import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { PriceListStore } from "../src/core/price-list-store.ts";
import { SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { isIssued } from "../src/core/sales-invoices.ts";
import { SCHEDULE_LIMITS } from "../src/core/schedules.ts";
import { sameWord, stemsWithin } from "../src/core/name-keys.ts";
import { STOCK_LIMITS, StockError, stockAgentReads, stockCallReads } from "../src/core/stock.ts";
import { STOCK_BROKEN, STOCK_FULL, type StockLink, StockStore } from "../src/core/stock-store.ts";
import { stateOf } from "../src/core/stock-sums.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { createSalesInvoiceTools } from "../src/core/tools/sales-invoice-tools.ts";
import { createStockTools, type StockEvent } from "../src/core/tools/stock-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names and suppliers.
const NOW = new Date("2026-10-19T08:00:00Z"); // Monday 19 October 2026, in Rome
const ORDINARIO: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: ["IT51X0000000000000000000001"], by: "test:u", at: NOW.toISOString() };
const DELTA = { customer: "Delta Servizi Srl", vat_number: "00000020016", address: "Via Verdi 2, 00184 Roma RM", recipient_code: "ZZZ0001" };

let calls = 0;
const fresh = (callId = `s${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });

const FENCE = /<<<dati del magazzino ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati del magazzino \1>>>/g;
const outside = (text: string) => text.replace(FENCE, "");
const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
const NO_EM_DASH = /\u2014/;
/** Text for the person never names an op or a parameter. */
const NO_OPS = /\b(add_item|receive|unload|remove_item|movements|compact|confirm|uso_interno)\b/;

const dirs: string[] = [];
afterEach(() => {
	// Only the directories this file made, each by its exact path.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-stock-"));
	dirs.push(dir);
	return dir;
}

function setup(o: { stockStore?: (store: StockStore) => StockStore; salesStock?: (store: StockStore) => StockLink } = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(ORDINARIO);
	const priceList = new PriceListStore(dir);
	priceList.addMany("seed", 2, (id, n) => (n === 0 ? { id, name: "Cartucce XL", unit: "pezzo", price: "25", vat: 22, by: "test:u", at: NOW.toISOString() } : { id, name: "Consulenza", unit: "ora", price: "60", vat: 22, by: "test:u", at: NOW.toISOString() }));
	const store = new StockStore(dir);
	const events: StockEvent[] = [];
	const clock = { now: NOW };
	const [tool] = createStockTools({ workspace, store: o.stockStore?.(store) ?? store, priceList, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now });
	if (tool === undefined) throw new Error("no tool");
	const sales = new SalesInvoiceStore(dir);
	sales.update("seed", (state) => ({ ...state, settings: { by: "test:u", at: NOW.toISOString(), lastBefore: { 2026: 0, 2027: 0 } } }));
	const [salesTool] = createSalesInvoiceTools({
		workspace,
		store: sales,
		company: invoices,
		taxes: new TaxStore(dir),
		priceList,
		stock: o.salesStock?.(store) ?? store,
		scanner: new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) }),
		timeZone: "Europe/Rome",
		whoIs: () => "test:u",
		now: () => clock.now,
		make: async (input) => ({ data: Buffer.from(`%PDF-1.4 finta\n${input.text}`), notes: [] }),
	});
	if (salesTool === undefined) throw new Error("no sales tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const sell = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await salesTool.execute(args, c));
	const onHand = (id = "MG-0001") => {
		const b = store.read();
		const item = b.items.find((i) => i.id === id);
		if (item === undefined) throw new Error(`no ${id}`);
		return stateOf(item, b.moves);
	};
	return { dir, root, store, events, run, sell, sales, onHand, clock, tool, priceList };
}

describe("il magazzino: carichi, scarichi e costo medio", () => {
	it("recomputes the weighted average on every carico, and a scarico never changes it", async () => {
		const s = setup();
		const added = await s.run({ op: "add_item", item: "Toner nero", unit: "pezzi", min: 10 });
		expect(added).toContain("Fatto, ho aggiunto l'articolo (MG-0001): si conta a pezzi, ti avviso sotto i 10.");
		expect(inside(added)).toContain("Toner nero");
		const first = await s.run({ op: "receive", item: "toner nero", quantity: 10, cost: "12" });
		expect(first).toContain("Fatto, ho caricato 10 pezzi a 12,00 € per unità, senza IVA. Ora 10 pezzi, costo medio 12,00 €, valore 120,00 €.");
		expect(first).not.toMatch(/MV-/);
		const second = await s.run({ op: "receive", item: "MG-0001", quantity: 30, cost: "8", supplier: "Beta Forniture Srl", doc: "DDT 45" });
		// (10 × 12 + 30 × 8) / 40 = 9.
		expect(second).toContain("costo medio 9,00 € (era 12,00 €)");
		expect(second).toContain("valore 360,00 €");
		expect(inside(second)).toContain("Beta Forniture Srl");
		expect(outside(second)).not.toContain("Beta");
		const out = await s.run({ op: "unload", item: "toner nero", quantity: 5, reason: "uso_interno" });
		expect(out).toContain("Fatto, ho scaricato 5 pezzi (uso interno). Ora 35 pezzi.");
		expect(s.onHand().average).toBe(90_000n);
		expect(s.onHand().value).toBe(31_500n);
		expect(await s.run({ op: "status", item: "toner nero" })).toContain("l'hai pagato in media 9,00 € l'uno, valore 315,00 €");
		expect(await s.run({ op: "value" })).toContain("Il magazzino vale 315,00 €, a quanto hai pagato la merce che c'è (un articolo). Per ogni articolo conto il prezzo medio dei carichi, pesato sulle quantità");
		// Each movement once: the call run again writes nothing twice.
		const again = fresh("same-call");
		await s.run({ op: "receive", item: "toner nero", quantity: 1, cost: 9 }, again);
		await s.run({ op: "receive", item: "toner nero", quantity: 1, cost: 9 }, again);
		expect(s.onHand().onHand).toBe(36_000n);
		for (const text of [added, first, second, out]) {
			expect(text).not.toMatch(NO_EM_DASH);
			expect(outside(text)).not.toMatch(NO_OPS);
		}
	});

	it("keeps quantities to three decimals (kg, m, l) and refuses a fourth", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Filo di rame", unit: "metri" });
		expect(s.store.read().items[0]?.unit).toBe("m");
		expect(await s.run({ op: "receive", item: "filo di rame", quantity: 2.125, cost: "3,2" })).toContain("ho caricato 2,125 m a 3,20 € per unità");
		await s.run({ op: "unload", item: "filo di rame", quantity: "0,5", reason: "vendita" });
		expect(s.onHand().onHand).toBe(1625n);
		expect(await s.run({ op: "status", item: "filo di rame" })).toContain("1,625 m in magazzino");
		expect(await s.run({ op: "receive", item: "filo di rame", quantity: 1.2345, cost: 1 })).toMatch(/^Errore: .*al più 3 decimali/);
		// «1.250» reads two ways: asked, never guessed.
		expect(await s.run({ op: "receive", item: "filo di rame", quantity: "1.250", cost: 1 })).toContain("migliaia o decimali");
		expect(s.store.read().moves).toHaveLength(2);
	});

	it("asks once before going under zero; only a person's yes records it, and it stays in negativo until a count", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 5, cost: 12 });
		const asked = await s.run({ op: "unload", item: "cartucce xl", quantity: 8, reason: "vendita" });
		expect(asked).toContain("Di questo articolo (nel riquadro) ne risultano 5 pezzi: togliendone 8 il magazzino andrebbe a −3. Chiedi a chi ti scrive se va bene lo stesso (di solito manca un carico)");
		expect(asked).not.toMatch(/^Errore/);
		expect(s.store.read().moves).toHaveLength(1);
		// The yes from a scheduled turn or another agente is no person's yes.
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 8, reason: "vendita", confirm: true }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 8, reason: "vendita", confirm: true }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(s.store.read().moves).toHaveLength(1);
		// A scarico within what there is stays open (bookkeeping).
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 1, reason: "scarto" }, fresh(undefined, "scheduled"))).toContain("Fatto, ho scaricato 1 pezzo (scarto)");
		const done = await s.run({ op: "unload", item: "cartucce xl", quantity: 7, reason: "vendita", confirm: true });
		expect(done).toContain("Ora −3 pezzi");
		expect(done).toContain("in negativo");
		expect(s.onHand().negative).toBe(true);
		// A carico back above zero does not clear it: only a count does.
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 12 });
		expect(s.onHand().negative).toBe(true);
		expect(await s.run({ op: "low" })).toContain("in negativo, da ricontare");
		const counted = await s.run({ op: "count", item: "cartucce xl", quantity: 7 });
		expect(counted).toContain("Non è più in negativo.");
		expect(s.onHand().negative).toBe(false);
	});

	it("a count adds a rettifica with the difference and never edits a movement; only the person asks it", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12 });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 10, reason: "vendita" });
		const before = JSON.stringify(s.store.read().moves);
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 37 }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 37 }, agent())).toMatch(/^Errore: a un altro agente/);
		const answer = await s.run({ op: "count", item: "cartucce xl", quantity: 37 });
		expect(answer).toContain("Fatto, ho corretto il magazzino con il conteggio: contati 37 pezzi, ne mancano 3.");
		expect(answer).not.toContain("I movimenti di prima");
		const moves = s.store.read().moves;
		expect(JSON.stringify(moves.slice(0, 2))).toBe(before);
		expect(moves).toHaveLength(3);
		expect(moves[2]).toMatchObject({ kind: "rettifica", qty: "-3", counted: "37" });
		expect(s.onHand().onHand).toBe(37_000n);
		// The average stays: a rettifica goes at it.
		expect(s.onHand().average).toBe(120_000n);
		// The same count again matches, and is recorded as such.
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 37 })).toContain("Fatto, ho segnato il conteggio: 37 pezzi, corrisponde a quello che risultava.");
		await s.run({ op: "count", item: "cartucce xl", quantity: 40 });
		expect(await s.run({ op: "count", item: "cartucce xl", quantity: 52 })).toContain("ce ne sono 12 in più");
	});
});

describe("il magazzino e le fatture emesse", () => {
	async function linked() {
		const s = setup();
		const added = await s.run({ op: "add_item", item: "LS-0001", min: 10 });
		expect(added).toContain("È la voce LS-0001 del listino");
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12 });
		return s;
	}
	const draftOf = async (s: Awaited<ReturnType<typeof linked>>, lines: unknown[]) => {
		const answer = await s.sell({ op: "draft", ...DELTA, lines });
		const id = s.sales.read().invoices.at(-1)?.id as string;
		return { answer, id };
	};

	it("a draft never unloads; the issue unloads once, however many times it runs; a credit note puts back", async () => {
		const s = await linked();
		const { answer, id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 5 }, { item: "Consulenza", quantity: 2 }]);
		expect(answer).not.toMatch(/^Errore/);
		const lines = s.sales.read().invoices.at(-1)?.lines ?? [];
		expect(lines.map((l) => l.item)).toEqual(["LS-0001", "LS-0002"]);
		expect(s.onHand().onHand).toBe(50_000n);
		const call = fresh("issue-1");
		const issued = await s.sell({ op: "issue", draft: id, confirm: true }, call);
		expect(issued).toContain("Ho scaricato dal magazzino una riga venduta");
		expect(inside(issued)).toContain("Cartucce XL (MG-0001): −5 pezzi");
		expect(s.onHand().onHand).toBe(45_000n);
		// Run again (a replay), and named again: nothing moves twice.
		await s.sell({ op: "issue", draft: id, confirm: true }, call);
		await s.sell({ op: "issue", draft: id, confirm: true });
		expect(s.onHand().onHand).toBe(45_000n);
		expect(s.store.read().moves.filter((m) => m.kind === "scarico")).toHaveLength(1);
		// The average never moves on a sale.
		expect(s.onHand().average).toBe(120_000n);
		const inv = s.sales.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error("not issued");
		const credit = await s.sell({ op: "credit_note", invoice: inv.number });
		expect(credit).not.toMatch(/^Errore/);
		expect(s.onHand().onHand).toBe(45_000n);
		const creditId = s.sales.read().invoices.at(-1)?.id as string;
		const back = await s.sell({ op: "issue", draft: creditId, confirm: true });
		expect(back).toContain("Ho rimesso in magazzino");
		expect(s.onHand().onHand).toBe(50_000n);
		await s.sell({ op: "issue", draft: creditId, confirm: true });
		expect(s.onHand().onHand).toBe(50_000n);
	});

	it("a line in another unit is left out and said; a sale past what there is goes in negativo and is said", async () => {
		const s = await linked();
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 2, unit: "scatole" }, { item: "Cartucce XL", quantity: 60 }]);
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(issued).toContain("Una riga non l'ho scaricata dal magazzino");
		expect(issued).toContain("l'unità della riga non è quella dell'articolo");
		expect(issued).toContain("in negativo in magazzino");
		expect(s.onHand().onHand).toBe(-10_000n);
		expect(s.onHand().negative).toBe(true);
	});

	it("a credit note never puts back more than its invoice took out", async () => {
		const s = await linked();
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 4 }]);
		await s.sell({ op: "issue", draft: id, confirm: true });
		const inv = s.sales.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error("not issued");
		// 9 at a lower price: within what was invoiced in money, past it in pieces.
		expect(await s.sell({ op: "credit_note", invoice: inv.number, lines: [{ description: "Cartucce XL", quantity: 9, price: 5, vat: 22, item: "LS-0001" }] })).not.toMatch(/^Errore/);
		const creditId = s.sales.read().invoices.at(-1)?.id as string;
		expect(await s.sell({ op: "issue", draft: creditId, confirm: true })).toContain("Cartucce XL (MG-0001): +4 pezzi");
		expect(s.onHand().onHand).toBe(50_000n);
	});
});

describe("il magazzino: sottoscorta, elenco, togliere, file", () => {
	it("says a sottoscorta in the brief once per crossing, and again only after it went back above", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL", min: 10 });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 12, cost: 12 });
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		await s.run({ op: "unload", item: "cartucce xl", quantity: 4, reason: "vendita" });
		const first = await s.run({ op: "low", compact: true });
		expect(first).toContain("Magazzino: un articolo è sceso sotto il minimo.");
		expect(inside(first)).toContain("Cartucce XL: 8 pezzi, minimo 10 pezzi");
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// Lower still: the same crossing, not said again.
		await s.run({ op: "unload", item: "cartucce xl", quantity: 1, reason: "vendita" });
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// Back above, then under again: a new crossing, said once.
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 12 });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 10, reason: "vendita" });
		expect(await s.run({ op: "low", compact: true })).toContain("un articolo è sceso");
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// «avvisami sotto le 10» said again with another level: said once with it.
		await s.run({ op: "add_item", item: "cartucce xl", min: 20 });
		expect(await s.run({ op: "low", compact: true })).toContain("un articolo è sceso");
		// The brief's call is a read: it runs in a brief's thread.
		expect(stockCallReads({ op: "low", compact: true })).toBe(true);
		expect(stockCallReads({ op: "receive" })).toBe(false);
		expect(BRIEF_INSTRUCTION).toContain("stock (low)");
		expect(BRIEF_INSTRUCTION.length).toBeLessThanOrEqual(SCHEDULE_LIMITS.maxInstructionChars);
	});

	it("lists what is running low first", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Viti", min: 100 });
		await s.run({ op: "add_item", item: "Bulloni", min: 5 });
		await s.run({ op: "receive", item: "viti", quantity: 500, cost: "0,02" });
		await s.run({ op: "receive", item: "bulloni", quantity: 2, cost: "0,1" });
		const list = await s.run({ op: "list" });
		expect(list).toContain("2 articoli in magazzino, uno sottoscorta o in negativo (in cima)");
		expect(inside(list).indexOf("Bulloni")).toBeLessThan(inside(list).indexOf("Viti"));
		const low = await s.run({ op: "low" });
		expect(inside(low)).toContain("Bulloni");
		expect(inside(low)).not.toContain("Viti");
	});

	it("removes an article only with nothing on hand, and only for the person; its movements stay", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 3, cost: 12 });
		expect(await s.run({ op: "remove_item", item: "cartucce xl" })).toContain("Non lo tolgo: di questo articolo (MG-0001) risultano ancora 3 pezzi");
		await s.run({ op: "count", item: "cartucce xl", quantity: 0 });
		expect(await s.run({ op: "remove_item", item: "cartucce xl" }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		const removed = await s.run({ op: "remove_item", item: "cartucce xl" });
		expect(removed).toContain("Fatto, ho tolto l'articolo (MG-0001)");
		expect(s.store.read().moves).toHaveLength(2);
		expect(await s.run({ op: "list" })).toContain("Il magazzino è vuoto");
		// The name is free again, with a new number.
		expect(await s.run({ op: "add_item", item: "Cartucce XL" })).toContain("MG-0002");
		expect(s.events.map((e) => e.op)).toEqual(["add_item", "receive", "count", "remove_item", "add_item"]);
	});

	it("exports a CSV with hostile cells made inert, never over another file", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "=HYPERLINK(\"http://x.example\")", code: "+SKU1", place: "@scaffale", category: "-cat" });
		await s.run({ op: "receive", item: "MG-0001", quantity: 4, cost: "2,5" });
		const first = await s.run({ op: "export" });
		expect(first).toContain("Salvato magazzino/magazzino-al-2026-10-19.csv");
		const second = await s.run({ op: "export" });
		expect(second).toContain("magazzino/magazzino-al-2026-10-19-2.csv");
		const csv = readFileSync(join(s.root, "magazzino/magazzino-al-2026-10-19.csv"), "utf8");
		expect(csv).toContain(`"'=HYPERLINK(""http://x.example"")"`);
		expect(csv).toContain("'+SKU1");
		expect(csv).toContain("'@scaffale");
		expect(csv).toContain("'-cat");
		expect(csv).toContain(";4;;2,5;10,00;");
		expect(csv).not.toMatch(/;[=+@-][^0-9]/);
	});

	it("never writes over a file that does not read", async () => {
		const s = setup();
		writeFileSync(join(s.dir, "stock.json"), "{ non è json");
		expect(s.store.read().broken).toBe(true);
		expect(await s.run({ op: "add_item", item: "Viti" })).toBe(`Errore: ${STOCK_BROKEN}.`);
		expect(await s.run({ op: "list" })).toBe(`Errore: ${STOCK_BROKEN}.`);
		expect(readFileSync(join(s.dir, "stock.json"), "utf8")).toBe("{ non è json");
		// A movement edited by hand into a shape it cannot have: unreadable too.
		const t = setup();
		await t.run({ op: "add_item", item: "Viti" });
		await t.run({ op: "receive", item: "viti", quantity: 10, cost: 1 });
		const raw = JSON.parse(readFileSync(join(t.dir, "stock.json"), "utf8"));
		raw.moves[0].qty = "-10";
		writeFileSync(join(t.dir, "stock.json"), JSON.stringify(raw));
		expect(t.store.read().broken).toBe(true);
		expect(existsSync(join(t.dir, "stock.json.bak"))).toBe(true);
	});

	it("gives another agente names and quantities only: no cost, value, supplier, movement or change", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL", min: 10 });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 5, cost: 12, supplier: "Beta Forniture Srl" });
		const list = await s.run({ op: "list" }, agent());
		expect(inside(list)).toContain("Cartucce XL (MG-0001): 5 pezzi, minimo 10 pezzi (sottoscorta)");
		expect(list).not.toContain("€");
		expect(list).not.toContain("Beta");
		const low = await s.run({ op: "low" }, agent());
		expect(inside(low)).toContain("Cartucce XL");
		expect(low).not.toContain("€");
		for (const op of ["status", "value", "movements", "export", "receive", "unload", "add_item", "count", "remove_item"]) expect(await s.run({ op, item: "cartucce xl" }, agent())).toMatch(/^Errore: a un altro agente/);
		expect(await s.run({ op: "low", compact: true }, agent())).toMatch(/^Errore: a un altro agente/);
		expect(stockAgentReads({ op: "list" })).toBe(true);
		expect(stockAgentReads({ op: "status" })).toBe(false);
	});

	it("audits the op and the count only, never names, quantities, costs or suppliers", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12, supplier: "Beta Forniture Srl", doc: "DDT 7" });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 2, reason: "scarto", note: "rotte" });
		await s.run({ op: "export" });
		expect(s.events).toEqual([
			{ type: "stock.changed", op: "add_item", count: 1 },
			{ type: "stock.changed", op: "receive", count: 1 },
			{ type: "stock.changed", op: "unload", count: 1 },
			{ type: "stock.changed", op: "export", count: 1 },
		]);
		const all = JSON.stringify(s.events);
		for (const word of ["Cartucce", "Beta", "50", "12", "DDT", "rotte"]) expect(all).not.toContain(word);
	});

	it("runs only its reads in a brief's thread; the instructions route prices to the listino and quantities here", async () => {
		const s = setup();
		const store = new StockStore(s.dir);
		const [tool] = createStockTools({ workspace: new Workspace(s.root), store, timeZone: "Europe/Rome", whoIs: () => "test:u", now: () => NOW });
		if (tool === undefined) throw new Error("no tool");
		const [guarded] = readOnlyInBriefs([tool], async () => true);
		expect(await guarded?.execute({ op: "add_item", item: "Viti" }, fresh())).toContain("nella chat del brief del mattino Owni legge soltanto");
		expect(await guarded?.execute({ op: "list" }, fresh())).toContain("Il magazzino è vuoto");
		expect(tool.description).toContain("price_list is the prices, stock the quantities.");
		expect(tool.description).toContain("an adjustment, the history stays as it was");
	});
});

describe("week 69 review", () => {
	const draftOf = async (s: ReturnType<typeof setup>, lines: unknown[]) => {
		const answer = await s.sell({ op: "draft", ...DELTA, lines });
		const id = s.sales.read().invoices.at(-1)?.id as string;
		return { answer, id };
	};
	const issuedNumber = (s: ReturnType<typeof setup>, id: string) => {
		const inv = s.sales.read().invoices.find((i) => i.id === id);
		if (inv === undefined || !isIssued(inv)) throw new Error("not issued");
		return inv.number;
	};

	it("1: finds an article from other words of its name, with its endings off, and says which it took", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "add_item", item: "Rotolo carta", unit: "rotoli" });
		await s.run({ op: "receive", item: "Cartucce XL", quantity: 10, cost: 12 });
		for (const said of ["cartuccia xl", "cartucce"]) {
			const status = await s.run({ op: "status", item: said });
			expect(status).toContain("MG-0001: 10 pezzi in magazzino");
			// Said outside the fence (so the model says it), the name inside.
			expect(status).toContain("Ho preso l'articolo MG-0001 (nel riquadro): dillo a chi ti scrive.");
			expect(inside(status)).not.toContain("Ho preso");
		}
		// A change on other words is asked, confirmed by the number.
		const asked = await s.run({ op: "receive", item: "rotoli di carta", quantity: 4, cost: 2 });
		expect(asked).toContain("Intendi questo articolo?");
		expect(inside(asked)).toContain("Rotolo carta (MG-0002)");
		expect(s.store.read().moves).toHaveLength(1);
		expect(await s.run({ op: "receive", item: "MG-0002", quantity: 4, cost: 2 })).toContain("Fatto, ho caricato 4 rotoli");
		// Two that hold the words: asked, never picked.
		await s.run({ op: "add_item", item: "Cartucce S" });
		expect(await s.run({ op: "status", item: "cartucce" })).toContain("Più articoli vanno bene con queste parole");
	});

	it("2: the first carico adds the article, from the voce of the listino of the same name; a close match is asked", async () => {
		const s = setup();
		const first = await s.run({ op: "receive", item: "Cartucce XL", quantity: 50, cost: 12, min: 10 });
		expect(first).toContain("Fatto: ho aggiunto l'articolo (MG-0001, nel riquadro) al magazzino, a pezzi (è la voce LS-0001 del listino), con l'avviso sotto i 10, e caricato 50 pezzi a 12,00 € per unità, senza IVA. Ora 50 pezzi");
		expect(first).toContain("valore 600,00 €");
		expect(s.store.read().items[0]).toMatchObject({ name: "Cartucce XL", unit: "pezzo", listino: "LS-0001", min: "10" });
		const tape = await s.run({ op: "receive", item: "Nastro adesivo", quantity: 6, cost: "1,5", unit: "rotoli" });
		expect(tape).toContain("al magazzino, a rotoli, e caricato 6 rotoli");
		expect(s.store.read().items[1]).toMatchObject({ unit: "rotolo" });
		expect(s.store.read().items[1]?.listino).toBeUndefined();
		// Run again: one article, one carico.
		const c = fresh("first-carico");
		await s.run({ op: "receive", item: "Graffette", quantity: 1, cost: 1 }, c);
		await s.run({ op: "receive", item: "Graffette", quantity: 1, cost: 1 }, c);
		expect(s.store.read().items.filter((i) => i.name === "Graffette")).toHaveLength(1);
		await s.run({ op: "add_item", item: "Cartucce S" });
		const moves = s.store.read().moves.length;
		expect(await s.run({ op: "receive", item: "cartucce", quantity: 1, cost: 1 })).toContain("Più articoli vanno bene");
		expect(s.store.read().moves).toHaveLength(moves);
	});

	it("3: packs turn into units exactly, the cost per pack is divided (rounded half up and said), and an invoice in packs unloads them", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		const boxes = await s.run({ op: "receive", item: "cartucce xl", quantity: 3, unit: "scatole", per_pack: 12, pack_cost: 30 });
		expect(boxes).toContain("Fatto, ho caricato 3 scatole da 12 = 36 pezzi a 2,50 € per unità, senza IVA.");
		expect(boxes).toContain("Il costo: 30,00 € per scatola da 12: 2,50 € per pezzo.");
		expect(s.onHand().onHand).toBe(36_000n);
		expect(s.onHand().average).toBe(25_000n);
		const odd = await s.run({ op: "receive", item: "cartucce xl", quantity: 1, unit: "scatole", per_pack: 12, pack_cost: 10 });
		expect(odd).toContain("0,8333 € per pezzo (arrotondato al centesimo di centesimo)");
		expect(await s.run({ op: "receive", item: "cartucce xl", quantity: 1, pack_cost: 10 })).toContain("dimmi quanti ne contiene ogni confezione");
		expect(await s.run({ op: "receive", item: "cartucce xl", quantity: "0,5", per_pack: "0,001", cost: 1 })).toMatch(/^Errore: 0,5 per 0,001 non viene/);
		// The article's own pack: an invoice line in scatole unloads twelve each.
		await s.run({ op: "add_item", item: "LS-0001", pack_unit: "scatola", per_pack: 12 });
		const before = s.onHand().onHand;
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 2, unit: "scatole" }]);
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(inside(issued)).toContain("−24 pezzi");
		expect(s.onHand().onHand).toBe(before - 24_000n);
	});

	it("4: a quantity in another unit is checked against the article's: turned by its pack, else asked", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12 });
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 3, unit: "confezioni", reason: "uso_interno" })).toContain("Questo articolo si conta a pezzi: 3 confezioni quanti pezzi sono?");
		expect(await s.run({ op: "receive", item: "cartucce xl", quantity: 3, unit: "confezioni", cost: 1 })).toContain("Questo articolo si conta a pezzi: 3 confezioni quanti pezzi sono?");
		expect(s.onHand().onHand).toBe(50_000n);
		await s.run({ op: "add_item", item: "cartucce xl", pack_unit: "confezione", per_pack: 10 });
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 3, unit: "confezioni", reason: "uso_interno" })).toContain("ho scaricato 3 confezioni da 10 = 30 pezzi");
		expect(s.onHand().onHand).toBe(20_000n);
		// The article's own unit said is no question.
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 2, unit: "pezzi", reason: "scarto" })).toContain("ho scaricato 2 pezzi");
	});

	it("5: a full magazzino says so apart, an issue left to complete says why; closing a year keeps on hand, averages and the credit notes' caps", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 50, cost: 12 });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 6 });
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 5 }]);
		await s.sell({ op: "issue", draft: id, confirm: true });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 70, reason: "scarto", confirm: true });
		const before = s.onHand();
		expect(before.negative).toBe(true);
		// A new year: 2026 closed.
		s.clock.now = new Date("2027-01-10T09:00:00Z");
		const asked = await s.run({ op: "close_year", year: 2026 });
		expect(asked).toContain("Chiudendo il 2026 riassumo 4 movimenti fino al 31/12/2026 in una riga di apertura");
		expect(await s.run({ op: "close_year", year: 2026, confirm: true }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		expect(s.store.read().moves).toHaveLength(4);
		expect(await s.run({ op: "close_year", year: 2026, confirm: true })).toContain("Fatto, ho chiuso il 2026: 4 movimenti fino al 31/12/2026 sono diventati una riga di apertura.");
		const after = s.onHand();
		expect(s.store.read().moves.map((m) => m.kind)).toEqual(["apertura"]);
		expect([after.onHand, after.average, after.value, after.negative, after.negativeSince]).toEqual([before.onHand, before.average, before.value, before.negative, before.negativeSince]);
		// The vendita's recorded cost stays with its key (week 71: the margins read it).
		expect(s.store.read().archived).toEqual([{ k: `${id}#1`, i: "MG-0001", q: "5", y: 2026, c: expect.stringMatching(/^\d+(?:\.\d{1,4})?$/) }]);
		expect(s.store.read().broken).toBe(false);
		// The invoice issued again moves nothing; its credit note puts back at most the 5 it took out.
		await s.sell({ op: "issue", draft: id, confirm: true });
		expect(s.onHand().onHand).toBe(before.onHand);
		await s.sell({ op: "credit_note", invoice: issuedNumber(s, id), lines: [{ description: "Cartucce XL", quantity: 9, price: 1, vat: 22, item: "LS-0001" }] });
		const creditId = s.sales.read().invoices.at(-1)?.id as string;
		expect(inside(await s.sell({ op: "issue", draft: creditId, confirm: true }))).toContain("+5 pezzi");
		expect(s.onHand().onHand).toBe(before.onHand + 5_000n);
		expect(s.onHand().average).toBe(before.average);
	});

	it("5: a magazzino full of movements: «pieno» on a change, and an issue that cannot move it stays to complete and says why", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		const raw = JSON.parse(readFileSync(join(s.dir, "stock.json"), "utf8"));
		raw.moves = Array.from({ length: 20_000 }, (_, n) => ({ id: `MV-${String(n + 1).padStart(6, "0")}`, item: "MG-0001", kind: "carico", qty: "1", day: "2026-01-02", cost: "1", by: "test:u", at: NOW.toISOString() }));
		raw.nextMove = 20_001;
		writeFileSync(join(s.dir, "stock.json"), JSON.stringify(raw));
		expect(s.store.read().broken).toBe(false);
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 1, reason: "scarto" })).toBe(`Errore: ${STOCK_FULL}.`);
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 5 }]);
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(issued).toContain("il magazzino è pieno di movimenti, quindi le righe con voci del listino non sono scaricate dal magazzino");
		expect(issued).toContain("non è completa");
		// A closed year makes room; the issue completes, once.
		s.clock.now = new Date("2026-10-20T09:00:00Z");
		expect(await s.run({ op: "close_year", year: 2026, confirm: true })).toContain("20000 movimenti");
		expect(await s.sell({ op: "issue", draft: id, confirm: true })).toContain("Ho scaricato dal magazzino una riga venduta");
		expect(s.onHand().onHand).toBe(19_995_000n);
	});

	it("6: the issue's question shows what the magazzino will do, and warns of going under zero; a voce that does not match its line is asked at the draft", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 37, cost: 12 });
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 40 }]);
		const asked = await s.sell({ op: "issue", draft: id });
		expect(inside(asked)).toContain("Scarica dal magazzino: Cartucce XL −40 pezzi");
		expect(asked).toContain("In magazzino ci sono 37 pezzi di MG-0001: questa fattura ne scarica 40, quindi andrebbe a −3.");
		expect(s.onHand().onHand).toBe(37_000n);
		const odd = await draftOf(s, [{ item: "Cartucce XL", description: "Servizio di assistenza", quantity: 1 }]);
		expect(odd.answer).toContain("una descrizione diversa dalla voce del listino");
		expect(inside(odd.answer)).toContain("la riga «Servizio di assistenza» è legata alla voce Cartucce XL (LS-0001) del listino");
	});

	it("7: a scarico that goes under zero meanwhile is refused under the lock, unless the person said yes in a turn of theirs", async () => {
		// Another scarico lands between the check and the write.
		const racing = (store: StockStore): StockStore => {
			let raced = false;
			const proxy = Object.create(store) as StockStore;
			proxy.update = (callId, change) => {
				if (!raced) {
					raced = true;
					store.update("race", (st) => ({ ...st, nextMove: st.nextMove + 1, moves: [...st.moves, { id: `MV-${String(st.nextMove).padStart(6, "0")}`, item: "MG-0001", kind: "scarico", qty: "4", day: "2026-10-19", reason: "scarto", by: "test:u", at: NOW.toISOString() }] }));
				}
				return store.update(callId, change);
			};
			return proxy;
		};
		const s = setup({ stockStore: racing });
		await s.store.update("seed-item", (st) => ({ ...st, nextItem: 2, items: [{ id: "MG-0001", name: "Cartucce XL", unit: "pezzo", by: "test:u", at: NOW.toISOString() }], nextMove: 2, moves: [{ id: "MV-000001", item: "MG-0001", kind: "carico", qty: "5", day: "2026-10-19", cost: "12", by: "test:u", at: NOW.toISOString() }] }));
		expect(await s.run({ op: "unload", item: "cartucce xl", quantity: 3, reason: "scarto", confirm: true }, fresh(undefined, "scheduled"))).toContain("nel frattempo la quantità è cambiata");
		expect(s.onHand().onHand).toBe(1_000n);
	});

	it("8: a carico needs the person; the last carico's cost is corrected as if it had always had it", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		expect(await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 12 }, fresh(undefined, "notice"))).toContain("serve il sì di chi ti scrive");
		expect(s.store.read().moves).toHaveLength(0);
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 12 });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 10, cost: 8 });
		await s.run({ op: "unload", item: "cartucce xl", quantity: 5, reason: "scarto" });
		expect(s.onHand().average).toBe(100_000n);
		expect(await s.run({ op: "fix_cost", item: "cartucce xl", cost: 6 }, fresh(undefined, "scheduled"))).toContain("serve il sì di chi ti scrive");
		const fixed = await s.run({ op: "fix_cost", item: "cartucce xl", cost: 6 });
		expect(fixed).toContain("Fatto, ho corretto il costo dell'ultimo carico (10 pezzi 19/10/2026): 6,00 € per unità invece di 8,00 €. Ora il costo medio è 9,00 €, valore 135,00 €.");
		// The carico itself is untouched: a costo movement records the correction.
		expect(s.store.read().moves.find((m) => m.kind === "carico" && m.cost === "8")).toBeDefined();
		expect(s.store.read().moves.at(-1)).toMatchObject({ kind: "costo", cost: "6", was: "8" });
		expect(await s.run({ op: "fix_cost", item: "cartucce xl", cost: 6 })).toContain("era già a 6,00 €");
	});

	it("9: on hand is capped, with its own words; a count spans the whole range", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Viti" });
		await s.run({ op: "receive", item: "viti", quantity: 999_999_999, cost: "0,01" });
		expect(await s.run({ op: "receive", item: "viti", quantity: 2, cost: "0,01" })).toContain("ne risulterebbero più di 1.000.000.000, il massimo che tengo per un articolo");
		await s.run({ op: "add_item", item: "Bulloni" });
		await s.run({ op: "unload", item: "bulloni", quantity: 1_000_000_000, reason: "scarto", confirm: true });
		expect(await s.run({ op: "count", item: "bulloni", quantity: 1_000_000_000 })).toContain("ce ne sono 2.000.000.000 in più");
		expect(s.onHand("MG-0002").onHand).toBe(1_000_000_000_000n);
		expect(s.store.read().broken).toBe(false);
	});

	it("10: a dictated line with an article's name gets its voce; one like an article that is no voce is said at the issue", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 20, cost: 12 });
		await s.run({ op: "add_item", item: "Rotolo carta", unit: "rotoli" });
		const { answer, id } = await draftOf(s, [{ description: "Cartucce XL", quantity: 3, price: 25, vat: 22 }, { description: "Rotolo carta", quantity: 2, price: 4, vat: 22 }]);
		expect(answer).toContain("Ho legato la riga nel riquadro alla voce del listino che è un articolo del magazzino");
		expect(s.sales.read().invoices.at(-1)?.lines.map((l) => l.item)).toEqual(["LS-0001", undefined]);
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(issued).toContain("La riga nel riquadro sembra un articolo del magazzino, ma non è legata a una voce del listino: non l'ho scaricata. Dimmi se va scaricata.");
		expect(s.onHand().onHand).toBe(17_000n);
		expect(s.onHand("MG-0002").onHand).toBe(0n);
	});

	it("11: the words: plural units, «per quello», skipped lines, no movement numbers outside the list", async () => {
		const s = setup();
		expect(await s.run({ op: "add_item", item: "Nastro", unit: "rotoli", min: 3 })).toContain("Fatto, ho aggiunto l'articolo (MG-0001): si conta a rotoli, ti avviso sotto i 3.");
		await s.run({ op: "add_item", item: "Colla" });
		await s.run({ op: "receive", item: "nastro", quantity: 5, cost: 2 });
		expect(await s.run({ op: "low" })).toContain("Un articolo non ha un minimo: per quello non so dire quando avvisarti.");
		const asked = await s.run({ op: "unload", item: "nastro", quantity: 9, reason: "scarto" });
		expect(asked).toContain("Di questo articolo (nel riquadro) ne risultano 5 rotoli: togliendone 9 il magazzino andrebbe a −4.");
		const list = await s.run({ op: "movements" });
		expect(list).toContain("MV-000001");
		for (const op of ["status", "unload"]) expect(await s.run({ op, item: "nastro", quantity: 1, reason: "scarto" })).not.toMatch(/MV-\d/);
		const t = setup();
		await t.run({ op: "add_item", item: "LS-0001" });
		await t.run({ op: "receive", item: "cartucce xl", quantity: 5, cost: 1 });
		const { id } = await draftOf(t, [{ item: "Cartucce XL", quantity: 2, unit: "scatole" }]);
		expect(await t.sell({ op: "issue", draft: id, confirm: true })).toContain("Se va scaricata, dimmi quante unità sono e le scarico io.");
	});

	it("12: the description says a move only changes the place; 13: an article in negativo without a minimum is said in the brief once per episode", async () => {
		const s = setup();
		expect(s.tool.description).toContain("stock split across two places is not kept");
		expect(s.tool.description).toContain("never take the VAT out yourself");
		await s.run({ op: "add_item", item: "Colla" });
		await s.run({ op: "receive", item: "colla", quantity: 2, cost: 1 });
		await s.run({ op: "unload", item: "colla", quantity: 3, reason: "scarto", confirm: true });
		const first = await s.run({ op: "low", compact: true });
		expect(first).toContain("Magazzino: un articolo è in negativo, va ricontato.");
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		await s.run({ op: "unload", item: "colla", quantity: 1, reason: "scarto", confirm: true });
		expect(await s.run({ op: "low", compact: true })).toContain("Niente da segnalare");
		// A count ends the episode; a new one is said again.
		await s.run({ op: "count", item: "colla", quantity: 0 });
		await s.run({ op: "unload", item: "colla", quantity: 1, reason: "scarto", confirm: true });
		expect(await s.run({ op: "low", compact: true })).toContain("in negativo, va ricontato");
	});
});

describe("week 69 last round", () => {
	const draftOf = async (s: ReturnType<typeof setup>, lines: unknown[]) => {
		const answer = await s.sell({ op: "draft", ...DELTA, lines });
		const id = s.sales.read().invoices.at(-1)?.id as string;
		return { answer, id };
	};
	// Singular and plural of the same gender are one word; another gender never is.
	const PAIRS: readonly (readonly [string, string, boolean])[] = [
		["cartuccia", "cartucce", true],
		["busta", "buste", true],
		["barca", "barche", true],
		["rotolo", "rotoli", true],
		["foglio", "fogli", true],
		["pacco", "pacchi", true],
		["cartone", "cartoni", true],
		["colla", "collo", false],
		["colla", "colli", false],
		["cera", "ceri", false],
		["cera", "cero", false],
		["foglia", "foglio", false],
		["foglia", "fogli", false],
		["panna", "panno", false],
		["panna", "panni", false],
		["problema", "problemi", false],
		["xl", "xl", true],
	];
	it.each(PAIRS)("N1: «%s» and «%s» the same word: %s", (a, b, same) => {
		expect(sameWord(a, b)).toBe(same);
		expect(sameWord(b, a)).toBe(same);
	});

	it("N1: names in either number, never another article's", () => {
		expect(stemsWithin("cartuccia xl", "Cartucce XL")).toBe(true);
		expect(stemsWithin("rotoli di carta", "Rotolo carta")).toBe(true);
		for (const [said, name] of [["colla", "Collo"], ["cera", "Ceri"], ["foglia", "Foglio A4"], ["panna", "Panno"]]) expect(stemsWithin(said as string, name as string)).toBe(false);
	});

	it("N1: «colla», «cera», «foglia», «panna» never move Collo, Ceri, Foglio A4, Panno", async () => {
		const s = setup();
		for (const name of ["Collo", "Ceri", "Foglio A4", "Panno"]) await s.run({ op: "add_item", item: name });
		await s.run({ op: "receive", item: "MG-0004", quantity: 1, cost: 1 });
		const before = s.store.read().moves.length;
		// A carico of a name that is none of them adds its own article.
		await s.run({ op: "receive", item: "colla", quantity: 2, cost: 3 });
		await s.run({ op: "receive", item: "cera", quantity: 2, cost: 3 });
		await s.run({ op: "receive", item: "foglia", quantity: 2, cost: 3 });
		expect(s.store.read().items.map((i) => i.name)).toEqual(["Collo", "Ceri", "Foglio A4", "Panno", "colla", "cera", "foglia"]);
		for (const id of ["MG-0001", "MG-0002", "MG-0003"]) expect(s.onHand(id).onHand).toBe(0n);
		expect(await s.run({ op: "unload", item: "panna", quantity: 1, reason: "scarto" })).toContain("Non trovo questo articolo in magazzino");
		expect(await s.run({ op: "count", item: "panna", quantity: 0 })).toContain("Non trovo questo articolo in magazzino");
		expect(s.onHand("MG-0004").onHand).toBe(1000n);
		expect(s.store.read().moves).toHaveLength(before + 3);
	});

	it("N1: a change on a name that is not the article's own asks «Intendi questo articolo?»; a read takes it and says so outside the fence", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Cartucce XL" });
		await s.run({ op: "receive", item: "Cartucce XL", quantity: 10, cost: 12 });
		const moves = s.store.read().moves.length;
		const writes: Record<string, unknown>[] = [
			{ op: "receive", item: "cartuccia xl", quantity: 1, cost: 12 },
			{ op: "unload", item: "cartuccia xl", quantity: 1, reason: "scarto" },
			{ op: "count", item: "cartucce", quantity: 3 },
			{ op: "fix_cost", item: "cartucce", cost: 11 },
			{ op: "remove_item", item: "cartucce" },
		];
		for (const args of writes) {
			const asked = await s.run(args);
			expect(asked).toContain("Intendi questo articolo?");
			expect(inside(asked)).toContain("Cartucce XL (MG-0001)");
			expect(outside(asked)).not.toContain("Cartucce XL");
		}
		expect(s.store.read().moves).toHaveLength(moves);
		expect(s.store.read().items[0]?.removed).toBeUndefined();
		// Confirmed by its number.
		expect(await s.run({ op: "unload", item: "MG-0001", quantity: 1, reason: "scarto" })).toContain("Fatto, ho scaricato 1 pezzo");
		for (const op of ["status", "movements"]) {
			const read = await s.run({ op, item: "cartuccia xl" });
			expect(outside(read)).toContain("Ho preso l'articolo MG-0001 (nel riquadro): dillo a chi ti scrive.");
			expect(inside(read)).toContain("Cartucce XL");
		}
	});

	it("N1: the draft links a line only by the article's own name; one only like it is asked, not linked", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		await s.run({ op: "receive", item: "cartucce xl", quantity: 20, cost: 12 });
		const { answer } = await draftOf(s, [{ description: "Cartuccia XL", quantity: 3, price: 25, vat: 22 }]);
		expect(answer).toContain("Una riga sembra un articolo del magazzino, ma il nome non è proprio quello: non l'ho legata alla voce");
		expect(inside(answer)).toContain("la riga «Cartuccia XL» sembra l'articolo Cartucce XL (voce LS-0001)");
		expect(s.sales.read().invoices.at(-1)?.lines[0]?.item).toBeUndefined();
		const exact = await draftOf(s, [{ description: "cartucce  xl", quantity: 3, price: 25, vat: 22 }]);
		expect(exact.answer).toContain("Ho legato la riga nel riquadro");
		expect(s.sales.read().invoices.at(-1)?.lines[0]?.item).toBe("LS-0001");
	});

	it("L1/L2: an unreadable magazzino speaks of the lines with a voce; a refused write is said apart from unreadable and full", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: 1 }]);
		writeFileSync(join(s.dir, "stock.json"), "{");
		const asked = await s.sell({ op: "issue", draft: id });
		expect(asked).toContain("il magazzino non si legge, quindi le righe con voci del listino di questa fattura non potranno essere scaricate dal magazzino");
		expect(asked).not.toContain("articoli venduti");
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(issued).toContain("il magazzino non si legge, quindi le righe con voci del listino non sono scaricate dal magazzino");
		const t = setup({ salesStock: (store) => ({ read: () => store.read(), sale: () => { throw new StockError("il magazzino non è valido: non l'ho salvato"); } }) });
		await t.run({ op: "add_item", item: "LS-0001" });
		const other = await draftOf(t, [{ item: "Cartucce XL", quantity: 1 }]);
		const refused = await t.sell({ op: "issue", draft: other.id, confirm: true });
		expect(refused).toContain("il magazzino non ha accettato questi movimenti (il file ne uscirebbe non valido), quindi le righe con voci del listino non sono scaricate dal magazzino");
		expect(refused).not.toContain("non si legge");
		expect(refused).toContain("non è completa");
	});

	it("L3: a line in packs that is no exact number of units is skipped with its own reason", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001", pack_unit: "scatola", per_pack: "0,333" });
		await s.run({ op: "receive", item: "MG-0001", quantity: 10, cost: 1 });
		const { id } = await draftOf(s, [{ item: "Cartucce XL", quantity: "1,5", unit: "scatole" }]);
		const issued = await s.sell({ op: "issue", draft: id, confirm: true });
		expect(issued).toContain("in confezioni, ma le confezioni per quanto ne contiene ognuna non danno un numero preciso di unità");
		expect(issued).not.toContain("l'unità della riga non è quella");
		expect(s.onHand().onHand).toBe(10_000n);
	});

	it("L4: closing a year drops the sale keys of invoices ten years or more before it, and keeps the others", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "LS-0001" });
		await s.run({ op: "receive", item: "MG-0001", quantity: 5, cost: 1 });
		const raw = JSON.parse(readFileSync(join(s.dir, "stock.json"), "utf8"));
		raw.archived = [
			{ k: "BZ-0900#1", i: "MG-0001", q: "1", y: 2015 },
			{ k: "BZ-0901#1", i: "MG-0001", q: "1", y: 2016 },
			{ k: "BZ-0902#1", i: "MG-0001", q: "1", y: 2017 },
			{ k: "BZ-0903#1", i: "MG-0001", q: "1" },
		];
		writeFileSync(join(s.dir, "stock.json"), JSON.stringify(raw));
		s.clock.now = new Date("2027-01-10T09:00:00Z");
		expect(await s.run({ op: "close_year", year: 2026, confirm: true })).toContain("Fatto, ho chiuso il 2026");
		expect(s.store.read().archived.map((a) => a.k)).toEqual(["BZ-0902#1", "BZ-0903#1"]);
	});

	it("L5: a year whose article is too far in negativo for an opening line asks for a count first", async () => {
		const s = setup();
		await s.run({ op: "add_item", item: "Colla" });
		const max = STOCK_LIMITS.maxQuantity;
		await s.run({ op: "unload", item: "MG-0001", quantity: max, reason: "scarto", confirm: true });
		await s.run({ op: "unload", item: "MG-0001", quantity: 1, reason: "scarto", confirm: true });
		const moves = s.store.read().moves.length;
		s.clock.now = new Date("2027-01-10T09:00:00Z");
		for (const confirm of [false, true]) {
			const answer = await s.run({ op: "close_year", year: 2026, confirm });
			expect(answer).toContain("l'articolo MG-0001 a quella data risulta a -1000000001, troppo in negativo per una riga di apertura: prima chi ti scrive faccia un conteggio di quell'articolo, poi chiudi l'anno");
		}
		expect(s.store.read().moves).toHaveLength(moves);
	});
});
