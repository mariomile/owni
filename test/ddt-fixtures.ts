/** The DDT tests' fixture: synthetic data only (checksum-valid fake partite IVA, invented names). */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { ClientCard } from "../src/core/clients.ts";
import type { Ddt } from "../src/core/ddt.ts";
import { DdtStore } from "../src/core/ddt-store.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import type { Company } from "../src/core/invoices.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import type { PriceItem } from "../src/core/price-list.ts";
import { SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import type { Movement, StockItem } from "../src/core/stock.ts";
import { StockStore } from "../src/core/stock-store.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { createDdtTools, type DdtEvent } from "../src/core/tools/ddt-tools.ts";
import { createSalesInvoiceTools, type SalesEvent } from "../src/core/tools/sales-invoice-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Synthetic data only: checksum-valid fake partite IVA, invented names.
export const NOW = new Date("2026-10-05T08:00:00Z");
export const AT = NOW.toISOString();
export const MARK = { by: "test:u", at: AT };
export const IBAN = "IT51X0000000000000000000001";
export const COMPANY: Company = { vat: "IT00000010017", name: "Bottega Prova Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: [IBAN], ...MARK };

export const ROSSI: ClientCard = { id: "CL-0001", name: "Rossi Prova Srl", vat: "IT00000020016", aliases: [], contacts: [], address: "Via Verdi 2, 00184 Roma RM", tags: [], notes: [], followUps: [], ...MARK };
export const VERDI: ClientCard = { id: "CL-0002", name: "Verdi Prova Spa", vat: "IT00000050013", aliases: [], contacts: [], address: "Via Neri 3, 10121 Torino TO", tags: [], notes: [], followUps: [], ...MARK };

export const LISTINO: PriceItem[] = [
	{ id: "LS-0001", name: "Carta A4", unit: "risma", price: "5", vat: 22, ...MARK },
	{ id: "LS-0002", name: "Toner XL", unit: "pezzo", price: "30", vat: 22, ...MARK },
];
export const ITEMS: StockItem[] = [
	{ id: "MG-0001", name: "Carta A4", unit: "risma", listino: "LS-0001", ...MARK },
	{ id: "MG-0002", name: "Toner XL", unit: "pezzo", listino: "LS-0002", ...MARK },
];

let calls = 0;
export const fresh = (callId = `d${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
export const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });
export const durable = (callId: string, memo: Map<string, unknown>): ToolContext => ({
	...fresh(callId),
	step: async (key, work) => {
		if (memo.has(key)) return memo.get(key) as never;
		const v = await work();
		memo.set(key, v);
		return v;
	},
});

export const FENCE = /<<<dati (?:dei DDT|del magazzino|delle fatture emesse|del listino) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:dei DDT|del magazzino|delle fatture emesse|del listino) \1>>>/g;
export const outside = (text: string) => text.replace(FENCE, "");
export const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
export const checkIn = (answer: string) => /il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;

export const EMDASH = /\u2014/;
const dirs: string[] = [];
/** Only the directories the tests made, each by its exact path (afterEach). */
export function cleanup(): void {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function setup(o: { askFirst?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "owni-ddt-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(join(root, "fatture"), { recursive: true });
	const workspace = new Workspace(root);
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const stock = new StockStore(dir);
	const moves: Movement[] = [
		{ id: "MV-000001", item: "MG-0001", kind: "carico", qty: "50", day: "2026-09-01", cost: "3.2", ...MARK },
		{ id: "MV-000002", item: "MG-0002", kind: "carico", qty: "10", day: "2026-09-01", cost: "18", ...MARK },
	];
	stock.update("seed", (st) => ({ ...st, nextItem: 3, nextMove: 3, items: ITEMS, moves }));
	const store = new DdtStore(dir);
	const sales = new SalesInvoiceStore(dir);
	sales.update("seed", (state) => ({ ...state, settings: { ...MARK, lastBefore: { 2026: 0 } } }));
	// The last DDT before Owni said already (none), unless the test is about asking it.
	if (!o.askFirst) store.update("seed", (state) => ({ ...state, settings: { ...MARK, lastBefore: { 2026: 0 } } }));
	const clients = { read: () => ({ cards: [ROSSI, VERDI], nextCard: 3, nextFollowUp: 1, calls: [], broken: false }) };
	const priceList = { read: () => ({ items: LISTINO, broken: false }) as never };
	const events: (DdtEvent | SalesEvent)[] = [];
	const clock = { now: NOW };
	const made: MakeInput[] = [];
	const make = async (input: MakeInput) => {
		made.push(input);
		return { data: new TextEncoder().encode(input.text), notes: [] };
	};
	const [tool] = createDdtTools({ workspace, store, sales, clients, priceList, stock, company: invoices, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	const [salesTool] = createSalesInvoiceTools({ workspace, store: sales, company: invoices, taxes: new TaxStore(dir), clients, priceList, stock, ddt: store, scanner, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	if (tool === undefined || salesTool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const sell = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await salesTool.execute(args, c));
	return { dir, root, stock, store, sales, events, clock, made, tool, run, sell };
}

export type S = ReturnType<typeof setup>;

export const PAPER_AND_TONER = [
	{ item: "Carta A4", quantity: 10 },
	{ item: "Toner XL", quantity: 2 },
];

/** A DDT made and issued for the client, on the clock's day: its number. */
export async function shipped(s: S, client = "Rossi Prova Srl", lines: unknown[] = PAPER_AND_TONER, more: Record<string, unknown> = {}): Promise<string> {
	const made = await s.run({ op: "create", client, lines, transport: "mittente", ...more });
	if (!made.includes("Fatto")) throw new Error(made);
	const draft = s.store.read().ddts.filter((d) => d.status === "draft").at(-1) as Ddt;
	const text = await s.run({ op: "issue", ddt: draft.id, confirm: true });
	expect(text).toContain("Fatto: ho emesso il DDT n.");
	return s.store.read().ddts.find((d) => d.id === draft.id)?.number as string;
}

export const onHand = (s: S, item: string) => s.stock.read().moves.filter((m) => m.item === item).reduce((n, m) => n + (m.kind === "carico" || m.kind === "storno" ? Number(m.qty) : m.kind === "scarico" ? -Number(m.qty) : 0), 0);
