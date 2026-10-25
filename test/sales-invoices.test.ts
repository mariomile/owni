import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import type { ClientCard } from "../src/core/clients.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { OwniTool, PersonCall, ToolContext } from "../src/core/engine.ts";
import { fatturaData, fatturaText } from "../src/core/fattura-pa.ts";
import { fatturaXml } from "../src/core/fattura-pa-writer.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { type Company, register } from "../src/core/invoices.ts";
import { makeDocument } from "../src/core/make-document.ts";
import { latin1 } from "../src/core/plain-text.ts";
import { QuoteStore } from "../src/core/quote-store.ts";
import type { Quote } from "../src/core/quotes.ts";
import { FIELD_LIMITS, FORFETTARIO_DICITURA, NATURE, SELLER_PHONE, UPLOAD_PATH } from "../src/core/sales-invoice-rules.ts";
import { SALES_BROKEN, SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { amount2, salesTotals } from "../src/core/sales-invoice-sums.ts";
import { hourlyText } from "../src/core/invoice-sums.ts";
import { rateText } from "../src/core/tools/timesheet-render.ts";
import { type IssuedInvoice, invoiceProblem, isIssued, italianAddress, progressiveCode, salesAgentReads, salesCallReads, type SalesInvoice, PERSON_CF, ritenutaType, sellerOf } from "../src/core/sales-invoices.ts";
import { SCHEDULE_LIMITS } from "../src/core/schedules.ts";
import { resolveClient } from "../src/core/timesheet-clients.ts";
import { lineWords } from "../src/core/timesheet-sums.ts";
import { askFor, namedDraft } from "../src/core/tools/sales-invoice-env.ts";
import { paymentTermsOf } from "../src/core/tools/sales-invoice-input.ts";
import { NATURA } from "../src/core/fattura-pa-codes.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import type { WorkEntry } from "../src/core/timesheet.ts";
import { TimesheetStore } from "../src/core/timesheet-store.ts";
import { createSalesInvoiceTools, type SalesEvent } from "../src/core/tools/sales-invoice-tools.ts";
import { child, children, descendant, parseXml, type XmlElement } from "../src/core/xml-tree.ts";
import { Workspace } from "../src/core/workspace.ts";

// Every tax id here is made up and passes its checksum; every name is invented.
const SELLER_VAT = "IT00000010017";
const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
let calls = 0;
const fresh = (callId = `c${++calls}`, thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin: "person", signal: new AbortController().signal, callId, thread });

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-sales-"));
	dirs.push(dir);
	return dir;
}

const IBAN = "IT51X0000000000000000000001";
const ORDINARIO: Company = { vat: SELLER_VAT, name: "Beta Studio Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: [IBAN], by: "test:u", at: NOW.toISOString() };
const FORFETTARIO: Company = { ...ORDINARIO, name: "Kevin Wojtq", cf: "KWJXQZ75C10F205V", regime: "forfettario" };

/** A business customer, said in full. */
const DELTA = { customer: "Delta Servizi Srl", vat_number: "00000020016", address: "Via Verdi 2, 00184 Roma RM", recipient_code: "ZZZ0001" };
const line = (description: string, price: number | string, extra: Record<string, unknown> = {}) => ({ description, price, ...extra });

const quote = (o: Partial<Quote> = {}): Quote => ({
	number: "2026-004",
	base: "2026-004",
	revision: 0,
	date: "2026-10-01",
	validDays: 30,
	customer: { name: "Delta Servizi Srl", vat: "00000020016", address: "Via Verdi 2, 00184 Roma RM" },
	lines: [{ description: "Sito web", quantity: "1", price: "1000", vat: 22 }],
	terms: "Bonifico a 60 giorni fine mese",
	status: "accepted",
	file: "preventivi/Preventivo-2026-004.pdf",
	by: "test:u",
	at: NOW.toISOString(),
	...o,
});

const entry = (n: number, minutes: number, extra: Partial<WorkEntry> = {}): WorkEntry => ({ id: `O-2026-000${n}`, date: `2026-10-0${n}`, client: "Delta Servizi Srl", minutes, billable: true, rate: "50", description: `Sviluppo ${n}`, by: "test:u", at: NOW.toISOString(), ...extra });

/** `askFirst`: leave the last number before Owni unsaid, so the first draft of the year asks it. */
type Setup = { company?: Company | null; quotes?: Quote[]; entries?: WorkEntry[]; cards?: ClientCard[]; real?: boolean; askFirst?: boolean };

function setup(o: Setup = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	if (o.company !== null) invoices.setCompany(o.company ?? ORDINARIO);
	writeFileSync(join(dir, "quotes.json"), JSON.stringify({ next: { 2026: 10 }, quotes: o.quotes ?? [] }));
	writeFileSync(join(dir, "timesheet.json"), JSON.stringify({ next: { 2026: 10 }, entries: o.entries ?? [], timers: [], rates: [], reservations: [] }));
	const quotes = new QuoteStore(dir);
	const timesheet = new TimesheetStore(dir, { now: () => clock.now });
	const store = new SalesInvoiceStore(dir);
	// The last number before Owni said already (none), unless the test is about asking it.
	if (o.askFirst !== true) store.update("seed", (state) => ({ ...state, settings: { by: "test:u", at: NOW.toISOString(), lastBefore: { 2026: 0, 2027: 0 } } }));
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const pdf = { fails: false };
	/** `crash`: the next audit throws, as a process dying between the issue and its record. */
	const audit = { crash: false };
	const events: SalesEvent[] = [];
	const clock = { now: NOW };
	const made: string[] = [];
	const [tool] = createSalesInvoiceTools({
		workspace,
		store,
		company: invoices,
		taxes: new TaxStore(dir),
		clients: { read: () => ({ cards: o.cards ?? [], nextCard: 1, nextFollowUp: 1, calls: [], broken: false }) },
		quotes,
		timesheet,
		scanner,
		timeZone: "Europe/Rome",
		whoIs: () => "test:u",
		record: async (e) => {
			if (audit.crash) {
				audit.crash = false;
				throw new Error("crash");
			}
			events.push(e);
		},
		now: () => clock.now,
		make: async (input) => {
			if (pdf.fails) throw new Error("niente PDF");
			made.push(input.text);
			return o.real === true ? makeDocument(input) : { data: Buffer.from(`%PDF-1.4 finta\n${input.text}`), notes: [] };
		},
	});
	if (tool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const last = (): SalesInvoice => store.read().invoices.at(-1) as SalesInvoice;
	/** A draft, then its issue after the yes: the invoice issued. */
	const issued = async (args: Record<string, unknown>): Promise<{ inv: IssuedInvoice; answer: string; draft: string }> => {
		const draft = await run({ op: "draft", ...args });
		const id = last().id;
		expect(isIssued(last()), draft).toBe(false);
		const answer = await run({ op: "issue", draft: id, confirm: true });
		const inv = store.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error(`not issued: ${answer}`);
		return { inv, answer, draft };
	};
	const xmlOf = (inv: IssuedInvoice) => readFileSync(join(root, inv.file as string), "utf8");
	return { dir, root, workspace, invoices, quotes, timesheet, store, events, audit, clock, made, pdf, tool, run, last, issued, xmlOf, at: (iso: string) => (clock.now = new Date(iso)) };
}

const tree = (xml: string): XmlElement => parseXml(xml, { maxElements: 100_000, maxDepth: 64 });
const text = (el: XmlElement | undefined, path: string) => {
	const found = descendant(el, path);
	return found?.text;
};
const names = (el: XmlElement | undefined) => (el?.children ?? []).map((c) => c.name);
const body = (xml: string) => child(tree(xml), "FatturaElettronicaBody");

/** The order FatturaPA 1.2.2 gives the children of each block (the subset written here). */
const ORDER: Record<string, readonly string[]> = {
	FatturaElettronica: ["FatturaElettronicaHeader", "FatturaElettronicaBody"],
	FatturaElettronicaHeader: ["DatiTrasmissione", "CedentePrestatore", "RappresentanteFiscale", "CessionarioCommittente"],
	DatiTrasmissione: ["IdTrasmittente", "ProgressivoInvio", "FormatoTrasmissione", "CodiceDestinatario", "ContattiTrasmittente", "PECDestinatario"],
	CedentePrestatore: ["DatiAnagrafici", "Sede", "StabileOrganizzazione", "IscrizioneREA", "Contatti", "RiferimentoAmministrazione"],
	DatiAnagrafici: ["IdFiscaleIVA", "CodiceFiscale", "Anagrafica", "AlboProfessionale", "ProvinciaAlbo", "NumeroIscrizioneAlbo", "DataIscrizioneAlbo", "RegimeFiscale"],
	Sede: ["Indirizzo", "NumeroCivico", "CAP", "Comune", "Provincia", "Nazione"],
	FatturaElettronicaBody: ["DatiGenerali", "DatiBeniServizi", "DatiVeicoli", "DatiPagamento", "Allegati"],
	DatiGenerali: ["DatiGeneraliDocumento", "DatiOrdineAcquisto", "DatiContratto", "DatiConvenzione", "DatiRicezione", "DatiFattureCollegate"],
	DatiGeneraliDocumento: ["TipoDocumento", "Divisa", "Data", "Numero", "DatiRitenuta", "DatiBollo", "DatiCassaPrevidenziale", "ScontoMaggiorazione", "ImportoTotaleDocumento", "Arrotondamento", "Causale", "Art73"],
	DatiRitenuta: ["TipoRitenuta", "ImportoRitenuta", "AliquotaRitenuta", "CausalePagamento"],
	DatiBollo: ["BolloVirtuale", "ImportoBollo"],
	DatiCassaPrevidenziale: ["TipoCassa", "AlCassa", "ImportoContributoCassa", "ImponibileCassa", "AliquotaIVA", "Ritenuta", "Natura", "RiferimentoAmministrazione"],
	DatiBeniServizi: ["DettaglioLinee", "DatiRiepilogo"],
	DettaglioLinee: ["NumeroLinea", "TipoCessionePrestazione", "CodiceArticolo", "Descrizione", "Quantita", "UnitaMisura", "DataInizioPeriodo", "DataFinePeriodo", "PrezzoUnitario", "ScontoMaggiorazione", "PrezzoTotale", "AliquotaIVA", "Ritenuta", "Natura", "RiferimentoAmministrazione", "AltriDatiGestionali"],
	DatiRiepilogo: ["AliquotaIVA", "Natura", "SpeseAccessorie", "Arrotondamento", "ImponibileImporto", "Imposta", "EsigibilitaIVA", "RiferimentoNormativo"],
	DatiPagamento: ["CondizioniPagamento", "DettaglioPagamento"],
	DettaglioPagamento: ["Beneficiario", "ModalitaPagamento", "DataRiferimentoTerminiPagamento", "GiorniTerminiPagamento", "DataScadenzaPagamento", "ImportoPagamento", "CodUfficioPostale", "CognomeQuietanzante", "NomeQuietanzante", "CFQuietanzante", "TitoloQuietanzante", "IstitutoFinanziario", "IBAN"],
};

/** Every block's children in the schema's order, recursively; repeated blocks kept together. */
function checkOrder(el: XmlElement, path = el.name): void {
	const order = ORDER[el.name];
	if (order !== undefined) {
		const seen = names(el);
		const positions = seen.map((n) => order.indexOf(n));
		expect(positions.every((p) => p >= 0), `${path}: ${seen.join(", ")}`).toBe(true);
		expect([...positions].sort((a, b) => a - b), `${path}: ${seen.join(", ")}`).toEqual(positions);
	}
	for (const c of el.children) checkOrder(c, `${path}/${c.name}`);
}

/** The XML read back by the reader: the same totals, VAT, ritenuta, bollo and due date as the sums. */
function roundTrip(inv: IssuedInvoice, xml: string): void {
	const t = salesTotals(inv);
	const data = Buffer.from(xml, "utf8");
	const read = fatturaData(data, false);
	const doc = read.documents[0];
	expect(doc?.number).toBe(inv.number);
	expect(doc?.date).toBe(inv.date);
	expect(doc?.type).toBe(inv.type);
	expect(doc?.total).toBe(amount2(t.total));
	expect(Number(doc?.taxable).toFixed(2)).toBe(amount2(t.taxable));
	expect(read.supplier.vat?.code).toBe(SELLER_VAT.slice(2));
	if (inv.type === "TD01") {
		expect(doc?.instalments).toHaveLength(1);
		expect(doc?.instalments[0]?.amount).toBe(amount2(t.toPay));
		expect(doc?.instalments[0]?.due).toBe(inv.due);
		if (inv.payment?.iban !== undefined) expect(doc?.instalments[0]?.iban).toBe(inv.payment.iban);
	}
	const b = body(xml);
	const vat = children(child(b, "DatiBeniServizi"), "DatiRiepilogo").reduce((s, r) => s + Number(text(r, "Imposta")), 0);
	expect(vat.toFixed(2)).toBe(amount2(t.vat));
	expect(text(b, "DatiGenerali/DatiGeneraliDocumento/DatiRitenuta/ImportoRitenuta")).toBe(t.ritenuta > 0n ? amount2(t.ritenuta) : undefined);
	expect(text(b, "DatiGenerali/DatiGeneraliDocumento/DatiBollo/ImportoBollo")).toBe(t.bollo.due ? "2.00" : undefined);
	// The reader's own summary agrees too.
	const summary = fatturaText(data, false).text;
	expect(summary).toContain(inv.number);
	checkOrder(tree(xml));
}

describe("forfettario", () => {
	it("writes no VAT, N2.2 and the dicitura; no bollo at 77,47", async () => {
		const s = setup({ company: FORFETTARIO });
		const { inv, answer } = await s.issued({ ...DELTA, lines: [line("Consulenza", "77.47")] });
		expect(answer).toContain("Fatto, ho emesso la fattura n. 1 del 18/10/2026.");
		expect(answer).toContain("Fatture e Corrispettivi");
		const xml = s.xmlOf(inv);
		expect(inv.file).toBe(`fatture/emesse/${SELLER_VAT}_00001.xml`);
		expect(xml).toContain("<RegimeFiscale>RF19</RegimeFiscale>");
		expect(xml).toContain("<Natura>N2.2</Natura>");
		expect(xml).toContain("<AliquotaIVA>0.00</AliquotaIVA>");
		expect(xml).toContain(`<Causale>${latin1(FORFETTARIO_DICITURA).replace("'", "&apos;")}</Causale>`);
		expect(xml).not.toContain("DatiBollo");
		expect(xml).not.toContain("DatiRitenuta");
		roundTrip(inv, xml);
	});

	it("declares the bollo past 77,47 and asks once who pays it", async () => {
		const s = setup({ company: FORFETTARIO });
		const asked = await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", "77.48")] });
		expect(asked).toContain("Su questa fattura: chi paga il bollo da 2,00 € (supera 77,47 € senza IVA)");
		expect(s.store.read().invoices).toHaveLength(0);
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", "77.48")], bollo_to_client: false });
		const xml = s.xmlOf(inv);
		expect(xml).toMatch(/<DatiBollo>\s*<BolloVirtuale>SI<\/BolloVirtuale>\s*<ImportoBollo>2.00<\/ImportoBollo>\s*<\/DatiBollo>/);
		expect(salesTotals(inv).total).toBe(7748n);
		roundTrip(inv, xml);
		// Said once: the next invoice does not ask again.
		expect(s.store.read().settings?.bolloToClient).toBe(false);
		const next = await s.run({ op: "draft", ...DELTA, lines: [line("Formazione", 300)] });
		expect(next).toContain("Bozza");
		expect(next).toContain("a carico tuo");
	});

	it("adds the bollo as a line when the customer pays it", async () => {
		const s = setup({ company: FORFETTARIO });
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", 500)], bollo_to_client: true });
		const t = salesTotals(inv);
		expect(t.total).toBe(50200n);
		expect(t.lines.at(-1)?.description).toBe("Imposta di bollo assolta in modo virtuale");
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<Natura>N1</Natura>");
		expect(xml).toContain("<ImportoBollo>2.00</ImportoBollo>");
		roundTrip(inv, xml);
	});

	it("refuses VAT and the ritenuta", async () => {
		const s = setup({ company: FORFETTARIO });
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", 100)], vat: 22 })).toContain("senza IVA");
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", 100)], ritenuta: true })).toContain("non hanno la ritenuta");
	});
});

describe("ordinario", () => {
	it("writes 22% VAT with the payment, the IBAN and the due date", async () => {
		const s = setup();
		const { inv, draft } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(draft).toContain("emessa oggi sarebbe la n. 1");
		const t = salesTotals(inv);
		expect([t.taxable, t.vat, t.total, t.toPay]).toEqual([100000n, 22000n, 122000n, 122000n]);
		expect(inv.due).toBe("2026-11-17");
		const xml = s.xmlOf(inv);
		expect(xml).toContain('versione="FPR12"');
		expect(xml).toContain("<FormatoTrasmissione>FPR12</FormatoTrasmissione>");
		expect(xml).toContain("<CodiceDestinatario>ZZZ0001</CodiceDestinatario>");
		expect(xml).toContain("<RegimeFiscale>RF01</RegimeFiscale>");
		expect(xml).toContain("<ModalitaPagamento>MP05</ModalitaPagamento>");
		expect(xml).toContain("<EsigibilitaIVA>I</EsigibilitaIVA>");
		expect(xml).not.toContain("PECDestinatario");
		roundTrip(inv, xml);
	});

	it("groups mixed rates, a nature line and rounds per summary row", async () => {
		const s = setup();
		const lines = [line("Progetto", 1000), line("Libro", "19.99", { vat: 4, quantity: 3 }), line("Ristorazione", "33.33", { vat: 10, quantity: 3 }), line("Corso esente", 100, { vat: 0, natura: "N4" })];
		expect(await s.run({ op: "draft", ...DELTA, lines })).toContain("aliquota IVA delle voci");
		const { inv } = await s.issued({ ...DELTA, lines, vat: 22, bollo_to_client: false });
		const t = salesTotals(inv);
		expect(t.rows.map((r) => [r.vat, r.natura, r.taxable, r.tax])).toEqual([
			[22, undefined, 100000n, 22000n],
			[10, undefined, 9999n, 1000n],
			[4, undefined, 5997n, 240n],
			[0, "N4", 10000n, 0n],
		]);
		expect(t.bollo.due).toBe(true);
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<Natura>N4</Natura>");
		roundTrip(inv, xml);
	});

	it("takes the ritenuta at 20% on the fees", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", 1000)], vat: 22, ritenuta: true });
		const t = salesTotals(inv);
		expect([t.ritenuta, t.total, t.toPay]).toEqual([20000n, 122000n, 102000n]);
		const xml = s.xmlOf(inv);
		expect(xml).toMatch(/<DatiRitenuta>\s*<TipoRitenuta>RT02<\/TipoRitenuta>\s*<ImportoRitenuta>200.00<\/ImportoRitenuta>\s*<AliquotaRitenuta>20.00<\/AliquotaRitenuta>\s*<CausalePagamento>A<\/CausalePagamento>/);
		expect(xml).toContain("<Ritenuta>SI</Ritenuta>");
		roundTrip(inv, xml);
	});

	it("adds the rivalsa INPS at 4%, with VAT on it and in the ritenuta's base", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Consulenza", 1000)], vat: 22, ritenuta: true, cassa: { kind: "rivalsa_inps" } });
		const t = salesTotals(inv);
		expect([t.cassaTotal, t.taxable, t.vat, t.total, t.ritenuta, t.toPay]).toEqual([4000n, 104000n, 22880n, 126880n, 20800n, 106080n]);
		const xml = s.xmlOf(inv);
		expect(xml).toMatch(/<DatiCassaPrevidenziale>\s*<TipoCassa>TC22<\/TipoCassa>\s*<AlCassa>4.00<\/AlCassa>\s*<ImportoContributoCassa>40.00<\/ImportoContributoCassa>\s*<ImponibileCassa>1000.00<\/ImponibileCassa>\s*<AliquotaIVA>22.00<\/AliquotaIVA>\s*<Ritenuta>SI<\/Ritenuta>/);
		roundTrip(inv, xml);
	});

	it("puts a cassa's contributo on the imponibile, VAT on both, and the ritenuta on the fees only", async () => {
		const s = setup();
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Parere", 1000)], vat: 22, cassa: { kind: "contributo_integrativo" } })).toContain("cassa professionale del contributo integrativo");
		const { inv } = await s.issued({ ...DELTA, lines: [line("Parere", 1000)], vat: 22, ritenuta: true, cassa: { kind: "contributo_integrativo", type: "TC01" } });
		const t = salesTotals(inv);
		expect([t.cassaTotal, t.taxable, t.vat, t.total, t.ritenutaBase, t.ritenuta, t.toPay]).toEqual([4000n, 104000n, 22880n, 126880n, 100000n, 20000n, 106880n]);
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<TipoCassa>TC01</TipoCassa>");
		expect(descendant(body(xml), "DatiGenerali/DatiGeneraliDocumento/DatiCassaPrevidenziale/Ritenuta")).toBeUndefined();
		roundTrip(inv, xml);
	});
});

describe("customers", () => {
	it("writes 0000000 for a private person and says the copy goes to them", async () => {
		const s = setup();
		const { inv, answer } = await s.issued({ customer: "Xenia Quaz", cf: "XQZKWJ80A41H501T", address: "Via Dante 3, 40121 Bologna BO", lines: [line("Ripetizioni", 60)], vat: 22 });
		expect(inv.buyer.kind).toBe("private");
		expect(answer).toContain("Recapito: nessun codice (la trova nella sua area dell'Agenzia delle Entrate; gli diamo il PDF)");
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<CodiceDestinatario>0000000</CodiceDestinatario>");
		const buyer = child(child(tree(xml), "FatturaElettronicaHeader"), "CessionarioCommittente");
		expect(text(buyer, "DatiAnagrafici/CodiceFiscale")).toBe("XQZKWJ80A41H501T");
		expect(descendant(buyer, "DatiAnagrafici/IdFiscaleIVA")).toBeUndefined();
		expect(text(buyer, "DatiAnagrafici/Anagrafica/Denominazione")).toBe("Xenia Quaz");
		roundTrip(inv, xml);
	});

	it("writes the PEC only with 0000000", async () => {
		const s = setup();
		const { inv } = await s.issued({ customer: "Omega Srl", vat_number: "00000030015", address: "Corso Italia 9, 10121 Torino TO", pec: "omega@pec.example", lines: [line("Servizio", 100)], vat: 22 });
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<CodiceDestinatario>0000000</CodiceDestinatario>");
		expect(xml).toContain("<PECDestinatario>omega@pec.example</PECDestinatario>");
		checkOrder(tree(xml));
	});

	it("writes XXXXXXX for a foreign customer", async () => {
		const s = setup();
		const { inv } = await s.issued({ customer: "Muster GmbH", vat_number: "DE111111117", address: "Hauptstrasse 5, 10115 Berlin", lines: [line("Consulenza", 800)], vat: 0, natura: "N2.1", reference: "Art. 7-ter DPR 633/72", bollo_to_client: false });
		expect(inv.buyer).toMatchObject({ kind: "foreign", code: "XXXXXXX", address: { country: "DE", cap: "00000" } });
		const xml = s.xmlOf(inv);
		expect(xml).toContain("<CodiceDestinatario>XXXXXXX</CodiceDestinatario>");
		expect(xml).toMatch(/<IdPaese>DE<\/IdPaese>\s*<IdCodice>111111117<\/IdCodice>/);
		expect(xml).toContain("<Nazione>DE</Nazione>");
		expect(xml).toContain("<RiferimentoNormativo>Art. 7-ter DPR 633/72</RiferimentoNormativo>");
		roundTrip(inv, xml);
	});

	it("writes FPA12 for a public office, with split payment and the order", async () => {
		const s = setup();
		const { inv } = await s.issued({ customer: "Comune di Esempio", cf: "80000010019", address: "Piazza Municipio 1, 80100 Napoli NA", recipient_code: "UFABCD", lines: [line("Manutenzione", 1000)], vat: 22, split_payment: true, order: { id: "DET-12", cig: "Z1234567890" } });
		expect(inv.buyer.kind).toBe("pa");
		const t = salesTotals(inv);
		expect([t.total, t.toPay]).toEqual([122000n, 100000n]);
		const xml = s.xmlOf(inv);
		expect(xml).toContain('versione="FPA12"');
		expect(xml).toContain("<FormatoTrasmissione>FPA12</FormatoTrasmissione>");
		expect(xml).toContain("<CodiceDestinatario>UFABCD</CodiceDestinatario>");
		expect(xml).toContain("<EsigibilitaIVA>S</EsigibilitaIVA>");
		expect(xml).toContain("<CodiceCIG>Z1234567890</CodiceCIG>");
		const read = fatturaData(Buffer.from(xml), false);
		expect(read.publicAdmin).toBe(true);
		expect(read.documents[0]?.splitVat).toBeDefined();
		roundTrip(inv, xml);
	});

	it("asks what FatturaPA needs of the customer, and never guesses it", async () => {
		const s = setup();
		const answer = await s.run({ op: "draft", customer: "Nuovo Cliente Srl", lines: [line("Servizio", 100)], vat: 22 });
		expect(answer).toContain("Sul cliente: partita IVA e codice destinatario (7 caratteri) o PEC; per un privato il codice fiscale; indirizzo");
		expect(answer).toContain("non inventarli");
		expect(s.store.read().invoices).toHaveLength(0);
		const bad = await s.run({ op: "draft", ...DELTA, address: "Via Verdi 2, Roma", lines: [line("Servizio", 100)], vat: 22 });
		expect(bad).toContain("«Via Roma 1, 20121 Milano MI»");
	});

	it("takes the customer from a client's card", async () => {
		const card: ClientCard = { id: "CL-0001", name: "Delta Servizi Srl", aliases: ["Delta"], vat: "IT00000020016", address: "Via Verdi 2, 00184 Roma RM", tags: [], contacts: [], notes: [], followUps: [], contactLog: [], by: "test:u", at: NOW.toISOString() } as unknown as ClientCard;
		const s = setup({ cards: [card] });
		const answer = await s.run({ op: "draft", customer: "Delta", recipient_code: "ZZZ0001", lines: [line("Servizio", 100)], vat: 22 });
		expect(answer).toContain("Per emetterla o cambiarla usa la bozza BZ-0001 (non serve dirlo a chi ti scrive).");
		expect(s.last().buyer).toMatchObject({ name: "Delta Servizi Srl", vat: "IT00000020016", card: "CL-0001" });
	});
});

describe("the seller", () => {
	it("asks for what is missing from the company's data", async () => {
		const s = setup({ company: { vat: SELLER_VAT, name: "Beta Studio Srl", by: "test:u", at: NOW.toISOString() } });
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("Servizio", 100)], vat: 22 });
		expect(answer).toContain("Su di te (una volta sola): codice fiscale, regime (ordinario o forfettario), indirizzo con CAP, comune e provincia");
		expect(answer).toContain("non inventarli");
		expect(s.store.read().invoices).toHaveLength(0);
		const none = setup({ company: null });
		expect(await none.run({ op: "draft", ...DELTA, lines: [line("Servizio", 100)], vat: 22 })).toContain("Su di te (una volta sola): nome o ragione sociale, partita IVA, codice fiscale, regime (ordinario o forfettario), indirizzo con CAP, comune e provincia, IBAN");
	});

	it("reads the company's address in its parts", () => {
		expect(italianAddress("Via Roma 1, 20121 Milano (MI)")).toEqual({ street: "Via Roma 1", cap: "20121", town: "Milano", province: "MI", country: "IT" });
		expect(italianAddress("Viale dei Mille 10 - 50131 Firenze FI, Italia")).toMatchObject({ cap: "50131", town: "Firenze", province: "FI" });
		expect(italianAddress("Via Roma 1, Milano")).toBeUndefined();
	});
});

describe("credit notes", () => {
	it("makes a TD04 that refers to the invoice, and never credits more than its total", async () => {
		const s = setup();
		const { inv: original } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		const draft = await s.run({ op: "credit_note", invoice: "1" });
		expect(draft).toContain("Nota di credito a Delta Servizi Srl");
		const id = s.last().id;
		const answer = await s.run({ op: "issue", draft: id, confirm: true });
		expect(answer).toContain("ho emesso la nota di credito n. 2 del 18/10/2026");
		const note = s.store.read().invoices.find((i) => i.id === id) as IssuedInvoice;
		const xml = s.xmlOf(note);
		expect(xml).toContain("<TipoDocumento>TD04</TipoDocumento>");
		expect(xml).toMatch(/<DatiFattureCollegate>\s*<IdDocumento>1<\/IdDocumento>\s*<Data>2026-10-18<\/Data>\s*<\/DatiFattureCollegate>/);
		expect(xml).not.toContain("DatiPagamento");
		expect(salesTotals(note).total).toBe(salesTotals(original).total);
		roundTrip(note, xml);
		expect(fatturaData(Buffer.from(xml), false).documents[0]?.credit).toBe(true);
		expect(await s.run({ op: "credit_note", invoice: "1", lines: [line("Altro", 10)] })).toContain("non si storna più di quanto fatturato");
		expect(await s.run({ op: "credit_note", invoice: "7" })).toContain("non trovo una fattura emessa");
	});

	it("credits part of an invoice with the lines given", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000), line("Hosting", 200)], vat: 22 });
		await s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto concordato sul sito", 100)] });
		expect(salesTotals(s.last()).total).toBe(12200n);
		expect(s.last().related?.number).toBe("1");
	});
});

describe("numbering", () => {
	it("starts again each calendar year and can be written with the year", async () => {
		const s = setup();
		expect((await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 })).inv.number).toBe("1");
		expect((await s.issued({ ...DELTA, lines: [line("B", 100)], vat: 22 })).inv.number).toBe("2");
		expect(await s.run({ op: "settings", numbering: "year" })).toContain("si può scegliere da gennaio, prima della prima fattura del 2027. Non ho cambiato niente.");
		s.at("2027-01-04T09:00:00Z");
		expect(await s.run({ op: "settings", numbering: "year" })).toContain("Fatto, ho salvato.");
		const third = (await s.issued({ ...DELTA, lines: [line("C", 100)], vat: 22 })).inv;
		expect([third.number, third.year, third.seq]).toEqual(["2027/1", 2027, 1]);
		expect(third.progressive).toBe("00003");
		expect(await s.run({ op: "list", year: 2026 })).toContain("Nel 2026: 2 fatture");
		expect(await s.run({ op: "list" })).toContain("Nel 2027: una fattura");
	});

	it("never gives one number twice when two issues run at once", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		const [a, b] = s.store.read().invoices.map((i) => i.id);
		await Promise.all([s.run({ op: "issue", draft: a, confirm: true }), s.run({ op: "issue", draft: b, confirm: true })]);
		const issued = s.store.read().invoices.filter(isIssued);
		expect(issued.map((i) => i.number).sort()).toEqual(["1", "2"]);
		expect(new Set(issued.map((i) => i.file)).size).toBe(2);
	});

	it("gives a removed draft no number", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const first = s.last().id;
		const removed = await s.run({ op: "remove", draft: first });
		expect(removed).toBe(`Fatto, ho tolto la bozza ${first}: nessun numero è stato usato.`);
		const { inv } = await s.issued({ ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(inv.number).toBe("1");
		expect(inv.id).toBe("BZ-0002");
		expect(await s.run({ op: "remove", draft: inv.id })).toContain("non si può togliere");
	});

	it("issues only after the yes", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const ask = await s.run({ op: "issue", draft: s.last().id });
		expect(ask).toContain("la emetto solo dopo il suo sì");
		expect(isIssued(s.last())).toBe(false);
		expect(readdirSync(s.root)).toEqual([]);
	});
});

describe("calls run again", () => {
	/** A context whose steps are kept, as the engine keeps them, for a call run again. */
	const durable = (callId: string): ToolContext => {
		const kept = new Map<string, unknown>();
		return {
			step: async (key, work) => {
				if (kept.has(key)) return kept.get(key) as never;
				const out = await work();
				kept.set(key, out);
				return out;
			},
			progress: () => {}, origin: "person",
			signal: new AbortController().signal,
			callId,
			thread: { channel: "test", threadId: "t1" },
		};
	};

	it("makes one draft and issues one number per call id", async () => {
		const s = setup();
		const d = durable("draft-1");
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 }, d);
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 }, d);
		expect(s.store.read().invoices).toHaveLength(1);
		const i = durable("issue-1");
		const id = s.last().id;
		const first = await s.run({ op: "issue", draft: id, confirm: true }, i);
		const again = await s.run({ op: "issue", draft: id, confirm: true }, i);
		const unfenced = (t: string) => t.replace(/fatture emesse [0-9a-f]{12}/g, "fatture emesse");
		expect(unfenced(again)).toBe(unfenced(first));
		expect(s.store.read().next).toEqual({ 2026: 2 });
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(1);
	});

	it("finishes an invoice issued whose file was never written", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const draft = s.last();
		// Stopped right after the number was taken.
		const { inv } = { inv: s.store.issue(draft.id, "lost-call", "2026-10-18", undefined, (d, number, seq, progressive) => ({ ...d, number, year: 2026, seq, date: "2026-10-18", due: "2026-11-17", seller: { name: "Beta Studio Srl", vat: SELLER_VAT, cf: "00000010017", regime: "RF01", address: { street: "Via Roma 1", cap: "20121", town: "Milano", province: "MI", country: "IT" } }, progressive, issued: { by: "test:u", at: NOW.toISOString() }, issueCall: "lost-call" })) };
		expect(inv.file).toBeUndefined();
		const answer = await s.run({ op: "issue", draft: draft.id, confirm: true });
		expect(answer).toContain("Ho completato la fattura n. 1 (era già emessa).");
		const done = s.store.read().invoices[0] as IssuedInvoice;
		expect(done.number).toBe("1");
		expect(existsSync(join(s.root, done.file as string))).toBe(true);
		expect(s.store.read().next).toEqual({ 2026: 2 });
	});
});

describe("files", () => {
	it("never writes over a file: a name taken gets the next progressive", async () => {
		const s = setup();
		mkdirSync(join(s.root, "fatture/emesse"), { recursive: true });
		const theirs = join(s.root, `fatture/emesse/${SELLER_VAT}_00001.xml`);
		writeFileSync(theirs, "<x>altro</x>");
		const { inv } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(readFileSync(theirs, "utf8")).toBe("<x>altro</x>");
		expect(inv.file).toBe(`fatture/emesse/${SELLER_VAT}_00002.xml`);
		expect(inv.pdf).toBe(`fatture/emesse/${SELLER_VAT}_00002.pdf`);
		expect(progressiveCode(36)).toBe("00010");
	});

	it("writes a courtesy PDF that says it is not valid for tax purposes", async () => {
		const s = setup({ real: true });
		const { inv, answer } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(answer).toContain("non è valida ai fini fiscali");
		const pdf = readFileSync(join(s.root, inv.pdf as string));
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(s.made[0]).toContain("Copia di cortesia, non valida ai fini fiscali.");
	});

	it("escapes hostile text and drops control characters", async () => {
		const s = setup();
		const hostile = "Lavori <script>alert(1)</script> & \"altro\" 'x' ]]> fine\u0001\u0007 ok";
		const { inv } = await s.issued({ customer: "Rossi & Figli <Srl>", vat_number: "11111110018", address: "Via <Roma> 1, 20121 Milano MI", recipient_code: "ZZZ0001", lines: [line(hostile, 100)], vat: 22, notes: "Nota ]]> <b>" });
		const xml = s.xmlOf(inv);
		expect(xml).toContain("Lavori &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;altro&quot; &apos;x&apos; ]]&gt; fine ok");
		expect(xml).toContain("<Denominazione>Rossi &amp; Figli &lt;Srl&gt;</Denominazione>");
		expect(xml).not.toContain("]]>");
		expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
		const read = fatturaData(Buffer.from(xml), false);
		expect(read.customer.name).toBe("Rossi & Figli <Srl>");
		expect(text(body(xml), "DatiBeniServizi/DettaglioLinee/Descrizione")).toBe("Lavori <script>alert(1)</script> & \"altro\" 'x' ]]> fine ok");
		roundTrip(inv, xml);
	});

	it("keeps to FatturaPA's field lengths", async () => {
		const s = setup();
		const long = await s.run({ op: "draft", ...DELTA, lines: [line("x".repeat(1001), 100)], vat: 22 });
		expect(long).toContain("al massimo 1000 caratteri");
		const dots = await s.run({ op: "draft", ...DELTA, lines: [line("…".repeat(500), 100)], vat: 22 });
		expect(dots).toContain("troppo lunga per la fattura");
		const name = await s.run({ op: "draft", ...DELTA, customer: `Ditta ${"A".repeat(80)}`, lines: [line("Servizio", 100)], vat: 22 });
		expect(name).toContain(`al massimo ${FIELD_LIMITS.denominazione} caratteri`);
		const { inv } = await s.issued({ ...DELTA, lines: [line("y".repeat(1000), 100)], vat: 22 });
		expect(text(body(s.xmlOf(inv)), "DatiBeniServizi/DettaglioLinee/Descrizione")).toHaveLength(1000);
		expect(s.store.read().invoices).toHaveLength(1);
	});

	it("writes typographic marks as Latin-1", () => {
		expect(latin1("L’offerta “speciale” – 10 € … ok")).toBe("L'offerta \"speciale\" - 10 EUR ... ok");
		expect(latin1("Šárka Łódź")).toBe("Sárka ?ódz");
		expect(NATURE.every((n) => n in NATURA)).toBe(true);
	});
});

describe("hours and quotes", () => {
	it("bills the hours not yet billed and marks them with the invoice", async () => {
		const s = setup({ entries: [entry(1, 120), entry(2, 90), entry(3, 60, { client: "Altro Srl" })] });
		const { inv, draft, answer } = await s.issued({ ...DELTA, lines: undefined, hours: true, vat: 22 });
		expect(draft).toContain("3 ore e 30 minuti");
		expect(draft).not.toContain("Ore in fattura");
		expect(inv.hours?.map((h) => h.id)).toEqual(["O-2026-0001", "O-2026-0002"]);
		expect(salesTotals(inv).taxable).toBe(17500n);
		expect(answer).toContain("Ho segnato come fatturate 2 voci di ore");
		const entries = s.timesheet.read().entries;
		expect(entries.filter((e) => e.billed?.ref === "fattura 1").map((e) => e.id)).toEqual(["O-2026-0001", "O-2026-0002"]);
		expect(entries.find((e) => e.id === "O-2026-0003")?.billed).toBeUndefined();
		expect(await s.run({ op: "draft", ...DELTA, lines: undefined, hours: true, vat: 22 })).toContain("Nessuna ora da fatturare");
	});

	it("refuses to issue when the hours changed since the draft", async () => {
		const s = setup({ entries: [entry(1, 120)] });
		await s.run({ op: "draft", ...DELTA, hours: true, vat: 22 });
		const id = s.last().id;
		s.timesheet.setBilled(["O-2026-0001"], () => ({ by: "test:u", at: NOW.toISOString(), ref: "a mano" }));
		const answer = await s.run({ op: "issue", draft: id, confirm: true });
		expect(answer).toContain("va rifatta la bozza");
		expect(isIssued(s.last())).toBe(false);
		expect(s.store.read().next).toEqual({});
	});

	it("bills an accepted quote and marks it invoiced, with its hours", async () => {
		const quoted = entry(4, 60, { billed: { by: "test:u", at: NOW.toISOString(), quote: "2026-004", rate: "50", rounding: 0 } });
		const s = setup({ quotes: [quote()], entries: [quoted] });
		const { inv, answer } = await s.issued({ quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 });
		expect(inv.quote).toBe("2026-004");
		expect(inv.buyer).toMatchObject({ name: "Delta Servizi Srl", vat: "IT00000020016" });
		expect(inv.payment).toMatchObject({ days: 60, endOfMonth: true });
		expect(inv.due).toBe("2026-12-31");
		expect(answer).toContain("Il preventivo 2026-004 ora risulta fatturato");
		expect(s.quotes.read().quotes[0]?.invoice).toBe("1");
		expect(s.timesheet.read().entries[0]?.billed).toMatchObject({ quote: "2026-004", ref: "fattura 1" });
		roundTrip(inv, s.xmlOf(inv));
		expect(await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001" })).toContain("già stato fatturato");
	});

	it("bills only an accepted quote", async () => {
		const s = setup({ quotes: [quote({ status: "open" })] });
		expect(await s.run({ op: "draft", quote: "4", recipient_code: "ZZZ0001" })).toContain("non risulta accettato (è aperto)");
		expect(s.store.read().invoices).toHaveLength(0);
	});
});

describe("the scadenzario", () => {
	it("finds the invoice issued as one to collect, and the credit note against it", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		await s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto", 100)] });
		await s.run({ op: "issue", draft: s.last().id, confirm: true });
		const scanner = new InvoiceScanner(s.workspace, { read: async (_name, data) => documentFattura(data) });
		const found = register((await scanner.scan(new AbortController().signal)).invoices, [], s.invoices.read().company);
		const invoice = found.find((i) => i.doc.number === "1");
		const credit = found.find((i) => i.doc.number === "2");
		expect(found).toHaveLength(2);
		expect(invoice).toMatchObject({ side: "active", credit: false, paid: false });
		expect(invoice?.instalments[0]).toMatchObject({ due: inv.due });
		expect(credit).toMatchObject({ side: "active", credit: true });
	});
});

describe("who may ask", () => {
	it("gives another agente only counts and totals", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		const agent = fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" });
		const list = await s.run({ op: "list" }, agent);
		expect(list).toContain("Nel 2026: una fattura");
		expect(list).toContain("1.220,00 €");
		expect(list).not.toContain("Delta");
		for (const op of ["draft", "issue", "show", "remove", "credit_note", "settings"]) {
			expect(await s.run({ op, ...DELTA, lines: [line("A", 1)] }, fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" }))).toContain("a un altro agente non preparo");
		}
		expect([salesAgentReads({ op: "list" }), salesAgentReads({ op: "show" })]).toEqual([true, false]);
	});

	it("another agente's invoice request in its conversation: the draft is made and its issue goes to the approvers, with the preview, never to the model (ADR 0108)", async () => {
		const s = setup({ quotes: [quote()] });
		const handed: { what: string; call?: PersonCall }[] = [];
		const asked = (callId: string): ToolContext => ({ ...fresh(callId, { channel: AGENT_CHANNEL, threadId: "vendite~web~t1" }), origin: "agent", needsPerson: (what, call) => void handed.push({ what, ...(call === undefined ? {} : { call }) }) });
		const answer = await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 }, asked("a1"));
		expect(answer).toMatch(/^Non emetto la fattura su richiesta di un altro agente/);
		expect(answer).not.toContain("Delta");
		const made = s.last();
		expect(isIssued(made)).toBe(false);
		expect(handed).toHaveLength(1);
		expect(handed[0]).toMatchObject({ what: "emetto la fattura", call: { args: { op: "issue", draft: made.id, confirm: true, version: expect.any(String), day: "2026-10-18" }, undo: { op: "remove", draft: made.id } } });
		// A customer with nothing saved: what the other agente gave is flagged on top, and the day the approval holds for is said.
		expect(handed[0]?.call?.preview).toMatch(/^Attenzione: non vengono dai dati salvati, li ha dati l'altro agente: codice destinatario «ZZZ0001», che non avevo\. Controllali prima di approvare\./);
		expect(handed[0]?.call?.preview).toContain("Data: 2026-10-18. Approvata un altro giorno non la emetto");
		expect(handed[0]?.call?.preview).toContain("Emetterei questa fattura");
		expect(handed[0]?.call?.preview).toContain("1.220,00");
		// The same call again: the same draft, handed over again, no second one.
		await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 }, asked("a1"));
		expect(s.store.read().invoices).toHaveLength(1);
		expect(handed[1]?.call?.args).toEqual(handed[0]?.call?.args);
		// What only a person sets, or a draft missing data: nothing made, nothing said of it.
		for (const args of [{ last_number: 41 }, { bollo_to_client: true }, { replace: made.id }]) {
			expect(await s.run({ op: "draft", ...DELTA, lines: [line("A", 1)], vat: 22, ...args }, asked(`p-${Object.keys(args)[0]}`))).toMatch(/^Errore: questa fattura non la posso preparare su richiesta di un altro agente/);
		}
		expect(await s.run({ op: "draft", customer: "Nuovo Cliente Srl", lines: [line("A", 1)], vat: 22 }, asked("missing"))).toMatch(/^Errore: questa fattura non la posso preparare/);
		expect(s.store.read().invoices).toHaveLength(1);
		expect(handed).toHaveLength(2);
		// In a stanza (no approvers to ask) it is refused as before, and nothing is made.
		expect(await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 }, { ...fresh("stanza"), origin: "agent" })).toContain("a un altro agente non preparo");
		expect(s.store.read().invoices).toHaveLength(1);
		// Approved: the confirmed call issues it, as a person's; a draft changed since is not issued.
		const call = handed[0]?.call as PersonCall;
		expect(await s.run({ ...call.args, version: "0000" }, fresh("approved-stale"))).toContain("è cambiata da quando è stata chiesta l'approvazione");
		expect(isIssued(s.last())).toBe(false);
		// Approved on another day: date, number and stock would not be the ones read, so it is not issued.
		s.at("2026-10-19T09:00:00Z");
		expect(await s.run({ ...call.args }, fresh("approved-late"))).toContain("l'approvazione è arrivata un giorno diverso da quello dell'anteprima (2026-10-18)");
		expect(isIssued(s.last())).toBe(false);
		s.at(NOW.toISOString());
		// The invoice and its record name who said yes, not Owni.
		await s.run({ ...call.args }, { ...fresh("approved"), approvedBy: "test:boss" });
		expect(s.last()).toMatchObject({ id: made.id, number: "1", issued: { by: "test:boss" } });
		expect(s.events.at(-1)).toEqual({ type: "sales_invoices.changed", op: "issue", count: 1, by: "test:boss" });
	});

	it("another agente never says where the money goes, nor changes a known customer's data (ADR 0108)", async () => {
		const handed: PersonCall[] = [];
		const asked = (callId: string): ToolContext => ({ ...fresh(callId, { channel: AGENT_CHANNEL, threadId: "vendite~web~t1" }), origin: "agent", needsPerson: (_what, call) => void (call === undefined ? undefined : handed.push(call)) });
		const cannot = /^Errore: questa fattura non la posso preparare su richiesta di un altro agente/;
		// «Cambia l'IBAN»: an IBAN given by the other agente is refused, nothing made.
		const s = setup({ quotes: [quote()] });
		expect(await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22, iban: "IT00X0000000000000000000666" }, asked("iban"))).toMatch(cannot);
		expect(s.store.read().invoices).toHaveLength(0);

		// An IBAN not saved with the company (one from the last invoice): the draft is taken back, and not made again.
		const loose = setup({ company: { ...ORDINARIO, ibans: [] }, quotes: [quote()] });
		await loose.issued({ ...DELTA, lines: [line("A", 100)], vat: 22, iban: IBAN });
		expect(await loose.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 }, asked("loose"))).toMatch(cannot);
		expect(await loose.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 }, asked("loose"))).toMatch(cannot);
		expect(loose.store.read().invoices).toHaveLength(1);

		// A customer already invoiced: a code or an address other than the saved ones is refused.
		const known = setup({ quotes: [quote()] });
		await known.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(await known.run({ op: "draft", quote: "2026-004", recipient_code: "AAA0000", vat: 22 }, asked("code"))).toMatch(cannot);
		expect(await known.run({ op: "draft", customer: "Delta Servizi Srl", address: "Via Bianchi 9, 00100 Roma RM", lines: [line("A", 1)], vat: 22 }, asked("address"))).toMatch(cannot);
		expect(await known.run({ op: "draft", customer: "Delta Servizi Srl", pec: "altro@pec.it", lines: [line("A", 1)], vat: 22 }, asked("pec"))).toMatch(/^Non emetto la fattura su richiesta di un altro agente/);
		expect(handed.at(-1)?.preview).toMatch(/^Attenzione: [^\n]*PEC «altro@pec\.it», che non avevo/);
		expect(known.store.read().invoices).toHaveLength(2);
		// The same data as saved, written another way: no flag.
		expect(await known.run({ op: "draft", quote: "2026-004", recipient_code: "zzz0001", vat: 22 }, asked("same"))).toMatch(/^Non emetto la fattura su richiesta di un altro agente/);
		expect(handed.at(-1)?.preview).not.toContain("Attenzione");
		expect(handed).toHaveLength(2);
	});

	it("only reads in the brief's thread", async () => {
		const s = setup();
		const [tool] = readOnlyInBriefs([s.tool as OwniTool], async () => true);
		const brief = fresh(undefined, { channel: "web", threadId: "w1" });
		expect(String(await tool?.execute({ op: "draft", ...DELTA, lines: [line("A", 1)], vat: 22 }, brief))).toContain("legge soltanto");
		expect(String(await tool?.execute({ op: "list" }, brief))).toContain("Nessuna fattura emessa con me nel 2026");
		expect([salesCallReads({ op: "list" }), salesCallReads({ op: "show" }), salesCallReads({ op: "issue" })]).toEqual([true, true, false]);
	});

	it("audits the op and a count, never names or amounts", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		await s.run({ op: "credit_note", invoice: "1" });
		await s.run({ op: "remove", draft: s.last().id });
		await s.run({ op: "settings", bollo_to_client: true });
		expect(s.events).toEqual([
			{ type: "sales_invoices.changed", op: "draft", count: 1 },
			{ type: "sales_invoices.changed", op: "issue", count: 1 },
			{ type: "sales_invoices.changed", op: "credit_note", count: 1 },
			{ type: "sales_invoices.changed", op: "remove", count: 1 },
			{ type: "sales_invoices.changed", op: "settings", count: 1 },
		]);
		expect(JSON.stringify(s.events)).not.toMatch(/Delta|1000|1220|00000020016/);
	});
});

describe("the archive", () => {
	it("never writes over a file that does not read", async () => {
		const s = setup();
		const file = join(s.dir, "sales-invoices.json");
		writeFileSync(file, "{ rotto");
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(answer).toBe(`Errore: ${SALES_BROKEN}.`);
		expect(await s.run({ op: "list" })).toBe(`Errore: ${SALES_BROKEN}.`);
		expect(readFileSync(file, "utf8")).toBe("{ rotto");
	});

	it("keeps a copy of the last state written", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(existsSync(join(s.dir, "sales-invoices.json.bak"))).toBe(true);
	});

	it("shows and lists, with the drafts waiting", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		await s.run({ op: "draft", ...DELTA, lines: [line("Altro", 50)], vat: 22 });
		const list = await s.run({ op: "list" });
		expect(list).toContain("Nel 2026: una fattura; imponibile 1.000,00 €, IVA 220,00 €, totale 1.220,00 €.");
		expect(list).toContain("bozza BZ-0002");
		expect(await s.run({ op: "show", invoice: "1" })).toContain("Fattura n. 1 del 18/10/2026 a Delta Servizi Srl");
		expect(await s.run({ op: "list", compact: true })).toBe("Niente da segnalare sulle fatture: nel brief non scrivere niente sulle fatture.");
		s.at("2026-10-30T08:00:00Z");
		expect(await s.run({ op: "list", compact: true })).toContain("Una bozza di fattura è ferma da più di 7 giorni");
	});

	it("writes the same XML for the same invoice", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(fatturaXml(inv, salesTotals(inv))).toBe(s.xmlOf(inv));
	});
});

// The review's fixes, one test (or more) each, named by their number.
describe("review fixes", () => {
	const PROF: Company = { ...ORDINARIO, name: "Kevin Wojtq", cf: "KWJXQZ75C10F205V" };
	const OMEGA = { customer: "Omega Srl", vat_number: "00000030015", address: "Corso Italia 9, 10121 Torino TO", recipient_code: "ZZZ0002" };

	it("S1: asks once the last number before Owni and goes on from it", async () => {
		const s = setup({ askFirst: true });
		const asked = await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(asked).toContain("È la prima fattura che fai con me quest'anno: qual è il numero dell'ultima fattura che hai emesso nel 2026? (se nessuna, parto da 1)");
		expect(s.store.read().invoices).toHaveLength(0);
		const { inv } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22, last_number: 41 });
		expect(inv.number).toBe("42");
		expect(s.store.read().settings?.lastBefore).toEqual({ 2026: 41 });
		// Once Owni issued that year, the starting number is not said again.
		expect(await s.run({ op: "settings", last_number: 50 })).toContain("Non ho cambiato niente");
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 })).toContain("Bozza pronta");
	});

	it("S1: the setting is one-time, said before the first invoice of the year", async () => {
		const s = setup({ askFirst: true });
		expect(await s.run({ op: "settings", last_number: 12 })).toContain("Nel 2026 l'ultima fattura prima di me era la 12: parto dalla 13.");
		expect(await s.run({ op: "settings", last_number: 14 })).toContain("Corretto: l'ultima prima di me era la 14, parto dalla 15.");
		expect((await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 })).inv.number).toBe("15");
		expect(await s.run({ op: "settings" })).toContain("L'ultima fattura del 2026 è la n. 15: la prossima sarà la 16.");
	});


	it("S1: a broken archive is restored from the copy, never deleted", () => {
		expect(SALES_BROKEN).toContain("Non va cancellato: con l'istanza ferma, va rimessa al suo posto la copia sales-invoices.json.bak");
	});

	it("S2: never removes a draft issued meanwhile, and checks the credit note's limit under the lock", async () => {
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		expect(() => s.store.removeDraft(inv.id, "other-call")).toThrow("è stata emessa intanto");
		const answers = await Promise.all([s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto", 600)] }), s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto", 600)] })]);
		expect(answers.filter((a) => a.includes("non si storna più di quanto fatturato"))).toHaveLength(1);
		expect(s.store.read().invoices.filter((i) => i.type === "TD04")).toHaveLength(1);
	});


	it("S4 and S5: a spesa anticipata (N1) and the bollo are outside the ritenuta and the cassa", async () => {
		const s = setup();
		const lines = [line("Consulenza", 1000), line("Diritti di segreteria anticipati", 100, { advance: true })];
		const { inv } = await s.issued({ ...DELTA, lines, vat: 22, ritenuta: true, cassa: { kind: "rivalsa_inps" }, bollo_to_client: true });
		expect(inv.lines[1]).toMatchObject({ vat: 0, natura: "N1", notFee: true });
		const t = salesTotals(inv);
		expect([t.cassaTotal, t.ritenutaBase, t.ritenuta]).toEqual([4000n, 104000n, 20800n]);
		const xml = s.xmlOf(inv);
		const details = children(child(body(xml), "DatiBeniServizi"), "DettaglioLinee");
		expect(details.map((d) => [text(d, "Natura"), text(d, "Ritenuta")])).toEqual([
			[undefined, "SI"],
			["N1", undefined],
			["N1", undefined],
		]);
		roundTrip(inv, xml);
	});


	it("S7: a credit note's lines keep the invoice's rates, and each rate is credited at most its imponibile", async () => {
		const s = setup();
		await s.issued({ ...DELTA, lines: [line("Sito web", 1000), line("Corso", 100, { vat: 0, natura: "N4" })], vat: 22, bollo_to_client: false });
		expect(await s.run({ op: "credit_note", invoice: "1", lines: [line("Altro", 10, { vat: 10 })] })).toContain("IVA 10%, che la fattura n. 1 non ha");
		expect(await s.run({ op: "credit_note", invoice: "1", lines: [line("Corso", 150, { vat: 0, natura: "N4" })] })).toContain("per le voci senza IVA, esenti (N4)");
		expect(await s.run({ op: "credit_note", invoice: "1", lines: [line("Corso", 100, { vat: 0, natura: "N4" })] })).toContain("Bozza pronta");
		expect(await s.run({ op: "credit_note", invoice: "1", lines: [line("Sconto", 10)] })).toContain("l'aliquota IVA di ogni voce da stornare");
	});

	it("S8: one rule for the seller's phone, and an issue refused says which field", async () => {
		const seller = (phone: string) => sellerOf({ ...ORDINARIO, phone }, undefined);
		expect(seller("+39 000 000 0000")).toMatchObject({ seller: { phone: "+390000000000" } });
		expect("seller" in seller("12") && seller("12")).toMatchObject({ seller: expect.not.objectContaining({ phone: expect.anything() }) });
		expect([SELLER_PHONE.test("+390000000000"), SELLER_PHONE.test("0000"), SELLER_PHONE.test("+3900000000000")]).toEqual([true, false, false]);
		const s = setup();
		const { inv } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(invoiceProblem({ ...inv, seller: { ...inv.seller, phone: "12" } })).toContain("il telefono dell'azienda");
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(() => s.store.issue(s.last().id, "bad", "2026-10-18", undefined, (d, number, seq, progressive) => ({ ...d, number, year: 2026, seq, date: "2026-10-18", seller: { ...inv.seller, phone: "12" }, progressive, issued: inv.issued, issueCall: "bad" }))).toThrow("il telefono dell'azienda");
	});

	it("S9: the tests hold only made-up tax ids", () => {
		const own = readFileSync(join(import.meta.dirname, "sales-invoices.test.ts"), "utf8");
		for (const real of ["0074311015" + "7", "0331122003" + "6", "DE13669597" + "6", "M5UXCR" + "1", "8001234567" + "8", "IT60X054281110100000012345" + "6", "BNCLRA80A41H50" + "1D", "VRDGPP75C10F20" + "5G"]) expect(own).not.toContain(real);
	});



	it("U3: a quote's draft takes the lines and the customer said, and stays linked to the quote", async () => {
		const s = setup({ quotes: [quote()] });
		await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", lines: [line("Sito web ridotto", 800)], vat: 22 });
		expect(s.last()).toMatchObject({ quote: "2026-004", lines: [{ description: "Sito web ridotto", price: "800" }], buyer: { name: "Delta Servizi Srl" } });
		const first = s.last().id;
		await s.run({ op: "draft", quote: "2026-004", ...OMEGA, vat: 22, replace: first });
		expect(s.last()).toMatchObject({ quote: "2026-004", lines: [{ description: "Sito web" }], buyer: { name: "Omega Srl", vat: "IT00000030015" } });
		expect(s.store.read().invoices).toHaveLength(1);
		expect(s.tool.description).toContain("draft again with the whole request and the change, and replace with the draft's id");
		expect(s.tool.description).toContain("A fattura differita is issued by the 15th of the month after the DDTs.");
	});

	it("U4: says a customer's accepted quote not invoiced, and where the hours already are", async () => {
		const quoted = entry(1, 60, { billed: { by: "test:u", at: NOW.toISOString(), quote: "2026-004", rate: "50", rounding: 0 } });
		const s = setup({ quotes: [quote()], entries: [quoted] });
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("Sito", 1000)], vat: 22 })).toContain("Delta Servizi Srl ha anche il preventivo 2026-004 accettato e non ancora fatturato: se è lo stesso lavoro, rifaccio la fattura dal preventivo.");
		const hours = await s.run({ op: "draft", ...DELTA, hours: true, vat: 22 });
		expect(hours).toContain("sono già in un preventivo o in una fattura");
		expect(hours).toContain("una voce è nel preventivo 2026-004");
	});


	it("U6: after the issue, how to upload the file and by when, and how the PDF reaches the customer", async () => {
		const s = setup();
		const { answer } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(answer).toContain(`Per caricarlo: ${UPLOAD_PATH}`);
		expect(answer).toContain("Va trasmesso entro 12 giorni dalla data della fattura (entro venerdì 30 ottobre): meglio oggi.");
		expect(answer).toContain("google_mail_send con il PDF in allegato");
		expect(answer).toContain("file_send");
		expect(readFileSync(join(import.meta.dirname, "../src/core/sales-invoice-rules.ts"), "utf8")).toContain("da verificare");
	});

	it("U7: the description sends the totals per customer to clients and gives the person's words", () => {
		const s = setup();
		for (const words of ["«quanto ho fatturato quest'anno / a Rossi?» → clients", "only the invoices issued with Owni", "«fammi la fattura a Rossi per il preventivo 4»", "«cambia il prezzo della riga 2 a 900»", "«sì, il bollo lo paga il cliente»"]) expect(s.tool.description).toContain(words);
	});

	it("U8: the brief reads the invoices' compact line, within the instruction's limit", async () => {
		expect(BRIEF_INSTRUCTION).toMatch(/\n9\. Chiama ognuno di questi tool con l'op tra parentesi e compact true, e riporta la sua riga solo se segnala qualcosa: [^\n]*\bsales_invoices \(list\)[,.]/);
		expect(BRIEF_INSTRUCTION.length).toBeLessThanOrEqual(SCHEDULE_LIMITS.maxInstructionChars);
		expect(await setup().run({ op: "list", compact: true })).toBe("Niente da segnalare sulle fatture: nel brief non scrivere niente sulle fatture.");
	});

	it("U9: a forfettario's year in compensi, the bollo apart", async () => {
		const s = setup({ company: FORFETTARIO });
		await s.issued({ ...DELTA, lines: [line("Consulenza", 1500)], bollo_to_client: true });
		expect(await s.run({ op: "list" })).toContain("Nel 2026: una fattura, 1.500,00 € di compensi (più 2,00 € di bollo fatto pagare al cliente).");
	});

	it("U10: the settings, the removal, the hours, the credit note and the quote in plain words", async () => {
		const s = setup({ quotes: [quote({ status: "open" })], entries: [entry(1, 120), entry(2, 90)] });
		expect(await s.run({ op: "settings" })).toContain("Le fatture sono numerate 1, 2, 3… (oppure 2026/1 se preferisci).");
		expect(await s.run({ op: "draft", quote: "4", recipient_code: "ZZZ0001" })).toContain("lo segnalo accettato con quotes (op set_status accepted) solo se chi ti scrive lo conferma");
		const hours = await s.run({ op: "draft", ...DELTA, hours: true, vat: 22 });
		expect(hours).toContain("3 ore e 30 minuti");
		expect(hours).not.toContain("Ore di lavoro: 2 voci");
		expect(await s.run({ op: "remove" })).toBe("Fatto, ho tolto la bozza BZ-0001: nessun numero è stato usato.");
		await s.issued({ ...DELTA, lines: [line("Sito", 1000)], vat: 22 });
		const credit = await s.run({ op: "credit_note", invoice: "1", wrong_customer: true });
		expect(credit).toContain("Dopo averla emessa, rifaccio la fattura al cliente giusto.");
		expect(s.last().causale).toBeUndefined();
		expect(credit).not.toContain("Note: Storno");
		expect(resolveClient("Laura Ner", ["Laura Neri"])).toMatchObject({ kind: "close", candidates: ["Laura Neri"] });
	});

	it("A1, A4: the shared helpers ask in one go and name the draft or the only one", () => {
		expect(askFor(["a", "b"], "la fattura", "coda")).toBe("Per la fattura mi servono ancora questi dati. Chiedili a chi ti scrive tutti insieme, non inventarli, poi rifai la richiesta con le sue risposte:\n• a\n• b\ncoda");
		const d = (id: string) => ({ id }) as SalesInvoice;
		expect(namedDraft([d("BZ-0001")], undefined, "emettere")).toEqual({ found: d("BZ-0001") });
		expect(namedDraft([d("BZ-0001"), d("BZ-0002")], undefined, "emettere")).toEqual({ answer: "Errore: ci sono più bozze, dimmi quale emettere." });
		expect(namedDraft([], undefined, "togliere")).toEqual({ answer: "Non c'è nessuna bozza da togliere." });
		expect(namedDraft([d("BZ-0001")], "bz-0003", "vedere")).toEqual({ answer: "Errore: non c'è la bozza BZ-0003." });
	});

	it("A2, A3: the quote's payment terms and the hours' line words, from their own modules", () => {
		expect(paymentTermsOf("Bonifico a 60 giorni fine mese")).toEqual({ days: 60, endOfMonth: true });
		expect(paymentTermsOf("a vista")).toEqual({ days: 0, endOfMonth: false });
		expect(typeof lineWords).toBe("function");
	});

	it("A5: the customer found with the clients' rule: the same name but for the legal form is taken and said", async () => {
		const card = { id: "CL-0001", name: "Acme Srl", aliases: [], vat: "IT00000020016", address: "Via Verdi 2, 00184 Roma RM", tags: [], contacts: [], notes: [], followUps: [], contactLog: [], by: "test:u", at: NOW.toISOString() } as unknown as ClientCard;
		const s = setup({ cards: [card] });
		const answer = await s.run({ op: "draft", customer: "Acme", recipient_code: "ZZZ0001", lines: [line("Servizio", 50)], vat: 22 });
		expect(answer).toContain("a meno della forma societaria");
		expect(s.last().buyer).toMatchObject({ name: "Acme Srl", card: "CL-0001" });
	});

	it("A6, A7: no sender of invoices, the intermediary said once; no inline type imports", () => {
		const read = (f: string) => readFileSync(join(import.meta.dirname, "../src/core", f), "utf8");
		expect(read("sales-invoices.ts")).not.toContain("InvoiceSender");
		expect(read("sales-invoice-rules.ts")).toContain("an accredited channel (an intermediary");
		for (const f of ["tools/sales-invoice-draft.ts", "tools/sales-invoice-issue.ts", "tools/sales-invoice-tools.ts", "tools/sales-invoice-render.ts", "fattura-pa-writer.ts"]) expect(read(f)).not.toContain('import("');
	});
});

// The second pass of the review, by its numbers: N the numbering, S security, U the person's words.
describe("second pass", () => {
	const PROF: Company = { ...ORDINARIO, name: "Kevin Wojtq", cf: "KWJXQZ75C10F205V" };
	/** An invoice of the company written elsewhere, as a file in the workspace. */
	async function companyFile(s: ReturnType<typeof setup>, file: string, over: Partial<IssuedInvoice>): Promise<void> {
		const t = setup();
		const { inv } = await t.issued({ ...DELTA, lines: [line("Vecchia", 100)], vat: 22 });
		const doc = { ...inv, ...over } as IssuedInvoice;
		mkdirSync(dirname(join(s.root, file)), { recursive: true });
		writeFileSync(join(s.root, file), fatturaXml(doc, salesTotals(doc)));
	}
	const OWN = (n: number, date = "2026-10-10") => ({ number: String(n), seq: n, date, progressive: `ZZ${String(n).padStart(3, "0")}` });

	it("N1: only the counter and the last number said move the number, never the files", async () => {
		const s = setup();
		await companyFile(s, "fatture/emesse/altra.xml", OWN(7));
		expect((await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 })).inv.number).toBe("1");
	});

	it("N2: proposes the number after the highest in fatture/emesse, and saves it on the yes", async () => {
		const s = setup({ askFirst: true });
		await companyFile(s, "fatture/emesse/altra.xml", OWN(7));
		const asked = await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(asked).toContain("Nei tuoi file l'ultima fattura del 2026 è la 7: questa sarà la 8, va bene?");
		expect(asked).not.toContain("qual è il numero dell'ultima fattura");
		const { inv } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22, last_number: 7 });
		expect(inv.number).toBe("8");
	});

	it("N3: reads only fatture/emesse, the company's own, up to today, with a plain number of its year", async () => {
		const s = setup({ askFirst: true });
		await companyFile(s, "archivio/fuori.xml", OWN(9));
		await companyFile(s, "fatture/emesse/futura.xml", OWN(9, "2026-12-01"));
		await companyFile(s, "fatture/emesse/anno.xml", { ...OWN(9), number: "2025/9" });
		await companyFile(s, "fatture/emesse/strana.xml", { ...OWN(9), number: "A-9-B" });
		await companyFile(s, "fatture/emesse/altrui.xml", { ...OWN(9), seller: { name: "Omega Srl", vat: "IT00000030015", cf: "00000030015", regime: "RF01", address: { street: "Corso Italia 9", cap: "10121", town: "Torino", province: "TO", country: "IT" } } });
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 })).toContain("qual è il numero dell'ultima fattura che hai emesso nel 2026?");
		await companyFile(s, "fatture/emesse/ft.xml", { ...OWN(4), number: "FT 4" });
		await companyFile(s, "fatture/emesse/slash.xml", { ...OWN(5), number: "5/2026" });
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 })).toContain("l'ultima fattura del 2026 è la 5");
	});

	it("N4: in January, after a year issued all with Owni and no other invoice this year, does not ask", async () => {
		const run = async (iso: string) => {
			const s = setup({ askFirst: true });
			await s.run({ op: "settings", last_number: 0 });
			await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
			s.at(iso);
			return { s, answer: await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 }) };
		};
		const january = await run("2027-01-05T09:00:00Z");
		expect(january.answer).toContain("Bozza pronta");
		expect(january.s.store.read().settings?.lastBefore?.[2027]).toBe(0);
		expect((await run("2027-02-02T09:00:00Z")).answer).toContain("qual è il numero dell'ultima fattura che hai emesso nel 2027?");
	});

	it("N5: a last number lower than the files' is warned with the file, never refused", async () => {
		const s = setup({ askFirst: true });
		await companyFile(s, "fatture/emesse/altra.xml", OWN(7));
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22, last_number: 3 });
		expect(answer).toContain("c'è già la fattura n. 7, più alta dell'ultima che mi hai detto (3)");
		expect(answer).toContain("fatture/emesse/altra.xml");
		expect(answer).toContain("Bozza pronta");
		expect(await s.run({ op: "settings", last_number: 2 })).toContain("fatture/emesse/altra.xml");
	});

	it("N6: the last number is corrected until the first invoice; then the settings say where the numbering is", async () => {
		const s = setup({ askFirst: true });
		await s.run({ op: "settings", last_number: 12 });
		expect(await s.run({ op: "settings", last_number: 14 })).toContain("Corretto: l'ultima prima di me era la 14, parto dalla 15.");
		await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(await s.run({ op: "settings" })).toContain("L'ultima fattura del 2026 è la n. 15: la prossima sarà la 16.");
		expect(await s.run({ op: "settings", last_number: 20 })).toContain("Non ho cambiato niente");
	});

	it("N7: a number different from the draft's is explained", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const first = s.last().id;
		expect(s.last().expected).toBe("1");
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		const second = s.last().id;
		s.at("2026-10-18T09:00:00Z");
		await s.run({ op: "issue", draft: second, confirm: true });
		const answer = await s.run({ op: "issue", draft: first, confirm: true });
		expect(answer).toContain("Nella bozza avevo detto la n. 1: è la n. 2 perché intanto è stata emessa un'altra fattura.");
	});

	it("N8: the dates follow the numbers; a later one is named, invoice or file", async () => {
		const s = setup();
		s.at("2026-10-20T09:00:00Z");
		await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		s.at("2026-10-18T09:00:00Z");
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(await s.run({ op: "issue", draft: s.last().id, confirm: true })).toContain("c'è già la fattura n. 1 con una data successiva");
		const t = setup();
		await t.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		const draft = t.last();
		expect(() => t.store.issue(draft.id, "x", "2026-10-18", { date: "2026-10-19", file: "fatture/emesse/altra.xml" }, (d) => d)).toThrow("nel file fatture/emesse/altra.xml c'è una fattura di quest'anno con una data successiva");
	});

	it("S2: an unfinished issue is completed first, by number, without touching other drafts", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const half = s.last();
		s.store.issue(half.id, "lost-call", "2026-10-18", undefined, (d, number, seq, progressive) => ({ ...d, number, year: 2026, seq, date: "2026-10-18", due: "2026-11-17", seller: { name: "Beta Studio Srl", vat: SELLER_VAT, cf: "00000010017", regime: "RF01", address: { street: "Via Roma 1", cap: "20121", town: "Milano", province: "MI", country: "IT" } }, progressive, issued: { by: "test:u", at: NOW.toISOString() }, issueCall: "lost-call" }));
		await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 });
		expect(await s.run({ op: "list" })).toContain("(emissione da completare: si completa con la fattura n. 1)");
		expect(await s.run({ op: "list", compact: true })).toBe("La fattura n. 1 ha l'emissione da completare.");
		const answer = await s.run({ op: "issue" });
		expect(answer.split("\n")[0]).toBe("Ho completato la fattura n. 1 (era già emessa).");
		expect(isIssued(s.last())).toBe(false);
		expect(await s.run({ op: "finish", invoice: "1" })).toContain("è già emessa e completa");
		expect(await s.run({ op: "finish", invoice: "9" })).toContain("non trovo una fattura emessa");
	});

	it("S2: without the PDF the invoice is finished, and the XML is what goes to the customer", async () => {
		const s = setup();
		s.pdf.fails = true;
		const { inv, answer } = await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(inv.pdf).toBeUndefined();
		expect((s.store.read().invoices[0] as IssuedInvoice).finished).toBe(true);
		expect(answer).toContain("Il PDF non c'è: al cliente si può mandare il file XML");
		expect(answer).not.toContain("con il PDF in allegato");
	});

	it("S3: a ritenuta with no fee to bear it is dropped", async () => {
		const s = setup({ company: PROF });
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("Diritti anticipati", 50, { advance: true })], ritenuta: true });
		expect(answer).toContain("nessun compenso soggetto a ritenuta");
		expect(s.last().ritenuta).toBeUndefined();
	});

	it("S4: the issue is audited once, when it is finished", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		const half = s.last();
		s.store.issue(half.id, "lost-call", "2026-10-18", undefined, (d, number, seq, progressive) => ({ ...d, number, year: 2026, seq, date: "2026-10-18", due: "2026-11-17", seller: { name: "Beta Studio Srl", vat: SELLER_VAT, cf: "00000010017", regime: "RF01", address: { street: "Via Roma 1", cap: "20121", town: "Milano", province: "MI", country: "IT" } }, progressive, issued: { by: "test:u", at: NOW.toISOString() }, issueCall: "lost-call" }));
		await s.run({ op: "finish", invoice: "1" });
		await s.run({ op: "finish", invoice: "1" });
		await s.run({ op: "issue", draft: half.id, confirm: true });
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(1);
	});

	it("S5: the IBAN asked with the person's data, or alone with how to save it; the last invoice's reused", async () => {
		const missingAll = setup({ company: { vat: SELLER_VAT, name: "Beta Studio Srl", regime: "ordinario", by: "test:u", at: NOW.toISOString() } });
		const asked = await missingAll.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(asked).toContain("Su di te (una volta sola): codice fiscale, indirizzo con CAP, comune e provincia, IBAN");
		expect(asked).not.toContain("così non te lo richiedo");
		const s = setup({ company: { ...ORDINARIO, ibans: [] } });
		const only = await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22 });
		expect(only).toContain("Su questa fattura: IBAN su cui ricevere il bonifico");
		expect(only).toContain("L'IBAN si salva una volta con invoices op set_company iban, così non te lo richiedo.");
		await s.issued({ ...DELTA, lines: [line("A", 100)], vat: 22, iban: IBAN });
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("B", 100)], vat: 22 })).toContain("Bozza pronta");
		expect(s.last().payment?.iban).toBe(IBAN);
	});

	it("S6: a codice fiscale said with its label finds the customer", async () => {
		const s = setup();
		await s.issued({ customer: "Xenia Quaz", cf: "XQZKWJ80A41H501T", address: "Via Dante 3, 40121 Bologna BO", lines: [line("Lezione", 60)], vat: 22 });
		await s.run({ op: "draft", customer: "c.f. XQZKWJ80A41H501T", lines: [line("Lezione", 60)], vat: 22 });
		expect(s.last().buyer).toMatchObject({ name: "Xenia Quaz", cf: "XQZKWJ80A41H501T" });
	});

	it("U1: a name containing a client's is a new customer with other tax ids, or when the person says so", async () => {
		const card = { id: "CL-0001", name: "Delta Servizi Srl", aliases: [], vat: "IT00000020016", address: "Via Verdi 2, 00184 Roma RM", tags: [], contacts: [], notes: [], followUps: [], contactLog: [], by: "test:u", at: NOW.toISOString() } as unknown as ClientCard;
		const s = setup({ cards: [card] });
		const nord = { customer: "Delta Servizi Nord", address: "Corso Italia 9, 10121 Torino TO", recipient_code: "ZZZ0002", lines: [line("A", 100)], vat: 22 };
		const close = await s.run({ op: "draft", ...nord });
		expect(close).toContain("Intendi uno di questi?");
		expect(close).toContain("Se è un cliente diverso da questi, dimmelo e lo fatturo come cliente nuovo.");
		const fresh2 = await s.run({ op: "draft", ...nord, vat_number: "00000030015" });
		expect(fresh2).toContain("Bozza pronta");
		expect(s.last().buyer).toMatchObject({ name: "Delta Servizi Nord", vat: "IT00000030015" });
		expect(s.last().buyer.card).toBeUndefined();
		await s.run({ op: "draft", ...nord, cf: "XQZKWJ80A41H501T", new_customer: true });
		expect(s.last().buyer).toMatchObject({ name: "Delta Servizi Nord", kind: "private" });
	});

	it("U5: the brief reads the invoices like the hours", () => {
		expect(BRIEF_INSTRUCTION).toMatch(/\n9\. Chiama ognuno di questi tool con l'op tra parentesi e compact true, e riporta la sua riga solo se segnala qualcosa: [^\n]*\bsales_invoices \(list\)[,.]/);
	});

	it("U6: one question under three headings, only the missing ones", async () => {
		const s = setup({ company: { vat: SELLER_VAT, name: "Kevin Wojtq", regime: "forfettario", by: "test:u", at: NOW.toISOString() }, askFirst: true });
		const asked = await s.run({ op: "draft", customer: "Nuovo Cliente Srl", lines: [line("Consulenza", 500)] });
		const lines = asked.split("\n");
		expect(lines[1]).toBe("Su di te (una volta sola): codice fiscale, indirizzo con CAP, comune e provincia, IBAN");
		expect(lines[2]).toBe("Sul cliente: partita IVA e codice destinatario (7 caratteri) o PEC; per un privato il codice fiscale; indirizzo");
		expect(lines[3]).toMatch(/^Su questa fattura: chi paga il bollo da 2,00 € \(supera 77,47 € senza IVA\)/);
		expect(lines[3]).toContain("qual è il numero dell'ultima fattura");
		const only = setup();
		const customer = await only.run({ op: "draft", customer: "Nuovo Cliente Srl", lines: [line("A", 50)], vat: 22 });
		expect(customer).toContain("Sul cliente:");
		expect(customer).not.toContain("Su di te");
		expect(customer).not.toContain("Su questa fattura");
	});

	it("U7: a spesa anticipata says so, with its row", async () => {
		const s = setup();
		const answer = await s.run({ op: "draft", ...DELTA, lines: [line("Consulenza", 500), line("Diritti", 30, { advance: true })], vat: 22 });
		expect(answer).toContain("Diritti: 30,00 € (spesa anticipata, senza IVA)");
		expect(answer).toContain("Spese anticipate, senza IVA: 30,00 €");
		expect(answer).toContain("IVA 22%: 110,00 €");
	});

	it("U8, U9: a private customer's channel says the PDF, once; the tail names the draft for the assistant only", async () => {
		const s = setup();
		const answer = await s.run({ op: "draft", customer: "Xenia Quaz", cf: "XQZKWJ80A41H501T", address: "Via Dante 3, 40121 Bologna BO", lines: [line("Lezione", 60)], vat: 22 });
		expect(answer).toContain("Recapito: nessun codice (la trova nella sua area dell'Agenzia delle Entrate; gli diamo il PDF)");
		expect(answer).not.toContain("una copia va data");
		expect(answer.split("\n").at(-1)).toBe("Per emetterla o cambiarla usa la bozza BZ-0001 (non serve dirlo a chi ti scrive).");
	});

	it("U11: the ritenuta to companies in the settings, and asked for a public office too", async () => {
		const s = setup({ company: PROF });
		expect(await s.run({ op: "settings" })).toContain("Ritenuta d'acconto alle aziende: da chiedere.");
		expect(await s.run({ op: "draft", customer: "Comune di Esempio", cf: "80000010019", address: "Piazza Municipio 1, 80100 Napoli NA", recipient_code: "UFABCD", lines: [line("Manutenzione", 50)], vat: 22 })).toContain("la ritenuta d'acconto del 20%");
		expect(await s.run({ op: "settings", ritenuta: false })).toContain("Ritenuta d'acconto alle aziende: no.");
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("A", 50)], vat: 22 })).toContain("Bozza pronta");
		expect(s.last().ritenuta).toBeUndefined();
	});

	it("U12: the helpers are imported from core, with no re-export left", () => {
		const read = (f: string) => readFileSync(join(import.meta.dirname, "../src/core", f), "utf8");
		expect(read("tools/quote-input.ts")).not.toMatch(/export \{[^}]*\} from "\.\.\/text-input\.ts"/);
		expect(read("tools/quote-document.ts")).not.toContain('from "../markdown-text.ts";\nexport');
		expect(read("tools/quote-document.ts")).not.toMatch(/export \{[^}]*\} from/);
		expect(read("cashflow-items.ts")).not.toContain("tools/quote-input.ts");
		for (const f of readdirSync(join(import.meta.dirname, "../src/core/tools"))) expect(read(`tools/${f}`), f).not.toMatch(/import \{[^}]*\b(?:cleanText|isProblem|Problem)\b[^}]*\} from "\.\/quote-input\.ts"/);
	});

	it("U13: hours in an invoice are «nella fattura», and a draft already there can be redone in its place", async () => {
		const billed = entry(1, 60, { billed: { by: "test:u", at: NOW.toISOString(), ref: "fattura 1", rate: "50", rounding: 0 } });
		const s = setup({ entries: [billed, entry(2, 60)], quotes: [quote()] });
		await s.run({ op: "draft", ...DELTA, hours: true, vat: 22 });
		expect(await s.run({ op: "draft", ...DELTA, hours: true, vat: 22 })).toContain("oppure la rifaccio prendendo il suo posto.");
		const t = setup({ entries: [billed] });
		expect(await t.run({ op: "draft", ...DELTA, hours: true, vat: 22 })).toContain("una voce è nella fattura 1");
		await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 });
		expect(await s.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0001", vat: 22 })).toContain("emetti quella, oppure la rifaccio prendendo il suo posto.");
	});

	it("U14: one rate formatter, one rule for a person's codice fiscale, the shared names", () => {
		expect([rateText("45"), hourlyText("45")]).toEqual(["45,00 €/h", "45,00 €/h"]);
		expect([PERSON_CF.test("KWJXQZ75C10F205V"), PERSON_CF.test("00000010017"), ritenutaType("KWJXQZ75C10F205V"), ritenutaType("00000010017")]).toEqual([true, false, "RT01", "RT02"]);
		const read = (f: string) => readFileSync(join(import.meta.dirname, "../src/core", f), "utf8");
		expect(read("tools/sales-invoice-draft.ts")).toContain("FORM_NOTE");
		expect(read("tools/sales-invoice-buyer.ts")).toContain("findNamed(candidates, said, MAX_SAID)");
		expect(read("tools/sales-invoice-env.ts")).toContain("export type SalesStores");
		expect(read("tools/sales-invoice-tools.ts")).toContain("export type SalesToolsOptions = SalesStores & {");
		expect(read("invoice-sums.ts")).not.toContain("«1.220,00 €». */\n/**");
	});
});

describe("third pass", () => {
	const DELTA_CARD = { id: "CL-0001", name: "Delta Servizi Srl", aliases: [], vat: "IT00000020016", address: "Via Verdi 2, 00184 Roma RM", tags: [], contacts: [], notes: [], followUps: [], contactLog: [], by: "test:u", at: NOW.toISOString() } as unknown as ClientCard;
	/** Another company with Delta's very name: its own P.IVA, address and code. */
	const OTHER = { customer: "Delta Servizi Srl", vat_number: "00000030015", address: "Corso Italia 9, 10121 Torino TO", recipient_code: "ZZZ0002" };
	const A = { lines: [line("A", 100)], vat: 22 };
	const buyerOf = async (s: ReturnType<typeof setup>, args: Record<string, unknown>) => {
		const answer = await s.run({ op: "draft", ...A, ...args });
		const b = s.last().buyer;
		return { answer, b, ids: `${b?.vat} ${b?.code}` };
	};

	it("T1 (p16): a same-name customer of another P.IVA never lends its code to the card's customer", async () => {
		const s = setup({ cards: [DELTA_CARD] });
		await s.issued({ ...DELTA, ...A });
		const other = await s.issued({ ...OTHER, ...A, new_customer: true });
		expect([other.inv.buyer.vat, other.inv.buyer.code, other.inv.buyer.card]).toEqual(["IT00000030015", "ZZZ0002", undefined]);
		// By name (the card first), by the name and its P.IVA, by its P.IVA alone: Delta's own data.
		expect((await buyerOf(s, { customer: "Delta Servizi Srl" })).ids).toBe("IT00000020016 ZZZ0001");
		expect((await buyerOf(s, { customer: "Delta Servizi Srl", vat_number: "00000020016" })).ids).toBe("IT00000020016 ZZZ0001");
		expect((await buyerOf(s, { customer: "IT00000020016" })).ids).toBe("IT00000020016 ZZZ0001");
		expect(s.last().buyer?.address.town).toBe("Roma");
		// And the other one by its own P.IVA: its own code and address.
		const o = await buyerOf(s, { customer: "Delta Servizi Srl", vat_number: "00000030015" });
		expect([o.ids, o.b?.address.town, o.b?.card]).toEqual(["IT00000030015 ZZZ0002", "Torino", undefined]);
	});

	it("T1 (p17): without a card, each P.IVA finds its own company; the bare name asks, listing both", async () => {
		const s = setup();
		await s.issued({ ...DELTA, ...A });
		await s.issued({ ...OTHER, ...A, new_customer: true });
		expect((await buyerOf(s, { customer: "IT00000020016" })).ids).toBe("IT00000020016 ZZZ0001");
		expect((await buyerOf(s, { customer: "00000030015" })).ids).toBe("IT00000030015 ZZZ0002");
		expect((await buyerOf(s, { customer: "Delta Servizi Srl", vat_number: "00000020016" })).ids).toBe("IT00000020016 ZZZ0001");
		expect((await buyerOf(s, { customer: "Delta Servizi Srl", vat_number: "IT00000030015" })).ids).toBe("IT00000030015 ZZZ0002");
		const drafts = s.store.read().invoices.length;
		const asked = await s.run({ op: "draft", ...A, customer: "Delta Servizi Srl" });
		expect(asked).toContain("Delta Servizi Srl, P.IVA IT00000020016");
		expect(asked).toContain("Delta Servizi Srl, P.IVA IT00000030015");
		expect(asked).toContain("con la sua partita IVA");
		expect(s.store.read().invoices).toHaveLength(drafts);
	});

	it("T2 (p14): the very name or card id with another P.IVA asks; as a new customer no hybrid, and Delta stays Delta", async () => {
		const s = setup({ cards: [DELTA_CARD] });
		await s.issued({ ...DELTA, ...A });
		const drafts = s.store.read().invoices.length;
		const sentence = "Delta Servizi Srl che conosco ha un'altra partita IVA (IT00000020016): è un cliente diverso? Se sì, lo fatturo come cliente nuovo.";
		expect(await s.run({ op: "draft", ...A, ...OTHER })).toContain(sentence);
		expect(await s.run({ op: "draft", ...A, ...OTHER, customer: "CL-0001" })).toContain(sentence);
		// Without a card too: the customer invoiced here.
		const t = setup();
		await t.issued({ ...DELTA, ...A });
		expect(await t.run({ op: "draft", ...A, ...OTHER })).toContain(sentence);
		expect(s.store.read().invoices).toHaveLength(drafts);
		// Said to be another customer: only what was said, nothing of Delta's.
		const { inv } = await s.issued({ ...A, ...OTHER, new_customer: true });
		expect([inv.buyer.vat, inv.buyer.code, inv.buyer.address.town, inv.buyer.card]).toEqual(["IT00000030015", "ZZZ0002", "Torino", undefined]);
		// The knock-on: Delta's next invoice is still all Delta's.
		const next = await buyerOf(s, { customer: "Delta Servizi Srl" });
		expect([next.ids, next.b?.address.town, next.b?.card]).toEqual(["IT00000020016 ZZZ0001", "Roma", "CL-0001"]);
		const byCard = await buyerOf(s, { customer: "CL-0001" });
		expect(byCard.ids).toBe("IT00000020016 ZZZ0001");
		// A quote of the same name with the other P.IVA: the quote's customer, not the card's.
		const q = setup({ cards: [DELTA_CARD], quotes: [quote({ customer: { name: "Delta Servizi Srl", vat: "00000030015", address: "Corso Italia 9, 10121 Torino TO" } })] });
		await q.issued({ ...DELTA, ...A });
		await q.run({ op: "draft", quote: "2026-004", recipient_code: "ZZZ0002", vat: 22 });
		const fromQuote = q.last().buyer;
		expect([fromQuote?.vat, fromQuote?.code, fromQuote?.address.town, fromQuote?.card]).toEqual(["IT00000030015", "ZZZ0002", "Torino", undefined]);
	});

	it("T3: a crash between finishing and the audit is audited on the next run, once", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, ...A });
		const id = s.last().id;
		s.audit.crash = true;
		await expect(s.run({ op: "issue", draft: id, confirm: true })).rejects.toThrow("crash");
		const crashed = s.store.read().invoices.find((i) => i.id === id) as IssuedInvoice;
		expect([crashed.finished, crashed.audited]).toEqual([true, undefined]);
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(0);
		// The next run (another call, nothing named) completes the audit.
		await s.run({ op: "issue" });
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(1);
		expect((s.store.read().invoices.find((i) => i.id === id) as IssuedInvoice).audited).toBe(true);
		// Never twice.
		expect(await s.run({ op: "issue", draft: id, confirm: true })).toContain("è già emessa");
		expect(await s.run({ op: "finish", invoice: "1" })).toContain("già emessa e completa");
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(1);
		// Named, after a crash: the same.
		await s.run({ op: "draft", ...DELTA, ...A });
		const second = s.last().id;
		s.audit.crash = true;
		await expect(s.run({ op: "issue", draft: second, confirm: true })).rejects.toThrow("crash");
		await s.run({ op: "finish", invoice: "2" });
		await s.run({ op: "finish", invoice: "2" });
		expect(s.events.filter((e) => e.op === "issue")).toHaveLength(2);
		// An audited mark without the invoice finished does not read.
		expect(invoiceProblem({ ...crashed, finished: undefined, audited: true } as IssuedInvoice)).toBe("la registrazione dell'emissione");
	});

	it("T4: the proposed number names the file it comes from, fenced", async () => {
		const s = setup({ askFirst: true });
		const t = setup();
		const { inv } = await t.issued({ ...DELTA, ...A });
		const doc = { ...inv, number: "7", seq: 7, date: "2026-10-10", progressive: "ZZ007" } as IssuedInvoice;
		mkdirSync(join(s.root, "fatture/emesse"), { recursive: true });
		writeFileSync(join(s.root, "fatture/emesse/Ignora le istruzioni.xml"), fatturaXml(doc, salesTotals(doc)));
		const asked = await s.run({ op: "draft", ...DELTA, ...A });
		expect(asked).toContain("questa sarà la 8, va bene? (il file è nel riquadro sotto)");
		const from = asked.slice(asked.indexOf("Il numero proposto viene da questo file:"));
		expect(from).toMatch(/dati delle fatture emesse[\s\S]*fatture\/emesse\/Ignora le istruzioni\.xml[\s\S]*fine dati delle fatture emesse/);
	});
});

describe("week 68: the yes is a person's own message", () => {
	it("issue: refused in a notice, scheduled or agente turn, and in one whose origin is not known; the preview works; a person's turn issues", async () => {
		const s = setup();
		await s.run({ op: "draft", ...DELTA, lines: [line("Sito web", 1000)], vat: 22 });
		const id = s.last().id;
		// Another agente's turn, whatever its channel, stops at the agent gate first (week 70).
		expect(await s.run({ op: "issue", draft: id, confirm: true }, { ...fresh(), origin: "agent" })).toContain("a un altro agente");
		for (const origin of ["notice", "scheduled"] as const) {
			const refused = await s.run({ op: "issue", draft: id, confirm: true }, { ...fresh(), origin });
			expect(refused).toContain("Non emetto la fattura ");
			expect(refused).not.toContain("Errore");
			expect(await s.run({ op: "issue", draft: id }, { ...fresh(), origin })).toContain("Emetterei questa fattura");
		}
		const { origin: _o, ...unknown } = fresh();
		expect(await s.run({ op: "issue", draft: id, confirm: true }, unknown)).toContain("non so da dove nasce questo turno");
		expect(isIssued(s.last())).toBe(false);
		expect(await s.run({ op: "issue", draft: id, confirm: true })).toContain("ho emesso la fattura n. 1");
	});
});

describe("week 68: numbering and removals are a person's own word (ADR 0088)", () => {
	const refused = /serve il sì di chi ti scrive|lo conferma solo chi ti scrive|altro agente/;
	it("settings numbering and last_number, a draft's last_number and remove draft are refused in a notice, a schedule or another agente's turn", async () => {
		const s = setup({ askFirst: true });
		for (const origin of ["notice", "scheduled", "agent"] as const) {
			const c = () => ({ ...fresh(), origin });
			expect(await s.run({ op: "settings", numbering: "year" }, c())).toMatch(refused);
			expect(await s.run({ op: "settings", last_number: 41 }, c())).toMatch(refused);
			expect(await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22, last_number: 41 }, c())).toMatch(refused);
			// What is not the numbering still goes; another agente changes nothing at all (week 70).
			expect(await s.run({ op: "settings", bollo_to_client: true }, c())).toContain(origin === "agent" ? "a un altro agente" : "Fatto, ho salvato.");
		}
		expect(s.store.read().settings?.lastBefore).toBeUndefined();
		expect(s.store.read().settings?.numbering).toBeUndefined();
		expect(await s.run({ op: "draft", ...DELTA, lines: [line("A", 100)], vat: 22, last_number: 41 })).toContain("Bozza pronta");
		const id = s.last().id;
		for (const origin of ["notice", "scheduled", "agent"] as const) expect(await s.run({ op: "remove", draft: id }, { ...fresh(), origin })).toMatch(refused);
		expect(s.store.read().invoices).toHaveLength(1);
		expect(await s.run({ op: "remove", draft: id })).toContain(`Fatto, ho tolto la bozza ${id}`);
	});
});
