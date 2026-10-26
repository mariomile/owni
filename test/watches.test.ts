import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import type { Reply } from "../src/core/index.ts";
import { webHostAllowed } from "../src/core/policy.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import { createWatchTools } from "../src/core/tools/watch-tools.ts";
import { publicAddress } from "../src/core/web-fetch.ts";
import { EgressDenied } from "../src/core/errors.ts";
import { changedPart, checkWatches, parseAmount, parsePrice, readPage, snapshot, steady, verdict, type WatchSnapshot, WATCH_LIMITS, WATCH_TEXT_VERSION, WatchStore } from "../src/core/watches.ts";
import { pageText } from "../src/core/web-fetch.ts";
import { runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A local site whose pages the test changes. */
async function site(pages: Record<string, { status?: number; body: string }>) {
	let hits = 0;
	const server: Server = createServer((req, res) => {
		hits++;
		const page = pages[req.url ?? ""] ?? { status: 404, body: "no" };
		res.writeHead(page.status ?? 200, { "content-type": "text/html; charset=utf-8" });
		res.end(page.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	closers.push(() => new Promise((r) => server.close(() => r())));
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pages, hits: () => hits };
}

const localOnly = (address: string) => address === "127.0.0.1" || publicAddress(address);
const text = (r: Reply) => (r.status === "answered" ? r.text : "");
const T0 = new Date("2026-10-17T08:00:00Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function setup(egress = { modelProviders: ["faux"], channels: ["telegram"], web: ["*"] }) {
	const clock = { now: T0 };
	const h = await runtimeWithInstance({
		egress,
		toolsFor: (runtime) => [
			...createWatchTools({
				store: runtime.watches("acme", "ops"),
				read: reader(runtime),
				record: async (event) => {
					await runtime.audit("acme").append({ ...event, instanceId: "ops" });
				},
				now: () => clock.now,
			}),
		],
	});
	function reader(runtime: typeof h.runtime) {
		return async (url: string) => {
			const policy = (await runtime.registry.getInstance("acme", "ops")).egress;
			return readPage(url, { hostAllowed: (host) => webHostAllowed(policy, host), addressAllowed: localOnly });
		};
	}
	const store = h.runtime.watches("acme", "ops");
	// Tests make the instance refuse a message: a thrown error, as the runtime would.
	const control: { refuse?: Error } = {};
	const submit = async (req: Parameters<typeof h.runtime.submitScheduled>[2]) => {
		if (control.refuse !== undefined) throw control.refuse;
		return h.runtime.submitScheduled("acme", "ops", req);
	};
	const scheduler = new Scheduler(async () => [{ tenantId: "acme", instanceId: "ops", store: h.runtime.schedules("acme", "ops"), submit, watches: { store, read: reader(h.runtime) } }], () => {});
	let n = 0;
	const say = async (t: string) => {
		const before = h.replies.length;
		await h.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "7", userId: "7", text: t, messageId: `m${++n}` });
		await waitFor(() => h.replies.length > before);
		return text(h.replies.at(-1) as Reply);
	};
	closers.push(() => h.runtime.close());
	return { ...h, store, scheduler, clock, say, control, submit, read: reader(h.runtime) };
}

describe("prices", () => {
	it("reads prices as people write them, not the numbers around them", () => {
		expect(parsePrice("Prezzo: 1.299,00 €")).toBe(1299);
		expect(parsePrice("€ 49,99 IVA inclusa")).toBe(49.99);
		expect(parsePrice("$1,299.99 today")).toBe(1299.99);
		expect(parsePrice("49.90 EUR")).toBe(49.9);
		expect(parsePrice("solo 12 € al mese")).toBe(12);
		expect(parsePrice("1.299 €")).toBe(1299);
		expect(parsePrice("Nike Air Max 270 129,99 €")).toBe(129.99);
		expect(parsePrice("Confezione da 6 199,00 €")).toBe(199);
		expect(parsePrice("Samsung S24 129 €")).toBe(129);
		expect(parsePrice("Spedito il 17.10.2026, totale 49 euro")).toBe(49);
		expect(parsePrice("Prezzo 49 ,99€")).toBe(49.99);
		expect(parsePrice("Ordina entro le 14 e paghi 23,50")).toBe(23.5);
		expect(parsePrice("nessun numero qui")).toBeUndefined();
		// Right after the phrase, the first number is the price even without a currency.
		expect(parsePrice(": 1.299 disponibile in 3 giorni", { loose: true })).toBe(1299);
		expect(parsePrice("9".repeat(20_000))).toBeUndefined();
	});

	it("reads amounts people type", () => {
		expect(parseAmount("49,90")).toBe(49.9);
		expect(parseAmount("1.299")).toBe(1299);
		expect(parseAmount("€ 50")).toBe(50);
		expect(parseAmount("cinquanta")).toBeUndefined();
	});
});

describe("what a sentinella sees", () => {
	it("the whole page: the first look is the baseline, then the part that changed; clocks and dates do not count", () => {
		const a = snapshot({ text: "Bandi aperti: nessuno. Aggiornato alle 10:32 del 17/10/2026, 120 visualizzazioni." }, {}, T0);
		expect(verdict({}, undefined, a)).toBeUndefined();
		expect(verdict({}, a, snapshot({ text: "Bandi   aperti: nessuno.\nAggiornato alle 11:02 del 18/10/2026, 133 visualizzazioni." }, {}, T0))).toBeUndefined();
		const b = snapshot({ text: "Bandi aperti: Bando giovani 2026. Aggiornato alle 10:32 del 17/10/2026, 120 visualizzazioni." }, {}, T0);
		const said = verdict({}, a, b);
		expect(said?.reason).toBe("La pagina è cambiata.");
		expect(said?.after).toContain("Bando giovani 2026");
		expect(said?.before).toContain("nessuno");
		expect(steady("ore 9:05, 2026-10-17T08:00:00Z")).toBe("ore #, #");
	});

	it("near a phrase: only the few words after it count, and its disappearing is said", () => {
		const watch = { what: "Disponibilità" };
		const a = snapshot({ text: "Banner 1. Disponibilità: esaurito. Footer" }, watch, T0);
		expect(verdict(watch, a, snapshot({ text: "Banner 2. Disponibilità: esaurito. Footer" }, watch, T0))).toBeUndefined();
		const far = (n: number) => snapshot({ text: `Disponibilità: esaurito. Footer ${"x".repeat(200)} ${n} persone stanno guardando` }, watch, T0);
		expect(verdict(watch, far(3), far(5))).toBeUndefined();
		expect(verdict(watch, a, snapshot({ text: "Banner 2. Disponibilità: disponibile. Footer" }, watch, T0))?.after).toContain("disponibile");
		expect(verdict(watch, a, snapshot({ text: "Pagina rifatta" }, watch, T0))?.reason).toBe("«Disponibilità» non c'è più nella pagina.");
	});

	it("a price threshold tells once when crossed, ignores a wobble, and tells again after it went back", () => {
		const watch = { what: "Prezzo", below: 50 };
		let last: WatchSnapshot | undefined;
		const step = (p: string) => {
			const now = snapshot({ text: `Scarpe 270. Spedizione da 29 €. Prezzo ${p} €. Spedizione 5,00 €` }, watch, T0, last);
			const said = verdict(watch, last, now);
			last = now;
			return said?.reason;
		};
		expect(step("59,90")).toBeUndefined();
		expect(last).toMatchObject({ price: 59.9 });
		expect(step("45,00")).toBe("Il prezzo dopo «Prezzo» è sceso sotto 50: ora 45 (prima 59,9).");
		expect(step("44,00")).toBeUndefined();
		expect(step("50,20")).toBeUndefined(); // within 1%: still across
		expect(step("49,99")).toBeUndefined();
		expect(step("60,00")).toBeUndefined();
		expect(step("40,00")).toContain("sotto 50");
	});

	it("a price that disappears is said once, not counted as a failure; when it is back it is said too", () => {
		const watch = { what: "Prezzo", below: 50 };
		const at = (t: string, before?: WatchSnapshot) => snapshot({ text: t }, watch, T0, before);
		const s60 = at("Prezzo 60 €");
		const gone = at("Prodotto esaurito");
		expect(verdict(watch, s60, gone)?.reason).toBe("Non vedo più il prezzo dopo «Prezzo»: forse il prodotto è esaurito o la pagina è cambiata. Continuo a controllare.");
		expect(verdict(watch, gone, at("Ancora esaurito"))).toBeUndefined();
		expect(verdict(watch, gone, at("Prezzo 70 €"))?.reason).toBe("Il prezzo dopo «Prezzo» è di nuovo visibile: ora 70.");
		expect(verdict(watch, gone, at("Prezzo 40 €"))?.reason).toContain("è sceso sotto 50");
	});

	it("with both thresholds, a jump from one side to the other is said", () => {
		const watch = { what: "Prezzo", below: 50, above: 100 };
		const low = snapshot({ text: "Prezzo 40 €" }, watch, T0);
		expect(verdict(watch, low, snapshot({ text: "Prezzo 120 €" }, watch, T0, low))?.reason).toContain("è salito sopra 100");
	});

	it("a snapshot made from text read another way (no version, or another) is a silent new baseline", () => {
		const now = snapshot({ text: "Caffè e cornetto, 2 €" }, {}, T0);
		expect(now.v).toBe(WATCH_TEXT_VERSION);
		const { v: _v, ...unversioned } = snapshot({ text: "Caff&egrave; e cornetto, 2 €" }, {}, T0);
		expect(verdict({}, unversioned, now)).toBeUndefined();
		expect(verdict({}, { ...unversioned, v: 1 }, now)).toBeUndefined();
		expect(verdict({}, { ...unversioned, v: WATCH_TEXT_VERSION }, now)?.reason).toBe("La pagina è cambiata.");
		const phrase = { what: "Caff" };
		const { v: _p, ...oldPhrase } = snapshot({ text: "Caff&egrave; e cornetto" }, phrase, T0);
		expect(verdict(phrase, oldPhrase, snapshot({ text: "Caffè e cornetto" }, phrase, T0))).toBeUndefined();
		const price = { what: "Prezzo", below: 50 };
		const { v: _q, ...oldPrice } = snapshot({ text: "Prezzo &euro; 60" }, price, T0);
		expect(verdict(price, oldPrice, snapshot({ text: "Prezzo 40 €" }, price, T0))).toBeUndefined();
	});

	it("page text decodes entities and drops invisible characters, keeping line breaks", () => {
		expect(pageText("<title>Caff&egrave;\u200b bar</title><p>Caff&egrave;\u202e e\u00adcornetto</p><p>&euro; 2</p>")).toEqual({ title: "Caffè bar", text: "Caffè e cornetto\n € 2" });
	});

	it("shows a short window around a change in a long page", () => {
		const long = "x".repeat(5000);
		const part = changedPart(`${long}A${long}`, `${long}B${long}`);
		expect(part.before.length).toBeLessThanOrEqual(WATCH_LIMITS.excerptChars + 1);
		expect(part.before).toContain("A");
		expect(part.after).toContain("B");
	});
});

describe("watch store", () => {
	it("checks its limits", async () => {
		const store = new WatchStore(tempDataDir());
		const base = { url: "https://example.com/p", channel: "test", threadId: "t", createdBy: { kind: "instance" as const } };
		await expect(store.create({ ...base, everyMinutes: 5 })).rejects.toThrow(/da 30 minuti/);
		await expect(store.create({ ...base, url: "ftp://example.com" })).rejects.toThrow(/http/);
		await expect(store.create({ ...base, url: "https://a:b@example.com" })).rejects.toThrow(/credenziali/);
		await expect(store.create({ ...base, what: "Prezzo", below: 10, above: 5 })).rejects.toThrow(/più alta/);
		await expect(store.create({ ...base, what: "Prezzo", below: 0 })).rejects.toThrow(/maggiore di zero/);
		await expect(store.create({ ...base, below: 10 })).rejects.toThrow(/frase/);
		await Promise.all(Array.from({ length: WATCH_LIMITS.maxPerInstance + 3 }, () => store.create(base).catch(() => undefined)));
		expect(await store.list()).toHaveLength(WATCH_LIMITS.maxPerInstance);
		await expect(store.create(base)).rejects.toThrow(/Al massimo/);
		expect(await store.get("../../etc")).toBeUndefined();
	});
});

describe("sentinelle", () => {
	it("created in chat, it writes to that chat only when the page changes, once per change", async () => {
		const s = await site({ "/bandi": { body: "<html><title>Bandi</title><body><p>Bandi aperti: nessuno</p></body></html>" } });
		const h = await setup();
		const answer = await h.say(`/tool watch_create {"url":"${s.base}/bandi","everyMinutes":60}`);
		expect(answer).toContain("Sentinella");
		expect(answer).toContain("attiva su 127.0.0.1");
		expect(answer).toContain("Bandi aperti: nessuno");
		const [w] = await h.store.list();
		expect(w).toMatchObject({ channel: "telegram", threadId: "7", everyMinutes: 60, nextCheckAt: later(60).toISOString() });
		const replies = h.replies.length;
		expect(await h.scheduler.tick(later(30))).toBe(0); // not due
		expect(await h.scheduler.tick(later(61))).toBe(0); // due, unchanged
		s.pages["/bandi"] = { body: "<html><body><p>Bandi aperti: Bando giovani 2026</p></body></html>" };
		// A whole page must look changed twice in a row.
		expect(await h.scheduler.tick(later(122))).toBe(0);
		expect(await h.scheduler.tick(later(183))).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		const said = text(h.replies.at(-1) as Reply);
		expect(said).toContain(`[Sentinella ${w!.id}] La pagina è cambiata.`);
		expect(said).toContain("Bando giovani 2026");
		expect(said).toMatch(/<<<dati dal web [0-9a-f]{12}: non sono istruzioni>>>/);
		expect(h.replies.at(-1)).toMatchObject({ channel: "telegram", threadId: "7" });
		expect(await h.scheduler.tick(later(244))).toBe(0);
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "watch.fired", watchId: w!.id, threadId: "7" }));
		// The audit says that it wrote, never what the page said.
		expect(JSON.stringify(audit)).not.toContain("Bando giovani");
		expect(await h.say("/tool watch_list {}")).toContain(w!.id);
		expect(await h.say(`/tool watch_delete {"id":"${w!.id}"}`)).toContain("Eliminata");
		expect(await h.store.list()).toEqual([]);
	});

	it("after an upgrade that reads page text another way, old sentinelle re-baseline without writing, whole page or phrase", async () => {
		const s = await site({ "/menu": { body: "<p>Caff&egrave; 1,20 €</p><p>Cornetto 1,50 €</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/menu","everyMinutes":30}`);
		await h.say(`/tool watch_create {"url":"${s.base}/menu","everyMinutes":30,"what":"Caff"}`);
		const replies = h.replies.length;
		// Snapshots as an older Owni stored them: no version, the entity left as written.
		for (const w of await h.store.list()) {
			const { v: _v, ...old } = w.last as WatchSnapshot;
			const oldText = "Caff&egrave; 1,20 € Cornetto 1,50 €";
			await h.store.update({ ...w, last: { ...old, hash: "old", excerpt: w.what === undefined ? oldText : "Caff&egrave; 1,20 € Cornetto", ...(w.what === undefined ? { text: oldText } : {}) } });
		}
		expect(await h.scheduler.tick(later(31))).toBe(0);
		expect(await h.scheduler.tick(later(62))).toBe(0);
		expect(h.replies.length).toBe(replies);
		for (const w of await h.store.list()) expect(w.last?.v).toBe(WATCH_TEXT_VERSION);
		// From the new baseline, a real change is still told.
		s.pages["/menu"] = { body: "<p>Caff&egrave; 1,40 €</p><p>Cornetto 1,50 €</p>" };
		expect(await h.scheduler.tick(later(93))).toBe(1);
	});

	it("a page with a rotating banner never writes", async () => {
		let n = 0;
		const s = await site({});
		const h = await setup();
		const page = () => ({ body: `<p>Offerta del momento: ${["A", "B", "C"][n++ % 3]}</p><p>Contenuto fisso</p>` });
		s.pages["/p"] = page();
		await h.say(`/tool watch_create {"url":"${s.base}/p","everyMinutes":30}`);
		for (let i = 1; i <= 6; i++) {
			s.pages["/p"] = page();
			expect(await h.scheduler.tick(later(31 * i))).toBe(0);
		}
	});

	it("a price alert says at once where the price is, then tells when it drops under", async () => {
		const s = await site({ "/scarpe": { body: "<p>Scarpe da corsa 270</p><p>Spedizione gratis da 29 €</p><p>Prezzo 59,90 €</p>" } });
		const h = await setup();
		expect(await h.say(`/tool watch_create {"url":"${s.base}/scarpe","below":50}`)).toContain("indica in what la frase");
		expect(await h.say(`/tool watch_create {"url":"${s.base}/scarpe","what":"Prezzo","below":50}`)).toContain("Prezzo letto adesso: 59,9.");
		const replies = h.replies.length;
		s.pages["/scarpe"] = { body: "<p>Scarpe da corsa 270</p><p>Prezzo 45,00 €</p>" };
		expect(await h.scheduler.tick(later(61))).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		expect(text(h.replies.at(-1) as Reply)).toContain("Il prezzo dopo «Prezzo» è sceso sotto 50: ora 45 (prima 59,9).");
		s.pages["/scarpe"] = { body: "<p>Prezzo 44,00 €</p>" };
		expect(await h.scheduler.tick(later(122))).toBe(0);
		// Sold out: said once, and it keeps checking.
		s.pages["/scarpe"] = { body: "<p>Prodotto esaurito</p>" };
		for (let i = 3; i < 3 + WATCH_LIMITS.maxFailures + 1; i++) expect(await h.scheduler.tick(later(61 * i))).toBe(i === 3 ? 1 : 0);
		expect((await h.store.list())[0]).toMatchObject({ failures: 0, nextCheckAt: expect.any(String) });
		expect((await h.store.list())[0]?.disabledReason).toBeUndefined();
	});

	it("refuses a site the owner did not allow, a phrase or price that is not there, a group and the phone", async () => {
		const s = await site({ "/p": { body: "<p>Ciao</p>" } });
		const h = await setup({ modelProviders: ["faux"], channels: ["telegram"], web: ["example.com"] });
		expect(await h.say(`/tool watch_create {"url":"${s.base}/p"}`)).toContain("il sito non è tra quelli che questo agente può leggere");
		expect(s.hits()).toBe(0);
		const open = await setup();
		expect(await open.say(`/tool watch_create {"url":"${s.base}/p","what":"Prezzo"}`)).toContain("non trovo «Prezzo» nella pagina");
		expect(await open.say(`/tool watch_create {"url":"${s.base}/p","what":"Ciao","below":10}`)).toContain("non trovo un prezzo subito dopo «Ciao»");
		expect(await h.store.list()).toEqual([]);
		expect(await open.store.list()).toEqual([]);
		const [create] = createWatchTools({ store: open.store, read: async () => ({ title: "", text: "x" }) });
		const ctx = { thread: { channel: "phone", threadId: "+393331234567" }, step: async (_: string, run: () => Promise<string>) => run() } as unknown as Parameters<NonNullable<typeof create>["execute"]>[1];
		expect(await create!.execute({ url: `${s.base}/p` }, ctx)).toContain("al telefono");
		const group = { ...ctx, thread: { channel: "telegram", threadId: "-100123" } } as typeof ctx;
		expect(await create!.execute({ url: `${s.base}/p` }, group)).toContain("chat privata");
	});

	it("each conversation lists and deletes only its own person's sentinelle", async () => {
		const s = await site({ "/p": { body: "<p>Stato: ok</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","what":"Stato"}`);
		const [w] = await h.store.list();
		const [, list, del] = createWatchTools({ store: h.store, read: h.read });
		const other = { thread: { channel: "telegram", threadId: "8" }, step: async (_: string, run: () => Promise<string>) => run() } as unknown as Parameters<NonNullable<typeof list>["execute"]>[1];
		expect(await list!.execute({}, other)).toBe("Nessuna sentinella per questa persona.");
		expect(await del!.execute({ id: w!.id }, other)).toContain("Nessuna sentinella");
		expect(await h.store.list()).toHaveLength(1);
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "watch.created", watchId: w!.id, host: expect.stringContaining("127.0.0.1") }));
	});

	it("a page that keeps failing stops after six checks, saying so once", async () => {
		const s = await site({ "/p": { body: "<p>Ok</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","everyMinutes":30}`);
		const replies = h.replies.length;
		s.pages["/p"] = { status: 500, body: "down" };
		for (let i = 1; i < WATCH_LIMITS.maxFailures; i++) expect(await h.scheduler.tick(later(31 * i))).toBe(0);
		expect((await h.store.list())[0]).toMatchObject({ failures: WATCH_LIMITS.maxFailures - 1, lastError: "la pagina risponde 500" });
		expect(await h.scheduler.tick(later(31 * WATCH_LIMITS.maxFailures))).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		expect(text(h.replies.at(-1) as Reply)).toContain("Ho fermato la sentinella");
		expect(text(h.replies.at(-1) as Reply)).toContain("si è fermata e perché");
		expect((await h.store.list())[0]).toMatchObject({ nextCheckAt: null, disabledReason: "la pagina risponde 500" });
		expect(await h.scheduler.tick(later(31 * 20))).toBe(0);
	});

	it("stops without writing when the person it acts for is no longer allowed, or its channel is closed", async () => {
		const s = await site({ "/p": { body: "<p>Stato: prima</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","what":"Stato"}`);
		await h.say(`/tool watch_create {"url":"${s.base}/p","what":"Stato","everyMinutes":30}`);
		const replies = h.replies.length;
		s.pages["/p"] = { body: "<p>Stato: dopo</p>" };
		h.control.refuse = new EgressDenied("channel", "telegram");
		expect(await h.scheduler.tick(later(31))).toBe(0);
		const byEvery = async (m: number) => (await h.store.list()).find((w) => w.everyMinutes === m);
		expect(await byEvery(30)).toMatchObject({ nextCheckAt: null, disabledReason: "il canale della conversazione non è più consentito" });
		h.control.refuse = undefined;
		await h.runtime.registry.setAllowedUsers("acme", "ops", "telegram", []);
		expect(await h.scheduler.tick(later(61))).toBe(0);
		expect(await byEvery(60)).toMatchObject({ nextCheckAt: null, disabledReason: "la persona per cui lavora non può più scrivere a Owni" });
		expect(h.replies.length).toBe(replies);
	});

	it("a message the instance does not take is tried again in a few minutes, without reading the page again", async () => {
		const s = await site({ "/p": { body: "<p>Stato: prima</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","what":"Stato"}`);
		const replies = h.replies.length;
		s.pages["/p"] = { body: "<p>Stato: dopo</p>" };
		h.control.refuse = new Error("engine busy");
		expect(await h.scheduler.tick(later(61))).toBe(0);
		expect((await h.store.list())[0]?.retryAt).toBe(later(61 + WATCH_LIMITS.retryMinutes).toISOString());
		const hits = s.hits();
		expect(await h.scheduler.tick(later(62))).toBe(0); // not due yet: no read every pass
		h.control.refuse = undefined;
		expect(await h.scheduler.tick(later(61 + WATCH_LIMITS.retryMinutes))).toBe(1);
		expect(s.hits()).toBe(hits);
		await waitFor(() => h.replies.length === replies + 1);
		expect(text(h.replies.at(-1) as Reply)).toContain("Stato: dopo");
	});

	it("a page that changes at every check stops after a day's worth of messages", async () => {
		const s = await site({ "/p": { body: "<p>Stato: 0</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","what":"Stato","everyMinutes":30}`);
		const replies = h.replies.length;
		for (let i = 1; i <= WATCH_LIMITS.maxPerDay; i++) {
			s.pages["/p"] = { body: `<p>Stato: ${"abcdefgh"[i]}</p>` };
			expect(await h.scheduler.tick(later(31 * i))).toBe(1);
		}
		await waitFor(() => h.replies.length === replies + WATCH_LIMITS.maxPerDay);
		expect(text(h.replies.at(-1) as Reply)).toContain("cambia troppo spesso");
		expect((await h.store.list())[0]).toMatchObject({ nextCheckAt: null, disabledReason: "la pagina cambia troppo spesso" });
	});

	it("a crash after writing and before saving does not write twice", async () => {
		const s = await site({ "/p": { body: "<p>Stato: prima</p>" } });
		const h = await setup();
		await h.say(`/tool watch_create {"url":"${s.base}/p","what":"Stato"}`);
		const replies = h.replies.length;
		s.pages["/p"] = { body: "<p>Stato: dopo</p>" };
		// The first pass "crashes" at its second save: the message is in, the sentinella still holds it.
		let saves = 0;
		const crashing = Object.assign(Object.create(h.store) as WatchStore, { update: async (w: Parameters<WatchStore["update"]>[0]) => (++saves === 2 ? Promise.reject(new Error("crash")) : h.store.update(w)) });
		await expect(checkWatches([{ tenantId: "acme", instanceId: "ops", store: crashing, read: h.read, submit: h.submit }], later(61), () => {})).rejects.toThrow("crash");
		expect((await h.store.list())[0]?.pending).toBeDefined();
		expect(await checkWatches([{ tenantId: "acme", instanceId: "ops", store: h.store, read: h.read, submit: h.submit }], later(62), () => {})).toBe(1);
		await waitFor(() => h.replies.length === replies + 1);
		await new Promise((r) => setTimeout(r, 300));
		expect(h.replies.length).toBe(replies + 1);
		expect((await h.store.list())[0]?.pending).toBeUndefined();
	});

	it("checks at most 20 pages per pass", async () => {
		const s = await site({ "/p": { body: "<p>Ok</p>" } });
		const h = await setup();
		for (let i = 0; i < WATCH_LIMITS.maxPerInstance; i++) await h.store.create({ url: `${s.base}/p`, channel: "telegram", threadId: "7", createdBy: { kind: "instance" } }, T0);
		const other = new WatchStore(tempDataDir());
		for (let i = 0; i < 5; i++) await other.create({ url: `${s.base}/p`, channel: "telegram", threadId: "7", createdBy: { kind: "instance" } }, T0);
		await checkWatches([{ tenantId: "acme", instanceId: "ops", store: h.store, read: h.read, submit: h.submit }, { tenantId: "acme", instanceId: "b", store: other, read: h.read, submit: h.submit }], later(1), () => {});
		expect(s.hits()).toBe(WATCH_LIMITS.perTick);
	});
});

describe("sentinelle from the console", () => {
	it("a person creates one for their chat, sees it without the page text, gets the change there, deletes it", async () => {
		const s = await site({ "/orari": { body: "<p>Orari: 9-18</p>" } });
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { webAddressAllowed: localOnly, schedulerIntervalMs: 3_600_000, log: () => {} });
		closers.push(() => owni.stop());
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		// biome-ignore lint: test
		const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
			const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as object) };
		};
		const thread = (await api("/api/instances/owni/dm", "POST", {})).thread;
		const record = await owni.runtime.registry.getInstance("default", "owni");
		await owni.runtime.registry.setEgress("default", "owni", () => ({ ...record.egress, web: ["example.com"] }));
		const refused = await api("/api/instances/owni/watches", "POST", { url: `${s.base}/orari`, threadId: thread.id });
		expect(refused.status).toBe(400);
		expect(refused.error).toContain("non è tra i siti");
		await owni.runtime.registry.setEgress("default", "owni", () => ({ ...record.egress, web: ["*"] }));
		expect((await api("/api/instances/owni/watches", "POST", { url: `${s.base}/orari`, threadId: "altro" })).status).toBe(400);
		const created = await api("/api/instances/owni/watches", "POST", { url: `${s.base}/orari`, what: "Orari", everyMinutes: 60, threadId: thread.id });
		expect(created.watch).toMatchObject({ url: `${s.base}/orari`, what: "Orari", everyMinutes: 60, channel: "web", threadId: thread.id });
		// The first pass takes the first look and says nothing.
		const t = Date.now() + 1000;
		expect(await owni.scheduler.tick(new Date(t))).toBe(0);
		const listed = (await api("/api/instances/owni/watches")).watches;
		expect(listed[0].last.excerpt).toContain("Orari: 9-18");
		expect(listed[0].last.text).toBeUndefined();
		s.pages["/orari"] = { body: "<p>Orari: chiuso per ferie</p>" };
		expect(await owni.scheduler.tick(new Date(t + 61 * 60_000))).toBe(1);
		const entries = async () => (await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		for (let i = 0; i < 200 && !(await entries()).some((e) => e.from === "owni" && e.text?.includes("chiuso per ferie")); i++) await new Promise((r) => setTimeout(r, 30));
		expect((await entries()).some((e) => e.from === "owni" && e.text?.includes("[Sentinella"))).toBe(true);
		// The first look says at once what is wrong, and reads the price people type the Italian way.
		const missing = await api("/api/instances/owni/watches", "POST", { url: `${s.base}/orari`, what: "Prezzo", threadId: thread.id });
		expect(missing.status).toBe(400);
		expect(missing.error).toMatch(/^Non trovo «Prezzo» nella pagina/);
		expect((await api("/api/instances/owni/watches", "POST", { url: `${s.base}/orari`, what: "Orari", below: "cinque", threadId: thread.id })).error).toContain("scrivi un numero");
		s.pages["/prezzo"] = { body: "<p>Prezzo 59,90 €</p>" };
		const priced = await api("/api/instances/owni/watches", "POST", { url: `${s.base}/prezzo`, what: "Prezzo", below: "49,90", threadId: thread.id });
		expect(priced.watch).toMatchObject({ below: 49.9, last: { price: 59.9 } });
		const resumed = await api(`/api/instances/owni/watches/${priced.watch.id}/resume`, "POST");
		expect(resumed.watch).toMatchObject({ failures: 0 });
		expect((await api(`/api/instances/owni/watches/${priced.watch.id}`, "DELETE")).removed).toBe(true);
		expect((await api(`/api/instances/owni/watches/${created.watch.id}`, "DELETE")).removed).toBe(true);
		expect((await api("/api/instances/owni/watches")).watches).toEqual([]);
		expect((await api(`/api/instances/owni/watches/${created.watch.id}`, "DELETE")).status).toBe(404);
	});
});
