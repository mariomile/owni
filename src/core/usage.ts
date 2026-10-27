import { mkdir, readFile, readdir, appendFile, rename, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AuditLog } from "./audit.ts";
import type { TurnUsage } from "./engine.ts";
import { SerialQueue } from "./serial-queue.ts";

export type UsageRecord = {
	readonly at: string;
	readonly provider: string;
	readonly model: string;
	/** "agent": a turn of an agente (ADR 0098). */
	readonly role: "agent";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly estimatedUsd: number;
	readonly submissionId?: string;
	/** The agente and the chat of a turn (role "agent"). */
	readonly instanceId?: string;
	readonly threadId?: string;
	/** Of a turn: the tools it called, in order, and how many times it called the model. */
	readonly tools?: readonly string[];
	readonly modelCalls?: number;
};

export type CostCaps = {
	readonly softUsdPerDay: number;
	readonly hardUsdPerDay: number;
};

export const DEFAULT_COST_CAPS: CostCaps = { softUsdPerDay: 5, hardUsdPerDay: 20 };

/** Rough public list prices (USD / MTok) used only for estimates in tests and caps. */
const PRICE: Record<string, { in: number; out: number }> = {
	"claude-haiku-5-5": { in: 0.1, out: 0.5 },
	"claude-sonnet-5-5": { in: 2, out: 10 },
	"gpt-5-mini": { in: 0.25, out: 2 },
	"gpt-5": { in: 1.25, out: 10 },
	"owni-dev": { in: 0, out: 0 },
};

export function estimateUsd(modelId: string, inputTokens: number, outputTokens: number): number {
	const p = PRICE[modelId] ?? { in: 2, out: 10 };
	return (inputTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
}

const ROME_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });

/** Europe/Rome civil day key YYYY-MM-DD. */
export function romeDayKey(date = new Date()): string {
	return ROME_DAY.format(date);
}

/** Months of archives kept next to the live ledger (ADR 0130). */
export const USAGE_RETENTION_MONTHS = 12;

const ARCHIVE = /^usage-(\d{4}-\d{2})\.jsonl$/;

const monthOf = (at: string): string => romeDayKey(new Date(at)).slice(0, 7);
const monthIndex = (month: string): number => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

/** The record being written for each ledger file: a read of the same tenant waits for it. */
const recording = new SerialQueue();

type Ledger = { readonly records: readonly UsageRecord[]; readonly days: ReadonlyMap<string, number> };

/** Each ledger file as last read or written in this process, by its identity on disk: parsed again only when that changes. */
const ledgers = new Map<string, Ledger & { readonly stamp: string; readonly size: bigint }>();

/** What was spent each day (Europe/Rome), from the records alone. */
function spentByDay(records: readonly UsageRecord[], days = new Map<string, number>()): Map<string, number> {
	for (const r of records) {
		const day = romeDayKey(new Date(r.at));
		days.set(day, (days.get(day) ?? 0) + r.estimatedUsd);
	}
	return days;
}

async function identity(path: string): Promise<{ stamp: string; size: bigint } | undefined> {
	try {
		const s = await stat(path, { bigint: true });
		return { stamp: `${s.ino}:${s.size}:${s.mtimeNs}`, size: s.size };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * Per-tenant usage ledger: one append-only JSONL file, the only record of the spend. The day and
 * month totals are sums of its lines, kept in memory with the parsed file and computed again
 * whenever the file changes: a fault or a crash after a line is written leaves nothing to
 * reconcile, the next read (a retry, a new process) sums the same lines.
 * It is kept by month (ADR 0130): the first record of a new month moves the live file to
 * `usage-YYYY-MM.jsonl` (the month of its last record) and deletes archives older than twelve
 * months. Today's total reads the live file alone; month totals, the stats and the dedup of a
 * turn read the live file and the archives.
 * Soft cap: warn; hard cap: refuse new model requests (runtime.ts asks before each one).
 */
export class UsageLedger {
	constructor(
		private readonly tenantDir: string,
		private readonly caps: CostCaps = DEFAULT_COST_CAPS,
	) {}

	private usagePath(): string {
		return join(this.tenantDir, "usage.jsonl");
	}

	async ensure(): Promise<void> {
		await mkdir(this.tenantDir, { recursive: true });
	}

	/** Today is always in the live file: a rotation only moves months that are over. */
	async todaySpent(): Promise<number> {
		return (await recording.run(this.usagePath(), () => this.ledger(this.usagePath(), false))).days.get(romeDayKey()) ?? 0;
	}

	/** One record at a time per tenant in this process: the ledger is read, checked for the turn and appended to. */
	record(rec: UsageRecord, audit?: AuditLog): Promise<{ softExceeded: boolean; hardExceeded: boolean }> {
		return recording.run(this.usagePath(), () => this.write(rec, audit));
	}

	/** Every record kept, archives first, oldest first: only whole lines, read between two records being written. */
	records(): Promise<UsageRecord[]> {
		return recording.run(this.usagePath(), async () => (await this.allFiles()).flatMap((l) => l.records));
	}

	private days(): Promise<Map<string, number>> {
		return recording.run(this.usagePath(), async () => {
			const days = new Map<string, number>();
			for (const l of await this.allFiles()) for (const [day, usd] of l.days) days.set(day, (days.get(day) ?? 0) + usd);
			return days;
		});
	}

	private async allFiles(): Promise<Ledger[]> {
		return Promise.all([...(await this.archives()).map((a) => a.path), this.usagePath()].map((path) => this.ledger(path, false)));
	}

	/** Archived months, oldest first. */
	private async archives(): Promise<{ month: string; path: string }[]> {
		let names: string[];
		try {
			names = await readdir(this.tenantDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		return names
			.flatMap((name) => {
				const month = ARCHIVE.exec(name)?.[1];
				return month === undefined ? [] : [{ month, path: join(this.tenantDir, name) }];
			})
			.sort((a, b) => a.month.localeCompare(b.month));
	}

	/** Bytes the ledger takes on disk: the live file and its archives. */
	async size(): Promise<number> {
		let total = 0;
		for (const path of [...(await this.archives()).map((a) => a.path), this.usagePath()]) {
			try {
				total += (await stat(path)).size;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}
		return total;
	}

	/** Moves the live file to the archive of its month, then deletes the archives past the retention. */
	private async rotate(lastMonth: string, month: string): Promise<void> {
		const live = this.usagePath();
		const archive = join(this.tenantDir, `usage-${lastMonth}.jsonl`);
		// An archive of that month already there (a clock that went back) is added to, never replaced.
		if ((await identity(archive)) === undefined) await rename(live, archive);
		else {
			await appendFile(archive, await readFile(live), { mode: 0o600 });
			await unlink(live);
		}
		ledgers.delete(live);
		for (const old of await this.archives()) {
			if (monthIndex(month) - monthIndex(old.month) > USAGE_RETENTION_MONTHS) {
				await unlink(old.path).catch(() => undefined);
				ledgers.delete(old.path);
			}
		}
	}

	/** A file's whole lines; `repair`: first drop a line a crash cut short, so the next record does not glue to it. */
	private async ledger(path: string, repair: boolean): Promise<Ledger> {
		const before = await identity(path);
		if (before === undefined) return { records: [], days: new Map() };
		const cached = ledgers.get(path);
		if (cached?.stamp === before.stamp) return cached;
		const log = await this.readLog(path);
		const whole = log.lastIndexOf("\n") + 1;
		if (repair && whole < log.length) await truncate(path, Buffer.byteLength(log.slice(0, whole)));
		const records = parseRecords(log, path);
		const read = { records, days: spentByDay(records) };
		// Only a ledger that ends with a whole line is kept: a cut one is read again next time.
		const after = await identity(path);
		if (after !== undefined && after.size === BigInt(Buffer.byteLength(log.slice(0, whole)))) ledgers.set(path, { ...after, ...read });
		return read;
	}

	private async readLog(path: string): Promise<string> {
		try {
			return await readFile(path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw err;
		}
	}

	private async write(rec: UsageRecord, audit?: AuditLog): Promise<{ softExceeded: boolean; hardExceeded: boolean }> {
		await this.ensure();
		let log = await this.ledger(this.usagePath(), true);
		const day = romeDayKey(new Date(rec.at));
		const last = log.records[log.records.length - 1];
		if (last !== undefined && monthOf(last.at) < day.slice(0, 7)) {
			await this.rotate(monthOf(last.at), day.slice(0, 7));
			log = { records: [], days: new Map() };
		}
		// A turn is billed once: a recovery that delivers it again finds it already on record, in
		// the live file or in any month still archived (ADR 0098, 0130).
		const same = (r: UsageRecord) => r.role === "agent" && r.instanceId === rec.instanceId && r.submissionId === rec.submissionId;
		const billed =
			rec.role === "agent" &&
			rec.instanceId !== undefined &&
			rec.submissionId !== undefined &&
			(log.records.some(same) || (await Promise.all((await this.archives()).map((a) => this.ledger(a.path, false)))).some((l) => l.records.some(same)));
		if (billed) {
			const spent = log.days.get(day) ?? 0;
			return { softExceeded: spent >= this.caps.softUsdPerDay, hardExceeded: spent >= this.caps.hardUsdPerDay };
		}
		const line = `${JSON.stringify(rec)}\n`;
		const before = await identity(this.usagePath());
		// Not fsynced: a power cut may lose the newest line, and the totals with it, never one without the other.
		await appendFile(this.usagePath(), line, { mode: 0o600 });
		const days = spentByDay([rec], new Map(log.days));
		// Known without reading it back, unless someone else wrote to it in between.
		const after = await identity(this.usagePath());
		const expected = (before?.size ?? 0n) + BigInt(Buffer.byteLength(line));
		if (after !== undefined && after.size === expected && ledgers.get(this.usagePath())?.size === (before?.size ?? -1n)) ledgers.set(this.usagePath(), { ...after, records: [...log.records, rec], days });
		else ledgers.delete(this.usagePath());
		const spent = days.get(day) ?? 0;
		const softExceeded = spent >= this.caps.softUsdPerDay;
		const hardExceeded = spent >= this.caps.hardUsdPerDay;
		// Over the hard cap, the next model request is refused and that refusal audited (cost.denied, runtime.ts).
		if (audit !== undefined && softExceeded && !hardExceeded) await audit.append({ type: "cost.warn", day, spentUsd: spent, softUsd: this.caps.softUsdPerDay });
		return { softExceeded, hardExceeded };
	}

	/** Spent per month ("YYYY-MM", Europe/Rome), every month on record. */
	async byMonth(): Promise<Record<string, number>> {
		const months: Record<string, number> = {};
		for (const [day, usd] of await this.days()) months[day.slice(0, 7)] = (months[day.slice(0, 7)] ?? 0) + usd;
		return months;
	}

	/** Spent this month (Europe/Rome), or in the month "YYYY-MM". */
	async monthSpent(month = romeDayKey().slice(0, 7)): Promise<number> {
		return (await this.byMonth())[month] ?? 0;
	}

	/**
	 * Today's hard cap reached, with `unrecordedUsd` (spent by work still running, on no record
	 * yet) counted: new model requests must be refused. What counts as spent today, then.
	 */
	async hardCapped(unrecordedUsd = 0): Promise<{ readonly day: string; readonly spentUsd: number; readonly hardUsd: number } | undefined> {
		const spentUsd = (await this.todaySpent()) + unrecordedUsd;
		return spentUsd >= this.caps.hardUsdPerDay ? { day: romeDayKey(), spentUsd, hardUsd: this.caps.hardUsdPerDay } : undefined;
	}

	/** true when new model requests must be refused. */
	async isHardCapped(): Promise<boolean> {
		return (await this.hardCapped()) !== undefined;
	}

	async isSoftCapped(): Promise<boolean> {
		return (await this.todaySpent()) >= this.caps.softUsdPerDay;
	}
}

/** The whole lines of the ledger; a whole line that is not a record is an error, never skipped. */
function parseRecords(log: string, path: string): UsageRecord[] {
	const lines = log.slice(0, log.lastIndexOf("\n") + 1).split("\n");
	lines.pop();
	// A whole line that is not a record (edited by hand, a disk error) is skipped and said, never
	// thrown: the cap and the stats read the same lines, and one bad line must not stop every turn.
	return lines.flatMap((line, i) => {
		if (line === "") return [];
		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			rec = undefined;
		}
		if (isRecord(rec)) return [rec];
		console.error(`owni: ${path}: line ${i + 1} is not a usage record, skipped`);
		return [];
	});
}

function isRecord(value: unknown): value is UsageRecord {
	if (typeof value !== "object" || value === null) return false;
	const { at, estimatedUsd } = value as Record<string, unknown>;
	return typeof at === "string" && !Number.isNaN(Date.parse(at)) && typeof estimatedUsd === "number" && Number.isFinite(estimatedUsd);
}
export type TurnStats = {
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costUsd: number;
	/** Per agente: its turns and what they cost. */
	readonly instances: readonly { readonly instanceId: string; readonly turns: number; readonly costUsd: number }[];
	/** The tools called most, with how many times. */
	readonly tools: readonly { readonly name: string; readonly calls: number }[];
};

/** What a turn took, in the tenant's ledger and its spend (ADR 0098). Never the text. */
export async function recordTurn(
	ledger: UsageLedger,
	audit: AuditLog,
	turn: { readonly instanceId: string; readonly threadId: string; readonly submissionId: string; readonly model: { readonly provider: string; readonly modelId: string } | undefined; readonly usage: TurnUsage },
): Promise<void> {
	const { usage } = turn;
	await ledger.record(
		{
			at: new Date().toISOString(),
			provider: turn.model?.provider ?? "",
			model: turn.model?.modelId ?? "",
			role: "agent",
			inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
			outputTokens: usage.outputTokens,
			estimatedUsd: usage.costUsd,
			submissionId: turn.submissionId,
			instanceId: turn.instanceId,
			threadId: turn.threadId,
			tools: usage.tools,
			modelCalls: usage.modelCalls,
		},
		audit,
	);
}

/** The turns of the agenti over the last `days`, from the ledger's records of role "agent" (ADR 0098). */
export function turnStats(records: readonly UsageRecord[], now: Date, days = 7): TurnStats {
	const since = now.getTime() - days * 24 * 3600_000;
	const turns = records.filter((r) => r.role === "agent" && Date.parse(r.at) >= since);
	const instances = new Map<string, { turns: number; costUsd: number }>();
	const tools = new Map<string, number>();
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (const r of turns) {
		inputTokens += r.inputTokens;
		outputTokens += r.outputTokens;
		costUsd += r.estimatedUsd;
		const instance = instances.get(r.instanceId ?? "") ?? { turns: 0, costUsd: 0 };
		instances.set(r.instanceId ?? "", { turns: instance.turns + 1, costUsd: instance.costUsd + r.estimatedUsd });
		for (const name of r.tools ?? []) tools.set(name, (tools.get(name) ?? 0) + 1);
	}
	return {
		turns: turns.length,
		inputTokens,
		outputTokens,
		costUsd,
		instances: [...instances].map(([instanceId, v]) => ({ instanceId, ...v })).sort((a, b) => b.costUsd - a.costUsd),
		tools: [...tools].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls).slice(0, 10),
	};
}
