import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { WhatsAppAdapter, type WhatsAppWebhook, type WindowState, windowStore } from "../src/channels/whatsapp.ts";
import { splitText } from "../src/channels/text.ts";
import { ChannelRefused, type InboundAction, type InboundMessage } from "../src/channels/types.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const PHONE_ID = "1098765432101";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "EAAGtesttoken0123456789abcdef";

/** Meta's Graph API as Owni uses it: every call recorded; a number told apart by its id. */
async function fakeGraph(options: { refuse?: { code: number; message: string } } = {}) {
	const calls: { method: string; path: string; auth: string; body: any }[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const path = req.url ?? "";
			const json = (req.headers["content-type"] ?? "").includes("json");
			calls.push({ method: req.method ?? "", path, auth: String(req.headers.authorization ?? ""), body: json ? JSON.parse(raw) : raw });
			const reply = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { message: "Invalid OAuth access token", code: 190 } });
			if (options.refuse !== undefined && path.endsWith("/messages")) return reply(400, { error: options.refuse });
			if (path.startsWith(`/${PHONE_ID}?fields=`)) return reply(200, { display_phone_number: "+39 06 1234 5678", verified_name: "Studio Rossi" });
			if (path === `/${PHONE_ID}/messages`) return reply(200, { messages: [{ id: `wamid.out${calls.length}` }] });
			if (path === `/${PHONE_ID}/media`) return reply(200, { id: "media-up-1" });
			if (path === "/media-in-1") return reply(200, { url: `${base}/files/media-in-1`, file_size: 5 });
			if (path === "/media-big") return reply(200, { url: `${base}/files/media-big`, file_size: 25 * 1024 * 1024 });
			if (path === "/media-elsewhere") return reply(200, { url: "http://169.254.169.254/latest/", file_size: 5 });
			if (path === "/media-photo") return reply(200, { url: `${base}/files/media-photo`, file_size: 12 });
			if (path === "/files/media-photo") {
				res.writeHead(200, { "content-type": "image/jpeg" });
				return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
			}
			if (path === "/files/media-in-1") {
				res.writeHead(200, { "content-type": "application/pdf" });
				return res.end("%PDF-");
			}
			reply(404, { error: { message: "Unknown path", code: 100 } });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	closers.push(() => new Promise((r) => server.close(() => r())));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { calls, base, sent: () => calls.filter((c) => c.path === `/${PHONE_ID}/messages`).map((c) => c.body) };
}

/** A webhook delivery as Meta sends it, for our number. */
function delivery(messages: unknown[], phoneNumberId = PHONE_ID): WhatsAppWebhook {
	const payload: unknown = { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, messages } }] }] };
	return payload as WhatsAppWebhook;
}
const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

describe("WhatsApp adapter", () => {
	const adapterFor = (apiBase: string) => new WhatsAppAdapter({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "verify-me-123", tenantId: "default", instanceId: "owni", apiBase });

	it("answers Meta's check only with our token, and takes only deliveries Meta signed", () => {
		const wa = adapterFor("http://unused");
		expect(wa.verify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "1158201444" }))).toBe("1158201444");
		expect(wa.verify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }))).toBeUndefined();
		const raw = JSON.stringify(delivery([]));
		expect(wa.signed(Buffer.from(raw), sign(raw))).toBe(true);
		expect(wa.signed(Buffer.from(raw), sign(raw, "ffffffffffffffffffffffffffffffff"))).toBe(false);
		expect(wa.signed(Buffer.from(`${raw} `), sign(raw))).toBe(false);
		expect(wa.signed(Buffer.from(raw), undefined)).toBe(false);
	});

	it("passes on text, documents (downloaded) and button taps; skips other numbers and what it cannot read", async () => {
		const graph = await fakeGraph();
		const wa = adapterFor(graph.base);
		const inbound: InboundMessage[] = [];
		const taps: InboundAction[] = [];
		wa.onInbound(async (m) => void inbound.push(m));
		wa.onAction(async (a) => void taps.push(a));
		await wa.handleWebhook(
			delivery([
				{ from: "393331234567", id: "wamid.1", type: "text", text: { body: "Ciao Owni" } },
				{ from: "393331234567", id: "wamid.2", type: "document", document: { id: "media-in-1", filename: "preventivo.pdf", caption: "Guarda qui" } },
				{ from: "393331234567", id: "wamid.3", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "tool:0123456789ab:approved", title: "Approva" } } },
				{ from: "393331234567", id: "wamid.4", type: "sticker", sticker: { id: "x", animated: true } },
				{ from: "393331234567", id: "wamid.6", type: "image", image: { id: "media-photo", mime_type: "image/jpeg", caption: "Lo scontrino" } },
				{ from: "393331234567", id: "wamid.7", type: "sticker", sticker: { id: "media-photo", mime_type: "image/webp" } },
			]),
		);
		await wa.handleWebhook(delivery([{ from: "393331234567", id: "wamid.5", type: "text", text: { body: "altro numero" } }], "999"));
		expect(inbound.map((m) => [m.text, m.threadId, m.privateThread, m.messageId])).toEqual([
			["Ciao Owni", "393331234567", true, "wamid.1"],
			["Guarda qui", "393331234567", true, "wamid.2"],
			["Lo scontrino", "393331234567", true, "wamid.6"],
			["", "393331234567", true, "wamid.7"],
		]);
		expect(inbound[2]?.attachments?.map((a) => [a.name, a.data.length])).toEqual([["foto.jpg", 12]]);
		// A still sticker is a picture too; an animated one is skipped.
		expect(inbound[3]?.attachments?.map((a) => a.name)).toEqual(["sticker.jpg"]);
		expect(inbound[1]?.attachments?.[0]?.name).toBe("preventivo.pdf");
		expect(Buffer.from(inbound[1]?.attachments?.[0]?.data ?? []).toString()).toBe("%PDF-");
		expect(taps).toEqual([expect.objectContaining({ channel: "whatsapp", userId: "393331234567", data: "tool:0123456789ab:approved", actionId: "wamid.3" })]);
		// The media download carries the token; nothing else leaves.
		expect(graph.calls.find((c) => c.path === "/files/media-in-1")?.auth).toBe(`Bearer ${TOKEN}`);
	});

	it("sends long text in pieces, buttons under the last 1024 characters, files as documents", async () => {
		const graph = await fakeGraph();
		const wa = adapterFor(graph.base);
		const base = { tenantId: "default", instanceId: "owni", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k" };
		await wa.send({ ...base, text: "x".repeat(5000) });
		expect(graph.sent().map((b) => [b.type, b.text.body.length, b.to])).toEqual([
			["text", 4096, "393331234567"],
			["text", 904, "393331234567"],
		]);
		await wa.send({ ...base, text: `${"a".repeat(1500)}${"b".repeat(1024)}`, buttons: [{ label: "Approva", data: "tool:0123456789ab:approved" }] });
		const [plain, card] = graph.sent().slice(2);
		expect(plain.text.body).toBe("a".repeat(1500));
		expect(card.interactive.body.text).toBe("b".repeat(1024));
		expect(card.interactive.action.buttons).toEqual([{ type: "reply", reply: { id: "tool:0123456789ab:approved", title: "Approva" } }]);
		await wa.sendFile({ ...base, name: "report.pdf", data: new Uint8Array([1, 2, 3]), caption: "Ecco" });
		expect(graph.sent().at(-1)).toMatchObject({ type: "document", document: { id: "media-up-1", filename: "report.pdf", caption: "Ecco" } });
		expect(graph.calls.some((c) => c.path === `/${PHONE_ID}/media` && c.method === "POST")).toBe(true);
	});

	it("reacts to a message with the reaction message type, the emoji as it is (ADR 0132)", async () => {
		const graph = await fakeGraph();
		const wa = adapterFor(graph.base);
		await wa.react({ tenantId: "default", instanceId: "owni", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "react:1", messageId: "wamid.in1", emoji: "❤️" });
		expect(graph.calls.filter((c) => c.path === `/${PHONE_ID}/messages`)).toEqual([
			expect.objectContaining({ method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", to: "393331234567", type: "reaction", reaction: { message_id: "wamid.in1", emoji: "❤️" } } }),
		]);
	});

	it("a file it cannot have still lets the message through, saying so; a message that keeps failing is let go after three tries", async () => {
		const graph = await fakeGraph();
		const logs: string[] = [];
		const wa = new WhatsAppAdapter({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "v", tenantId: "default", instanceId: "owni", apiBase: graph.base, log: (m) => void logs.push(m) });
		const inbound: InboundMessage[] = [];
		wa.onInbound(async (m) => void inbound.push(m));
		await wa.handleWebhook(
			delivery([
				{ from: "393331234567", id: "wamid.big", type: "document", document: { id: "media-big", filename: "enorme.pdf", caption: "Il bando" } },
				{ from: "393331234567", id: "wamid.far", type: "document", document: { id: "media-elsewhere", filename: "x.pdf" } },
				{ from: "393331234567", id: "wamid.next", type: "text", text: { body: "dopo" } },
			]),
		);
		expect(inbound.map((m) => [m.messageId, m.attachments?.length ?? 0])).toEqual([
			["wamid.big", 0],
			["wamid.far", 0],
			["wamid.next", 0],
		]);
		expect(inbound[0]?.text).toMatch(/^Il bando\n\n\[Un file allegato non è stato scaricato/);
		// The token never went to the address the answer named.
		expect(graph.calls.some((c) => c.path.includes("latest"))).toBe(false);
		// Signed but not what Meta sends: nothing happens, nothing throws.
		await wa.handleWebhook(null as never);
		await wa.handleWebhook({ entry: "x" } as never);
		// A handler that fails every time: twice an error (Meta delivers again), the third time dropped and logged.
		const failing = new WhatsAppAdapter({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "v", tenantId: "default", instanceId: "owni", apiBase: graph.base, log: (m) => void logs.push(m) });
		failing.onInbound(async () => {
			throw new Error("disk full");
		});
		const again = delivery([{ from: "393331234567", id: "wamid.bad", type: "text", text: { body: "x" } }]);
		await expect(failing.handleWebhook(again)).rejects.toThrow("disk full");
		await expect(failing.handleWebhook(again)).rejects.toThrow("disk full");
		await failing.handleWebhook(again);
		expect(logs.some((l) => l.includes("wamid.bad dropped after 3"))).toBe(true);
	});

	it("a message Meta could not deliver later (outside the 24 hours) is logged; files go with their type, unknown kinds are refused; emoji are never cut", async () => {
		const graph = await fakeGraph();
		const logs: string[] = [];
		const wa = new WhatsAppAdapter({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "v", tenantId: "default", instanceId: "owni", apiBase: graph.base, log: (m) => void logs.push(m) });
		const statuses = delivery([]);
		(statuses.entry?.[0]?.changes?.[0]?.value as { statuses?: unknown[] }).statuses = [{ id: "wamid.out1", status: "failed", recipient_id: "393331234567", errors: [{ code: 131047, title: "Re-engagement message" }] }];
		await wa.handleWebhook(statuses);
		expect(logs).toEqual(["whatsapp: message wamid.out1 to 393331234567 not delivered: outside the 24-hour window, the person must write to Owni first"]);
		const base = { tenantId: "default", instanceId: "owni", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k" };
		await wa.sendFile({ ...base, name: "Preventivo.PDF", data: new Uint8Array([1]) });
		expect(graph.calls.find((c) => c.path === `/${PHONE_ID}/media`)?.body).toContain("application/pdf");
		await expect(wa.sendFile({ ...base, name: "script.exe", data: new Uint8Array([1]) })).rejects.toThrow(ChannelRefused);
		const pieces = splitText(`${"a".repeat(3)}😀b`, 4);
		expect(pieces).toEqual(["aaa", "😀b"]);
	});

	it("outside the 24-hour window Meta's refusal says so, final; errors never carry the token", async () => {
		const graph = await fakeGraph({ refuse: { code: 131047, message: "Re-engagement message" } });
		const wa = adapterFor(graph.base);
		const error = await wa.send({ tenantId: "default", instanceId: "owni", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k", text: "Promemoria" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChannelRefused);
		expect((error as ChannelRefused).retryable).toBe(false);
		expect((error as Error).message).toContain("24-hour window");
		const wrong = new WhatsAppAdapter({ accessToken: "EAAGwrongtoken0123456789", phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "v", tenantId: "default", instanceId: "owni", apiBase: graph.base });
		const refused = await wrong.me().catch((e: Error) => e);
		expect((refused as Error).message).not.toContain("EAAG");
	});
});

describe("WhatsApp beyond the 24-hour window", () => {
	/** The adapter's store with the app's rules, kept in memory. */
	function memoryWindow() {
		let state: WindowState = {};
		const window = windowStore({ read: () => state, update: (change) => void (state = change(state)) });
		return { window, state: () => state, setLast: (n: string, at: number) => void (state = { ...state, [n]: { ...state[n], last: at } }) };
	}
	const base = { tenantId: "default", instanceId: "owni", channel: "whatsapp", threadId: "393331234567", idempotencyKey: "k" };
	const adapter = (apiBase: string, store: ReturnType<typeof memoryWindow>, extra: { template?: { name: string; language: string }; log?: (m: string) => void } = {}) => {
		const wa = new WhatsAppAdapter({ accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, verifyToken: "v", tenantId: "default", instanceId: "owni", apiBase, window: store.window, mayDownload: async (n) => n === "393331234567", ...extra });
		wa.onInbound(async () => {});
		return wa;
	};
	const templates = (graph: Awaited<ReturnType<typeof fakeGraph>>) => graph.sent().filter((b) => b.type === "template");

	it("outside the window a reaction is dropped: nothing sent, nothing thrown, and it is logged (ADR 0132)", async () => {
		const graph = await fakeGraph();
		const store = memoryWindow();
		const logs: string[] = [];
		const wa = adapter(graph.base, store, { log: (m) => logs.push(m) });
		const reaction = { ...base, idempotencyKey: "react:1", messageId: "wamid.in1", emoji: "👍" };
		store.setLast("393331234567", Date.now() - 48 * 3_600_000);
		await expect(wa.react(reaction)).resolves.toBeUndefined();
		expect(graph.sent()).toEqual([]);
		expect(store.state()["393331234567"]?.parked ?? []).toEqual([]);
		expect(logs).toEqual(["whatsapp: reaction to 393331234567 dropped, outside the 24-hour window"]);
		// Inside it, the same reaction goes.
		store.setLast("393331234567", Date.now() - 3_600_000);
		await wa.react(reaction);
		expect(graph.sent()).toEqual([expect.objectContaining({ type: "reaction", reaction: { message_id: "wamid.in1", emoji: "👍" } })]);
	});

	it("inside the window it writes; outside it keeps the message, tells once with the approved template, and delivers when the person writes", async () => {
		const graph = await fakeGraph();
		const store = memoryWindow();
		const wa = adapter(graph.base, store, { template: { name: "owni_aggiornamento", language: "it" } });
		// Never heard from: sent as is (the window is not known).
		await wa.send({ ...base, text: "Prima volta" });
		expect(graph.sent().at(-1)).toMatchObject({ type: "text", text: { body: "Prima volta" } });
		store.setLast("393331234567", Date.now() - 3_600_000);
		await wa.send({ ...base, text: "Entro la finestra" });
		expect(graph.sent().at(-1)).toMatchObject({ type: "text", text: { body: "Entro la finestra" } });
		// Wrote two days ago: the template, the text flattened into its variable; the message waits.
		store.setLast("393331234567", Date.now() - 48 * 3_600_000);
		await wa.send({ ...base, idempotencyKey: "brief", text: "Promemoria:\n\nscadenza F24 domani", buttons: [{ label: "Approva", data: "tool:0123456789ab:approved" }] });
		expect(templates(graph)).toEqual([
			{
				messaging_product: "whatsapp",
				recipient_type: "individual",
				to: "393331234567",
				type: "template",
				template: { name: "owni_aggiornamento", language: { code: "it" }, components: [{ type: "body", parameters: [{ type: "text", text: "Promemoria: scadenza F24 domani" }] }] },
			},
		]);
		// The same message again (an outbox retry) is kept once; a second message waits without a second paid notice.
		await wa.send({ ...base, idempotencyKey: "brief", text: "Promemoria:\n\nscadenza F24 domani", possibleDuplicate: true });
		await wa.send({ ...base, idempotencyKey: "reminder", text: "Altro promemoria" });
		expect(templates(graph)).toHaveLength(1);
		expect(store.state()["393331234567"]?.parked?.map((p) => p.key)).toEqual(["brief", "reminder"]);
		await expect(wa.sendFile({ ...base, name: "f24.pdf", data: new Uint8Array([1]) })).rejects.toThrow(/24-hour window/);
		// The person writes: what waited goes first, in order, with its buttons; the window is open again.
		const before = graph.sent().length;
		await wa.handleWebhook(delivery([{ from: "393331234567", id: "wamid.back", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "eccomi" } }]));
		const delivered = graph.sent().slice(before);
		expect(delivered.map((b) => b.type)).toEqual(["interactive", "text"]);
		expect(delivered[0]).toMatchObject({ interactive: { body: { text: "Promemoria:\n\nscadenza F24 domani" } } });
		expect(store.state()["393331234567"]?.parked).toEqual([]);
		await wa.send({ ...base, text: "Di nuovo libero" });
		expect(graph.sent().at(-1)).toMatchObject({ type: "text", text: { body: "Di nuovo libero" } });
		// Closed again later: a new notice is due.
		store.setLast("393331234567", Date.now() - 48 * 3_600_000);
		await wa.send({ ...base, idempotencyKey: "next", text: "Domani" });
		expect(templates(graph)).toHaveLength(2);
	});

	it("a notice Meta refuses still leaves the message waiting, and the send counts as handed off; without a template it only waits", async () => {
		const refusing = await fakeGraph({ refuse: { code: 132001, message: "Template name does not exist" } });
		const store = memoryWindow();
		const logs: string[] = [];
		const wa = adapter(refusing.base, store, { template: { name: "manca", language: "it" }, log: (m) => void logs.push(m) });
		store.setLast("393331234567", Date.now() - 48 * 3_600_000);
		await wa.send({ ...base, idempotencyKey: "a", text: "Aspetto" });
		expect(store.state()["393331234567"]?.parked?.map((p) => p.text)).toEqual(["Aspetto"]);
		expect(logs.at(-1)).toMatch(/notice to 393331234567 not sent \(template manca\).*waits for them anyway/);
		const quiet = memoryWindow();
		const plain = await fakeGraph();
		const silent = adapter(plain.base, quiet, { log: (m) => void logs.push(m) });
		quiet.setLast("393331234567", Date.now() - 48 * 3_600_000);
		await silent.send({ ...base, idempotencyKey: "b", text: "Senza avviso" });
		expect(plain.sent()).toHaveLength(0);
		expect(logs.at(-1)).toContain("kept until they write (no template set)");
	});

	it("an old message Meta delivers again opens nothing; a delivery that fails stays, to go again with the notice; strangers are not recorded", async () => {
		const graph = await fakeGraph();
		const store = memoryWindow();
		const wa = adapter(graph.base, store);
		store.setLast("393331234567", Date.now() - 48 * 3_600_000);
		await wa.send({ ...base, idempotencyKey: "w", text: "In attesa" });
		const twoDaysAgo = String(Math.floor((Date.now() - 47 * 3_600_000) / 1000));
		await wa.handleWebhook(delivery([{ from: "393331234567", id: "wamid.old", timestamp: twoDaysAgo, type: "text", text: { body: "vecchio" } }]));
		expect(store.state()["393331234567"]?.parked).toHaveLength(1);
		const refusing = await fakeGraph({ refuse: { code: 131000, message: "Something went wrong" } });
		const later = adapter(refusing.base, store);
		await later.handleWebhook(delivery([{ from: "393331234567", id: "wamid.now", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "ci sono" } }]));
		expect(store.state()["393331234567"]?.parked).toEqual([{ key: "w", text: "In attesa", resend: true }]);
		await adapter(graph.base, store).handleWebhook(delivery([{ from: "393331234567", id: "wamid.again", type: "text", text: { body: "riprovo" } }]));
		expect(graph.sent().at(-1)?.text.body).toMatch(/^Possibile doppione/);
		await wa.handleWebhook(delivery([{ from: "390000000000", id: "wamid.s", type: "text", text: { body: "estraneo" } }]));
		expect(store.state()["390000000000"]).toBeUndefined();
	});
});

describe("WhatsApp in an instance", () => {
	async function boot(apiBase: string) {
		const dataDir = tempDataDir();
		const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", OWNI_PUBLIC_URL: "https://owni.example.it" });
		const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { whatsappApiBase: apiBase, schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => owni.stop());
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as any) };
		};
		const hook = (body: unknown, signature?: string) => {
			const raw = JSON.stringify(body);
			return fetch(`${base}/hooks/whatsapp/owni`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) }, body: raw });
		};
		return { owni, api, hook, base, dataDir };
	}

	it("the owner connects a number from the console; allowed people get answers, strangers silence, forged deliveries nothing", async () => {
		const graph = await fakeGraph();
		const { api, hook, base, dataDir } = await boot(graph.base);
		expect((await api("/api/instances/owni/whatsapp")).whatsapp).toMatchObject({ connected: false, webhookUrl: "https://owni.example.it/hooks/whatsapp/owni" });
		// The first time needs all three values; Meta checks token and number id.
		expect((await api("/api/instances/owni/whatsapp", { accessToken: TOKEN }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/whatsapp", { accessToken: "EAAGwrongtoken0123456789", phoneNumberId: PHONE_ID, appSecret: APP_SECRET }, "PUT")).status).toBe(400);
		const connected = await api("/api/instances/owni/whatsapp", { accessToken: TOKEN, phoneNumberId: PHONE_ID, appSecret: APP_SECRET, allowedUsers: ["393331234567"] }, "PUT");
		expect(connected.whatsapp).toMatchObject({ connected: true, number: "+39 06 1234 5678", allowedUsers: ["393331234567"], verifyToken: expect.stringMatching(/^[\w-]{20,}$/) });
		// Token and app secret never come back.
		expect(JSON.stringify(connected)).not.toContain(TOKEN);
		expect(JSON.stringify(connected)).not.toContain(APP_SECRET);
		// Meta's check of the address.
		const challenge = await fetch(`${base}/hooks/whatsapp/owni?hub.mode=subscribe&hub.verify_token=${connected.whatsapp.verifyToken}&hub.challenge=42`);
		expect([challenge.status, await challenge.text()]).toEqual([200, "42"]);
		expect((await fetch(`${base}/hooks/whatsapp/owni?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`)).status).toBe(403);
		// A forged delivery is refused; a stranger gets no answer; an allowed person does.
		expect((await hook(delivery([{ from: "393331234567", id: "wamid.f", type: "text", text: { body: "falso" } }]), sign("{}"))).status).toBe(401);
		expect((await hook(delivery([{ from: "390000000000", id: "wamid.s", type: "text", text: { body: "sono un estraneo" } }]))).status).toBe(200);
		expect((await hook(delivery([{ from: "393331234567", id: "wamid.a", type: "text", text: { body: "ciao da WhatsApp" } }]))).status).toBe(200);
		for (const start = Date.now(); !graph.sent().some((b) => b.to === "393331234567") && Date.now() - start < 10_000; ) await new Promise((r) => setTimeout(r, 30));
		expect(graph.sent().filter((b) => b.to === "393331234567").map((b) => b.text.body).join(" ")).toContain("ciao da WhatsApp");
		expect(graph.sent().some((b) => b.to === "390000000000")).toBe(false);
		// The same delivery again (Meta retries) does not answer twice.
		const answers = graph.sent().length;
		await hook(delivery([{ from: "393331234567", id: "wamid.a", type: "text", text: { body: "ciao da WhatsApp" } }]));
		await new Promise((r) => setTimeout(r, 300));
		expect(graph.sent()).toHaveLength(answers);
		// The template is set from the console, checked, and comes back; empty removes it.
		expect((await api("/api/instances/owni/whatsapp", { templateName: "Owni Aggiornamento", templateLanguage: "it" }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/whatsapp", { templateName: "owni_aggiornamento", templateLanguage: "it" }, "PUT")).whatsapp.template).toEqual({ name: "owni_aggiornamento", language: "it" });
		expect((await api("/api/instances/owni/whatsapp", { templateName: "", templateLanguage: "" }, "PUT")).whatsapp.template).toBeNull();
		// When the person last wrote is kept on disk, for after a restart.
		expect(Object.keys(JSON.parse(readFileSync(join(dataDir, "tenants", "default", "instances", "owni", "whatsapp-window.json"), "utf8")))).toContain("393331234567");
		// Disconnected: the address answers nothing.
		expect((await api("/api/instances/owni/whatsapp", undefined, "DELETE")).status).toBe(200);
		expect((await hook(delivery([]))).status).toBe(404);
	}, 30_000);
});
