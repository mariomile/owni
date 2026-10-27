import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DUPLICATE_NOTICE } from "../src/channels/telegram.ts";
import { type ChannelAdapter, ChannelRefused, type OutboundMessage, type OutboundReaction } from "../src/channels/types.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, type DurableEngine, type EngineSession, Outbox, type OutboxEntry, type Reply } from "../src/core/index.ts";
import { connectChannel } from "../src/gateway.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";
import { kill9, spawnFixture, type Worker } from "./processes.ts";

const ANSWER = "Owni (modello locale di sviluppo): hai scritto «ciao»";
const outboxOf = (dataDir: string) => join(dataDir, "tenants", "acme", "instances", "ops", "outbox");

function outboxEntries(dataDir: string): OutboxEntry[] {
	const dir = outboxOf(dataDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as OutboxEntry);
}

/** A test channel: `send` runs the given behavior and records what it was asked to send. */
function testChannel(behavior: (message: OutboundMessage) => Promise<void>): ChannelAdapter & { sent: OutboundMessage[] } {
	const sent: OutboundMessage[] = [];
	return {
		name: "test",
		sent,
		start: async () => {},
		stop: async () => {},
		onInbound: () => {},
		send: async (message) => {
			sent.push(message);
			await behavior(message);
		},
	};
}

const hello = { tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text: "ciao", messageId: "m1" };

describe("reply outbox (in process)", () => {
	it("writes each reply to the outbox before the channel sends it, and marks it delivered after", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		let atSend: OutboxEntry[] = [];
		const channel = testChannel(async () => {
			atSend = outboxEntries(dataDir);
		});
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });

		await runtime.submit(hello);
		// markDelivered writes the outbox, then the audit: wait for the last of the two.
		let audit = await runtime.audit("acme").read();
		while (!audit.some((e) => e.type === "reply.delivered")) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			audit = await runtime.audit("acme").read();
		}

		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.possibleDuplicate).toBe(false);
		const key = channel.sent[0]?.idempotencyKey;
		expect(key).toMatch(/^reply:/);
		// At send time: on disk, not yet delivered.
		expect(atSend).toEqual([expect.objectContaining({ key, channel: "test", threadId: "t1", attempts: 1, reply: { status: "answered", text: ANSWER, model: { provider: "faux", modelId: "owni-dev" } } })]);
		expect(atSend[0]?.deliveredAt).toBeUndefined();
		// After the channel's ok: delivered.
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ key, attempts: 1, deliveredAt: expect.any(String) })]);
		expect(audit).toContainEqual(expect.objectContaining({ type: "reply.delivered", deliveryId: key, attempts: 1, possibleDuplicate: false }));
		expect(JSON.stringify(audit)).not.toContain("hai scritto");
		await runtime.close();
	});

	it("keeps a reply whose send failed and sends it once on the next resume", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		const failing = testChannel(async () => {
			throw new Error("channel down");
		});
		const logs: string[] = [];
		connectChannel(runtime, failing, { tenantId: "acme", instanceId: "ops" }, (line) => logs.push(line));
		await runtime.submit(hello);
		await waitFor(() => failing.sent.length === 1);
		await waitFor(() => logs.length === 1);
		expect(logs[0]).toContain("send failed, kept in the outbox: channel down");
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 1 })]);
		expect(outboxEntries(dataDir)[0]?.deliveredAt).toBeUndefined();
		await runtime.close();

		const next = new OwniRuntime({ dataDir, engine: piDurableEngine });
		const working = testChannel(async () => {});
		connectChannel(next, working, { tenantId: "acme", instanceId: "ops" });
		expect(await next.resume("acme", "ops")).toEqual({ pending: 0, undelivered: 1, reattached: 0 });
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		// A second resume in the same process, and the engine's own replies, send nothing more.
		await next.resume("acme", "ops");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(working.sent).toEqual([expect.objectContaining({ threadId: "t1", text: ANSWER, idempotencyKey: failing.sent[0]?.idempotencyKey })]);
		// The first try may have reached the user before failing: the second one says so.
		expect(failing.sent[0]?.possibleDuplicate).toBe(false);
		expect(working.sent[0]?.possibleDuplicate).toBe(true);
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 2 })]);
		await next.close();
	});
});

describe("reply outbox: retries in the same process", () => {
	it("retries a reply whose send failed, with backoff, until the channel takes it", async () => {
		const dataDir = tempDataDir();
		const { runtime } = await runtimeWithInstance({ dataDir });
		await runtime.close();
		const retrying = new OwniRuntime({ dataDir, engine: piDurableEngine, retryDelaysMs: [30, 60] });
		let failures = 2;
		const flaky = testChannel(async () => {
			if (failures-- > 0) throw new Error("network down");
		});
		connectChannel(retrying, flaky, { tenantId: "acme", instanceId: "ops" }, () => {});
		await retrying.submit(hello);
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		expect(flaky.sent).toHaveLength(3);
		expect(flaky.sent.map((m) => m.possibleDuplicate)).toEqual([false, true, true]);
		expect(new Set(flaky.sent.map((m) => m.idempotencyKey)).size).toBe(1);
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 3 })]);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(flaky.sent).toHaveLength(3);
		await retrying.close();
	});

	it("does not retry a reply the channel refused, and a close stops pending retries", async () => {
		const dataDir = tempDataDir();
		const { runtime } = await runtimeWithInstance({ dataDir });
		await runtime.close();
		const retrying = new OwniRuntime({ dataDir, engine: piDurableEngine, retryDelaysMs: [30] });
		const refusing = testChannel(async () => {
			throw new ChannelRefused("Forbidden: bot was blocked by the user");
		});
		connectChannel(retrying, refusing, { tenantId: "acme", instanceId: "ops" }, () => {});
		await retrying.submit(hello);
		while (!(await retrying.audit("acme").read()).some((e) => e.type === "reply.refused")) await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(refusing.sent).toHaveLength(1);
		expect(outboxEntries(dataDir)[0]?.deliveredAt).toBeUndefined();

		const down = testChannel(async () => {
			throw new Error("network down");
		});
		const other = new OwniRuntime({ dataDir: tempDataDir(), engine: piDurableEngine, retryDelaysMs: [60] });
		await other.registry.createTenant({ id: "acme", name: "acme" });
		await other.registry.createInstance("acme", { id: "ops", name: "ops", model: { provider: "faux", modelId: "owni-dev" }, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		connectChannel(other, down, { tenantId: "acme", instanceId: "ops" }, () => {});
		await other.submit(hello);
		await waitFor(() => down.sent.length === 1);
		await other.close();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(down.sent).toHaveLength(1);
		await retrying.close();
	});
});

describe("reply outbox: retry limits", () => {
	it("two failure reports at once schedule one retry, and a close leaves nothing to send", async () => {
		const dataDir = tempDataDir();
		const { runtime } = await runtimeWithInstance({ dataDir });
		await runtime.close();
		// The first retry soon, the next one far away: only the duplicate reports are under test.
		const retrying = new OwniRuntime({ dataDir, engine: piDurableEngine, retryDelaysMs: [40, 60_000] });
		const sent: Reply[] = [];
		retrying.onReply((r) => sent.push(r));
		const down = testChannel(async () => {
			throw new Error("network down");
		});
		connectChannel(retrying, down, { tenantId: "acme", instanceId: "ops" }, () => {});
		await retrying.submit(hello);
		await waitFor(() => sent.length === 1);
		const first = sent[0] as Reply;
		await Promise.all([1, 2, 3].map(() => retrying.deliveryFailed(first, { refused: false, reason: "again" })));
		await waitFor(() => sent.length >= 2);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await retrying.close();
		const after = sent.length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent.length).toBe(after);
		expect(sent.length).toBe(2);
	});

	it("gives up in the process after the last delay; the reply waits for the next resume", async () => {
		const dataDir = tempDataDir();
		const { runtime } = await runtimeWithInstance({ dataDir });
		await runtime.close();
		const retrying = new OwniRuntime({ dataDir, engine: piDurableEngine, retryDelaysMs: [10, 10], maxRetries: 3 });
		const down = testChannel(async () => {
			throw new Error("network down");
		});
		connectChannel(retrying, down, { tenantId: "acme", instanceId: "ops" }, () => {});
		await retrying.submit(hello);
		while (!(await retrying.audit("acme").read()).some((e) => e.type === "reply.retries_exhausted")) await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(down.sent).toHaveLength(4);
		expect(outboxEntries(dataDir)[0]?.deliveredAt).toBeUndefined();
		await retrying.close();
	});
});

describe("reply outbox: stale failures", () => {
	it("a failure of a send started before a reopen does not send the reply again", async () => {
		const dataDir = tempDataDir();
		const { runtime } = await runtimeWithInstance({ dataDir });
		await runtime.close();
		const retrying = new OwniRuntime({ dataDir, engine: piDurableEngine, retryDelaysMs: [20] });
		const sent: Reply[] = [];
		retrying.onReply((r) => sent.push(r));
		const pending: (() => void)[] = [];
		const slow = testChannel(
			() =>
				new Promise<void>((_, reject) => {
					pending.push(() => reject(new Error("timed out")));
				}),
		);
		connectChannel(retrying, slow, { tenantId: "acme", instanceId: "ops" }, () => {});
		await retrying.submit(hello);
		await waitFor(() => pending.length === 1);
		// The reopen hands the reply off again (attempt 2); then the first send fails.
		await retrying.reopen("acme", "ops");
		await waitFor(() => sent.length === 2);
		pending[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sent.map((r) => r.attempt)).toEqual([1, 2]);
		await retrying.close();
	});
});

describe("reply outbox: cleanup", () => {
	it("on resume, drops replies delivered more than 30 days ago and keeps the rest", async () => {
		const dataDir = tempDataDir();
		const { runtime } = await runtimeWithInstance({ dataDir });
		await runtime.close();
		const outbox = new Outbox(outboxOf(dataDir));
		const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
		const reply = { status: "answered" as const, text: "ok" };
		const base = { submissionId: "s", channel: "test", threadId: "t1", reply, attempts: 1 };
		await outbox.put({ ...base, key: "reply:old", createdAt: days(41), deliveredAt: days(40) });
		await outbox.put({ ...base, key: "reply:recent", createdAt: days(6), deliveredAt: days(5) });
		await outbox.put({ key: "reply:stuck", submissionId: "s2", channel: "test", threadId: "t1", attempts: 0, createdAt: days(40) });
		// Messages the instance sends itself (approval notices) keep their key: it stops a second notice.
		await outbox.put({ ...base, key: "msg:acme/ops/proposal:p1:9", createdAt: days(41), deliveredAt: days(40) });
		const next = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await next.resume("acme", "ops");
		expect((await outbox.list()).map((e) => e.key).sort()).toEqual(["msg:acme/ops/proposal:p1:9", "reply:recent", "reply:stuck"]);
		expect(await next.audit("acme").read()).toContainEqual(expect.objectContaining({ type: "outbox.pruned", instanceId: "ops", removed: 1 }));
		await next.close();
	});
});

/** Pi Durable whose replies never reach the core: the state a crash right after Pi settles leaves on disk. */
const deafEngine: DurableEngine = {
	async open(options) {
		const session = await piDurableEngine.open(options);
		return { ...bind(session), onReply: () => () => {} };
	},
};

function bind(session: EngineSession): EngineSession {
	return {
		submit: (...args) => session.submit(...args),
		resume: () => session.resume(),
		reattach: (...args) => session.reattach(...args),
		setThreadModel: (...args) => session.setThreadModel(...args),
		threadModel: (...args) => session.threadModel(...args),
		onReply: (listener) => session.onReply(listener),
		idle: () => session.idle(),
		close: () => session.close(),
	};
}

describe("activity: what a cell must finish before it sleeps", () => {
	it("counts submissions still waiting for their reply, and nothing once replies are out", async () => {
		const setup = await runtimeWithInstance({});
		await setup.runtime.close();
		const deaf = new OwniRuntime({ dataDir: setup.dataDir, engine: deafEngine });
		expect(await deaf.activity("acme")).toEqual({ working: 0, retrying: 0 });
		await deaf.submit(hello);
		await (await deaf.openInstance("acme", "ops")).idle();
		expect(await deaf.activity("acme")).toEqual({ working: 1, retrying: 0 });
		await deaf.close();
		const { runtime } = await runtimeWithInstance({ dataDir: tempDataDir() });
		connectChannel(runtime, testChannel(async () => {}), { tenantId: "acme", instanceId: "ops" });
		await runtime.submit(hello);
		await (await runtime.openInstance("acme", "ops")).idle();
		while ((await runtime.activity("acme")).working > 0) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await runtime.activity("acme")).toEqual({ working: 0, retrying: 0 });
		await runtime.close();
	});
});

describe("reply outbox: review regressions", () => {
	it("a reply Pi settled but the outbox never received is reattached by ID and sent once on resume", async () => {
		const setup = await runtimeWithInstance({});
		await setup.runtime.close();
		const deaf = new OwniRuntime({ dataDir: setup.dataDir, engine: deafEngine });
		await deaf.submit(hello);
		await (await deaf.openInstance("acme", "ops")).idle();
		await deaf.close();
		// Admitted and answered in Pi, but the outbox only knows the admission.
		expect(outboxEntries(setup.dataDir)).toEqual([expect.objectContaining({ channel: "test", threadId: "t1", attempts: 0 })]);
		expect(outboxEntries(setup.dataDir)[0]?.reply).toBeUndefined();

		const next = new OwniRuntime({ dataDir: setup.dataDir, engine: piDurableEngine });
		const channel = testChannel(async () => {});
		connectChannel(next, channel, { tenantId: "acme", instanceId: "ops" });
		expect(await next.resume("acme", "ops")).toEqual({ pending: 0, undelivered: 0, reattached: 1 });
		await waitFor(() => outboxEntries(setup.dataDir)[0]?.deliveredAt !== undefined);
		await next.resume("acme", "ops");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(channel.sent).toEqual([expect.objectContaining({ threadId: "t1", text: ANSWER })]);
		await next.close();
	});

	it("concurrent resumes hand each undelivered reply to the channel once", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		connectChannel(runtime, testChannel(async () => {
			throw new Error("channel down");
		}), { tenantId: "acme", instanceId: "ops" }, () => {});
		await runtime.submit(hello);
		await runtime.submit({ ...hello, threadId: "t2", messageId: "m2" });
		await waitFor(() => outboxEntries(dataDir).filter((e) => e.attempts === 1).length === 2);
		await runtime.close();

		const next = new OwniRuntime({ dataDir, engine: piDurableEngine });
		const channel = testChannel(async () => {});
		connectChannel(next, channel, { tenantId: "acme", instanceId: "ops" });
		await Promise.all([next.resume("acme", "ops"), next.resume("acme", "ops"), next.resume("acme", "ops")]);
		await waitFor(() => outboxEntries(dataDir).every((e) => e.deliveredAt !== undefined));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(channel.sent.map((m) => m.threadId).sort()).toEqual(["t1", "t2"]);
		expect(outboxEntries(dataDir).map((e) => e.attempts)).toEqual([2, 2]);
		await next.close();
	});

	it("a send that completes after close() does not reopen the instance; the reply stays for the next process", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const logs: string[] = [];
		const slow = testChannel(() => gate);
		connectChannel(runtime, slow, { tenantId: "acme", instanceId: "ops" }, (line) => logs.push(line));
		await runtime.submit(hello);
		await waitFor(() => slow.sent.length === 1);
		await runtime.close();
		release();
		await waitFor(() => logs.length === 1);
		expect(logs[0]).toContain("not confirmed in the outbox: Instance acme/ops is not open");

		// The lock is free (nothing reopened it), and the reply goes out again, flagged.
		const next = new OwniRuntime({ dataDir, engine: piDurableEngine });
		const channel = testChannel(async () => {});
		connectChannel(next, channel, { tenantId: "acme", instanceId: "ops" });
		expect(await next.resume("acme", "ops")).toMatchObject({ undelivered: 1 });
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		expect(channel.sent).toHaveLength(1);
		await next.close();
	});

	it("idempotency keys name the tenant and instance, so two tenants never share one", async () => {
		const { runtime } = await runtimeWithInstance({});
		await runtime.registry.createTenant({ id: "globex", name: "globex" });
		await runtime.registry.createInstance("globex", { id: "ops", name: "ops", model: { provider: "faux", modelId: "owni-dev" }, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		const channel = testChannel(async () => {});
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
		connectChannel(runtime, channel, { tenantId: "globex", instanceId: "ops" });
		await runtime.submit(hello);
		await runtime.submit({ ...hello, tenantId: "globex" });
		await waitFor(() => channel.sent.length === 2);
		const keys = channel.sent.map((m) => m.idempotencyKey).sort();
		expect(keys[0]).toMatch(/^reply:acme\/ops\//);
		expect(keys[1]).toMatch(/^reply:globex\/ops\//);
		await runtime.close();
	});
});

describe("reactions through the outbox (ADR 0132)", () => {
	const reaction = { channel: "test", threadId: "t1", messageId: "m1", emoji: "👍", key: "call-1" };
	/** A test channel that also reacts: `react` records what it was asked. */
	const reacting = () => {
		const reactions: OutboundReaction[] = [];
		return Object.assign(testChannel(async () => {}), {
			reactions,
			react: async (r: OutboundReaction) => void reactions.push(r),
		});
	};

	it("a reaction reaches adapter.react with the message and the emoji, and is marked delivered", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		const channel = reacting();
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
		await runtime.sendReaction("acme", "ops", reaction);
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		expect(channel.reactions).toEqual([expect.objectContaining({ channel: "test", threadId: "t1", messageId: "m1", emoji: "👍", idempotencyKey: "react:acme/ops/call-1" })]);
		expect(channel.sent).toEqual([]);
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ key: "react:acme/ops/call-1", reply: { status: "reaction", emoji: "👍", messageId: "m1" }, attempts: 1 })]);
		await runtime.close();
	});

	it("the same key delivers once; another key is another reaction", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		const channel = reacting();
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
		await runtime.sendReaction("acme", "ops", reaction);
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		await runtime.sendReaction("acme", "ops", reaction);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(channel.reactions).toHaveLength(1);
		await runtime.sendReaction("acme", "ops", { ...reaction, key: "call-2", emoji: "🔥" });
		await waitFor(() => channel.reactions.length === 2);
		expect(channel.reactions.map((r) => r.emoji)).toEqual(["👍", "🔥"]);
		await runtime.close();
	});

	it("a channel without react has nothing to deliver: the reaction is delivered, nothing thrown", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		const channel = testChannel(async () => {});
		const logs: string[] = [];
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" }, (line) => logs.push(line));
		await runtime.sendReaction("acme", "ops", reaction);
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		expect(channel.sent).toEqual([]);
		expect(logs).toEqual([]);
		await runtime.close();
	});

	it("an answer with only blanks is marked delivered and never sent", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({});
		const channel = reacting();
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
		await runtime.sendMessage("acme", "ops", { channel: "test", threadId: "t1", text: " \n ", key: "blank" });
		await waitFor(() => outboxEntries(dataDir)[0]?.deliveredAt !== undefined);
		expect(channel.sent).toEqual([]);
		await runtime.close();
	});
});

describe("reply outbox across a SIGKILL (real child processes, fake Telegram)", () => {
	const workers: Worker[] = [];
	afterEach(async () => {
		await Promise.all(workers.splice(0).map(kill9));
	});
	const worker = (mode: "start" | "resume", dataDir: string, callsFile: string, send: "ok" | "hang-before" | "hang-after") => {
		const w = spawnFixture("outbox-worker.ts", [mode, dataDir, callsFile, send]);
		workers.push(w);
		return w;
	};
	const sendMessages = (callsFile: string) =>
		existsSync(callsFile)
			? readFileSync(callsFile, "utf8")
					.trim()
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line) as { pid: number; method: string; body: Record<string, unknown> })
			: [];

	it("killed after the outbox write and before the send: the next process sends exactly one sendMessage", async () => {
		const dataDir = tempDataDir();
		const callsFile = join(dataDir, "telegram-calls.jsonl");

		const first = worker("start", dataDir, callsFile, "hang-before");
		await first.waitForLine("SENDING");
		// The reply is on disk before the request leaves.
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ channel: "telegram", threadId: "42", attempts: 1, reply: { status: "answered", text: ANSWER, model: { provider: "faux", modelId: "owni-dev" } } })]);
		await kill9(first);
		expect(sendMessages(callsFile)).toEqual([]);

		const second = worker("resume", dataDir, callsFile, "ok");
		expect(await second.waitForLine("RESUMED")).toBe('RESUMED {"pending":0,"undelivered":1,"reattached":0}');
		await second.waitForLine("DELIVERED");
		expect(await second.exited).toBe(0);

		// A third start finds nothing to send.
		const third = worker("resume", dataDir, callsFile, "ok");
		expect(await third.waitForLine("RESUMED")).toBe('RESUMED {"pending":0,"undelivered":0,"reattached":0}');
		expect(await third.exited).toBe(0);

		// The outbox cannot tell this crash from one after Telegram received the message, so
		// the resend carries the warning anyway: a false alarm, never a silent duplicate.
		expect(sendMessages(callsFile)).toEqual([{ pid: second.child.pid, method: "sendMessage", body: { chat_id: "42", text: `${DUPLICATE_NOTICE}\n\n${ANSWER}` } }]);
		expect(outboxEntries(dataDir)).toEqual([expect.objectContaining({ attempts: 2, deliveredAt: expect.any(String) })]);
	});

	it("killed after Telegram received it and before the outbox was marked: at-least-once, the user gets it twice", async () => {
		const dataDir = tempDataDir();
		const callsFile = join(dataDir, "telegram-calls.jsonl");

		const first = worker("start", dataDir, callsFile, "hang-after");
		await first.waitForLine("SENT");
		await kill9(first);
		expect(outboxEntries(dataDir)[0]?.deliveredAt).toBeUndefined();

		const second = worker("resume", dataDir, callsFile, "ok");
		expect(await second.waitForLine("RESUMED")).toBe('RESUMED {"pending":0,"undelivered":1,"reattached":0}');
		await second.waitForLine("DELIVERED");
		expect(await second.exited).toBe(0);

		// Telegram has no idempotency key for sendMessage: the resend cannot be deduplicated there.
		const calls = sendMessages(callsFile);
		expect(calls.map((c) => [c.pid, c.body])).toEqual([
			[first.child.pid, { chat_id: "42", text: ANSWER }],
			[second.child.pid, { chat_id: "42", text: `${DUPLICATE_NOTICE}\n\n${ANSWER}` }],
		]);
		// The possible duplicate is visible in the tenant's audit.
		const audit = readFileSync(join(dataDir, "tenants", "acme", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(audit).toContainEqual(expect.objectContaining({ type: "reply.delivered", attempts: 2, possibleDuplicate: true }));
	});
});
