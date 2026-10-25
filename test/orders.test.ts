import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BRIEF_INSTRUCTION, readOnlyInBriefs } from "../src/core/brief.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import { awaitedOf, matchInvoice, orderLink } from "../src/core/order-receive.ts";
import { OrderStore } from "../src/core/order-store.ts";
import { paceOf, sellersOf, suggestions } from "../src/core/order-suggest.ts";
import { type Order, OrderError, orderCallReads, orderState } from "../src/core/orders.ts";
import { lineKey } from "../src/core/purchase-prices.ts";
import { PurchaseStore } from "../src/core/purchase-store.ts";
import type { Movement, StockItem } from "../src/core/stock.ts";
import { StockStore } from "../src/core/stock-store.ts";
import { createOrderTools, type OrderEvent } from "../src/core/tools/order-tools.ts";
import { createStockTools, type StockEvent } from "../src/core/tools/stock-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names.
const NOW = new Date("2026-10-19T08:00:00Z");
const COMPANY: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", address: "Via Prova 1, Torino", by: "test:u", at: NOW.toISOString() };
const ME = { name: "Bottega Prova Srl", vat: "00000010017" };
const BETA = { name: "Beta Forniture Srl", vat: "00000030015" };
const GAMMA = { name: "Gamma Carta Spa", vat: "00000040014" };
const MARK = { by: "test:u", at: NOW.toISOString() };

let calls = 0;
const fresh = (callId = `o${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });
const durable = (callId: string, memo: Map<string, unknown>): ToolContext => ({
	...fresh(callId),
	step: async (key, work) => {
		if (memo.has(key)) return memo.get(key) as never;
		const v = await work();
		memo.set(key, v);
		return v;
	},
});

const FENCE = /<<<dati (?:degli ordini|del magazzino) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:degli ordini|del magazzino) \1>>>/g;
const outside = (text: string) => text.replace(FENCE, "");
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
const checkIn = (answer: string) => /il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Party = { name: string; vat: string };
type Line = { desc: string; qty: string; unit: string; price: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A received FatturaPA with its lines and the riepilogo IVA at 22%. */
function xml(from: Party, to: Party, o: { number: string; date: string; lines: Line[]; refs?: string[] }): string {
	const party = (p: Party) => `<DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${p.vat}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>${esc(p.name)}</Denominazione></Anagrafica></DatiAnagrafici>`;
	let taxable = 0;
	const lines = o.lines
		.map((l, i) => {
			const total = (Number(l.price) * Number(l.qty)).toFixed(2);
			taxable += Number(total);
			return `<DettaglioLinee><NumeroLinea>${i + 1}</NumeroLinea><Descrizione>${esc(l.desc)}</Descrizione><Quantita>${l.qty}</Quantita><UnitaMisura>${l.unit}</UnitaMisura><PrezzoUnitario>${l.price}</PrezzoUnitario><PrezzoTotale>${total}</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>`;
		})
		.join("");
	const riepilogo = `<DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>${taxable.toFixed(2)}</ImponibileImporto><Imposta>${(taxable * 0.22).toFixed(2)}</Imposta></DatiRiepilogo>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione><CedentePrestatore>${party(from)}</CedentePrestatore><CessionarioCommittente>${party(to)}</CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>${o.date}</Data><Numero>${esc(o.number)}</Numero></DatiGeneraliDocumento>${(o.refs ?? []).map((r) => `<DatiOrdineAcquisto><IdDocumento>${esc(r)}</IdDocumento></DatiOrdineAcquisto>`).join("")}</DatiGenerali><DatiBeniServizi>${lines}${riepilogo}</DatiBeniServizi></FatturaElettronicaBody></p:FatturaElettronica>`;
}

const item = (n: number, name: string, unit: string, more: Partial<StockItem> = {}): StockItem => ({ id: `MG-000${n}`, name, unit, ...more, ...MARK });

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "owni-orders-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(join(root, "fatture"), { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const stock = new StockStore(dir);
	const store = new OrderStore(dir);
	const events: (OrderEvent | StockEvent)[] = [];
	const clock = { now: NOW };
	const made: MakeInput[] = [];
	const make = async (input: MakeInput) => {
		made.push(input);
		return { data: new TextEncoder().encode(input.text), notes: [] };
	};
	const [tool] = createOrderTools({ workspace, store, stock, invoices, scanner, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	const [stockTool] = createStockTools({ workspace, store: stock, invoices, scanner, orders: orderLink(store), timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now });
	if (tool === undefined || stockTool === undefined) throw new Error("no tool");
	let files = 0;
	const file = (text: string) => writeFileSync(join(root, "fatture", `f${++files}.xml`), text);
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const stockRun = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await stockTool.execute(args, c));
	return { dir, root, workspace, stock, store, events, clock, made, tool, file, run, stockRun };
}

/**
 * The shop: cartridges (minimum 10, in boxes of 12) went out 45 in the last 90 days and 5 are
 * left; paper (minimum 5) went out 30 in two sales and 6 are left; glue has no minimum and no
 * sales. Beta sold the cartridges twice (12,00 then 12,50) and the paper; Gamma once, cheaper.
 */
function shop(s: ReturnType<typeof setup>) {
	const moves: Movement[] = [];
	let n = 0;
	const mv = (m: Omit<Movement, "id" | "by" | "at">) => moves.push({ id: `MV-${String(++n).padStart(6, "0")}`, ...m, ...MARK } as Movement);
	mv({ item: "MG-0001", kind: "carico", qty: "50", day: "2026-07-01", cost: "12", supplier: { name: "Beta Forniture Srl", vat: "IT00000030015" } });
	for (let i = 0; i < 9; i++) mv({ item: "MG-0001", kind: "scarico", qty: "5", day: `2026-${i < 4 ? "08" : "09"}-${String(10 + i).padStart(2, "0")}`, reason: "vendita" });
	mv({ item: "MG-0002", kind: "carico", qty: "36", day: "2026-07-01", cost: "4.5" });
	mv({ item: "MG-0002", kind: "scarico", qty: "15", day: "2026-09-01", reason: "uso_interno" });
	mv({ item: "MG-0002", kind: "scarico", qty: "15", day: "2026-10-01", reason: "vendita" });
	// An old sale, before the window: not in the pace.
	mv({ item: "MG-0003", kind: "carico", qty: "10", day: "2026-01-01", cost: "1" });
	mv({ item: "MG-0003", kind: "scarico", qty: "2", day: "2026-02-01", reason: "vendita" });
	s.stock.update("seed", (st) => ({ ...st, nextItem: 4, nextMove: n + 1, items: [item(1, "Cartucce XL", "pezzo", { min: "10", pack: { unit: "scatola", size: "12" } }), item(2, "Carta A4", "risma", { min: "5" }), item(3, "Colla stick", "pezzo")], moves }));
	s.file(xml(BETA, ME, { number: "B-1", date: "2026-09-01", lines: [{ desc: "Cartucce XL", qty: "20.00", unit: "PZ", price: "12.00" }, { desc: "Carta A4", qty: "10.00", unit: "RISMA", price: "4.50" }] }));
	s.file(xml(BETA, ME, { number: "B-2", date: "2026-10-01", lines: [{ desc: "Cartucce XL", qty: "10.00", unit: "PZ", price: "12.50" }] }));
	s.file(xml(GAMMA, ME, { number: "G-1", date: "2026-10-10", lines: [{ desc: "Cartucce XL", qty: "5.00", unit: "PZ", price: "11.80" }] }));
}

describe("what to reorder", () => {
	it("under the minimum or soon under it, from the pace of the scarichi; whole packs; the cheapest and the usual supplier; an estimate said when sales are few", async () => {
		const s = setup();
		shop(s);
		const text = await s.run({ op: "suggest" });
		expect(outside(text)).toContain("Da riordinare: 2 articoli. Nel riquadro perché e quanti (prezzi per unità, senza IVA).");
		// Both from Beta as usual: one draft.
		expect(outside(text)).toContain("Vuoi che prepari l'ordine? Te lo faccio vedere prima.");
		const rows = inside(text).split("\n");
		// 45 in 90 days: half a cartridge a day; the 7 days of delivery and 30 more are 19 (rounded up), past the minimum of 10: 29, 24 missing, two boxes of 12.
		expect(rows[0]).toBe(
			"• Cartucce XL: ne hai 5 pezzi, il minimo è 10, quindi sei sotto. Ne vendi circa 0,5 pezzi al giorno (45 negli ultimi 90 giorni). Per averne abbastanza per un mese sopra il minimo, anche durante la consegna, te ne servono 29: ordinane 24 pezzi (2 scatole da 12). L'ultimo prezzo pagato è 12,50 € da Beta Forniture Srl (1º ottobre); da Gamma Carta Spa costa 11,80 € (10 ottobre).",
		);
		// 30 in two scarichi: in 3 days it goes under 5, before a delivery of 7 days (assumed); an estimate.
		expect(rows[1]).toBe(
			"• Carta A4: ne hai 6 risme, il minimo è 5: a questo ritmo ci scendi sotto in 3 giorni, prima che un ordine possa arrivare (per la consegna conto 7 giorni). Ne vendi circa 0,3 risme al giorno (30 negli ultimi 90 giorni). È una stima: solo 2 vendite in questi giorni. Per averne abbastanza per un mese sopra il minimo, anche durante la consegna, te ne servono 18: ordinane 12 risme. L'ultimo prezzo pagato è 4,50 € da Beta Forniture Srl (1º settembre).",
		);
		expect(outside(text)).not.toMatch(/Beta|Gamma|Cartucce|MG-/);
		expect(s.events).toEqual([{ type: "orders.used", op: "suggest", count: 2 }]);
		expect(orderCallReads({ op: "suggest" })).toBe(true);
		expect(orderCallReads({ op: "create" })).toBe(false);
	});

	it("the pace: sales and internal use less the returns, inside the window; the usual supplier is the one bought from most", () => {
		const it1 = item(1, "X", "pezzo");
		const m = (id: number, kind: Movement["kind"], qty: string, day: string, more: Partial<Movement> = {}): Movement => ({ id: `MV-00000${id}`, item: "MG-0001", kind, qty, day, ...more, ...MARK }) as Movement;
		const moves = [m(1, "scarico", "4", "2026-10-01", { reason: "vendita" }), m(2, "scarico", "1", "2026-10-02", { reason: "scarto" }), m(3, "storno", "1", "2026-10-03"), m(4, "scarico", "2", "2026-01-01", { reason: "vendita" })];
		expect(paceOf(it1, moves, "2026-07-22", "2026-10-19")).toEqual({ sold: 3000n, sales: 1 });
		const o = (key: string, cost: bigint, day: string) => ({ key, supplier: key, cost, day, from: "invoice" as const });
		const s = sellersOf([o("A", 100n, "2026-10-01"), o("A", 110n, "2026-10-05"), o("B", 105n, "2026-10-02"), o("C", 50n, "2025-01-01")], "2026-10-19");
		expect(s.cheapest?.key).toBe("B");
		expect(s.usual).toMatchObject({ key: "A", cost: 110n, count: 2 });
		// No minimum and no sales: nothing to say.
		expect(suggestions({ items: [it1], moves: [], purchases: [], codes: [], units: [] }, "2026-10-19", { cover: 30, lead: () => ({ days: 7, known: false }) })).toEqual([]);
	});
});

describe("drafts, documents, sent", () => {
	it("«fammi l'ordine per Beta»: a proposal with a check, a draft only with the person's yes; changed while a draft; the document without sending it; sent only by the person", async () => {
		const s = setup();
		shop(s);
		const asked = await s.run({ op: "create", supplier: "Beta" });
		expect(outside(asked)).toContain("Preparerei una bozza d'ordine, come nel riquadro (prezzi per unità, senza IVA).");
		// Each line says why; Gamma's price, more than 5% less, is said on the line.
		expect(inside(asked).split("\n")).toEqual([
			"Fornitore: Beta Forniture Srl",
			"  1. Cartucce XL: 24 pezzi a 12,50 € (ne hai 5, il minimo è 10, per un mese; l'ultimo prezzo pagato, il 1º ottobre) (Gamma Carta Spa l'ha fatto 11,80 €, il 5% in meno, il 10 ottobre: se vuoi lo prendo da lì)",
			"  2. Carta A4: 12 risme a 4,50 € (ne hai 6, il minimo è 5, per un mese; l'ultimo prezzo pagato, il 1º settembre)",
			"  Totale previsto: 354,00 € senza IVA",
		]);
		expect(outside(asked)).toContain("Non mando niente a nessuno");
		expect(s.store.read().orders).toEqual([]);
		const check = checkIn(asked);
		expect(await s.run({ op: "create", supplier: "Beta", confirm: true, check }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "create", supplier: "Beta", confirm: true })).toContain("Errore: per preparare le bozze serve il controllo");
		expect(await s.run({ op: "create", supplier: "Beta", confirm: true, check: "0123456789abcdef" })).toContain("La proposta è cambiata");
		const memo = new Map<string, unknown>();
		const done = await s.run({ op: "create", supplier: "Beta", confirm: true, check }, durable("c-1", memo));
		expect(outside(done)).toContain("Fatto: ho preparato la bozza d'ordine OR-0001, come nel riquadro. È solo una bozza, non è partito niente.");
		expect(outside(done)).toContain("Vuoi il PDF da mandare al fornitore? Quando l'hai mandato, dimmelo e lo segno come inviato.");
		// Run again: nothing twice.
		await s.run({ op: "create", supplier: "Beta", confirm: true, check }, durable("c-1", memo));
		const [o] = s.store.read().orders;
		expect(o).toMatchObject({ id: "OR-0001", status: "draft", day: "2026-10-19", supplier: { key: "IT00000030015", name: "Beta Forniture Srl", vat: "IT00000030015" } });
		expect(o?.lines).toEqual([
			{ n: 1, item: "MG-0001", name: "Cartucce XL", qty: "24", unit: "pezzo", price: "12.5", priceFrom: "purchase", priceDay: "2026-10-01" },
			{ n: 2, item: "MG-0002", name: "Carta A4", qty: "12", unit: "risma", price: "4.5", priceFrom: "purchase", priceDay: "2026-09-01" },
		]);
		// Two boxes more, the paper off, a note: only in the person's own turn.
		const changes = { op: "change", supplier: "Beta", lines: [{ item: "cartucce xl", quantity: 4, unit: "scatole" }, { item: "Carta A4", quantity: 0 }], notes: "Consegna al mattino" };
		expect(await s.run(changes, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "document", order: "OR-0001" }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(s.made).toEqual([]);
		const changed = await s.run({ op: "change", supplier: "Beta", lines: [{ item: "cartucce xl", quantity: 4, unit: "scatole" }, { item: "Carta A4", quantity: 0 }], notes: "Consegna al mattino" });
		expect(inside(changed)).toContain("  1. Cartucce XL: 48 pezzi a 12,50 €");
		expect(inside(changed)).not.toContain("Carta A4");
		expect(inside(changed)).toContain("  Note: Consegna al mattino");
		// The document, without prices: written, never sent.
		const doc = await s.run({ op: "document", order: "OR-0001", no_prices: true });
		expect(outside(doc)).toContain("Ecco il PDF dell'ordine OR-0001 per il fornitore, senza prezzi: il file è nel riquadro. Non l'ho mandato a nessuno.");
		expect(inside(doc)).toBe("File: ordini/Ordine-OR-0001-Beta-Forniture-Srl.pdf");
		expect(outside(doc)).not.toMatch(/Beta/);
		const md = s.made[0]?.text ?? "";
		expect(md).toContain("# Ordine n. OR-0001");
		expect(md).toContain("**Bottega Prova Srl**");
		expect(md).toContain("P\\.IVA 00000030015");
		expect(md).toContain("| 1 | Cartucce XL | 48 pezzi |");
		expect(md).not.toContain("12,50");
		expect(readFileSync(join(s.root, "ordini", "Ordine-OR-0001-Beta-Forniture-Srl.pdf"), "utf8")).toBe(md);
		expect(s.store.read().orders[0]).toMatchObject({ file: "ordini/Ordine-OR-0001-Beta-Forniture-Srl.pdf", noPrices: true });
		// Sent: only the person says it.
		expect(await s.run({ op: "mark_sent", supplier: "Beta" }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		const sent = await s.run({ op: "mark_sent", supplier: "Beta" });
		expect(sent).toContain("Segnato: OR-0001 inviato lunedì 19 ottobre.");
		// No lead time said for Beta: the 7 days are an assumption, said as one.
		expect(sent).toContain("Non so in quanti giorni consegna il fornitore: conto 7 giorni. Se di solito ci mette di più o di meno, dimmelo e ti avviso al momento giusto.");
		expect(s.store.read().orders[0]).toMatchObject({ status: "sent", sentDay: "2026-10-19" });
		expect(await s.run({ op: "change", order: "OR-0001", lines: [{ item: "Carta A4", quantity: 1 }] })).toContain("si cambia solo una bozza");
		const st = await s.run({ op: "status", supplier: "beta forniture" });
		expect(outside(st)).toContain("Per me OR-0001 non è ancora arrivato: non ho ancora la fattura del fornitore con questa merce. Se la merce è già arrivata con la bolla, dimmi «è arrivato» e lo segno.");
		expect(s.events.filter((e) => e.type === "orders.used").map((e) => e.op)).toEqual(["create", "change", "document", "mark_sent", "status"]);
	});

	it("«ordina 50 cartucce dal fornitore che le fa pagare meno»: the line to the cheapest, at its price; one said with a price keeps it; cancelled only by the person", async () => {
		const s = setup();
		shop(s);
		// Boxes of 12: 50 is no whole number of boxes, asked again.
		const odd = await s.run({ op: "create", lines: [{ item: "cartucce xl", quantity: 50 }], prefer: "cheapest" });
		expect(outside(odd)).toContain("Questo articolo va a scatole da 12: 50 non è un numero intero di scatole. Dimmi quanti pezzi o quante scatole.");
		const lines = [{ item: "cartucce xl", quantity: 48 }];
		const asked = await s.run({ op: "create", lines, prefer: "cheapest" });
		expect(inside(asked).split("\n").slice(0, 2)).toEqual(["Fornitore: Gamma Carta Spa", "  1. Cartucce XL: 48 pezzi a 11,80 € (l'ultimo prezzo pagato, il 10 ottobre) (da Gamma Carta Spa perché costa meno: 11,80 € il 10 ottobre, contro 12,50 € di Beta Forniture Srl il 1º ottobre)"]);
		const usual = await s.run({ op: "create", lines: [{ item: "cartucce xl", quantity: 48, price: "12" }] });
		expect(inside(usual)).toContain("Fornitore: Beta Forniture Srl\n  1. Cartucce XL: 48 pezzi a 12,00 € (prezzo detto da te)");
		await s.run({ op: "create", lines, prefer: "cheapest", confirm: true, check: checkIn(asked) });
		expect(s.store.read().orders[0]?.supplier.name).toBe("Gamma Carta Spa");
		// An article not in the magazzino is not ordered here.
		expect(await s.run({ op: "create", lines: [{ item: "Penne blu", quantity: 3 }] })).toContain("Questo articolo non è ancora in magazzino: vuoi che lo aggiunga? Dimmi come lo conti (a pezzi, a scatole).");
		expect(await s.run({ op: "create", lines: [{ item: "Carta A4", quantity: 3 }, { item: "carta a4", quantity: 2 }] })).toContain("Lo stesso articolo è su due righe");
		const refusal = await s.run({ op: "cancel", order: "OR-0001" }, agent());
		expect(refusal).toBe("Gli ordini dicono fornitori, articoli e prezzi: a un altro agente do solo quanti sono. Li prepara e li cambia chi ti scrive, nella sua conversazione.");
		expect(refusal).not.toContain("Errore");
		expect(await s.run({ op: "cancel", order: "or 1" })).toBe("Annullato l'ordine OR-0001.");
		expect(orderState(s.store.read().orders[0] as Order)).toBe("cancelled");
	});
});

describe("the goods arrive", () => {
	it("an invoice of a supplier with an order sent: its lines matched in the proposal with the differences; the order marked only with the load, each line once", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		await s.run({ op: "mark_sent", order: "OR-0001" });
		s.clock.now = new Date("2026-10-23T08:00:00Z");
		s.file(xml(BETA, ME, { number: "B-9", date: "2026-10-22", lines: [{ desc: "Cartucce XL", qty: "20.00", unit: "PZ", price: "12.80" }, { desc: "Carta A4", qty: "9.00", unit: "RISMA", price: "4.50" }, { desc: "Colla stick", qty: "3.00", unit: "PZ", price: "1.00" }] }));
		const asked = await s.stockRun({ op: "receive_invoice", supplier: "Beta", date: "ieri" });
		expect(inside(asked)).toContain(
			[
				"• Cartucce XL: ne sono arrivati 20 pezzi (ordine OR-0001); costano 12,80 €, più dei 12,50 € dell'ordine",
				"• Carta A4: ne sono arrivate 9 risme (ordine OR-0001)",
				"• Colla stick: arrivato ma non era in nessun ordine a questo fornitore",
				"• Cartucce XL: ne mancano ancora 4 pezzi (ordine OR-0001)",
				"• Carta A4: ne mancano ancora 3 risme (ordine OR-0001)",
			].join("\n"),
		);
		expect(inside(asked)).not.toMatch(/riga \d+ →|Ordini aperti/);
		expect(outside(asked)).toContain("Questo fornitore ha un ordine in arrivo: con la conferma lo segno nell'ordine. Ci sono differenze con l'ordine (nel riquadro): falle vedere a chi ti scrive.");
		// Only shown: the order is as it was.
		expect(s.store.read().orders[0]?.receipts).toEqual([]);
		const memo = new Map<string, unknown>();
		const done = await s.stockRun({ op: "receive_invoice", supplier: "Beta", date: "ieri", confirm: true, check: checkIn(asked) }, durable("r-1", memo));
		expect(outside(done)).toContain("Ho segnato la merce nel suo ordine, come nel riquadro, con le differenze: falle vedere a chi ti scrive.");
		const o = s.store.read().orders[0] as Order;
		const k = (line: number) => expect.stringMatching(new RegExp(`^[0-9a-f]{24}#${line}$`));
		expect(o.receipts).toEqual([
			{ k: k(1), n: 1, qty: "20", day: "2026-10-22" },
			{ k: k(2), n: 2, qty: "9", day: "2026-10-22" },
		]);
		expect(orderState(o)).toBe("partial");
		// The same call again, or the invoice asked again: nothing twice.
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", date: "ieri", confirm: true, check: checkIn(asked) }, durable("r-1", memo));
		const again = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		expect(inside(again)).not.toContain("ne sono arrivati");
		expect(s.store.read().orders[0]?.receipts).toHaveLength(2);
		const st = await s.run({ op: "status", supplier: "Beta" });
		expect(outside(st)).toContain("OR-0001 è arrivato in parte: nel riquadro cosa manca.");
		expect(inside(st)).toContain("  1. Cartucce XL: 24 pezzi a 12,50 €, arrivati 20 pezzi, ne mancano 4 pezzi");
		// The rest: received.
		s.file(xml(BETA, ME, { number: "B-10", date: "2026-10-23", lines: [{ desc: "Cartucce XL", qty: "4.00", unit: "PZ", price: "12.50" }, { desc: "Carta A4", qty: "3.00", unit: "RISMA", price: "4.50" }] }));
		const rest = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-10" });
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-10", confirm: true, check: checkIn(rest) });
		expect(orderState(s.store.read().orders[0] as Order)).toBe("received");
	});

	it("the matching: the oldest order first, past the quantity said, an invoice line marked once", () => {
		const line = (n: number, itemId: string, qty: string, price?: string) => ({ n, item: itemId, name: itemId, qty, unit: "pezzo", ...(price === undefined ? {} : { price, priceFrom: "said" as const }) });
		const order = (id: string, sentDay: string, lines: Order["lines"], receipts: Order["receipts"] = []): Order => ({ id, supplier: { key: "IT00000030015", name: "Beta", vat: "IT00000030015" }, status: "sent", day: sentDay, sentDay, lines, receipts, ...MARK });
		const inv = "a".repeat(24);
		const orders = [order("OR-0002", "2026-10-10", [line(1, "MG-0001", "5", "2")]), order("OR-0001", "2026-10-01", [line(1, "MG-0001", "3", "2")])];
		const m = matchInvoice(orders, { name: "Beta Forniture Srl", vat: "IT00000030015" }, inv, "2026-10-20", [{ line: 1, item: "MG-0001", qty: "10", cost: "2" }]);
		expect(m?.matched.map((x) => [x.order, x.qty, x.over])).toEqual([
			["OR-0001", 3000n, 0n],
			["OR-0002", 5000n, 2000n],
		]);
		// What is past every line is said, never put on one: 10 came, 8 were awaited.
		expect(m?.receipts.map((r) => [r.order, r.qty])).toEqual([
			["OR-0001", "3"],
			["OR-0002", "5"],
		]);
		expect(matchInvoice(orders, { name: "Altro", vat: "IT00000050013" }, inv, "2026-10-20", [])).toBeUndefined();
		const marked = [order("OR-0001", "2026-10-01", [line(1, "MG-0001", "3")], [{ k: lineKey(inv, 1), n: 1, qty: "3", day: "2026-10-20" }])];
		expect(matchInvoice(marked, { name: "Beta", vat: "IT00000030015" }, inv, "2026-10-20", [{ line: 1, item: "MG-0001", qty: "3", cost: "2" }])).toBeUndefined();
	});
});

describe("the brief, the agents, the file", () => {
	it("the brief: orders sent past the lead time, once a week and three a day at most; the articles to reorder, once a day; the lead time said per supplier", async () => {
		const s = setup();
		shop(s);
		for (let i = 0; i < 4; i++) {
			// Supplier and lines both said: the draft is made at once.
			expect(outside(await s.run({ op: "create", lines: [{ item: "Colla stick", quantity: i + 1 }], supplier: "Beta Forniture Srl" }))).toContain("È solo una bozza, non è partito niente.");
			await s.run({ op: "mark_sent", order: `OR-000${i + 1}` });
		}
		s.clock.now = new Date("2026-10-27T08:00:00Z");
		const first = await s.run({ op: "list", compact: true });
		expect(outside(first)).toContain("Ordini: 3 ordini inviati non sono ancora arrivati tutti, oltre il tempo di consegna (nel riquadro).");
		expect(inside(first).split("\n")).toHaveLength(3);
		expect(inside(first)).toContain("• OR-0001 a Beta Forniture Srl: inviato 8 giorni fa (19 ottobre), non ancora arrivato; ne avevo contati 7 per la consegna.");
		expect(outside(first)).toContain("Da riordinare: 2 articoli, uno dei quali non ancora sotto il minimo ma ci arriva prima della consegna; chiedimi «cosa devo riordinare?».");
		// The same day: three said already, and the line on reordering too.
		expect(await s.run({ op: "list", compact: true })).toBe("Ordini: niente da segnalare.");
		// The next day: the fourth, never the three said this week; the line on reordering again.
		s.clock.now = new Date("2026-10-28T08:00:00Z");
		const next = await s.run({ op: "list", compact: true });
		expect(inside(next).split("\n")).toEqual(["• OR-0004 a Beta Forniture Srl: inviato 9 giorni fa (19 ottobre), non ancora arrivato; ne avevo contati 7 per la consegna."]);
		expect(outside(next)).toContain("Da riordinare: 2 articoli");
		// Beta delivers in 10 days: a week on, not late any more until the tenth day is past.
		expect(outside(await s.run({ op: "lead_time", supplier: "Beta", days: 10 }))).toContain("questo fornitore consegna in 10 giorni");
		s.clock.now = new Date("2026-10-29T08:00:00Z");
		expect(outside(await s.run({ op: "list", compact: true }))).not.toContain("Ordini: ");
		const list = await s.run({ op: "list" });
		expect(inside(list)).not.toContain("in ritardo");
		s.clock.now = new Date("2026-11-03T08:00:00Z");
		const week = await s.run({ op: "list", compact: true });
		expect(inside(week).split("\n")).toHaveLength(3);
		expect(inside(week)).toContain("• OR-0001 a Beta Forniture Srl: inviato 15 giorni fa (19 ottobre), non ancora arrivato; Beta Forniture Srl consegna in 10 giorni.");
		expect(BRIEF_INSTRUCTION).toContain("orders (list)");
		const [guarded] = readOnlyInBriefs([s.tool], async () => true);
		expect(await guarded?.execute({ op: "create", supplier: "Beta" }, fresh())).toContain("nella chat del brief del mattino Owni legge soltanto");
	});

	it("another agente gets counts only; the audit has op and count; the CSV is made inert", async () => {
		const s = setup();
		shop(s);
		s.stock.update("rename", (st) => ({ ...st, items: st.items.map((i) => (i.id === "MG-0001" ? { ...i, name: "=Cartucce XL" } : i)) }));
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		for (const op of ["suggest", "list", "status"]) {
			const text = await s.run({ op, supplier: "Beta" }, agent());
			// The draft brings what was to reorder: nothing left to reorder.
			expect(text).toBe("Ordini ai fornitori: uno aperto (una bozza, 0 inviati), 0 oltre il tempo di consegna; 0 articoli da riordinare. A un altro agente do solo i conteggi: fornitori, articoli e prezzi no.");
		}
		for (const op of ["create", "change", "mark_sent", "received", "cancel", "document", "export", "lead_time"]) expect(await s.run({ op }, agent())).toContain("a un altro agente do solo quanti sono");
		const csvAnswer = await s.run({ op: "export" });
		expect(csvAnswer).toContain("Salvato ordini/ordini-al-2026-10-19.csv");
		const csv = readFileSync(join(s.root, "ordini", "ordini-al-2026-10-19.csv"), "utf8").replace(/^\uFEFF/, "").split("\r\n");
		expect(csv[0]).toBe("Ordine;Stato;Fornitore;Preparato il;Inviato il;Codice articolo;Articolo;Quantità;Unità;Arrivati;Prezzo previsto;Importo previsto");
		expect(csv[1]).toBe("OR-0001;bozza, non ancora inviato;Beta Forniture Srl;2026-10-19;;MG-0001;'=Cartucce XL;24;pezzo;0;12,5;300,00");
		const audited = s.events.filter((e) => e.type === "orders.used");
		expect(audited.every((e) => Object.keys(e).sort().join() === "count,op,type")).toBe(true);
		expect(JSON.stringify(audited)).not.toMatch(/Beta|Cartucce|12/);
	});

	it("the routing names the tool with Italian examples", () => {
		const described = setup().tool.description;
		for (const said of ["cosa sta per finire?» → suggest", "ho mandato l'ordine», «l'ho mandato venerdì» → mark_sent", "annulla l'ordine OR-0002» → cancel", "fammi il PDF dell'ordine per Beta» → document", "è arrivata la merce di Beta», «è arrivato l'ordine OR-0003» → received", "stock low says only what is already under the minimum"]) expect(described).toContain(said);
	});
});

describe("week 72 review: what is on its way, the delivery note, the status", () => {
	const DELTA = { name: "Delta Colle Srl", vat: "00000050013" };

	it("what to reorder counts the orders on their way: a draft or an order sent, said on the row; nothing once the order covers it", async () => {
		const s = setup();
		shop(s);
		// The person dictates supplier and line: the draft at once, nothing asked (on Thursday).
		s.clock.now = new Date("2026-10-15T08:00:00Z");
		const one = await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Carta A4", quantity: 1 }] });
		s.clock.now = NOW;
		expect(outside(one)).toContain("Fatto: ho preparato la bozza d'ordine OR-0001, come nel riquadro. È solo una bozza, non è partito niente.");
		const withDraft = inside(await s.run({ op: "suggest" }));
		expect(withDraft).toContain("• Carta A4: ne hai 6 risme, più 1 nella bozza OR-0001 per Beta Forniture Srl, non ancora inviata, il minimo è 5: a questo ritmo ci scendi sotto in 6 giorni");
		expect(withDraft).toContain("te ne servono 18, contando quelle in arrivo: ordinane 11 risme.");
		// A draft for the same article again: said, never silently twice.
		const twice = await s.run({ op: "create", supplier: "Beta" });
		expect(inside(twice)).toContain("Già in un ordine aperto:\n• Carta A4: già in OR-0001 (bozza)");
		expect(outside(twice)).toContain("Un articolo è già in un ordine aperto (nel riquadro): controlla di non ordinarlo due volte.");
		// Sent on Friday: the row says when.
		expect(await s.run({ op: "mark_sent", order: "OR-0001", day: "16/10" })).toContain("Segnato: OR-0001 inviato venerdì 16 ottobre.");
		expect(s.store.read().orders[0]?.sentDay).toBe("2026-10-16");
		expect(inside(await s.run({ op: "suggest" }))).toContain("più 1 in arrivo con l'ordine OR-0001 a Beta Forniture Srl (inviato il 16 ottobre)");
		expect(await s.run({ op: "mark_sent", order: "OR-0001", day: "domani" })).toContain("già segnato come inviato");
		// The whole proposal ordered and sent: nothing more to reorder for these articles.
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		expect(await s.run({ op: "mark_sent", order: "OR-0002" })).toContain("Segnato: OR-0002 inviato");
		expect(await s.run({ op: "suggest" })).toContain("Niente da riordinare");
	});

	it("the pace over the days the article is followed, the lead time past the cover, a need with decimals rounded up", async () => {
		const s = setup();
		shop(s);
		const mark = { by: "test:u", at: NOW.toISOString() };
		// Flour, by the kilo, followed for 20 days: 5 kg sold, 1,5 kg left, minimum 2.
		s.stock.update("flour", (st) => ({
			...st,
			nextItem: 5,
			nextMove: st.nextMove + 2,
			items: [...st.items, item(4, "Farina", "kg", { min: "2" })],
			moves: [...st.moves, { id: `MV-${String(st.nextMove).padStart(6, "0")}`, item: "MG-0004", kind: "carico", qty: "6.5", day: "2026-09-30", cost: "1", ...mark } as Movement, { id: `MV-${String(st.nextMove + 1).padStart(6, "0")}`, item: "MG-0004", kind: "scarico", qty: "5", day: "2026-10-10", reason: "vendita", ...mark } as Movement],
		}));
		const rows = inside(await s.run({ op: "suggest" })).split("\n");
		const flour = rows.find((r) => r.startsWith("• Farina")) as string;
		expect(flour).toContain("(5 negli ultimi 20 giorni, da quando lo segui)");
		// 5 kg in 20 days for 37 days: 9,25; past 2: 11,25, up to 12; less the 1,5 had: 10,5, ordered as 11.
		expect(flour).toContain("te ne servono 12: ordinane 11 kg (ne mancano 10,5: arrotondo all'unità).");
		// Beta delivers in 40 days, more than the 30 covered: both counted.
		await s.run({ op: "lead_time", supplier: "Beta", days: 40 });
		const cart = inside(await s.run({ op: "suggest" })).split("\n")[0] as string;
		expect(cart).toContain("te ne servono 45: ordinane 48 pezzi (4 scatole da 12).");
		const paper = inside(await s.run({ op: "suggest" })).split("\n").find((r) => r.startsWith("• Carta")) as string;
		expect(paper).toContain("(Beta Forniture Srl consegna in 40 giorni)");
	});

	it("«ordine per Delta» with nothing Delta sells: counts and who sells them instead; some left out of Gamma's", async () => {
		const s = setup();
		shop(s);
		s.file(xml(DELTA, ME, { number: "D-1", date: "2026-10-05", lines: [{ desc: "Colla stick", qty: "10.00", unit: "PZ", price: "1.00" }] }));
		const none = await s.run({ op: "create", supplier: "Delta" });
		expect(outside(none)).toContain("Da questo fornitore non c'è niente da riordinare. Ci sono altri 2 articoli da riordinare, che di solito compri da un altro fornitore (nel riquadro): vuoi l'ordine per quello?");
		expect(inside(none)).toBe("Fornitore chiesto: Delta Colle Srl\nDi solito da: Beta Forniture Srl");
		expect(outside(none)).not.toMatch(/Delta|Beta/);
		const gamma = await s.run({ op: "create", supplier: "Gamma" });
		expect(inside(gamma)).toContain("Fornitore: Gamma Carta Spa\n  1. Cartucce XL: 24 pezzi a 11,80 €");
		expect(outside(gamma)).toContain("(un altro articolo da riordinare non l'hai mai comprato da questo fornitore: te lo metto nell'ordine per il fornitore da cui li compri di solito?)");
		expect(inside(gamma)).not.toContain("Carta A4");
	});

	it("«è arrivata la merce di Beta»: by the person only, shown with a check, loaded at the order's price and marked; the invoice then bills it instead of loading it again, its price difference said", async () => {
		const s = setup();
		shop(s);
		s.clock.now = new Date("2026-10-15T08:00:00Z");
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		s.clock.now = NOW;
		// Not sent yet: said.
		expect(await s.run({ op: "received", order: "OR-0001" })).toContain("OR-0001 non risulta ancora inviato");
		await s.run({ op: "mark_sent", order: "OR-0001", day: "16/10" });
		expect(await s.run({ op: "received", order: "OR-0001" }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "received", order: "OR-0001", day: "15/10" })).toContain("la merce non può essere arrivata prima");
		// One box of cartridges and 4,5 reams would not be whole reams: the pack is read, the rest as said.
		const asked = await s.run({ op: "received", order: "OR-0001", day: "ieri", lines: [{ item: "Cartucce XL", quantity: 1, unit: "scatole" }, { item: "Carta A4", quantity: 4 }] });
		expect(outside(asked)).toContain("Segno arrivata con la bolla, domenica 18 ottobre, la merce di OR-0001 e la carico in magazzino al prezzo dell'ordine, come nel riquadro (prezzi per unità, senza IVA).");
		expect(inside(asked)).toBe("OR-0001 a Beta Forniture Srl\n• Cartucce XL: 12 pezzi a 12,50 €, da caricare\n• Carta A4: 4 risme a 4,50 €, da caricare");
		expect(s.stock.read().moves.filter((m) => m.doc === "bolla OR-0001")).toEqual([]);
		const memo = new Map<string, unknown>();
		const args = { op: "received", order: "OR-0001", day: "ieri", lines: [{ item: "Cartucce XL", quantity: 1, unit: "scatole" }, { item: "Carta A4", quantity: 4 }], confirm: true, check: checkIn(asked) };
		const done = await s.run(args, durable("h-1", memo));
		expect(outside(done)).toContain("Fatto: ho caricato in magazzino la merce arrivata con la bolla e l'ho segnata in OR-0001");
		await s.run(args, durable("h-1", memo));
		const loads = s.stock.read().moves.filter((m) => m.doc === "bolla OR-0001");
		expect(loads.map((m) => [m.item, m.qty, m.cost, m.day, m.supplier?.vat])).toEqual([
			["MG-0001", "12", "12.5", "2026-10-18", "IT00000030015"],
			["MG-0002", "4", "4.5", "2026-10-18", "IT00000030015"],
		]);
		const o = s.store.read().orders[0] as Order;
		expect(o.receipts).toEqual([
			{ k: expect.stringMatching(/^bolla:[0-9a-f]{16}$/), n: 1, qty: "12", day: "2026-10-18", from: "person" },
			{ k: expect.stringMatching(/^bolla:[0-9a-f]{16}$/), n: 2, qty: "4", day: "2026-10-18", from: "person" },
		]);
		expect(orderState(o)).toBe("partial");
		// The invoice: the cartridges came with the note (billed, not loaded again, its higher price said); the paper billed for 4, 2 more loaded.
		s.file(xml(BETA, ME, { number: "B-9", date: "2026-10-19", lines: [{ desc: "Cartucce XL", qty: "12.00", unit: "PZ", price: "12.80" }, { desc: "Carta A4", qty: "4.00", unit: "RISMA", price: "4.50" }, { desc: "Carta A4", qty: "2.00", unit: "RISMA", price: "4.50" }] }));
		const inv = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		expect(inside(inv)).toContain("• riga 1, Cartucce XL: già caricata con la bolla il 18 ottobre: la fattura la paga, non la carico di nuovo");
		expect(inside(inv)).toContain("• Cartucce XL: 12 pezzi già caricati con la bolla il 18 ottobre (ordine OR-0001): la fattura li paga, non li carico di nuovo; costano 12,80 €, più dei 12,50 € dell'ordine, il prezzo del carico con la bolla");
		expect(inside(inv)).toContain("• Carta A4: ne sono arrivate 2 risme (ordine OR-0001)");
		expect(outside(inv)).toContain("una riga si può caricare in magazzino, come nel riquadro (costi per unità, senza IVA); 2 no, con il motivo.");
		expect(outside(inv)).toContain("2 righe sono merce già arrivata con la bolla: non la carico di nuovo; con la conferma segno che questa fattura la paga");
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9", confirm: true, check: checkIn(inv) });
		expect(s.stock.read().moves.filter((m) => m.doc === "fattura n. B-9").map((m) => [m.item, m.qty])).toEqual([["MG-0002", "2"]]);
		const after = s.store.read().orders[0] as Order;
		expect(after.billed?.map((b) => [b.n, b.qty])).toEqual([
			[1, "12"],
			[2, "4"],
		]);
		// Billed once: asked again, nothing held, nothing loaded.
		const again = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		expect(inside(again)).toContain("già segnata: paga la merce arrivata con la bolla e caricata allora");
		expect(outside(again)).toContain("nessuna riga da caricare in magazzino.");
		// The rest by hand, all that is missing; a line of no order refused.
		expect(await s.run({ op: "received", order: "OR-0001", lines: [{ item: "Colla stick", quantity: 1 }] })).toContain("Questo articolo non è nell'ordine OR-0001");
		const rest = await s.run({ op: "received", order: "OR-0001" });
		expect(inside(rest)).toBe("OR-0001 a Beta Forniture Srl\n• Cartucce XL: 12 pezzi a 12,50 €, da caricare\n• Carta A4: 6 risme a 4,50 €, da caricare");
		await s.run({ op: "received", order: "OR-0001", confirm: true, check: checkIn(rest) });
		expect(orderState(s.store.read().orders[0] as Order)).toBe("received");
		expect(await s.run({ op: "received", order: "OR-0001" })).toBe("OR-0001 è già arrivato tutto.");
		expect(await s.run({ op: "received", supplier: "Beta" })).toContain("Per questo fornitore non c'è un ordine in arrivo");
	});

	it("goods in kilos by hand; an invoice that only bills the delivery note is confirmed to record it; an order cancelled between the proposal and the load loads nothing", async () => {
		const s = setup();
		shop(s);
		s.stock.update("flour", (st) => ({ ...st, nextItem: 5, items: [...st.items, item(4, "Farina", "kg")] }));
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Farina", quantity: "2.5", price: "1.2" }] });
		await s.run({ op: "mark_sent", order: "OR-0001" });
		const asked = await s.run({ op: "received", order: "OR-0001", lines: [{ item: "Farina", quantity: "1,25" }] });
		expect(inside(asked)).toContain("• Farina: 1,25 kg a 1,20 €, da caricare");
		await s.run({ op: "received", order: "OR-0001", lines: [{ item: "Farina", quantity: "1,25" }], confirm: true, check: checkIn(asked) });
		expect(s.store.read().orders[0]?.receipts.map((r) => r.qty)).toEqual(["1.25"]);
		s.file(xml(BETA, ME, { number: "B-20", date: "2026-10-19", lines: [{ desc: "Farina", qty: "1.25", unit: "KG", price: "1.20" }] }));
		const bills = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-20" });
		expect(outside(bills)).toContain("nessuna riga da caricare in magazzino: la merce è già arrivata con la bolla ed è caricata da allora (nel riquadro).");
		const billed = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-20", confirm: true, check: checkIn(bills) });
		expect(outside(billed)).toContain("Non c'era niente da caricare: la merce di questa fattura era già arrivata con la bolla");
		expect(s.store.read().orders[0]?.billed?.map((b) => b.qty)).toEqual(["1.25"]);
		expect(s.stock.read().moves.filter((m) => m.doc === "fattura n. B-20")).toEqual([]);
		// Cancelled between the proposal and the yes: nothing loaded.
		const before = s.stock.read().moves.length;
		const rest = await s.run({ op: "received", order: "OR-0001" });
		expect(await s.run({ op: "cancel", order: "OR-0001" })).toBe("Annullato l'ordine OR-0001. L'avevi già mandato al fornitore: avvisalo tu. Se vuoi ti preparo la mail.");
		expect(await s.run({ op: "received", order: "OR-0001", confirm: true, check: checkIn(rest) })).toContain("è annullato");
		expect(s.stock.read().moves).toHaveLength(before);
	});

	it("the status of a supplier: the orders awaited first, both when two; else the one arrived, else the draft", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 1, price: "1" }] });
		expect(outside(await s.run({ op: "status", supplier: "Beta" }))).toContain("OR-0001 è ancora una bozza: non risulta inviato.");
		await s.run({ op: "mark_sent", order: "OR-0001" });
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 2, price: "1" }] });
		await s.run({ op: "mark_sent", order: "OR-0002" });
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 3, price: "1" }] });
		const two = await s.run({ op: "status", supplier: "Beta" });
		expect(outside(two)).toContain("Da questo fornitore aspetti 2 ordini: Per me OR-0001 non è ancora arrivato");
		expect(inside(two)).toContain("OR-0001 a Beta");
		expect(inside(two)).toContain("OR-0002 a Beta");
		expect(inside(two)).not.toContain("OR-0003");
		const rest = await s.run({ op: "received", order: "OR-0001" });
		await s.run({ op: "received", order: "OR-0001", confirm: true, check: checkIn(rest) });
		const one = await s.run({ op: "status", supplier: "Beta" });
		expect(outside(one)).toContain("Per me OR-0002 non è ancora arrivato");
		expect(inside(one)).not.toContain("OR-0001");
	});

	it("mark_sent after the goods were loaded from the supplier: said; the invoice naming our order matches it first", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 5, price: "1" }] });
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 5, price: "1" }] });
		// The invoice came while OR-0001 was a draft: loaded, no order awaited.
		s.file(xml(BETA, ME, { number: "B-30", date: "2026-10-19", lines: [{ desc: "Colla stick", qty: "5.00", unit: "PZ", price: "1.00" }] }));
		const first = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-30" });
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-30", confirm: true, check: checkIn(first) });
		const sent = await s.run({ op: "mark_sent", order: "OR-0001" });
		expect(sent).toContain("se era questa merce, dimmi «è arrivato»: la segno nell'ordine senza caricarla di nuovo.");
		await s.run({ op: "mark_sent", order: "OR-0002" });
		// «È arrivato»: in the magazzino already, marked without loading it again.
		const colla = () => s.stock.read().moves.filter((m) => m.item === "MG-0003" && m.kind === "carico").length;
		const before = colla();
		const there = await s.run({ op: "received", order: "OR-0001" });
		expect(outside(there)).toContain("La merce di OR-0001 è già in magazzino, caricata prima che l'ordine fosse segnato (nel riquadro): la segno arrivata senza caricarla di nuovo.");
		expect(inside(there)).toBe("OR-0001 a Beta Forniture Srl\n• Colla stick: 5 pezzi già in magazzino (caricati il 19 ottobre): non li carico di nuovo");
		expect(outside(await s.run({ op: "received", order: "OR-0001", confirm: true, check: checkIn(there) }))).toContain("Fatto: ho segnato in OR-0001 la merce che era già in magazzino, senza caricarla di nuovo.");
		expect(colla()).toBe(before);
		const o1 = s.store.read().orders[0] as Order;
		expect(o1.receipts).toEqual([{ k: expect.stringMatching(/^carico:MV-\d{6}$/), n: 1, qty: "5", day: "2026-10-19", from: "stock" }]);
		expect(orderState(o1)).toBe("received");
		// That carico is OR-0001's now: OR-0002 finds nothing in the magazzino and loads with the note.
		const second = await s.run({ op: "received", order: "OR-0002" });
		expect(inside(second)).toBe("OR-0002 a Beta Forniture Srl\n• Colla stick: 5 pezzi a 1,00 €, da caricare");
		// The next invoice names OR-0002: it goes there, not to the older OR-0001.
		s.file(xml(BETA, ME, { number: "B-31", date: "2026-10-19", lines: [{ desc: "Colla stick", qty: "5.00", unit: "PZ", price: "1.00" }], refs: ["OR-0002"] }));
		const named = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-31" });
		expect(inside(named)).toContain("• Colla stick: ne sono arrivati 5 pezzi (ordine OR-0002)");
	});

	it("a crash after the load: the run again marks the order with what was meant; an OrderError after the load is said, the price rises still said", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		await s.run({ op: "mark_sent", order: "OR-0001" });
		s.file(xml(BETA, ME, { number: "B-9", date: "2026-10-19", lines: [{ desc: "Cartucce XL", qty: "24.00", unit: "PZ", price: "12.80" }] }));
		const asked = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		const args = { op: "receive_invoice", supplier: "Beta", invoice: "B-9", confirm: true, check: checkIn(asked) };
		// The load is written, then the process dies before its step is kept.
		const memo = new Map<string, unknown>();
		const crashing: ToolContext = {
			...durable("x-1", memo),
			step: async (key, work) => {
				if (memo.has(key)) return memo.get(key) as never;
				const v = await work();
				if (key === "apply") throw new Error("crash");
				memo.set(key, v);
				return v;
			},
		};
		await expect(s.stockRun(args, crashing)).rejects.toThrow("crash");
		expect(s.store.read().orders[0]?.receipts).toEqual([]);
		const again = await s.stockRun(args, durable("x-1", memo));
		expect(outside(again)).toContain("Fatto: una riga di questa fattura è caricata in magazzino.");
		expect(s.store.read().orders[0]?.receipts.map((r) => r.qty)).toEqual(["24"]);
		expect(s.stock.read().moves.filter((m) => m.doc === "fattura n. B-9")).toHaveLength(1);
		// Another shop: the orders refuse the mark after the load.
		const t = setup();
		shop(t);
		await t.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await t.run({ op: "create", supplier: "Beta" })) });
		await t.run({ op: "mark_sent", order: "OR-0001" });
		t.file(xml(BETA, ME, { number: "B-9", date: "2026-10-19", lines: [{ desc: "Cartucce XL", qty: "24.00", unit: "PZ", price: "13.50" }] }));
		const link = orderLink(t.store);
		const [failing] = createStockTools({
			workspace: t.workspace,
			store: t.stock,
			invoices: new InvoiceStore(t.dir),
			scanner: new InvoiceScanner(t.workspace, { read: async (_name, data) => documentFattura(data) }),
			purchases: new PurchaseStore(t.dir),
			orders: {
				...link,
				receive: () => {
					throw new OrderError("prova");
				},
			},
			timeZone: "Europe/Rome",
			whoIs: () => "test:u",
			now: () => t.clock.now,
		});
		const run = async (a: Record<string, unknown>) => String(await failing?.execute(a, fresh()));
		const proposal = await run({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		const done = await run({ op: "receive_invoice", supplier: "Beta", invoice: "B-9", confirm: true, check: checkIn(proposal) });
		expect(done).toContain("La merce è caricata, ma non sono riuscita a segnarla nell'ordine: prova.");
		expect(done).toContain("Un prezzo di questa fattura è aumentato");
		expect(t.stock.read().moves.filter((m) => m.doc === "fattura n. B-9")).toHaveLength(1);
	});

	it("the matching: an order kept by name only matches the invoice of that supplier with its partita IVA; excess on a full line is said, never put on it", () => {
		const byName: Order = { id: "OR-0001", supplier: { key: "nome:beta forniture srl", name: "Beta Forniture Srl" }, status: "sent", day: "2026-10-01", sentDay: "2026-10-01", lines: [{ n: 1, item: "MG-0001", name: "X", qty: "3", unit: "pezzo" }], receipts: [], ...MARK };
		const inv = "b".repeat(24);
		const m = matchInvoice([byName], { name: "BETA Forniture S.r.l.", vat: "IT00000030015" }, inv, "2026-10-20", [{ line: 1, item: "MG-0001", qty: "3", cost: "2" }]);
		expect(m?.matched.map((x) => [x.order, x.qty])).toEqual([["OR-0001", 3000n]]);
		expect(awaitedOf([byName], { name: "Altro Srl", vat: "IT00000050013" })).toEqual([]);
		const full: Order = { ...byName, lines: [...byName.lines, { n: 2, item: "MG-0002", name: "Y", qty: "1", unit: "pezzo" }], receipts: [{ k: lineKey("c".repeat(24), 1), n: 1, qty: "3", day: "2026-10-10" }] };
		const over = matchInvoice([full], { name: "Beta Forniture Srl", vat: "IT00000030015" }, inv, "2026-10-20", [{ line: 1, item: "MG-0001", qty: "2", cost: "2" }]);
		expect(over?.matched.map((x) => [x.order, x.qty, x.over])).toEqual([["OR-0001", 0n, 2000n]]);
		expect(over?.receipts).toEqual([]);
	});

	it("a broken orders.json: every op says so; an invoice is shown but not loaded, a line may have come with a delivery note", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 1 }] });
		writeFileSync(join(s.dir, "orders.json"), "{ not json");
		rmSync(join(s.dir, "orders.json.bak"), { force: true });
		for (const op of ["suggest", "create", "change", "mark_sent", "received", "cancel", "list", "status", "document", "export", "lead_time"]) expect(await s.run({ op, supplier: "Beta" })).toContain("orders.json) non si leggono");
		s.file(xml(BETA, ME, { number: "B-9", date: "2026-10-19", lines: [{ desc: "Colla stick", qty: "1.00", unit: "PZ", price: "1.00" }] }));
		const asked = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9" });
		expect(outside(asked)).toContain("Gli ordini ai fornitori non si leggono");
		const done = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-9", confirm: true, check: checkIn(asked) });
		expect(done).toBe("Gli ordini ai fornitori non si leggono: non carico questa fattura, perché qualche riga potrebbe essere già arrivata con la bolla e la caricherei due volte. Va prima sistemato il file degli ordini.");
		expect(s.stock.read().moves.filter((m) => m.doc === "fattura n. B-9")).toEqual([]);
		expect(readFileSync(join(s.dir, "orders.json"), "utf8")).toBe("{ not json");
	});

	it("the document in Word without prices; made again in the same file; a file not under ordini/ never written", async () => {
		const s = setup();
		shop(s);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 4, price: "1" }] });
		const doc = await s.run({ op: "document", order: "OR-0001", format: "docx", no_prices: true });
		expect(outside(doc)).toContain("Ecco il documento Word dell'ordine OR-0001 per il fornitore, senza prezzi: il file è nel riquadro. Non l'ho mandato a nessuno.");
		expect(inside(doc)).toBe("File: ordini/Ordine-OR-0001-Beta-Forniture-Srl.docx");
		expect(s.made[0]).toMatchObject({ format: "docx" });
		expect(s.made[0]?.text).not.toContain("Prezzo unitario");
		expect(inside(await s.run({ op: "document", order: "OR-0001", format: "docx" }))).toBe("File: ordini/Ordine-OR-0001-Beta-Forniture-Srl.docx");
		s.store.update("evil", (st) => ({ ...st, orders: st.orders.map((o) => ({ ...o, file: "fatture/f1.docx" })) }));
		expect(inside(await s.run({ op: "document", order: "OR-0001", format: "docx" }))).toBe("File: ordini/Ordine-OR-0001-Beta-Forniture-Srl-2.docx");
		expect(readFileSync(join(s.root, "fatture", "f1.xml"), "utf8")).toContain("FatturaElettronica");
	});

	it("an invoice past the delivery note: the note's part billed, only the rest loaded; the next invoice is not held back; a cost unlike the note's said", async () => {
		const s = setup();
		shop(s);
		s.clock.now = new Date("2026-10-15T08:00:00Z");
		await s.run({ op: "create", supplier: "Beta", confirm: true, check: checkIn(await s.run({ op: "create", supplier: "Beta" })) });
		s.clock.now = NOW;
		await s.run({ op: "mark_sent", order: "OR-0001", day: "16/10" });
		const cartridges = () => s.stock.read().moves.filter((m) => m.item === "MG-0001" && m.kind === "carico").reduce((t, m) => t + Number(m.qty), 0);
		const start = cartridges();
		const note = await s.run({ op: "received", order: "OR-0001", lines: [{ item: "Cartucce XL", quantity: 10 }] });
		await s.run({ op: "received", order: "OR-0001", lines: [{ item: "Cartucce XL", quantity: 10 }], confirm: true, check: checkIn(note) });
		expect(cartridges()).toBe(start + 10);
		s.file(xml(BETA, ME, { number: "B-40", date: "2026-10-19", lines: [{ desc: "Cartucce XL", qty: "15.00", unit: "PZ", price: "12.80" }] }));
		const inv = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-40" });
		expect(inside(inv)).toContain("• riga 1, Cartucce XL → MG-0001 Cartucce XL: 5 pezzi a 12,80 € (il resto della riga: 10 pezzi erano già arrivati con la bolla)");
		expect(inside(inv)).toContain("• riga 1, Cartucce XL: già caricata con la bolla il 19 ottobre (10 pezzi su 15 pezzi: il resto lo carico): la fattura la paga, non la carico di nuovo; in fattura costa 12,80 €, con la bolla l'ho caricata a 12,50 €");
		// The held half of the split line is no line left out.
		expect(outside(inv)).toContain("una riga si può caricare in magazzino, come nel riquadro (costi per unità, senza IVA).");
		expect(outside(inv)).toContain("Per la merce della bolla il costo in fattura è diverso da quello con cui l'ho caricata (nel riquadro): se vuoi, dopo il carico correggo il costo dell'articolo con quello della fattura.");
		const done = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-40", confirm: true, check: checkIn(inv) });
		expect(done).toContain("se vuoi, correggo il costo dell'articolo con quello della fattura.");
		expect(cartridges()).toBe(start + 15);
		const o = s.store.read().orders[0] as Order;
		expect(o.billed?.map((b) => [b.n, b.qty])).toEqual([[1, "10"]]);
		expect(o.receipts.filter((r) => r.n === 1).map((r) => [r.from ?? "invoice", r.qty])).toEqual([
			["person", "10"],
			["invoice", "5"],
		]);
		// The next invoice for 10: nothing of the note left to bill, all loaded.
		s.file(xml(BETA, ME, { number: "B-41", date: "2026-10-19", lines: [{ desc: "Cartucce XL", qty: "10.00", unit: "PZ", price: "12.50" }] }));
		const next = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-41" });
		expect(inside(next)).not.toContain("già caricata con la bolla");
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-41", confirm: true, check: checkIn(next) });
		expect(cartridges()).toBe(start + 25);
	});

	it("a supplier said loosely is shown before the draft; the lead time is the person's to say", async () => {
		const s = setup();
		shop(s);
		const loose = await s.run({ op: "create", supplier: "Beta", lines: [{ item: "Colla stick", quantity: 1 }] });
		expect(outside(loose)).toContain("Preparerei una bozza d'ordine");
		expect(s.store.read().orders).toEqual([]);
		expect(await s.run({ op: "lead_time", supplier: "Beta", days: 10 }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(s.store.read().leads).toEqual([]);
	});

	it("a carico by hand then marked arrived: the invoice that comes later bills it, never loads it again; a carico from an invoice stays paid by that invoice", async () => {
		const s = setup();
		shop(s);
		const onHand = () => s.stock.read().moves.filter((m) => m.item === "MG-0003").reduce((t, m) => t + (m.kind === "carico" ? Number(m.qty) : m.kind === "scarico" ? -Number(m.qty) : 0), 0);
		expect(onHand()).toBe(8);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 5, price: "1" }] });
		await s.run({ op: "mark_sent", order: "OR-0001" });
		// Loaded by hand with the delivery note, then «è arrivato».
		await s.stockRun({ op: "receive", item: "Colla stick", quantity: 5, cost: 1, supplier: "Beta Forniture Srl", doc: "DDT 9" });
		expect(onHand()).toBe(13);
		const there = await s.run({ op: "received", order: "OR-0001" });
		expect(inside(there)).toContain("5 pezzi già in magazzino");
		await s.run({ op: "received", order: "OR-0001", confirm: true, check: checkIn(there) });
		expect(s.store.read().orders[0]?.receipts).toEqual([{ k: expect.stringMatching(/^carico:MV-\d{6}$/), n: 1, qty: "5", day: "2026-10-19", from: "stock", bill: true }]);
		// The invoice of those goods: held, nothing loaded.
		s.file(xml(BETA, ME, { number: "B-50", date: "2026-10-19", lines: [{ desc: "Colla stick", qty: "5.00", unit: "PZ", price: "1.00" }] }));
		const inv = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-50" });
		expect(inside(inv)).toContain("già caricata con la bolla il 19 ottobre: la fattura la paga, non la carico di nuovo");
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-50", confirm: true, check: checkIn(inv) });
		expect(onHand()).toBe(13);
		expect(s.store.read().orders[0]?.billed?.map((b) => b.qty)).toEqual(["5"]);
	});

	it("goods past order A on A's invoice, marked arrived on order B: paid by A's invoice; B's invoice then loads as other goods", async () => {
		const s = setup();
		shop(s);
		const onHand = () => s.stock.read().moves.filter((m) => m.item === "MG-0003").reduce((t, m) => t + (m.kind === "carico" ? Number(m.qty) : m.kind === "scarico" ? -Number(m.qty) : 0), 0);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 5, price: "1" }] });
		await s.run({ op: "mark_sent", order: "OR-0001" });
		s.file(xml(BETA, ME, { number: "B-60", date: "2026-10-19", lines: [{ desc: "Colla stick", qty: "10.00", unit: "PZ", price: "1.00" }] }));
		const a = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-60" });
		expect(inside(a)).toContain("• Colla stick: ne sono arrivati 10 pezzi (ordine OR-0001), 5 pezzi più di quelli ordinati");
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-60", confirm: true, check: checkIn(a) });
		expect(onHand()).toBe(18);
		await s.run({ op: "create", supplier: "Beta Forniture Srl", lines: [{ item: "Colla stick", quantity: 5, price: "1" }] });
		await s.run({ op: "mark_sent", order: "OR-0002" });
		const b = await s.run({ op: "received", order: "OR-0002" });
		expect(inside(b)).toContain("5 pezzi già in magazzino");
		await s.run({ op: "received", order: "OR-0002", confirm: true, check: checkIn(b) });
		expect(onHand()).toBe(18);
		// Not billable: A's invoice paid it.
		expect(s.store.read().orders[1]?.receipts[0]).toMatchObject({ from: "stock", qty: "5" });
		expect(s.store.read().orders[1]?.receipts[0]?.bill).toBeUndefined();
		s.file(xml(BETA, ME, { number: "B-61", date: "2026-10-19", lines: [{ desc: "Colla stick", qty: "5.00", unit: "PZ", price: "1.00" }] }));
		const next = await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-61" });
		expect(inside(next)).not.toContain("già caricata con la bolla");
		await s.stockRun({ op: "receive_invoice", supplier: "Beta", invoice: "B-61", confirm: true, check: checkIn(next) });
		expect(onHand()).toBe(23);
	});
});
