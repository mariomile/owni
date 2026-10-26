import { mkdir, readFile, appendFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import type { AuditLog } from "./audit.ts";
import type { TurnUsage } from "./engine.ts";
import { SerialQueue } from "./serial-queue.ts";

export type UsageRecord = {
	readonly at: string;
	readonly provider: string;
	readonly model: string;
	/** "agent": a turn of an agente (ADR 0098); the others are the segreteria's steps. */
	readonly role: "extract" | "draft" | "classify" | "agent" | "other";
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

/** Europe/Rome civil day key YYYY-MM-DD. */
export function romeDayKey(date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Rome",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

/** The record being written for each totals file: a ledger of the same tenant waits for it. */
const recording = new SerialQueue();

/** Each ledger file as last read or written in this process, by its identity on disk: parsed again only when that changes. */
const ledgers = new Map<string, { readonly stamp: string; readonly size: bigint; readonly records: readonly UsageRecord[] }>();

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
 * Per-tenant daily usage ledger (append-only JSONL + day totals JSON).
 * Soft cap: warn; hard cap: reject new model calls (send-only Approva still allowed).
 */
export class UsageLedger {
	constructor(
		private readonly tenantDir: string,
		private readonly caps: CostCaps = DEFAULT_COST_CAPS,
	) {}

	private usagePath(): string {
		return join(this.tenantDir, "usage.jsonl");
	}

	private totalsPath(): string {
		return join(this.tenantDir, "usage-totals.json");
	}

	async ensure(): Promise<void> {
		await mkdir(this.tenantDir, { recursive: true });
	}

	async todaySpent(): Promise<number> {
		const totals = await this.readTotals();
		return totals[romeDayKey()] ?? 0;
	}

	/** One record at a time per tenant in this process: the day totals are read, added to and written back. */
	record(rec: UsageRecord, audit?: AuditLog): Promise<{ softExceeded: boolean; hardExceeded: boolean }> {
		return recording.run(this.totalsPath(), () => this.write(rec, audit));
	}

	/** Every record written, oldest first: only whole lines, read between two records being written. */
	records(): Promise<UsageRecord[]> {
		return recording.run(this.totalsPath(), async () => [...(await this.ledger(false))]);
	}

	/** The ledger's whole lines; `repair`: first drop a line a crash cut short, so the next record does not glue to it. */
	private async ledger(repair: boolean): Promise<readonly UsageRecord[]> {
		const path = this.usagePath();
		const before = await identity(path);
		if (before === undefined) return [];
		const cached = ledgers.get(path);
		if (cached?.stamp === before.stamp) return cached.records;
		const log = await this.readLog();
		const whole = log.lastIndexOf("\n") + 1;
		if (repair && whole < log.length) await truncate(path, Buffer.byteLength(log.slice(0, whole)));
		const records = parseRecords(log, path);
		// Only a ledger that ends with a whole line is kept: a cut one is read again next time.
		const after = await identity(path);
		if (after !== undefined && after.size === BigInt(Buffer.byteLength(log.slice(0, whole)))) ledgers.set(path, { ...after, records });
		return records;
	}

	private async readLog(): Promise<string> {
		try {
			return await readFile(this.usagePath(), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw err;
		}
	}

	private async write(rec: UsageRecord, audit?: AuditLog): Promise<{ softExceeded: boolean; hardExceeded: boolean }> {
		await this.ensure();
		const log = await this.ledger(true);
		const day = romeDayKey(new Date(rec.at));
		const totals = await this.readTotals();
		// A turn is billed once: a recovery that delivers it again finds it already on record (ADR 0098).
		const billed =
			rec.role === "agent" &&
			rec.instanceId !== undefined &&
			rec.submissionId !== undefined &&
			log.some((r) => r.role === "agent" && r.instanceId === rec.instanceId && r.submissionId === rec.submissionId);
		if (billed) {
			const spent = totals[day] ?? 0;
			return { softExceeded: spent >= this.caps.softUsdPerDay, hardExceeded: spent >= this.caps.hardUsdPerDay };
		}
		const line = `${JSON.stringify(rec)}\n`;
		const before = await identity(this.usagePath());
		await appendFile(this.usagePath(), line, { mode: 0o600 });
		// Known without reading it back, unless someone else wrote to it in between.
		const after = await identity(this.usagePath());
		const expected = (before?.size ?? 0n) + BigInt(Buffer.byteLength(line));
		if (after !== undefined && after.size === expected && ledgers.get(this.usagePath())?.size === (before?.size ?? -1n)) ledgers.set(this.usagePath(), { ...after, records: [...log, rec] });
		else ledgers.delete(this.usagePath());
		totals[day] = (totals[day] ?? 0) + rec.estimatedUsd;
		// The line above is not fsynced either: syncing the totals' folder would buy nothing on a power cut.
		await writeFileAtomic(this.totalsPath(), `${JSON.stringify(totals, null, "\t")}\n`, { durable: false });
		const spent = totals[day]!;
		const softExceeded = spent >= this.caps.softUsdPerDay;
		const hardExceeded = spent >= this.caps.hardUsdPerDay;
		if (audit) {
			if (hardExceeded) {
				await audit.append({ type: "cost.denied", day, spentUsd: spent, hardUsd: this.caps.hardUsdPerDay });
			} else if (softExceeded) {
				await audit.append({ type: "cost.warn", day, spentUsd: spent, softUsd: this.caps.softUsdPerDay });
			}
		}
		return { softExceeded, hardExceeded };
	}

	/** Spent per month ("YYYY-MM", Europe/Rome), every month on record. */
	async byMonth(): Promise<Record<string, number>> {
		const months: Record<string, number> = {};
		for (const [day, usd] of Object.entries(await this.readTotals())) months[day.slice(0, 7)] = (months[day.slice(0, 7)] ?? 0) + usd;
		return months;
	}

	/** Spent this month (Europe/Rome), or in the month "YYYY-MM". */
	async monthSpent(month = romeDayKey().slice(0, 7)): Promise<number> {
		const totals = await this.readTotals();
		return Object.entries(totals).reduce((sum, [day, usd]) => (day.startsWith(`${month}-`) ? sum + usd : sum), 0);
	}

	/** true when new model generations must be rejected. */
	async isHardCapped(): Promise<boolean> {
		return (await this.todaySpent()) >= this.caps.hardUsdPerDay;
	}

	async isSoftCapped(): Promise<boolean> {
		return (await this.todaySpent()) >= this.caps.softUsdPerDay;
	}

	private async readTotals(): Promise<Record<string, number>> {
		try {
			return JSON.parse(await readFile(this.totalsPath(), "utf8")) as Record<string, number>;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
	}
}

/** The whole lines of the ledger; a whole line that is not a record is an error, never skipped. */
function parseRecords(log: string, path: string): UsageRecord[] {
	const lines = log.slice(0, log.lastIndexOf("\n") + 1).split("\n");
	lines.pop();
	return lines.flatMap((line, i) => {
		if (line === "") return [];
		try {
			return [JSON.parse(line) as UsageRecord];
		} catch {
			throw new Error(`${path}: line ${i + 1} is not a usage record`);
		}
	});
}

export const TELEGRAM_SOFT_CAP = `Limite soft di spesa · oggi

Questo tenant ha superato circa 5 USD di modelli nel giorno civile.
Continuo a preparare le bozze già in corso. Le nuove mail restano in coda e ti avviso se il ritmo non cala.
Se serve alzare il tetto, chiedilo all'owner.`;

export const TELEGRAM_HARD_CAP = `Limite hard di spesa · oggi

Ho smesso di usare il modello per questo tenant: raggiunto il tetto di circa 20 USD nel giorno civile.
Nessuna nuova bozza partirà fino a domani (o finché l'owner non alza il tetto).
Le mail in arrivo restano salvate e non vengono inviate risposte automatiche.
Pratiche già in approvazione: puoi ancora Approvare una bozza già pronta (parte solo l'invio mail).`;

export const TELEGRAM_HARD_CAP_REGEN = `Non posso rigenerare la bozza: tetto di spesa giornaliero raggiunto.
Puoi Scartare, oppure Approvare la bozza già mostrata (v{n}) senza rigenerarla.`;

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
