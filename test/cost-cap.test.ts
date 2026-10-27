/**
 * The daily hard cap (usage.ts): once today's recorded spend reaches it, no new model request
 * leaves, whatever started the turn, and the person is told so. Asked by the engine before each
 * request, so a turn that crosses the cap mid-way stops at its next call, and a resumed run too.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { connectorAction } from "../src/core/approvals.ts";
import type { DurableEngine } from "../src/core/engine.ts";
import { COST_CAPPED, OwniRuntime, type OwniTool, type Reply } from "../src/core/index.ts";
import { REPLY_CAPPED } from "../src/gateway.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

/** The dev model with a price: each request it answers costs `usd`, in Pi's usage of the conversation. */
const price = vi.hoisted(() => ({ usd: 0 }));
vi.mock("../src/core/adapters/pi-durable-models.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/adapters/pi-durable-models.ts")>();
	const priced = (provider: Provider): Provider => ({
		...provider,
		streamSimple: (model, transcript, options) => {
			const inner = provider.streamSimple(model, transcript, options);
			const out = new AssistantMessageEventStream();
			void (async () => {
				for await (const event of inner) {
					if (event.type === "done") event.message.usage.cost.total = price.usd;
					if (event.type === "error") event.error.usage.cost.total = price.usd;
					out.push(event);
				}
				out.end();
			})();
			return out;
		},
	});
	return { ...actual, createProvider: (...args: Parameters<typeof actual.createProvider>) => (price.usd > 0 && args[0] === "faux" ? priced(actual.createProvider(...args)) : actual.createProvider(...args)) };
});

const runtimes: OwniRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	price.usd = 0;
});

/** The ledger's rows; none before the first one is written. */
const records = (dataDir: string) =>
	(existsSync(join(tenantDir(dataDir), "usage.jsonl")) ? readFileSync(join(tenantDir(dataDir), "usage.jsonl"), "utf8") : "")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { at: string; estimatedUsd: number; submissionId?: string; threadId?: string });

/** A tool that waits until the test lets it go, or the turn is stopped. */
function heldTool(): { tool: OwniTool; started: string[]; release: () => void } {
	const started: string[] = [];
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	return {
		started,
		release: () => release(),
		tool: {
			name: "hold",
			description: "Waits.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute(_args, ctx) {
				started.push(ctx.thread!.threadId);
				await new Promise<void>((resolve, reject) => {
					ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
					void released.then(resolve);
				});
				return "fatto";
			},
		},
	};
}

const tenantDir = (dataDir: string) => join(dataDir, "tenants", "acme");

/** Spend on record today, as recordTurn writes it: 25 USD is over the default hard cap of 20. */
function spend(dataDir: string, usd: number): void {
	mkdirSync(tenantDir(dataDir), { recursive: true });
	appendFileSync(join(tenantDir(dataDir), "usage.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), provider: "p", model: "m", role: "agent", inputTokens: 0, outputTokens: 0, estimatedUsd: usd })}\n`);
}

const rows = (dataDir: string) => readFileSync(join(tenantDir(dataDir), "usage.jsonl"), "utf8").trim().split("\n").length;
const denials = (dataDir: string) =>
	readFileSync(join(tenantDir(dataDir), "audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === "cost.denied");

async function setup(tools: OwniTool[] = []) {
	const made = await runtimeWithInstance({ tools, egress: { modelProviders: ["faux"], channels: ["test", "agente"] }, allowedUsers: { test: ["u"], agente: ["altro"] } });
	runtimes.push(made.runtime);
	dirs.push(made.dataDir);
	return made;
}

describe("daily hard cap", () => {
	it("refuses a person's turn before any model request, on record first, and tells the person in Italian", async () => {
		const { runtime, dataDir, replies } = await setup();
		spend(dataDir, 25);
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: "ciao", messageId: "m1" });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadId: "p", status: "unanswered", reason: COST_CAPPED });
		expect(denials(dataDir)).toEqual([expect.objectContaining({ instanceId: "ops", day: expect.any(String), spentUsd: 25, hardUsd: 20, channel: "test", threadId: "p" })]);
		// Nothing was spent: no answer to record.
		expect(rows(dataDir)).toBe(1);
		expect(REPLY_CAPPED).toMatch(/tetto di spesa/);
	});

	it("refuses a scheduled task and another agente's message the same way", async () => {
		const { runtime, dataDir, replies } = await setup();
		spend(dataDir, 25);
		await runtime.submitScheduled("acme", "ops", { channel: "test", threadId: "s", text: "[Task programmato S-1] Riassunto", messageId: "s1", scheduleId: "S-1", onBehalfOf: { channel: "test", userId: "u" } });
		await runtime.submitNotice("acme", "ops", { channel: "test", threadId: "n", text: "Risposta di un altro agente", messageId: "n1", event: { kind: "test" }, origin: "agent" });
		await waitFor(() => replies.length === 2);
		expect(replies.map((r) => [r.threadId, r.status === "unanswered" && r.reason === COST_CAPPED]).sort()).toEqual([
			["n", true],
			["s", true],
		]);
		expect(denials(dataDir).map((d) => d.threadId).sort()).toEqual(["n", "s"]);
	});

	it("stops a turn that crosses the cap mid-way at its next model request; the tool call already made stands", async () => {
		let ran = 0;
		const costly: OwniTool = {
			name: "costly",
			description: "Spends a lot.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute() {
				ran += 1;
				// Another turn of the tenant answers and is recorded while this one runs.
				spend(dataDir, 25);
				return "fatto";
			},
		};
		const { runtime, dataDir, replies } = await setup([costly]);
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: "/tool costly {}", messageId: "m1" });
		await waitFor(() => replies.length === 1);
		expect(ran).toBe(1);
		expect(replies[0]).toMatchObject({ status: "unanswered", reason: COST_CAPPED });
		expect(denials(dataDir)).toHaveLength(1);
	});

	it("refuses a run resumed after a restart", async () => {
		const first = await setup();
		await first.runtime.close();
		// Admitted, then the process stops before the run starts.
		const stopAfterAdmission: DurableEngine = {
			async open(options) {
				const session = await piDurableEngine.open(options);
				let closed: Promise<void> | undefined;
				const close = () => (closed ??= session.close());
				return {
					submit: async (threadKey, text, requestId) => {
						const result = await session.submit(threadKey, text, requestId);
						await close();
						return result;
					},
					resume: () => session.resume(),
					reattach: (submissionId, threadKey) => session.reattach(submissionId, threadKey),
					setThreadModel: (threadKey, model) => session.setThreadModel(threadKey, model),
					threadModel: (threadKey) => session.threadModel(threadKey),
					onReply: (listener) => session.onReply(listener),
					idle: () => session.idle(),
					close,
				};
			},
		};
		const stopping = new OwniRuntime({ dataDir: first.dataDir, engine: stopAfterAdmission });
		const instance = await stopping.openInstance("acme", "ops");
		await instance.submit({ channel: "test", threadId: "r", userId: "u", text: "ciao", messageId: "m1" });
		await stopping.close();

		spend(first.dataDir, 25);
		const second = new OwniRuntime({ dataDir: first.dataDir, engine: piDurableEngine });
		runtimes.push(second);
		const replies: Reply[] = [];
		second.onReply((reply) => replies.push(reply));
		await second.resume("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadId: "r", status: "unanswered", reason: COST_CAPPED });
		expect(denials(first.dataDir)).toHaveLength(1);
	});

	it("still runs an action approved earlier, which needs no model; only the turn reporting it is refused", async () => {
		const { runtime, dataDir, replies } = await setup();
		const proposed = await runtime.connectorActions("acme", "ops").propose({ connectorId: "c1", connectorName: "CRM", server: "crm", tool: "add_note", toolTitle: "Aggiungi nota", args: { text: "x" }, reason: "richiesta", destructive: false, thread: { channel: "test", threadId: "a" }, requester: "test:u" });
		spend(dataDir, 25);
		let ran = 0;
		const decided = await connectorAction(async () => {
			ran += 1;
			return { text: "nota aggiunta" };
		}).settle(runtime, "acme", "ops", proposed.id, "approved", { channel: "test", userId: "u" });
		expect(ran).toBe(1);
		expect(decided.status).toBe("done");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadId: "a", status: "unanswered", reason: COST_CAPPED });
	});

	it("lets every turn through under the cap", async () => {
		const { runtime, dataDir, replies } = await setup();
		spend(dataDir, 19);
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: "ciao", messageId: "m1" });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "answered" });
		expect(denials(dataDir)).toEqual([]);
	});
});

describe("spend of a turn that ends unanswered", () => {
	it("is billed when the turn is refused, so the next day the conversation answers again", async () => {
		const quick: OwniTool = { name: "quick", description: "Quick.", parameters: { type: "object", properties: {}, additionalProperties: false }, replaySafe: true, execute: async () => "fatto" };
		const { runtime, dataDir, replies } = await setup([quick]);
		price.usd = 30;
		// Its first request costs 30, over the cap of 20: the next one is refused.
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: "/tool quick {}", messageId: "m1" });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "unanswered", reason: COST_CAPPED });
		const refused = records(dataDir);
		// The day turns: what was spent is yesterday's.
		const yesterday = new Date(Date.now() - 86_400_000).toISOString();
		writeFileSync(join(tenantDir(dataDir), "usage.jsonl"), refused.map((r) => `${JSON.stringify({ ...r, at: yesterday })}\n`).join(""));
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: "ciao", messageId: "m2" });
		await waitFor(() => replies.length === 2);
		expect(replies[1]).toMatchObject({ status: "answered" });
		expect(denials(dataDir)).toHaveLength(1);
		expect(refused).toEqual([expect.objectContaining({ threadId: "p", estimatedUsd: 30, submissionId: expect.any(String) })]);
		expect(records(dataDir).map((r) => r.estimatedUsd)).toEqual([30, 30]);
	});

	it("is on the ledger when the person stops the turn, once", async () => {
		const held = heldTool();
		const { runtime, dataDir, replies } = await setup([held.tool]);
		price.usd = 3;
		const { runId } = await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "u", text: "/tool hold {}", messageId: "m1" });
		await waitFor(() => held.started.length === 1);
		await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "p" });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "unanswered", cancelled: true });
		const run = (await runtime.listRuns("acme", "ops")).find((r) => r.id === runId);
		expect(records(dataDir)).toEqual([expect.objectContaining({ threadId: "p", estimatedUsd: 3, submissionId: run?.submissionId, provider: "faux", model: expect.stringMatching(/.+/) })]);
	});

	it("turns of two conversations at the same time each see only their own unrecorded spend: together they pass the cap, each by at most one request", async () => {
		const held = heldTool();
		const { runtime, dataDir, replies } = await setup([held.tool]);
		price.usd = 15;
		for (const threadId of ["a", "b"]) await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId, userId: "u", text: "/tool hold {}", messageId: `m-${threadId}` });
		await waitFor(() => held.started.length === 2);
		held.release();
		await waitFor(() => replies.length === 2);
		// Each turn: 15 recorded nowhere yet, under 20, so its second request goes too.
		expect(replies.map((r) => r.status)).toEqual(["answered", "answered"]);
		expect(records(dataDir).reduce((sum, r) => sum + r.estimatedUsd, 0)).toBe(60);
		// Two conversations, each up to the cap plus one request: at most 2 * (20 + 15).
		expect(60).toBeLessThanOrEqual(2 * (20 + 15));
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "c", userId: "u", text: "ciao", messageId: "m-c" });
		await waitFor(() => replies.length === 3);
		expect(replies[2]).toMatchObject({ threadId: "c", reason: COST_CAPPED });
	});
});
