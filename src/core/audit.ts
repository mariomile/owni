import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/** Append-only JSONL audit log of one tenant. Bound to that tenant at construction. */
export class AuditLog {
	private readonly file: string;

	constructor(
		dataDir: string,
		readonly tenantId: TenantId,
	) {
		this.file = auditFile(dataDir, tenantId);
	}

	async append(event: AuditEvent): Promise<void> {
		const record: AuditRecord = { ts: new Date().toISOString(), tenantId: this.tenantId, ...event };
		await mkdir(dirname(this.file), { recursive: true });
		// "a" opens with O_APPEND: writes only ever go to the end of the file.
		await appendFile(this.file, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
	}

	/**
	 * Every record, oldest first; with `last`, only the newest `last` ones, read from the end
	 * of the file in chunks so memory stays bounded however long the log has grown.
	 */
	async read(last?: number): Promise<AuditRecord[]> {
		if (last !== undefined) return this.readTail(last);
		let text: string;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return text
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as AuditRecord);
	}

	private async readTail(last: number): Promise<AuditRecord[]> {
		if (last <= 0) return [];
		let handle;
		try {
			handle = await open(this.file, "r");
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
