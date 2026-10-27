/**
 * Billing of answers (ADR 0098) on Pi Durable's own usage ledger: what each answer took, written
 * once per answer in the conversation's documents.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { CompactionEntry, type ConversationId, type Cursor, type DocumentReader, defineDoc, defineDocFamily, type EntryId, type EntryRecord, type Page, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import type { TurnUsage } from "../engine.ts";

/**
 * How far this conversation is billed (ADR 0098): `answer` is the last entry a bill took in, an
 * answer's or a turn's that ended unanswered, and `spent` how much of Pi's `pi.usage` had been
 * spent at that bill. No `spent` until billing starts: when the conversation is created, or for one
 * created before, when this version first opens it.
 */
type Spent = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type Billing = { answer?: number; spent: Spent };
export const BilledDoc = defineDoc<Partial<Billing>>({
	kind: "owni.billed-to",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** What one answer was billed (ADR 0098), keyed by its entry: written once, given again whenever it is read again. */
type Bill = { modelCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; tools: string[] };
const BillDoc = defineDocFamily<{ bill?: Bill }, Bill | null>({
	kind: "owni.bill",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (bill) => (bill === null ? {} : { bill }),
});

/** An answer: an assistant message that completed without calling a tool. Failed and cut-short requests are not. */
export function answered(entry: EntryRecord): boolean {
	return ((entry.model ?? []) as Message[]).some((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && !m.content.some((c) => c.type === "toolCall"));
}

/** The assistant messages of `entries`: every model call Pi wrote down, answered, failed, retried or cut short. */
function assistants(entries: readonly EntryRecord[]): (Message & { role: "assistant" })[] {
	return entries.flatMap((entry) => ((entry.model ?? []) as Message[]).filter((m): m is Message & { role: "assistant" } => m.role === "assistant"));
}

function spentBy(messages: readonly (Message & { role: "assistant" })[]): Spent {
	const spent = noSpend();
	for (const m of messages) {
		spent.input += m.usage?.input ?? 0;
		spent.output += m.usage?.output ?? 0;
		spent.cacheRead += m.usage?.cacheRead ?? 0;
		spent.cacheWrite += m.usage?.cacheWrite ?? 0;
		spent.cost += m.usage?.cost?.total ?? 0;
	}
	return spent;
}

export function noSpend(): Spent {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * What the run that ended with `answer` took (ADR 0098), billed once. The answers not billed yet,
 * up to the newest, are billed in order in this commit, each in its own document, and an answer
 * read again gets its own bill back. Token and cost are Pi's own ledger of the conversation
 * (`pi.usage`, every provider call, summaries of a compaction included): at each answer the ledger
 * stood at today's total less the assistant messages written after it, and the bill is the growth
 * since the bill before (an answer's, or a turn's that ended unanswered). A call that left no
 * message (a summary) goes to the first bill after it was made. The tools are those the run called,
 * in order; the model calls, its assistant messages and compactions; a turn that ended unanswered
 * before it is on its own bill. Undefined for an answer from before billing started, and for
 * one that is not there.
 */
export async function turnUsage(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId, answer: EntryId): Promise<TurnUsage | undefined> {
	const billed = await tx.doc(BilledDoc, conversationId);
	if (!billing(billed)) return undefined;
	if (billed.answer === undefined || billed.answer < answer) await billAnswers(tx, conversationId, billed);
	if (billed.answer === undefined || billed.answer < answer) return undefined;
	const { bill } = await tx.doc(BillDoc, conversationId, String(answer), null);
	return bill === undefined ? undefined : { ...bill, tools: [...bill.tools] };
}

function billing(billed: Partial<Billing>): billed is Billing {
	return billed.spent !== undefined;
}

/**
 * Bill every answer after the last entry billed, oldest first, from one complete scan of what came
 * after it. `rest`: the entries after the last answer, on no bill yet; `now`: Pi's ledger as it stands.
 */
async function billAnswers(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId, billed: Billing): Promise<{ rest: EntryRecord[]; now: Spent }> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page: Page<EntryRecord, Cursor> = await tx.scanEntries({ conversationId, order: "ascending", ...(billed.answer === undefined ? {} : { minEntryId: (billed.answer + 1) as EntryId }) }, 50, cursor);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	const now = await ledgerSpent(tx, conversationId);
	let later = spentBy(assistants(entries));
	let run: EntryRecord[] = [];
	for (const entry of entries) {
		run.push(entry);
		if (!answered(entry)) continue;
		later = since(later, spentBy(assistants(run)));
		const at = since(now, later);
		await tx.doc(BillDoc, conversationId, String(entry.id), billOf(run, since(at, billed.spent)));
		billed.answer = entry.id;
		billed.spent = at;
		run = [];
	}
	return { rest: run, now };
}

/** The bill of a run's `entries` that spent `spent`: the tools they called in order, their model calls and compactions. */
function billOf(entries: readonly EntryRecord[], spent: Spent): Bill {
	const calls = assistants(entries);
	const tools = calls.flatMap((m) => (m.stopReason === "toolUse" ? m.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : [])) : []));
	const modelCalls = calls.length + entries.filter((e) => e.kind === CompactionEntry.kind).length;
	// Never below zero: each difference is a sum of calls, only floating point can take it under.
	return { modelCalls, inputTokens: Math.max(0, spent.input), outputTokens: Math.max(0, spent.output), cacheReadTokens: Math.max(0, spent.cacheRead), cacheWriteTokens: Math.max(0, spent.cacheWrite), costUsd: Math.max(0, spent.cost), tools };
}

/**
 * What a turn that ended unanswered (cancelled, failed, refused by the cap) took (ADR 0098),
 * billed once under its submission: everything spent since the last bill, so no spend stays
 * unbilled and counts against the conversation forever. The answers written before it are billed
 * first. Given again whenever it is read again; undefined before billing starts, and for a turn
 * that spent nothing.
 */
export async function unansweredUsage(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId, submissionId: string): Promise<TurnUsage | undefined> {
	const billed = await tx.doc(BilledDoc, conversationId);
	if (!billing(billed)) return undefined;
	const doc = await tx.doc(BillDoc, conversationId, `s${submissionId}`, null);
	if (doc.bill === undefined) {
		const { rest, now } = await billAnswers(tx, conversationId, billed);
		doc.bill = billOf(rest, since(now, billed.spent));
		billed.spent = now;
		billed.answer = rest.at(-1)?.id ?? billed.answer;
	}
	// A turn that sent nothing (refused at its first request) spent nothing: no row to record.
	if (doc.bill.modelCalls === 0 && doc.bill.costUsd === 0) return undefined;
	return { ...doc.bill, tools: [...doc.bill.tools] };
}

/**
 * Billing starts for a conversation created before it existed: from its last answer, with the
 * ledger as it stood then (today's total less the assistant messages written after it).
 */
export async function startBilling(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId): Promise<void> {
	const billed = await tx.doc(BilledDoc, conversationId);
	if (billed.spent !== undefined) return;
	const after: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	scan: do {
		const page: Page<EntryRecord, Cursor> = await tx.scanEntries({ conversationId, order: "descending" }, 50, cursor);
		for (const entry of page.items) {
			if (answered(entry)) {
				billed.answer = entry.id;
				break scan;
			}
			after.push(entry);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	billed.spent = since(await ledgerSpent(tx, conversationId), spentBy(assistants(after)));
}

/**
 * What the conversation's model calls cost since its last bill: the turn under way, on no record
 * of Owni's yet (it is recorded when it settles, answered or not). Zero before billing starts.
 */
export async function unbilledUsd(reader: DocumentReader, conversationId: ConversationId, readContext: Context): Promise<number> {
	const billed = await reader.snapshot(BilledDoc, conversationId, readContext);
	if (billed?.spent === undefined) return 0;
	const usage = await reader.snapshot(UsageDoc, conversationId, readContext);
	const total = Object.values(usage?.models ?? {}).reduce((sum, model) => sum + model.cost.total, 0);
	return Math.max(0, total - billed.spent.cost);
}

/** Every model call of the conversation in Pi's ledger, summed across models. */
async function ledgerSpent(tx: Pick<Tx, "doc">, conversationId: ConversationId): Promise<Spent> {
	const spent = noSpend();
	for (const usage of Object.values((await tx.doc(UsageDoc, conversationId)).models)) {
		spent.input += usage.input;
		spent.output += usage.output;
		spent.cacheRead += usage.cacheRead;
		spent.cacheWrite += usage.cacheWrite;
		spent.cost += usage.cost.total;
	}
	return spent;
}

function since(now: Spent, before: Spent): Spent {
	return { input: now.input - before.input, output: now.output - before.output, cacheRead: now.cacheRead - before.cacheRead, cacheWrite: now.cacheWrite - before.cacheWrite, cost: now.cost - before.cost };
}
