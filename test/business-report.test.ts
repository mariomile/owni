import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { briefSpeaks, businessAgentReads, businessCallReads, type Figures, REPORT_LIMITS } from "../src/core/business-report.ts";
import { biggest, comparedTo, deltas, lastMonths, lastYearSpan, monthsOf, readAgainst, signedPercent, spanBefore, yearBack } from "../src/core/business-report-compare.ts";
import { figuresIn, presenceOf, receivablesOf, sourcesOf } from "../src/core/business-report-sums.ts";
import { reportConcentrated } from "../src/core/business-report-top.ts";
import { maybeTwins, pairPaidWithExpenses, rollForward } from "../src/core/cashflow-sources.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { ExpenseStore } from "../src/core/expense-store.ts";
import type { Expense } from "../src/core/expenses.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { type Invoice, type Regime, register } from "../src/core/invoices.ts";
import { dayOfIn } from "../src/core/italian-calendar.ts";
import { halfUp } from "../src/core/quote-sums.ts";
import type { Quote } from "../src/core/quotes.ts";
import type { SalesInvoice } from "../src/core/sales-invoices.ts";
import type { SalesBook } from "../src/core/sales-invoice-store.ts";
import { SCHEDULE_LIMITS } from "../src/core/schedules.ts";
import type { TaxProfile } from "../src/core/taxes.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { currentEstimate, yearEstimate, yearIncassi } from "../src/core/tax-sums.ts";
import type { WorkEntry } from "../src/core/timesheet.ts";
import { type BusinessReportEvent, createBusinessReportTools } from "../src/core/tools/business-report-tools.ts";
import { readAsked } from "../src/core/tools/business-report-input.ts";
import { spanWords } from "../src/core/periods.ts";
import { BRIEF_NOTHING, compareAnswer, EMPTY, loadNotes, TAX_NOTE } from "../src/core/tools/business-report-render.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic identifiers only: checksum-valid fake partite IVA.
const COMPANY = { name: "Studio Prova Srl", vat: "00000010017" };
const CLIENT1 = { name: "Cliente Uno Srl", vat: "00000020016" };
const CLIENT2 = { name: "Cliente Due Srl", vat: "00000030015" };
const SUPPLIER = { name: "Fornitore Tre Srl", vat: "11111110018" };

const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
const TODAY = "2026-10-18";
const dayOf = dayOfIn("Europe/Rome");
let calls = 0;
const fresh = (callId = `c${++calls}`, thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" });

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-report-"));
	dirs.push(dir);
	return dir;
}

type Party = { name: string; vat?: string };
type Riepilogo = { rate: string; taxable: string; tax: string };
const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r22 = (taxable: string): Riepilogo => ({ rate: "22.00", taxable, tax: (Number(taxable) * 0.22).toFixed(2) });

/** A FatturaPA file with its DatiRiepilogo rows and its instalments (one, the whole total, by default). */
function xml(from: Party, to: Party, o: { number: string; date: string; type?: string; rows: Riepilogo[]; due?: string; rate?: { amount: string; due: string }[] }): string {
	const party = (p: Party) => `<DatiAnagrafici>${p.vat === undefined ? "" : `<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${p.vat}</IdCodice></IdFiscaleIVA>`}<Anagrafica><Denominazione>${xmlText(p.name)}</Denominazione></Anagrafica></DatiAnagrafici>`;
	const total = o.rows.reduce((n, r) => n + Number(r.taxable) + Number(r.tax), 0).toFixed(2);
	const lines = o.rows.map((r, i) => `<DettaglioLinee><NumeroLinea>${i + 1}</NumeroLinea><Descrizione>Voce</Descrizione><PrezzoUnitario>${r.taxable}</PrezzoUnitario><PrezzoTotale>${r.taxable}</PrezzoTotale><AliquotaIVA>${r.rate}</AliquotaIVA></DettaglioLinee>`).join("");
	const summary = o.rows.map((r) => `<DatiRiepilogo><AliquotaIVA>${r.rate}</AliquotaIVA><ImponibileImporto>${r.taxable}</ImponibileImporto><Imposta>${r.tax}</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo>`).join("");
	const rates = o.rate ?? [{ amount: total, due: o.due ?? o.date }];
	const pay = `<DatiPagamento><CondizioniPagamento>${rates.length > 1 ? "TP01" : "TP02"}</CondizioniPagamento>${rates.map((r) => `<DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>${r.due}</DataScadenzaPagamento><ImportoPagamento>${r.amount}</ImportoPagamento></DettaglioPagamento>`).join("")}</DatiPagamento>`;
	const generali = `<TipoDocumento>${o.type ?? "TD01"}</TipoDocumento><Divisa>EUR</Divisa><Data>${o.date}</Data><Numero>${xmlText(o.number)}</Numero><ImportoTotaleDocumento>${total}</ImportoTotaleDocumento>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione><CedentePrestatore>${party(from)}</CedentePrestatore><CessionarioCommittente>${party(to)}</CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>${generali}</DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi>${lines}${summary}</DatiBeniServizi>${pay}</FatturaElettronicaBody></p:FatturaElettronica>`;
}

/** An issued fattura in uscita as the sales store keeps it, to Cliente Uno. */
function sale(number: string, date: string, price: string): SalesInvoice {
	const marker = { by: "test:u", at: NOW.toISOString() };
	return {
		id: `BZ-${number}`,
		type: "TD01",
		regime: "RF01",
		buyer: { name: CLIENT1.name, kind: "business", vat: `IT${CLIENT1.vat}`, address: { street: "Via Prova 1", zip: "00100", city: "Roma", province: "RM", country: "IT" }, code: "0000000" },
		lines: [{ description: "Consulenza", quantity: "1", price, vat: 22 }],
		callId: `call-${number}`,
		number,
		year: Number(date.slice(0, 4)),
		seq: 1,
		date,
		seller: { name: COMPANY.name, vat: `IT${COMPANY.vat}`, cf: COMPANY.vat, regime: "RF01", address: { street: "Via Prova 2", zip: "00100", city: "Roma", province: "RM", country: "IT" } },
		progressive: "00001",
		issued: marker,
		...marker,
	} as unknown as SalesInvoice;
}
const salesBook = (invoices: SalesInvoice[], broken = false): SalesBook => ({ next: {}, nextDraft: 1, nextFile: 1, invoices, calls: [], broken }) as unknown as SalesBook;

/**
 * October 2026 to the 18th: issued FV-2 (500, in two instalments, the first paid on the 16th),
 * FV-3 (2.000, overdue since Monday 12th) and the credit note NC-1 (100, open); FV-1 (Sept, 1.000)
 * paid at 00:30 of 1 October in Rome (22:30 UTC of 30 September). Received A-1 (paid, with its
 * expense) and A-2 (paid, no expense). September: FV-0 paid, the renewal's payment recorded and its
 * supplier invoice B-9 paid the next day (counted once). October 2025: FV-L, paid.
 */
const FILES: Record<string, string> = {
	"f/fv0.xml": xml(COMPANY, CLIENT2, { number: "FV-0", date: "2026-08-20", rows: [r22("800.00")], due: "2026-09-19" }),
	"f/fv1.xml": xml(COMPANY, CLIENT1, { number: "FV-1", date: "2026-09-10", rows: [r22("1000.00")], due: "2026-10-10" }),
	"f/fv2.xml": xml(COMPANY, CLIENT2, { number: "FV-2", date: "2026-10-05", rows: [r22("500.00")], rate: [{ amount: "305.00", due: "2026-10-15" }, { amount: "305.00", due: "2026-11-15" }] }),
	"f/fv3.xml": xml(COMPANY, CLIENT1, { number: "FV-3", date: "2026-10-07", rows: [r22("2000.00")], due: "2026-10-12" }),
	"f/nc1.xml": xml(COMPANY, CLIENT1, { number: "NC-1", date: "2026-10-09", type: "TD04", rows: [r22("100.00")] }),
	"f/fvl.xml": xml(COMPANY, CLIENT1, { number: "FV-L", date: "2025-10-10", rows: [r22("1500.00")], due: "2025-11-10" }),
	"f/a1.xml": xml(SUPPLIER, COMPANY, { number: "A-1", date: "2026-10-02", rows: [r22("100.00")], due: "2026-10-10" }),
	"f/a2.xml": xml(SUPPLIER, COMPANY, { number: "A-2", date: "2026-10-03", rows: [r22("200.00")], due: "2026-10-12" }),
	"f/b9.xml": xml(SUPPLIER, COMPANY, { number: "B-9", date: "2026-09-18", rows: [{ rate: "22.00", taxable: "245.90", tax: "54.10" }], due: "2026-09-21" }),
};
/** Number → when it was marked paid; «FV-2#1»: one instalment. */
const PAID: Record<string, string> = {
	"FV-0": "2026-09-15T10:00:00.000Z",
	"FV-1": "2026-09-30T22:30:00.000Z",
	"FV-2#1": "2026-10-16T09:00:00.000Z",
	"FV-L": "2025-10-20T10:00:00.000Z",
	"A-1": "2026-10-10T08:00:00.000Z",
	"A-2": "2026-10-12T08:00:00.000Z",
	"B-9": "2026-09-21T08:00:00.000Z",
};

const expense = (id: string, date: string, amount: string, more: Partial<Expense> = {}): Expense => ({ id, date, amount, category: "altro", by: "u", at: `${date}T12:00:00.000Z`, ...more });
const EXPENSES: Expense[] = [
	expense("S-2026-0001", "2026-10-09", "122", { supplier: SUPPLIER.name, supplierVat: SUPPLIER.vat, docType: "fattura", docNumber: "A-1", category: "consulenze" }),
	expense("S-2026-0002", "2026-10-14", "50", { category: "carburante" }),
	// The renewal's payment, recorded by renewals through the expenses: B-9 paid the next day is the same money.
	expense("S-2026-0003", "2026-09-20", "300", { supplier: SUPPLIER.name, category: "software e abbonamenti" }),
	expense("S-2025-0001", "2025-10-05", "100"),
];

const quote = (number: string, date: string, status: Quote["status"], base = number, revision = 0): Quote => ({ number, base, revision, date, validDays: 30, customer: { name: CLIENT1.name }, lines: [{ description: "Sito", quantity: "1", price: "1000", vat: 22 }], status, by: "test:u", at: NOW.toISOString() });
const QUOTES: Quote[] = [quote("2026-001", "2026-10-02", "accepted"), quote("2026-002", "2026-10-05", "declined"), quote("2026-003", "2026-10-10", "open"), quote("2026-004", "2026-09-28", "superseded"), quote("2026-004-R1", "2026-10-03", "accepted", "2026-004", 1)];
const entry = (id: string, date: string, minutes: number): WorkEntry => ({ id, date, client: CLIENT1.name, minutes, billable: true, by: "test:u", at: NOW.toISOString() });
const ENTRIES: WorkEntry[] = [entry("O-2026-0001", "2026-10-06", 600), entry("O-2026-0002", "2026-10-13", 150), entry("O-2026-0003", "2026-09-10", 60)];

const GS_PROFILE: TaxProfile = { coefficient: "78", rate: "15", startYear: 2020, pension: { kind: "gestione_separata" }, by: "u", at: NOW.toISOString() };

type Setup = {
	files?: Record<string, string>;
	paid?: Record<string, string>;
	expenses?: Expense[] | "real";
	quotes?: Quote[];
	entries?: WorkEntry[];
	sales?: SalesInvoice[];
	salesBroken?: boolean;
	regime?: Regime;
	profile?: TaxProfile;
	company?: boolean;
	now?: Date;
	timeZone?: string;
};

async function setup(o: Setup = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	for (const [path, content] of Object.entries(o.files ?? FILES)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	const company = { vat: `IT${COMPANY.vat}`, name: COMPANY.name, ...(o.regime === undefined ? {} : { regime: o.regime }), by: "test:u", at: NOW.toISOString() };
	if (o.company !== false) invoices.setCompany(company);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const scan = await scanner.scan(new AbortController().signal);
	for (const i of register(scan.invoices, [], company)) {
		const paid = o.paid ?? PAID;
		const number = i.doc.number ?? "";
		const all = paid[number];
		if (all !== undefined) invoices.mark({ invoice: i.key, count: i.instalments.length, paid: true, by: "test:u", at: all });
		for (const [key, at] of Object.entries(paid)) {
			const [n, k] = key.split("#");
			if (n === number && k !== undefined) invoices.mark({ invoice: i.key, count: i.instalments.length, instalment: Number(k), paid: true, by: "test:u", at });
		}
	}
	const expenseStore = new ExpenseStore(dir);
	const expenses = o.expenses === "real" ? expenseStore : { read: () => ({ expenses: (o.expenses as Expense[] | undefined) ?? EXPENSES, broken: false }) };
	const taxes = new TaxStore(dir);
	if (o.profile !== undefined) {
		const profile = o.profile;
		taxes.update("setup", () => profile, []);
	}
	const events: BusinessReportEvent[] = [];
	const clock = { now: o.now ?? NOW };
	const [tool] = createBusinessReportTools({
		workspace,
		invoices,
		scanner,
		sales: { read: () => salesBook(o.sales ?? [], o.salesBroken === true) },
		expenses,
		quotes: { read: () => ({ quotes: o.quotes ?? QUOTES, broken: false }) },
		timesheet: { read: () => ({ entries: o.entries ?? ENTRIES, timers: [], rates: [], reservations: [], broken: false }) },
		taxes,
		timeZone: o.timeZone ?? "Europe/Rome",
		record: async (e) => {
			events.push(e);
		},
		now: () => clock.now,
	});
	if (tool === undefined) throw new Error("no tool");
	const registerNow = async (): Promise<Invoice[]> => {
		const b = invoices.read();
		return register((await scanner.scan(new AbortController().signal)).invoices, b.paid, b.company, b.reminders);
	};
	return {
		dir,
		root,
		tool,
		events,
		clock,
		invoices,
		registerNow,
		at: (iso: string) => {
			clock.now = new Date(iso);
		},
		run: async (args: Record<string, unknown>, ctx: ToolContext = fresh()) => String(await tool.execute(args, ctx)),
	};
}

const FENCE = /<<<dati dell'andamento ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati dell'andamento \1>>>/g;
const fences = (text: string) => [...text.matchAll(FENCE)];
const inside = (text: string) => fences(text).map((m) => m[2] as string).join("\n");
const outside = (text: string) => text.replace(FENCE, "");
const NO_EM_DASH = /\u2014/;

describe("business report: the figures of a period", () => {
	it("October so far: fatturato by invoice date with the credit note, incassato by the Rome day paid, spese once, margine", async () => {
		const s = await setup();
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("Ottobre 2026 fino al 18:");
		// FV-2 500 + FV-3 2.000 less NC-1 100; FV-1 is September's.
		expect(answer).toContain("• Fatturato: 2.400,00 € di imponibile (2 fatture, 1 nota di credito)");
		// FV-1 paid at 00:30 of 1 October in Rome, and FV-2's first instalment.
		expect(answer).toContain("• Incassato: 1.525,00 €");
		// 122 (A-1's own expense) + 50 + A-2 244 paid with no expense; A-1 not twice.
		expect(answer).toContain("• Spese: 416,00 € (2 spese registrate, 1 fattura di fornitore pagata)\n");
		expect(answer).toContain("• Margine: 1.109,00 €");
		expect(answer).toContain("• Ore lavorate: 12 ore e 30 minuti; fatturato diviso le ore registrate: 192,00 € l'ora");
		// 2026-004 was first made in September: not October's.
		expect(answer).toContain("• Preventivi: 3 fatti, 1 accettato (il 33%), 1 rifiutato, 1 aperto");
		// Open: FV-2's second 305 + FV-3 2.440 less NC-1 122.
		expect(answer).toContain("Ancora da incassare: 2.623,00 €, di cui 2.318,00 € scaduti (1 rata).");
		expect(answer).not.toMatch(NO_EM_DASH);
		expect(fences(answer)).toHaveLength(0);
		expect(answer).not.toContain(CLIENT1.name);
	});

	it("with no period: this month so far, then the year so far in one line", async () => {
		const s = await setup();
		const answer = await s.run({ op: "summary" });
		expect(answer.split("\n")[0]).toBe("Ottobre 2026 fino al 18:");
		// 976 (FV-0) + 1.220 + 305; spese 300 + 172 + 244.
		expect(answer).toContain("Dal 1º gennaio al 18 ottobre 2026: incassati 2.501,00 €, spese 716,00 €, margine 1.785,00 €.");
	});

	it("in another time zone the same mark falls on 30 September", async () => {
		const s = await setup({ timeZone: "UTC" });
		expect(await s.run({ op: "summary", period: "ottobre" })).toContain("• Incassato: 305,00 €");
		expect(await s.run({ op: "summary", period: "settembre" })).toContain("• Incassato: 2.196,00 €");
		const rome = await setup();
		expect(await rome.run({ op: "summary", period: "settembre" })).toContain("• Incassato: 976,00 €");
	});

	it("a renewal's payment and its supplier invoice paid the next day count once, as the expense", async () => {
		const s = await setup();
		const answer = await s.run({ op: "summary", period: "settembre" });
		expect(answer).toContain("• Spese: 300,00 € (1 spesa registrata)\n");
		expect(answer).toContain("• Margine: 676,00 €");
		// The rule is the cashflow's own.
		const invoices = await s.registerNow();
		const b9 = invoices.find((i) => i.doc.number === "B-9") as Invoice;
		expect(pairPaidWithExpenses([{ invoice: b9, cents: 30000n, day: "2026-09-21" }], EXPENSES)).toEqual([true]);
		expect(pairPaidWithExpenses([{ invoice: b9, cents: 30000n, day: "2026-09-30" }], EXPENSES)).toEqual([false]);
	});

	it("an invoice in instalments counts once in the fatturato, each instalment in the month it is paid", async () => {
		const s = await setup({ paid: { ...PAID, "FV-2#2": "2026-11-16T09:00:00.000Z" }, now: new Date("2026-11-20T09:00:00Z") });
		expect(await s.run({ op: "summary", period: "novembre" })).toContain("• Incassato: 305,00 €");
		const nov = await s.run({ op: "summary", period: "novembre" });
		expect(nov).toContain("• Fatturato: 0,00 € di imponibile (0 fatture)");
		expect(await s.run({ op: "summary", period: "ottobre" })).toContain("• Fatturato: 2.400,00 € di imponibile");
	});

	it("a credit note used comes off the incassato; open, it comes off what is to collect", async () => {
		const used = await setup({ paid: { ...PAID, "NC-1": "2026-10-17T09:00:00.000Z" } });
		expect(await used.run({ op: "summary", period: "ottobre" })).toContain("• Incassato: 1.403,00 €");
	});

	it("an issued fattura in uscita that is also an XML counts once; one not in the workspace adds", async () => {
		const same = await setup({ sales: [sale("FV-3", "2026-10-07", "2000")] });
		expect(await same.run({ op: "summary", period: "ottobre" })).toContain("• Fatturato: 2.400,00 € di imponibile (2 fatture, 1 nota di credito)");
		const more = await setup({ sales: [sale("FV-9", "2026-10-11", "300")] });
		expect(await more.run({ op: "summary", period: "ottobre" })).toContain("• Fatturato: 2.700,00 € di imponibile (3 fatture, 1 nota di credito)");
	});

	it("custom spans and periods with an article", async () => {
		const s = await setup();
		expect(await s.run({ op: "summary", from: "1/10/2026", to: "10/10/2026" })).toContain("Ottobre 2026 fino al 10:");
		expect(await s.run({ op: "summary", period: "il mese scorso" })).toContain("Settembre 2026:");
		expect(await s.run({ op: "summary", period: "l'anno scorso" })).toContain("• Incassato: 1.830,00 €");
		expect(await s.run({ op: "summary", period: "ottobre", from: "1/10/2026" })).toContain("Errore: dimmi un periodo oppure le date da e a");
		expect(await s.run({ op: "summary", from: "10/10/2026", to: "1/10/2026" })).toContain("Errore: from viene dopo to");
		expect(await s.run({ op: "summary", period: "boh <<<dati" })).toContain("<<<dati dell'andamento");
		expect(await s.run({ op: "summary", from: "1/1/2020" })).toContain("Errore: il periodo è troppo lungo");
	});

	it("taxes, forfettario: each year's share of every incasso, as the taxes tool estimates the year", async () => {
		const s = await setup({ regime: "forfettario", profile: GS_PROFILE });
		const invoices = await s.registerNow();
		const incassi = yearIncassi(invoices, TODAY, dayOf);
		// This year projected to its end, as the taxes tool's own estimate takes it.
		const e = yearEstimate({ profile: GS_PROFILE, figures: [], incassi, today: TODAY }, 2026);
		expect(incassi(2026).cents).toBe(250100n);
		const october = halfUp(152500n * e.total, e.incassi);
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain(`• Tasse e contributi da accantonare: ${euroText(october)}, circa il ${e.setAsidePercent}% di ogni incasso`);
		expect(answer).toContain(`• Ti resta in tasca: ${euroText(110900n - october)}`);
		expect(answer).toContain(TAX_NOTE);
		// The year so far: the same share of its incassi.
		expect(await s.run({ op: "summary", period: "da inizio anno" })).toContain(`da accantonare: ${euroText(halfUp(250100n * e.total, e.incassi))}`);
	});

	it("taxes, ordinario: the IVA of the period, IRPEF not estimated", async () => {
		const s = await setup({ regime: "ordinario" });
		// Sales 110 + 440 less NC-1 22; purchases 22 + 44.
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("• IVA da versare: 462,00 € (IRPEF e contributi non stimati)");
		expect(answer).toContain("• Dopo l'IVA: 647,00 € (prima di IRPEF e contributi, che non stimo)");
		expect(answer).not.toContain("in tasca");
		expect(answer).toContain(TAX_NOTE);
	});

	it("taxes not estimated without a regime or a profile, and said how to set it", async () => {
		const none = await setup();
		const a = await none.run({ op: "summary", period: "ottobre" });
		expect(a).toContain("• Tasse: non stimate (il perché è in fondo).");
		expect(a).toContain("\nTasse non stimate: non so se chi ti scrive è nel forfettario o nell'ordinario");
		expect(a).not.toContain("Ti resta in tasca");
		expect(a).not.toContain(TAX_NOTE);
		const forf = await setup({ regime: "forfettario" });
		expect(await forf.run({ op: "summary", period: "ottobre" })).toContain("manca il profilo delle tasse del forfettario");
	});
});

describe("business report: empty and broken registers", () => {
	it("nothing in any register: one line, no zeros", async () => {
		const s = await setup({ files: {}, expenses: [], quotes: [], entries: [] });
		expect(await s.run({ op: "summary" })).toBe(EMPTY);
		expect(await s.run({ op: "trend" })).toBe(EMPTY);
		expect(await s.run({ op: "summary", compact: true })).toBe(BRIEF_NOTHING);
	});

	it("invoices but no expenses: the spese said missing, the margine marked", async () => {
		const issued = Object.fromEntries(Object.entries(FILES).filter(([path]) => path.includes("/fv") || path.includes("/nc")));
		const s = await setup({ files: issued, expenses: [], quotes: [], entries: [] });
		const answer = await s.run({ op: "summary", period: "settembre" });
		expect(answer).toContain("• Spese: nessuna registrata.");
		expect(answer).toContain("• Margine: 976,00 € (senza spese registrate)");
		expect(answer).not.toContain("Ore");
		expect(answer).not.toContain("Preventivi");
	});

	it("expenses but no invoices: one line for the invoices", async () => {
		const s = await setup({ files: {} });
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("• Fatture: nessuna nei registri, quindi niente fatturato né incassi.");
		expect(answer).not.toContain("Incassato");
		expect(answer).not.toContain("Da incassare");
	});

	it("a broken expenses.json: said, no crash, nothing written over it", async () => {
		const s = await setup({ expenses: "real" });
		const file = join(s.dir, "expenses.json");
		writeFileSync(file, "{ non è json");
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("Il registro delle spese non si legge: spese e margine qui non ci sono.");
		expect(answer).toContain("• Incassato: 1.525,00 €");
		expect(answer).not.toContain("Margine");
		expect(readFileSync(file, "utf8")).toBe("{ non è json");
		expect(existsSync(join(s.root, "report"))).toBe(false);
	});

	it("a broken invoices.json: said, no crash, nothing written over it", async () => {
		const s = await setup();
		const file = join(s.dir, "invoices.json");
		writeFileSync(file, "[[[");
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("Lo stato delle fatture non si legge");
		expect(answer).toContain("• Spese: 172,00 €");
		expect(readFileSync(file, "utf8")).toBe("[[[");
		expect(await s.run({ op: "top" })).toContain("Lo stato delle fatture non si legge");
	});

	it("a broken taxes.json and a broken fatture in uscita: said", async () => {
		const s = await setup({ regime: "forfettario" });
		writeFileSync(join(s.dir, "taxes.json"), "nope");
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("Tasse non stimate: il profilo delle tasse non si legge.");
		expect(readFileSync(join(s.dir, "taxes.json"), "utf8")).toBe("nope");
		const sales = await setup({ salesBroken: true });
		const answer2 = await sales.run({ op: "summary", period: "ottobre" });
		expect(answer2).toContain("Le fatture in uscita non si leggono: il fatturato conta solo le fatture XML.");
		expect(answer2).toContain("• Fatturato: 2.400,00 € di imponibile");
	});
});

describe("business report: compare", () => {
	it("October so far against the same days of September: the biggest changes first, then each figure", async () => {
		const s = await setup();
		const answer = await s.run({ op: "compare", period: "ottobre" });
		expect(answer.split("\n")[0]).toBe("Ottobre 2026 fino al 18 rispetto a settembre 2026 fino al 18:");
		// Fatturato 2.400 vs 1.000; incassato 1.525 vs 976; spese 416 vs 0.
		expect(answer).toContain("Cosa è cambiato di più: fatturato +1.400,00 € (+140%); incassato +549,00 € (+56,3%); spese +416,00 €.");
		expect(answer).toContain("• Margine: 1.109,00 €, prima 976,00 €, +133,00 € (+13,6%)");
		expect(answer).toContain("• Ore lavorate: 12 ore e 30 minuti, prima 1 ora");
		expect(answer).not.toMatch(NO_EM_DASH);
	});

	it("against the same period last year", async () => {
		const s = await setup();
		const answer = await s.run({ op: "compare", period: "ottobre", against: "last_year" });
		expect(answer.split("\n")[0]).toBe("Ottobre 2026 fino al 18 rispetto a ottobre 2025 fino al 18:");
		expect(answer).toContain("• Fatturato: 2.400,00 €, prima 1.500,00 €, +900,00 € (+60%)");
		expect(await s.run({ op: "compare", against: "boh" })).toContain("Errore: against è previous");
	});

	it("nothing before: no division by zero, «non c'era niente»", async () => {
		const s = await setup();
		const answer = await s.run({ op: "compare", period: "settembre" });
		expect(answer.split("\n")[0]).toBe("Settembre 2026 rispetto ad agosto 2026:");
		// August had the fatturato of FV-0, no incassi nor spese: said once.
		expect(answer).toContain("\nAd agosto 2026 non c'erano incassi né spese; a settembre: incassati 976,00 €, spese 300,00 €.\nIl fatturato: +200,00 € (+25%).\n");
		expect(answer.match(/non c'era/g)).toHaveLength(1);
		expect(answer).toContain("• Incassato: 976,00 €, prima 0,00 €, +976,00 €\n");
		const custom = await s.run({ op: "compare", from: "1/10/2026", to: "10/10/2026" });
		expect(custom.split("\n")[0]).toBe("Ottobre 2026 fino al 10 rispetto ai giorni dal 21 al 30 settembre 2026:");
		const year = await s.run({ op: "compare", period: "2025" });
		expect(year.split("\n")[0]).toBe("2025 rispetto al 2024:");
		expect(signedPercent(100n, 0n)).toBeUndefined();
	});

	it("percent on a negative before, and the biggest by euros either way", () => {
		expect(signedPercent(5000n, -10000n)).toBeUndefined();
		expect(signedPercent(-5000n, 10000n)).toBe("\u2212150%");
		const f = (incassato: bigint, spese: bigint): Figures => ({ span: { from: "2026-10-01", to: "2026-10-31" }, fatturato: { cents: incassato, count: 1, credits: 0 }, incassato, spese: { cents: spese, expenses: 1, suppliers: 0, supplierCents: 0n, twins: 0 }, margine: incassato - spese });
		const list = deltas(f(1000n, 5000n), f(1000n, 1000n));
		// The margine comes from the spese, already said.
		expect(biggest(list).map((d) => d.key)).toEqual(["spese"]);
		expect(biggest(list, 1)).toHaveLength(1);
	});
});

describe("business report: periods and months", () => {
	it("month boundaries, leap years, the span before", () => {
		expect(lastMonths("2026-03-31", 2)).toEqual([
			{ from: "2026-02-01", to: "2026-02-28" },
			{ from: "2026-03-01", to: "2026-03-31" },
		]);
		expect(lastMonths("2026-01-15", 2)[0]).toEqual({ from: "2025-12-01", to: "2025-12-31" });
		expect(lastMonths("2028-03-01", 2)[0]).toEqual({ from: "2028-02-01", to: "2028-02-29" });
		expect(monthsOf({ from: "2025-12-15", to: "2026-01-10" })).toEqual([
			{ from: "2025-12-15", to: "2025-12-31" },
			{ from: "2026-01-01", to: "2026-01-10" },
		]);
		expect(yearBack("2028-02-29")).toBe("2027-02-28");
		expect(lastYearSpan({ from: "2028-02-01", to: "2028-02-29" })).toEqual({ from: "2027-02-01", to: "2027-02-28" });
		expect(spanBefore({ from: "2026-10-01", to: "2026-10-10" })).toEqual({ from: "2026-09-21", to: "2026-09-30" });
		const feb = readAsked({ period: "febbraio 2028" }, "2028-03-10");
		expect(feb).toEqual(expect.objectContaining({ span: { from: "2028-02-01", to: "2028-02-29" }, partial: false }));
		expect(readAsked({ period: "novembre 2026" }, TODAY)).toEqual({ problem: expect.stringContaining("non è ancora cominciato") });
		expect(spanWords({ from: "2028-02-01", to: "2028-02-29" })).toBe("febbraio 2028");
		expect(spanWords({ from: "2026-07-01", to: "2026-09-30" })).toBe("3º trimestre 2026");
		expect(spanWords({ from: "2025-01-01", to: "2025-12-31" })).toBe("2025");
		expect(spanWords({ from: "2025-12-15", to: "2026-01-10" })).toBe("dal 15 dicembre 2025 al 10 gennaio 2026");
	});

	it("a leap February against last year's", async () => {
		const s = await setup({ files: {}, now: new Date("2028-03-10T09:00:00Z"), expenses: [expense("S-2028-0001", "2028-02-29", "10"), expense("S-2027-0001", "2027-02-28", "20")] });
		const answer = await s.run({ op: "compare", period: "febbraio 2028", against: "last_year" });
		expect(answer.split("\n")[0]).toBe("Febbraio 2028 rispetto a febbraio 2027:");
		expect(answer).toContain("• Spese: 10,00 €, prima 20,00 €, −10,00 € (−50%)");
	});

	it("trend: six months by default, at most 24, the empty months before folded in one line, each row labelled", async () => {
		const s = await setup();
		const answer = await s.run({ op: "trend" });
		const rows = answer.split("\n").filter((l) => l.startsWith("• "));
		expect(answer).toContain("Gli ultimi 6 mesi, mese per mese:\nDa maggio 2026 a luglio 2026: niente.\n");
		expect(rows).toEqual([
			"• agosto 2026: fatturati 800,00 €, incassati 0,00 €, spese 0,00 €, margine 0,00 €",
			"• settembre 2026: fatturati 1.000,00 €, incassati 976,00 €, spese 300,00 €, margine 676,00 €",
			"• ottobre 2026 (fino al 18): fatturati 2.400,00 €, incassati 1.525,00 €, spese 416,00 €, margine 1.109,00 €",
		]);
		expect(answer).toContain("Totale: fatturati 4.200,00 €, incassati 2.501,00 €, spese 716,00 €, margine 1.785,00 €.");
		expect(answer).not.toContain("chart");
		expect(s.tool.description).toContain("(months, default 6, at most 24; chart_create only if the person asks for a chart)");
		const year = await s.run({ op: "trend", months: 12 });
		expect(year).toContain("\nDa novembre 2025 a luglio 2026: niente.\n");
		expect(year.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(3);
		const capped = await s.run({ op: "trend", months: 30 });
		expect(capped).toContain("Al massimo 24 mesi");
		expect(capped).toContain("\nDa novembre 2024 a settembre 2025: niente.\n• ottobre 2025: fatturati 1.500,00 €, incassati 1.830,00 €, spese 100,00 €, margine 1.730,00 €\n• novembre 2025: fatturati 0,00 €");
		// Only the leading empty months fold: 24 less the 11 before October 2025.
		expect(capped.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(REPORT_LIMITS.maxTrendMonths - 11);
		expect(await s.run({ op: "trend", months: 0 })).toContain("Errore: months è un numero intero");
		expect(await s.run({ op: "trend", months: 2.5 })).toContain("Errore: months è un numero intero");
		expect(answer).not.toMatch(NO_EM_DASH);
		expect(REPORT_LIMITS.trendMonths).toBe(6);
	});
});

describe("business report: top", () => {
	it("clients by incassato with the concentration, and the expense categories, in one fence", async () => {
		const s = await setup();
		const answer = await s.run({ op: "top" });
		expect(answer.split("\n")[0]).toBe("Dal 1º gennaio al 18 ottobre 2026:");
		expect(fences(answer)).toHaveLength(1);
		const names = inside(answer);
		// Cliente Due 976 + 305; Cliente Uno 1.220.
		expect(names).toContain(`1. ${CLIENT2.name}: 1.281,00 €, 51%`);
		expect(names).toContain(`2. ${CLIENT1.name}: 1.220,00 €, 49%`);
		expect(names).toContain("Software e abbonamenti: 300,00 € (1 spesa)");
		expect(names).toContain("Consulenze: 122,00 € (1 spesa)");
		expect(outside(answer)).not.toContain(CLIENT1.name);
		// 51% and 49%: two clients close to even, no warning.
		expect(outside(answer)).toContain("Gli incassi vengono da 2 clienti, quasi alla pari.");
		expect(outside(answer)).not.toContain("dipendi");
		expect(answer).not.toMatch(NO_EM_DASH);
	});

	it("pure: the first three's share with more clients, not concentrated when spread", async () => {
		const s = await setup();
		const src = sourcesOf({ invoices: await s.registerNow(), expenses: EXPENSES, marks: [], tax: { kind: "none", why: "no_regime" } }, TODAY, dayOf);
		expect(presenceOf(src)).toEqual({ invoices: true, expenses: true, entries: false, quotes: false });
		expect(receivablesOf(src)).toEqual({ open: 262300n, overdue: 231800n, overdueCount: 1 });
		const f = figuresIn(src, { from: "2026-10-01", to: "2026-10-18" });
		expect(f.ore).toBeUndefined();
		expect(f.preventivi).toBeUndefined();
		expect(f.spese).toEqual({ cents: 41600n, expenses: 2, suppliers: 1, supplierCents: 24400n, twins: 1 });
	});
});

describe("business report: the brief, another agente, the export, the audit", () => {
	it("the brief's line only on the first weekday of the month, and it never writes", async () => {
		const s = await setup({ now: new Date("2026-11-02T07:00:00Z") });
		const before = readFileSync(join(s.dir, "invoices.json"), "utf8");
		const line = await s.run({ op: "summary", compact: true });
		expect(line).toBe("Ottobre chiuso: incassati 1.525,00 €, spese 416,00 €, margine 1.109,00 € (+64,1% su settembre). Nel brief riporta questo in una riga.");
		s.at("2026-11-04T07:00:00Z");
		expect(await s.run({ op: "summary", compact: true })).toBe(BRIEF_NOTHING);
		s.at("2026-10-01T07:00:00Z");
		// September against August, when August had nothing.
		expect(await s.run({ op: "summary", compact: true })).toContain("(ad agosto non c'era niente)");
		expect(readFileSync(join(s.dir, "invoices.json"), "utf8")).toBe(before);
		expect(readdirSync(s.root)).toEqual(["f"]);
		expect(s.events).toEqual([]);
	});

	it("in the brief's thread it reads, the export is refused; the instruction names it within the limit", async () => {
		const s = await setup();
		const [briefed] = readOnlyInBriefs([s.tool], async () => true);
		expect(String(await briefed?.execute({ op: "summary", compact: true }, fresh()))).toBe(BRIEF_NOTHING);
		expect(String(await briefed?.execute({ op: "trend", months: 2 }, fresh()))).toContain("• ottobre 2026");
		expect(String(await briefed?.execute({ op: "export" }, fresh()))).toContain("nella chat del brief del mattino Owni legge soltanto");
		expect(existsSync(join(s.root, "report"))).toBe(false);
		expect(businessCallReads({ op: "summary" })).toBe(true);
		expect(businessCallReads({ op: "export" })).toBe(false);
		expect(BRIEF_INSTRUCTION).toMatch(/\n9\. Chiama ognuno di questi tool con l'op tra parentesi e compact true, e riporta la sua riga solo se segnala qualcosa: [^\n]*\bbusiness_report \(summary\)[,.]/);
		expect(BRIEF_INSTRUCTION.length).toBeLessThanOrEqual(SCHEDULE_LIMITS.maxInstructionChars);
	});

	it("another agente: summary and trend as numbers, never names, compare, top or files", async () => {
		const s = await setup();
		const summary = await s.run({ op: "summary", period: "ottobre" }, agent());
		expect(summary).toContain("• Margine: 1.109,00 €");
		expect(summary).not.toContain(CLIENT1.name);
		expect(fences(summary)).toHaveLength(0);
		expect(await s.run({ op: "trend", months: 3 }, agent())).toContain("• ottobre 2026 (fino al 18)");
		for (const op of ["top", "compare", "export"]) expect(await s.run({ op }, agent())).toContain("Errore: a un altro agente do solo le cifre dell'andamento");
		expect(businessAgentReads({ op: "top" })).toBe(false);
		expect(existsSync(join(s.root, "report"))).toBe(false);
	});

	it("the export: a CSV under report/ named by its dates, never over another, hostile names inert, audit with op and count only", async () => {
		const hostile = { name: "=HYPERLINK(\"http://x.example\";\"clic\") Srl" };
		const files = { ...FILES, "f/fv0.xml": xml(COMPANY, hostile, { number: "FV-0", date: "2026-08-20", rows: [r22("800.00")], due: "2026-09-19" }) };
		const s = await setup({ files });
		const answer = await s.run({ op: "export", period: "settembre" });
		expect(answer).toContain("Salvato report/andamento-2026-09-01_2026-09-30.csv: l'andamento di settembre 2026, mese per mese");
		expect(answer).not.toContain("non mi hai detto il periodo");
		expect(answer).not.toContain("HYPERLINK");
		const csv = readFileSync(join(s.root, "report", "andamento-2026-09-01_2026-09-30.csv"), "utf8");
		expect(csv.startsWith("﻿Periodo;Fatturato (imponibile);Incassato;Spese;Margine;Tasse stimate;Ti resta in tasca;Ore\r\n")).toBe(true);
		// The supplier invoice the renewal's expense stands for: said in the CSV, not in the chat.
		expect(csv).toContain("1 fattura di fornitore pagata è già nelle spese registrate: contate una volta.");
		expect(csv).toContain("settembre 2026;1000,00;976,00;300,00;676,00;;;1:00\r\n");
		expect(csv).toContain(`"'=HYPERLINK(""http://x.example"";""clic"") Srl";976,00;100\r\n`);
		expect(csv).not.toMatch(/(^|;|\n)=HYPERLINK/);
		const again = await s.run({ op: "export", period: "settembre" });
		expect(again).toContain("report/andamento-2026-09-01_2026-09-30-2.csv");
		expect(readdirSync(join(s.root, "report")).sort()).toEqual(["andamento-2026-09-01_2026-09-30-2.csv", "andamento-2026-09-01_2026-09-30.csv"]);
		expect(s.events).toHaveLength(2);
		for (const e of s.events) expect(Object.keys(e).sort()).toEqual(["count", "op", "type"]);
		expect(s.events[0]).toEqual({ type: "business_report.exported", op: "export", count: expect.any(Number) });
		const json = JSON.stringify(s.events);
		for (const leak of ["Cliente", "HYPERLINK", "976", "2026-09", SUPPLIER.vat]) expect(json).not.toContain(leak);
		// Reading writes nothing and records nothing.
		await s.run({ op: "summary" });
		await s.run({ op: "compare" });
		await s.run({ op: "top" });
		expect(s.events).toHaveLength(2);
	});

	it("the answers carry no em dash and the source files carry none", () => {
		for (const f of ["business-report.ts", "business-report-sums.ts", "business-report-taxes.ts", "business-report-compare.ts", "business-report-top.ts", "tools/business-report-tools.ts", "tools/business-report-render.ts", "tools/business-report-input.ts"]) {
			expect(readFileSync(join("src", "core", f), "utf8")).not.toMatch(NO_EM_DASH);
		}
	});

	it("an unknown op, and compact that is no boolean", async () => {
		const s = await setup();
		expect(await s.run({ op: "boh" })).toContain("Errore: op è una di queste: summary, compare, trend, top, export.");
		expect(await s.run({ op: "summary", compact: "sì" })).toBe("Errore: compact è true o false.");
	});
});

const COMMERCIANTI: TaxProfile = { coefficient: "40", rate: "15", startYear: 2020, pension: { kind: "commercianti", reduction: false }, by: "u", at: NOW.toISOString() };
const OTHER_SUPPLIER = { name: "Altro Fornitore Srl", vat: "22222220010" };
/** Two supplier invoices of 500 € paid on 5 and 6 October, and an unrelated expense of 500 € on the 7th. */
const TWO_PAID = {
	files: {
		"f/s1.xml": xml(SUPPLIER, COMPANY, { number: "X-1", date: "2026-10-01", rows: [r22("409.84")], due: "2026-10-05" }),
		"f/s2.xml": xml(OTHER_SUPPLIER, COMPANY, { number: "Y-7", date: "2026-10-02", rows: [r22("409.84")], due: "2026-10-06" }),
	},
	paid: { "X-1": "2026-10-05T08:00:00.000Z", "Y-7": "2026-10-06T08:00:00.000Z" },
	expenses: [expense("S-2026-0009", "2026-10-07", "500", { category: "attrezzatura", supplier: "Negozio Prova" })],
	quotes: [],
	entries: [],
};
const fig = (o: { incassato: bigint; spese: bigint; fatturato?: bigint }): Figures => ({ span: { from: "2026-09-01", to: "2026-09-30" }, fatturato: { cents: o.fatturato ?? o.incassato, count: 1, credits: 0 }, incassato: o.incassato, spese: { cents: o.spese, expenses: 1, suppliers: 0, supplierCents: 0n, twins: 0 }, margine: o.incassato - o.spese, tasse: { kind: "none", why: "no_regime" } });
const PRESENT = { invoices: true, expenses: true, entries: false, quotes: false };

describe("business report: week 61 review fixes", () => {
	it("M1: forfettario commercianti, 3.000 € in January asked on 2 February: the taxes tool's share, never over 100%", async () => {
		const files = { "f/a.xml": xml(COMPANY, CLIENT1, { number: "1", date: "2026-01-05", rows: [{ rate: "0.00", taxable: "3000.00", tax: "0.00" }], due: "2026-01-20" }) };
		const now = new Date("2026-02-02T09:00:00Z");
		const s = await setup({ files, paid: { "1": "2026-01-20T10:00:00.000Z" }, expenses: [], quotes: [], entries: [], regime: "forfettario", profile: COMMERCIANTI, now });
		const incassi = yearIncassi(await s.registerNow(), "2026-02-02", dayOf);
		const e = currentEstimate({ profile: COMMERCIANTI, figures: [], incassi, today: "2026-02-02" });
		expect(e.setAsidePercent).toBeDefined();
		expect(e.setAsidePercent as number).toBeLessThanOrEqual(100);
		const answer = await s.run({ op: "summary", period: "gennaio" });
		const share = halfUp(300000n * e.total, e.incassi);
		expect(share).toBeLessThan(300000n);
		expect(answer).toContain(`• Tasse e contributi da accantonare: ${euroText(share)}, circa il ${e.setAsidePercent}% di ogni incasso`);
		expect(answer).toContain(`• Ti resta in tasca: ${euroText(300000n - share)}`);
		expect(answer).not.toMatch(/in tasca: −/);
		// The share the old code took: the whole year's fixed contributions on January alone.
		const ytdOnly = yearEstimate({ profile: COMMERCIANTI, figures: [], incassi, today: "2026-02-02" }, 2026, 300000n);
		expect(ytdOnly.setAsidePercent as number).toBeGreaterThan(100);
	});

	it("M2: one expense stands for one supplier payment at most; an unrelated one for none, in the report and in the balance brought forward", async () => {
		const s = await setup(TWO_PAID);
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("• Spese: 1.500,00 € (1 spesa registrata, 2 fatture di fornitori pagate)");
		const invoices = await s.registerNow();
		const x1 = invoices.find((i) => i.doc.number === "X-1") as Invoice;
		const y7 = invoices.find((i) => i.doc.number === "Y-7") as Invoice;
		const paid = [
			{ invoice: x1, cents: 50000n, day: "2026-10-05" },
			{ invoice: y7, cents: 50000n, day: "2026-10-06" },
		];
		// Another supplier named: no pair. No name nor partita IVA: one pair only, never both.
		expect(pairPaidWithExpenses(paid, TWO_PAID.expenses)).toEqual([false, false]);
		expect(pairPaidWithExpenses(paid, [expense("S-1", "2026-10-07", "500")])).toEqual([false, true]);
		// Amount alone with another partita IVA: no pair; with the invoice's partita IVA and number: that one.
		expect(pairPaidWithExpenses(paid, [expense("S-2", "2026-10-06", "500", { supplierVat: OTHER_SUPPLIER.vat })])).toEqual([false, true]);
		expect(pairPaidWithExpenses(paid, [expense("S-3", "2026-10-06", "500", { supplierVat: "IT99999999990" })])).toEqual([false, false]);
		expect(pairPaidWithExpenses(paid, [expense("S-4", "2026-11-30", "500", { supplierVat: SUPPLIER.vat, docNumber: "X-1" })])).toEqual([true, false]);
		// The cashflow takes both payments off, and the expense.
		const rolled = rollForward({ amount: "1000", date: "2026-10-01", by: "u", at: "2026-10-01T18:00:00.000Z" }, "2026-10-18T08:00:00.000Z", TODAY, invoices, TWO_PAID.expenses, [], dayOf);
		expect(rolled?.paidPassive).toHaveLength(2);
		expect(rolled?.net).toBe(-150000n);
		const one = rollForward({ amount: "1000", date: "2026-10-01", by: "u", at: "2026-10-01T18:00:00.000Z" }, "2026-10-18T08:00:00.000Z", TODAY, invoices, [expense("S-1", "2026-10-07", "500")], [], dayOf);
		expect(one?.paidPassive).toHaveLength(1);
	});

	it("M3: the ordinario is «dopo l'IVA», never «in tasca»: chat, the year's line, the agente, the CSV, the description", async () => {
		const s = await setup({ regime: "ordinario" });
		const answer = await s.run({ op: "summary" });
		expect(answer).toContain("• Dopo l'IVA: ");
		expect(answer).toMatch(/Dal 1º gennaio al 18 ottobre 2026: [^\n]*dopo l'IVA [^\n]*, prima di IRPEF e contributi, che non stimo\./);
		expect(answer).not.toMatch(/in tasca|ti restano/);
		const toAgent = await s.run({ op: "summary", period: "ottobre" }, agent());
		expect(toAgent).toContain("• Dopo l'IVA: 647,00 € (prima di IRPEF e contributi, che non stimo)");
		expect(toAgent).not.toContain("in tasca");
		const compare = await s.run({ op: "compare", period: "ottobre" });
		expect(compare).toContain("• Dopo l'IVA: 647,00 €");
		expect(compare).toContain("Dopo l'IVA vuol dire prima di IRPEF e contributi, che non stimo.");
		await s.run({ op: "export", period: "ottobre" });
		const csv = readFileSync(join(s.root, "report", "andamento-2026-10-01_2026-10-18.csv"), "utf8");
		expect(csv.split("\r\n")[0]).toBe("﻿Periodo;Fatturato (imponibile);Incassato;Spese;Margine;IVA da versare;Dopo l'IVA (prima di IRPEF e contributi, non stimati);Ore");
		expect(s.tool.description).toContain("for the ordinario only what is left after the IVA");
		const forf = await setup({ regime: "forfettario", profile: GS_PROFILE });
		expect(await forf.run({ op: "summary", period: "ottobre" })).toContain("• Ti resta in tasca: ");
	});

	it("U1: «chi mi paga di più» goes to clients op top; the report's top is where the money goes, the concentration kept", async () => {
		const s = await setup();
		expect(s.tool.description).toContain("«chi mi paga di più?», «chi sono i miei clienti migliori?» → not this tool: the clients tool, op top");
		expect(s.tool.description).not.toContain("«chi sono i clienti che mi pagano di più?», «dove spendo di più?» → top");
		expect(s.tool.description).toContain("«dove spendo di più?» → top");
		expect(await s.run({ op: "top" })).toContain("Gli incassi vengono da 2 clienti");
	});

	it("U3: no percent from zero or below or from under a tenth; the biggest prefer fatturato, incassato, spese", () => {
		expect(signedPercent(110900n, -10000n)).toBeUndefined();
		expect(signedPercent(100000n, 9000n)).toBeUndefined();
		expect(signedPercent(100000n, 10000n)).toBe("+900%");
		expect(signedPercent(-100000n, 9000n)).toBeUndefined();
		const now = fig({ incassato: 120900n, spese: 10000n });
		const before = fig({ incassato: 10000n, spese: 20000n, fatturato: 120900n });
		const list = deltas(now, before);
		const top = biggest(list);
		// Incassato and spese first; the margine comes from them: not said again.
		expect(top.map((d) => d.key)).toEqual(["incassato", "spese"]);
		const answer = compareAnswer({ now, before, deltas: list, biggest: top, presence: PRESENT, notes: [] });
		expect(answer).toContain("• Margine: 1.109,00 €, prima −100,00 €, +1.209,00 € (da −100,00 € a 1.109,00 €)");
		expect(answer).toContain("Cosa è cambiato di più: incassato +1.109,00 € (da 100,00 € a 1.209,00 €); spese −100,00 € (−50%).");
		expect(answer).not.toMatch(/margine \+/);
	});

	it("U5: two clients warn only at 60% and twice the second, «quasi alla pari» when close; three or more also need twice the second or over half", () => {
		expect(reportConcentrated([70n, 30n], 100n)).toBe(true);
		expect(reportConcentrated([65n, 35n], 100n)).toBe(false);
		expect(reportConcentrated([55n, 45n], 100n)).toBe(false);
		expect(reportConcentrated([45n, 40n, 15n], 100n)).toBe(false);
		expect(reportConcentrated([45n, 20n, 20n, 15n], 100n)).toBe(true);
		expect(reportConcentrated([51n, 30n, 19n], 100n)).toBe(true);
		expect(reportConcentrated([100n], 100n)).toBe(false);
	});

	it("U6: the export defaults to the month just closed and says so; the brief speaks only on the first weekday of the month", async () => {
		const s = await setup();
		const answer = await s.run({ op: "export" });
		expect(answer).toContain("Salvato report/andamento-2026-09-01_2026-09-30.csv: l'andamento di settembre 2026 (il mese scorso: non mi hai detto il periodo)");
		// 1 November 2026 is a Sunday: Monday the 2nd speaks, the 3rd does not.
		expect(briefSpeaks("2026-11-02")).toBe(true);
		expect(briefSpeaks("2026-11-01")).toBe(false);
		expect(briefSpeaks("2026-11-03")).toBe(false);
		expect(briefSpeaks("2026-10-01")).toBe(true);
		expect(briefSpeaks("2026-10-02")).toBe(false);
		expect(briefSpeaks("2026-08-03")).toBe(true);
		const brief = await setup({ now: new Date("2026-11-03T07:00:00Z") });
		expect(await brief.run({ op: "summary", compact: true })).toBe(BRIEF_NOTHING);
	});

	it("U7: euros per hour only with 10 hours or more, said as a rough ratio", async () => {
		const few = await setup({ entries: [entry("O-1", "2026-10-06", 540)] });
		const a = await few.run({ op: "summary", period: "ottobre" });
		expect(a).toContain("• Ore lavorate: 9 ore\n");
		expect(a).not.toContain("l'ora");
		const enough = await setup({ entries: [entry("O-1", "2026-10-06", 600)] });
		expect(await enough.run({ op: "summary", period: "ottobre" })).toContain("• Ore lavorate: 10 ore; fatturato diviso le ore registrate: 240,00 € l'ora");
		expect(few.tool.description).toContain("a rough ratio, not a rate");
	});

	it("U8: «prima nessuna», no quotes row at 0 su 0, the minus sign in percents, the reason for no taxes after the list", async () => {
		const s = await setup();
		const sept = await s.run({ op: "compare", period: "settembre" });
		expect(sept).toContain("• Ore lavorate: 1 ora, prima nessuna");
		expect(sept).toContain("• Preventivi accettati: 1 su 1, prima nessun preventivo");
		const aug = await s.run({ op: "compare", period: "agosto" });
		expect(aug).not.toContain("Preventivi");
		expect(aug).not.toContain("Ore lavorate");
		expect(aug).not.toContain("0 minuti");
		const october = await s.run({ op: "summary", period: "ottobre" });
		const lines = october.split("\n");
		const why = lines.findIndex((l) => l.startsWith("Tasse non stimate:"));
		expect(why).toBeGreaterThan(lines.findIndex((l) => l.startsWith("Ancora da incassare")));
		expect(october).not.toContain("già nelle spese");
		expect(october).not.toContain("Da incassare oggi");
		expect(signedPercent(5000n, 10000n)).toBe("−50%");
	});

	it("U9: paidDay from invoices.ts, the comparison in business-report-compare.ts, the notes in the render", () => {
		const sums = readFileSync(join("src", "core", "business-report-sums.ts"), "utf8");
		expect(sums).not.toContain("paidDayOf");
		// The day paid comes from invoices.ts paidDay, through the instalments the cashflow gathers.
		expect(sums).toContain("paidSupplierInstalments(");
		expect(readFileSync(join("src", "core", "cashflow-sources.ts"), "utf8")).toMatch(/paidDay\(i\.paid, dayOf\)/);
		const input = readFileSync(join("src", "core", "tools", "business-report-input.ts"), "utf8");
		expect(input).not.toMatch(/comparedTo|readAgainst|comparedSpans/);
		expect(readAgainst("anno scorso")).toBe("last_year");
		expect(comparedTo({ span: { from: "2026-10-01", to: "2026-10-10" } }, "previous", TODAY)).toEqual({ now: { from: "2026-10-01", to: "2026-10-10" }, before: { from: "2026-09-21", to: "2026-09-30" } });
		const tools = readFileSync(join("src", "core", "tools", "business-report-tools.ts"), "utf8");
		expect(tools).not.toContain("non si legge");
		expect(loadNotes({ invoicesBroken: false, noCompany: false, unread: 2, salesBroken: false, expensesBroken: true, quotesBroken: false, hoursBroken: false, uncounted: 1 })).toEqual([
			"2 file di fatture nel workspace non si leggono e sono fuori dal conto.",
			"Il registro delle spese non si legge: spese e margine qui non ci sono.",
			"Una fattura emessa non entra nel fatturato (senza riepilogo IVA, senza data o in un'altra valuta).",
		]);
	});
});

describe("business report: week 61 second review fixes", () => {
	const R5 = {
		files: { "f/s.xml": xml(SUPPLIER, COMPANY, { number: "R-5", date: "2026-10-01", rows: [r22("819.67")], rate: [{ amount: "500.00", due: "2026-10-05" }, { amount: "500.00", due: "2026-10-15" }] }) },
		expenses: [expense("S-2026-0001", "2026-10-05", "1000", { supplier: SUPPLIER.name, supplierVat: SUPPLIER.vat, docType: "fattura", docNumber: "R-5", category: "consulenze" })],
		quotes: [],
		entries: [],
	};
	const balance = { amount: "1000", date: "2026-10-01", by: "u", at: "2026-10-01T18:00:00.000Z" };

	it("1: one expense for a whole invoice in instalments covers each instalment up to its amount, in the report and in the balance brought forward", async () => {
		const s = await setup({ ...R5, paid: { "R-5#1": "2026-10-05T08:00:00.000Z", "R-5#2": "2026-10-15T08:00:00.000Z" } });
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("• Spese: 1.000,00 € (1 spesa registrata)\n");
		const invoices = await s.registerNow();
		const r5 = invoices.find((i) => i.doc.number === "R-5") as Invoice;
		const both = [
			{ invoice: r5, cents: 50000n, day: "2026-10-05" },
			{ invoice: r5, cents: 50000n, day: "2026-10-15" },
		];
		expect(pairPaidWithExpenses(both, R5.expenses)).toEqual([true, true]);
		// By the invoice's total within the days, the same; by an instalment's amount, one only.
		expect(pairPaidWithExpenses(both, [expense("S-2", "2026-10-06", "1000", { supplierVat: SUPPLIER.vat })])).toEqual([true, true]);
		expect(pairPaidWithExpenses(both, [expense("S-3", "2026-10-06", "500", { supplierVat: SUPPLIER.vat })])).toEqual([true, false]);
		expect(pairPaidWithExpenses(both, [expense("S-4", "2026-10-06", "500")])).toEqual([true, false]);
		// Its amount runs out: 600 € by number covers the first 500 € only.
		expect(pairPaidWithExpenses(both, [expense("S-5", "2026-10-05", "600", { supplierVat: SUPPLIER.vat, docNumber: "R-5" })])).toEqual([true, false]);
		// The balance brought forward: neither instalment taken off, by hand or by the bank.
		const rolled = rollForward(balance, "2026-10-18T08:00:00.000Z", TODAY, invoices, R5.expenses, [], dayOf);
		expect(rolled?.paidPassive).toEqual([]);
		expect(rolled?.net).toBe(-100000n);
		const bank = await setup({ ...R5, paid: {} });
		const store = bank.invoices;
		const [inv] = (await bank.registerNow()).filter((i) => i.doc.number === "R-5");
		for (const [n, on] of [[1, "2026-10-05"], [2, "2026-10-15"]] as const) store.mark({ invoice: inv?.key as string, count: 2, instalment: n, paid: true, on, source: "bank", by: "test:u", at: `${on}T09:00:00.000Z` });
		const fromBank = rollForward(balance, "2026-10-18T08:00:00.000Z", TODAY, await bank.registerNow(), R5.expenses, [], dayOf);
		expect(fromBank?.paidPassive).toEqual([]);
	});

	it("2: a receipt «TIM» without partita IVA and Telecom Italia's invoice of the same amount: both counted, said as maybe the same payment", async () => {
		const telecom = { name: "Telecom Italia S.p.A.", vat: "33333330013" };
		const tim = (id: string, date: string) => expense(id, date, "50", { supplier: "TIM", category: "telefono e internet" });
		const files: Record<string, string> = {};
		const paid: Record<string, string> = {};
		for (let i = 1; i <= 5; i++) {
			files[`f/t${i}.xml`] = xml(telecom, COMPANY, { number: `T-${i}`, date: "2026-10-01", rows: [r22("40.98")], due: `2026-10-0${i + 1}` });
			paid[`T-${i}`] = `2026-10-0${i + 1}T08:00:00.000Z`;
		}
		const one = await setup({ files: { "f/t1.xml": files["f/t1.xml"] as string }, paid: { "T-1": "2026-10-05T08:00:00.000Z" }, expenses: [tim("S-1", "2026-10-05")], quotes: [], entries: [] });
		const answer = await one.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("• Spese: 100,00 € (1 spesa registrata, 1 fattura di fornitore pagata)");
		expect(outside(answer)).toContain("Forse è lo stesso pagamento, contato due volte (nel riquadro): chiedi a chi ti scrive.");
		expect(inside(answer)).toBe("la spesa «TIM» del 5 ottobre 2026 e la fattura di Telecom Italia S.p.A. (50,00 €)");
		expect(outside(answer)).not.toMatch(/TIM|Telecom/);
		const toAgent = await one.run({ op: "summary", period: "ottobre" }, agent());
		expect(toAgent).toContain("Un pagamento a un fornitore forse è contato due volte: una spesa registrata e una fattura di fornitore pagata.");
		expect(toAgent).not.toMatch(/TIM|Telecom/);
		expect(fences(toAgent)).toHaveLength(0);
		// At most three named, then «e altri N».
		const many = await setup({ files, paid, expenses: [1, 2, 3, 4, 5].map((i) => tim(`S-${i}`, `2026-10-0${i + 1}`)), quotes: [], entries: [] });
		const listed = inside(await many.run({ op: "summary", period: "ottobre" })).split("\n");
		expect(listed).toHaveLength(4);
		expect(listed[3]).toBe("e altri 2");
		// Not said when the amount is not exact, or the receipt has a partita IVA, or the names agree (then it is one payment).
		const invoices = await one.registerNow();
		const t1 = { invoice: invoices.find((i) => i.doc.number === "T-1") as Invoice, cents: 5000n, day: "2026-10-05" };
		expect(maybeTwins([t1], [expense("S-9", "2026-10-05", "50.10", { supplier: "TIM" })])).toEqual([]);
		expect(maybeTwins([t1], [expense("S-9", "2026-10-05", "50", { supplier: "TIM", supplierVat: "11111110018" })])).toEqual([]);
		expect(maybeTwins([t1], [expense("S-9", "2026-10-05", "50", { supplier: "Telecom Italia" })])).toEqual([]);
		expect(maybeTwins([t1], [expense("S-9", "2026-10-15", "50", { supplier: "TIM" })])).toEqual([]);
	});

	it("3: «Il fatturato:» for one more change, «Inoltre:» for more; the reason for no taxes in lowercase; «prima nessun preventivo»", async () => {
		const now = fig({ incassato: 50000n, spese: 10000n, fatturato: 90000n });
		const before = { ...fig({ incassato: 0n, spese: 0n, fatturato: 60000n }), tasse: { kind: "forfettario" as const, cents: 1000n } };
		const withTax = { ...now, tasse: { kind: "forfettario" as const, cents: 3000n } };
		const list = deltas(withTax, before);
		const answer = compareAnswer({ now: withTax, before, deltas: list, biggest: biggest(list), presence: PRESENT, notes: [] });
		expect(answer).toContain("\nInoltre: fatturato +300,00 € (+50%); tasse stimate +20,00 € (+200%).\n");
		const s = await setup({ regime: "forfettario" });
		expect(await s.run({ op: "summary", period: "ottobre" })).toContain("\nTasse non stimate: manca il profilo delle tasse del forfettario");
		expect(await s.run({ op: "compare", period: "settembre" })).toContain("• Preventivi accettati: 1 su 1, prima nessun preventivo");
	});
});

describe("business report: week 61 third verify fixes", () => {
	const R5 = { "f/s.xml": xml(SUPPLIER, COMPANY, { number: "R-5", date: "2026-09-01", rows: [r22("819.67")], rate: [{ amount: "500.00", due: "2026-09-05" }, { amount: "500.00", due: "2026-10-15" }] }) };
	const withNum = (id: string, date: string, amount: string) => expense(id, date, amount, { supplier: SUPPLIER.name, supplierVat: SUPPLIER.vat, docType: "fattura", docNumber: "R-5", category: "consulenze" });
	const spese = (answer: string) => /• Spese: ([^ ]+ €)/.exec(answer)?.[1];

	it("1: an expense's amount is spent once over the whole register: the months add up to the period, and a balance between the instalments takes the second off", async () => {
		const s = await setup({ files: R5, paid: { "R-5#1": "2026-09-05T08:00:00.000Z", "R-5#2": "2026-10-15T08:00:00.000Z" }, expenses: [withNum("S-2026-0001", "2026-09-05", "500")], quotes: [], entries: [] });
		expect(spese(await s.run({ op: "summary", period: "settembre" }))).toBe("500,00 €");
		expect(spese(await s.run({ op: "summary", period: "ottobre" }))).toBe("500,00 €");
		expect(spese(await s.run({ op: "summary", from: "1/9/2026", to: "18/10/2026" }))).toBe("1.000,00 €");
		const trend = await s.run({ op: "trend", months: 2 });
		expect(trend).toContain("• settembre 2026: fatturati 0,00 €, incassati 0,00 €, spese 500,00 €, margine −500,00 €");
		expect(trend).toContain("• ottobre 2026 (fino al 18): fatturati 0,00 €, incassati 0,00 €, spese 500,00 €, margine −500,00 €");
		expect(trend).toContain("Totale: fatturati 0,00 €, incassati 0,00 €, spese 1.000,00 €, margine −1.000,00 €.");
		// The balance of 1 October holds the expense and the first instalment: the second is taken off.
		const invoices = await s.registerNow();
		const rolled = rollForward({ amount: "1000", date: "2026-10-01", by: "u", at: "2026-10-01T18:00:00.000Z" }, "2026-10-18T08:00:00.000Z", TODAY, invoices, [withNum("S-2026-0001", "2026-09-05", "500")], [], dayOf);
		expect(rolled?.paidPassive.map((r) => [r.invoice.doc.number, r.instalment.n, r.cents])).toEqual([["R-5", 2, 50000n]]);
		expect(rolled?.net).toBe(-50000n);
	});

	it("2: an expense with the invoice's number smaller than the instalment stands for none: all counted, said as maybe an acconto", async () => {
		const s = await setup({ files: R5, paid: { "R-5#1": "2026-10-05T08:00:00.000Z", "R-5#2": "2026-10-15T08:00:00.000Z" }, expenses: [withNum("S-2026-0001", "2026-10-05", "300")], quotes: [], entries: [] });
		const answer = await s.run({ op: "summary", period: "ottobre" });
		expect(answer).toContain("• Spese: 1.300,00 € (1 spesa registrata, 2 fatture di fornitori pagate)");
		expect(outside(answer)).toContain("Forse è lo stesso pagamento, contato due volte (nel riquadro): chiedi a chi ti scrive.");
		expect(inside(answer)).toBe(`la spesa «${SUPPLIER.name}» del 5 ottobre 2026 (300,00 €), forse un acconto della rata di 500,00 € della fattura R-5 di ${SUPPLIER.name}`);
		const invoices = await s.registerNow();
		const r5 = invoices.find((i) => i.doc.number === "R-5") as Invoice;
		const both = [
			{ invoice: r5, cents: 50000n, day: "2026-10-05" },
			{ invoice: r5, cents: 50000n, day: "2026-10-15" },
		];
		const partial = [withNum("S-1", "2026-10-05", "300")];
		expect(pairPaidWithExpenses(both, partial)).toEqual([false, false]);
		expect(maybeTwins(both, partial).map((t) => [t.why, t.paid.day])).toEqual([["partial", "2026-10-05"]]);
		// One that holds an instalment still covers it, and the next while its amount lasts.
		expect(pairPaidWithExpenses(both, [withNum("S-2", "2026-10-05", "500")])).toEqual([true, false]);
		const rolled = rollForward({ amount: "1000", date: "2026-10-01", by: "u", at: "2026-10-01T18:00:00.000Z" }, "2026-10-18T08:00:00.000Z", TODAY, invoices, partial, [], dayOf);
		expect(rolled?.paidPassive).toHaveLength(2);
		expect(rolled?.maybe?.map((t) => t.why)).toEqual(["partial"]);
	});
});

/** Cents as the answers write them. */
function euroText(cents: bigint): string {
	const digits = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
	return `${cents < 0n ? "−" : ""}${digits.slice(0, -2).replace(/\B(?=(\d{3})+$)/g, ".")},${digits.slice(-2)} €`;
}
