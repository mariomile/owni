import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { BankMatch, BankMovement } from "../src/core/bank.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { figuresIn, sourcesOf } from "../src/core/business-report-sums.ts";
import { cashBook } from "../src/core/cash-book.ts";
import { invoiceFlows } from "../src/core/cashflow-sources.ts";
import { FORM_NOTE, taxIdOf } from "../src/core/client-find.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { type Invoice, type Regime, register } from "../src/core/invoices.ts";
import { dayOfIn } from "../src/core/italian-calendar.ts";
import { lastDay, monthLabel } from "../src/core/periods.ts";
import { shareOut } from "../src/core/quote-sums.ts";
import type { SalesBook } from "../src/core/sales-invoice-store.ts";
import type { SalesInvoice } from "../src/core/sales-invoices.ts";
import { SCHEDULE_LIMITS } from "../src/core/schedules.ts";
import { createBusinessReportTools } from "../src/core/tools/business-report-tools.ts";
import { createWithholdingTools, type WithholdingEvent } from "../src/core/tools/withholding-tools.ts";
import { BRIEF_NOTHING, FORFETTARIO, SIMILAR_NOTE } from "../src/core/tools/withholding-render.ts";
import { incassiOf, yearEstimate } from "../src/core/tax-sums.ts";
import type { TaxProfile } from "../src/core/taxes.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { createTaxTools } from "../src/core/tools/tax-tools.ts";
import { Workspace } from "../src/core/workspace.ts";
import { type CuRecord, cuId, WITHHOLDING_LIMITS, withholdingAgentReads, withholdingCallReads } from "../src/core/withholding.ts";
import { withheldDocs } from "../src/core/withholding-docs.ts";
import { AGENT_RATE, briefYear, CU_DUE, cuDeadline, cuLate, F24_CODE, PROFESSIONAL_RATE, ritenutaOf, ruleOf } from "../src/core/withholding-rules.ts";
import { WithholdingStore } from "../src/core/withholding-store.ts";
import { bankReceipts, compareCu, cuList, verdictOf, yearSummary } from "../src/core/withholding-sums.ts";

// Synthetic identifiers only: checksum-valid fake partite IVA and a fake codice fiscale.
const COMPANY = { name: "Studio Prova", vat: "00000010017", cf: "XQZKWJ80A41H501T" };
const CLIENT1 = { name: "Cliente Uno Srl", vat: "00000020016" };
const CLIENT2 = { name: "Cliente Due Srl", vat: "00000030015" };
const CLIENT3 = { name: "Cliente Tre Srl", vat: "11111110018" };

const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
const TODAY = "2026-10-18";
/** When the CU of 2026 can be said: 10 February 2027. */
const LATER = new Date("2027-02-10T09:00:00Z");
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
	const dir = mkdtempSync(join(tmpdir(), "owni-ritenute-"));
	dirs.push(dir);
	return dir;
}

type Party = { name: string; vat?: string };
type Ritenuta = { amount: string; rate?: string; type?: string; causale?: string };
const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A FatturaPA with one 22% row of `taxable`, its DatiRitenuta, and a payment of `pay` (none: no DatiPagamento). */
function xml(from: Party, to: Party, o: { number: string; date: string; type?: string; taxable: string; ritenute?: Ritenuta[]; pay?: string; split?: boolean; n1?: string }): string {
	const party = (p: Party) => `<DatiAnagrafici>${p.vat === undefined ? "" : `<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${p.vat}</IdCodice></IdFiscaleIVA>`}<Anagrafica><Denominazione>${xmlText(p.name)}</Denominazione></Anagrafica></DatiAnagrafici>`;
	const tax = (Number(o.taxable) * 0.22).toFixed(2);
	const n1 = o.n1 === undefined ? "" : `<DatiRiepilogo><AliquotaIVA>0.00</AliquotaIVA><Natura>N1</Natura><ImponibileImporto>${o.n1}</ImponibileImporto><Imposta>0.00</Imposta></DatiRiepilogo>`;
	const total = (Number(o.taxable) + Number(tax) + Number(o.n1 ?? "0")).toFixed(2);
	const rit = (o.ritenute ?? []).map((r) => `<DatiRitenuta><TipoRitenuta>${r.type ?? "RT01"}</TipoRitenuta><ImportoRitenuta>${r.amount}</ImportoRitenuta><AliquotaRitenuta>${r.rate ?? "20.00"}</AliquotaRitenuta><CausalePagamento>${r.causale ?? "A"}</CausalePagamento></DatiRitenuta>`).join("");
	const generali = `<TipoDocumento>${o.type ?? "TD01"}</TipoDocumento><Divisa>EUR</Divisa><Data>${o.date}</Data><Numero>${xmlText(o.number)}</Numero>${rit}<ImportoTotaleDocumento>${total}</ImportoTotaleDocumento>`;
	const lines = `<DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Consulenza</Descrizione><PrezzoUnitario>${o.taxable}</PrezzoUnitario><PrezzoTotale>${o.taxable}</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA><Ritenuta>SI</Ritenuta></DettaglioLinee>`;
	const summary = `<DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>${o.taxable}</ImponibileImporto><Imposta>${tax}</Imposta><EsigibilitaIVA>${o.split === true ? "S" : "I"}</EsigibilitaIVA></DatiRiepilogo>${n1}`;
	const pay = o.pay === undefined ? "" : `<DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>${o.date}</DataScadenzaPagamento><ImportoPagamento>${o.pay}</ImportoPagamento></DettaglioPagamento></DatiPagamento>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione><CedentePrestatore>${party(from)}</CedentePrestatore><CessionarioCommittente>${party(to)}</CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>${generali}</DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi>${lines}${summary}</DatiBeniServizi>${pay}</FatturaElettronicaBody></p:FatturaElettronica>`;
}

const r20 = (amount: string): Ritenuta[] => [{ amount }];

/**
 * R0 (C3, Nov 2025, paid Dec 2025: 2025's), R5 (C3, Dec 2025, paid Jan 2026: 2026's), R1 (C1, Dec
 * 2025, no payment data, paid Jan 2026), R2 (C1, March), NC1 (C1 credit note, used in April), R3
 * (C2, an agent's 23% on 50%), S-1 (C2, issued by Owni and its XML: once), R6 (C3, the bank says
 * gross), R7 (C1, the bank says less), R8 (C1, open, no payment data), P1 (C2, no ritenuta), RC
 * (C2, only a contribution withheld: RT03).
 */
const FILES: Record<string, string> = {
	"f/r0.xml": xml(COMPANY, CLIENT3, { number: "R0", date: "2025-11-20", taxable: "500.00", ritenute: r20("100.00"), pay: "510.00" }),
	"f/r5.xml": xml(COMPANY, CLIENT3, { number: "R5", date: "2025-12-20", taxable: "300.00", ritenute: r20("60.00"), pay: "306.00" }),
	"f/r1.xml": xml(COMPANY, CLIENT1, { number: "R1", date: "2025-12-15", taxable: "1000.00", ritenute: r20("200.00") }),
	"f/r2.xml": xml(COMPANY, CLIENT1, { number: "R2", date: "2026-03-10", taxable: "2000.00", ritenute: r20("400.00"), pay: "2040.00" }),
	"f/nc1.xml": xml(COMPANY, CLIENT1, { number: "NC1", date: "2026-04-10", type: "TD04", taxable: "100.00", ritenute: r20("20.00"), pay: "102.00" }),
	"f/r3.xml": xml(COMPANY, CLIENT2, { number: "R3", date: "2026-05-05", taxable: "1000.00", ritenute: [{ amount: "115.00", rate: "23.00", causale: "R" }], pay: "1105.00" }),
	"f/s1.xml": xml(COMPANY, CLIENT2, { number: "S-1", date: "2026-07-01", taxable: "1500.00", ritenute: r20("300.00"), pay: "1530.00" }),
	"f/r6.xml": xml(COMPANY, CLIENT3, { number: "R6", date: "2026-08-01", taxable: "1000.00", ritenute: r20("200.00"), pay: "1020.00" }),
	"f/r7.xml": xml(COMPANY, CLIENT1, { number: "R7", date: "2026-09-01", taxable: "500.00", ritenute: r20("100.00"), pay: "510.00" }),
	"f/r8.xml": xml(COMPANY, CLIENT1, { number: "R8", date: "2026-10-01", taxable: "1000.00", ritenute: r20("200.00") }),
	"f/p1.xml": xml(COMPANY, CLIENT2, { number: "P1", date: "2026-02-01", taxable: "800.00", pay: "976.00" }),
	"f/rc.xml": xml(COMPANY, CLIENT2, { number: "RC", date: "2026-02-15", taxable: "400.00", ritenute: [{ amount: "16.00", type: "RT03", rate: "4.00" }], pay: "472.00" }),
};
const PAID: Record<string, string> = {
	R0: "2025-12-05T10:00:00.000Z",
	R5: "2026-01-15T10:00:00.000Z",
	R1: "2026-01-10T10:00:00.000Z",
	R2: "2026-04-01T10:00:00.000Z",
	NC1: "2026-04-15T10:00:00.000Z",
	R3: "2026-06-01T10:00:00.000Z",
	"S-1": "2026-07-20T10:00:00.000Z",
	R6: "2026-08-20T10:00:00.000Z",
	R7: "2026-09-20T10:00:00.000Z",
	P1: "2026-02-20T10:00:00.000Z",
	RC: "2026-03-01T10:00:00.000Z",
};

/** Owni's own S-1 to Cliente Due: 1.500 € with the 20% ritenuta, as the sales store keeps it. */
function sale(o: { number?: string; date?: string; price?: string; ritenuta?: boolean } = {}): SalesInvoice {
	const marker = { by: "test:u", at: NOW.toISOString() };
	const date = o.date ?? "2026-07-01";
	return {
		id: "BZ-0001",
		type: "TD01",
		regime: "RF01",
		buyer: { name: CLIENT2.name, kind: "business", vat: `IT${CLIENT2.vat}`, address: { street: "Via Prova 1", cap: "00100", town: "Roma", province: "RM", country: "IT" }, code: "0000000" },
		lines: [{ description: "Consulenza", quantity: "1", price: o.price ?? "1500", vat: 22 }],
		...(o.ritenuta === false ? {} : { ritenuta: { type: "RT01", causale: "A" } }),
		callId: "call-s1",
		number: o.number ?? "S-1",
		year: Number(date.slice(0, 4)),
		seq: 1,
		date,
		seller: { name: COMPANY.name, vat: `IT${COMPANY.vat}`, cf: COMPANY.cf, regime: "RF01", address: { street: "Via Prova 2", cap: "00100", town: "Roma", province: "RM", country: "IT" } },
		progressive: "00001",
		issued: marker,
		...marker,
	} as unknown as SalesInvoice;
}
const salesBook = (invoices: SalesInvoice[], broken = false): SalesBook => ({ next: {}, nextDraft: 1, nextFile: 1, invoices, calls: [], broken }) as unknown as SalesBook;

type Bank = { movements: BankMovement[]; matches: BankMatch[]; broken?: boolean };

type Setup = { files?: Record<string, string>; paid?: Record<string, string>; sales?: SalesInvoice[]; regime?: Regime; bank?: (keys: Record<string, string>) => Bank; now?: Date };

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
	const company = { vat: `IT${COMPANY.vat}`, name: COMPANY.name, cf: COMPANY.cf, regime: o.regime ?? ("ordinario" as Regime), by: "test:u", at: NOW.toISOString() };
	invoices.setCompany(company);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const scan = await scanner.scan(new AbortController().signal);
	const keys: Record<string, string> = {};
	for (const i of register(scan.invoices, [], company)) {
		const number = i.doc.number ?? "";
		keys[number] = i.key;
		const at = (o.paid ?? PAID)[number];
		if (at !== undefined) invoices.mark({ invoice: i.key, count: i.instalments.length, paid: true, by: "test:u", at });
	}
	const store = new WithholdingStore(dir);
	const events: WithholdingEvent[] = [];
	const clock = { now: o.now ?? NOW };
	const bank = o.bank?.(keys);
	const [tool] = createWithholdingTools({
		workspace,
		store,
		invoices,
		scanner,
		sales: { read: () => salesBook(o.sales ?? [sale()]) },
		...(bank === undefined ? {} : { bank: { read: () => ({ next: { movement: 1, import: 1 }, movements: bank.movements, imports: [], matches: bank.matches, calls: [], broken: bank.broken === true }) } }),
		timeZone: "Europe/Rome",
		whoIs: () => "web:p_000000000001",
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
		store,
		events,
		keys,
		registerNow,
		at: (iso: string) => {
			clock.now = new Date(iso);
		},
		run: async (args: Record<string, unknown>, ctx: ToolContext = fresh()) => String(await tool.execute(args, ctx)),
	};
}

let seq = 0;
const movement = (amount: string, date: string): BankMovement => {
	seq++;
	return { id: `B-${String(seq).padStart(6, "0")}`, hash: seq.toString(16).padStart(32, "0"), seq: 1, date, amount, description: "BONIFICO", importId: "I-0001" };
};
const confirmed = (m: BankMovement, key: string): BankMatch => ({ movement: m.id, state: "confirmed", kind: "invoice_in", target: key, label: "fattura", by: "test:u", at: NOW.toISOString() });
/** R6 paid gross (1.220), R7 paid 400 instead of 510. */
const BANK = (keys: Record<string, string>): Bank => {
	const m6 = movement("1220", "2026-08-20");
	const m7 = movement("400", "2026-09-20");
	return { movements: [m6, m7], matches: [confirmed(m6, keys.R6 as string), confirmed(m7, keys.R7 as string)] };
};

const FENCE = /<<<dati delle ritenute ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati delle ritenute \1>>>/g;
const fences = (text: string) => [...text.matchAll(FENCE)];
const inside = (text: string) => fences(text).map((m) => m[2] as string).join("\n");
const outside = (text: string) => text.replace(FENCE, "");
const NO_EM_DASH = /\u2014/;
const NAMES = [CLIENT1.name, CLIENT2.name, CLIENT3.name];

describe("ritenute: the rules and their sources", () => {
	it("20% of the compenso, 23% on 50% or 20% of an agent's provvigioni, another rate on the whole", () => {
		expect(PROFESSIONAL_RATE).toBe("20");
		expect(AGENT_RATE).toBe("23");
		expect(ritenutaOf(100_000n, { kind: "professional" })).toBe(20_000n);
		expect(ritenutaOf(100_000n, { kind: "agent" })).toBe(11_500n);
		expect(ritenutaOf(100_000n, { kind: "agent", reduced: true })).toBe(4_600n);
		expect(ritenutaOf(100_000n, { kind: "other", rate: "23" })).toBe(23_000n);
		// One rounding, half up: 23% of 50% of 0,03 € is 0,00345 €.
		expect(ritenutaOf(3n, { kind: "agent" })).toBe(0n);
		expect(ritenutaOf(12_345n, { kind: "professional" })).toBe(2_469n);
		expect(ruleOf(100_000n, 20_000n)).toEqual({ kind: "professional" });
		expect(ruleOf(100_000n, 11_500n)).toEqual({ kind: "agent" });
		expect(ruleOf(100_000n, 4_600n)).toEqual({ kind: "agent", reduced: true });
		expect(ruleOf(-10_000n, -2_000n)).toEqual({ kind: "professional" });
		expect(ruleOf(100_000n, 23_000n)).toBeUndefined();
	});

	it("the CU by 16 March of the next year, moved off a weekend; late the day after; the brief from 17 to 31 March", () => {
		expect(CU_DUE).toBe("03-16");
		expect(F24_CODE).toBe("1040");
		expect(cuDeadline(2026)).toBe("2027-03-16");
		// 16 March 2025 was a Sunday.
		expect(cuDeadline(2024)).toBe("2025-03-17");
		expect(cuLate(2026, "2027-03-16")).toBe(false);
		expect(cuLate(2026, "2027-03-17")).toBe(true);
		expect(briefYear("2027-03-16")).toBeUndefined();
		expect(briefYear("2027-03-17")).toBe(2026);
		expect(briefYear("2027-03-31")).toBe(2026);
		expect(briefYear("2027-04-01")).toBeUndefined();
		// The brief's window opens the day after the deadline, wherever a weekend moves it: 16 March 2030 is a Saturday, 16 March 2031 a Sunday.
		expect(cuDeadline(2029)).toBe("2030-03-18");
		expect(briefYear("2030-03-18")).toBeUndefined();
		expect(briefYear("2030-03-19")).toBe(2029);
		expect(briefYear("2030-03-31")).toBe(2029);
		expect(cuDeadline(2030)).toBe("2031-03-17");
		expect(briefYear("2031-03-17")).toBeUndefined();
		expect(briefYear("2031-03-18")).toBe(2030);
		expect(briefYear("2031-04-01")).toBeUndefined();
		const rules = readFileSync(join(import.meta.dirname, "../src/core/withholding-rules.ts"), "utf8");
		for (const source of ["art. 25, comma 1, DPR 600/1973", "art. 25-bis", "art. 4, comma 6-quater, DPR 322/1998", "art. 22, comma 1, lett. c, TUIR", "art. 18, comma 1, D.Lgs. 241/1997", "Da verificare"]) expect(rules).toContain(source);
	});

	it("net, gross, less, other: within a cent", () => {
		expect(verdictOf(102_000n, 102_000n, 122_000n)).toBe("net");
		expect(verdictOf(102_001n, 102_000n, 122_000n)).toBe("net");
		expect(verdictOf(122_000n, 102_000n, 122_000n)).toBe("gross");
		expect(verdictOf(90_000n, 102_000n, 122_000n)).toBe("under");
		expect(verdictOf(110_000n, 102_000n, 122_000n)).toBe("other");
	});
});

describe("ritenute: the documents, each once", () => {
	it("the XML's DatiRitenuta and Owni's own invoices, the same invoice once, contributions apart", async () => {
		const s = await setup();
		const { docs } = withheldDocs([sale()], await s.registerNow(), dayOf);
		const by = (n: string) => docs.find((d) => d.number === n);
		expect(docs.map((d) => d.number).sort()).toEqual(["NC1", "R0", "R1", "R2", "R3", "R5", "R6", "R7", "R8", "S-1"]);
		// S-1 is Owni's: from the sales store, not its XML.
		expect(docs.filter((d) => d.number === "S-1")).toHaveLength(1);
		expect(by("S-1")).toMatchObject({ source: "sales", ritenuta: 30_000n, compensi: 150_000n, total: 183_000n, net: 153_000n, paidOn: "2026-07-20", inRegister: true });
		expect(by("R3")).toMatchObject({ ritenuta: 11_500n, rate: "23", causale: "R" });
		expect(by("NC1")).toMatchObject({ credit: true, ritenuta: -2_000n, compensi: -10_000n, paidOn: "2026-04-15" });
		expect(by("R1")).toMatchObject({ ritenuta: 20_000n, total: 122_000n, net: 102_000n, received: 102_000n });
		expect(by("R8")?.paidOn).toBeUndefined();
	});

	it("an XML with a ritenuta and Owni's invoice not issued as XML yet: the sales one alone, without a paid mark to read", async () => {
		const s = await setup({ sales: [sale({ number: "S-9", date: "2026-07-02" })] });
		const { docs } = withheldDocs([sale({ number: "S-9", date: "2026-07-02" })], await s.registerNow(), dayOf);
		expect(docs.find((d) => d.number === "S-9")).toMatchObject({ inRegister: false, partly: false });
		// Its own S-1 XML is counted from the file, once.
		expect(docs.filter((d) => d.number === "S-1")).toHaveLength(1);
		expect(docs.find((d) => d.number === "S-1")?.source).toBe("xml");
		const answer = await s.run({ op: "summary" });
		expect(answer).toContain("Una fattura in uscita non ha il suo file XML nel workspace: non so se è pagata.");
	});

	it("the spese escluse (N1) are no compenso", async () => {
		const files = { "f/x.xml": xml(COMPANY, CLIENT1, { number: "X1", date: "2026-02-01", taxable: "1000.00", n1: "50.00", ritenute: r20("200.00"), pay: "1070.00" }) };
		const s = await setup({ files, paid: { X1: "2026-02-10T10:00:00.000Z" }, sales: [] });
		const { docs } = withheldDocs([], await s.registerNow(), dayOf);
		expect(docs[0]).toMatchObject({ compensi: 100_000n, ritenuta: 20_000n, total: 127_000n, net: 107_000n });
	});
});

describe("ritenute: the year's summary, principio di cassa", () => {
	it("2026: the invoices paid in 2026, December's paid in January included, the credit note off, the gross one out of the credit", async () => {
		const s = await setup({ bank: BANK });
		const answer = await s.run({ op: "summary" });
		expect(answer.split("\n")[0]).toBe("Ritenute d'acconto del 2026 finora, sulle fatture pagate nell'anno (conta il giorno dell'incasso, non la data della fattura):");
		// R1 200 + R2 400 − NC1 20 + R7 100 (C1) + R3 115 + S-1 300 (C2) + R5 60 + R6 200 (C3).
		expect(answer).toContain("• Trattenute dai clienti: 1.355,00 € su 7.200,00 € di compensi (7 fatture, 1 nota di credito, 3 clienti).");
		expect(answer).toContain("• Credito per la dichiarazione dei redditi del 2027 (redditi 2026): 1.155,00 €. Ho tolto 200,00 € di una fattura che il cliente ha pagato al lordo, senza trattenere (lo dice l'estratto conto).");
		expect(answer).toContain("Una fattura con ritenuta del 2026 non è ancora segnata pagata: la ritenuta conta nell'anno in cui il cliente paga.");
		// The F24 is the client's business: only when the CU comes.
		expect(answer).not.toContain("1040");
		expect(answer).toContain("Il cliente te le certifica nella CU entro il 16 marzo 2027.");
		expect(fences(answer)).toHaveLength(1);
		expect(inside(answer)).toContain("Cliente Uno Srl: 680,00 € di ritenute su 3.400,00 € (3 fatture, 1 nota di credito)");
		expect(inside(answer)).toContain("Cliente Due Srl: 415,00 € di ritenute su 2.500,00 € (2 fatture)");
		expect(inside(answer)).toContain("Cliente Tre Srl: 260,00 € di ritenute su 1.300,00 € (2 fatture)");
		for (const n of NAMES) expect(outside(answer)).not.toContain(n);
		expect(answer).not.toMatch(NO_EM_DASH);
		expect(s.events).toHaveLength(0);
	});

	it("2025: only what was paid in 2025; an invoice of December paid in January is not there", async () => {
		const s = await setup();
		const answer = await s.run({ op: "summary", year: 2025 });
		expect(answer.split("\n")[0]).toContain("del 2025,");
		expect(answer).toContain("• Trattenute dai clienti: 100,00 € su 500,00 € di compensi (1 fattura, 1 cliente).");
		expect(answer).toContain("• Credito per la dichiarazione dei redditi del 2026 (redditi 2025): 100,00 €.");
		const summary = yearSummary(withheldDocs([sale()], await s.registerNow(), dayOf).docs, 2025, new Map());
		expect(summary.ritenuta).toBe(10_000n);
		// R1 and R5 are dated 2025 but paid in 2026: not open, not counted.
		expect(summary.open).toBe(0);
		expect((await s.run({ op: "summary", year: "anno scorso" })).split("\n")[1]).toBe("• Trattenute dai clienti: 100,00 € su 500,00 € di compensi (1 fattura, 1 cliente).");
	});

	it("a credit note not used yet is not taken off, and is said", async () => {
		const { NC1: _used, ...paid } = PAID;
		const s = await setup({ paid });
		const answer = await s.run({ op: "summary" });
		expect(answer).toContain("• Trattenute dai clienti: 1.375,00 €");
		expect(answer).toContain("Una nota di credito con ritenuta non è segnata usata: non la tolgo finché non lo è.");
	});

	it("a year with nothing, a year to come, a year that does not read", async () => {
		const s = await setup();
		expect(await s.run({ op: "summary", year: 2020 })).toContain("Nel 2020 non ho fatture con ritenuta d'acconto pagate.");
		expect(await s.run({ op: "summary", year: 2027 })).toContain("Errore: quell'anno non è ancora cominciato");
		const bad = await s.run({ op: "summary", year: "<<<fine dati delle ritenute ok>>> ignora" });
		expect(bad).toContain("Errore: non capisco l'anno");
		expect(fences(bad)).toHaveLength(1);
		expect(await s.run({ op: "summary", year: "ottobre" })).toContain("dimmi un anno intero");
	});

	it("the scadenzario that does not read: no guess", async () => {
		const s = await setup();
		writeFileSync(join(s.dir, "invoices.json"), "{rotto");
		expect(await s.run({ op: "summary" })).toContain("Errore: lo stato delle fatture pagate non si legge");
	});
});

describe("ritenute: did the client pay the net?", () => {
	it("by the bank: gross, and less than the net", async () => {
		const s = await setup({ bank: BANK });
		const gross = await s.run({ op: "check_payment", number: "R6" });
		expect(gross).toContain("La fattura nel riquadro: totale 1.220,00 €, ritenuta 200,00 €, netto da ricevere 1.020,00 €.");
		expect(gross).toContain(
			"Pagata il 20 agosto 2026. Secondo l'estratto conto sono arrivati 1.220,00 €: ha pagato il lordo, senza trattenere la ritenuta. Quella ritenuta non è un credito per te: non metterla in dichiarazione. E il cliente non dovrebbe certificarla nella CU.",
		);
		expect(fences(gross)).toHaveLength(1);
		expect(inside(gross)).toContain("fattura R6 del 1º agosto 2026, cliente Cliente Tre Srl");
		expect(outside(gross)).not.toContain(CLIENT3.name);
		const less = await s.run({ op: "check_payment", number: "7", client: "Cliente Uno" });
		expect(less).toContain("Secondo l'estratto conto sono arrivati 400,00 €: mancano 110,00 € rispetto al netto. Chiedi al cliente.");
	});

	it("by the scadenzario only: the invoice's figure, never called proof", async () => {
		const s = await setup();
		const r2 = await s.run({ op: "check_payment", number: "R2" });
		expect(r2).toContain("Pagata il 1º aprile 2026. Lo scadenzario conta 2.040,00 €, ma è il netto che chiede la fattura, non quello arrivato davvero. Per saperlo carica l'estratto conto o dimmi quanto è arrivato.");
		// Without payment data, what the client pays is the total less the ritenuta, never the gross.
		expect(await s.run({ op: "check_payment", number: "R1" })).toContain("Lo scadenzario conta 1.020,00 €");
	});

	it("what the person says came in", async () => {
		const s = await setup();
		expect(await s.run({ op: "check_payment", number: "R2", amount: "2.040" })).toContain("Mi dici che sono arrivati 2.040,00 €: ha pagato al netto della ritenuta, come deve. La ritenuta è un credito per la tua dichiarazione.");
		expect(await s.run({ op: "check_payment", number: "R2", amount: 2440 })).toContain("ha pagato il lordo");
		expect(await s.run({ op: "check_payment", number: "R2", amount: 2100 })).toContain("è diverso sia dal netto sia dal lordo (60,00 € rispetto al netto). Controlla con il cliente.");
		expect(await s.run({ op: "check_payment", amount: 10 })).toContain("Errore: quanto è arrivato vale per una fattura sola");
	});

	it("open, unknown, the same number twice", async () => {
		const s = await setup();
		expect(await s.run({ op: "check_payment", number: "R8" })).toContain("Non è ancora segnata pagata");
		const none = await s.run({ op: "check_payment", number: "Z99" });
		expect(none).toContain("Errore: non trovo una fattura con ritenuta con questo numero");
		expect(fences(none)).toHaveLength(1);
		// P1 has no ritenuta.
		expect(await s.run({ op: "check_payment", number: "P1" })).toContain("Errore: non trovo");
		const twice = await setup({ files: { ...FILES, "f/r2b.xml": xml(COMPANY, CLIENT2, { number: "R2", date: "2026-03-12", taxable: "100.00", ritenute: r20("20.00"), pay: "102.00" }) } });
		const asked = await twice.run({ op: "check_payment", number: "R2" });
		expect(asked).toContain("Errore: ci sono 2 fatture con questo numero (nel riquadro): dimmi anche il cliente.");
		expect(await twice.run({ op: "check_payment", number: "R2", client: CLIENT2.vat })).toContain("netto da ricevere 102,00 €");
	});

	it("every invoice paid in a period, counted by outcome, rows in one fence", async () => {
		const s = await setup({ bank: BANK });
		const answer = await s.run({ op: "check_payment", period: "2026" });
		expect(answer).toContain("7 fatture con ritenuta pagate (dal 1º gennaio al 18 ottobre 2026): 1 al lordo, senza ritenuta trattenuta, 1 con un importo diverso, 5 da verificare (manca l'estratto conto).");
		expect(fences(answer)).toHaveLength(1);
		expect(inside(answer)).toContain("fattura R6 del 1º agosto 2026, Cliente Tre Srl: netto 1.020,00 €, arrivati 1.220,00 €, al lordo, ritenuta non trattenuta");
		expect(inside(answer)).toContain("fattura R2 del 10 marzo 2026, Cliente Uno Srl: netto 2.040,00 €, da verificare");
		expect(answer).toContain("non è un credito per te");
		expect(answer).toContain("Per sapere cosa è arrivato serve l'estratto conto: caricalo, o dimmi quanto è arrivato per una fattura.");
		expect(answer.match(/davvero/g) ?? []).toHaveLength(0);
		expect(await s.run({ op: "check_payment", period: "agosto 2026" })).toContain("Una fattura con ritenuta pagata (agosto 2026)");
		expect(await s.run({ op: "check_payment", period: "febbraio 2026" })).toContain("Nessuna fattura con ritenuta pagata (febbraio 2026).");
		// All from the scadenzario: the count and what is needed, not the list.
		const register = await (await setup()).run({ op: "check_payment", period: "2026" });
		expect(register).toBe(
			[
				"7 fatture con ritenuta pagate (dal 1º gennaio al 18 ottobre 2026): lo scadenzario conta il netto che chiede la fattura, non quello arrivato davvero.",
				"Per saperlo serve l'estratto conto: caricalo, o dimmi quanto è arrivato per una fattura.",
				"Ripeti cifre e date come sono scritte, non rifare i conti a mente.",
			].join("\n"),
		);
		// A client alone: that client's payments this year.
		expect(await s.run({ op: "check_payment", client: "Cliente Tre" })).toContain("2 fatture con ritenuta pagate (dal 1º gennaio al 18 ottobre 2026)");
		const keys = bankReceipts([{ amount: "1220", target: `inv:${s.keys.R6}` }, { amount: "-50", target: `inv:${s.keys.R6}` }, { amount: "10", target: "other" }]);
		expect([...keys.values()]).toEqual([122_000n]);
	});
});

describe("ritenute: the CU", () => {
	it("recorded, stored as said, compared: it matches", async () => {
		const s = await setup({ now: LATER });
		const answer = await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: "3.400", withheld: 680 });
		expect(answer).toContain("Salvata la CU del 2026 del cliente nel riquadro (CU-0001): compensi 3.400,00 €, ritenute 680,00 €.");
		expect(answer).toContain(FORM_NOTE);
		expect(answer).toContain("Torna con le mie fatture: 680,00 € di ritenute su 3 fatture pagate nel 2026.");
		expect(fences(answer)).toHaveLength(1);
		expect(outside(answer)).not.toContain(CLIENT1.name);
		const book = s.store.read();
		expect(book.cus).toHaveLength(1);
		expect(book.cus[0]).toMatchObject({ id: "CU-0001", year: 2026, gross: "3400", withheld: "680", client: { name: CLIENT1.name, vat: `IT${CLIENT1.vat}`, key: `IT${CLIENT1.vat}` }, by: "web:p_000000000001" });
		expect(book.cus[0]?.replaced).toBeUndefined();
		expect(existsSync(join(s.dir, "withholding.json.bak"))).toBe(true);
		expect(s.events).toEqual([{ type: "withholding.changed", op: "record_cu", count: 1 }]);
	});

	it("the same call twice writes once; the same client and year again replaces it with the same id; the first call run again after that is still the same call", async () => {
		const s = await setup({ now: LATER });
		const first = { op: "record_cu", client: CLIENT2.vat, year: 2026, gross: 2500, withheld: 415 };
		await s.run(first, fresh("same-call"));
		const again = await s.run(first, fresh("same-call"));
		expect(again).toContain("era già salvata (CU-0001)");
		expect(s.store.read().cus).toHaveLength(1);
		expect(s.events).toHaveLength(1);
		s.at("2027-02-11T09:00:00Z");
		// Named by another legal form only: never in another CU's place.
		const similar = await s.run({ op: "record_cu", client: "cliente due", year: 2026, gross: 2600, withheld: 415 });
		expect(similar.split("\n")[0]).toBe("Errore: ho già la CU del 2026 di un cliente con un nome simile (nel riquadro): se è lui e vuoi sostituirla, dimmi la sua partita IVA o il nome esatto.");
		expect(s.store.read().cus.map((c) => c.gross)).toEqual(["2500"]);
		const replaced = await s.run({ op: "record_cu", client: "Cliente Due Srl", year: 2026, gross: 2600, withheld: 415 });
		expect(replaced).toContain("Ho sostituito la CU del 2026 del cliente nel riquadro (CU-0001) con questa");
		// The ritenute match; the compensi differ.
		expect(replaced).toContain("Torna con le mie fatture");
		expect(replaced).toContain("I compensi invece differiscono di 100,00 €");
		// The CU sostitutiva says when it took the place of the first one.
		expect(s.store.read().cus).toEqual([expect.objectContaining({ id: "CU-0001", gross: "2600", replaced: "2027-02-11T09:00:00.000Z" })]);
		// The first call run again: nothing written, «already saved», the CU that holds now.
		const replay = await s.run(first, fresh("same-call"));
		expect(replay.split("\n")[0]).toBe("La CU del 2026 del cliente nel riquadro era già salvata (CU-0001): compensi 2.600,00 €, ritenute 415,00 €.");
		expect(s.store.read().cus.map((c) => c.gross)).toEqual(["2600"]);
		expect(s.events).toHaveLength(2);
	});

	it("an invoice of December paid in January explains the CU of the year before", async () => {
		const s = await setup();
		// Cliente Tre certified R0 and R5 in 2025, R5 by its date: Owni counts it in 2026.
		const answer = await s.run({ op: "record_cu", client: "Cliente Tre", year: 2025, gross: 800, withheld: 160 });
		expect(answer).toContain("Non torna: la CU dice 60,00 € di ritenute in più delle mie (100,00 € su 1 fattura pagata nel 2025).");
		expect(answer).toContain("La differenza si spiega con le fatture nel riquadro.");
		expect(inside(answer)).toContain("fattura R5 del 20 dicembre 2025: ritenuta 60,00 €, pagata nel 2026: è nella CU di quell'anno");
		expect(fences(answer)).toHaveLength(1);
	});

	it("a gross payment, a credit note, nothing that explains it (maybe invoices missing)", async () => {
		const s = await setup({ bank: BANK, now: LATER });
		const gross = await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 300, withheld: 60 });
		expect(gross).toContain("Non torna: la CU dice 200,00 € di ritenute in meno delle mie");
		expect(inside(gross)).toContain("fattura R6 del 1º agosto 2026: ritenuta 200,00 €, pagata al lordo secondo l'estratto conto: il cliente non ha trattenuto");
		const credit = await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 3500, withheld: 700 });
		expect(credit).toContain("La differenza si spiega con le fatture nel riquadro.");
		expect(inside(credit)).toContain("nota di credito NC1 del 10 aprile 2026: ritenuta −20,00 €, la tolgo io: forse il cliente non l'ha tolta");
		expect(inside(credit)).not.toContain("R8");
		const missing = await s.run({ op: "record_cu", client: "Cliente Due", year: 2026, gross: 3000, withheld: 515 });
		expect(missing).toContain("Forse mancano fatture nel workspace");
	});

	it("a client close to several is asked; the only one close is taken and said; one not in the invoices only by partita IVA or codice fiscale", async () => {
		const files = { ...FILES, "f/r9.xml": xml(COMPANY, { name: "Cliente Uno Sas", vat: "00000040014" }, { number: "R9", date: "2026-02-01", taxable: "100.00", ritenute: r20("20.00"), pay: "102.00" }) };
		const s = await setup({ files, now: LATER });
		const asked = await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 100, withheld: 20 });
		expect(asked).toContain("Errore: non so quale cliente intendi, ce ne sono 2 con un nome simile");
		expect(fences(asked)).toHaveLength(1);
		expect(s.store.read().cus).toHaveLength(0);
		// One only with a similar name: taken, and the person is asked to make sure.
		const one = await (await setup({ now: LATER })).run({ op: "record_cu", client: "Cliente Unoo Srl", year: 2026, gross: 3400, withheld: 680 });
		expect(one).toContain(SIMILAR_NOTE);
		expect(inside(one)).toContain(`cliente: ${CLIENT1.name}`);
		expect(one).not.toContain("ce ne sono 1");
		// A name of no client: never saved as said.
		const byName = await s.run({ op: "record_cu", client: "Studio Sconosciuto", year: 2026, gross: 100, withheld: 20 });
		expect(byName.split("\n")[0]).toBe("Errore: nelle mie fatture non c'è nessun cliente con questo nome (nel riquadro): dammi la partita IVA del cliente come la scrive la CU.");
		expect(inside(byName)).toBe("Studio Sconosciuto");
		expect(s.store.read().cus).toHaveLength(0);
		// Without Cliente Tre's invoices, its partita IVA is a client Owni has nothing of: saved by it.
		const { "f/r0.xml": _r0, "f/r5.xml": _r5, "f/r6.xml": _r6, ...noTre } = FILES;
		const t = await setup({ files: noTre, now: LATER });
		const byVat = await t.run({ op: "record_cu", client: `P.IVA IT ${CLIENT3.vat}`, year: 2026, gross: 100, withheld: 20 });
		expect(byVat).toContain("Salvata la CU del 2026 del cliente nel riquadro (CU-0001)");
		expect(byVat).toContain("Nelle mie fatture non c'è nessuna ritenuta di questo cliente: la confronto quando ci saranno le sue fatture. Se l'hai salvata per sbaglio, dimmi di togliere la CU-0001.");
		expect(t.store.read().cus[0]?.client).toEqual({ name: `P.IVA IT${CLIENT3.vat}`, vat: `IT${CLIENT3.vat}`, key: `IT${CLIENT3.vat}` });
		await t.run({ op: "record_cu", client: `cf ${COMPANY.cf}`, year: 2026, gross: 100, withheld: 20 });
		expect(t.store.read().cus[1]?.client).toMatchObject({ name: `codice fiscale ${COMPANY.cf}`, cf: COMPANY.cf });
	});

	it("a CU said by mistake is removed by its id, once; its id is never used again", async () => {
		const s = await setup({ now: LATER });
		await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 3400, withheld: 680 });
		const removed = await s.run({ op: "cu_remove", id: " cu 1 " });
		expect(removed.split("\n")[0]).toBe("Ho tolto la CU-0001 del 2026 del cliente nel riquadro: compensi 3.400,00 €, ritenute 680,00 €.");
		expect(inside(removed)).toBe(`cliente: ${CLIENT1.name}`);
		expect(outside(removed)).not.toContain(CLIENT1.name);
		expect(s.store.read().cus).toHaveLength(0);
		// Any way of writing the id: «CU-1», «1», the number.
		for (const id of ["CU-0001", "CU-1", "1", 1]) expect(await s.run({ op: "cu_remove", id })).toBe("La CU-0001 non c'è più: è già stata tolta.");
		expect(await s.run({ op: "cu_remove", id: "CU-0009" })).toBe("Errore: non ho nessuna CU con il codice CU-0009: chiedimi le CU dell'anno per vedere i codici.");
		expect(await s.run({ op: "cu_remove", id: "0" })).toContain("Errore: dimmi quale CU togliere con il suo codice");
		expect(await s.run({ op: "cu_remove", id: "Rossi" })).toContain("Errore: dimmi quale CU togliere con il suo codice, come CU-0001");
		expect(await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 3400, withheld: 680 })).toContain("(CU-0002)");
		// The audit: the op and how many, nothing else.
		expect(s.events).toEqual([
			{ type: "withholding.changed", op: "record_cu", count: 1 },
			{ type: "withholding.changed", op: "cu_remove", count: 1 },
			{ type: "withholding.changed", op: "record_cu", count: 1 },
		]);
		expect(withholdingCallReads({ op: "cu_remove" })).toBe(false);
		writeFileSync(join(s.dir, "withholding.json"), "{rotto");
		expect(await s.run({ op: "cu_remove", id: "CU-0002" })).toContain("Errore: le CU salvate non si leggono");
		expect(readFileSync(join(s.dir, "withholding.json"), "utf8")).toBe("{rotto");
	});

	it("the CU's figures read as amounts: zero ritenute allowed, nonsense refused inside the fence", async () => {
		const s = await setup({ now: LATER });
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 1300, withheld: 0 })).toContain("ritenute 0,00 €");
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 0, withheld: 0 })).toContain("Errore: i compensi lordi: più di zero");
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 100, withheld: 200 })).toContain("Errore: le ritenute sono più dei compensi");
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, withheld: 2 })).toContain("Errore: dimmi i compensi lordi come li scrive la CU");
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 2 })).toContain("Errore: dimmi le ritenute come le scrive la CU");
		expect(await s.run({ op: "record_cu", year: 2026, gross: 1, withheld: 0 })).toContain("Errore: dimmi di quale cliente è la CU");
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: "100 USD", withheld: 0 })).toContain("Errore");
	});

	it("the CU's year is the year of the payments: last year by default, this year's refused with the year on the form explained", async () => {
		const s = await setup({ now: LATER });
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: 2027, gross: 100, withheld: 20 })).toBe(
			"Errore: la CU dei compensi del 2027 arriva nel 2028. Se sulla CU c'è scritto «2027», è quella dei compensi del 2026: ridimmela con l'anno 2026.",
		);
		expect(await s.run({ op: "record_cu", client: "Cliente Tre", year: "quest'anno", gross: 100, withheld: 20 })).toContain("Errore: la CU dei compensi del 2027 arriva nel 2028.");
		expect(s.store.read().cus).toHaveLength(0);
		await s.run({ op: "record_cu", client: "Cliente Tre", gross: 1300, withheld: 260 });
		expect(s.store.read().cus.map((c) => c.year)).toEqual([2026]);
		const description = JSON.stringify(s.tool.description) + JSON.stringify(s.tool.parameters);
		expect(description).toContain("the year before the one printed on the CU form");
		expect(description).toContain("«quanto credito ho per la dichiarazione?»");
		expect(description).toContain("→ summary with last year");
		expect(description).toContain("«la CU di Rossi torna?»");
		expect(description).toContain("a client alone → check_payment with client: that client's payments this year");
	});

	it("compareCu: a cent per invoice is the same", async () => {
		const s = await setup();
		const docs = withheldDocs([sale()], await s.registerNow(), dayOf).docs;
		const cu = (withheld: string): CuRecord => ({ id: "CU-0001", client: { name: CLIENT1.name, key: `IT${CLIENT1.vat}` }, year: 2026, gross: "3400", withheld, callId: "x", by: "u", at: NOW.toISOString() });
		expect(compareCu(cu("680.03"), docs, new Map()).matches).toBe(true);
		expect(compareCu(cu("680.05"), docs, new Map()).matches).toBe(false);
	});
});

describe("ritenute: the CU still to come", () => {
	it("last year's by default, said so: the deadline gone, late", async () => {
		const s = await setup();
		const answer = await s.run({ op: "cu_list" });
		expect(answer.split("\n")[0]).toBe("CU del 2025, l'anno scorso: non mi hai detto l'anno. Manca quella dell'unico cliente con ritenute (scadenza 16 marzo 2026, passata: chi non l'ha mandata è in ritardo).");
		expect(inside(answer)).toContain("Cliente Tre Srl: manca, in ritardo (ritenute 100,00 €)");
		expect(fences(answer)).toHaveLength(1);
		expect(answer).toContain("Chiedile ai clienti");
		expect(await s.run({ op: "cu_list", year: 2025 })).toContain("CU del 2025 (scadenza 16 marzo 2026, passata: chi non l'ha mandata è in ritardo): manca quella dell'unico cliente con ritenute.");
	});

	it("this year's: all missing, then the ones received compared, the first reason beside each that does not match", async () => {
		const s = await setup({ bank: BANK, now: LATER });
		expect(await s.run({ op: "cu_list", year: 2026 })).toContain("CU del 2026 (scadenza 16 marzo 2027): mancano tutte e 3, una per cliente con ritenute.");
		await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 3400, withheld: 680 });
		await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 300, withheld: 60 });
		const answer = await s.run({ op: "cu_list", year: 2026 });
		expect(answer).toContain("CU del 2026 (scadenza 16 marzo 2027): ne manca 1 su 3 clienti con ritenute.");
		expect(inside(answer)).toContain("Cliente Uno Srl: ricevuta (CU-0001), torna");
		expect(inside(answer)).toContain("Cliente Tre Srl: ricevuta (CU-0002), non torna (differenza −200,00 €): forse fattura R6 del 1º agosto 2026, pagata al lordo secondo l'estratto conto: il cliente non ha trattenuto");
		expect(inside(answer)).toContain("Cliente Due Srl: manca (ritenute 415,00 €)");
		expect(answer).toContain("Una CU non torna con le mie fatture: il perché più probabile è nel riquadro, accanto al cliente.");
		expect(answer).not.toContain("chiedimi di confrontarla");
		const list = cuList(withheldDocs([sale()], await s.registerNow(), dayOf).docs, s.store.read().cus, 2026, "2027-03-20", new Map());
		expect(list.late).toBe(true);
		expect(list.missing.map((m) => m.client.name)).toEqual([CLIENT2.name]);
	});
});

describe("ritenute: the brief", () => {
	it("one line only from 17 to 31 March, and never writes", async () => {
		const s = await setup({ now: new Date("2027-03-20T08:00:00Z") });
		const before = readdirSync(s.dir).sort();
		expect(await s.run({ op: "cu_list", compact: true })).toBe("Mancano 3 CU per il 2026: chiedile ai clienti.");
		expect(readdirSync(s.dir).sort()).toEqual(before);
		expect(existsSync(join(s.dir, "withholding.json"))).toBe(false);
		await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 3400, withheld: 680 });
		await s.run({ op: "record_cu", client: "Cliente Due", year: 2026, gross: 2500, withheld: 415 });
		expect(await s.run({ op: "cu_list", compact: true })).toBe("Manca 1 CU per il 2026: chiedile ai clienti.");
		s.at("2027-03-16T08:00:00Z");
		expect(await s.run({ op: "cu_list", compact: true })).toBe(BRIEF_NOTHING);
		s.at("2027-04-01T08:00:00Z");
		expect(await s.run({ op: "cu_list", compact: true })).toBe(BRIEF_NOTHING);
		s.at("2027-03-31T08:00:00Z");
		await s.run({ op: "record_cu", client: "Cliente Tre", year: 2026, gross: 1300, withheld: 260 });
		expect(await s.run({ op: "cu_list", compact: true })).toBe(BRIEF_NOTHING);
	});

	it("in the brief's thread: the reading ops run, the CU and the export refuse", async () => {
		const s = await setup({ now: new Date("2027-03-20T08:00:00Z") });
		const [briefed] = readOnlyInBriefs([s.tool], async () => true);
		expect(String(await briefed?.execute({ op: "cu_list", compact: true }, fresh()))).toContain("Mancano 3 CU");
		expect(String(await briefed?.execute({ op: "summary", year: 2026 }, fresh()))).toContain("Trattenute dai clienti");
		expect(String(await briefed?.execute({ op: "record_cu", client: "Cliente Uno", gross: 1, withheld: 0 }, fresh()))).toContain("nella chat del brief del mattino Owni legge soltanto");
		expect(String(await briefed?.execute({ op: "cu_remove", id: "CU-0001" }, fresh()))).toContain("nella chat del brief del mattino Owni legge soltanto");
		expect(String(await briefed?.execute({ op: "export" }, fresh()))).toContain("nella chat del brief del mattino Owni legge soltanto");
		expect(existsSync(join(s.dir, "withholding.json"))).toBe(false);
		expect(existsSync(join(s.root, "ritenute"))).toBe(false);
		expect(withholdingCallReads({ op: "check_payment" })).toBe(true);
		expect(withholdingCallReads({ op: "record_cu" })).toBe(false);
		expect(withholdingCallReads({ op: "cu_remove" })).toBe(false);
		expect(withholdingCallReads({ op: "export" })).toBe(false);
		expect(BRIEF_INSTRUCTION).toMatch(/\n9\. Chiama ognuno di questi tool con l'op tra parentesi e compact true, e riporta la sua riga solo se segnala qualcosa: [^\n]*\bwithholding \(cu_list\)[,.]/);
		expect(BRIEF_INSTRUCTION.length).toBeLessThanOrEqual(SCHEDULE_LIMITS.maxInstructionChars);
	});

	it("quiet when the store or the scadenzario does not read, or for a forfettario", async () => {
		const s = await setup({ now: new Date("2027-03-20T08:00:00Z") });
		writeFileSync(join(s.dir, "withholding.json"), "{rotto");
		expect(await s.run({ op: "cu_list", compact: true })).toBe(BRIEF_NOTHING);
		const f = await setup({ now: new Date("2027-03-20T08:00:00Z"), regime: "forfettario" });
		expect(await f.run({ op: "cu_list", compact: true })).toBe(BRIEF_NOTHING);
	});
});

describe("ritenute: another agente", () => {
	it("the year's totals only, never names, CU, checks or files", async () => {
		const s = await setup();
		const totals = await s.run({ op: "summary" }, agent());
		expect(totals).toContain("• Trattenute dai clienti: 1.355,00 €");
		expect(fences(totals)).toHaveLength(0);
		for (const n of NAMES) expect(totals).not.toContain(n);
		for (const args of [{ op: "cu_list" }, { op: "check_payment", number: "R2" }, { op: "record_cu", client: "Cliente Uno", gross: 1, withheld: 0 }, { op: "cu_remove", id: "CU-0001" }, { op: "export" }]) {
			expect(await s.run(args, agent())).toContain("Errore: a un altro agente do solo i totali delle ritenute dell'anno");
		}
		expect(s.store.read().cus).toHaveLength(0);
		expect(withholdingAgentReads({ op: "summary" })).toBe(true);
		expect(withholdingAgentReads({ op: "cu_list" })).toBe(false);
	});
});

describe("ritenute: the store", () => {
	it("a broken file is never written over; the tool says so", async () => {
		const s = await setup();
		const path = join(s.dir, "withholding.json");
		writeFileSync(path, "{non è json");
		expect(s.store.read()).toEqual({ cus: [], broken: true });
		const answer = await s.run({ op: "record_cu", client: "Cliente Tre", year: 2025, gross: 1, withheld: 0 });
		expect(answer).toContain("Errore: le CU salvate non si leggono: non le cambio, perché andrebbero perse.");
		// The person never sees the file's name.
		expect(answer).not.toContain("withholding.json");
		expect(() => s.store.record("x", "k", 2026, (id) => ({ id, client: { name: "A", key: "k" }, year: 2026, gross: "1", withheld: "0", callId: "x", by: "u", at: NOW.toISOString() }))).toThrow(/non si leggono/);
		expect(readFileSync(path, "utf8")).toBe("{non è json");
		expect(await s.run({ op: "cu_list", year: 2026 })).toContain("Le CU salvate non si leggono: le conto tutte come mancanti.");
	});

	it("past the cap no new CU; a record that does not hold is not saved", async () => {
		const dir = temp();
		const cus = Array.from({ length: WITHHOLDING_LIMITS.cus }, (_, i): CuRecord => ({ id: cuId(i + 1), client: { name: `Cliente ${i}`, key: `nome:cliente ${i}` }, year: 2025, gross: "100", withheld: "20", callId: `k${i}`, by: "u", at: NOW.toISOString() }));
		writeFileSync(join(dir, "withholding.json"), JSON.stringify({ next: WITHHOLDING_LIMITS.cus + 1, cus, calls: [] }));
		const store = new WithholdingStore(dir);
		expect(store.read().broken).toBe(false);
		const make = (id: string): CuRecord => ({ id, client: { name: "Nuovo", key: "nome:nuovo" }, year: 2025, gross: "1", withheld: "0", callId: "new", by: "u", at: NOW.toISOString() });
		expect(() => store.record("new", "nome:nuovo", 2025, make)).toThrow(/il massimo/);
		// Replacing one already there still works at the cap.
		expect(store.record("again", "nome:cliente 3", 2025, (id) => ({ ...make(id), client: { name: "Cliente 3", key: "nome:cliente 3" }, callId: "again" })).kind).toBe("replaced");
		const empty = new WithholdingStore(temp());
		expect(() => empty.record("bad", "k", 2025, (id) => ({ ...make(id), gross: "-5" }))).toThrow(/non è valida/);
		expect(empty.read().cus).toHaveLength(0);
	});

	it("a file with two CU of the same client and year, or an id past the counter, is broken", () => {
		const dir = temp();
		const cu = (id: string): CuRecord => ({ id, client: { name: "A", key: "nome:a" }, year: 2025, gross: "1", withheld: "0", callId: id, by: "u", at: NOW.toISOString() });
		writeFileSync(join(dir, "withholding.json"), JSON.stringify({ next: 3, cus: [cu("CU-0001"), cu("CU-0002")], calls: [] }));
		expect(new WithholdingStore(dir).read().broken).toBe(true);
		writeFileSync(join(dir, "withholding.json"), JSON.stringify({ next: 1, cus: [cu("CU-0001")], calls: [] }));
		expect(new WithholdingStore(dir).read().broken).toBe(true);
	});
});

describe("ritenute: the export for the commercialista", () => {
	it("a CSV under ritenute/, named from the dates, never over another, cells made inert, the audit with op and count only", async () => {
		const hostile = { name: "=HYPERLINK(\"http://x\";\"a\")", vat: "00000040014" };
		const files = { ...FILES, "f/h.xml": xml(COMPANY, hostile, { number: "+H1", date: "2026-02-01", taxable: "100.00", ritenute: r20("20.00"), pay: "102.00" }) };
		const s = await setup({ files, paid: { ...PAID, "+H1": "2026-02-10T10:00:00.000Z" }, now: LATER });
		await s.run({ op: "record_cu", client: "Cliente Uno", year: 2026, gross: 3400, withheld: 680 });
		const answer = await s.run({ op: "export", year: 2026 });
		expect(answer).toContain("Salvato ritenute/ritenute-2026-01-01_2026-12-31.csv: le ritenute del 2026, una riga");
		const csv = readFileSync(join(s.root, "ritenute/ritenute-2026-01-01_2026-12-31.csv"), "utf8");
		expect(csv.startsWith("\uFEFFCliente;P.IVA o codice fiscale;Documento;Numero;Data;Pagata il;Anni di cassa;Compensi;Ritenuta;Regola;Totale;Netto da ricevere;Compensi del 2026;Ritenuta del 2026;Credito del 2026;Ricevuto;")).toBe(true);
		expect(csv).toContain(`"'=HYPERLINK(""http://x"";""a"")";IT00000040014;fattura;'+H1;2026-02-01;2026-02-10;2026;100,00;20,00;20% sul compenso;`);
		// From the scadenzario only: to verify, never «al netto».
		expect(csv).toContain("Cliente Due Srl;IT00000030015;fattura;R3;2026-05-05;2026-06-01;2026;1000,00;115,00;23% sul 50% (agenti);1220,00;1105,00;1000,00;115,00;115,00;1105,00;scadenzario;da verificare (manca l'estratto conto);;;non ricevuta");
		expect(csv).toContain("Cliente Uno Srl;IT00000020016;nota di credito;NC1;2026-04-10;2026-04-15;2026;-100,00;-20,00;");
		expect(csv).toMatch(/Cliente Uno Srl;[^\r]*;R2;[^\r]*;680,00;0,00;torna\r\n/);
		// R8 is dated 2026, not paid: listed to say why it is not counted.
		expect(csv).toContain("Cliente Uno Srl;IT00000020016;fattura;R8;2026-10-01;non pagata;;1000,00;200,00;20% sul compenso;1220,00;1020,00;;;;;;;;;\r\n");
		// A December invoice paid in January is 2026's.
		expect(csv).toContain(";R1;2025-12-15;2026-01-10;2026;");
		// The year's total of the rows counted: 1.375 € of ritenute on 7.300 € (Cliente Uno, Due, Tre and the hostile one).
		expect(csv).toContain("Totale 2026;;;;;;;;;;;;7300,00;1375,00;1375,00;;;;;;\r\n");
		await s.run({ op: "export", year: 2026 });
		expect(readdirSync(join(s.root, "ritenute")).sort()).toEqual(["ritenute-2026-01-01_2026-12-31-2.csv", "ritenute-2026-01-01_2026-12-31.csv"]);
		expect(s.events).toEqual([
			{ type: "withholding.changed", op: "record_cu", count: 1 },
			{ type: "withholding.changed", op: "export", count: 10 },
			{ type: "withholding.changed", op: "export", count: 10 },
		]);
		for (const e of s.events) expect(Object.keys(e).sort()).toEqual(["count", "op", "type"]);
		// Last year by default, said so.
		expect(await s.run({ op: "export" })).toContain("Salvato ritenute/ritenute-2026-01-01_2026-12-31-3.csv: le ritenute del 2026 (l'anno scorso: non mi hai detto l'anno), una riga");
		expect(await s.run({ op: "export", year: 2019 })).toContain("Nel 2019 non ho fatture con ritenuta d'acconto");
	});

	it("the CU's columns only on the rows of that CU's year; an invoice of December paid in January is «nella CU del 2026»", async () => {
		const s = await setup({ now: LATER });
		await s.run({ op: "record_cu", client: "Cliente Tre", year: 2025, gross: 500, withheld: 100 });
		await s.run({ op: "export", year: 2025 });
		const csv = readFileSync(join(s.root, "ritenute/ritenute-2025-01-01_2025-12-31.csv"), "utf8");
		expect(csv).toMatch(/Cliente Tre Srl;[^\r]*;R0;[^\r]*;500,00;100,00;100,00;[^\r]*;100,00;0,00;torna\r\n/);
		expect(csv).toMatch(/Cliente Tre Srl;[^\r]*;R5;2025-12-20;2026-01-15;2026;[^\r]*;;;;[^\r]*;nella CU del 2026\r\n/);
		expect(csv).toMatch(/Cliente Uno Srl;[^\r]*;R1;2025-12-15;2026-01-10;2026;[^\r]*;nella CU del 2026\r\n/);
		expect(csv).toContain("Totale 2025;;;;;;;;;;;;500,00;100,00;100,00;;;;;;\r\n");
	});
});

describe("ritenute: the forfettario", () => {
	it("every op says the ritenute do not apply, and stops", async () => {
		const s = await setup({ regime: "forfettario" });
		for (const op of ["summary", "check_payment", "cu_list", "export", "cu_remove"]) expect(await s.run({ op })).toBe(FORFETTARIO);
		expect(await s.run({ op: "record_cu", client: "Cliente Uno", gross: 100, withheld: 20 })).toBe(FORFETTARIO);
		expect(s.store.read().cus).toHaveLength(0);
		expect(FORFETTARIO).toBe(
			"Nel regime forfettario i clienti non trattengono la ritenuta d'acconto (L. 190/2014, art. 1, comma 67): non c'è niente da controllare né credito per la dichiarazione. La CU, se un cliente te la manda, ha solo i compensi, senza ritenute.",
		);
	});
});

describe("ritenute: the other registers", () => {
	it("what the client pays without payment data is the net: the scadenzario, the cash book and the cashflow expect it", async () => {
		const s = await setup();
		const all = await s.registerNow();
		const r8 = all.find((i) => i.doc.number === "R8") as Invoice;
		expect(r8.instalments.map((n) => n.amount)).toEqual([102_000_000_000n]);
		const flows = invoiceFlows(all.filter((i) => i.side === "active"), TODAY, "2026-12-31", false);
		// R8 has no due date: undated, at the net 1.020 €, not the gross 1.220 €.
		expect(flows.undated.in).toBe(102_000n);
		// The PA under split payment with a ritenuta: total less the IVA less the ritenuta.
		const pa = await setup({ files: { "f/pa.xml": xml(COMPANY, CLIENT1, { number: "PA1", date: "2026-02-01", taxable: "1000.00", split: true, ritenute: r20("200.00") }) }, sales: [] });
		const [one] = await pa.registerNow();
		expect(one?.instalments.map((n) => n.amount)).toEqual([80_000_000_000n]);
		// A contribution withheld (RT03) is no ritenuta d'acconto, but it is not paid to the supplier either.
		const rc = all.find((i) => i.doc.number === "RC") as Invoice;
		expect(rc.instalments.map((n) => n.amount)).toEqual([47_200_000_000n]);
	});

	it("the business report of the ordinario says the ritenute withheld; incassato stays the net", async () => {
		const s = await setup();
		const invoices = await s.registerNow();
		const sources = sourcesOf({ invoices, sales: [sale()], marks: [], tax: { kind: "ordinario" } }, TODAY, dayOf);
		const f = figuresIn(sources, { from: "2026-01-01", to: TODAY });
		expect(f.ritenute).toBe(135_500n);
		const jan = figuresIn(sources, { from: "2026-01-01", to: "2026-01-31" });
		// R1 (no payment data) 1.020 + R5 306: what came in.
		expect(jan.incassato).toBe(132_600n);
		expect(jan.ritenute).toBe(26_000n);
		const forfettario = sourcesOf({ invoices, sales: [], marks: [], tax: { kind: "none", why: "no_profile" } }, TODAY, dayOf);
		expect(figuresIn(forfettario, { from: "2026-01-01", to: TODAY }).ritenute).toBeUndefined();
		const [report] = createBusinessReportTools({ workspace: new Workspace(s.root), invoices: new InvoiceStore(s.dir), sales: { read: () => salesBook([sale()]) }, expenses: { read: () => ({ expenses: [], broken: false }) }, timeZone: "Europe/Rome", now: () => NOW });
		const answer = String(await report?.execute({ op: "summary", period: "gennaio 2026" }, fresh()));
		expect(answer).toContain("• Incassato: 1.326,00 €");
		expect(answer).toContain("• Ritenute trattenute dai clienti: 260,00 € (credito per la dichiarazione)");
	});
});

describe("ritenute: the review's money fixes", () => {
	it("shareOut: in proportion, half up, the rest on the last, never more than the total, with its sign", () => {
		expect(shareOut(20_000n, [51_000n, 51_000n])).toEqual([10_000n, 10_000n]);
		expect(shareOut(10_000n, [1n, 1n, 1n])).toEqual([3_333n, 3_333n, 3_334n]);
		expect(shareOut(-10_000n, [1n, 2n])).toEqual([-3_333n, -6_667n]);
		expect(shareOut(5n, [0n, 0n])).toEqual([3n, 2n]);
		expect(shareOut(1n, [1n, 1n, 1n])).toEqual([0n, 0n, 1n]);
		expect(shareOut(7n, [])).toEqual([]);
	});

	it("U11: one reading of a partita IVA or codice fiscale as said; one last day and month label", () => {
		expect(taxIdOf(`P.IVA IT ${CLIENT1.vat}`)).toEqual({ vat: `IT${CLIENT1.vat}` });
		expect(taxIdOf(`partita IVA: ${CLIENT1.vat.slice(0, 5)} ${CLIENT1.vat.slice(5)}`)).toEqual({ vat: `IT${CLIENT1.vat}`, cf: CLIENT1.vat });
		expect(taxIdOf(`c.f. ${COMPANY.cf.toLowerCase()}`)).toEqual({ cf: COMPANY.cf });
		expect(taxIdOf("Studio Sconosciuto")).toBeUndefined();
		expect(taxIdOf("12")).toBeUndefined();
		expect(lastDay("2028-02-01")).toBe("2028-02-29");
		expect(monthLabel("2026-10-18")).toBe("ottobre 2026");
	});

	it("M1: a received invoice with a ritenuta is paid gross by the company (the ritenuta goes to the F24): its instalment stays 1.220", async () => {
		const passive = xml(CLIENT1, COMPANY, { number: "P9", date: "2026-03-01", taxable: "1000.00", ritenute: r20("200.00") });
		const s = await setup({ files: { "f/p9.xml": passive }, paid: {}, sales: [] });
		const [p9] = await s.registerNow();
		expect(p9?.side).toBe("passive");
		expect(p9?.instalments.map((n) => n.amount)).toEqual([122_000_000_000n]);
		expect(invoiceFlows([p9 as Invoice], TODAY, "2026-12-31", false).undated.out).toBe(122_000n);
	});

	it("L1: an ImportoTotaleDocumento written already net is not netted twice", async () => {
		const net = xml(COMPANY, CLIENT1, { number: "N1", date: "2026-03-01", taxable: "1000.00", ritenute: r20("200.00") }).replace("<ImportoTotaleDocumento>1220.00", "<ImportoTotaleDocumento>1020.00");
		const s = await setup({ files: { "f/n1.xml": net }, paid: {}, sales: [] });
		const [n1] = await s.registerNow();
		expect(n1?.instalments.map((n) => n.amount)).toEqual([102_000_000_000n]);
		expect(await s.run({ op: "check_payment", number: "N1" })).toContain("totale 1.220,00 €, ritenuta 200,00 €, netto da ricevere 1.020,00 €.");
		// A total that is neither the gross nor the net is left as written.
		const odd = xml(COMPANY, CLIENT1, { number: "N2", date: "2026-03-01", taxable: "1000.00", ritenute: r20("200.00") }).replace("<ImportoTotaleDocumento>1220.00", "<ImportoTotaleDocumento>1100.00");
		const t = await setup({ files: { "f/n2.xml": odd }, paid: {}, sales: [] });
		expect((await t.registerNow())[0]?.instalments.map((n) => n.amount)).toEqual([110_000_000_000n]);
	});

	it("M2: an agent's ENASARCO withheld: the payment expected stays the net, the income for the taxes counts it", async () => {
		const files = { "f/a1.xml": xml(COMPANY, CLIENT1, { number: "A1", date: "2025-03-01", taxable: "1000.00", ritenute: [{ amount: "85.00", type: "RT04", rate: "8.50", causale: "A" }] }) };
		const s = await setup({ files, paid: { A1: "2025-03-20T10:00:00.000Z" }, regime: "forfettario", sales: [] });
		const reg = await s.registerNow();
		expect(reg[0]?.instalments.map((n) => n.amount)).toEqual([113_500_000_000n]);
		expect(reg[0]?.withheld).toEqual({ tax: 0n, contributions: 8_500n });
		const book = cashBook(reg, [], { from: "2025-01-01", to: "2025-12-31" }, dayOf);
		expect(book.totalIn).toBe(113_500n);
		expect(book.contributions).toBe(8_500n);
		expect(incassiOf(reg, 2025, dayOf).cents).toBe(122_000n);
		// The business report: incassato what came in, the forfettario's taxes on the whole income.
		const profile: TaxProfile = { coefficient: "78", rate: "15", startYear: 2020, pension: { kind: "gestione_separata" }, by: "u", at: NOW.toISOString() };
		const sources = sourcesOf({ invoices: reg, sales: [], marks: [], tax: { kind: "forfettario", profile, years: [] } }, TODAY, dayOf);
		const f = figuresIn(sources, { from: "2025-01-01", to: "2025-12-31" });
		expect(f.incassato).toBe(113_500n);
		const estimate = yearEstimate({ profile, figures: [], incassi: (y) => incassiOf(reg, y, dayOf), today: TODAY }, 2025, 122_000n);
		expect(f.tasse).toMatchObject({ kind: "forfettario", cents: estimate.total });
	});

	it("M3: an invoice paid across two years counts each instalment's share in its own year, the part paid when not all is", async () => {
		const two = xml(COMPANY, CLIENT1, { number: "T1", date: "2025-11-10", taxable: "1000.00", ritenute: r20("200.00"), pay: "510.00" }).replace(
			"</DettaglioPagamento>",
			"</DettaglioPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-01-10</DataScadenzaPagamento><ImportoPagamento>510.00</ImportoPagamento></DettaglioPagamento>",
		);
		const s = await setup({ files: { "f/t1.xml": two }, paid: {}, sales: [], now: LATER });
		const marks = new InvoiceStore(s.dir);
		const key = s.keys.T1 as string;
		marks.mark({ invoice: key, count: 2, instalment: 1, paid: true, by: "test:u", at: "2025-12-15T10:00:00.000Z" });
		// Only December's paid: 2025 counts its share, and says the rest is to come.
		const partly = await s.run({ op: "summary", year: 2025 });
		expect(partly).toContain("• Trattenute dai clienti: 100,00 € su 500,00 € di compensi (1 fattura, 1 cliente).");
		expect(partly).toContain("Una fattura è pagata solo in parte: conto la parte pagata, nell'anno in cui è arrivata.");
		marks.mark({ invoice: key, count: 2, instalment: 2, paid: true, by: "test:u", at: "2026-01-12T10:00:00.000Z" });
		expect(await s.run({ op: "summary", year: 2025 })).toContain("• Trattenute dai clienti: 100,00 € su 500,00 €");
		expect(await s.run({ op: "summary", year: 2026 })).toContain("• Trattenute dai clienti: 100,00 € su 500,00 €");
		// The client certified 2025's share: it matches.
		expect(await s.run({ op: "record_cu", client: "Cliente Uno", year: 2025, gross: 500, withheld: 100 })).toContain("Torna con le mie fatture: 100,00 € di ritenute su 1 fattura pagata nel 2025.");
		// The client certified it all in 2025: January's share explains it.
		const whole = await s.run({ op: "record_cu", client: "Cliente Uno Srl", year: 2025, gross: 1000, withheld: 200 });
		expect(inside(whole)).toContain("fattura T1 del 10 novembre 2025: ritenuta 100,00 €, pagata in parte nel 2026: quella parte è nella CU di quell'anno");
		// The business report counts each share in its own span.
		const sources = sourcesOf({ invoices: await s.registerNow(), sales: [], marks: [], tax: { kind: "ordinario" } }, "2027-02-10", dayOf);
		expect(figuresIn(sources, { from: "2025-01-01", to: "2025-12-31" }).ritenute).toBe(10_000n);
		expect(figuresIn(sources, { from: "2026-01-01", to: "2026-12-31" }).ritenute).toBe(10_000n);
	});

	it("L5: a cassa's contributo integrativo (TC01 to TC21) is no compenso; the rivalsa INPS (TC22) is", async () => {
		const fund = (type: string) => `<DatiCassaPrevidenziale><TipoCassa>${type}</TipoCassa><AlCassa>4.00</AlCassa><ImportoContributoCassa>40.00</ImportoContributoCassa><ImponibileCassa>1000.00</ImponibileCassa><AliquotaIVA>22.00</AliquotaIVA></DatiCassaPrevidenziale>`;
		const withFund = (number: string, type: string) => xml(COMPANY, CLIENT1, { number, date: "2026-02-01", taxable: "1040.00", ritenute: r20("200.00"), pay: "1068.80" }).replace("<ImportoTotaleDocumento>", `${fund(type)}<ImportoTotaleDocumento>`);
		const s = await setup({ files: { "f/c1.xml": withFund("C1", "TC01"), "f/c2.xml": withFund("C2", "TC22") }, paid: {}, sales: [] });
		const { docs } = withheldDocs([], await s.registerNow(), dayOf);
		expect(docs.find((d) => d.number === "C1")?.compensi).toBe(100_000n);
		expect(docs.find((d) => d.number === "C2")?.compensi).toBe(104_000n);
	});

	it("UX7: the business report leaves out the ritenuta of an invoice the bank says was paid gross, as the ritenute tool does", async () => {
		const s = await setup({ bank: BANK });
		const invoices = await s.registerNow();
		const bank = BANK(s.keys);
		const received = bankReceipts(bank.movements.map((m) => ({ amount: m.amount, target: `inv:${bank.matches.find((x) => x.movement === m.id)?.target}` })));
		const sources = sourcesOf({ invoices, sales: [sale()], marks: [], tax: { kind: "ordinario" }, received }, TODAY, dayOf);
		// 1.355 less R6's 200: the credit the summary says.
		expect(figuresIn(sources, { from: "2026-01-01", to: TODAY }).ritenute).toBe(115_500n);
		expect(await s.run({ op: "summary" })).toContain("1.155,00 €.");
		const [report] = createBusinessReportTools({
			workspace: new Workspace(s.root),
			invoices: new InvoiceStore(s.dir),
			sales: { read: () => salesBook([sale()]) },
			expenses: { read: () => ({ expenses: [], broken: false }) },
			bank: { read: () => ({ next: { movement: 1, import: 1 }, movements: bank.movements, imports: [], matches: bank.matches, calls: [], broken: false }) },
			timeZone: "Europe/Rome",
			now: () => NOW,
		});
		// August: only R6, paid gross: no ritenute line.
		const august = String(await report?.execute({ op: "summary", period: "agosto 2026" }, fresh()));
		expect(august).toContain("• Incassato: 1.020,00 €");
		expect(august).not.toContain("Ritenute trattenute");
		const july = String(await report?.execute({ op: "summary", period: "luglio 2026" }, fresh()));
		expect(july).toContain("• Ritenute trattenute dai clienti: 300,00 € (credito per la dichiarazione)");
	});
});

describe("ritenute: the second review's fixes", () => {
	it("N1: a client taken by a similar name never takes another CU's place; by the exact name or the partita IVA it does", async () => {
		const s = await setup();
		await s.run({ op: "record_cu", client: "Cliente Uno Srl", year: 2025, gross: 1000, withheld: 200 });
		await s.run({ op: "record_cu", client: "Cliente Tre Srl", year: 2025, gross: 500, withheld: 100 });
		for (const name of ["Clienti Uno Srl", "Cliente Unoo Srl", "Cliente Uno", "Cliente Uno Sas", "Uno Srl", "Cliente Tre Srls"]) {
			const answer = await s.run({ op: "record_cu", client: name, year: 2025, gross: 300, withheld: 60 });
			expect(answer.split("\n")[0], name).toBe("Errore: ho già la CU del 2025 di un cliente con un nome simile (nel riquadro): se è lui e vuoi sostituirla, dimmi la sua partita IVA o il nome esatto.");
			expect(fences(answer)).toHaveLength(1);
		}
		expect(s.store.read().cus.map((c) => [c.id, c.client.name, c.withheld])).toEqual([
			["CU-0001", CLIENT1.name, "200"],
			["CU-0002", CLIENT3.name, "100"],
		]);
		expect(s.events).toHaveLength(2);
		// The same call run again is refused again, never «already saved».
		const ctx = fresh("similar-again");
		await s.run({ op: "record_cu", client: "Cliente Uno Sas", year: 2025, gross: 300, withheld: 60 }, ctx);
		expect(await s.run({ op: "record_cu", client: "Cliente Uno Sas", year: 2025, gross: 300, withheld: 60 }, ctx)).toContain("Errore: ho già la CU del 2025");
		// A new CU by a similar name is still taken, with the note.
		const fresh2 = await s.run({ op: "record_cu", client: "cliente due", year: 2025, gross: 300, withheld: 60 });
		expect(fresh2).toContain("Salvata la CU del 2025 del cliente nel riquadro (CU-0003)");
		expect(fresh2).toContain(FORM_NOTE);
		// By the partita IVA: the CU sostitutiva.
		expect(await s.run({ op: "record_cu", client: CLIENT1.vat, year: 2025, gross: 1000, withheld: 190 })).toContain("Ho sostituito la CU del 2025 del cliente nel riquadro (CU-0001) con questa");
	});

	it("N2: a negative summary row is summed with its sign: the gross check holds, the net is right", async () => {
		const x = xml(COMPANY, CLIENT1, { number: "G1", date: "2026-03-01", taxable: "1000.00", ritenute: r20("200.00"), n1: "50.00" })
			.replace("<ImponibileImporto>50.00</ImponibileImporto>", "<ImponibileImporto>-50.00</ImponibileImporto>")
			.replace("<ImportoTotaleDocumento>1270.00", "<ImportoTotaleDocumento>1170.00");
		const s = await setup({ files: { "f/g1.xml": x }, paid: { G1: "2026-03-20T10:00:00.000Z" }, sales: [] });
		const reg = await s.registerNow();
		expect(reg[0]?.instalments.map((n) => n.amount)).toEqual([97_000_000_000n]);
		expect(withheldDocs([], reg, dayOf).docs[0]).toMatchObject({ total: 117_000n, net: 97_000n, compensi: 100_000n, ritenuta: 20_000n });
	});

	it("N3: the forfettario agent's ENASARCO: said on its own line, a row of its own in the CSV, the share to set aside of what arrives", async () => {
		const files = { "f/a1.xml": xml(COMPANY, CLIENT1, { number: "A1", date: "2026-03-01", taxable: "1000.00", ritenute: [{ amount: "85.00", type: "RT04", rate: "8.50", causale: "A" }] }) };
		const s = await setup({ files, paid: { A1: "2026-03-20T10:00:00.000Z" }, regime: "forfettario", sales: [] });
		const taxes = new TaxStore(s.dir);
		const profile: TaxProfile = { coefficient: "62", rate: "15", startYear: 2020, pension: { kind: "gestione_separata" }, by: "u", at: NOW.toISOString() };
		taxes.update("p", () => profile, []);
		const [tool] = createTaxTools({ workspace: new Workspace(s.root), store: taxes, invoices: new InvoiceStore(s.dir), timeZone: "Europe/Rome", whoIs: () => "test:u", now: () => NOW });
		const answer = String(await tool?.execute({ op: "estimate" }, fresh()));
		expect(answer).toContain("1.220,00 €");
		expect(answer).toContain("Di cui 85,00 € di contributi trattenuti dal mandante: non arrivano sul conto, ma sono compensi e contano nel reddito.");
		// The percent of what reaches the account (1.135 of 1.220) covers the estimate.
		const reg = await s.registerNow();
		const e = yearEstimate({ profile, figures: [], incassi: (y) => incassiOf(reg, y, dayOf), today: TODAY }, 2026);
		expect(e.setAsidePercent).toBeDefined();
		expect((BigInt(e.setAsidePercent ?? 0) * 113_500n * e.incassi) / 122_000n / 100n >= e.total).toBe(true);
		expect((BigInt((e.setAsidePercent ?? 0) - 1) * 113_500n * e.incassi) / 122_000n / 100n < e.total).toBe(true);
		const exported = String(await tool?.execute({ op: "export" }, fresh()));
		const path = /Salvato (\S+\.csv)/.exec(exported)?.[1] as string;
		const csv = readFileSync(join(s.root, path), "utf8");
		expect(csv).toContain("Incassi;20/03/2026;Fattura A1, Cliente Uno Srl;1135,00;fatture");
		expect(csv).toContain("Incassi;20/03/2026;Contributi trattenuti dal mandante, fattura A1;85,00;fatture");
		expect(csv).toContain("Incassi 2026 (fatture segnate come pagate);1220,00;fatture");
	});

	it("N4: the CSV's credit column leaves out what the bank says was paid gross, so it adds up to the summary's credit", async () => {
		const s = await setup({ bank: BANK, now: LATER });
		await s.run({ op: "export", year: 2026 });
		const csv = readFileSync(join(s.root, "ritenute/ritenute-2026-01-01_2026-12-31.csv"), "utf8");
		expect(csv).toMatch(/;R6;2026-08-01;[^\r]*;1000,00;200,00;0,00;1220,00;estratto conto;al lordo;/);
		expect(csv).toContain("Totale 2026;;;;;;;;;;;;7200,00;1355,00;1155,00;;;;;;\r\n");
		expect(await s.run({ op: "summary", year: 2026 })).toContain("(redditi 2026): 1.155,00 €.");
	});

	it("UX3: with every CU in, the header says only the deadline", async () => {
		const s = await setup();
		await s.run({ op: "record_cu", client: "Cliente Tre Srl", year: 2025, gross: 500, withheld: 100 });
		expect((await s.run({ op: "cu_list", year: 2025 })).split("\n")[0]).toBe("CU del 2025 (scadenza 16 marzo 2026): le hai tutte, 1 cliente con ritenute.");
	});
});

describe("ritenute: the answers", () => {
	it("no em dash in the sources, no parameter names in the answers", async () => {
		for (const f of ["withholding.ts", "withholding-rules.ts", "withholding-docs.ts", "withholding-sums.ts", "withholding-store.ts", "tools/withholding-tools.ts", "tools/withholding-render.ts", "tools/withholding-input.ts"]) {
			expect(readFileSync(join(import.meta.dirname, "../src/core", f), "utf8")).not.toMatch(NO_EM_DASH);
		}
		const s = await setup({ bank: BANK });
		const answers = [await s.run({ op: "summary" }), await s.run({ op: "check_payment", period: "2026" }), await s.run({ op: "cu_list", year: 2026 }), await s.run({ op: "cu_list" }), await s.run({ op: "record_cu", client: "Cliente Tre", year: 2025, gross: 800, withheld: 160 }), await s.run({ op: "cu_remove", id: "CU-0001" })];
		for (const a of answers) {
			expect(a).not.toMatch(NO_EM_DASH);
			expect(outside(a)).not.toMatch(/\b(?:withheld|gross|check_payment|cu_list|record_cu|cu_remove|op|year|id)\b/);
			expect(a).not.toContain("withholding.json");
			expect(fences(a).length).toBeLessThanOrEqual(1);
		}
		expect(await s.run({ op: "nope" })).toContain("Errore: op è una di queste");
	});
});
