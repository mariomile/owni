import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { FakeCrmAdapter } from "../src/connectors/crm-fake.ts";
import { FakeMailAdapter } from "../src/connectors/mail-fake.ts";
import type { InboundMail } from "../src/connectors/types.ts";
import { AuditLog } from "../src/core/audit.ts";
import { tenantId } from "../src/core/ids.ts";
import { FAUX_MODEL_ROLES } from "../src/core/model-routing.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { processInboundMail } from "../src/segreteria/pipeline.ts";
import { SegreteriaService } from "../src/segreteria/service.ts";

type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };

/** Fake Telegram: queued updates, recorded sendMessage bodies, sendMessage can be made to fail. */
function fakeTelegram() {
	const updates: unknown[][] = [];
	const sent: Sent[] = [];
	const state = { failSend: false, networkError: false };
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const method = String(url).slice(String(url).lastIndexOf("/") + 1);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (method === "getUpdates") return Response.json({ ok: true, result: updates.shift() ?? [] });
		if (method === "answerCallbackQuery") return Response.json({ ok: true, result: true });
		if (method === "sendMessage") {
			if (state.networkError) throw new TypeError("fetch failed");
			if (state.failSend) return Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 });
			sent.push(body as unknown as Sent);
			return Response.json({ ok: true, result: { message_id: sent.length } });
		}
		return Response.json({ ok: false, error_code: 404 });
	}) as typeof fetch;
	return { updates, sent, state, fetch: fetchImpl };
}

let updateId = 100;
const tap = (userId: number, data: string) => ({ update_id: updateId++, callback_query: { id: `cq${updateId}`, from: { id: userId }, message: { message_id: 1, chat: { id: userId } }, data } });
const text = (userId: number, t: string) => ({ update_id: updateId++, message: { message_id: updateId, chat: { id: userId }, from: { id: userId }, text: t } });

const request = (over: Partial<InboundMail> = {}): InboundMail => ({
	messageId: "m1",
	threadId: "t1",
	from: "Marta Bianchi <marta.bianchi@acme.example>",
	fromName: "Marta Bianchi",
	subject: "Richiesta preventivo stampante",
	bodyText: "Buongiorno, chiedo preventivo per 2 stampanti UV. Sede Milano. Grazie.",
	receivedAt: "2026-10-15T12:00:00.000Z",
	...over,
});

function setup(dataDir = mkdtempSync(join(tmpdir(), "owni-svc-")), shared?: { mail: FakeMailAdapter; crm: FakeCrmAdapter }) {
	const telegram = fakeTelegram();
	const bot = new TelegramAdapter({ token: "1:T", tenantId: "acme", instanceId: "segreteria", fetch: telegram.fetch });
	const mail = shared?.mail ?? new FakeMailAdapter();
	const crm = shared?.crm ?? new FakeCrmAdapter();
	const audit = new AuditLog(dataDir, tenantId("acme"));
	const logs: string[] = [];
	const service = new SegreteriaService({
		tenantId: "acme",
		instanceId: "segreteria",
		instanceDir: join(dataDir, "tenants", "acme", "instances", "segreteria"),
		mail,
		crm,
		telegram: bot,
		audit,
		usage: new UsageLedger(join(dataDir, "tenants", "acme")),
		roles: FAUX_MODEL_ROLES,
		salesUserIds: ["7"],
		log: (l) => logs.push(l),
	});
	return { dataDir, telegram, bot, mail, crm, audit, service, logs };
}

const buttonsOf = (m: Sent | undefined) => m?.reply_markup?.inline_keyboard[0]?.map((b) => b.text);
const dataOf = (m: Sent | undefined, label: string) => m?.reply_markup?.inline_keyboard[0]?.find((b) => b.text === label)?.callback_data as string;

describe("segreteria service (fake mailbox, fake Telegram)", () => {
	it("mail in → card with three buttons to the sales person → Approva → one reply sent", async () => {
		const h = setup();
		h.mail.seed([request()]);
		expect(await h.service.pollOnce()).toEqual({ processed: 1 });
		const card = h.telegram.sent.at(-1);
		expect(card?.chat_id).toBe("7");
		expect(card?.text).toContain("Nuova richiesta di preventivo");
		expect(buttonsOf(card)).toEqual(["Approva", "Modifica", "Scarta"]);
		expect(h.mail.sent).toHaveLength(0);

		// The same mail on the next poll is not a second pratica.
		expect(await h.service.pollOnce()).toEqual({ processed: 0 });

		h.telegram.updates.push([tap(7, dataOf(card, "Approva"))]);
		await h.bot.pollOnce();
		expect(h.mail.sent).toHaveLength(1);
		expect(h.mail.sent[0]).toMatchObject({ to: "marta.bianchi@acme.example", inReplyToMessageId: "m1" });
		expect(h.telegram.sent.at(-1)?.text).toContain("Inviata");

		// A tap redelivered after a crash sends nothing more.
		h.telegram.updates.push([tap(7, dataOf(card, "Approva"))]);
		await h.bot.pollOnce();
		expect(h.mail.sent).toHaveLength(1);
	});

	it("Modifica, then a text from the sales person, gives a new draft version with new buttons", async () => {
		const h = setup();
		h.mail.seed([request()]);
		await h.service.pollOnce();
		const card = h.telegram.sent.at(-1);
		h.telegram.updates.push([tap(7, dataOf(card, "Modifica"))], [text(7, "Aggiungi che il sopralluogo è gratuito.")]);
		await h.bot.pollOnce();
		expect(h.telegram.sent.at(-1)?.text).toContain("Scrivi qui sotto");
		await h.bot.pollOnce();
		const v2 = h.telegram.sent.at(-1);
		expect(v2?.text).toContain("Bozza v2");
		expect(dataOf(v2, "Approva")).toMatch(/:2:approve$/);
		expect(h.mail.sent).toHaveLength(0);
	});

	it("an edit text goes to the pratica its sender tapped Modifica on, and only within 30 minutes", async () => {
		const h = setup();
		h.mail.seed([request({ messageId: "a", threadId: "ta" }), request({ messageId: "b", threadId: "tb", subject: "Seconda richiesta" })]);
		await h.service.pollOnce();
		const [cardA, cardB] = h.telegram.sent.slice(-2);
		// Two sales people: 7 edits A, then 8 edits B; 7's text must land on A.
		(h.service as unknown as { sales: Set<string> }).sales.add("8");
		h.telegram.updates.push([tap(7, dataOf(cardA, "Modifica"))], [tap(8, dataOf(cardB, "Modifica"))], [text(7, "Aggiungi il sopralluogo gratuito.")]);
		await h.bot.pollOnce();
		await h.bot.pollOnce();
		await h.bot.pollOnce();
		const list = await h.service.practices.list();
		const a = list.find((p) => p.mailMessageId === "a");
		const b = list.find((p) => p.mailMessageId === "b");
		expect(a?.draftVersion).toBe(2);
		expect(b).toMatchObject({ draftVersion: 1, status: "awaiting_edit", editingBy: "8" });
		// A Modifica forgotten for over 30 minutes: the text is not an edit.
		b!.editingSince = new Date(Date.now() - 31 * 60_000).toISOString();
		await h.service.practices.save(b!);
		h.telegram.updates.push([text(8, "ok grazie")]);
		await h.bot.pollOnce();
		expect((await h.service.practices.get(b!.praticaId))?.draftVersion).toBe(1);
		expect(h.telegram.sent.at(-1)?.text).toContain("Segreteria attiva");
	});

	it("strangers get silence; taps and texts from them are audited and change nothing", async () => {
		const h = setup();
		h.mail.seed([request()]);
		await h.service.pollOnce();
		const card = h.telegram.sent.at(-1);
		const before = h.telegram.sent.length;
		h.telegram.updates.push([tap(66, dataOf(card, "Approva")), text(66, "ciao")]);
		await h.bot.pollOnce();
		expect(h.telegram.sent.length).toBe(before);
		expect(h.mail.sent).toHaveLength(0);
		const denied = (await h.audit.read()).filter((e) => e.type === "user.denied");
		expect(denied.map((e) => e.userId)).toEqual(["66", "66"]);
	});

	it("a card Telegram refused goes out on the next round, without the duplicate line (it never arrived)", async () => {
		const h = setup();
		h.mail.seed([request()]);
		h.telegram.state.failSend = true;
		await h.service.pollOnce();
		expect(h.telegram.sent).toHaveLength(0);
		expect(h.logs.some((l) => l.includes("retried next round"))).toBe(true);
		h.telegram.state.failSend = false;
		await h.service.pollOnce();
		expect(h.telegram.sent).toHaveLength(1);
		expect(h.telegram.sent[0]?.text.startsWith("Nuova richiesta di preventivo")).toBe(true);
	});

	it("a card whose send was cut off (no answer from Telegram) is resent at the next start, marked as a possible duplicate", async () => {
		const first = setup();
		first.mail.seed([request()]);
		first.telegram.state.networkError = true;
		await first.service.pollOnce();
		expect(first.telegram.sent).toHaveLength(0);

		const second = setup(first.dataDir, { mail: first.mail, crm: first.crm });
		await second.service.recoverNow();
		const card = second.telegram.sent.at(-1);
		expect(card?.text.startsWith("Possibile doppione di notifica: ignora se hai già risposto.\n\n")).toBe(true);
		expect(buttonsOf(card)).toEqual(["Approva", "Modifica", "Scarta"]);
		// Delivered: a third start sends nothing.
		const third = setup(first.dataDir, { mail: first.mail, crm: first.crm });
		await third.service.recoverNow();
		expect(third.telegram.sent).toHaveLength(0);
	});

	it("a crash after the pratica was saved and before its card was written: the card goes out on the next round", async () => {
		const h = setup();
		h.mail.seed([request()]);
		// The pipeline ran to the end except the card (the process died in between): no card, cursor not moved.
		await processInboundMail(
			{ tenantId: "acme", instanceId: "segreteria", practices: h.service.practices, mail: h.mail, crm: h.crm, audit: h.audit, usage: new UsageLedger(join(h.dataDir, "x")), roles: FAUX_MODEL_ROLES, notify: async () => {} },
			request(),
		);
		expect(h.telegram.sent).toHaveLength(0);
		await h.service.pollOnce();
		const card = h.telegram.sent.at(-1);
		expect(card?.text).toContain("Nuova richiesta di preventivo");
		expect(buttonsOf(card)).toEqual(["Approva", "Modifica", "Scarta"]);
		// Only once: the card is marked now.
		await h.service.pollOnce();
		expect(h.telegram.sent).toHaveLength(1);
		expect((await h.audit.read()).filter((e) => e.type === "card.recovered")).toHaveLength(1);
	});

	it("over the hard spend cap: one notice a day, no pratica, mails read again once the cap resets", async () => {
		const h = setup();
		await new UsageLedger(join(h.dataDir, "tenants", "acme")).record({ at: new Date().toISOString(), provider: "anthropic", model: "claude-sonnet-5-5", role: "draft", inputTokens: 0, outputTokens: 0, estimatedUsd: 25 });
		h.mail.seed([request()]);
		await h.service.pollOnce();
		await h.service.pollOnce();
		expect(h.telegram.sent.filter((m) => m.text.startsWith("Limite hard di spesa"))).toHaveLength(1);
		expect(await h.service.practices.list()).toEqual([]);
	});

	it("a mail that keeps failing is skipped after three tries, with a notice, and does not block the next ones", async () => {
		const h = setup();
		h.mail.seed([request({ messageId: "bad" }), request({ messageId: "good", threadId: "t2" })]);
		let calls = 0;
		const upsert = h.crm.upsertLead.bind(h.crm);
		h.crm.upsertLead = async (...args) => {
			calls++;
			return upsert(...args);
		};
		const practicesSave = h.service.practices.save.bind(h.service.practices);
		h.service.practices.save = async (p) => {
			if (p.mailMessageId === "bad") throw new Error("disk full");
			return practicesSave(p);
		};
		// Tries 1 and 2 stop at the bad mail; try 3 gives up on it and goes on in the same round.
		expect(await h.service.pollOnce()).toEqual({ processed: 0 });
		expect(await h.service.pollOnce()).toEqual({ processed: 0 });
		expect(await h.service.pollOnce()).toEqual({ processed: 1 });
		expect(h.telegram.sent.some((m) => m.text.startsWith("Mail non elaborata"))).toBe(true);
		expect(await h.service.pollOnce()).toEqual({ processed: 0 });
		expect((await h.service.practices.list()).map((p) => p.mailMessageId)).toEqual(["good"]);
		// The bad mail upserts its lead on each of its 3 tries (idempotent by email), the good one once.
		expect(calls).toBe(4);
	});
});
