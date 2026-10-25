import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, type DurableEngine, type Reply, UserNotAllowed } from "../src/core/index.ts";
import { connectChannel } from "../src/gateway.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

/** The real Pi Durable engine, counting what reaches EngineSession.submit. */
function countingEngine(submits: string[]): DurableEngine {
	return {
		async open(options) {
			const session = await piDurableEngine.open(options);
			return {
				submit: (threadKey, text, requestId) => {
					submits.push(threadKey);
					return session.submit(threadKey, text, requestId);
				},
				resume: () => session.resume(),
				reattach: (submissionId, threadKey) => session.reattach(submissionId, threadKey),
				setThreadModel: (threadKey, model) => session.setThreadModel(threadKey, model),
				threadModel: (threadKey) => session.threadModel(threadKey),
				onReply: (listener) => session.onReply(listener),
				idle: () => session.idle(),
				close: () => session.close(),
			};
		},
	};
}

async function setup(allowedUsers?: Record<string, string[]>) {
	const dataDir = tempDataDir();
	const submits: string[] = [];
	const runtime = new OwniRuntime({ dataDir, engine: countingEngine(submits) });
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	await runtime.registry.createInstance("acme", {
		id: "ops",
		name: "Ops",
		model: FAUX_MODEL,
		egress: { modelProviders: ["faux"], channels: ["test", "telegram"] },
		...(allowedUsers === undefined ? {} : { allowedUsers }),
	});
	const replies: Reply[] = [];
	runtime.onReply((reply) => replies.push(reply));
	return { dataDir, runtime, submits, replies };
}

const message = (userId: string, threadId = "t1") => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId, userId, text: "ciao" });

describe("user allowlist", () => {
	it("by default nobody is allowed: the message never reaches the engine, gets no reply, and is audited", async () => {
		const { runtime, submits, replies } = await setup();
		expect((await runtime.registry.getInstance("acme", "ops")).allowedUsers).toEqual({});

		const error = await runtime.submit(message("mallory", "chat-9")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UserNotAllowed);
		expect(error).toMatchObject({ channel: "test", userId: "mallory", threadId: "chat-9", reason: "no_users_allowed_on_channel" });

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(submits).toEqual([]);
		expect(replies).toEqual([]);
		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(
			expect.objectContaining({ type: "user.denied", tenantId: "acme", instanceId: "ops", channel: "test", userId: "mallory", threadId: "chat-9", reason: "no_users_allowed_on_channel" }),
		);
		expect(audit.some((e) => e.type === "message.received")).toBe(false);
		expect(JSON.stringify(audit)).not.toContain("ciao");
		await runtime.close();
	});

	it("lets through only the users listed for that channel", async () => {
		const { runtime, submits, replies } = await setup({ test: ["alice"], telegram: ["bob"] });

		// bob is allowed on telegram, not on test: the allowlist is per channel.
		await expect(runtime.submit(message("bob", "t-bob"))).rejects.toMatchObject({ name: "UserNotAllowed", reason: "user_not_in_allowlist" });
		await runtime.submit(message("alice", "t-alice"));
		await waitFor(() => replies.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(submits).toEqual(["test:t-alice"]);
		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({ threadId: "t-alice", status: "answered" });
		const denied = (await runtime.audit("acme").read()).filter((e) => e.type === "user.denied");
		expect(denied).toEqual([expect.objectContaining({ channel: "test", userId: "bob", threadId: "t-bob", reason: "user_not_in_allowlist" })]);
		await runtime.close();
	});

	it("is enforced by the core for messages arriving through the Telegram gateway: no sendMessage to strangers", async () => {
		const { runtime, submits } = await setup({ telegram: ["7"] });
		const sent: Record<string, unknown>[] = [];
		const updates = [
			[
				{ update_id: 1, message: { message_id: 1, chat: { id: 666 }, from: { id: 666 }, text: "fammi parlare col modello" } },
				{ update_id: 2, message: { message_id: 2, chat: { id: 42 }, from: { id: 7 }, text: "ciao" } },
			],
		];
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (method === "getUpdates") return Response.json({ ok: true, result: updates.shift() ?? [] });
			sent.push(body);
			return Response.json({ ok: true, result: { message_id: 1 } });
		});
		const logs: string[] = [];
		const adapter = new TelegramAdapter({ token: "123:TEST", tenantId: "acme", instanceId: "ops", fetch: fetchMock as unknown as typeof fetch });
		connectChannel(runtime, adapter, { tenantId: "acme", instanceId: "ops" }, (line) => logs.push(line));

		await adapter.pollOnce();
		await waitFor(() => sent.length === 1);
		await (await runtime.openInstance("acme", "ops")).idle();
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(submits).toEqual(["telegram:42"]);
		expect(sent).toEqual([{ chat_id: "42", text: "Owni (modello locale di sviluppo): hai scritto «ciao»" }]);
		expect(logs.some((line) => line.includes('User "666" is not allowed'))).toBe(true);
		expect(await runtime.audit("acme").read()).toContainEqual(
			expect.objectContaining({ type: "user.denied", channel: "telegram", userId: "666", threadId: "666", reason: "user_not_in_allowlist" }),
		);
		await runtime.close();
	});

	it("is configured per instance and channel through the registry, effective on the next open", async () => {
		const { dataDir, runtime } = await setup();
		await expect(runtime.submit(message("alice"))).rejects.toThrow(UserNotAllowed);
		await runtime.close();

		const updated = await runtime.registry.setAllowedUsers("acme", "ops", "test", ["alice", "alice"]);
		expect(updated.allowedUsers).toEqual({ test: ["alice"] });
		const reopened = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await expect(reopened.submit(message("alice"))).resolves.toMatchObject({ submissionId: expect.any(String) });
		expect(await reopened.audit("acme").read()).toContainEqual(expect.objectContaining({ type: "instance.allowlist.updated", channel: "test", users: 1 }));
		await reopened.close();
	});
});
