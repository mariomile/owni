/**
 * The daily hard cap (usage.ts): once today's recorded spend reaches it, no new model request
 * leaves, whatever started the turn, and the person is told so. Asked by the engine before each
 * request, so a turn that crosses the cap mid-way stops at its next call, and a resumed run too.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { connectorAction } from "../src/core/approvals.ts";
import type { DurableEngine } from "../src/core/engine.ts";
import { OwniRuntime, type OwniTool, type Reply } from "../src/core/index.ts";
import { REPLY_CAPPED } from "../src/gateway.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const runtimes: OwniRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
		expect(replies[0]).toMatchObject({ threadId: "p", status: "unanswered", reason: "cost_capped", capped: true });
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
		expect(replies.map((r) => [r.threadId, r.status === "unanswered" && r.capped === true]).sort()).toEqual([
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
		expect(replies[0]).toMatchObject({ status: "unanswered", capped: true });
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
		expect(replies[0]).toMatchObject({ threadId: "r", status: "unanswered", capped: true });
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
		expect(replies[0]).toMatchObject({ threadId: "a", status: "unanswered", capped: true });
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
