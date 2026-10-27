import { describe, expect, it, vi } from "vitest";
import { DUPLICATE_NOTICE, splitText, TELEGRAM_MAX_TEXT, TelegramAdapter } from "../src/channels/telegram.ts";
import { ChannelRefused } from "../src/channels/types.ts";
import type { InboundAction, InboundMessage } from "../src/channels/types.ts";
import { connectChannel } from "../src/gateway.ts";
import { ConfigError, loadOwniConfig, loadTelegramConfig } from "../src/main/config.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const TOKEN = "123456:TEST-TOKEN";

type Call = { method: string; body: Record<string, unknown> };

/** A fake Telegram Bot API: queued getUpdates batches, recorded calls. Never touches the network. */
function fakeTelegram(batches: unknown[][]) {
	const calls: Call[] = [];
	const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		expect(href.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
		const method = href.slice(href.lastIndexOf("/") + 1);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		calls.push({ method, body });
		if (method === "getUpdates") {
			const batch = batches.shift();
			// Like real long polling: with nothing to deliver, the request waits before answering.
			if (batch === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
			init?.signal?.throwIfAborted();
			return Response.json({ ok: true, result: batch ?? [] });
		}
		if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: calls.length } });
		if (method === "answerCallbackQuery" || method === "setWebhook" || method === "setMessageReaction") return Response.json({ ok: true, result: true });
		return Response.json({ ok: false, error_code: 404, description: "Not Found" });
	});
	return { calls, fetch: fetchMock as unknown as typeof fetch };
}

function textUpdate(updateId: number, chatId: number, messageId: number, text: string, chatType = "private") {
	return { update_id: updateId, message: { message_id: messageId, chat: { id: chatId, type: chatType }, from: { id: 7 }, text } };
}

describe("Telegram adapter (mocked fetch)", () => {
	it("normalizes updates into InboundMessage and advances the offset", async () => {
		const api = fakeTelegram([[textUpdate(10, 42, 1, "ciao"), { update_id: 11 }, textUpdate(12, -5, 2, "a tutti", "group")], []]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (message) => {
			inbound.push(message);
		});

		expect(await adapter.pollOnce()).toBe(3);
		await adapter.pollOnce();

		expect(inbound).toEqual([
			{ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", userId: "7", text: "ciao", privateThread: true, messageId: "42:1" },
			// A group chat is not private: nobody's memoria applies there.
			{ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "-5", userId: "7", text: "a tutti", privateThread: false, messageId: "-5:2" },
		]);
		expect(api.calls[0]).toMatchObject({ method: "getUpdates", body: { allowed_updates: ["message"] } });
		expect(api.calls[0]?.body.offset).toBeUndefined();
		expect(api.calls[1]?.body.offset).toBe(13);
	});

	it("sends replies with sendMessage, split at Telegram's length limit", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		await adapter.send({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", text: "x".repeat(TELEGRAM_MAX_TEXT + 1), idempotencyKey: "reply:1" });
		expect(api.calls.map((c) => [c.method, c.body.chat_id, String(c.body.text).length])).toEqual([
			["sendMessage", "42", TELEGRAM_MAX_TEXT],
			["sendMessage", "42", 1],
		]);
		expect(splitText("")).toEqual(["(risposta vuota)"]);
	});

	it("reacts with setMessageReaction: the message number after the last colon, the emoji without its variation selector (ADR 0132)", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const reaction = { tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "-5", idempotencyKey: "react:1", messageId: "-5:17", emoji: "❤️" };
		await adapter.react(reaction);
		await adapter.react({ ...reaction, messageId: "42:9", threadId: "42", emoji: "👍" });
		expect(api.calls).toEqual([
			{ method: "setMessageReaction", body: { chat_id: "-5", message_id: 17, reaction: [{ type: "emoji", emoji: "\u2764" }] } },
			{ method: "setMessageReaction", body: { chat_id: "42", message_id: 9, reaction: [{ type: "emoji", emoji: "👍" }] } },
		]);
	});

	it("refuses a reaction to something that is no Telegram message, and calls nothing", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const reaction = { tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", idempotencyKey: "react:1", emoji: "👍" };
		for (const messageId of ["m_abc", "42:abc", "42:1.5", "42:"]) {
			expect(await adapter.react({ ...reaction, messageId }).catch((e: unknown) => e), messageId).toBeInstanceOf(ChannelRefused);
		}
		expect(api.calls).toEqual([]);
	});

	it("puts the duplicate warning on top of a possibly repeated reply, within the length limit", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const base = { tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", idempotencyKey: "reply:1" };
		await adapter.send({ ...base, text: "ciao", possibleDuplicate: true });
		await adapter.send({ ...base, text: "ciao", possibleDuplicate: false });
		await adapter.send({ ...base, text: "x".repeat(TELEGRAM_MAX_TEXT), possibleDuplicate: true });
		const texts = api.calls.map((c) => String(c.body.text));
		expect(texts[0]).toBe(`${DUPLICATE_NOTICE}\n\nciao`);
		expect(texts[1]).toBe("ciao");
		// Only the first piece carries the warning, and no piece goes over the limit.
		expect(texts.slice(2).map((t) => t.length)).toEqual([TELEGRAM_MAX_TEXT, DUPLICATE_NOTICE.length + 2]);
		expect(texts[2]?.startsWith(DUPLICATE_NOTICE)).toBe(true);
		expect(texts[3]?.includes(DUPLICATE_NOTICE)).toBe(false);
	});

	it("puts the buttons, as one row of an inline keyboard, on the last piece only", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const buttons = [
			{ label: "Approva", data: "owni:abcd:1:approve" },
			{ label: "Scarta", data: "owni:abcd:1:discard" },
		];
		await adapter.send({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", text: "x".repeat(TELEGRAM_MAX_TEXT + 1), idempotencyKey: "k", buttons });
		expect(api.calls[0]?.body.reply_markup).toBeUndefined();
		expect(api.calls[1]?.body.reply_markup).toEqual({
			inline_keyboard: [[{ text: "Approva", callback_data: "owni:abcd:1:approve" }, { text: "Scarta", callback_data: "owni:abcd:1:discard" }]],
		});
		// Telegram rejects callback_data over 64 bytes: fail before sending anything.
		const before = api.calls.length;
		await expect(adapter.send({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", text: "t", idempotencyKey: "k", buttons: [{ label: "x", data: "é".repeat(33) }] })).rejects.toThrow("64 bytes");
		expect(api.calls.length).toBe(before);
	});

	it("turns button taps into actions, answers each tap, and asks for taps only when someone handles them", async () => {
		const tap = { update_id: 20, callback_query: { id: "cq1", from: { id: 7 }, message: { message_id: 9, chat: { id: 42 } }, data: "owni:abcd:1:approve" } };
		const plain = fakeTelegram([[tap], []]);
		const textOnly = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: plain.fetch });
		textOnly.onInbound(async () => {});
		await textOnly.pollOnce();
		expect(plain.calls[0]?.body.allowed_updates).toEqual(["message"]);

		const api = fakeTelegram([[tap]]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		const actions: InboundAction[] = [];
		adapter.onAction(async (action) => {
			actions.push(action);
		});
		expect(await adapter.pollOnce()).toBe(1);
		expect(api.calls[0]?.body.allowed_updates).toEqual(["message", "callback_query"]);
		expect(actions).toEqual([{ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "42", userId: "7", data: "owni:abcd:1:approve", actionId: "cq1" }]);
		// Answered before the handler runs, so the spinner stops even if the handler is slow.
		expect(api.calls.map((c) => c.method)).toEqual(["getUpdates", "answerCallbackQuery"]);
		expect(api.calls[1]?.body).toEqual({ callback_query_id: "cq1" });
	});

	it("a failed answer to a tap (e.g. a redelivered, expired query) does not drop the action", async () => {
		const tap = { update_id: 21, callback_query: { id: "old", from: { id: 7 }, message: { message_id: 9, chat: { id: 42 } }, data: "owni:abcd:1:edit" } };
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			if (method === "getUpdates") return Response.json({ ok: true, result: [tap] });
			return Response.json({ ok: false, error_code: 400, description: "Bad Request: query is too old" });
		});
		const logs: string[] = [];
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: fetchMock as unknown as typeof fetch, log: (l) => logs.push(l) });
		const actions: InboundAction[] = [];
		adapter.onAction(async (action) => {
			actions.push(action);
		});
		await adapter.pollOnce();
		expect(actions).toHaveLength(1);
		expect(logs[0]).toContain("query is too old");
	});

	it("an update whose handler fails is delivered again, up to three times", async () => {
		const tap = { update_id: 30, callback_query: { id: "cq", from: { id: 7 }, message: { message_id: 9, chat: { id: 42 } }, data: "owni:ab:1:approve" } };
		const api = fakeTelegram([[tap], [tap], [tap], []]);
		const logs: string[] = [];
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch, log: (l) => logs.push(l) });
		let calls = 0;
		adapter.onAction(async () => {
			calls++;
			throw new Error("disk full");
		});
		await expect(adapter.pollOnce()).rejects.toThrow("disk full");
		await expect(adapter.pollOnce()).rejects.toThrow("disk full");
		await adapter.pollOnce();
		await adapter.pollOnce();
		const offsets = api.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset);
		expect(offsets).toEqual([undefined, 30, 30, 31]);
		expect(calls).toBe(3);
		expect(logs.some((l) => l.includes("update 30 dropped after 3 failed attempts"))).toBe(true);
	});

	it("reports API errors without leaking the bot token", async () => {
		const fetchMock = vi.fn(async () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 }));
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: fetchMock as unknown as typeof fetch });
		const error = await adapter.pollOnce().catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Telegram getUpdates failed: 401 Unauthorized");
		expect((error as Error).message).not.toContain(TOKEN);
	});

	it("start/stop runs the long-polling loop until stopped", async () => {
		const api = fakeTelegram([[textUpdate(1, 42, 1, "uno")]]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch, retryDelayMs: 1 });
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (message) => {
			inbound.push(message);
		});
		await adapter.start();
		await waitFor(() => inbound.length === 1 && api.calls.length >= 2);
		await adapter.stop();
		const callsAfterStop = api.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(api.calls.length).toBe(callsAfterStop);
	});

	it("puts its commands in the bot's menu on start, and starts even when Telegram refuses them", async () => {
		// The fake answers setMyCommands with a 404: the menu is lost, the bot still runs.
		const api = fakeTelegram([[textUpdate(1, 42, 1, "uno")]]);
		const logs: string[] = [];
		const commands = [{ command: "modello", description: "Scegli il modello di questa chat" }];
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch, retryDelayMs: 1, commands, log: (line) => logs.push(line) });
		const inbound: InboundMessage[] = [];
		adapter.onInbound(async (message) => {
			inbound.push(message);
		});
		await adapter.start();
		await waitFor(() => inbound.length === 1);
		await adapter.stop();
		expect(api.calls[0]).toEqual({ method: "setMyCommands", body: { commands } });
		expect(logs.some((line) => line.includes("setMyCommands failed"))).toBe(true);
	});

	it("end to end: a Telegram message reaches the core and the reply goes back to the same chat, once", async () => {
		const { runtime } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["telegram"] } });
		// The same message delivered twice (as Telegram does after a crash before the offset is confirmed).
		const api = fakeTelegram([[textUpdate(1, 42, 5, "ciao owni")], [textUpdate(1, 42, 5, "ciao owni")]]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch });
		connectChannel(runtime, adapter, { tenantId: "acme", instanceId: "ops" });

		await adapter.pollOnce();
		await waitFor(() => api.calls.some((c) => c.method === "sendMessage"));
		await adapter.pollOnce();
		await (await runtime.openInstance("acme", "ops")).idle();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const sent = api.calls.filter((c) => c.method === "sendMessage");
		expect(sent).toEqual([{ method: "sendMessage", body: { chat_id: "42", text: "Owni (modello locale di sviluppo): hai scritto «ciao owni»" } }]);
		await runtime.close();
	});
});

describe("gateway with several tenants", () => {
	it("sends each reply only through the bot of the tenant and instance that answered", async () => {
		const { runtime, dataDir } = await runtimeWithInstance({ tenant: "acme", egress: { modelProviders: ["faux"], channels: ["telegram"] } });
		await runtime.registry.createTenant({ id: "globex", name: "globex" });
		await runtime.registry.createInstance("globex", { id: "ops", name: "ops", model: { provider: "faux", modelId: "owni-dev" }, egress: { modelProviders: ["faux"], channels: ["telegram"] }, allowedUsers: { telegram: ["7"] } });
		expect(dataDir).toBeTruthy();

		// The same user (private chat 42) talks to both bots.
		const acmeApi = fakeTelegram([[textUpdate(1, 42, 1, "per acme")]]);
		const globexApi = fakeTelegram([]);
		const acmeBot = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: acmeApi.fetch });
		const globexBot = new TelegramAdapter({ token: TOKEN, tenantId: "globex", instanceId: "ops", fetch: globexApi.fetch });
		connectChannel(runtime, acmeBot, { tenantId: "acme", instanceId: "ops" });
		connectChannel(runtime, globexBot, { tenantId: "globex", instanceId: "ops" });

		await acmeBot.pollOnce();
		await waitFor(() => acmeApi.calls.some((c) => c.method === "sendMessage"));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(acmeApi.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
		expect(globexApi.calls).toEqual([]);
		await runtime.close();
	});
});

describe("dev:telegram configuration", () => {
	it("names every missing variable exactly", () => {
		expect(() => loadTelegramConfig({})).toThrow(new ConfigError("Missing environment variables: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY. Set them in .env (see .env.example)."));
		expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t" })).toThrow("Missing environment variable: ANTHROPIC_API_KEY.");
		expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", OWNI_MODEL_PROVIDER: "openai" })).toThrow("Missing environment variable: OPENAI_API_KEY.");
		expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: " ", ANTHROPIC_API_KEY: "k" })).toThrow("Missing environment variable: TELEGRAM_BOT_TOKEN.");
	});

	it("defaults to Anthropic Claude Sonnet 5.5 and needs no key for the local model", () => {
		expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toMatchObject({
			modelProvider: "anthropic",
			modelId: "claude-sonnet-5-5",
			modelApiKey: "k",
			dataDir: "data",
			tenantId: "default",
			instanceId: "telegram",
		});
		expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", OWNI_MODEL_PROVIDER: "faux" })).toMatchObject({ modelProvider: "faux", modelId: "owni-dev", modelApiKey: undefined });
	});

	it("reads the Telegram allowlist as numeric user IDs", () => {
		const base = { TELEGRAM_BOT_TOKEN: "t", OWNI_MODEL_PROVIDER: "faux" };
		expect(loadTelegramConfig(base).telegramAllowedUsers).toBeUndefined();
		expect(loadTelegramConfig({ ...base, OWNI_TELEGRAM_ALLOWED_USERS: " 12, 34 ,," }).telegramAllowedUsers).toEqual(["12", "34"]);
		expect(() => loadTelegramConfig({ ...base, OWNI_TELEGRAM_ALLOWED_USERS: "12,@mario" })).toThrow("invalid: @mario");
	});
});

describe("Telegram errors", () => {
	const answering = (status: number, payload: unknown) => (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
	const message = { tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "7", idempotencyKey: "k", text: "ciao" };

	it("a blocked bot is a refusal; rate limits and server errors are failures worth retrying", async () => {
		const blocked = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: answering(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }) });
		const no = await blocked.send(message).catch((e: unknown) => e);
		expect(no).toBeInstanceOf(ChannelRefused);
		expect((no as ChannelRefused).retryable).toBe(false);
		for (const [status, payload] of [
			[429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" }],
			[502, { ok: false, error_code: 502, description: "Bad Gateway" }],
		] as const) {
			const busy = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: answering(status, payload) });
			const notNow = await busy.send(message).catch((e: unknown) => e);
			// Not arrived (so no duplicate notice later), but worth another try.
			expect(notNow).toBeInstanceOf(ChannelRefused);
			expect((notNow as ChannelRefused).retryable).toBe(true);
		}
	});
});

describe("Telegram adapter, webhook mode", () => {
	it("start registers the webhook with its secret and never polls", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch, webhook: { url: "https://owni.example/hooks/telegram/ops", secretToken: "s3cret_token-1" } });
		adapter.onInbound(async () => {});
		await adapter.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await adapter.stop();
		expect(api.calls.map((c) => c.method)).toEqual(["setWebhook"]);
		expect(api.calls[0]?.body).toEqual({ url: "https://owni.example/hooks/telegram/ops", secret_token: "s3cret_token-1", allowed_updates: ["message"] });
	});

	it("an update pushed by Telegram takes the same path as a polled one; a failing one is refused until the third try", async () => {
		const api = fakeTelegram([]);
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api.fetch, webhook: { url: "https://owni.example/hooks/telegram/ops", secretToken: "s3cret" } });
		const inbound: InboundMessage[] = [];
		let fail = 0;
		adapter.onInbound(async (message) => {
			if (message.text === "rotto" && fail++ < 10) throw new Error("core down");
			inbound.push(message);
		});
		await adapter.handleUpdate(textUpdate(20, 42, 5, "ciao"));
		expect(inbound).toEqual([expect.objectContaining({ channel: "telegram", threadId: "42", userId: "7", text: "ciao", messageId: "42:5" })]);
		const broken = textUpdate(21, 42, 6, "rotto");
		// Telegram redelivers on an error answer; after three failures the update is let go.
		await expect(adapter.handleUpdate(broken)).rejects.toThrow("core down");
		await expect(adapter.handleUpdate(broken)).rejects.toThrow("core down");
		await expect(adapter.handleUpdate(broken)).resolves.toBeUndefined();
	});
});

describe("webhook configuration", () => {
	const base = { OWNI_MODEL_PROVIDER: "faux", TELEGRAM_BOT_TOKEN: "1:T" };
	it("needs a public URL and a secret Telegram accepts", () => {
		expect(() => loadOwniConfig({ ...base, OWNI_TELEGRAM_WEBHOOK_SECRET: "abc" })).toThrow(/OWNI_PUBLIC_URL/);
		expect(() => loadOwniConfig({ ...base, OWNI_PUBLIC_URL: "https://a.example", OWNI_TELEGRAM_WEBHOOK_SECRET: "has space" })).toThrow(ConfigError);
		expect(loadOwniConfig({ ...base, OWNI_PUBLIC_URL: "https://a.example", OWNI_TELEGRAM_WEBHOOK_SECRET: "ok_Secret-1" }).telegram?.webhookSecret).toBe("ok_Secret-1");
		expect(loadOwniConfig(base).telegram?.webhookSecret).toBeUndefined();
	});
});

