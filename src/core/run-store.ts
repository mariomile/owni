import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import { SerialQueue } from "./serial-queue.ts";
import type { TurnOrigin } from "./turn-origin.ts";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RunProgress = { readonly at: string; readonly kind: string; readonly message: string; readonly toolName?: string };
export type RunRecord = {
	readonly id: string;
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly userId?: string;
	readonly onBehalfOf?: { readonly channel: string; readonly userId: string };
	readonly origin: TurnOrigin;
	readonly source: "message" | "schedule" | "brief" | "watch" | "automation" | "notice" | "agent";
	readonly sourceId?: string;
	readonly scheduleId?: string;
	readonly messageId?: string;
	readonly submissionId?: string;
	readonly status: RunStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly cancelRequestedAt?: string;
	readonly progress: readonly RunProgress[];
	readonly error?: string;
	/** not_applicable: no durable admission exists, so no reply can enter the outbox. */
	readonly delivery?: "pending" | "delivered" | "failed" | "not_applicable";
};
export type RunEvent = { readonly type: "run.updated"; readonly run: RunRecord };
export type RunFilter = {
	readonly channel?: string;
	readonly threadId?: string;
	/** Authorization scope, applied before limit. An empty list matches nothing. */
	readonly threadIds?: readonly string[];
	readonly userId?: string;
	readonly statuses?: readonly RunStatus[];
	readonly sources?: readonly RunRecord["source"][];
	readonly limit?: number;
};

export const RUN_HISTORY_LIMIT = 1_000;
export const RUN_PROGRESS_LIMIT = 32;
export const isActiveRun = (run: Pick<RunRecord, "status">): boolean => run.status === "queued" || run.status === "running";

/** Conversation-scoped deduplication matches the engine; missing message IDs mean new work. */
export function runId(channel: string, threadId: string, messageId?: string): string {
	return messageId === undefined ? randomUUID() : createHash("sha256").update(JSON.stringify([channel, threadId, messageId])).digest("hex").slice(0, 32);
}

/** Keep the engine's existing message deduplication namespace. */
export function runRequestId(run: Pick<RunRecord, "channel" | "messageId" | "id">): string {
	return run.messageId === undefined ? `owni-run:${run.id}` : `${run.channel}:${run.messageId}`;
}

/** One bounded, atomic snapshot per instance. Only the process holding its instance lock writes. */
export class RunStore {
	private readonly queue = new SerialQueue();
	private readonly file: string;
	constructor(instanceDir: string, private readonly emit: (event: RunEvent) => void = () => {}) {
		this.file = join(instanceDir, "runs.json");
	}

	async all(): Promise<RunRecord[]> {
		try { return JSON.parse(await readFile(this.file, "utf8")) as RunRecord[]; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	}

	async list(filter: RunFilter = {}): Promise<RunRecord[]> {
		const threads = filter.threadIds === undefined ? undefined : new Set(filter.threadIds);
		const limit = Math.max(0, Math.min(200, Number.isFinite(filter.limit) ? Math.floor(filter.limit!) : 50));
		return (await this.all()).filter((run) =>
			(filter.channel === undefined || run.channel === filter.channel) &&
			(filter.threadId === undefined || run.threadId === filter.threadId) &&
			(threads === undefined || threads.has(run.threadId)) &&
			(filter.userId === undefined || run.userId === filter.userId || run.onBehalfOf?.userId === filter.userId) &&
			(filter.statuses === undefined || filter.statuses.includes(run.status)) &&
			(filter.sources === undefined || filter.sources.includes(run.source)),
		).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit);
	}

	/** Serialized read-modify-write; terminal outcomes cannot be overwritten by delayed events. */
	change(id: string, update: (run: RunRecord | undefined) => RunRecord | undefined, retryAdmission = false): Promise<RunRecord | undefined> {
		return this.mutate((run) => run.id === id, update, retryAdmission);
	}

	/** Resolve an engine event and apply it from the same disk snapshot, without a second parse. */
	changeMatching(match: (run: RunRecord) => boolean, update: (run: RunRecord | undefined) => RunRecord | undefined): Promise<RunRecord | undefined> {
		return this.mutate(match, update);
	}

	private mutate(match: (run: RunRecord) => boolean, update: (run: RunRecord | undefined) => RunRecord | undefined, retryAdmission = false): Promise<RunRecord | undefined> {
		return this.queue.run("runs", async () => {
			const records = await this.all();
			const previous = records.find(match);
			const candidate = update(previous);
			if (candidate === undefined) return previous;
			const retry = retryAdmission && previous?.status === "failed" && previous.submissionId === undefined && previous.cancelRequestedAt === undefined;
			const proposed = previous !== undefined && !isActiveRun(previous) && !retry
				? { ...candidate, status: previous.status, finishedAt: previous.finishedAt, error: previous.error, progress: previous.progress }
				: candidate;
			if (JSON.stringify(proposed) === JSON.stringify(previous)) return previous;
			// Strictly ordered even when several commits share a millisecond (SSE + snapshot merge).
			const updatedAt = new Date(Math.max(Date.now(), previous === undefined ? 0 : Date.parse(previous.updatedAt) + 1)).toISOString();
			const next = { ...proposed, updatedAt, progress: proposed.progress.slice(-RUN_PROGRESS_LIMIT) };
			const others = records.filter((run) => run.id !== next.id);
			const all = [...others, next];
			const active = all.filter(isActiveRun);
			const settled = all.filter((run) => !isActiveRun(run)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RUN_HISTORY_LIMIT);
			await writeFileAtomic(this.file, `${JSON.stringify([...active, ...settled])}\n`);
			try { this.emit({ type: "run.updated", run: next }); }
			catch (error) { console.error(`owni: run event listener failed: ${String(error)}`); }
			return next;
		});
	}

	idle(): Promise<void> { return this.queue.idle(); }
}
