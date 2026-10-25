/** The appointments tests' fixture: synthetic data only (checksum-valid fake partite IVA, invented names, example.invalid contacts). */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import type { AppointmentSettings } from "../src/core/appointments.ts";
import { AppointmentStore } from "../src/core/appointment-store.ts";
import type { ClientCard } from "../src/core/clients.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { InvoiceScanner } from "../src/core/invoice-scan.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { documentFattura } from "../src/core/documents.ts";
import type { Company } from "../src/core/invoices.ts";
import type { MakeInput } from "../src/core/make-document.ts";
import type { PriceItem } from "../src/core/price-list.ts";
import { SalesInvoiceStore } from "../src/core/sales-invoice-store.ts";
import { TaxStore } from "../src/core/tax-store.ts";
import { type AppointmentEvent, createAppointmentTools } from "../src/core/tools/appointment-tools.ts";
import { createSalesInvoiceTools, type SalesEvent } from "../src/core/tools/sales-invoice-tools.ts";
import type { TurnOrigin } from "../src/core/turn-origin.ts";
import { Workspace } from "../src/core/workspace.ts";

// Monday 19 October 2026, 10:00 in Rome (CEST).
export const NOW = new Date("2026-10-19T08:00:00Z");
export const AT = NOW.toISOString();
export const MARK = { by: "test:u", at: AT };
export const COMPANY: Company = { vat: "IT00000010017", name: "Salone Prova Srl", cf: "00000010017", address: "Via Roma 1, 20121 Milano MI", regime: "ordinario", ibans: ["IT51X0000000000000000000001"], ...MARK };

export const ROSSI: ClientCard = { id: "CL-0001", name: "Maria Rossi", aliases: [], contacts: [{ email: "maria.rossi@example.invalid", phone: "+39 333 0000001" }], tags: [], notes: [], followUps: [], ...MARK };
export const BIANCHI: ClientCard = { id: "CL-0002", name: "Officina Bianchi Prova Srl", vat: "IT00000030015", aliases: ["Bianchi"], contacts: [{ phone: "02 0000002" }], address: "Via Verdi 2, 00184 Roma RM", tags: [], notes: [], followUps: [], ...MARK };

export const LISTINO: PriceItem[] = [
	{ id: "LS-0001", name: "Taglio", unit: "servizio", price: "25", vat: 22, ...MARK },
	{ id: "LS-0002", name: "Piega", unit: "servizio", price: "15", vat: 22, ...MARK },
];

export const SETTINGS: AppointmentSettings = {
	business: "Salone Prova",
	week: {
		"1": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"2": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"3": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"4": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"5": [{ from: "09:00", to: "13:00" }, { from: "14:00", to: "19:00" }],
		"6": [{ from: "09:00", to: "13:00" }],
	},
	services: [
		{ name: "Taglio", item: "LS-0001", minutes: 30 },
		{ name: "Piega", item: "LS-0002", minutes: 30 },
		{ name: "Colore", minutes: 90 },
	],
	...MARK,
};

let calls = 0;
export const fresh = (callId = `a${++calls}`, origin: TurnOrigin = "person", thread = { channel: "test", threadId: "t1" }): ToolContext => ({ step: (_key, work) => work(), progress: () => {}, origin, signal: new AbortController().signal, callId, thread });
export const agent = () => fresh(undefined, "agent", { channel: AGENT_CHANNEL, threadId: "a1" });

export const FENCE = /<<<dati (?:degli appuntamenti|delle fatture emesse) ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati (?:degli appuntamenti|delle fatture emesse) \1>>>/g;
export const outside = (text: string) => text.replace(FENCE, "");
export const inside = (text: string) => [...text.matchAll(FENCE)].map((m) => m[2] as string).join("\n");
export const checkIn = (answer: string) => /il controllo ([0-9a-f]{16})/.exec(answer)?.[1] as string;
export const EMDASH = /\u2014/;

const dirs: string[] = [];
/** Only the directories the tests made, each by its exact path (afterEach). */
export function cleanup(): void {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function setup(o: { settings?: AppointmentSettings | null; calendar?: boolean; items?: PriceItem[] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "owni-appointments-"));
	dirs.push(dir);
	const root = join(dir, "workspace");
	mkdirSync(join(root, "fatture"), { recursive: true });
	const workspace = new Workspace(root);
	const store = new AppointmentStore(dir);
	if (o.settings !== null) store.update("seed", (state) => ({ ...state, settings: o.settings ?? SETTINGS }));
	const invoices = new InvoiceStore(dir);
	invoices.setCompany(COMPANY);
	const sales = new SalesInvoiceStore(dir);
	sales.update("seed", (state) => ({ ...state, settings: { ...MARK, lastBefore: { 2026: 0 } } }));
	const scanner = new InvoiceScanner(workspace, { read: async (_name, data) => documentFattura(data) });
	const clients = { read: () => ({ cards: [ROSSI, BIANCHI], nextCard: 3, nextFollowUp: 1, calls: [], broken: false }) };
	const priceList = { read: () => ({ items: o.items ?? LISTINO, broken: false }) as never };
	const events: (AppointmentEvent | SalesEvent)[] = [];
	const clock = { now: NOW };
	const make = async (input: MakeInput) => ({ data: new TextEncoder().encode(input.text), notes: [] });
	const [tool] = createAppointmentTools({ workspace, store, clients, priceList, timeZone: "Europe/Rome", ...(o.calendar === true ? { calendar: true } : {}), whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now });
	const [salesTool] = createSalesInvoiceTools({ workspace, store: sales, company: invoices, taxes: new TaxStore(dir), clients, priceList, appointments: store, scanner, timeZone: "Europe/Rome", whoIs: () => "test:u", record: async (e) => void events.push(e), now: () => clock.now, make });
	if (tool === undefined || salesTool === undefined) throw new Error("no tool");
	const run = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await tool.execute(args, c));
	const sell = async (args: Record<string, unknown>, c: ToolContext = fresh()) => String(await salesTool.execute(args, c));
	return { dir, root, store, sales, events, clock, tool, run, sell };
}

export type S = ReturnType<typeof setup>;
