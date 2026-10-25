import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { GOOGLE_SCOPE, GOOGLE_WRITE_SCOPE } from "../src/connectors/google.ts";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { readOnlyInBriefs } from "../src/core/brief.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { GoogleActionError } from "../src/core/google-actions.ts";
import type { MailProposal, MailRequests } from "../src/core/mail-requests.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import { todayIn } from "../src/core/italian-calendar.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import { auditFile, workspaceDir } from "../src/core/paths.ts";
import { quoteMailProblem } from "../src/core/quote-mail.ts";
import { QuoteStore } from "../src/core/quote-store.ts";
import { createQuoteTools, type QuoteEvent } from "../src/core/tools/quote-tools.ts";
import { Workspace } from "../src/core/workspace.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { B70, BETA, cleanTemp, FILES, fakeMail, fattura, G1, G2, GAMMA, inside, outside, type Party, setup, TUESDAY } from "./solleciti-fixtures.ts";
import { loadTools } from "./helpers.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanTemp();
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-mail-flows-"));
	dirs.push(dir);
	return dir;
}

const NOW = new Date("2026-10-18T08:00:00Z");
const COMPANY: Company = { name: "Beta Ristorazione Srl", vat: "IT00000520031", address: "Via Roma 1, Milano", email: "info@beta.example", signature: "Anna Bianchi\nBeta Ristorazione Srl", by: "test:u", at: NOW.toISOString() };
const PDF_HEAD = "%PDF-1.7\n";
/** A document that reads as a PDF, its text after the header: no worker needed. */
const pdfMake = async (input: MakeInput) => ({ data: new Uint8Array(Buffer.from(`${PDF_HEAD}${input.text}`)), pages: 1, notes: [] });
let calls = 0;
const fresh = (thread: { channel: string; threadId: string } = { channel: "web", threadId: "t1" }): ToolContext => ({ step: (_k, work) => work(), progress: () => {}, origin: "person", signal: new AbortController().signal, callId: `qs${++calls}`, thread });

function quoteMail(unavailable?: string, o: { capacity?: number; pending?: ReadonlySet<string> } = {}) {
	const proposals: MailProposal[] = [];
	const mail: MailRequests = {
		check: async () => unavailable,
		pending: async () => ({ invoices: new Set(), quotes: o.pending ?? new Set() }),
		propose: async (p) => {
			if (proposals.length >= (o.capacity ?? 20)) throw new GoogleActionError("troppe richieste in attesa");
			proposals.push(p);
			return { id: `req${proposals.length}` };
		},
	};
	return { proposals, mail };
}

function quotes(mail?: MailRequests, clock: { now: Date } = { now: NOW }) {
	const dir = temp();
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const store = new QuoteStore(dir);
	const workspace = new Workspace(join(dir, "workspace"));
	const events: QuoteEvent[] = [];
	const [tool] = createQuoteTools({ workspace, store, company: invoices, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make: pdfMake, ...(mail === undefined ? {} : { mail }) });
	if (tool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, ctx = fresh()) => String(await tool.execute(args, ctx));
	return { tool, run, store, workspace, events, dir };
}

const CREATE = { op: "create", customer: "Rossi Srl", items: [{ description: "Consulenza", quantity: 2, unit: "giornate", price: 500 }], vat: 22 };

/** What the person is told to read aloud: the sentences between «». */
const quoted = (text: string) => [...text.matchAll(/«([^»]*)»/g)].map((m) => m[1] as string);

describe("quotes op send", () => {
	it("asks one card with the quote's PDF attached and a short letter; the address given goes with the request, saved only once sent", async () => {
		const { mail, proposals } = quoteMail();
		const { run, store, events, workspace } = quotes(mail);
		expect(await run(CREATE)).toContain("Fatto il preventivo 2026-001");
		expect(await run({ op: "send", number: "1" })).toContain("non ho l'indirizzo email");
		expect(await run({ op: "send", number: "1", email: "non-valida" })).toContain("email non è un indirizzo valido");
		expect(proposals).toEqual([]);
		const answer = await run({ op: "send", number: "1", email: "Mario@Rossi.example" });
		expect(answer).toMatch(/^Richiesta req1 pronta: inviare il preventivo 2026-001 per mail, con il PDF allegato\./);
		expect(answer).toContain("L'indirizzo lo salvo sul preventivo quando la mail parte.");
		expect(answer).toContain("Allegato: preventivi/Preventivo-2026-001-Rossi-Srl.pdf");
		const [p] = proposals as [MailProposal];
		expect(p.to).toBe("mario@rossi.example");
		expect(p.subject).toBe("Beta Ristorazione Srl: preventivo n. 2026-001");
		expect(p.body).toBe(
			"Spett.le Rossi Srl,\n\nVi inviamo in allegato il preventivo n. 2026-001 del 18/10/2026, per un totale di 1.220,00 € IVA inclusa.\nIl preventivo è valido fino al 17/11/2026.\n\nRestiamo a disposizione per qualsiasi chiarimento.\n\nCordiali saluti\nAnna Bianchi\nBeta Ristorazione Srl",
		);
		expect(`${p.subject}${p.body}${answer}`).not.toMatch(/[\u2013\u2014]/);
		expect(p.attachments?.map((a) => [a.path, a.contentType])).toEqual([["preventivi/Preventivo-2026-001-Rossi-Srl.pdf", "application/pdf"]]);
		expect(p.attachments?.[0]?.size).toBe((await workspace.read("preventivi/Preventivo-2026-001-Rossi-Srl.pdf")).length);
		expect(p.reason).toBe("Invio del preventivo 2026-001 a Rossi Srl");
		expect(p.quote).toEqual({ number: "2026-001", base: "2026-001", email: "mario@rossi.example" });
		// Not saved yet: only an approved, sent mail keeps it.
		expect(store.read().quotes[0]?.customer.email).toBeUndefined();
		store.markSent("2026-001", "2026-10-18T09:00:00Z", "mario@rossi.example");
		expect(await run({ op: "show", number: "1" })).toContain("aperto, inviato per mail il 18/10/2026");
		expect(await run({ op: "list" })).toContain("inviato per mail il 18/10/2026");
		// The address kept is used next time, and the same one in other case is not a new one.
		expect(await run({ op: "send", number: "2026-001", email: "MARIO@rossi.example" })).toContain("Nota: il preventivo è già inviato per mail il 18/10/2026: dillo a chi ti scrive.");
		expect(proposals[1]?.to).toBe("mario@rossi.example");
		expect(proposals[1]?.quote).toEqual({ number: "2026-001", base: "2026-001" });
		expect(events.filter((e) => e.op === "send")).toEqual([
			{ type: "quote.changed", op: "send", count: 1 },
			{ type: "quote.changed", op: "send", count: 1 },
		]);
	});

	it("the letter: Lei to a person, senza IVA when nothing has VAT, the net when there is a ritenuta", async () => {
		const { mail, proposals } = quoteMail();
		const { run } = quotes(mail);
		await run({ op: "create", customer: "Mario Rossi", email: "m@r.example", items: [{ description: "Lezione", price: 100 }], vat: 0, vat_note: "esente art. 10" });
		await run({ op: "send", number: "1" });
		expect(proposals[0]?.body).toMatch(/^Gentile Mario Rossi,\n\nLe inviamo in allegato il preventivo n\. 2026-001 del 18\/10\/2026, per un totale di 100,00 € senza IVA\./);
		await run({ op: "create", customer: "Studio Verdi", email: "v@s.example", items: [{ description: "Consulenza", price: 1000 }], vat: 22, ritenuta: true });
		await run({ op: "send", number: "2" });
		expect(proposals[1]?.body).toMatch(/^Spett\.le Studio Verdi,\n\nVi inviamo .* IVA inclusa \(netto a pagare [\d.,]+ €\)\./);
	});

	it("an expired or declined quote waits for the person's word; a customer that does not match is said; one card per quote", async () => {
		const clock = { now: NOW };
		const { mail, proposals } = quoteMail(undefined, { pending: new Set(["2026-002"]) });
		const { run } = quotes(mail, clock);
		await run({ ...CREATE, email: "a@b.example" });
		await run({ ...CREATE, customer: "Gialli Srl", email: "g@b.example" });
		expect(await run({ op: "send", number: "1", customer: "Verdi" })).toContain("Il preventivo 2026-001 è di Rossi Srl, non di Verdi: controlla");
		expect(await run({ op: "send", number: "2" })).toBe("C'è già una richiesta in attesa per il preventivo 2026-002: approvala o rifiutala nella card.");
		expect(proposals).toEqual([]);
		clock.now = new Date("2026-12-01T08:00:00Z");
		expect(await run({ op: "send", number: "1", customer: "rossi" })).toMatch(/^Errore: il preventivo 2026-001 è scaduto il 17\/11\/2026\. Chiedi se vuole rifarlo con una nuova validità \(op revise con valid_days\) o mandarlo così com'è/);
		expect(await run({ op: "send", number: "1", confirm_expired: true })).toContain("Richiesta req1 pronta");
		clock.now = NOW;
		await run({ op: "set_status", number: "1", status: "declined" });
		expect(await run({ op: "send", number: "1" })).toContain("è segnato rifiutato dal cliente");
		expect(await run({ op: "send", number: "1", confirm_declined: true })).toContain("Richiesta req2 pronta");
		// The confirmation goes with the request: at approval a declined quote is sent only with it.
		expect(proposals[0]?.quote?.confirmedDeclined).toBeUndefined();
		expect(proposals[1]?.quote?.confirmedDeclined).toBe(true);
	});

	it("week 68: sending an expired or declined quote anyway is a person's own word, never a notice, a schedule or another agente (ADR 0088)", async () => {
		const clock = { now: NOW };
		const { mail, proposals } = quoteMail();
		const { run } = quotes(mail, clock);
		await run({ ...CREATE, email: "a@b.example" });
		await run({ ...CREATE, customer: "Gialli Srl", email: "g@b.example" });
		await run({ op: "set_status", number: "2", status: "declined" });
		clock.now = new Date("2026-12-01T08:00:00Z");
		for (const origin of ["notice", "scheduled", "agent"] as const) {
			const c = { ...fresh(), origin };
			expect(await run({ op: "send", number: "1", confirm_expired: true }, c)).toMatch(/serve il sì di chi ti scrive|lo conferma solo chi ti scrive|altro agente/);
			// Another agente's turn stops at the agent gate (week 70); the others still see the preview.
			expect(await run({ op: "send", number: "1" }, c)).toContain(origin === "agent" ? "altro agente" : "è scaduto il 17/11/2026");
		}
		clock.now = NOW;
		for (const origin of ["notice", "scheduled", "agent"] as const) expect(await run({ op: "send", number: "2", confirm_declined: true }, { ...fresh(), origin })).toMatch(/serve il sì di chi ti scrive|lo conferma solo chi ti scrive|altro agente/);
		expect(proposals).toEqual([]);
		expect(await run({ op: "send", number: "2", confirm_declined: true })).toContain("Richiesta req1 pronta");
	});

	it("at approval: a quote declined since is not sent, unless the request was confirmed so; replaced, not sent", async () => {
		const { run, store } = quotes(quoteMail().mail);
		await run({ ...CREATE, email: "a@b.example" });
		const ref = { number: "2026-001", base: "2026-001" };
		expect(quoteMailProblem(store, ref)).toBeUndefined();
		await run({ op: "set_status", number: "1", status: "declined" });
		expect(quoteMailProblem(store, ref)).toBe("Non inviata: il preventivo 2026-001 è stato segnato rifiutato dal cliente dopo la richiesta.");
		expect(quoteMailProblem(store, { ...ref, confirmedDeclined: true })).toBeUndefined();
		await run({ op: "revise", number: "1", discount: 5 });
		expect(quoteMailProblem(store, { ...ref, confirmedDeclined: true })).toBe("Non inviata: il preventivo 2026-001 è stato sostituito da 2026-001-R1.");
	});

	it("a card waiting for an older version does not hold up the revision; a replay after a crash finds the call's own card", async () => {
		const { mail, proposals } = quoteMail(undefined, { pending: new Set(["2026-001"]) });
		const { run } = quotes(mail);
		await run({ ...CREATE, email: "a@b.example" });
		await run({ op: "revise", number: "1", discount: 5 });
		expect(await run({ op: "send", number: "2026-001-R1" })).toContain("Richiesta req1 pronta");
		// The same call run again: its steps are kept, so the pending check does not see its own card as another one.
		const asked = new Set<string>();
		const replayable = quoteMail(undefined, { pending: asked });
		const q = quotes(replayable.mail);
		await q.run({ ...CREATE, email: "a@b.example" });
		const steps = new Map<string, unknown>();
		const ctx: ToolContext = { ...fresh(), callId: "replay", step: async (key, work) => (steps.has(key) ? steps.get(key) : steps.set(key, await work()).get(key)) as never };
		expect(await q.run({ op: "send", number: "1" }, ctx)).toContain("Richiesta req1 pronta");
		asked.add("2026-001");
		expect(await q.run({ op: "send", number: "1" }, ctx)).toContain("Richiesta req1 pronta");
		expect(replayable.proposals).toHaveLength(1);
		expect(proposals).toHaveLength(1);
	});

	it("refuses a replaced quote or a missing file; a full queue is said", async () => {
		const { mail, proposals } = quoteMail(undefined, { capacity: 0 });
		const { run, workspace } = quotes(mail);
		await run({ ...CREATE, email: "a@b.example" });
		await run({ op: "revise", number: "1", discount: 10 });
		await run({ op: "revise", number: "1", discount: 5 });
		expect(await run({ op: "send", number: "2026-001-R1" })).toContain("è stato sostituito da");
		expect(await run({ op: "send", number: "2026-001" })).toContain("troppe richieste in attesa");
		await workspace.remove("preventivi/Preventivo-2026-001-R2-Rossi-Srl.pdf");
		expect(await run({ op: "send", number: "1" })).toContain("non trovo «Preventivo-2026-001-R2-Rossi-Srl.pdf» nel workspace: cercalo con file_search o file_list");
		expect(proposals).toEqual([]);
	});

	it("from a phone or without a mail account: the text and a mailto link to copy, the file in the chat; file_send only for Owni", async () => {
		const { mail, proposals } = quoteMail("la posta si usa solo dalle conversazioni della console, con l'account di chi scrive");
		for (const q of [quotes(mail), quotes()]) {
			await q.run({ ...CREATE, email: "a@b.example" });
			const answer = await q.run({ op: "send", number: "1" }, fresh({ channel: "telegram", threadId: "42" }));
			expect(answer).toMatch(/^Non posso inviare mail da qui \(/);
			expect(quoted(answer)).toContain("Da qui non posso mandare mail. Ti mando qui il PDF del preventivo e il testo da copiare: inoltrali tu a Rossi Srl.");
			for (const said of quoted(answer)) expect(said).not.toContain("file_send");
			expect(answer).toContain("file_send (File: preventivi/Preventivo-2026-001-Rossi-Srl.pdf)");
			expect(answer).toContain("Oggetto: Beta Ristorazione Srl: preventivo n. 2026-001");
			expect(answer).toContain("Link: mailto:a@b.example?subject=");
		}
		expect(proposals).toEqual([]);
	});

	it("another agente's request and the brief never send", async () => {
		const { mail, proposals } = quoteMail();
		const { tool, run } = quotes(mail);
		await run({ ...CREATE, email: "a@b.example" });
		expect(await run({ op: "send", number: "1" }, fresh({ channel: AGENT_CHANNEL, threadId: "x" }))).toContain("in una richiesta di un altro agente non faccio e non cambio preventivi");
		const [guarded] = readOnlyInBriefs([tool], async () => true);
		expect(String(await guarded?.execute({ op: "send", number: "1" }, fresh()))).toContain("legge soltanto");
		expect(String(await guarded?.execute({ op: "show", number: "1" }, fresh()))).toContain("Preventivo 2026-001");
		expect(proposals).toEqual([]);
	});
});

/** A PDF's text as the fakes write it: what follows the header. */
const fakeRead = async (_name: string, data: Uint8Array) => {
	const text = Buffer.from(data).toString("utf8");
	if (text.includes("illeggibile")) throw new Error("not a pdf");
	return text;
};

describe("solleciti with the invoices attached", () => {
	it("attach_invoice: each letter carries its invoices' XML and the PDF that reads as that invoice; the letter says so; the card says where the address came from", async () => {
		const { mail, proposals } = fakeMail();
		const files = { ...FILES, "f/g1.pdf": `${PDF_HEAD}Fattura n. B-70, cliente P.IVA IT01234567897`, "f/g2.pdf": `${PDF_HEAD}Fattura n. B-700`, "f/altro/Cortesia B-71.pdf": `${PDF_HEAD}Fattura B-71 del 10/09/2026`, "f/altro/B-71 vecchia.pdf": `${PDF_HEAD}nient'altro` };
		const { run, events } = setup(files, { mail, now: TUESDAY, readText: fakeRead });
		const answer = await run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(outside(answer)).toContain("Ho preparato una richiesta di invio");
		expect(outside(answer)).toContain("Le fatture sono allegate");
		const [p] = proposals;
		expect(p?.attachments?.map((a) => [a.path, a.contentType])).toEqual([
			["f/g1.xml", "application/xml"],
			["f/g1.pdf", "application/pdf"],
			["f/g2.xml", "application/xml"],
			["f/altro/Cortesia B-71.pdf", "application/pdf"],
		]);
		expect(inside(answer)).toContain("Nota: g2.pdf non riporta il numero B-71: non l'ho allegato.");
		expect(p?.body).toMatch(/Totale da saldare: 1\.370,00 € \([^\n]*\)\.\n\nIn allegato trovate copia delle fatture\.\n/);
		expect(p?.reason).toBe("Sollecito di pagamento (livello 1) a Gamma Hotel S.p.A. · indirizzo preso dalla fattura");
		expect(events).toEqual([{ type: "invoice.reminder", op: "queue", count: 1 }]);
		// Without attach_invoice, nothing attached and nothing said; reminder_sent refuses it; a draft says it needs send.
		const plain = fakeMail();
		await setup(FILES, { mail: plain.mail, now: TUESDAY }).run({ op: "reminder", party: "gamma", send: true });
		expect(plain.proposals[0]?.attachments).toBeUndefined();
		expect(plain.proposals[0]?.body).not.toContain("In allegato");
		expect(await run({ op: "reminder_sent", party: "gamma", attach_invoice: true })).toContain("attach_invoice non servono qui");
		expect(await run({ op: "reminder", party: "gamma", send: true, attach_invoice: "sì" })).toContain("attach_invoice è true o false");
		expect(await run({ op: "reminder", party: "gamma", attach_invoice: true })).toContain("attach_invoice vale solo con send");
	});

	it("only the XML: a note asks for the courtesy PDF; a PDF that cannot be read is not attached, and said", async () => {
		const { mail, proposals } = fakeMail();
		const { run } = setup({ "f/g1.xml": G1, "f/g1.pdf": `${PDF_HEAD}illeggibile` }, { mail, now: TUESDAY, readText: fakeRead });
		const answer = await run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(proposals[0]?.attachments?.map((a) => a.path)).toEqual(["f/g1.xml"]);
		expect(proposals[0]?.body).toContain("In allegato trovate copia della fattura.");
		expect(inside(answer)).toContain("Nota: non sono riuscita a leggere g1.pdf per controllare che sia la fattura B-70: non l'ho allegato.");
		expect(inside(answer)).toContain("Nota: per B-70 ho solo il file XML della fattura elettronica, che il cliente non legge facilmente: se hai il PDF di cortesia, mettilo nel workspace.");
	});

	it("a letter whose files cannot go is not asked, and says why; from a phone, the invoices to attach by hand", async () => {
		const { mail, proposals } = fakeMail();
		const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f/x${i}.xml`, G1.replace("B-70", `B-9${i}`)]));
		let reads = 0;
		const counted = async (name: string, data: Uint8Array) => {
			reads++;
			return fakeRead(name, data);
		};
		const pdfs = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f/x${i}.pdf`, `${PDF_HEAD}B-9${i} 01/09/2026`]));
		const { run } = setup({ ...many, ...pdfs }, { mail, now: TUESDAY, readText: counted });
		const answer = await run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(inside(answer)).toContain("non preparato, al massimo 5 allegati per mail; manda una fattura alla volta con number");
		expect(proposals).toEqual([]);
		expect(reads).toBe(0);
		// From a phone: the XML and the PDF beside it, not opened, marked to be checked.
		const phone = setup({ "f/g1.xml": G1, "f/g2.xml": G2, "f/g1.pdf": `${PDF_HEAD}B-70` }, { mail: fakeMail("chi scrive non ha collegato Google").mail, now: TUESDAY, readText: counted });
		const copy = await phone.run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(quoted(outside(copy))).toContain("Ti mando qui anche le fatture: allegale tu alla mail.");
		for (const said of quoted(outside(copy))) expect(said).not.toContain("file_send");
		expect(inside(copy)).toContain("File delle fatture: f/g1.xml, f/g1.pdf (da controllare), f/g2.xml");
		expect(outside(copy)).toContain("I PDF segnati «da controllare» li ho trovati solo dal nome, senza aprirli");
		expect(reads).toBe(0);
	});
});

describe("solleciti: a replay after a crash", () => {
	it("finds the call's own cards asked, not ones more waiting", async () => {
		const asked = new Set<string>();
		const { mail, proposals } = fakeMail(undefined, { pending: asked });
		const { run } = setup({ "f/g1.xml": G1 }, { mail, now: TUESDAY });
		const steps = new Map<string, unknown>();
		const ctx: ToolContext = { ...fresh(), callId: "replay", step: async (key, work) => (steps.has(key) ? steps.get(key) : steps.set(key, await work()).get(key)) as never };
		expect(await run({ op: "reminder", party: "gamma", send: true }, ctx)).toContain("Ho preparato una richiesta di invio");
		asked.add(B70);
		const again = await run({ op: "reminder", party: "gamma", send: true }, ctx);
		expect(again).toContain("Ho preparato una richiesta di invio");
		expect(again).not.toContain("c'è già una richiesta di invio in attesa");
		expect(proposals).toHaveLength(1);
		// Another call sees the card waiting.
		expect(await run({ op: "reminder", party: "gamma", send: true }, fresh())).toContain("c'è già una richiesta di invio in attesa");
	});
});

describe("solleciti: which PDF is the invoice", () => {
	/** Invoice `number` of Gamma, its XML at `path`. */
	const gamma = (number: string, extra: Partial<{ date: string; total: string }> = {}) => fattura(BETA, GAMMA, { number, date: extra.date ?? "2026-09-01", total: extra.total ?? "1220.00", rate: [{ amount: extra.total ?? "1220.00", due: "2026-09-30" }] });

	it("the number is not enough: the PDF also holds the customer's partita IVA, the date or the total", async () => {
		const cases: [string, string, boolean][] = [
			["Fattura n. B-70 Gamma Hotel", "solo il numero", false],
			["Fattura n. B-70 P.IVA IT01234567897", "partita IVA", true],
			["Fattura n. B-70 del 01/09/2026", "data italiana", true],
			["Fattura n. B-70, data 2026-09-01", "data ISO", true],
			["Fattura n. B-70 totale 1.220,00 €", "totale", true],
			["Fattura n. B-70 totale 1220,00 €", "totale senza punti", true],
			["Fattura n. B-70 totale 11.220,00 € del 01/09/20261", "numeri più lunghi", false],
			["Fattura n. B-70 P.IVA 012345678970", "partita IVA più lunga", false],
		];
		for (const [text, what, taken] of cases) {
			const { mail, proposals } = fakeMail();
			const answer = await setup({ "f/g1.xml": G1, "f/g1.pdf": `${PDF_HEAD}${text}` }, { mail, now: TUESDAY, readText: fakeRead }).run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
			expect(proposals[0]?.attachments?.map((a) => a.path), what).toEqual(taken ? ["f/g1.xml", "f/g1.pdf"] : ["f/g1.xml"]);
			if (!taken && what === "solo il numero") expect(inside(answer)).toContain("Nota: g1.pdf riporta il numero B-70 ma non la partita IVA del cliente, la data o l'importo della fattura: non l'ho allegato.");
		}
	});

	it("a short number («1») only takes the PDF beside the XML: «Fattura 1 2025 Rossi.pdf» is never another customer's invoice 1", async () => {
		const read: string[] = [];
		const readText = async (name: string, data: Uint8Array) => {
			read.push(name);
			return fakeRead(name, data);
		};
		const rossi = `${PDF_HEAD}Fattura 1 del 2025, Mario Rossi, totale 1.220,00, 01/09/2026`;
		const { mail, proposals } = fakeMail();
		const answer = await setup({ "f/gamma-1.xml": gamma("1"), "f/Fattura 1 2025 Rossi.pdf": rossi }, { mail, now: TUESDAY, readText }).run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(proposals[0]?.attachments?.map((a) => a.path)).toEqual(["f/gamma-1.xml"]);
		expect(read).toEqual([]);
		expect(inside(answer)).toContain("Nota: per 1 ho solo il file XML");
		// Beside the XML, with the same name, it is looked at: still tied to the invoice by the partita IVA, date or total.
		const beside = fakeMail();
		await setup({ "f/gamma-1.xml": gamma("1"), "f/gamma-1.pdf": `${PDF_HEAD}Fattura n. 1, Mario Rossi, 15/03/2025, 80,00` }, { mail: beside.mail, now: TUESDAY, readText }).run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(beside.proposals[0]?.attachments?.map((a) => a.path)).toEqual(["f/gamma-1.xml"]);
		const good = fakeMail();
		await setup({ "f/gamma-1.xml": gamma("1"), "f/gamma-1.pdf": `${PDF_HEAD}Fattura n. 1 del 01/09/2026` }, { mail: good.mail, now: TUESDAY, readText }).run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(good.proposals[0]?.attachments?.map((a) => a.path)).toEqual(["f/gamma-1.xml", "f/gamma-1.pdf"]);
	});

	it("a budget per call: at most 12 PDFs read, and the first that matches ends the search", async () => {
		const other: Party = { name: "Omega Srl", vat: "09876543210", email: "conti@omega.example" };
		const files: Record<string, string> = {};
		for (const [who, tag] of [
			[GAMMA, "g"],
			[other, "o"],
		] as const) {
			for (const n of [1, 2]) {
				const number = `${tag.toUpperCase()}-10${n}`;
				files[`f/${tag}${n}.xml`] = fattura(BETA, who, { number, date: "2026-09-01", total: "100.00", rate: [{ amount: "100.00", due: "2026-09-30" }] });
				files[`f/${tag}${n}.pdf`] = `${PDF_HEAD}niente`;
				for (const copy of ["a", "b", "c"]) files[`f/${number} ${copy}.pdf`] = `${PDF_HEAD}niente`;
			}
		}
		let reads = 0;
		const counted = async (name: string, data: Uint8Array) => {
			reads++;
			return fakeRead(name, data);
		};
		const { mail, proposals } = fakeMail();
		const answer = await setup(files, { mail, now: TUESDAY, readText: counted }).run({ op: "reminder", send: true, attach_invoice: true });
		expect(reads).toBe(12);
		expect(proposals).toHaveLength(2);
		expect(inside(answer)).toContain("Nota: non ho controllato altri PDF: troppi da leggere in una volta");
		// The first PDF that is the invoice ends the search: the copies named after it are not read.
		reads = 0;
		const first = fakeMail();
		await setup({ "f/g1.xml": G1, "f/g1.pdf": `${PDF_HEAD}B-70 01/09/2026`, "f/B-70 a.pdf": `${PDF_HEAD}B-70`, "f/B-70 b.pdf": `${PDF_HEAD}B-70` }, { mail: first.mail, now: TUESDAY, readText: counted }).run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(reads).toBe(1);
		expect(first.proposals[0]?.attachments?.map((a) => a.path)).toEqual(["f/g1.xml", "f/g1.pdf"]);
	});

	it("a PDF that takes too long to read is left out once the call's budget is gone, and nothing more is read", async () => {
		let reads = 0;
		const stuck = async () => {
			reads++;
			return new Promise<string>(() => {});
		};
		const { mail, proposals } = fakeMail();
		const answer = await setup({ "f/g1.xml": G1, "f/g2.xml": G2, "f/g1.pdf": `${PDF_HEAD}B-70`, "f/g2.pdf": `${PDF_HEAD}B-71` }, { mail, now: TUESDAY, readText: stuck, pdfBudgetMs: 50 }).run({ op: "reminder", party: "gamma", send: true, attach_invoice: true });
		expect(reads).toBe(1);
		expect(proposals[0]?.attachments?.map((a) => a.path)).toEqual(["f/g1.xml", "f/g2.xml"]);
		expect(inside(answer)).toContain("Nota: g1.pdf ci mette troppo a leggersi: non l'ho allegato.");
		expect(inside(answer)).toContain("Nota: non ho controllato altri PDF");
	});
});

/** A fake Google: sign-in, and the mails sent (the message as written). */
function fakeGoogle() {
	const sends: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body === undefined ? "" : String(init.body);
		if (url.pathname === "/token") {
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

/** The attachments of a raw message: name (RFC 2231 or quoted) and bytes. */
function attachmentsOf(raw: string): { name: string; data: Buffer }[] {
	const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] as string;
	return raw
		.split(`--${boundary}`)
		.slice(2, -1)
		.map((part) => {
			const [head, body] = part.replace(/^\r\n/, "").split("\r\n\r\n") as [string, string];
			const unfolded = head.replace(/\r\n /g, " ");
			const star = /filename\*=UTF-8''([^;\s]+)/.exec(unfolded)?.[1];
			return { name: star === undefined ? (/filename="([^"]*)"/.exec(unfolded)?.[1] ?? "") : decodeURIComponent(star), data: Buffer.from(body, "base64") };
		});
}

describe("attachments in the app, through the approval card", () => {
	it("a quote and a sollecito with their files reach Gmail only once approved, byte for byte; the audit has counts only", async () => {
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
		const entries = async () => (await api(`/api/instances/${config.instanceId}/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		const reply = async (text: string): Promise<string> => {
			const before = (await entries()).filter((e) => e.from === "owni").length;
			await api(`/api/instances/${config.instanceId}/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 30_000; ) {
				const now = (await entries()).filter((e) => e.from === "owni");
				if (now.length > before) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		const outcome = async (id: string) => {
			for (const start = Date.now(); Date.now() - start < 10_000; ) {
				if ((await entries()).some((e) => e.text?.includes(`Esito della richiesta ${id}`))) return;
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no outcome");
		};
		await loadTools(reply, "invoices", "quotes");
		await reply('/tool invoices {"op":"set_company","vat":"00000520031","name":"Beta Ristorazione Srl","address":"Via Roma 1, Milano"}');
		const year = todayIn(config.timeZone).slice(0, 4);
		const decide = async (id: string, decision: string) => (await api(`/api/instances/${config.instanceId}/google-actions/${id}/decision`, { decision })).action;
		const cards = async () => (await api(`/api/instances/${config.instanceId}/google-actions`)).actions as { id: string; status: string; reason: string; mail?: { attachments?: { path: string; name: string; size: number }[] } }[];
		// Outcome notices get replies of their own meanwhile, so wait for the reply that holds `mark`.
		const replyWith = async (text: string, mark: string): Promise<string> => {
			const before = (await entries()).length;
			await api(`/api/instances/${config.instanceId}/threads/${thread.id}/messages`, { text });
			for (const start = Date.now(); Date.now() - start < 30_000; ) {
				const found = (await entries()).slice(before).find((e) => e.from === "owni" && e.text?.includes(mark));
				if (found !== undefined) return found.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error(`no reply with ${mark}`);
		};
		const show = (n: string) => replyWith(`/tool quotes {"op":"show","number":"${n}"}`, "Cliente: Rossi Srl");
		expect(await reply(`/tool quotes ${JSON.stringify(CREATE)}`)).toContain(`Fatto il preventivo ${year}-001`);
		// Asked, then asked again: one card per quote. Rejected: nothing sent, the address not saved.
		expect(await reply(`/tool quotes {"op":"send","number":"1","email":"Mario@Rossi.example"}`)).toContain("pronta: inviare il preventivo");
		expect(await reply(`/tool quotes {"op":"send","number":"1","email":"mario@rossi.example"}`)).toContain(`C'è già una richiesta in attesa per il preventivo ${year}-001`);
		const [first] = await cards();
		const pdfPath = `preventivi/Preventivo-${year}-001-Rossi-Srl.pdf`;
		expect(first?.reason).toBe(`Invio del preventivo ${year}-001 a Rossi Srl`);
		expect(first?.mail?.attachments?.map((a) => [a.path, a.name])).toEqual([[pdfPath, `Preventivo-${year}-001-Rossi-Srl.pdf`]]);
		expect((await decide(first?.id as string, "rejected")).status).toBe("rejected");
		await outcome(first?.id as string);
		expect(await show("1")).not.toContain("rossi.example");
		// Approved: sent byte for byte, then the address and the day are on the quote.
		expect(await reply(`/tool quotes {"op":"send","number":"1","email":"Mario@Rossi.example"}`)).toContain("pronta: inviare il preventivo");
		const quoteCard = (await cards()).find((c) => c.status === "pending") as { id: string };
		expect(google.sends).toEqual([]);
		expect((await decide(quoteCard.id, "approved")).status).toBe("done");
		await outcome(quoteCard.id);
		const sentQuote = google.sends[0] as string;
		expect(sentQuote).toContain("To: mario@rossi.example\r\n");
		expect(sentQuote).toContain(`Subject: Beta Ristorazione Srl: preventivo n. ${year}-001\r\n`);
		const [quotePdf] = attachmentsOf(sentQuote);
		expect(quotePdf?.name).toBe(`Preventivo-${year}-001-Rossi-Srl.pdf`);
		expect(quotePdf?.data.equals(readFileSync(join(workspace, pdfPath)))).toBe(true);
		const shown = await show("1");
		expect(shown).toContain("mario@rossi.example");
		expect(shown).toContain("inviato per mail il");
		// Revised while the card waits: the card fails and nothing leaves.
		expect(await reply(`/tool quotes {"op":"send","number":"1"}`)).toContain("pronta: inviare il preventivo");
		const stale = (await cards()).find((c) => c.status === "pending") as { id: string };
		expect(await reply(`/tool quotes {"op":"revise","number":"1","valid_days":60}`)).toContain(`${year}-001-R1`);
		const failed = await decide(stale.id, "approved");
		expect(failed.status).toBe("failed");
		expect(failed.result.error).toBe(`Non inviata: il preventivo ${year}-001 è stato sostituito da ${year}-001-R1.`);
		expect(google.sends).toHaveLength(1);

		await replyWith('/tool invoices {"op":"reminder","party":"gamma","send":true,"attach_invoice":true}', "Le fatture sono allegate");
		const reminderCard = (await cards()).find((c) => c.status === "pending") as { id: string; reason: string; mail?: { attachments?: { path: string }[] } };
		expect(reminderCard.reason).toBe("Sollecito di pagamento (livello 1) a Gamma Hotel S.p.A. · indirizzo preso dalla fattura");
		expect(reminderCard.mail?.attachments?.map((a) => a.path)).toEqual(["fatture/g1.xml"]);
		expect((await api(`/api/instances/${config.instanceId}/google-actions/${reminderCard.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		await outcome(reminderCard.id);
		const [xml] = attachmentsOf(google.sends[1] as string);
		expect(xml?.name).toBe("g1.xml");
		expect(xml?.data.toString("utf8")).toBe(G1);
		const audit = readFileSync(auditFile(dataDir, tenantId(config.tenantId)), "utf8");
		const approved = audit
			.split("\n")
			.filter((l) => l.includes("google_action.approved"))
			.map((l) => JSON.parse(l).attachments);
		expect(approved).toEqual([1, 1, 1]);
		expect(audit).toMatch(/"type":"quote.changed"[^\n]*"op":"send","count":1/);
		for (const secret of ["Rossi", "rossi.example", "Preventivo-", "g1.xml", "fatture/", "Gamma"]) expect(audit).not.toContain(secret);
	}, 60_000);
});
