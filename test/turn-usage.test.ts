import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { piDurableEngine, startBilling, turnUsage } from "../src/core/adapters/pi-durable.ts";
import type { EngineReply } from "../src/core/engine.ts";
import { tenantId } from "../src/core/ids.ts";
import { tenantDir } from "../src/core/paths.ts";
import { turnStats, type UsageRecord } from "../src/core/usage.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

type FakeEntry = { id: number; kind?: string; model?: unknown[] };
const said = (cost: number, ...tools: string[]) => ({
	role: "assistant",
	content: tools.length === 0 ? [{ type: "text", text: "ok" }] : tools.map((name) => ({ type: "toolCall", id: name, name, arguments: {} })),
	stopReason: tools.length === 0 ? "stop" : "toolUse",
	usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, totalTokens: 165, cost: { total: cost } },
});
/** A request that failed: Pi writes it down, then retries, compacts, or gives up. */
const failed = (cost: number, stopReason: "error" | "aborted" = "error") => ({ ...said(cost), content: [], stopReason, errorMessage: "529 overloaded" });
const asked = { role: "user", content: "fai" };
const input = (id: number): FakeEntry => ({ id, kind: "owni.input", model: [asked] });
const assistant = (id: number, message: unknown): FakeEntry => ({ id, kind: "pi.assistant", model: [message] });
const ledger = (cost: number, input = 0) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });

/** A conversation billed from its start, as one created now. */
const fresh = (): Record<string, unknown> => ({ "owni.billed-to": { spent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } });

/**
 * Entries newest first, read in pages of `size` in either order; `models` is the conversation's
 * `pi.usage`, and the docs Owni writes live in `docs` (a family's members under `kind/key`).
 */
function fakeTx(entries: FakeEntry[], size = 2, models?: Record<string, ReturnType<typeof ledger>>, docs: Record<string, unknown> = fresh()) {
	return {
		async scanEntries(query: { order?: string; maxEntryId?: number; minEntryId?: number }, _limit: number, cursor?: unknown) {
			const list = query.order === "ascending" ? [...entries].reverse().filter((e) => e.id >= (query.minEntryId ?? 0)) : entries.filter((e) => query.maxEntryId === undefined || e.id <= query.maxEntryId);
			const start = (cursor as number | undefined) ?? 0;
			return { items: list.slice(start, start + size), next: start + size < list.length ? start + size : undefined };
		},
		async doc(token: { definition: { kind: string; family?: true; initial: (seed?: unknown) => unknown } }, _conversation: unknown, key?: string, seed?: unknown) {
			if (token.definition.kind === "pi.usage") return { models: models ?? {}, tools: {} };
			const name = token.definition.family ? `${token.definition.kind}/${key}` : token.definition.kind;
			return (docs[name] ??= structuredClone(token.definition.initial(seed)));
		},
	} as never;
}

describe("quanto costa un turno (ADR 0098)", () => {
	it("adds every model call from the answer back to the end of the previous turn, with the tools in order", async () => {
		const entries: FakeEntry[] = [
			assistant(6, said(0.003)),
			{ id: 5, model: [{ role: "toolResult" }] },
			assistant(4, said(0.002, "web_search")),
			{ id: 3, model: [{ role: "toolResult" }, { role: "toolResult" }] },
			assistant(2, said(0.001, "memory_recall", "calendar_list")),
			input(1),
			assistant(0, said(9)),
		];
		const usage = await turnUsage(fakeTx(entries), 1 as never, 6 as never);
		expect(usage).toEqual({ modelCalls: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 15, costUsd: expect.closeTo(0.006, 9), tools: ["memory_recall", "calendar_list", "web_search"] });
	});

	it("knows nothing when the answer is not where it should be", async () => {
		expect(await turnUsage(fakeTx([assistant(1, said(1))]), 1 as never, 9 as never)).toBeUndefined();
	});

	it("a next run longer than any page bound is taken out whole: the older answer is billed its own, the next one never below zero", async () => {
		const docs = fresh();
		const first: FakeEntry[] = [assistant(2, said(0.5)), input(1)];
		expect((await turnUsage(fakeTx(first, 50, { "p/m": ledger(0.5) }, docs), 1 as never, 2 as never))?.costUsd).toBeCloseTo(0.5, 9);
		// A answered at 4; the next run has already called 1500 tools when A is read.
		const calls = Array.from({ length: 1500 }, (_, i) => assistant(1506 - i, said(0.001, "web_search")));
		const running: FakeEntry[] = [...calls, input(5), assistant(4, said(1)), input(3), ...first];
		expect((await turnUsage(fakeTx(running, 50, { "p/m": ledger(0.5 + 1 + 1.5) }, docs), 1 as never, 4 as never))?.costUsd).toBeCloseTo(1, 9);
		// Its answer, B, takes its own run: 1500 calls and the answer.
		const done: FakeEntry[] = [assistant(1507, said(0.001)), ...running];
		const b = await turnUsage(fakeTx(done, 50, { "p/m": ledger(0.5 + 1 + 1.5 + 0.001) }, docs), 1 as never, 1507 as never);
		expect(b?.costUsd).toBeCloseTo(1.501, 9);
		expect(b?.modelCalls).toBe(1501);
	});

	it("a request that failed and was retried, or was cut short, does not end the run: the run's every call is counted", async () => {
		const entries: FakeEntry[] = [
			assistant(6, said(0.3)),
			{ id: 5, model: [{ role: "toolResult" }] },
			assistant(4, said(0.2, "web_search")),
			assistant(3, failed(0.05, "aborted")),
			assistant(2, failed(0.05)),
			input(1),
			assistant(0, said(9)),
		];
		const usage = await turnUsage(fakeTx(entries), 1 as never, 6 as never);
		expect(usage).toMatchObject({ modelCalls: 4, costUsd: expect.closeTo(0.6, 9), tools: ["web_search"] });
	});

	it("a compaction's summary is billed to the run it happened in, from Pi's own ledger, and a turn is billed once", async () => {
		const docs = fresh();
		// The previous turn: billed by what its run called.
		const first: FakeEntry[] = [assistant(2, said(0.1)), input(1)];
		expect(await turnUsage(fakeTx(first, 2, { "p/m": ledger(0.1, 100) }, docs), 1 as never, 2 as never)).toMatchObject({ modelCalls: 1, costUsd: expect.closeTo(0.1, 9) });
		// This turn overflowed: Pi compacted (a summary costing 0.25, in pi.usage only) and answered.
		const entries: FakeEntry[] = [assistant(6, said(0.3)), { id: 5, kind: "pi.compaction", model: [asked] }, assistant(4, failed(0.05)), input(3), ...first];
		const models = { "p/m": ledger(0.1 + 0.05 + 0.25 + 0.3, 1000) };
		const billedBefore = structuredClone(docs);
		const usage = await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 6 as never);
		expect(usage).toMatchObject({ modelCalls: 3, inputTokens: 900, costUsd: expect.closeTo(0.6, 9), tools: [] });
		// Answered again after a crash: the same bill, not a second one.
		expect(await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 6 as never)).toEqual(usage);
		// What the next run has called already is its own.
		const later: FakeEntry[] = [assistant(8, said(0.4, "web_search")), input(7), ...entries];
		const next = await turnUsage(fakeTx(later, 2, { "p/m": ledger(0.7 + 0.4, 1100) }, billedBefore), 1 as never, 6 as never);
		expect(next?.costUsd).toBeCloseTo(0.6, 9);
	});

	it("the first turn of a conversation pays its compaction's summary too: nothing Pi spent is left out", async () => {
		const docs = fresh();
		// The first turn overflowed: a summary costing 0.25 (in pi.usage only), then the answer at 0.30.
		const first: FakeEntry[] = [assistant(4, said(0.3)), { id: 3, kind: "pi.compaction", model: [asked] }, assistant(2, failed(0)), input(1)];
		expect((await turnUsage(fakeTx(first, 2, { "p/m": ledger(0.55) }, docs), 1 as never, 4 as never))?.costUsd).toBeCloseTo(0.55, 9);
		const second: FakeEntry[] = [assistant(6, said(0.1)), input(5), ...first];
		expect((await turnUsage(fakeTx(second, 2, { "p/m": ledger(0.65) }, docs), 1 as never, 6 as never))?.costUsd).toBeCloseTo(0.1, 9);
	});

	it("a conversation from before billing starts at its last answer, and its next turn pays its compaction's summary", async () => {
		const docs: Record<string, unknown> = {};
		// Before: two answers, 7 spent in all, never billed.
		const before: FakeEntry[] = [assistant(4, said(5)), input(3), assistant(2, said(2)), input(1)];
		await startBilling(fakeTx(before, 2, { "p/m": ledger(7) }, docs), 1 as never);
		// An answer from before has no bill; the next turn compacts (0.25) and answers (0.3).
		expect(await turnUsage(fakeTx(before, 2, { "p/m": ledger(7) }, docs), 1 as never, 4 as never)).toBeUndefined();
		const after: FakeEntry[] = [assistant(7, said(0.3)), { id: 6, kind: "pi.compaction", model: [asked] }, input(5), ...before];
		expect((await turnUsage(fakeTx(after, 2, { "p/m": ledger(7.55) }, docs), 1 as never, 7 as never))?.costUsd).toBeCloseTo(0.55, 9);
	});

	it("a conversation from before, opened in the middle of a run, bills that run's calls made before the restart", async () => {
		const docs: Record<string, unknown> = {};
		const before: FakeEntry[] = [assistant(4, said(0.2, "web_search")), input(3), assistant(2, said(2)), input(1)];
		await startBilling(fakeTx(before, 2, { "p/m": ledger(2.2) }, docs), 1 as never);
		const after: FakeEntry[] = [assistant(6, said(0.1)), { id: 5, model: [{ role: "toolResult" }] }, ...before];
		expect(await turnUsage(fakeTx(after, 2, { "p/m": ledger(2.3) }, docs), 1 as never, 6 as never)).toMatchObject({ modelCalls: 2, costUsd: expect.closeTo(0.3, 9), tools: ["web_search"] });
	});

	it("answers read again after a crash get their own bills back, the older one included", async () => {
		const docs = fresh();
		// A (0.10) and B (0.20) answered and read; the process dies before A reaches usage.jsonl.
		const entries: FakeEntry[] = [assistant(4, said(0.2)), input(3), assistant(2, said(0.1)), input(1)];
		const models = { "p/m": ledger(0.3) };
		const a = await turnUsage(fakeTx(entries.slice(2), 2, { "p/m": ledger(0.1) }, docs), 1 as never, 2 as never);
		const b = await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 4 as never);
		expect(a?.costUsd).toBeCloseTo(0.1, 9);
		expect(b?.costUsd).toBeCloseTo(0.2, 9);
		// Recovery reads both again, in either order.
		expect(await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 4 as never)).toEqual(b);
		expect(await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 2 as never)).toEqual(a);
	});

	it("answers read out of order are billed in order: the newer one does not take the older one's run", async () => {
		const docs = fresh();
		const entries: FakeEntry[] = [assistant(4, said(0.2)), input(3), assistant(2, said(0.1)), input(1)];
		const models = { "p/m": ledger(0.3) };
		expect((await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 4 as never))?.costUsd).toBeCloseTo(0.2, 9);
		expect((await turnUsage(fakeTx(entries, 2, models, docs), 1 as never, 2 as never))?.costUsd).toBeCloseTo(0.1, 9);
	});

	it("a turn with a tool writes its usage in the tenant's spend, once, and nothing in the audit", async () => {
		const { runtime, dataDir, replies } = await runtimeWithInstance({});
		const from = (text: string, messageId: string) => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text, messageId });
		await runtime.submit(from("conta fino a 2", "1"));
		await waitFor(() => replies.length === 1);
		await runtime.submit(from("ciao", "2"));
		await waitFor(() => replies.length === 2);
		await runtime.close();
		const ledger = (await readFile(join(tenantDir(dataDir, tenantId("acme")), "usage.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as UsageRecord);
		expect(ledger.map((r) => r.role)).toEqual(["agent", "agent"]);
		expect(ledger[0]).toMatchObject({ instanceId: "ops", threadId: "t1", provider: "faux", model: "owni-dev", modelCalls: 2, tools: ["slow_counter"] });
		expect(ledger[1]).toMatchObject({ modelCalls: 1, tools: [] });
		expect(new Set(ledger.map((r) => r.submissionId)).size).toBe(2);
		expect(await readFile(join(tenantDir(dataDir, tenantId("acme")), "audit.jsonl"), "utf8").catch(() => "")).not.toContain("turn.usage");
	});

	it("a conversation from before billing, with work left pending, bills that work even when it is reattached and answered before resume", async () => {
		const storageDir = tempDataDir();
		const open = () => piDurableEngine.open({ storageDir, model: { provider: "faux", modelId: "owni-dev" }, apiKey: async () => undefined, tools: [] });
		const replies: EngineReply[] = [];
		let session = await open();
		session.onReply((reply) => replies.push(reply));
		await session.submit("web:t1", "ciao");
		await waitFor(() => replies.length === 1);
		// Admitted, never run: the process stops right after.
		const { submissionId } = await session.submit("web:t1", "ancora");
		await session.close();
		// The conversation from before billing existed: no starting point.
		const db = new DatabaseSync(join(storageDir, "pi-durable.sqlite"));
		db.exec(`DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind = '"owni.billed-to"'); DELETE FROM documents WHERE kind = '"owni.billed-to"'`);
		db.close();

		// The runtime reattaches the outbox's entries before resume(): the scheduler starts there.
		session = await open();
		session.onReply((reply) => replies.push(reply));
		await session.reattach(submissionId, "web:t1");
		await waitFor(() => replies.length === 2);
		await session.resume();
		await session.close();
		expect(replies[1]).toMatchObject({ status: "answered", submissionId, usage: { modelCalls: 1 } });
	});

	it("sums the last 7 days per agente, with the tools called most", () => {
		const turn = (at: string, instanceId: string, estimatedUsd: number, tools: string[]): UsageRecord => ({ at, provider: "p", model: "m", role: "agent", inputTokens: 150, outputTokens: 10, estimatedUsd, instanceId, tools });
		const stats = turnStats([turn("2026-10-21T10:00:00Z", "ops", 0.01, ["web_search", "web_search"]), turn("2026-10-22T10:00:00Z", "casa", 0.03, ["memory_recall", "web_search"]), turn("2026-10-01T10:00:00Z", "ops", 5, ["old"]), { ...turn("2026-10-22T10:00:00Z", "ops", 7, []), role: "extract" }], new Date("2026-10-22T12:00:00Z"));
		expect(stats).toEqual({
			turns: 2,
			inputTokens: 300,
			outputTokens: 20,
			costUsd: expect.closeTo(0.04, 9),
			instances: [
				{ instanceId: "casa", turns: 1, costUsd: 0.03 },
				{ instanceId: "ops", turns: 1, costUsd: 0.01 },
			],
			tools: [
				{ name: "web_search", calls: 3 },
				{ name: "memory_recall", calls: 1 },
			],
		});
	});
});
