import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { TenantId } from "./ids.ts";
import { MonthlyLog } from "./monthly-log.ts";
import { auditFile } from "./paths.ts";
import { SerialQueue } from "./serial-queue.ts";

/**
 * Audit events carry metadata only: who, where, what kind, sizes. Never message text,
 * model output, or secret values.
 */
export type AuditEvent = {
	readonly type: string;
	readonly instanceId?: string;
	readonly [field: string]: string | number | boolean | undefined;
};

export type AuditRecord = AuditEvent & { readonly ts: string; readonly tenantId: string };

/** Appends of one file run one after the other, so a rotation never races an append. */
const writing = new SerialQueue();

function monthKey(date: Date): string {
	return date.toISOString().slice(0, 7);
}

/**
 * Append-only JSONL audit log of one tenant, bound to that tenant at construction. It is kept by
 * month (ADR 0129): the first append of a new month moves the live file to `audit-YYYY-MM.jsonl`
 * (the month of its last write, UTC) and deletes archives older than twelve months.
 */
export class AuditLog {
	private readonly file: string;
	private readonly log: MonthlyLog;

	constructor(
		dataDir: string,
		readonly tenantId: TenantId,
		private readonly clock: () => Date = () => new Date(),
	) {
		this.file = auditFile(dataDir, tenantId);
		this.log = new MonthlyLog(dirname(this.file), "audit");
	}

	append(event: AuditEvent): Promise<void> {
		return writing.run(this.file, () => this.write(event));
	}

	private async write(event: AuditEvent): Promise<void> {
		const now = this.clock();
		const record: AuditRecord = { ts: now.toISOString(), tenantId: this.tenantId, ...event };
		await mkdir(dirname(this.file), { recursive: true });
		await this.rotate(now);
		// "a" opens with O_APPEND: writes only ever go to the end of the file.
		await appendFile(this.file, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
	}

	private async rotate(now: Date): Promise<void> {
		let written: Date;
		try {
			written = (await stat(this.file)).mtime;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return;
		}
		if (monthKey(written) < monthKey(now)) await this.log.roll(monthKey(written), monthKey(now));
	}

	/** Bytes the audit takes on disk: the live file and its archives. */
	size(): Promise<number> {
		return this.log.size();
	}

	/**
	 * Every record, oldest first; with `last`, only the newest `last` ones, read from the end
	 * of the file in chunks so memory stays bounded however long the log has grown.
	 */
	async read(last?: number): Promise<AuditRecord[]> {
		const files = await this.log.files();
		if (last === undefined) return (await Promise.all(files.map(readAll))).flat();
		// Newest file first, until there are enough records.
		const records: AuditRecord[] = [];
		for (const path of files.reverse()) {
			if (records.length >= last) break;
			records.unshift(...(await readTail(path, last - records.length)));
		}
		return records;
	}
}

async function readAll(path: string): Promise<AuditRecord[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditRecord);
}

async function readTail(path: string, last: number): Promise<AuditRecord[]> {
	if (last <= 0) return [];
	let handle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		let position = (await handle.stat()).size;
		// Raw bytes, decoded per line: a chunk boundary can fall inside a UTF-8 character.
		let carry: Buffer = Buffer.alloc(0);
		const lines: Buffer[] = [];
		while (position > 0 && lines.length <= last) {
			const size = Math.min(TAIL_CHUNK, position);
			position -= size;
			const chunk = Buffer.alloc(size);
			await handle.read(chunk, 0, size, position);
			const parts = splitLines(Buffer.concat([chunk, carry]));
			carry = parts.shift() ?? Buffer.alloc(0);
			lines.unshift(...parts);
		}
		if (position === 0 && carry.length > 0) lines.unshift(carry);
		return lines
			.map((line) => line.toString("utf8"))
			.filter((line) => line.length > 0)
			.slice(-last)
			.map((line) => JSON.parse(line) as AuditRecord);
	} finally {
		await handle.close();
	}
}

const TAIL_CHUNK = 64 * 1024;

function splitLines(buffer: Buffer): Buffer[] {
	const parts: Buffer[] = [];
	let start = 0;
	for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10, start)) {
		parts.push(buffer.subarray(start, at));
		start = at + 1;
	}
	parts.push(buffer.subarray(start));
	return parts;
}
