import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { GOOGLE_SCOPE, GOOGLE_WRITE_SCOPE } from "../src/connectors/google.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { readOnlyInBriefs } from "../src/core/brief.ts";
import { decideGoogleAction, GoogleActionStore, googleActionReport } from "../src/core/google-actions.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { invoiceCallReads } from "../src/core/invoices.ts";
import { auditFile, instanceDir, workspaceDir } from "../src/core/paths.ts";
import { REMINDER_LIMITS } from "../src/core/reminder-book.ts";
import type { OwniRuntime } from "../src/core/runtime.ts";
import type { MailProposal as ReminderProposal } from "../src/core/mail-requests.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { B70, BETA, COMUNE, cleanTemp, ctx, DELTA, FILES, fakeMail, fattura, G1, GAMMA, GNC, IBAN, IBAN_2, IBAN_SAVED, inside, NOW, outside, setup, TUESDAY, temp } from "./solleciti-fixtures.ts";
import { loadTools } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	cleanTemp();
});

const B71 = "IT00000520031|b-71|2026-09-10|TD01";

describe("solleciti: sending only through the approval card", () => {
	it("send asks one card per customer, carries each draft's notes, records nothing; the audit has the op and a count", async () => {
		const { mail, proposals } = fakeMail();
		const { run, store, events } = setup(FILES, { mail, now: TUESDAY });
		const answer = await run({ op: "reminder", send: true });
		expect(outside(answer)).toContain("Ho preparato 2 richieste di invio: la persona le vede nelle card qui in chat");
		expect(outside(answer)).toContain("Parte solo ciò che approva");
		expect(outside(answer)).toContain("Per un sollecito manca l'indirizzo");
		expect(proposals.map((p) => p.to)).toEqual(["amministrazione@gamma.example", "delta@pec.example"]);
		const data = inside(answer);
		expect(data).toContain("• Gamma Hotel S.p.A., livello 1, indirizzo: amministrazione@gamma.example (richiesta req000000001)");
		expect(data).toContain("  Nota: l'indirizzo viene da un campo della fattura che il formato non prevede");
		expect(data).toContain("  Nota: è la PEC di recapito SdI");
		const gamma = proposals[0] as ReminderProposal;
		expect(gamma.subject).toBe("Beta Ristorazione Srl: promemoria di pagamento fatture n. B-70, B-71");
		expect(gamma.body).toContain("Totale da saldare: 1.370,00 €");
		expect(gamma.reminders?.map((r) => r.level)).toEqual([1, 1]);
		expect(gamma.key).toMatch(/^sol:/);
		expect(gamma.thread).toEqual({ channel: "web", threadId: "t1" });
		expect(store.read().reminders).toBeUndefined();
		expect(events).toEqual([{ type: "invoice.reminder", op: "queue", count: 2 }]);
		// Several customers by a word that fits more than one: nothing asked.
		const homonyms = setup({ ...FILES, "f/d1.xml": fattura(BETA, { ...DELTA, name: "Gamma Carni Srl" }, { number: "B-80", date: "2026-09-17", total: "300.00", rate: [{ amount: "300.00", due: "2026-10-17" }] }) }, { mail, now: TUESDAY });
		expect(await homonyms.run({ op: "reminder", party: "gamma", send: true })).toContain("corrisponde a più clienti: non preparo l'invio");
		expect(proposals).toHaveLength(2);
		// The address the person gives: used, and saved.
		const given = await run({ op: "reminder", party: "rossi", send: true, email: "Mario.Rossi@Example.com" });
		expect(given).toMatch(/^Indirizzo salvato/);
		expect(proposals[2]?.to).toBe("mario.rossi@example.com");
		expect(proposals[2]?.body).toContain("Gentile Mario Rossi,");
	});

	it("H4: not sent again to a customer reminded today or with a card pending, nor a second formal one unless asked; the reason said", async () => {
		const today = setup(FILES, { mail: fakeMail().mail });
		await today.run({ op: "reminder_sent", party: "gamma" });
		const skipped = await today.run({ op: "reminder", party: "gamma", send: true });
		expect(outside(skipped)).toContain("Nessuna richiesta preparata.");
		expect(inside(skipped)).toContain("• Gamma Hotel S.p.A. (livello 2): non preparato, già sollecitato oggi.");

		const { mail, proposals } = fakeMail(undefined, { pending: new Set([B70]) });
		const waiting = setup(FILES, { mail });
		expect(inside(await waiting.run({ op: "reminder", party: "gamma", send: true }))).toContain("non preparato, c'è già una richiesta di invio in attesa di decisione.");
		expect(proposals).toEqual([]);

		const formal = fakeMail();
		const after = setup(FILES, { mail: formal.mail });
		after.store.remind([{ invoice: B70, level: 3 }], { by: "p", at: "2026-10-12T08:00:00Z", via: "self" });
		// Only the invoice already at the formal level waits; the new one of the same customer goes.
		expect(inside(await after.run({ op: "reminder", party: "gamma", send: true }))).toContain("• Gamma Hotel S.p.A. (livello 3): non preparato, il sollecito formale per queste fatture è già stato mandato: per rimandarlo serve che chi ti scrive lo chieda, con level 3.");
		expect(formal.proposals.map((p) => p.reminders?.map((r) => [r.invoice, r.level]))).toEqual([[[B71, 1]]]);
		const again = fakeMail();
		const explicit = setup(FILES, { mail: again.mail });
		explicit.store.remind([{ invoice: B70, level: 3 }], { by: "p", at: "2026-10-12T08:00:00Z", via: "self" });
		await explicit.run({ op: "reminder", party: "gamma", send: true, level: 3 });
		expect(again.proposals.map((p) => p.reminders?.map((r) => r.level))).toEqual([[3, 3]]);
	});

	it("M5: when the queue is full, the requests made are kept and counted, the others said", async () => {
		const { mail, proposals } = fakeMail(undefined, { capacity: 1 });
		const { run, events } = setup(FILES, { mail, now: TUESDAY });
		const answer = await run({ op: "reminder", send: true });
		expect(proposals).toHaveLength(1);
		expect(outside(answer)).toContain("Ho preparato una richiesta di invio");
		expect(outside(answer)).toContain("Per gli altri 1 ci sono troppe richieste in attesa: falle decidere e riprova.");
		expect(events).toEqual([{ type: "invoice.reminder", op: "queue", count: 1 }]);
		const none = setup(FILES, { mail: fakeMail(undefined, { capacity: 0 }).mail });
		expect(await none.run({ op: "reminder", party: "gamma", send: true })).toContain("Per questo cliente ci sono troppe richieste in attesa");
	});

	it("without a mail account that can write, the letters to copy, nothing sent nor recorded", async () => {
		for (const o of [{}, { mail: fakeMail("chi scrive non ha collegato Google").mail }]) {
			const { run, store, events } = setup(FILES, o);
			const answer = await run({ op: "reminder", party: "gamma", send: true });
			expect(outside(answer)).toMatch(/^Non posso inviare mail da qui \((nessun account di posta è collegato|chi scrive non ha collegato Google)\): niente è stato inviato né annotato/);
			expect(inside(answer)).toContain("Spett.le Gamma Hotel S.p.A.,");
			expect(store.read().reminders).toBeUndefined();
			expect(events).toEqual([]);
		}
	});

	it("drafting reads (also in the brief); sending and recording write, and the brief refuses them", async () => {
		expect(invoiceCallReads({ op: "reminder" })).toBe(true);
		expect(invoiceCallReads({ op: "reminder", send: false })).toBe(true);
		expect(invoiceCallReads({ op: "reminder", send: true })).toBe(false);
		expect(invoiceCallReads({ op: "reminder_sent" })).toBe(false);
		const { mail, proposals } = fakeMail();
		const { tool, store } = setup(FILES, { mail });
		const [guarded] = readOnlyInBriefs([tool], async () => true);
		expect(String(await guarded?.execute({ op: "reminder", party: "gamma" }, ctx))).toContain("Bozza");
		expect(String(await guarded?.execute({ op: "reminder", party: "gamma", send: true }, ctx))).toContain("legge soltanto");
		expect(String(await guarded?.execute({ op: "reminder_sent", party: "gamma" }, ctx))).toContain("legge soltanto");
		expect(proposals).toEqual([]);
		expect(store.read().reminders).toBeUndefined();
	});

	it("another agent's request reads but never sends, records nor marks paid", async () => {
		const { mail, proposals } = fakeMail();
		const { run, store } = setup(FILES, { mail });
		const agent = { ...ctx, thread: { channel: AGENT_CHANNEL, threadId: "a1" } };
		const refusal = "Errore: in una richiesta di un altro agente non cambio lo scadenzario e non mando solleciti";
		expect(await run({ op: "reminder", party: "gamma", send: true }, agent)).toMatch(new RegExp(`^${refusal}`));
		expect(await run({ op: "reminder_sent", party: "gamma" }, agent)).toMatch(new RegExp(`^${refusal}`));
		expect(await run({ op: "mark_paid", number: "B-70" }, agent)).toMatch(new RegExp(`^${refusal}`));
		expect(await run({ op: "reminder", party: "gamma" }, agent)).toContain("Bozza");
		expect(proposals).toEqual([]);
		expect(store.read().reminders).toBeUndefined();
		expect(store.read().paid).toEqual([]);
	});
});

describe("solleciti: recorded only when the person says so", () => {
	it("reminder_sent: once a day for the same level, refuses letter arguments, the level from those recorded", async () => {
		const { run, store, events } = setup();
		expect(await run({ op: "reminder_sent", party: "gamma", send: true })).toBe("Errore: reminder_sent annota soltanto un sollecito già mandato da chi ti scrive: send non servono qui.");
		expect(await run({ op: "reminder_sent", party: "gamma", email: "a@b.example", note: "x" })).toContain("email, note non servono qui");
		expect(await run({ op: "reminder_sent" })).toContain("indica a chi è andato il sollecito");
		const first = await run({ op: "reminder_sent", party: "gamma" });
		expect(first).toContain("sollecito di livello 1 mandato da chi ti scrive, per 2 fatture");
		const twice = await run({ op: "reminder_sent", party: "gamma" });
		expect(twice).toMatch(/^Era già annotato oggi un sollecito di livello 1: non lo annoto due volte\./);
		expect(store.read().reminders?.map((e) => e.sent.length)).toEqual([1, 1]);
		expect(events).toEqual([{ type: "invoice.reminder", op: "self", count: 2 }]);
		// The next day it is the second reminder.
		const next = setup(FILES, { now: TUESDAY });
		next.store.remind([{ invoice: B70, level: 1 }], { by: "p", at: NOW.toISOString(), via: "self" });
		expect(await next.run({ op: "reminder_sent", number: "B-70" })).toContain("sollecito di livello 2");
		// And the draft says one was recorded today, naming the invoice.
		expect(inside(await run({ op: "reminder", party: "gamma", level: 1 }))).toContain("Nota: un sollecito per la fattura n. B-70 è già annotato oggi.");
	});

	it("recorded when the approved mail is sent: not on a rejection, a failure or an expiry; once per request; then due shows it", async () => {
		const { run, store, dir } = setup();
		const actions = new GoogleActionStore(join(dir, "google-actions"));
		const audit: Record<string, unknown>[] = [];
		const notices: string[] = [];
		const runtime = {
			audit: () => ({ append: async (e: Record<string, unknown>) => void audit.push(e) }),
			googleActions: () => actions,
			invoices: () => store,
			submitNotice: async (_t: string, _i: string, n: { text: string }) => void notices.push(n.text),
		} as unknown as OwniRuntime;
		const items = [{ invoice: B70, level: 1 as const }];
		const ask = (key: string) =>
			actions.propose({ kind: "mail.send", personId: "p1", account: "anna@example.com", reason: "Sollecito", mail: { to: ["a@gamma.example"], cc: [], subject: "s", body: "b" }, thread: { channel: "web", threadId: "t1" }, reminders: items }, new Date(), key);
		const rejected = await ask("k1");
		await decideGoogleAction(runtime, "t", "i", rejected.id, "rejected", "p1", async () => ({ done: "x" }), () => {});
		const failed = await ask("k2");
		await decideGoogleAction(runtime, "t", "i", failed.id, "approved", "p1", async () => {
			throw new Error("Google ha rifiutato");
		}, () => {});
		expect(store.read().reminders).toBeUndefined();
		const sent = await ask("k3");
		expect(store.read().reminders).toBeUndefined();
		await decideGoogleAction(runtime, "t", "i", sent.id, "approved", "p1", async () => ({ done: "inviata" }), () => {});
		const recorded = store.read().reminders;
		expect(recorded).toHaveLength(1);
		expect(recorded?.[0]?.sent).toMatchObject([{ level: 1, via: "mail", action: sent.id, by: "p1" }]);
		expect(store.remind(items, { by: "p1", at: NOW.toISOString(), via: "mail", action: sent.id })).toBe(0);
		expect(audit.filter((e) => e.type === "invoice.reminder")).toEqual([{ type: "invoice.reminder", instanceId: "i", op: "mail", count: 1 }]);
		expect(notices.at(-1)).toContain("Il sollecito è annotato nello scadenzario.");
		const done = (await actions.get(sent.id)) ?? sent;
		expect(googleActionReport(done, { recorded: 0, failed: true })).toContain("non è stato annotato nello scadenzario: se serve, annotalo con invoices op reminder_sent");
		expect(googleActionReport(done)).not.toContain("annotato");
		expect(googleActionReport({ ...sent, status: "rejected" }, { recorded: 1, failed: false })).not.toContain("è annotato");
		const due = inside(await run({ op: "due", side: "incassare", range: "scadute" }));
		expect(due).toMatch(/B-70; sollecitata il \d\d\/10/);
		await run({ op: "reminder_sent", number: "B-70", level: 2 });
		expect(inside(await run({ op: "by_party", party: "gamma" }))).toMatch(/B-70; sollecitata 2 volte, l'ultima il 18\/10/);
	});
});

describe("solleciti: second pass", () => {
	it("M3: said sent the same day an approved mail was recorded: nothing added, and said so", async () => {
		const { run, store } = setup();
		store.remind([{ invoice: B70, level: 1 }, { invoice: B71, level: 1 }], { by: "p1", at: NOW.toISOString(), via: "mail", action: "req000000001" });
		expect(await run({ op: "reminder_sent", party: "gamma" })).toMatch(/^Era già annotato oggi \(inviato dalla console\): non lo annoto due volte\./);
		expect(await run({ op: "reminder_sent", party: "gamma", level: 1 })).toMatch(/^Era già annotato oggi \(inviato dalla console\)/);
		expect(store.read().reminders?.map((e) => e.sent.length)).toEqual([1, 1]);
	});

	it("M2: one invoice named while others are late: its gross amount, the credit notes said apart; all of it: taken off", async () => {
		const partial = inside(await setup().run({ op: "reminder", number: "B-70" }));
		expect(partial).toContain("Totale da saldare: 1.220,00 €.");
		expect(partial).toContain("Nota: il cliente ha note di credito per 100,00 € da regolare: non le ho scalate, perché questo sollecito non copre tutto il suo scaduto.");
		const whole = inside(await setup({ "f/g1.xml": G1, "f/gnc.xml": GNC }).run({ op: "reminder", number: "B-70" }));
		expect(whole).toContain("Totale da saldare: 1.120,00 € (1.220,00 € meno la nota di credito n. NC-3 del 05/10/2026, 100,00 €).");
	});

	it("M4: a sent reminder carries only a saved IBAN; a draft takes the files' only from unpaid invoices of the last two years", async () => {
		const { mail, proposals } = fakeMail();
		const { run } = setup(FILES, { mail });
		const answer = await run({ op: "reminder", party: "gamma", send: true });
		expect(proposals[0]?.body).not.toContain("bonifico");
		expect(inside(answer)).toContain("Nota: per mettere l'IBAN nei solleciti inviati, salvalo con set_company.");
		await run({ op: "set_company", iban: IBAN_SAVED });
		await run({ op: "reminder", party: "gamma", send: true, level: 2 });
		expect(proposals[1]?.body).toContain(`all'IBAN ${IBAN_SAVED}.`);
		const old = fattura(BETA, DELTA, { number: "V-1", date: "2024-09-01", total: "10.00", rate: [{ amount: "10.00", due: "2024-09-30", iban: IBAN_2 }] });
		const paid = fattura(BETA, DELTA, { number: "V-2", date: "2026-09-01", total: "10.00", rate: [{ amount: "10.00", due: "2026-09-30", iban: IBAN_2 }] });
		const drafts = setup({ "f/g1.xml": G1, "f/old.xml": old, "f/paid.xml": paid });
		await drafts.run({ op: "mark_paid", number: "V-2" });
		expect(inside(await drafts.run({ op: "reminder", party: "gamma" }))).toContain(`all'IBAN ${IBAN}.`);
	});

	it("L2: a company saved by partita IVA only: no name from the files in subject or signature, a hint to save it", async () => {
		const draft = inside(await setup(FILES, { company: "vat" }).run({ op: "reminder", party: "gamma" }));
		expect(draft).toContain("Oggetto: Promemoria di pagamento fatture n. B-70, B-71");
		expect(draft).toMatch(/Cordiali saluti\nP\.IVA IT00000520031/);
		expect(draft).not.toContain("Beta Ristorazione");
		expect(draft).toContain("Nota: salva il nome dell'azienda con set_company (name): così compare nell'oggetto e nella firma.");
	});

	it("L5: the company is changed under one lock and never saved in a shape that does not read back", async () => {
		const { run, store } = setup(FILES, { company: false });
		expect(await run({ op: "set_company", iban: IBAN })).toMatch(/^Errore: prima serve l'azienda/);
		expect(store.read().company).toBeUndefined();
		expect(() => store.setCompany({ vat: "IT00000520031", signature: "a\nb\nc\nd\ne", by: "u", at: NOW.toISOString() })).toThrow(/non sono validi/);
		await run({ op: "set_company", vat: "00000520031" });
		await run({ op: "set_company", signature: "Anna" });
		await run({ op: "set_company", iban: IBAN });
		expect(store.read().company).toMatchObject({ vat: "IT00000520031", ibans: [IBAN], signature: "Anna" });
	});

	it("L6: split payment without instalments, credit notes with a negative total too: netted, and said", async () => {
		const pa = { format: "FPA12" as const, code: "UFE123" };
		for (const vat of ["-22.00", "22.00"]) {
			const files = {
				"f/p.xml": fattura(BETA, COMUNE, { number: "P-2", date: "2026-10-01", total: "244.00", split: { taxable: "200.00", vat: "44.00" } }, pa),
				"f/nc.xml": fattura(BETA, COMUNE, { number: "PNC-1", date: "2026-10-05", total: "-122.00", type: "TD04", split: { taxable: "-100.00", vat } }, pa),
			};
			const { run } = setup(files);
			const list = inside(await run({ op: "list", party: "comune" }));
			expect(list).toContain("200,00 € (senza IVA, split payment)");
			expect(list).toContain("100,00 € (senza IVA, split payment)");
			expect(inside(await run({ op: "due", side: "incassare" }))).toContain("200,00 € (senza IVA, split payment)");
			expect(inside(await run({ op: "reminder", number: "P-2" }))).toContain("Totale da saldare: 100,00 € (200,00 € meno la nota di credito n. PNC-1 del 05/10/2026, 100,00 €).");
		}
	});

	it("L3, L8: the report fences the recipients; it says «già annotato» when nothing new was recorded, «non annotato» only on a failure", async () => {
		const { dir } = setup();
		const actions = new GoogleActionStore(join(dir, "google-actions"));
		const sent = await actions.propose({ kind: "mail.send", personId: "p1", account: "anna@example.com", reason: "Sollecito", mail: { to: ["evil@x.example"], cc: [], subject: "s", body: "b" }, thread: { channel: "web", threadId: "t1" }, reminders: [{ invoice: B70, level: 1 }] }, new Date(), "k");
		const done = { ...sent, status: "done" as const, result: { done: "inviata" } };
		const report = googleActionReport(done, { recorded: 0, failed: false });
		expect(report).toContain("Il sollecito era già annotato nello scadenzario.");
		expect(report).not.toContain("non è stato annotato");
		expect(report).toMatch(/^\[Esito della richiesta [0-9a-z]+: inviare una mail\]/);
		expect(outside(report.replace(/<<<destinatari ([0-9a-f]{12}):[^\n]*>>>\n[\s\S]*?\n<<<fine destinatari \1>>>/g, ""))).not.toContain("evil");
		expect(report).toContain("destinatari: evil@x.example");
	});
});

describe("solleciti: the store", () => {
	it("limits refuse instead of dropping; a copy is kept; duplicates and bad instants do not read", async () => {
		const { store, dir } = setup();
		const items = (n: number) => Array.from({ length: n }, (_, i) => ({ invoice: `k${i}`, level: 1 as const }));
		const made = { by: "p", at: NOW.toISOString(), via: "self" as const };
		expect(store.remind(items(3), made)).toBe(3);
		expect(readFileSync(join(dir, "invoices.json.bak"), "utf8")).toContain('"k2"');
		for (let i = 1; i < REMINDER_LIMITS.perInvoice; i++) store.remind([{ invoice: "k0", level: 2 }], made);
		expect(() => store.remind([{ invoice: "k0", level: 3 }], made)).toThrow(/già 20 solleciti/);
		store.remind(Array.from({ length: REMINDER_LIMITS.invoices - 3 }, (_, i) => ({ invoice: `m${i}`, level: 1 as const })), made);
		expect(() => store.remind([{ invoice: "nuova", level: 1 }], made)).toThrow(/5000 fatture/);
		expect(store.read().reminders).toHaveLength(REMINDER_LIMITS.invoices);
		const mark = { level: 1, via: "self", by: "p", at: NOW.toISOString() };
		for (const reminders of [
			[{ invoice: "x", sent: [mark] }, { invoice: "x", sent: [mark] }],
			[{ invoice: "x", sent: [{ ...mark, at: "ieri" }] }],
			[{ invoice: "x", sent: [{ ...mark, by: "b".repeat(201) }] }],
			[{ invoice: "x", sent: [] }],
		]) {
			writeFileSync(join(dir, "invoices.json"), JSON.stringify({ paid: [], reminders }));
			expect(store.read()).toMatchObject({ broken: false, remindersBroken: true });
		}
	});

	it("a bad reminder never breaks due: paid marks still count; reminders are refused, not overwritten; mark_paid keeps them", async () => {
		const { run, store, dir, events } = setup();
		await run({ op: "mark_paid", number: "B-71" });
		const file = join(dir, "invoices.json");
		const book = JSON.parse(readFileSync(file, "utf8"));
		book.reminders = [{ invoice: B70, sent: [{ level: 1, via: "self", by: "p", at: "non una data" }] }];
		writeFileSync(file, JSON.stringify(book));
		expect(store.read()).toMatchObject({ broken: false, remindersBroken: true });
		const due = await run({ op: "due", side: "incassare", range: "scadute" });
		expect(inside(due)).toContain("B-70");
		expect(inside(due)).not.toContain("B-71");
		expect(due).not.toContain("sollecitata");
		expect(await run({ op: "reminder", party: "gamma" })).toMatch(/^Errore: .*Finché non si leggono non preparo né annoto solleciti/);
		expect(await run({ op: "reminder_sent", number: "B-70" })).toMatch(/^Errore: .*non preparo né annoto solleciti/);
		await run({ op: "mark_paid", number: "B-80" });
		expect(JSON.parse(readFileSync(file, "utf8")).reminders).toEqual(book.reminders);
		expect(events.filter((e) => e.type === "invoice.reminder")).toEqual([]);
	});

	it("a broken file is never overwritten", async () => {
		const { run, store, dir, events } = setup();
		await run({ op: "reminder_sent", party: "gamma" });
		const broken = '{"paid":"no"}';
		writeFileSync(join(dir, "invoices.json"), broken);
		expect(store.read().broken).toBe(true);
		expect(await run({ op: "reminder_sent", number: "B-71" })).toMatch(/^Errore: lo stato delle fatture pagate \(invoices\.json\) non si legge/);
		expect(await run({ op: "reminder", party: "gamma" })).toContain("non preparo solleciti, perché non so cosa è pagato");
		expect(readFileSync(join(dir, "invoices.json"), "utf8")).toBe(broken);
		expect(events.filter((e) => e.type === "invoice.reminder")).toEqual([{ type: "invoice.reminder", op: "self", count: 2 }]);
	});

	it("L1: marking paid keeps the reminders; those of invoices paid in full over a year ago go at the next write", async () => {
		const { run, store } = setup();
		await run({ op: "reminder_sent", party: "gamma" });
		await run({ op: "mark_paid", number: "B-70" });
		expect(store.read().reminders?.map((e) => e.invoice)).toEqual([B70, B71]);
		// B-70 paid in September 2025: more than a year before the next write, its reminders go; B-71's stay.
		const old = setup();
		old.store.remind([{ invoice: B70, level: 1 }], { by: "p", at: "2025-08-01T08:00:00Z", via: "self" });
		old.store.mark({ invoice: B70, count: 1, paid: true, by: "p", at: "2025-09-01T08:00:00Z" });
		expect(old.store.read().reminders?.map((e) => e.invoice)).toEqual([B70]);
		old.store.remind([{ invoice: B71, level: 1 }], { by: "p", at: NOW.toISOString(), via: "self" });
		expect(old.store.read().reminders?.map((e) => e.invoice)).toEqual([B71]);
	});

	it("H1: a long invoice number, a long customer name and a long who are written so they read back", async () => {
		const long = "N".repeat(321);
		const files = { "f/l.xml": fattura(BETA, GAMMA, { number: long, date: "2026-09-01", total: "10.00", rate: [{ amount: "10.00", due: "2026-09-30" }] }) };
		const { mail, proposals } = fakeMail();
		const { run, store, dir } = setup(files, { mail, who: `web:${"w".repeat(500)}` });
		await run({ op: "reminder", party: "gamma", send: true });
		const items = proposals[0]?.reminders ?? [];
		expect(items[0]?.invoice).toMatch(/^[0-9a-f]{64}$/);
		expect(await run({ op: "reminder_sent", party: "gamma" })).toContain("sollecito di livello 1");
		const book = store.read();
		expect(book).toMatchObject({ broken: false });
		expect(book.remindersBroken).toBeUndefined();
		expect(book.reminders?.[0]?.invoice).toBe(items[0]?.invoice);
		expect(book.reminders?.[0]?.sent[0]?.by.length).toBeLessThanOrEqual(REMINDER_LIMITS.by);
		expect(inside(await run({ op: "due", side: "incassare", range: "scadute" }))).toContain("sollecitata il 18/10");
		// Through an approved mail: the request carries the same short key, recorded as it is.
		const actions = new GoogleActionStore(join(dir, "google-actions"));
		const runtime = { audit: () => ({ append: async () => {} }), googleActions: () => actions, invoices: () => store, submitNotice: async () => {} } as unknown as OwniRuntime;
		const person = "p".repeat(400);
		const sent = await actions.propose({ kind: "mail.send", personId: person, account: "anna@example.com", reason: "Sollecito", mail: { to: ["a@gamma.example"], cc: [], subject: "s", body: "b" }, thread: { channel: "web", threadId: "t1" }, reminders: items }, new Date(), "k");
		await decideGoogleAction(runtime, "t", "i", sent.id, "approved", person, async () => ({ done: "inviata" }), () => {});
		expect(store.read().remindersBroken).toBeUndefined();
		expect(store.read().reminders?.[0]?.sent.map((m) => [m.level, m.via])).toEqual([
			[1, "self"],
			[1, "mail"],
		]);
		// A customer known only by a long name: the address is saved under a short key, and used.
		const nameless = { "f/n.xml": fattura(BETA, { name: `Cliente ${"x".repeat(400)}` }, { number: "Z-1", date: "2026-09-01", total: "10.00", rate: [{ amount: "10.00", due: "2026-09-30" }] }) };
		const named = setup(nameless);
		await named.run({ op: "reminder", party: "cliente", email: "c@x.example" });
		expect(named.store.read()).toMatchObject({ broken: false, contacts: [{ email: "c@x.example" }] });
		expect(named.store.read().contacts?.[0]?.key).toMatch(/^[0-9a-f]{64}$/);
		expect(inside(await named.run({ op: "reminder", party: "cliente" }))).toContain("A: c@x.example (salvato)");
	});

	it("audit entries carry the op and counts only: no names, numbers, amounts, addresses or text", async () => {
		const { mail } = fakeMail();
		const { run, events } = setup(FILES, { mail });
		await run({ op: "reminder", party: "gamma", send: true, email: "pagamenti@gamma.example" });
		await run({ op: "reminder_sent", party: "rossi" });
		expect(events).toEqual([
			{ type: "invoice.contact", op: "save", count: 1 },
			{ type: "invoice.reminder", op: "queue", count: 1 },
			{ type: "invoice.reminder", op: "self", count: 1 },
		]);
	});
});

/** A fake Google that takes a mail: just enough of it. */
function fakeGoogle() {
	const sends: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body === undefined ? "" : String(init.body);
		if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
			const form = new URLSearchParams(body);
			if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "at", refresh_token: "rt", scope: `openid email ${GOOGLE_SCOPE.gmail} ${GOOGLE_SCOPE.calendar} ${GOOGLE_WRITE_SCOPE.gmail} ${GOOGLE_WRITE_SCOPE.calendar}`, expires_in: 3600 });
			return Response.json({ access_token: "at2", expires_in: 3600 });
		}
		if (url.hostname === "openidconnect.googleapis.com") return Response.json({ email: "anna@example.com" });
		if (url.pathname === "/gmail/v1/users/me/messages/send") {
			sends.push(Buffer.from(JSON.parse(body).raw as string, "base64url").toString("utf8"));
			return Response.json({ id: "sent1", threadId: "t1" });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, sends };
}

describe("solleciti in the app", () => {
	it("from the chat to the card: sent only after the approval, then recorded; the instructions point to it; the audit has no data", async () => {
		expect(setup(FILES).tool.description).toContain("reminder: a payment reminder (sollecito) to customers late on invoices to collect");
		const dataDir = temp();
		const google = fakeGoogle();
		const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", OWNI_GOOGLE_CLIENT_ID: "c", OWNI_GOOGLE_CLIENT_SECRET: "s", OWNI_GOOGLE_WRITE: "1" });
		const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { googleFetch: google.fetch, schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => owni.stop());
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown, method?: string) => {
			const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			// biome-ignore lint: test
			return (await res.json()) as any;
		};
		const { url } = await api("/api/google/start", {});
		await api("/api/google/finish", { state: new URL(url).searchParams.get("state"), code: "good" });
		await api(`/api/instances/${config.instanceId}/google`, { allowed: true }, "PUT");
		const workspace = workspaceDir(dataDir, tenantId(config.tenantId), instanceId(config.instanceId));
		mkdirSync(join(workspace, "fatture"), { recursive: true });
		writeFileSync(join(workspace, "fatture", "g1.xml"), G1);
		const thread = (await api(`/api/instances/${config.instanceId}/dm`, {})).thread as { id: string };
		const reply = async (text: string): Promise<string> => {
			const answers = async () => ((await api(`/api/instances/${config.instanceId}/threads/${thread.id}`)).entries as { from: string; text?: string }[]).filter((e) => e.from === "owni");
			const before = (await answers()).length;
			await api(`/api/instances/${config.instanceId}/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 30_000; ) {
				const now = await answers();
				if (now.length > before) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		await loadTools(reply, "invoices");
		await reply('/tool invoices {"op":"set_company","vat":"00000520031"}');
		const asked = await reply('/tool invoices {"op":"reminder","party":"gamma","send":true}');
		expect(asked).toContain("Ho preparato una richiesta di invio");
		expect(google.sends).toEqual([]);
		const { actions } = await api(`/api/instances/${config.instanceId}/google-actions`);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ kind: "mail.send", status: "pending", mail: { to: ["amministrazione@gamma.example"] } });
		const invoices = join(instanceDir(dataDir, tenantId(config.tenantId), instanceId(config.instanceId)), "invoices.json");
		expect(readFileSync(invoices, "utf8")).not.toContain("reminders");
		// A card pending: asking again prepares nothing.
		expect(await reply('/tool invoices {"op":"reminder","party":"gamma","send":true}')).toContain("Nessuna richiesta preparata.");
		const decided = await api(`/api/instances/${config.instanceId}/google-actions/${actions[0].id}/decision`, { decision: "approved" });
		expect(decided.action.status).toBe("done");
		expect(google.sends).toHaveLength(1);
		expect(google.sends[0]).toContain("To: amministrazione@gamma.example\r\n");
		expect(Buffer.from((google.sends[0] as string).split("\r\n\r\n")[1] as string, "base64").toString("utf8")).toContain("fattura n. B-70 del 01/09/2026");
		const book = JSON.parse(readFileSync(invoices, "utf8"));
		expect(book.reminders).toHaveLength(1);
		expect(book.reminders[0].sent[0]).toMatchObject({ level: 1, via: "mail", action: actions[0].id });
		const audit = readFileSync(auditFile(dataDir, tenantId(config.tenantId)), "utf8");
		const reminders = audit
			.split("\n")
			.filter((l) => l.includes("invoice.reminder"))
			.map((l) => JSON.parse(l));
		expect(reminders.map((e) => [e.type, e.op, e.count])).toEqual([
			["invoice.reminder", "queue", 1],
			["invoice.reminder", "mail", 1],
		]);
		for (const secret of ["Gamma", "B-70", "1.220,00", "gamma.example", "promemoria"]) expect(audit).not.toContain(secret);
	}, 60_000);
});
