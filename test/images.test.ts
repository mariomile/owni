import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { IMAGE_LIMITS, imageProblem, imageType } from "../src/core/images.ts";
import { OwniRuntime } from "../src/core/index.ts";
import { createWorkspaceTools } from "../src/core/tools/workspace-tools.ts";
import { connectChannel } from "../src/gateway.ts";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { FAUX_MODEL, JPEG, PNG, runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0x24, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

describe("images: what counts as one", () => {
	it("is told by its bytes, not by its name, and must fit what the model takes", () => {
		expect([PNG, JPEG, GIF, WEBP].map(imageType)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
		expect(imageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
		expect(imageType(new TextEncoder().encode("%PDF-1.7"))).toBeUndefined();
		expect(imageType(new Uint8Array())).toBeUndefined();
		expect(imageProblem(PNG)).toBeUndefined();
		expect(imageProblem(new TextEncoder().encode("ciao"))).toContain("non è un'immagine");
		const big = new Uint8Array(IMAGE_LIMITS.maxBytes + 1);
		big.set(JPEG);
		expect(imageProblem(big)).toBe("è più grande di 20 MB");
	});
});

describe("images reach the model", () => {
	it("with a person's message: the model sees them, up to four, and only real images", async () => {
		const { runtime, replies } = await runtimeWithInstance({});
		const say = (text: string, images: { path: string; data: Uint8Array }[], id: string) =>
			runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id, images });
		await say("Cosa vedi?", [{ path: "uploads/a.png", data: PNG }], "1");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "answered", text: "Owni (modello locale di sviluppo): hai scritto «Cosa vedi?» e mandato 1 immagine (image/png, 20 byte)" });
		const many = Array.from({ length: 6 }, (_, i) => ({ path: `uploads/${i}.jpg`, data: JPEG }));
		await say("Tante", [...many, { path: "uploads/finta.png", data: new TextEncoder().encode("non sono un png") }], "2");
		await waitFor(() => replies.length === 2);
		const text = (replies[1] as { text: string }).text;
		expect(text).toContain("mandato 4 immagini");
		// What was left out is said, so the model can tell the person.
		expect(text).toContain("[Immagini non mostrate: uploads/4.jpg, uploads/5.jpg (al massimo 4 per messaggio); uploads/finta.png (non è un'immagine JPEG, PNG, GIF o WebP)]");
		const events = await runtime.audit("acme").read();
		// The audit counts them; it never holds them.
		expect(events.filter((e) => e.type === "message.received").map((e) => e.images)).toEqual([1, 4]);
		expect(JSON.stringify(events)).not.toContain(Buffer.from(PNG).toString("base64"));
		await runtime.close();
	});

	it("from Telegram: a photo, in its largest size, lands in uploads/ and the model sees it; a stranger's is never downloaded", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["telegram"] }, allowedUsers: { telegram: ["7"] } });
		const texts: string[] = [];
		const asked: string[] = [];
		const photo = (updateId: number, from: number) => ({
			update_id: updateId,
			message: { message_id: updateId, chat: { id: from, type: "private" }, from: { id: from }, caption: "Che pianta è?", photo: [{ file_id: "small", file_size: 900, width: 90, height: 90 }, { file_id: "big", file_size: 20, width: 1280, height: 960 }, { file_id: "huge", file_size: 25_000_000, width: 9000, height: 9000 }] },
		});
		const updates = [[photo(1, 7), photo(2, 66)]];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			if (String(url).includes("/file/bot")) return new Response(PNG);
			if (method === "getFile") {
				asked.push(String(JSON.parse(String(init?.body)).file_id));
				return Response.json({ ok: true, result: { file_path: "photos/file_9.jpg" } });
			}
			if (method === "sendMessage") texts.push(String(JSON.parse(String(init?.body)).text));
			return Response.json({ ok: true, result: method === "getUpdates" ? (updates.shift() ?? []) : { message_id: 1 } });
		}) as typeof fetch;
		const bot = new TelegramAdapter({ token: "1:T", tenantId: "acme", instanceId: "ops", fetch: fetchImpl, mayDownload: async (id) => id === "7" });
		connectChannel(runtime, bot, { tenantId: "acme", instanceId: "ops" });
		await bot.pollOnce();
		await waitFor(() => texts.length === 1);
		expect(asked).toEqual(["big"]);
		expect(texts[0]).toBe("Owni (modello locale di sviluppo): hai scritto «Che pianta è?\n\n[Immagine nel workspace: uploads/7_1-foto.png]» e mandato 1 immagine (image/png, 20 byte)");
		expect((await runtime.workspace("acme", "ops").list()).map((f) => f.path)).toEqual(["uploads/7_1-foto.png"]);
		await runtime.close();
	});

	it("from Telegram: an album is one message; a document that is a picture is seen; a photo that cannot be had is said, with its caption", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["telegram"] }, allowedUsers: { telegram: ["7"] } });
		const texts: string[] = [];
		const message = (id: number, extra: object) => ({ update_id: id, message: { message_id: id, chat: { id: 7, type: "private" }, from: { id: 7 }, ...extra } });
		const part = (id: number, extra: object = {}) => message(id, { media_group_id: "A1", photo: [{ file_id: `p${id}`, file_size: 20, width: 800, height: 600 }], ...extra });
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			if (String(url).includes("/file/bot")) return new Response(PNG);
			if (method === "getFile") return Response.json({ ok: true, result: { file_path: "photos/x.png" } });
			if (method === "sendMessage") texts.push(String(JSON.parse(String(init?.body)).text));
			return Response.json({ ok: true, result: method === "getUpdates" ? (polled.shift() ?? []) : { message_id: 1 } });
		}) as typeof fetch;
		const polled: unknown[][] = [];
		const bot = new TelegramAdapter({ token: "1:T", tenantId: "acme", instanceId: "ops", fetch: fetchImpl, albumWaitMs: 50 });
		connectChannel(runtime, bot, { tenantId: "acme", instanceId: "ops" });
		// Webhook: three calls, one message.
		await Promise.all([bot.handleUpdate(part(1, { caption: "Le tre stanze" })), bot.handleUpdate(part(2)), bot.handleUpdate(part(3))]);
		await waitFor(() => texts.length === 1);
		expect(texts[0]).toContain("Le tre stanze");
		expect(texts[0]).toContain("e mandato 3 immagini");
		await bot.handleUpdate(message(4, { document: { file_id: "d", file_name: "scontrino.png", file_size: 20 } }));
		await waitFor(() => texts.length === 2);
		expect(texts[1]).toContain("[Immagine nel workspace: uploads/7_4-scontrino.png]");
		expect(texts[1]).toContain("e mandato 1 immagine");
		await bot.handleUpdate(message(5, { caption: "E questa?", photo: [{ file_id: "enorme", file_size: 30_000_000, width: 9000, height: 9000 }] }));
		await waitFor(() => texts.length === 3);
		expect(texts[2]).toBe("Owni (modello locale di sviluppo): hai scritto «E questa?\n\n[Foto troppo grande o non disponibile.]» [2 messaggi precedenti con immagini]");
		// Polling: the album's updates come in one batch and go as one message.
		polled.push([message(6, { media_group_id: "B2", caption: "Due", photo: [{ file_id: "q6", file_size: 20, width: 8, height: 8 }] }), message(7, { media_group_id: "B2", photo: [{ file_id: "q7", file_size: 20, width: 8, height: 8 }] })]);
		await bot.pollOnce();
		await waitFor(() => texts.length === 4);
		expect(texts[3]).toContain("uploads/7_6-foto-2.png");
		expect(texts[3]).toContain("e mandato 2 immagini");
		await runtime.close();
	});

	it("only the newest two messages with pictures show them; older ones leave the request, not the history", async () => {
		const { runtime, replies } = await runtimeWithInstance({});
		const say = (text: string, id: string, images: { path: string; data: Uint8Array }[] = []) =>
			runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id, images });
		for (const i of [1, 2, 3]) {
			await say(`foto ${i}`, String(i), [{ path: `uploads/${i}.png`, data: PNG }]);
			await waitFor(() => replies.length === i);
		}
		await say("e adesso?", "4");
		await waitFor(() => replies.length === 4);
		const texts = replies.map((r) => (r as { text: string }).text);
		expect(texts[1]).toContain("[1 messaggio precedente con immagini]");
		// Third photo: the first has left the request.
		expect(texts[2]).toContain("[1 messaggio precedente con immagini]");
		expect(texts[3]).toBe("Owni (modello locale di sviluppo): hai scritto «e adesso?» [2 messaggi precedenti con immagini]");
		await runtime.close();
	});

	it("a photo too big for the model is shrunk on the way", async () => {
		const { runtime, replies } = await runtimeWithInstance({});
		const big = noisyPng(1400, 1100);
		expect(Math.ceil(big.length / 3) * 4).toBeGreaterThan(4.5 * 1024 * 1024);
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text: "Grande", messageId: "1", images: [{ path: "uploads/grande.png", data: big }] });
		await waitFor(() => replies.length === 1, 20_000);
		const seen = /mandato 1 immagine \((image\/\w+), (\d+) byte\)/.exec((replies[0] as { text: string }).text);
		expect(seen).not.toBeNull();
		expect(Math.ceil(Number(seen?.[2]) / 3) * 4).toBeLessThanOrEqual(4.5 * 1024 * 1024);
		await runtime.close();
	}, 30_000);

	it("from the workspace: image_view shows the model a picture there, and refuses what is not one", async () => {
		const { runtime, replies } = await runtimeWithInstance({ toolsFor: (rt) => createWorkspaceTools({ workspace: rt.workspace("acme", "ops"), sendFile: async () => {} }) });
		await runtime.workspace("acme", "ops").write("grafici/vendite.png", PNG);
		await runtime.workspace("acme", "ops").write("note.txt", new TextEncoder().encode("ciao"));
		const say = (text: string, id: string) => runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id });
		await say('/tool image_view {"path":"grafici/vendite.png"}', "1");
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ text: "Fatto. Ecco grafici/vendite.png (image/png, 20 byte). [1 immagine]" });
		await say('/tool image_view {"path":"note.txt"}', "2");
		await waitFor(() => replies.length === 2);
		expect(replies[1]).toMatchObject({ text: "Fatto. Errore: note.txt non è un'immagine JPEG, PNG, GIF o WebP." });
		await say('/tool image_view {"path":"../fuori.png"}', "3");
		await waitFor(() => replies.length === 3);
		expect((replies[2] as { text: string }).text).toContain("Errore:");
		await runtime.close();
	});
});

/** A real PNG of random pixels: it does not compress, so it stays as big as its size. */
function noisyPng(width: number, height: number): Uint8Array {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc(body));
		return Buffer.concat([head, body, tail]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const rows = randomBytes((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
	return new Uint8Array(Buffer.concat([Buffer.from(PNG.subarray(0, 8)), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}
