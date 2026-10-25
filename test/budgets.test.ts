import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { BankMatch, BankMovement } from "../src/core/bank.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { BudgetStore } from "../src/core/budget-store.ts";
import { periodFor } from "../src/core/budget-sums.ts";
import { budgetAgentReads, budgetCallReads, subjectKey } from "../src/core/budgets.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import type { Expense } from "../src/core/expenses.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { register } from "../src/core/invoices.ts";
import type { Renewal } from "../src/core/renewals.ts";
import { SCHEDULE_LIMITS } from "../src/core/schedules.ts";
import type { SalesBook } from "../src/core/sales-invoice-store.ts";
import { type BudgetEvent, createBudgetTools } from "../src/core/tools/budget-tools.ts";
import { BRIEF_NOTHING, MEASURE_NOTES, NO_BUDGETS } from "../src/core/tools/budget-render.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic identifiers only: checksum-valid fake partite IVA.
const COMPANY = { name: "Studio Prova Srl", vat: "00000010017" };
const CLIENT = { name: "Cliente Uno Srl", vat: "00000020016" };
const SUPPLIER = { name: "Fornitore Tre Srl", vat: "11111110018" };
const ROSSI1 = { name: "Rossi Srl", vat: "00000050013" };
const ROSSI2 = { name: "Rossi SpA", vat: "00000060012" };

const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday 18 October 2026, in Rome
let calls = 0;
const fresh = (callId = `c${++calls}`, thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, { channel: AGENT_CHANNEL, threadId: "a1" });
/** A context whose steps are kept, as the engine keeps them: run again, a step done gives back what it gave. */
const durable = (callId: string, memo: Map<string, unknown>): ToolContext => ({
	...fresh(callId),
	step: async (key, work) => {
		if (memo.has(key)) return memo.get(key) as never;
		const v = await work();
		memo.set(key, v);
		return v;
	},
});

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-budgets-"));
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

/**
 * October 2026 to the 18th: issued FV-2 (500, two instalments, the first paid on the 16th), FV-3
 * (2.000, open) and the credit note NC-1 (100, open); FV-1 (September, 1.000) paid at 00:30 of 1
 * October in Rome (22:30 UTC of 30 September). Received from Fornitore Tre: A-1 (paid, with its
 * expense) and A-2 (244, paid on the 12th with no expense, but an expense of 244 that day under
 * another name may be it). Two suppliers called Rossi, with two partite IVA.
 */
const FILES: Record<string, string> = {
	"f/fv1.xml": xml(COMPANY, CLIENT, { number: "FV-1", date: "2026-09-10", rows: [r22("1000.00")], due: "2026-10-10" }),
	"f/fv2.xml": xml(COMPANY, CLIENT, { number: "FV-2", date: "2026-10-05", rows: [r22("500.00")], rate: [{ amount: "305.00", due: "2026-10-15" }, { amount: "305.00", due: "2026-11-15" }] }),
	"f/fv3.xml": xml(COMPANY, CLIENT, { number: "FV-3", date: "2026-10-07", rows: [r22("2000.00")], due: "2026-11-30" }),
	"f/nc1.xml": xml(COMPANY, CLIENT, { number: "NC-1", date: "2026-10-09", type: "TD04", rows: [r22("100.00")] }),
	"f/a1.xml": xml(SUPPLIER, COMPANY, { number: "A-1", date: "2026-10-02", rows: [r22("100.00")], due: "2026-10-10" }),
	"f/a2.xml": xml(SUPPLIER, COMPANY, { number: "A-2", date: "2026-10-03", rows: [r22("200.00")], due: "2026-10-12" }),
	"f/r1.xml": xml(ROSSI1, COMPANY, { number: "R-1", date: "2026-09-01", rows: [r22("50.00")], due: "2026-12-31" }),
	"f/r2.xml": xml(ROSSI2, COMPANY, { number: "R-2", date: "2026-09-01", rows: [r22("60.00")], due: "2026-12-31" }),
};
/** Number → when it was marked paid; «FV-2#1»: one instalment. */
const PAID: Record<string, string> = {
	"FV-1": "2026-09-30T22:30:00.000Z",
	"FV-2#1": "2026-10-16T09:00:00.000Z",
	"A-1": "2026-10-10T08:00:00.000Z",
	"A-2": "2026-10-12T08:00:00.000Z",
};

const expense = (id: string, date: string, amount: string, more: Partial<Expense> = {}): Expense => ({ id, date, amount, category: "altro", by: "u", at: `${date}T12:00:00.000Z`, ...more });
const EXPENSES = (): Expense[] => [
	expense("S-2026-0001", "2026-10-09", "122", { supplier: SUPPLIER.name, supplierVat: SUPPLIER.vat, docType: "fattura", docNumber: "A-1", category: "consulenze" }),
	expense("S-2026-0002", "2026-10-14", "50", { category: "carburante" }),
	// The same 244 as A-2, the same day, under another name and with no partita IVA: maybe the same money.
	expense("S-2026-0003", "2026-10-12", "244", { supplier: "Altro Nome Srl", category: "software e abbonamenti" }),
	expense("S-2026-0004", "2026-10-03", "60", { supplier: "Aruba Prova", category: "software e abbonamenti" }),
	expense("S-2026-0005", "2026-09-30", "40", { category: "software e abbonamenti" }),
];

const salesBook = (): SalesBook => ({ next: {}, nextDraft: 1, nextFile: 1, invoices: [], calls: [], broken: false }) as unknown as SalesBook;

async function setup(o: { expenses?: Expense[]; files?: Record<string, string>; renewals?: Renewal[]; bank?: { movements: BankMovement[]; matches: BankMatch[] } } = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	for (const [path, content] of Object.entries(o.files ?? FILES)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	const company = { vat: `IT${COMPANY.vat}`, name: COMPANY.name, by: "test:u", at: NOW.toISOString() };
	invoices.setCompany(company);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const scan = await scanner.scan(new AbortController().signal);
	const keys = new Map<string, string>();
	for (const i of register(scan.invoices, [], company)) {
		const number = i.doc.number ?? "";
		keys.set(number, i.key);
		const all = PAID[number];
		if (all !== undefined) invoices.mark({ invoice: i.key, count: i.instalments.length, paid: true, by: "test:u", at: all });
		for (const [key, at] of Object.entries(PAID)) {
			const [n, k] = key.split("#");
			if (n === number && k !== undefined) invoices.mark({ invoice: i.key, count: i.instalments.length, instalment: Number(k), paid: true, by: "test:u", at });
		}
	}
	const expenses = o.expenses ?? EXPENSES();
	const store = new BudgetStore(dir);
	const events: BudgetEvent[] = [];
	const clock = { now: NOW };
	const [tool] = createBudgetTools({
		workspace,
		store,
		invoices,
		scanner,
		sales: { read: salesBook },
		expenses: { read: () => ({ expenses, broken: false }) as never },
		renewals: { read: () => ({ renewals: o.renewals ?? [], broken: false }) },
		...(o.bank === undefined ? {} : { bank: { read: () => ({ next: { movement: 9, import: 2 }, movements: o.bank?.movements ?? [], imports: [], matches: o.bank?.matches ?? [], calls: [], broken: false }) as never } }),
		timeZone: "Europe/Rome",
		whoIs: () => "test:u",
		record: async (e) => {
			events.push(e);
		},
		now: () => clock.now,
	});
	if (tool === undefined) throw new Error("no tool");
	return {
		dir,
		root,
		tool,
		store,
		events,
		expenses,
		keys,
		file: join(dir, "budgets.json"),
		at: (iso: string) => {
			clock.now = new Date(iso);
		},
		run: async (args: Record<string, unknown>, ctx: ToolContext = fresh()) => String(await tool.execute(args, ctx)),
	};
}

const FENCE = /<<<dati dei budget ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati dei budget \1>>>/g;
const fences = (text: string) => [...text.matchAll(FENCE)];
const inside = (text: string) => fences(text).map((m) => m[2] as string).join("\n");
const outside = (text: string) => text.replace(FENCE, "");
const NO_EM_DASH = /\u2014/;
const OPS = /\b(?:op|target|supplier|amount|every|start|compact|status|set|remove)\b/;

describe("budgets: set, replace, remove", () => {
	it("«metti un budget di 300 € al mese per il software»: a new budget, then the same target again replaces it", async () => {
		const s = await setup();
		const made = await s.run({ op: "set", target: "software", amount: "300", every: "al mese" });
		expect(made).toContain("Fatto, nuovo budget BU-0001: software e abbonamenti, 300,00 € al mese.");
		// 244 + 60 in October; the 40 of 30 September is not October's.
		expect(made).toContain("Software e abbonamenti (BU-0001), ottobre 2026 fino a oggi: spesi 304,00 € su 300,00 € (101%), budget superato di 4,00 €.");
		expect(made).not.toMatch(NO_EM_DASH);
		expect(outside(made)).not.toMatch(OPS);
		const again = await s.run({ op: "set", target: "software e abbonamenti", amount: 400 });
		expect(again).toContain("Fatto, ho aggiornato il budget BU-0001: software e abbonamenti, 400,00 € al mese.");
		const book = JSON.parse(readFileSync(s.file, "utf8"));
		expect(book.budgets).toHaveLength(1);
		expect(book.budgets[0].amount).toBe("400");
		expect(book.budgets[0].edited.by).toBe("test:u");
		// Another kind of period is another budget.
		expect(await s.run({ op: "set", target: "software", amount: "3000", every: "year" })).toContain("nuovo budget BU-0002");
		expect(s.events).toEqual([
			{ type: "budgets.changed", op: "set", count: 1 },
			{ type: "budgets.changed", op: "set", count: 1 },
			{ type: "budgets.changed", op: "set", count: 1 },
		]);
	});

	it("«togli il budget viaggi»: viaggi are pasti e trasferte; two budgets on it are asked; a number is never given again", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "viaggi", amount: "200" });
		await s.run({ op: "set", target: "viaggi", amount: "2000", every: "anno" });
		const asked = await s.run({ op: "remove", target: "viaggi" });
		expect(asked).toContain("Ci sono 2 budget su questo: quale tolgo?");
		expect(asked).toContain("• BU-0001: pasti e trasferte, 200,00 € al mese");
		expect(asked).toContain("• BU-0002: pasti e trasferte, 2.000,00 € all'anno");
		expect(JSON.parse(readFileSync(s.file, "utf8")).budgets).toHaveLength(2);
		expect(await s.run({ op: "remove", target: "viaggi", every: "month" })).toBe("Fatto, ho tolto il budget BU-0001: pasti e trasferte, 200,00 € al mese.");
		expect(await s.run({ op: "remove", id: "bu-0002" })).toBe("Fatto, ho tolto il budget BU-0002: pasti e trasferte, 2.000,00 € all'anno.");
		expect(await s.run({ op: "remove", target: "viaggi" })).toBe("Non c'è un budget su questo da togliere.");
		expect(await s.run({ op: "list" })).toBe(NO_BUDGETS);
		expect(await s.run({ op: "set", target: "carburante", amount: "100" })).toContain("nuovo budget BU-0003");
		expect(s.events.map((e) => e.op)).toEqual(["set", "set", "remove", "remove", "set"]);
	});

	it("«marketing» is not a category: the categories are said, and nothing is saved", async () => {
		const s = await setup();
		const answer = await s.run({ op: "set", target: "marketing", amount: "500" });
		expect(answer).toContain("Errore: questa non è una delle categorie delle spese (carburante, auto e veicoli,");
		expect(answer).toContain("per un fornitore solo, dimmi il fornitore");
		expect(existsSync(s.file)).toBe(false);
		expect(await s.run({ op: "set", target: "software", amount: "-5" })).toContain("non è negativo");
		expect(await s.run({ op: "set", target: "software", amount: "300", every: "ogni tanto" })).toContain("al mese, al trimestre o all'anno");
		expect(await s.run({ op: "set", target: "software" })).toBe("Errore: dimmi quanto, in euro.");
		expect(existsSync(s.file)).toBe(false);
		expect(s.events).toEqual([]);
	});
});

describe("budgets: what is counted", () => {
	it("a category counts its expenses; the supplier invoice paid with no expense is out of it, and said", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "software", amount: "300" });
		const answer = await s.run({ op: "status", target: "software" });
		expect(answer).toContain("spesi 304,00 € su 300,00 € (101%)");
		// One budget: the note after its own lines.
		const lines = answer.split("\n");
		expect(lines.indexOf("Una fattura di fornitore pagata senza una spesa registrata non ha categoria, quindi non entra nei budget per categoria.")).toBeGreaterThan(lines.findIndex((l) => l.startsWith("Stima a fine mese")));
		expect(answer).not.toContain("La conta il budget su tutte le spese");
		// With a budget on all the spending: where it is counted, said once for all the category budgets.
		await s.run({ op: "set", target: "tutto", amount: "1000" });
		await s.run({ op: "set", target: "carburante", amount: "100" });
		const both = await s.run({ op: "status" });
		expect(both.split("\n")[1]).toBe("Una fattura di fornitore pagata senza una spesa registrata non ha categoria, quindi non entra nei budget per categoria. La conta il budget su tutte le spese.");
		expect(both.match(/non ha categoria/g)).toHaveLength(1);
	});

	it("all the spending: each payment once, A-1 with its expense once, A-2 and the 244 under another name both counted and said", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "tutto", amount: "1000" });
		const answer = await s.run({ op: "status", target: "tutte le spese" });
		// 122 + 50 + 244 + 60 expenses + A-2 244 paid with no expense.
		expect(answer).toContain("Tutte le spese (BU-0001), ottobre 2026 fino a oggi: spesi 720,00 € su 1.000,00 € (72%), restano 280,00 €.");
		expect(answer).toContain("Un pagamento di fattura potrebbe essere anche una spesa registrata (BU-0001): l'ho contato una volta come fattura e una come spesa. Controlla se sono gli stessi soldi.");
		// Once per status, at the end, naming every budget it is counted in; the same for another agente.
		await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "500" });
		const twice = await s.run({ op: "status" });
		const line = "Un pagamento di fattura potrebbe essere anche una spesa registrata (BU-0001, BU-0002): l'ho contato una volta come fattura e una come spesa. Controlla se sono gli stessi soldi.";
		expect(twice.match(/potrebbe essere anche una spesa registrata/g)).toHaveLength(1);
		expect(outside(twice).trimEnd().split("\n").at(-1)).toBe(line);
		expect(await s.run({ op: "status" }, agent())).toContain(line);
		expect(answer).not.toContain("due volte");
	});

	it("a supplier, found by name or partita IVA; a name two suppliers have is asked, its names in the fence", async () => {
		const s = await setup();
		const asked = await s.run({ op: "set", supplier: "Rossi", amount: "100" });
		expect(outside(asked)).toContain("Intendi uno di questi?");
		expect(inside(asked)).toContain(ROSSI1.name);
		expect(inside(asked)).toContain(ROSSI2.name);
		expect(existsSync(s.file)).toBe(false);
		const made = await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "500" });
		expect(outside(made)).toContain("Fatto, nuovo budget BU-0001: un fornitore (nel riquadro), 500,00 € al mese.");
		expect(outside(made)).not.toContain(SUPPLIER.name);
		expect(inside(made)).toContain(`BU-0001: ${SUPPLIER.name}`);
		const status = await s.run({ op: "status", supplier: "Fornitore Tre" });
		// A-1 as its expense (122) and A-2 (244).
		expect(outside(status)).toContain("Un fornitore (BU-0001, nel riquadro), ottobre 2026 fino a oggi: spesi 366,00 € su 500,00 € (73%), restano 134,00 €.");
		expect(outside(status)).not.toContain("Fornitore Tre");
		expect(inside(status)).toContain(SUPPLIER.name);
		expect(await s.run({ op: "set", supplier: "Nessuno Tale", amount: "5" })).toContain("Non trovo questo fornitore");
	});

	it("«come vado con l'obiettivo di 60.000 € di fatturato quest'anno?»: the business report's fatturato, the credit note less, the monthly pace", async () => {
		const s = await setup();
		const made = await s.run({ op: "set", target: "fatturato", amount: "60.000" });
		expect(made).toContain("Fatto, nuovo obiettivo BU-0001: fatturato, 60.000,00 € all'anno.");
		const answer = await s.run({ op: "status", target: "fatturato" });
		// FV-1 1.000 + FV-2 500 + FV-3 2.000 less NC-1 100.
		expect(answer).toContain("Obiettivo di fatturato (BU-0001), 2026 fino a oggi: 3.400,00 € su 60.000,00 € (5%), mancano 56.600,00 €.");
		// 3.400 in 291 days of 365.
		expect(answer).toContain("Stima a fine anno, al ritmo tenuto finora: 4.264,60 €, cioè 55.735,40 € sotto l'obiettivo. A questo ritmo non ci arrivi.");
		expect(answer).toContain("Per arrivarci servono 18.866,67 € al mese da qui a dicembre (3 mesi, questo compreso).");
		expect(answer).toContain(MEASURE_NOTES.fatturato);
		expect(answer).toContain("Le stime allungano a tutto il periodo quello che è successo finora: sono indicative, e un incasso arrivato una volta sola le cambia molto.");
		await s.run({ op: "set", target: "carburante", amount: "100" });
		expect(await s.run({ op: "status" })).toContain("Le stime allungano a tutto il periodo quello che è successo finora: sono indicative, e una spesa o un incasso arrivati una volta sola le cambiano molto.");
		expect(await s.run({ op: "status", target: "carburante" })).toContain("sono indicative, e una spesa fatta una volta sola le fa sembrare più alte.");
		// In December, the last month: what is missing by the end of the year.
		s.at("2026-12-10T08:00:00Z");
		expect(await s.run({ op: "status", target: "fatturato" })).toContain("Per arrivarci servono 56.600,00 € entro fine anno.");
		// On a lower target, in line.
		s.at(NOW.toISOString());
		await s.run({ op: "set", target: "fatturato", amount: "3000" });
		expect(await s.run({ op: "status", target: "fatturato" })).toContain("Stima a fine anno, al ritmo tenuto finora: 4.264,60 €, cioè 1.264,60 € sopra l'obiettivo. Sei in linea per arrivarci.");
	});

	it("incassato: money in by the Rome day it was paid, IVA included", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "incassi", amount: "1500", every: "mese" });
		const answer = await s.run({ op: "status", target: "incassato" });
		// FV-1 1.220 paid at 00:30 of 1 October in Rome, FV-2's first 305.
		expect(answer).toContain("Obiettivo di incassato (BU-0001), ottobre 2026 fino a oggi: 1.525,00 € su 1.500,00 € (101%), raggiunto e superato di 25,00 €.");
		expect(answer).toContain(MEASURE_NOTES.incassato);
	});

	it("a credit note used lowers the incassato", async () => {
		const s = await setup({ files: { ...FILES, "f/nc2.xml": xml(COMPANY, CLIENT, { number: "NC-2", date: "2026-10-10", type: "TD04", rows: [r22("50.00")] }) } });
		await s.run({ op: "set", target: "incassato", amount: "1500", every: "month" });
		await s.run({ op: "set", target: "fatturato", amount: "3000", every: "month" });
		const answer = await s.run({ op: "status" });
		// 2.400 less NC-2's 50.
		expect(answer).toContain("Obiettivo di fatturato (BU-0002), ottobre 2026 fino a oggi: 2.350,00 €");
	});
});

describe("budgets: periods and the estimate", () => {
	it("the estimate: too early at the start, linear in the middle, the actual on the last day", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "carburante", amount: "100" });
		s.at("2026-10-02T08:00:00Z");
		const early = await s.run({ op: "status", target: "carburante" });
		expect(early).toContain("Troppo presto per una stima: sono passati 2 giorni su 31.");
		expect(early).not.toContain("indicative");
		s.at("2026-10-18T08:00:00Z");
		const middle = await s.run({ op: "status", target: "carburante" });
		// 50 in 18 days, times 31.
		expect(middle).toContain("Stima a fine mese, se continui a questo ritmo: 86,11 €, dentro il budget.");
		await s.run({ op: "set", target: "carburante", amount: "60" });
		expect(await s.run({ op: "status", target: "carburante" })).toContain("Stima a fine mese, se continui a questo ritmo: 86,11 €, cioè 26,11 € oltre il budget.");
		s.at("2026-10-31T20:00:00Z");
		const end = await s.run({ op: "status", target: "carburante" });
		expect(end).toContain("Carburante (BU-0001), ottobre 2026: spesi 50,00 € su 60,00 € (83%), restano 10,00 €.");
		expect(end).toContain("Il mese finisce oggi.");
		expect(end).not.toContain("Stima");
	});

	it("monthly, quarterly and yearly periods, and the month in Rome at midnight", async () => {
		expect(periodFor("month", "2026-10-18")).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
		expect(periodFor("quarter", "2026-10-18")).toMatchObject({ from: "2026-10-01", to: "2026-12-31" });
		expect(periodFor("year", "2026-10-18")).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
		const s = await setup();
		await s.run({ op: "set", target: "tutto", amount: "3000", every: "trimestre" });
		const quarter = await s.run({ op: "status", target: "tutto" });
		expect(quarter).toContain("Tutte le spese (BU-0001), 4º trimestre 2026 fino a oggi: spesi 720,00 €");
		expect(quarter).toContain("Stima a fine trimestre, se continui a questo ritmo:");
		await s.run({ op: "set", target: "incassato", amount: "1000", every: "month" });
		// 23:30 UTC of 30 September is 01:30 of 1 October in Rome: October's first day, FV-1 paid at 00:30 is in.
		s.at("2026-09-30T23:30:00Z");
		const first = await s.run({ op: "status", target: "incassato" });
		expect(first).toContain("Obiettivo di incassato (BU-0002), ottobre 2026 fino a oggi: 1.220,00 €");
		expect(first).toContain("Troppo presto per una stima: è passato 1 giorno su 31.");
		// 21:30 UTC of 30 September is still September in Rome, before FV-1 was paid.
		s.at("2026-09-30T21:30:00Z");
		expect(await s.run({ op: "status", target: "incassato" })).toContain("settembre 2026");
	});

	it("a budget from a later month waits for it", async () => {
		const s = await setup();
		const made = await s.run({ op: "set", target: "formazione", amount: "200", start: "novembre" });
		expect(made).toContain("dal 1º novembre 2026");
		expect(await s.run({ op: "status", target: "formazione" })).toContain("comincia il 1º novembre 2026");
	});
});

describe("budgets: the brief and another agente", () => {
	it("«quali budget sto sforando?»: the overview first", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "software", amount: "300" });
		await s.run({ op: "set", target: "tutto", amount: "850" });
		await s.run({ op: "set", target: "carburante", amount: "500" });
		const answer = await s.run({ op: "status" });
		expect(answer.split("\n")[0]).toBe("Superato: software e abbonamenti. Oltre l'80%: tutte le spese.");
	});

	it("each alert once a period: 80%, then 100%, then a new month; an income target behind in the last third", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "tutto", amount: "800" });
		const first = await s.run({ op: "status", compact: true });
		expect(first).toContain("Budget oltre l'80%: tutte le spese questo mese (90%).");
		expect(first).toContain("non ripetere la riga dell'andamento dell'attività");
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		s.expenses.push(expense("S-2026-0006", "2026-10-17", "100", { category: "attrezzatura" }));
		const over = await s.run({ op: "status", compact: true });
		expect(over).toContain("Budget superato: tutte le spese questo mese (102%).");
		expect(over).not.toContain("80%");
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		// November: a new period, said again once past the threshold.
		s.expenses.push(expense("S-2026-0007", "2026-11-02", "900", { category: "attrezzatura" }));
		s.at("2026-11-03T08:00:00Z");
		const next = await s.run({ op: "status", compact: true });
		expect(next).toContain("Budget superato: tutte le spese questo mese (112%).");
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		// A target behind pace in the last third of the year.
		s.at(NOW.toISOString());
		await s.run({ op: "set", target: "fatturato", amount: "60000" });
		const behind = await s.run({ op: "status", compact: true });
		expect(behind).toContain("L'obiettivo di fatturato di quest'anno è indietro: a questo ritmo a fine anno arriva a 4.264,60 € su 60.000,00 €.");
		expect(behind).not.toContain("tutte le spese");
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		const claims = JSON.parse(readFileSync(s.file, "utf8")).alerts as { level: string; period: string }[];
		expect(claims.map((c) => `${c.period}:${c.level}`)).toEqual(["2026-10:80", "2026-10:100", "2026-11:80", "2026-11:100", "2026:behind"]);
		// Claiming alerts is not a change the audit records.
		expect(s.events.map((e) => e.op)).toEqual(["set", "set"]);
	});

	it("a supplier's budget in the brief: no name in the line, the name in the fence; a budget changed is said again only past the level again", async () => {
		const s = await setup();
		await s.run({ op: "set", supplier: SUPPLIER.name, amount: "300" });
		const line = await s.run({ op: "status", compact: true });
		expect(outside(line)).toContain("Budget superato: un fornitore questo mese (122%). Il fornitore è nel riquadro.");
		expect(outside(line)).not.toContain("Fornitore Tre");
		expect(inside(line)).toContain(SUPPLIER.name);
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		// The same budget said again: nothing written, nothing audited, its alerts still said.
		const before = readFileSync(s.file, "utf8");
		expect(await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "300" })).toContain("Era già così, non ho cambiato niente: il budget BU-0001, un fornitore (nel riquadro), 300,00 € al mese.");
		expect(readFileSync(s.file, "utf8")).toBe(before);
		expect(s.events).toHaveLength(1);
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		// Raised but still past it: still said.
		await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "350" });
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		// Raised under it: the 80% stays said, the 100% goes, and comes back when lowered past it again.
		await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "400" });
		expect(await s.run({ op: "status", compact: true })).toBe(BRIEF_NOTHING);
		await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "360" });
		expect(outside(await s.run({ op: "status", compact: true }))).toContain("Budget superato: un fornitore questo mese (101%).");
		const claims = JSON.parse(readFileSync(s.file, "utf8")).alerts as { level: string }[];
		expect(claims.map((c) => c.level)).toEqual(["80", "100"]);
	});

	it("exactly the amount is reached, not exceeded: in the status, the overview and the brief", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "carburante", amount: "50" });
		await s.run({ op: "set", target: "software", amount: "300" });
		const status = await s.run({ op: "status" });
		expect(status.split("\n")[0]).toBe("Superato: software e abbonamenti. Raggiunto: carburante.");
		expect(status).toContain("Carburante (BU-0001), ottobre 2026 fino a oggi: spesi 50,00 € su 50,00 € (100%), budget raggiunto.");
		expect(await s.run({ op: "status", compact: true })).toContain("Budget superato: software e abbonamenti questo mese (101%). Budget raggiunto: carburante questo mese (100%).");
		const claims = JSON.parse(readFileSync(s.file, "utf8")).alerts as { budget: string; level: string }[];
		expect(claims.filter((c) => c.budget === "BU-0001").map((c) => c.level)).toEqual(["80"]);
	});

	it("in the brief's thread it reads and claims; setting is refused; the instruction names it within the limit", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "software", amount: "300" });
		const [briefed] = readOnlyInBriefs([s.tool], async () => true);
		expect(String(await briefed?.execute({ op: "status", compact: true }, fresh()))).toContain("Budget superato: software e abbonamenti questo mese (101%).");
		expect(String(await briefed?.execute({ op: "set", target: "carburante", amount: 5 }, fresh()))).toContain("nella chat del brief del mattino Owni legge soltanto");
		expect(budgetCallReads({ op: "status", compact: true })).toBe(true);
		expect(budgetCallReads({ op: "export" })).toBe(false);
		expect(BRIEF_INSTRUCTION).toMatch(/\n9\. Chiama ognuno di questi tool [^\n]*\bbudgets \(status\)[,.]/);
		expect(BRIEF_INSTRUCTION.length).toBeLessThanOrEqual(SCHEDULE_LIMITS.maxInstructionChars);
		expect(s.tool.description).toContain("How the business is doing (fatturato, margine, a period against another) is business_report: budgets is only for the limits and ta");
	});

	it("another agente: totals and percents, never a supplier's name; nothing else", async () => {
		const s = await setup();
		await s.run({ op: "set", supplier: SUPPLIER.name, amount: "500" });
		await s.run({ op: "set", target: "software", amount: "300" });
		const answer = await s.run({ op: "status" }, agent());
		expect(answer).toContain("Un fornitore (BU-0001), ottobre 2026 fino a oggi: spesi 366,00 € su 500,00 € (73%)");
		expect(answer).toContain("spesi 304,00 € su 300,00 € (101%)");
		expect(answer).not.toContain("Fornitore Tre");
		expect(answer).not.toContain("riquadro");
		expect(fences(answer)).toHaveLength(0);
		for (const args of [{ op: "set", target: "carburante", amount: 5 }, { op: "remove", id: "BU-0001" }, { op: "export" }, { op: "status", compact: true }])
			expect(await s.run(args, agent())).toBe("Errore: a un altro agente do solo come vanno i budget, in cifre e percentuali. Non li cambio, non do i nomi dei fornitori e non esporto; il resto lo chiede chi ti scrive, nella sua conversazione.");
		// The list: ids, «un fornitore», amounts.
		const list = await s.run({ op: "list" }, agent());
		expect(list).toBe("Ci sono 2 budget:\n• BU-0001: un fornitore, 500,00 € al mese\n• BU-0002: software e abbonamenti, 300,00 € al mese");
		expect(await s.run({ op: "status", id: "BU-0001" }, agent())).toContain("Un fornitore (BU-0001), ottobre 2026 fino a oggi: spesi 366,00 €");
		expect(budgetAgentReads({ op: "status" })).toBe(true);
		expect(budgetAgentReads({ op: "list" })).toBe(true);
		expect(JSON.parse(readFileSync(s.file, "utf8")).budgets).toHaveLength(2);
	});
});

describe("budgets: the file, reruns and the audit", () => {
	it("the export: formula-safe cells, a new file never over an old one, the audit with the count only", async () => {
		const hostile = "=HYPERLINK(\"http://x.invalid\";\"a\")";
		const s = await setup({ expenses: [...EXPENSES(), expense("S-2026-0009", "2026-10-15", "30", { supplier: hostile, category: "altro" })] });
		const made = await s.run({ op: "set", supplier: hostile, amount: "100" });
		expect(made).toContain("nuovo budget BU-0001");
		await s.run({ op: "set", target: "software", amount: "300" });
		const first = await s.run({ op: "export" });
		expect(first).toContain("Salvato budget/budget-al-2026-10-18.csv: 2 budget");
		const csv = readFileSync(join(s.root, "budget", "budget-al-2026-10-18.csv"), "utf8");
		expect(csv).toContain(`"'=HYPERLINK(""http://x.invalid"";""a"")"`);
		expect(csv).not.toMatch(/(?:^|;|\n)=/);
		expect(csv).toContain("BU-0002;budget di spesa;software e abbonamenti;;mese;300,00;;ottobre 2026;304,00;101;-4,00;523,56");
		const second = await s.run({ op: "export" });
		expect(second).not.toContain("budget-al-2026-10-18.csv:");
		expect(readdirSync(join(s.root, "budget"))).toHaveLength(2);
		expect(s.events.filter((e) => e.op === "export")).toEqual([
			{ type: "budgets.changed", op: "export", count: 2 },
			{ type: "budgets.changed", op: "export", count: 2 },
		]);
		expect(JSON.stringify(s.events)).not.toContain("HYPERLINK");
	});

	it("a broken file is never written over", async () => {
		const s = await setup();
		writeFileSync(s.file, "{ not json");
		const answer = await s.run({ op: "set", target: "software", amount: "300" });
		expect(answer).toContain("i budget (budgets.json) non si leggono");
		expect(await s.run({ op: "status" })).toContain("non si leggono");
		expect(await s.run({ op: "remove", id: "BU-0001" })).toContain("non si leggono");
		expect(readFileSync(s.file, "utf8")).toBe("{ not json");
		expect(s.events).toEqual([]);
	});

	it("a call run again writes once: from its steps (audited once), or from the call id when the steps were lost", async () => {
		const s = await setup();
		const memo = new Map<string, unknown>();
		const a = await s.run({ op: "set", target: "software", amount: "300" }, durable("set-1", memo));
		const b = await s.run({ op: "set", target: "software", amount: "300" }, durable("set-1", memo));
		expect(b).toBe(a);
		expect(s.events).toHaveLength(1);
		// The steps lost: the store knows the call, nothing is written twice.
		const c = await s.run({ op: "set", target: "carburante", amount: "50" }, fresh("set-2"));
		const d = await s.run({ op: "set", target: "carburante", amount: "50" }, fresh("set-2"));
		expect(d).toContain("BU-0002");
		expect(c).toContain("BU-0002");
		const book = JSON.parse(readFileSync(s.file, "utf8"));
		expect(book.budgets.map((x: { id: string }) => x.id)).toEqual(["BU-0001", "BU-0002"]);
		expect(book.nextId).toBe(3);
		const rm = new Map<string, unknown>();
		const r1 = await s.run({ op: "remove", id: "BU-0001" }, durable("rm-1", rm));
		const r2 = await s.run({ op: "remove", id: "BU-0001" }, durable("rm-1", rm));
		expect(r2).toBe(r1);
		expect(s.events.map((e) => e.op)).toEqual(["set", "set", "set", "remove"]);
		expect(existsSync(`${s.file}.bak`)).toBe(true);
		// The audit: the op and how many, nothing of what a budget is on.
		for (const e of s.events) expect(Object.keys(e).sort()).toEqual(["count", "op", "type"]);
	});
});

describe("budgets: review fixes", () => {
	it("another agente never asks by a supplier: the same refusal and the list, whatever the name, so nothing is learnt from it", async () => {
		const s = await setup();
		await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "500" });
		await s.run({ op: "set", target: "software", amount: "300" });
		const answers = new Set<string>();
		for (const said of ["Rossi", "Nessuno Tale", ROSSI1.vat, "Fornitore Tre", SUPPLIER.vat]) answers.add(await s.run({ op: "status", supplier: said }, agent()));
		expect([...answers]).toEqual(["A un altro agente non do i budget di un singolo fornitore: ecco tutti, in cifre.\nCi sono 2 budget:\n• BU-0001: un fornitore, 500,00 € al mese\n• BU-0002: software e abbonamenti, 300,00 € al mese"]);
		// A target with no budget: the list, with no supplier's name and no fence.
		const none = await s.run({ op: "status", target: "carburante" }, agent());
		expect(none).toContain("Non c'è un budget su questo. Ci sono 2 budget:");
		expect(none).toContain("• BU-0001: un fornitore, 500,00 € al mese");
		expect(none).not.toContain("riquadro");
		expect(none).not.toContain(SUPPLIER.name);
		expect(none).not.toContain(SUPPLIER.vat);
		expect(fences(none)).toHaveLength(0);
		// The person, in their own thread: the list with the name in the fence.
		expect(inside(await s.run({ op: "status", target: "carburante" }))).toContain(SUPPLIER.name);
	});

	it("a supplier's budget counts like the suppliers tool: a payment only the bank confirmed counts; all the spending stays the business report's", async () => {
		const files = { ...FILES, "f/a3.xml": xml(SUPPLIER, COMPANY, { number: "A-3", date: "2026-10-05", rows: [r22("100.00")], due: "2026-10-15" }) };
		const first = await setup({ files });
		const key = first.keys.get("A-3") as string;
		const movement: BankMovement = { id: "B-000001", hash: "h1", seq: 1, date: "2026-10-15", amount: "-122", description: "BONIFICO", importId: "I-0001" };
		const match: BankMatch = { movement: "B-000001", state: "confirmed", kind: "invoice_in", target: key, instalment: 1, label: "A-3", by: "test:u", at: NOW.toISOString() };
		const s = await setup({ files, bank: { movements: [movement], matches: [match] } });
		await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "500" });
		await s.run({ op: "set", target: "tutto", amount: "1000" });
		const answer = await s.run({ op: "status" });
		// 122 (A-1's expense) + 244 (A-2) + 122 (A-3, confirmed by the bank only).
		expect(answer).toContain("Un fornitore (BU-0001, nel riquadro), ottobre 2026 fino a oggi: spesi 488,00 €");
		expect(answer).toContain("Tutte le spese (BU-0002), ottobre 2026 fino a oggi: spesi 720,00 €");
		// Without the bank, A-3 is not paid.
		await first.run({ op: "set", supplier: SUPPLIER.vat, amount: "500" });
		expect(await first.run({ op: "status" })).toContain("spesi 366,00 €");
	});

	it("a supplier only in the renewals is found", async () => {
		const renewal = { id: "R-0001", name: "Abbonamento grafica", provider: "Grafica Prova", category: "software e abbonamenti", amount: "60", months: 1, due: "2026-11-01", day: 1, autoRenew: true, status: "active", by: "test:u", at: NOW.toISOString() } as unknown as Renewal;
		const s = await setup({ renewals: [renewal] });
		const made = await s.run({ op: "set", supplier: "Grafica Prova", amount: "100" });
		expect(outside(made)).toContain("Fatto, nuovo budget BU-0001: un fornitore (nel riquadro), 100,00 € al mese.");
		expect(inside(made)).toContain("BU-0001: Grafica Prova");
		expect(await (await setup()).run({ op: "set", supplier: "Grafica Prova", amount: "100" })).toContain("Non trovo questo fornitore tra schede, fatture ricevute, spese e rinnovi:");
	});

	it("replacing keeps the start unless a new one is said, or cleared", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "formazione", amount: "200", start: "novembre" });
		expect(await s.run({ op: "set", target: "formazione", amount: "250" })).toContain("Fatto, ho aggiornato il budget BU-0001: formazione, 250,00 € al mese, dal 1º novembre 2026.");
		expect(JSON.parse(readFileSync(s.file, "utf8")).budgets[0].start).toBe("2026-11-01");
		expect(await s.run({ op: "set", target: "formazione", amount: "250", start: "dicembre" })).toContain("dal 1º dicembre 2026");
		const cleared = await s.run({ op: "set", target: "formazione", amount: "250", start: "subito" });
		expect(cleared).toContain("Fatto, ho aggiornato il budget BU-0001: formazione, 250,00 € al mese.");
		expect(JSON.parse(readFileSync(s.file, "utf8")).budgets[0].start).toBeUndefined();
	});

	it("a budget kept by a supplier's name is the same target once that name groups with a partita IVA", async () => {
		const s = await setup();
		// Set when only the name was known.
		s.store.update("old", (st) => ({ nextId: 2, budgets: [...st.budgets, { id: "BU-0001", subject: { kind: "supplier", name: "fornitore tre srl" }, amount: "300", every: "month", by: "test:u", at: NOW.toISOString() }] }));
		const replaced = await s.run({ op: "set", supplier: SUPPLIER.vat, amount: "500" });
		expect(outside(replaced)).toContain("Fatto, ho aggiornato il budget BU-0001: un fornitore (nel riquadro), 500,00 € al mese.");
		const book = JSON.parse(readFileSync(s.file, "utf8"));
		expect(book.budgets).toHaveLength(1);
		expect(book.budgets[0].subject.vat).toBe(`IT${SUPPLIER.vat}`);
		expect(subjectKey({ kind: "supplier", name: "Rossi  SRL" })).toBe(subjectKey({ kind: "supplier", name: "rossi srl" }));
	});

	it("a remove run again with its steps lost removes nothing and audits nothing", async () => {
		const s = await setup();
		await s.run({ op: "set", target: "carburante", amount: "100" });
		expect(await s.run({ op: "remove", id: "BU-0001" }, fresh("rm-x"))).toBe("Fatto, ho tolto il budget BU-0001: carburante, 100,00 € al mese.");
		expect(await s.run({ op: "remove", id: "BU-0001" }, fresh("rm-x"))).toBe("Fatto, il budget è tolto.");
		expect(s.events.map((e) => e.op)).toEqual(["set", "remove"]);
	});

	it("routing: business_report and the expenses send limits and targets to budgets", async () => {
		const { createBusinessReportTools } = await import("../src/core/tools/business-report-tools.ts");
		const { createExpenseTools } = await import("../src/core/tools/expense-tools.ts");
		const dir = temp();
		const report = createBusinessReportTools({ workspace: new Workspace(dir), invoices: new InvoiceStore(dir), expenses: { read: () => ({ expenses: [], broken: false }) as never }, timeZone: "Europe/Rome" } as never)[0];
		expect(report?.description).toContain("A limit or target the person set (budget, obiettivo) is budgets.");
		const expenses = createExpenseTools({ workspace: new Workspace(dir), store: { read: () => ({ expenses: [], broken: false }) } } as never)[0];
		expect(expenses?.description).toContain("Spending against a budget the person set → budgets status.");
	});
});

describe("budgets: second-pass fixes", () => {
	it("the share: down below the amount, up above it, 100% only exactly", async () => {
		for (const [spent, share, words] of [
			["49.8", "99%", "restano 0,20 €"],
			["50", "100%", "budget raggiunto"],
			["50.2", "101%", "budget superato di 0,20 €"],
		] as const) {
			const s = await setup({ expenses: [expense("S-2026-0001", "2026-10-10", spent, { category: "formazione" })] });
			await s.run({ op: "set", target: "formazione", amount: "50" });
			expect(await s.run({ op: "status", target: "formazione" })).toContain(`(${share}), ${words}.`);
		}
	});
});
