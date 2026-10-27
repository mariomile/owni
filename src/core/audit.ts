import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TenantId } from "./ids.ts";
import { auditFile } from "./paths.ts";

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

/** Months of archives kept next to the live file (ADR 0129). */
export const AUDIT_RETENTION_MONTHS = 12;

const ARCHIVE = /^audit-(\d{4})-(\d{2})\.jsonl$/;

/** Appends of one file run one after the other, so a rotation never races an append. */
const writing = new Map<string, Promise<unknown>>();

function monthKey(date: Date): string {
	return date.toISOString().slice(0, 7);
}

function monthIndex(key: string): number {
	return Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
}

/**
 * Append-only JSONL audit log of one tenant, bound to that tenant at construction. It is kept by
 * month: the first append of a new month moves the live file to `audit-YYYY-MM.jsonl` (the month
 * of its last write) and deletes archives older than twelve months.
 */
export class AuditLog {
	private readonly file: string;
	private readonly dir: string;

	constructor(
		dataDir: string,
		readonly tenantId: TenantId,
		private readonly clock: () => Date = () => new Date(),
	) {
		this.file = auditFile(dataDir, tenantId);
		this.dir = dirname(this.file);
	}

	append(event: AuditEvent): Promise<void> {
		const run = (writing.get(this.file) ?? Promise.resolve()).catch(() => undefined).then(() => this.write(event));
		writing.set(this.file, run);
		return run;
	}

	private async write(event: AuditEvent): Promise<void> {
		const now = this.clock();
		const record: AuditRecord = { ts: now.toISOString(), tenantId: this.tenantId, ...event };
		await mkdir(this.dir, { recursive: true });
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
		const month = monthKey(written);
		if (month >= monthKey(now)) return;
		const archive = join(this.dir, `audit-${month}.jsonl`);
		try {
			await rename(this.file, archive);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const old of await this.archives()) {
			if (monthIndex(monthKey(now)) - monthIndex(old.month) > AUDIT_RETENTION_MONTHS) await unlink(old.path).catch(() => undefined);
		}
	}

	/** Archived months, oldest first. */
	private async archives(): Promise<{ month: string; path: string }[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names
			.map((name) => ({ name, match: ARCHIVE.exec(name) }))
			.filter((entry) => entry.match !== null)
			.map((entry) => ({ month: `${entry.match?.[1]}-${entry.match?.[2]}`, path: join(this.dir, basename(entry.name)) }))
			.sort((a, b) => a.month.localeCompare(b.month));
	}

	/** Bytes the audit takes on disk: the live file and its archives. */
	async size(): Promise<number> {
		let total = 0;
		for (const path of [...(await this.archives()).map((a) => a.path), this.file]) {
			try {
				total += (await stat(path)).size;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return total;
	}

	/**
	 * Every record, oldest first; with `last`, only the newest `last` ones, read from the end
	 * of the file in chunks so memory stays bounded however long the log has grown.
	 */
	async read(last?: number): Promise<AuditRecord[]> {
		const files = [...(await this.archives()).map((a) => a.path), this.file];
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
