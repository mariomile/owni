import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppointmentStore } from "./appointment-store.ts";
import { appointmentCallReads } from "./appointments.ts";
import type { ClientStore } from "./client-store.ts";
import { clientCallReads } from "./clients.ts";
import type { DdtStore } from "./ddt-store.ts";
import { ddtCallReads } from "./ddt.ts";
import type { OwniTool, ToolContext, ToolResult } from "./engine.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { businessKey, legalForm } from "./name-keys.ts";
import type { OrderStore } from "./order-store.ts";
import { orderCallReads } from "./orders.ts";
import type { QuoteStore } from "./quote-store.ts";
import { quoteCallReads } from "./quotes.ts";
import { recurringCallReads } from "./recurring-invoices.ts";
import type { SalesInvoiceStore } from "./sales-invoice-store.ts";
import { salesCallReads } from "./sales-invoices.ts";
import type { SupplierStore } from "./supplier-store.ts";
import { stockCallReads } from "./stock.ts";
import { supplierCallReads } from "./suppliers.ts";
import { timesheetCallReads } from "./timesheet.ts";
import { isAgentTurn } from "./turn-origin.ts";

/**
 * Il registro di chi segue cosa (ADR 0110): one per tenant, in `subjects.json`, next to the board.
 * The records stay in each agente's own registers; here only which agente has which record (its id
 * and kind), the scheda it is linked to, and when it was last touched. Two agenti handle the same
 * subject when their records are about the same client or supplier: the same partita IVA or codice
 * fiscale when both records have one, else the same name with no different legal form. Names and
 * numbers are kept only pseudonimizzati, with an HMAC under a key of the tenant kept with its
 * secrets: the file holds no name and no number of anybody (counts-only, ADR 0092).
 */
export const SUBJECT_REGISTERS = ["clients", "suppliers", "quotes", "orders", "appointments", "sales", "ddt"] as const;
export type SubjectRegister = (typeof SUBJECT_REGISTERS)[number];

/** How a record is said in a warning: «Vendite ha già preventivo 2026-004». */
export const SUBJECT_KIND: Readonly<Record<SubjectRegister, string>> = { clients: "cliente", suppliers: "fornitore", quotes: "preventivo", orders: "ordine", appointments: "appuntamento", sales: "fattura", ddt: "DDT" };

/**
 * A client or supplier as the ledger keeps it: its partita IVA and codice fiscale and its name
 * without legal form, pseudonimizzati, and the legal form as it is («srl», «spa»).
 */
export type Party = { readonly ids: readonly string[]; readonly name?: string; readonly form?: string };

/** A record as a register has it now: its id, its client or supplier, a fingerprint of its content. */
export type Subject = { readonly id: string; readonly party: Party; readonly f: string };

export type SubjectEntry = {
	readonly agent: string;
	readonly register: SubjectRegister;
	/** The record's id in the agente's register: «CL-0012», «OR-0003», «2026-004». */
	readonly id: string;
	readonly kind: string;
	readonly party: Party;
	readonly f: string;
	/** Last created or changed. */
	readonly at: string;
	/** The scheda the agente linked it to: a record is on one scheda at most. */
	readonly card?: { readonly id: string; readonly n: number };
};

type LedgerFile = {
	readonly entries: readonly SubjectEntry[];
	/** «agent/register» already read once: the first reading records without warning. */
	readonly synced: readonly string[];
};

const EMPTY: LedgerFile = { entries: [], synced: [] };

/** The tenant's secret the ledger's pseudonyms are made with. */
export const SUBJECTS_KEY_SECRET = "subjects.key";

/** The tenant's key for the ledger, made the first time. */
export async function subjectsKey(secrets: { get(name: string): Promise<string | undefined>; set(name: string, value: string): Promise<void> }): Promise<string> {
	const known = await secrets.get(SUBJECTS_KEY_SECRET);
	if (known !== undefined) return known;
	const fresh = randomBytes(32).toString("hex");
	await secrets.set(SUBJECTS_KEY_SECRET, fresh);
	return fresh;
}

/** Two records are about the same client or supplier: a shared number when both have one, else the same name and no different legal form. */
export function sameParty(a: Party, b: Party): boolean {
	if (a.ids.length > 0 && b.ids.length > 0) return a.ids.some((k) => b.ids.includes(k));
	return a.name !== undefined && a.name === b.name && (a.form === undefined || b.form === undefined || a.form === b.form);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The registers of one agente the ledger reads. */
export type SubjectStores = {
	readonly clients: Pick<ClientStore, "read">;
	readonly suppliers: Pick<SupplierStore, "read">;
	readonly quotes: Pick<QuoteStore, "read">;
	readonly orders: Pick<OrderStore, "read">;
	readonly appointments: Pick<AppointmentStore, "read">;
	readonly sales: Pick<SalesInvoiceStore, "read">;
	readonly ddt: Pick<DdtStore, "read">;
};

type PartyText = { readonly name?: string; readonly vat?: string; readonly cf?: string };

export class SubjectLedger {
	private readonly file: string;

	/** `key`: the tenant's secret for the pseudonyms (`subjectsKey`). */
	constructor(
		tenantDir: string,
		private readonly key: string,
	) {
		this.file = join(tenantDir, "subjects.json");
	}

	private pseudonym(text: string): string {
		return createHmac("sha256", this.key).update(text).digest("hex").slice(0, 32);
	}

	/** A client or supplier pseudonimizzato: partita IVA, codice fiscale, name without legal form, and the legal form. */
	party(of: PartyText): Party {
		const ids: string[] = [];
		const vat = of.vat?.replace(/\s+/g, "").toUpperCase();
		if (vat !== undefined && vat !== "") ids.push(`iva:${/^\d{11}$/.test(vat) ? `IT${vat}` : vat}`);
		const cf = of.cf?.replace(/\s+/g, "").toUpperCase();
		// A company's codice fiscale is its partita IVA.
		if (cf !== undefined && cf !== "") ids.push(/^\d{11}$/.test(cf) ? `iva:IT${cf}` : `cf:${cf}`);
		const name = of.name === undefined ? "" : businessKey(of.name);
		const form = of.name === undefined ? undefined : legalForm(of.name);
		return { ids: [...new Set(ids)].map((k) => this.pseudonym(k)), ...(name === "" ? {} : { name: this.pseudonym(`nome:${name}`) }), ...(form === undefined ? {} : { form }) };
	}

	subject(id: string, of: PartyText, record: unknown): Subject {
		return { id, party: this.party(of), f: this.pseudonym(JSON.stringify(record)) };
	}

	/** These registers' records as they are now; a register that does not read is left out, its entries kept. */
	read(stores: SubjectStores, registers: readonly SubjectRegister[] = SUBJECT_REGISTERS): Partial<Record<SubjectRegister, Subject[]>> {
		const out: Partial<Record<SubjectRegister, Subject[]>> = {};
		const want = new Set(registers);
		if (want.has("clients")) {
			const book = stores.clients.read();
			if (!book.broken) out.clients = book.cards.map((c) => this.subject(c.id, c, c));
		}
		if (want.has("suppliers")) {
			const book = stores.suppliers.read();
			if (!book.broken) out.suppliers = book.cards.map((c) => this.subject(c.id, c, c));
		}
		if (want.has("quotes")) {
			const book = stores.quotes.read();
			if (!book.broken) out.quotes = book.quotes.map((q) => this.subject(q.number, { name: q.customer.name, ...(q.customer.vat === undefined ? {} : { vat: q.customer.vat }), ...(q.customer.fiscal === undefined ? {} : { cf: q.customer.fiscal }) }, q));
		}
		if (want.has("orders")) {
			const book = stores.orders.read();
			if (!book.broken) out.orders = book.orders.map((o) => this.subject(o.id, o.supplier, o));
		}
		if (want.has("appointments")) {
			const book = stores.appointments.read();
			if (!book.broken) out.appointments = book.appointments.map((a) => this.subject(a.id, a.client, a));
		}
		if (want.has("sales")) {
			const book = stores.sales.read();
			if (!book.broken) out.sales = book.invoices.map((i) => this.subject(i.id, i.buyer, i));
		}
		if (want.has("ddt")) {
			const book = stores.ddt.read();
			if (!book.broken) out.ddt = book.ddts.map((d) => this.subject(d.id, d.client, d));
		}
		return out;
	}

	list(): SubjectEntry[] {
		return [...readJsonFile<LedgerFile>(this.file, EMPTY).entries];
	}

	/**
	 * The agente's records of these registers as they are now, in one write: new and changed ones are
	 * recorded with `now`, records gone (deleted) leave the ledger. Returns the news: records new or
	 * now about another client or supplier, none the first time a register is read (what was already
	 * there is not news). A record saved again about the same party is not news.
	 */
	sync(agent: string, registers: Partial<Record<SubjectRegister, readonly Subject[]>>, now = new Date()): SubjectEntry[] {
		const at = now.toISOString();
		const news: SubjectEntry[] = [];
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			let entries = book.entries;
			let synced = book.synced;
			let changed = false;
			for (const register of SUBJECT_REGISTERS) {
				const subjects = registers[register];
				if (subjects === undefined) continue;
				const tag = `${agent}/${register}`;
				const first = !synced.includes(tag);
				const mine = (e: SubjectEntry) => e.agent === agent && e.register === register;
				const old = new Map(entries.filter(mine).map((e) => [e.id, e]));
				let moved = first || old.size !== subjects.length;
				const next = subjects.map((s): SubjectEntry => {
					const was = old.get(s.id);
					if (was !== undefined && was.f === s.f && sameJson(was.party, s.party)) return was;
					moved = true;
					const entry: SubjectEntry = { agent, register, id: s.id, kind: SUBJECT_KIND[register], party: s.party, f: s.f, at, ...(was?.card === undefined ? {} : { card: was.card }) };
					if (!first && (was === undefined || !sameJson(was.party, s.party))) news.push(entry);
					return entry;
				});
				if (!moved) continue;
				changed = true;
				entries = [...entries.filter((e) => !mine(e)), ...next];
				if (first) synced = [...synced, tag];
			}
			return changed ? { entries, synced } : book;
		});
		return news;
	}

	/**
	 * The scheda linked to these records of the agente (by id), and no longer to its others: a record
	 * is on one scheda at most, so linking it here takes it off the scheda it was on. Returns the
	 * entries linked and the ids the agente has no record for.
	 */
	link(agent: string, card: { readonly id: string; readonly n: number }, ids: readonly string[]): { linked: SubjectEntry[]; missing: string[] } {
		const wanted = new Set(ids.map((id) => id.trim()).filter((id) => id !== ""));
		const linked: SubjectEntry[] = [];
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			let changed = false;
			const entries = book.entries.map((e) => {
				if (e.agent !== agent) return e;
				if (wanted.has(e.id)) {
					const next = { ...e, card: { id: card.id, n: card.n } };
					linked.push(next);
					if (e.card?.id === card.id && e.card.n === card.n) return e;
					changed = true;
					return next;
				}
				if (e.card?.id !== card.id) return e;
				changed = true;
				const { card: _c, ...rest } = e;
				return rest;
			});
			return changed ? { ...book, entries } : book;
		});
		return { linked, missing: [...wanted].filter((id) => !linked.some((e) => e.id === id)) };
	}

	/** A scheda deleted: no record is linked to it any more. */
	unlinkCard(cardId: string): void {
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			if (!book.entries.some((e) => e.card?.id === cardId)) return book;
			return {
				...book,
				entries: book.entries.map((e) => {
					if (e.card?.id !== cardId) return e;
					const { card: _c, ...rest } = e;
					return rest;
				}),
			};
		});
	}

	/** An agente deleted: its records leave the ledger. */
	forgetAgent(agent: string): void {
		updateJsonFile<LedgerFile>(this.file, EMPTY, (book) => {
			if (!book.entries.some((e) => e.agent === agent) && !book.synced.some((t) => t.startsWith(`${agent}/`))) return book;
			return { entries: book.entries.filter((e) => e.agent !== agent), synced: book.synced.filter((t) => !t.startsWith(`${agent}/`)) };
		});
	}

	/** The records of other agenti about the same client or supplier as these, the most recent first. */
	overlaps(of: readonly SubjectEntry[]): SubjectEntry[] {
		if (of.length === 0) return [];
		const agents = new Set(of.map((e) => e.agent));
		return this.list()
			.filter((e) => !agents.has(e.agent) && of.some((o) => sameParty(o.party, e.party)))
			.sort((a, b) => b.at.localeCompare(a.at));
	}
}

/** The most other agenti's records a warning names. */
const SHOWN = 5;

/** What a person who is not the owner is told: no agente, no record, no scheda. */
export const OVERLAP_GENERIC = "Attenzione, un altro agente segue già lo stesso cliente o fornitore. Dillo alla persona prima di andare avanti.";

/**
 * «Attenzione, lo segue anche un altro agente: Vendite ha già preventivo 2026-004 (scheda #12).»
 * Only agenti, kinds, record ids and scheda numbers: never a name or what a record holds. For the
 * owner only. `cardShown` says whether a linked scheda is still on the board. Empty when there is nothing.
 */
export function overlapText(overlaps: readonly SubjectEntry[], agentName: (id: string) => string, cardShown: (id: string) => boolean = () => true): string {
	if (overlaps.length === 0) return "";
	const lines = overlaps.slice(0, SHOWN).map((e) => `${agentName(e.agent)} ha già ${e.kind} ${e.id}${e.card !== undefined && cardShown(e.card.id) ? ` (scheda #${e.card.n})` : ""}`);
	const more = overlaps.length > SHOWN ? `, e altri ${overlaps.length - SHOWN}` : "";
	return `Attenzione, lo stesso cliente o fornitore lo segue anche un altro agente: ${lines.join("; ")}${more}. Dillo alla persona prima di andare avanti.`;
}

/**
 * The tools that write these registers, whether a call of theirs only reads, and the registers it
 * may write: the seven registers' own, the timesheet (it makes quotes), the fatture ricorrenti
 * (they make drafts) and the magazzino (an invoice loaded marks an order).
 */
export const SUBJECT_TOOLS: Readonly<Record<string, { readonly reads: (args: Record<string, unknown>) => boolean; readonly registers: readonly SubjectRegister[] }>> = {
	clients: { reads: clientCallReads, registers: ["clients"] },
	suppliers: { reads: supplierCallReads, registers: ["suppliers"] },
	quotes: { reads: quoteCallReads, registers: ["quotes"] },
	orders: { reads: orderCallReads, registers: ["orders"] },
	appointments: { reads: appointmentCallReads, registers: ["appointments"] },
	sales_invoices: { reads: salesCallReads, registers: ["sales", "quotes"] },
	ddt: { reads: ddtCallReads, registers: ["ddt"] },
	timesheet: { reads: timesheetCallReads, registers: ["quotes"] },
	recurring_invoices: { reads: recurringCallReads, registers: ["sales"] },
	stock: { reads: stockCallReads, registers: ["orders"] },
};

type Thread = ToolContext["thread"];

/** The agente's records read again after a write, its new ones with what other agenti have on the same subjects. */
export type SubjectSeam = {
	readonly ledger: SubjectLedger;
	readonly agent: string;
	readonly stores: SubjectStores;
	readonly agentName: (id: string) => Promise<string>;
	/** Whether the conversation is with the owner: only the owner is told which agenti and records. */
	readonly isOwner: (thread: Thread) => Promise<boolean>;
	readonly cardShown?: (id: string) => boolean;
};

/** Read the agente's registers (all of them, or these) into the ledger; the news. */
export function syncAgent(seam: Pick<SubjectSeam, "ledger" | "agent" | "stores">, registers: readonly SubjectRegister[] = SUBJECT_REGISTERS, now = new Date()): SubjectEntry[] {
	return seam.ledger.sync(seam.agent, seam.ledger.read(seam.stores, registers), now);
}

/** The warning for these entries of the agente, or "" when no other agente has the same subjects; the details only to the owner. */
export async function warningFor(seam: SubjectSeam, entries: readonly SubjectEntry[], thread: Thread): Promise<string> {
	const overlaps = seam.ledger.overlaps(entries);
	if (overlaps.length === 0) return "";
	if (!(await seam.isOwner(thread))) return OVERLAP_GENERIC;
	const names = new Map(await Promise.all([...new Set(overlaps.map((e) => e.agent))].map(async (id) => [id, await seam.agentName(id)] as const)));
	return overlapText(overlaps, (id) => names.get(id) ?? id, seam.cardShown);
}

const append = (result: ToolResult, text: string): ToolResult => (text === "" ? result : typeof result === "string" ? `${result}\n\n${text}` : { ...result, text: `${result.text}\n\n${text}` });

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The register tools of an agente with the ledger's write hook: after a call that may have written
 * (not a read, not another agente's request, which may not write), the registers that tool writes
 * are read into the ledger, and the result says when another agente already has the same client or
 * supplier. A ledger that fails never fails the call: the register wrote already.
 */
export function withSubjects(tools: readonly OwniTool[], seam: SubjectSeam, log: (message: string) => void = () => {}): OwniTool[] {
	// What the registers have already goes in now, without warning: from here on every write is news.
	try {
		syncAgent(seam);
	} catch (error) {
		log(`owni: subjects of ${seam.agent} not read: ${why(error)}`);
	}
	return tools.map((tool): OwniTool => {
		const hook = SUBJECT_TOOLS[tool.name];
		if (hook === undefined) return tool;
		return {
			...tool,
			async execute(args, ctx) {
				const result = await tool.execute(args, ctx);
				if (isAgentTurn(ctx) || hook.reads(args)) return result;
				try {
					return append(result, await warningFor(seam, syncAgent(seam, hook.registers), ctx.thread));
				} catch (error) {
					log(`owni: subjects of ${seam.agent} not recorded: ${why(error)}`);
					return result;
				}
			},
		};
	});
}

/** The records of an agente a scheda is about, as the board tools take them: by their ids. */
export type CardSubjects = {
	/** The ids the agente has no record for; none when the ledger cannot be read. */
	readonly missing: (ids: readonly string[]) => string[];
	/**
	 * The scheda linked to these records, and no longer to the agente's others; the warning when
	 * other agenti have the same subjects, or "". Undefined when the ledger failed and nothing was linked.
	 */
	readonly link: (card: { readonly id: string; readonly n: number }, ids: readonly string[], thread: Thread) => Promise<string | undefined>;
};

export function cardSubjects(seam: SubjectSeam, log: (message: string) => void = () => {}): CardSubjects {
	return {
		missing(ids) {
			try {
				syncAgent(seam);
				const have = new Set(seam.ledger.list().filter((e) => e.agent === seam.agent).map((e) => e.id));
				return ids.map((id) => id.trim()).filter((id) => id !== "" && !have.has(id));
			} catch (error) {
				log(`owni: subjects of ${seam.agent} not read: ${why(error)}`);
				return [];
			}
		},
		async link(card, ids, thread) {
			try {
				syncAgent(seam);
				return await warningFor(seam, seam.ledger.link(seam.agent, card, ids).linked, thread);
			} catch (error) {
				log(`owni: scheda #${card.n} not linked to the records of ${seam.agent}: ${why(error)}`);
				return undefined;
			}
		},
	};
}
