import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import type { ModelSelection } from "./registry.ts";

/**
 * One engine submission and its reply. Written when the submission is admitted (no `reply`
 * yet), filled with the reply before any channel sees it, marked once the channel accepts
 * it. `key` is the reply's idempotency key, so the same answer is never queued twice.
 */
export type OutboxEntry = {
	readonly key: string;
	readonly submissionId: string;
	readonly channel: string;
	readonly threadId: string;
	/** Undefined while the engine has not answered (as far as this outbox knows). */
	readonly reply?:
		| { readonly status: "answered"; readonly text: string; readonly model?: ModelSelection }
		| { readonly status: "unanswered"; readonly reason: string; readonly cancelled?: true }
		/** A workspace file the instance sends to the thread. */
		| { readonly status: "file"; readonly path: string; readonly caption?: string };
	readonly createdAt: string;
	/** Times the entry was handed to a channel. Above 1, the user may have received it before. */
	readonly attempts: number;
	readonly deliveredAt?: string;
};

/**
 * Durable outbox of one instance: one JSON file per entry under `<instanceDir>/outbox/`,
 * each written atomically and fsynced. Holds reply text, so it lives with the instance's
 * storage (same tenant directory, files mode 0600), never in the audit log.
 * Only the process holding the instance lock writes to it.
 */
export class Outbox {
	constructor(private readonly dir: string) {}

	async get(key: string): Promise<OutboxEntry | undefined> {
		try {
			return JSON.parse(await readFile(this.file(key), "utf8")) as OutboxEntry;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	put(entry: OutboxEntry): Promise<void> {
		return writeFileAtomic(this.file(entry.key), `${JSON.stringify(entry)}\n`);
	}

	/** All entries, oldest first. */
	async list(): Promise<OutboxEntry[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const entries = await Promise.all(
			names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).map(async (name) => JSON.parse(await readFile(join(this.dir, name), "utf8")) as OutboxEntry),
		);
		return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	/** Remove entries whose key starts with `prefix`, delivered before `cutoff`. Returns how many went. */
	async prune(cutoff: Date, prefix: string): Promise<number> {
		let removed = 0;
		for (const entry of await this.list()) {
			if (!entry.key.startsWith(prefix) || entry.deliveredAt === undefined || entry.deliveredAt >= cutoff.toISOString()) continue;
			await rm(this.file(entry.key), { force: true });
			removed++;
		}
		return removed;
	}

	private file(key: string): string {
		return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
	}
}
