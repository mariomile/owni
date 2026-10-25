import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime } from "../src/core/runtime.ts";
import type { OwniTool, DurableEngine, EngineRunEvent, EngineSession } from "../src/core/engine.ts";
import { RunStore, type RunEvent, type RunRecord, RUN_HISTORY_LIMIT, RUN_PROGRESS_LIMIT } from "../src/core/run-store.ts";
import { writeFileAtomic } from "../src/core/atomic-file.ts";
import { FAUX_MODEL, runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";
import { kill9, spawnFixture, type Worker } from "./processes.ts";

const hello = { tenantId: "acme", instanceId: "ops", channel: "test", threadId: "one", userId: "u", text: "hello", messageId: "first" };
const open: OwniRuntime[] = [];
afterEach(async () => { try { await Promise.all(open.splice(0).map((runtime) => runtime.close())); } finally { vi.restoreAllMocks(); } });
const register = (runtime: OwniRuntime) => { open.push(runtime); return runtime; };

function slowTool(effects: string[], ms = 400): OwniTool {
	return { name: "slow", description: "A deterministic slow tool", parameters: { type: "object", properties: {} }, replaySafe: true,
		async execute(_args, ctx) {
			effects.push(`${ctx.thread?.threadId}:start`);
			ctx.progress("secret-password=must-not-appear-in-run-history");
			await delay(ms, undefined, { signal: ctx.signal });
			await ctx.step("effect", async () => { effects.push(`${ctx.thread?.threadId}:effect`); return true; });
			return "private tool result must not be in history";
		},
	};
}


/** A tool advances only when the test releases its thread; scheduling load cannot complete it early. */
function heldTool(effects: string[]): { tool: OwniTool; release: (threadId: string) => void } {
	const releases = new Map<string, () => void>();
	return {
		release(threadId) {
			const release = releases.get(threadId);
			if (release === undefined) throw new Error(`No held tool for ${threadId}`);
			release();
		},
		tool: { ...slowTool(effects), async execute(_args, ctx) {
			const thread = ctx.thread!.threadId;
			effects.push(`${thread}:start`);
			ctx.progress("secret-password=must-not-appear-in-run-history");
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => { releases.delete(thread); ctx.signal.removeEventListener("abort", abort); };
				const abort = () => { cleanup(); reject(ctx.signal.reason); };
				releases.set(thread, () => { cleanup(); resolve(); });
				ctx.signal.addEventListener("abort", abort, { once: true });
				if (ctx.signal.aborted) abort();
			});
			await ctx.step("effect", async () => { effects.push(`${thread}:effect`); return true; });
			return "private tool result must not be in history";
		} },
	};
}

async function setup(tools: OwniTool[] = []) {
	const result = await runtimeWithInstance({ tools });
	register(result.runtime);
	return result;
}

describe("observable cancellable work", () => {
	it("publishes persisted progress before finishing, deduplicates messages, and keeps delivery separate", async () => {
		const effects: string[] = [];
		const held = heldTool(effects);
		const { runtime, dataDir, replies } = await setup([held.tool]);
		const events: RunEvent[] = [];
		runtime.onRunEvent((event) => events.push(event));
		const request = { ...hello, text: '/tool slow {"credential":"never-store-args"}' };
		const [admitted, duplicate] = await Promise.all([runtime.submit(request), runtime.submit(request)]);
		expect(duplicate).toEqual(admitted);
		await waitFor(() => events.some((event) => event.run.progress.some((p) => p.kind === "tool_start")));
		expect(replies).toHaveLength(0);
		expect(await runtime.currentRuns("acme", "ops", { channel: "test", threadId: "one" })).toMatchObject([{ status: "running", id: admitted.runId }]);
		held.release("one");
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(effects).toEqual(["one:start", "one:effect"]);
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ id: admitted.runId, status: "succeeded", delivery: "pending", userId: "u", origin: "person" }]);
		await runtime.deliveryFailed(replies[0]!, { refused: true, reason: "private delivery error" });
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "succeeded", delivery: "failed" }]);
		await runtime.markDelivered(replies[0]!);
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "succeeded", delivery: "delivered" }]);
		const stored = await readFile(join(dataDir, "tenants/acme/instances/ops/runs.json"), "utf8");
		for (const secret of ["must-not-appear", "never-store-args", "private tool result", "private delivery error"]) expect(stored).not.toContain(secret);
		for (let i = 1; i < events.length; i++) expect(events[i]!.run.updatedAt > events[i - 1]!.run.updatedAt).toBe(true);
	});

	it("stops the active and queued submissions of one thread, while another completes", async () => {
		const effects: string[] = [];
		const held = heldTool(effects);
		const { runtime } = await setup([held.tool]);
		const first = await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.includes("one:start"));
		const queued = await runtime.submit({ ...hello, text: "/tool slow {}", messageId: "queued" });
		const second = await runtime.submit({ ...hello, threadId: "two", text: "/tool slow {}" });
		await waitFor(() => effects.includes("two:start"));
		expect((await runtime.listRuns("acme", "ops")).find((run) => run.id === queued.runId)?.status).toBe("queued");
		const stopped = await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" });
		expect(stopped.cancelled).toBe(2);
		expect(stopped.runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
		held.release("two");
		await runtime.idle("acme", "ops");
		expect(effects).toEqual(["one:start", "two:start", "two:effect"]);
		const runs = await runtime.listRuns("acme", "ops");
		expect(runs.find((run) => run.id === first.runId)?.status).toBe("cancelled");
		expect(runs.find((run) => run.id === second.runId)?.status).toBe("succeeded");
		expect(await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "two" })).toEqual({ cancelled: 0, runs: [] });
		await runtime.submit({ ...hello, messageId: "after-stop", text: "new input" });
		await runtime.idle("acme", "ops");
		expect((await runtime.listRuns("acme", "ops")).find((run) => run.messageId === "after-stop")?.status).toBe("succeeded");
	});

	it("persists user-requested cancellation on unanswered delivery through restart", async () => {
		const effects: string[] = [];
		const { runtime, dataDir, replies } = await setup([heldTool(effects).tool]);
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" });
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "unanswered", reason: "aborted", cancelled: true });
		await runtime.close(); open.splice(open.indexOf(runtime), 1);
		const restarted = register(new OwniRuntime({ dataDir, engine: piDurableEngine }));
		const repeated: unknown[] = [];
		restarted.onReply((reply) => repeated.push(reply));
		await restarted.resume("acme", "ops");
		expect(repeated).toMatchObject([{ status: "unanswered", cancelled: true }]);
	});

	it("does not claim a user Stop for an engine abort without persisted user intent", async () => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		const effects: string[] = [];
		let session!: EngineSession;
		const engine: DurableEngine = { async open(options) { session = await piDurableEngine.open(options); return session; } };
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine, tools: [heldTool(effects).tool] }));
		const replies: unknown[] = [];
		runtime.onReply((reply) => replies.push(reply));
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		await session.stop!("test:one");
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(replies[0]).not.toHaveProperty("cancelled");
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "failed" }]);
	});

	it("guards later ctx.step calls even when a tool ignores its cancellation signal", async () => {
		const effects: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		let signal: AbortSignal | undefined;
		const tool: OwniTool = { ...slowTool(effects), async execute(_args, ctx) { signal = ctx.signal; effects.push("started"); await held; await ctx.step("after-stop", async () => { effects.push("unsafe"); return true; }); return "done"; } };
		const { runtime } = await setup([tool]);
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		const stopping = runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" });
		try { await waitFor(() => signal?.aborted === true); }
		finally { release(); }
		expect((await stopping).cancelled).toBe(1);
		expect(effects).toEqual(["started"]);
	});

	it("keeps a completed result when completion wins the race against Stop admission", async () => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let started = false;
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "stop") return async (thread: string) => { release(); await session.idle(); await session.stop!(thread); };
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		const tool: OwniTool = { ...slowTool([]), async execute() { started = true; await held; return "done"; } };
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine, tools: [tool] }));
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => started);
		const result = await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" });
		expect(result.cancelled).toBe(0);
		expect(result.runs).toMatchObject([{ status: "succeeded", cancelRequestedAt: expect.any(String) }]);
	});

	it("retains source/owner metadata and completed outcomes across restart and duplicate refires", async () => {
		const { runtime, dataDir } = await setup();
		const submissions = [];
		for (const kind of [undefined, "brief", "watch", "automation"] as const) {
			const request = { channel: "test", threadId: "one", text: "automatic", messageId: `event-${kind}`, scheduleId: `source-${kind}`, onBehalfOf: { channel: "test", userId: "u" }, kind };
			submissions.push({ request, result: await runtime.submitScheduled("acme", "ops", request) });
		}
		await runtime.idle("acme", "ops");
		await runtime.close(); open.splice(open.indexOf(runtime), 1);
		const restarted = register(new OwniRuntime({ dataDir, engine: piDurableEngine }));
		const before = await restarted.listRuns("acme", "ops");
		expect(before).toHaveLength(4);
		for (const item of submissions) {
			expect(before.find((run) => run.id === item.result.runId)).toMatchObject({ status: "succeeded", origin: "scheduled", source: item.request.kind ?? "schedule", sourceId: item.request.scheduleId, scheduleId: item.request.scheduleId, onBehalfOf: item.request.onBehalfOf });
			expect(await restarted.submitScheduled("acme", "ops", item.request)).toEqual(item.result);
		}
		expect(await restarted.listRuns("acme", "ops")).toHaveLength(4);
	});

	it("recovers an interrupted tool, and does not classify runtime shutdown as Stop", async () => {
		const effects: string[] = [];
		const held = heldTool(effects);
		const { runtime, dataDir } = await setup([held.tool]);
		const admitted = await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		await runtime.close(); open.splice(open.indexOf(runtime), 1);
		const restarted = register(new OwniRuntime({ dataDir, engine: piDurableEngine, tools: [held.tool] }));
		expect((await restarted.listRuns("acme", "ops"))[0]?.status).toBe("running");
		await restarted.resume("acme", "ops");
		await waitFor(() => effects.filter((effect) => effect === "one:start").length === 2);
		held.release("one");
		await restarted.idle("acme", "ops");
		expect(await restarted.listRuns("acme", "ops")).toMatchObject([{ id: admitted.runId, status: "succeeded" }]);
		expect(effects.filter((effect) => effect.endsWith(":effect"))).toEqual(["one:effect"]);
	});

	it("repairs a lost admission acknowledgement in the same process without running twice", async () => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let loseAck = true;
		const effects: string[] = [];
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "submit") return async (...args: Parameters<EngineSession["submit"]>) => {
					const admitted = await session.submit(...args);
					if (loseAck) { loseAck = false; throw new Error("ack lost"); }
					return admitted;
				};
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine, tools: [slowTool(effects, 100)] }));
		const replies: unknown[] = [];
		runtime.onReply((reply) => replies.push(reply));
		const request = { ...hello, text: "/tool slow {}" };
		await expect(runtime.submit(request)).rejects.toThrow("ack lost");
		const retry = await runtime.submit(request);
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ id: retry.runId, submissionId: retry.submissionId, status: "succeeded" }]);
		expect(effects).toEqual(["one:start", "one:effect"]);
	});

	it("retries an unadmitted failure with the same identity and rejects late terminal changes", async () => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let fail = true;
		let emit!: (event: EngineRunEvent) => void;
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "submit") return (...args: Parameters<EngineSession["submit"]>) => { if (fail) { fail = false; return Promise.reject(new Error("private credential failure")); } return session.submit(...args); };
				if (key === "onRunEvent") return (listener: (event: EngineRunEvent) => void) => { emit = listener; return session.onRunEvent!(listener); };
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine }));
		await expect(runtime.submit(hello)).rejects.toThrow("private credential failure");
		const failed = (await runtime.listRuns("acme", "ops"))[0]!;
		expect(failed.status).toBe("failed");
		expect(failed.delivery).toBe("not_applicable");
		expect(failed.error).not.toContain("credential");
		const retry = await runtime.submit(hello);
		expect(retry.runId).toBe(failed.id);
		await runtime.idle("acme", "ops");
		emit({ threadKey: "test:one", submissionId: retry.submissionId, status: "cancelled" });
		await runtime.idle("acme", "ops");
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ id: failed.id, status: "succeeded" }]);
	});
});

describe("restored Stop and uncertain admission", () => {
	async function restoredStop(tools: OwniTool[]) {
		const dataDir = tempDataDir();
		const worker = spawnFixture("run-stop-worker.ts", [dataDir]);
		try { await worker.waitForLine("STOP_INTENT"); }
		finally { await kill9(worker); }
		let harness!: Harness;
		const originalOpen = Harness.open;
		vi.spyOn(Harness, "open").mockImplementation(async (...args) => { harness = await originalOpen(...args); return harness; });
		const runtime = register(new OwniRuntime({ dataDir, engine: piDurableEngine, tools }));
		await runtime.openInstance("acme", "ops");
		return { runtime, harness };
	}

	it("keeps a restored guard when abort starts the scheduler then fails, and reports user cancellation", async () => {
		const effects: string[] = [];
		const { runtime, harness } = await restoredStop([slowTool(effects, 0)]);
		const replies: unknown[] = [];
		runtime.onReply((reply) => replies.push(reply));
		const conversation = harness.conversation.bind(harness);
		let failedAborts = 0;
		vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args) => {
			const current = await conversation(...args);
			vi.spyOn(current!, "abort").mockImplementationOnce(async () => {
				failedAborts++;
				harness.resume(); // Pi resumes before attempting its abort commit.
				throw new Error("abort commit failed once");
			});
			return current;
		});
		const resumed = await runtime.resume("acme", "ops").then(() => "ok", () => "rejected");
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		expect(failedAborts).toBe(1);
		expect(effects).toEqual([]);
		expect(resumed).toBe("ok");
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "cancelled", cancelRequestedAt: expect.any(String) }]);
		expect(replies).toMatchObject([{ status: "unanswered", cancelled: true }]);
		await runtime.submit({ ...hello, messageId: "after-retry" });
		await runtime.idle("acme", "ops");
		expect((await runtime.listRuns("acme", "ops")).find((run) => run.messageId === "after-retry")?.status).toBe("succeeded");
	});

	it("isolates a persistently failing restored Stop from another thread's resume, submit and Stop", async () => {
		const effects: string[] = [];
		const held = heldTool(effects);
		const { runtime, harness } = await restoredStop([held.tool]);
		const conversation = harness.conversation.bind(harness);
		let stoppedId: number | undefined;
		let failedAborts = 0;
		vi.spyOn(harness, "conversation").mockImplementation(async (...args) => {
			const current = await conversation(...args);
			stoppedId ??= current?.id;
			if (current?.id === stoppedId && current !== undefined) vi.spyOn(current, "abort").mockImplementation(async () => {
				failedAborts++;
				harness.resume();
				throw new Error("abort commit persistently unavailable");
			});
			return current;
		});
		await expect(runtime.resume("acme", "ops")).resolves.toBeDefined();
		await runtime.submit({ ...hello, threadId: "two", text: "/tool slow {}" });
		await waitFor(() => effects.includes("two:start"));
		expect((await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "two" })).cancelled).toBe(1);
		await expect(runtime.resume("acme", "ops")).resolves.toBeDefined();
		await runtime.submit({ ...hello, threadId: "two", messageId: "second" });
		await runtime.idle("acme", "ops");
		await expect(runtime.submit({ ...hello, messageId: "blocked" })).rejects.toThrow("abort commit persistently unavailable");
		await expect(runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).rejects.toThrow("abort commit persistently unavailable");
		expect(failedAborts).toBeGreaterThanOrEqual(3);
		expect(effects).toEqual(["two:start"]);
		expect((await runtime.listRuns("acme", "ops", { threadId: "two" })).find((run) => run.messageId === "second")?.status).toBe("succeeded");
	});

	it("still aborts actual work when attaching its Stop watcher fails", async () => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let session!: EngineSession;
		const engine: DurableEngine = { async open(options) { session = await piDurableEngine.open(options); return session; } };
		const effects: string[] = [];
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine, tools: [heldTool(effects).tool] }));
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(session as EngineSession & { watch: () => Promise<unknown> }, "watch").mockRejectedValueOnce(new Error("watch unavailable once"));
		expect((await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).cancelled).toBe(1);
		await runtime.idle("acme", "ops");
		expect(effects).toEqual(["one:start"]);
		expect(log).toHaveBeenCalled();
	});

	it.each([false, true])("Stop settles a confirmed absent admission after uncertainty (lookup still fails=%s)", async (retryLookup) => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let failLookup = true;
		let lookupCalls = 0;
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "submit") return async () => { throw new Error("admission unavailable"); };
				if (key === "lookupRun") return (...args: Parameters<NonNullable<EngineSession["lookupRun"]>>) => {
					lookupCalls++;
					if (failLookup) throw new Error("lookup unavailable");
					return session.lookupRun!(...args);
				};
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine }));
		await expect(runtime.submit(hello)).rejects.toThrow("admission unavailable");
		const uncertain = (await runtime.listRuns("acme", "ops"))[0]!;
		expect(uncertain).toMatchObject({ status: "queued", delivery: "pending" });
		if (retryLookup) {
			await expect(runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).rejects.toThrow("lookup unavailable");
			expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "queued", delivery: "pending", cancelRequestedAt: expect.any(String) }]);
		}
		failLookup = false;
		const stopped = await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" });
		expect(stopped).toMatchObject({ cancelled: 1, runs: [{ id: uncertain.id, status: "cancelled", delivery: "not_applicable", cancelRequestedAt: expect.any(String) }] });
		expect(stopped.runs[0]!.error).toBeUndefined();
		expect(stopped.runs[0]!.submissionId).toBeUndefined();
		const lookups = lookupCalls;
		await runtime.resume("acme", "ops");
		expect(lookupCalls).toBe(lookups);
		expect(await runtime.currentRuns("acme", "ops", { channel: "test", threadId: "one" })).toEqual([]);
		expect(await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).toEqual({ cancelled: 0, runs: [] });
	});

	it.each([false, true])("reconciles an uncertain acknowledgement without restart (admitted=%s)", async (admitted) => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let failSubmit = true;
		let failLookup = true;
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "submit") return async (...args: Parameters<EngineSession["submit"]>) => {
					if (!failSubmit) return session.submit(...args);
					failSubmit = false;
					if (admitted) await session.submit(...args);
					throw new Error("acknowledgement unavailable");
				};
				if (key === "lookupRun") return (...args: Parameters<NonNullable<EngineSession["lookupRun"]>>) => {
					if (failLookup) { failLookup = false; throw new Error("lookup unavailable once"); }
					return session.lookupRun!(...args);
				};
				// Observation is optional; recovery must not rely on a progress event finding the admission.
				if (key === "onRunEvent") return undefined;
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		const effects: string[] = [];
		const held = heldTool(effects);
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine, tools: [held.tool] }));
		const replies: unknown[] = [];
		runtime.onReply((reply) => replies.push(reply));
		const request = { ...hello, text: "/tool slow {}" };
		await expect(runtime.submit(request)).rejects.toThrow("acknowledgement unavailable");
		const uncertain = (await runtime.listRuns("acme", "ops"))[0]!;
		expect(uncertain.status).toBe("queued");
		expect(uncertain.delivery).toBe("pending");
		expect(uncertain.error).toBe("Submission acknowledgement could not be verified; retry safely.");
		await runtime.resume("acme", "ops");
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: admitted ? "running" : "failed", delivery: admitted ? "pending" : "not_applicable" }]);
		const retry = await runtime.submit(request);
		expect(retry.runId).toBe(uncertain.id);
		await waitFor(() => effects.length === 1);
		held.release("one");
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "succeeded" }]);
		expect((await runtime.listRuns("acme", "ops"))[0]!.error).toBeUndefined();
		expect(effects).toEqual(["one:start", "one:effect"]);
	});
});

describe("bounded private history", () => {
	it("resolves an event with one disk read, including no-ops, and sees externally replaced snapshots", async () => {
		const dir = tempDataDir();
		let reads = 0;
		class MeasuredStore extends RunStore { override async all() { reads++; return super.all(); } }
		const store = new MeasuredStore(dir);
		const run: RunRecord = { id: "r", tenantId: "a", instanceId: "b", channel: "web", threadId: "t", submissionId: "s", origin: "person", source: "message", status: "running", createdAt: "2026-10-23T10:00:00.000Z", updatedAt: "2026-10-23T10:00:00.000Z", progress: [] };
		await writeFileAtomic(join(dir, "runs.json"), JSON.stringify([run]));
		expect(await store.changeMatching((row) => row.submissionId === "s", (row) => row)).toEqual(run);
		expect(reads).toBe(1);
		await writeFileAtomic(join(dir, "runs.json"), JSON.stringify([{ ...run, status: "succeeded" }]));
		expect(await store.changeMatching((row) => row.submissionId === "s", (row) => row)).toMatchObject({ status: "succeeded" });
		expect(reads).toBe(2);
	});

	it("filters authorization and source before limit, bounds rows/progress and keeps active runs", async () => {
		const dir = tempDataDir();
		const store = new RunStore(dir);
		const record = (id: string): RunRecord => ({ id, tenantId: "a", instanceId: "b", channel: "web", threadId: "other", origin: "person", source: "message", status: "succeeded", createdAt: new Date(1_000 + Number(id)).toISOString(), updatedAt: new Date(1_000 + Number(id)).toISOString(), progress: [] });
		const own = { ...record("0"), threadId: "mine", source: "watch" as const };
		const active = { ...record("1"), id: "active", status: "running" as const };
		await writeFileAtomic(join(dir, "runs.json"), JSON.stringify([own, active, ...Array.from({ length: RUN_HISTORY_LIMIT + 5 }, (_, i) => record(String(i + 2)))]));
		expect(await store.list({ channel: "web", threadIds: ["mine"], sources: ["watch"], limit: 1 })).toEqual([own]);
		expect(await store.list({ threadIds: [] })).toEqual([]);
		await store.change("active", (run) => ({ ...run!, progress: Array.from({ length: 100 }, (_, i) => ({ at: "now", kind: "tool", message: String(i) })) }));
		expect(await store.all()).toHaveLength(RUN_HISTORY_LIMIT + 1);
		expect((await store.all()).find((run) => run.id === "active")?.progress).toHaveLength(RUN_PROGRESS_LIMIT);
	});
});

it("survives SIGKILL after Stop intent but before Pi abort: stopped tools never resume", async () => {
	const dataDir = tempDataDir();
	let worker: Worker | undefined;
	try {
		worker = spawnFixture("run-stop-worker.ts", [dataDir]);
		await worker.waitForLine("STOP_INTENT");
		await kill9(worker); worker = undefined;
		const effects: string[] = [];
		const runtime = register(new OwniRuntime({ dataDir, engine: piDurableEngine, tools: [slowTool(effects, 1)] }));
		await runtime.resume("acme", "ops");
		await runtime.idle("acme", "ops");
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "cancelled", cancelRequestedAt: expect.any(String) }]);
		expect(effects).toEqual([]);
		const old = (await runtime.listRuns("acme", "ops"))[0]!;
		expect(await runtime.submit({ ...hello, text: "/tool slow {}" })).toEqual({ submissionId: old.submissionId, runId: old.id });
		expect(effects).toEqual([]);
	} finally { if (worker !== undefined) await kill9(worker); }
}, 15_000);

it("repairs an outcome committed before submit returned and before the outbox existed", async () => {
	const dataDir = tempDataDir();
	let worker: Worker | undefined;
	try {
		worker = spawnFixture("run-stop-worker.ts", [dataDir, "admission"]);
		await worker.waitForLine("ADMITTED_OUTCOME");
		await kill9(worker); worker = undefined;
		const runtime = register(new OwniRuntime({ dataDir, engine: piDurableEngine }));
		const replies: unknown[] = [];
		runtime.onReply((reply) => replies.push(reply));
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "succeeded" }]);
		await runtime.resume("acme", "ops");
		await runtime.idle("acme", "ops");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "answered" });
		await runtime.resume("acme", "ops");
		await runtime.idle("acme", "ops");
		expect(replies).toHaveLength(1);
	} finally { if (worker !== undefined) await kill9(worker); }
}, 15_000);

it("records a genuine engine failure without a successful admission being mistaken for success", async () => {
	const { runtime } = await setup();
	await runtime.registry.setModel("acme", "ops", { provider: "faux", modelId: "missing-model" });
	await runtime.submit(hello);
	await runtime.idle("acme", "ops");
	expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "failed", error: "The agent did not complete this run." }]);
});


describe("backend failure recovery", () => {
	it.each(["lookup", "abort"] as const)("retries a failed %s before the adapter accepts the next submission", async (failure) => {
		let harness!: Harness;
		const originalOpen = Harness.open;
		vi.spyOn(Harness, "open").mockImplementation(async (...args) => { harness = await originalOpen(...args); return harness; });
		const session = await piDurableEngine.open({ storageDir: tempDataDir(), model: FAUX_MODEL, apiKey: async () => undefined, tools: [] });
		const replies: unknown[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.submit("test:one", "first", "first");
			await waitFor(() => replies.length === 1);
			const error = new Error(`stop ${failure} failed once`);
			if (failure === "lookup") vi.spyOn(harness, "conversation").mockRejectedValueOnce(error);
			else {
				const conversation = harness.conversation.bind(harness);
				vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args) => {
					const current = await conversation(...args);
					vi.spyOn(current!, "abort").mockRejectedValueOnce(error);
					return current;
				});
			}
			await expect(session.stop!("test:one")).rejects.toThrow(error.message);
			await session.submit("test:one", "next", "next");
			await waitFor(() => replies.length === 2);
			expect(replies[1]).toMatchObject({ status: "answered" });
		} finally { await session.close(); }
	});

	it.each(["submit", "stop"] as const)("retains a failed Stop's durable intent and retries through %s before new work", async (retry) => {
		let harness!: Harness;
		const originalOpen = Harness.open;
		vi.spyOn(Harness, "open").mockImplementation(async (...args) => { harness = await originalOpen(...args); return harness; });
		const effects: string[] = [];
		const { runtime } = await setup([heldTool(effects).tool]);
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		vi.spyOn(harness, "conversation").mockRejectedValueOnce(new Error("abort lookup failed once"));
		await expect(runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).rejects.toThrow("abort lookup failed once");
		expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status: "running", cancelRequestedAt: expect.any(String) }]);
		if (retry === "stop") expect((await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).cancelled).toBe(1);
		await runtime.submit({ ...hello, text: "next", messageId: "next" });
		// Prior work is cancelled before new work enters the same conversation.
		expect((await runtime.listRuns("acme", "ops")).find((run) => run.messageId === "first")?.status).toBe("cancelled");
		await runtime.idle("acme", "ops");
		expect((await runtime.listRuns("acme", "ops")).find((run) => run.messageId === "next")?.status).toBe("succeeded");
		expect(effects).toEqual(["one:start"]);
	});

	it("retries Stop without reconciling another thread still entering durable admission", async () => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const released = new Promise<void>((resolve) => { release = resolve; });
		let failStop = true;
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "submit") return async (...args: Parameters<EngineSession["submit"]>) => {
					if (args[0] === "test:two") { enter(); await released; }
					return session.submit(...args);
				};
				if (key === "stop") return async (thread: string) => {
					if (failStop) { failStop = false; throw new Error("abort unavailable once"); }
					return session.stop!(thread);
				};
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		const effects: string[] = [];
		const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine, tools: [heldTool(effects).tool] }));
		await runtime.submit({ ...hello, text: "/tool slow {}" });
		await waitFor(() => effects.length === 1);
		const other = runtime.submit({ ...hello, threadId: "two" });
		try {
			await entered;
			await expect(runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" })).rejects.toThrow("abort unavailable once");
			await runtime.submit({ ...hello, messageId: "next" });
		} finally { release(); await other; }
		await runtime.idle("acme", "ops");
		expect(await runtime.listRuns("acme", "ops", { threadId: "two" })).toMatchObject([{ status: "succeeded", delivery: "pending" }]);
		expect(effects).toEqual(["one:start"]);
	});

	it("keeps later running progress after one failed submission read in the event listener", async () => {
		let harness!: Harness;
		const originalOpen = Harness.open;
		vi.spyOn(Harness, "open").mockImplementation(async (...args) => { harness = await originalOpen(...args); return harness; });
		const effects: string[] = [];
		const held = heldTool(effects);
		const session = await piDurableEngine.open({ storageDir: tempDataDir(), model: FAUX_MODEL, apiKey: async () => undefined, tools: [held.tool] });
		const events: EngineRunEvent[] = [];
		const replies: unknown[] = [];
		session.onRunEvent!((event) => events.push(event));
		session.onReply((reply) => replies.push(reply));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const read = vi.spyOn(harness, "submission").mockRejectedValueOnce(new Error("progress read failed once"));
		try {
			await session.submit("test:one", "first", "first");
			await waitFor(() => replies.length === 1);
			expect(read).toHaveBeenCalled();
			const second = await session.submit("test:one", "/tool slow {}", "next");
			await waitFor(() => effects.includes("one:start"));
			await waitFor(() => events.some((event) => event.submissionId === second.submissionId && event.status === "running" && event.progress?.kind === "tool_start"), 1_000);
			expect(log).toHaveBeenCalled();
			expect(replies).toHaveLength(1);
			held.release("one");
			await session.idle();
			await waitFor(() => replies.length === 2);
		} finally { await session.close(); }
	});

	it.each(["failed", "cancelled"] as const)("reconciles a legacy unadmitted %s row once without claiming delivery", async (status) => {
		const first = await setup();
		await first.runtime.close(); open.splice(open.indexOf(first.runtime), 1);
		const file = join(first.dataDir, "tenants/acme/instances/ops/runs.json");
		const at = new Date().toISOString();
		const row: RunRecord = { id: "unadmitted", tenantId: "acme", instanceId: "ops", channel: "test", threadId: "one", messageId: "unadmitted", origin: "person", source: "message", status, createdAt: at, updatedAt: at, finishedAt: at, ...(status === "cancelled" ? { cancelRequestedAt: at } : {}), delivery: "pending", progress: [] };
		await writeFileAtomic(file, JSON.stringify([row]));
		let lookups = 0;
		const engine: DurableEngine = { async open(options) {
			const session = await piDurableEngine.open(options);
			return new Proxy(session, { get(target, key) {
				if (key === "lookupRun") return (...args: Parameters<NonNullable<EngineSession["lookupRun"]>>) => { lookups++; return session.lookupRun!(...args); };
				const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
			} });
		} };
		for (let restart = 0; restart < 2; restart++) {
			const runtime = register(new OwniRuntime({ dataDir: first.dataDir, engine }));
			await runtime.resume("acme", "ops");
			expect(await runtime.listRuns("acme", "ops")).toMatchObject([{ status, delivery: "not_applicable" }]);
			expect(await (await runtime.openInstance("acme", "ops")).undelivered()).toEqual([]);
			await runtime.close(); open.splice(open.indexOf(runtime), 1);
		}
		expect(lookups).toBe(1);
	});
});
