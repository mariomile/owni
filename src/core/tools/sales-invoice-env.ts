/**
 * What the ops of sales_invoices share: the stores and seams they read and write, the audit event,
 * the one way to ask for what is missing (in three groups: about the person, the customer, this
 * invoice), the due date of an invoice, how a draft or an invoice is named (a draft id, or the
 * only draft; an invoice by its number), and what the company's own files in `fatture/emesse/`
 * say of a year's numbers: only a suggestion and a warning, never the counter.
 */
import type { ClientStore } from "../client-store.ts";
import { dueDates } from "../dates.ts";
import type { ToolContext } from "../engine.ts";
import type { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import type { PriceListStore } from "../price-list-store.ts";
import type { QuoteStore } from "../quote-store.ts";
import { CREDIT_NOTE_TYPE, ISSUED_FOLDER } from "../sales-invoice-rules.ts";
import { SALES_BROKEN, type SalesBook, type SalesInvoiceStore } from "../sales-invoice-store.ts";
import { type IssuedInvoice, isIssued, SALES_LIMITS, type SalesInvoice, SalesInvoiceError } from "../sales-invoices.ts";
import { makeDocumentFile } from "../document-reader.ts";
import type { AppointmentLink } from "../appointment-store.ts";
import type { DdtLink } from "../ddt-store.ts";
import type { StockLink } from "../stock-store.ts";
import type { TaxStore } from "../tax-store.ts";
import type { TimesheetStore } from "../timesheet-store.ts";
import type { Workspace } from "../workspace.ts";

/** What changed, for the audit: the op and how many, never customers, amounts, numbers or lines; `by`: the approver of another agente's request (ADR 0108). */
export type SalesEvent = { readonly type: "sales_invoices.changed"; readonly op: "draft" | "credit_note" | "issue" | "remove" | "settings"; readonly count: number; readonly by?: string };

/** The stores and seams the tool is given (SalesToolsOptions adds the clock, the PDF maker, who is who and the audit). */
export type SalesStores = {
	readonly workspace: Workspace;
	readonly store: SalesInvoiceStore;
	/** The company's data (invoices set_company): the seller, read only. */
	readonly company: Pick<InvoiceStore, "read">;
	/** The forfettario's profile: tells the regime when the company does not say it. */
	readonly taxes: Pick<TaxStore, "read">;
	readonly clients?: Pick<ClientStore, "read">;
	readonly quotes?: Pick<QuoteStore, "read" | "markInvoiced">;
	readonly timesheet?: Pick<TimesheetStore, "read" | "setBilled">;
	/** The listino, read only: a line naming a voce (item) takes its description, unit, price and VAT or nature. */
	readonly priceList?: Pick<PriceListStore, "read">;
	/** Il magazzino: an invoice issued unloads the articles its lines sell (by the voce of the listino), a credit note puts them back; once per invoice and line. */
	readonly stock?: StockLink;
	/** I DDT: a fattura differita bills the vendita DDTs of a client in a month, marked billed when it is issued. */
	readonly ddt?: DdtLink;
	/** Gli appuntamenti: an invoice bills a client's appointments fatti, marked billed when it is issued. */
	readonly appointments?: AppointmentLink;
	/** The workspace's invoices (the scadenzario's scanner): the numbers already used this year. */
	readonly scanner: Pick<InvoiceScanner, "scan">;
	readonly timeZone: string;
};

/** What builds the env: the stores, who is who, the audit, and (tests) the clock and the PDF maker. */
export type SalesEnvOptions = SalesStores & {
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: SalesEvent) => Promise<void>;
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

/**
 * The env every op of sales_invoices works with, and the recurring invoices too (their drafts are
 * made by the same draft builder, with the same stores, markers and audit).
 */
export function salesEnvOf(options: SalesEnvOptions): SalesEnv {
	const { whoIs, record, now: clock, make, ...stores } = options;
	const now = clock ?? (() => new Date());
	// The approver of another agente's request is who said yes (ADR 0108); outside a conversation, Owni herself.
	const who = (ctx: ToolContext) => ctx.approvedBy ?? (ctx.thread === undefined ? "owni" : (whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	return {
		...stores,
		now,
		make: make ?? ((input: MakeInput) => makeDocumentFile(input)),
		marker: (ctx) => ({ by: who(ctx), at: now().toISOString() }),
		audit: async (ctx, op, count) => {
			// Its own step: an audit that failed is written on the rerun, after the change it records.
			await ctx.step(`audit-${op}`, async () => {
				await record?.({ type: "sales_invoices.changed", op, count, ...(ctx.approvedBy === undefined ? {} : { by: ctx.approvedBy }) });
				return true;
			});
		},
		book: () => {
			const book = stores.store.read();
			if (book.broken) throw new SalesInvoiceError(SALES_BROKEN);
			return book;
		},
	};
}

export type SalesEnv = SalesStores & {
	readonly now: () => Date;
	readonly make: (input: MakeInput) => Promise<MadeDocument>;
	readonly marker: (ctx: ToolContext) => Marker;
	readonly audit: (ctx: ToolContext, op: SalesEvent["op"], count: number) => Promise<void>;
	/** The store as saved; SalesInvoiceError when it does not read. */
	readonly book: () => SalesBook;
};

const ASK_HEAD = (what: string) => `Per ${what} mi servono ancora questi dati. Chiedili a chi ti scrive tutti insieme, non inventarli, poi rifai la richiesta con le sue risposte:`;

/** What FatturaPA still needs, to ask the person in one go: never invented. */
export function askFor(missing: readonly string[], what = "la fattura", tail?: string): string {
	return [ASK_HEAD(what), ...missing.map((m) => `• ${m}`), ...(tail === undefined ? [] : [tail])].join("\n");
}

/** What is missing, by whom it is about; a group with nothing missing is not shown. */
export type Missing = { readonly me: string[]; readonly customer: string[]; readonly invoice: string[] };

export const noneMissing = (): Missing => ({ me: [], customer: [], invoice: [] });

export const anyMissing = (m: Missing): boolean => m.me.length + m.customer.length + m.invoice.length > 0;

/** The one question, under short headings: about the person (said once), the customer, this invoice. */
export function askGroups(m: Missing, tails: readonly string[] = []): string {
	const group = (head: string, items: readonly string[], sep: string) => (items.length === 0 ? [] : [`${head}: ${items.join(sep)}`]);
	// The person's data are short names, listed with commas; the others may hold a comma or a semicolon of their own.
	return [ASK_HEAD("la fattura"), ...group("Su di te (una volta sola)", m.me, ", "), ...group("Sul cliente", m.customer, "; "), ...group("Su questa fattura", m.invoice, "; "), ...tails].join("\n");
}

/** The due date an invoice dated `day` has with its payment terms. */
export function dueOf(inv: Pick<SalesInvoice, "payment" | "type">, day: string): string | undefined {
	if (inv.payment === undefined || inv.type === CREDIT_NOTE_TYPE) return undefined;
	return dueDates(day, [inv.payment.days], { endOfMonth: inv.payment.endOfMonth })[0]?.date;
}

const SAID_NUMBER = /^(?:n\.?\s*)?(?:(\d{4})\s*[/-]\s*)?(\d{1,5})(?:\s*[/-]\s*(\d{4}))?$/i;

/** The issued invoices a number names: «12», «2026/12», «12/2026», «n. 12»; newest year first. */
export function findIssued(invoices: readonly SalesInvoice[], said: string, type?: SalesInvoice["type"]): IssuedInvoice[] {
	const m = SAID_NUMBER.exec(said.trim());
	if (m === null) return [];
	const year = m[1] ?? m[3];
	const seq = Number(m[2]);
	return invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.seq === seq && (year === undefined || i.year === Number(year)) && (type === undefined || i.type === type)).sort((a, b) => b.year - a.year);
}

/**
 * The draft (or invoice) a draft id names, or the only draft when none is named; else what to say.
 * `verb`: what is to be done with it, for the answer («emettere», «togliere», «vedere»).
 */
export function namedDraft(invoices: readonly SalesInvoice[], said: unknown, verb: string): { readonly found: SalesInvoice } | { readonly answer: string } {
	if (typeof said === "string" && said.trim() !== "") {
		const id = said.trim().toUpperCase();
		const found = invoices.find((i) => i.id === id);
		return found === undefined ? { answer: `Errore: non c'è la bozza ${id}.` } : { found };
	}
	const drafts = invoices.filter((i) => !isIssued(i));
	if (drafts.length === 1) return { found: drafts[0] as SalesInvoice };
	return { answer: drafts.length === 0 ? `Non c'è nessuna bozza da ${verb}.` : `Errore: ci sono più bozze, dimmi quale ${verb}.` };
}

/** A number as an invoice writes it, within its year: «12», «2026/12», «12/2026», «FT 12»; YYYY the document's own year. */
export function seqOf(number: string | undefined, year: number): number | undefined {
	if (number === undefined) return undefined;
	const t = number.trim();
	const m = /^(?:FT\s*)?(\d{1,6})$/i.exec(t) ?? /^(\d{4})\/(\d{1,6})$/.exec(t) ?? /^(\d{1,6})\/(\d{4})$/.exec(t);
	if (m === null) return undefined;
	let n: string | undefined;
	if (m.length === 2) n = m[1];
	else if (/^\d{4}\//.test(t)) n = m[1] === String(year) ? m[2] : undefined;
	else n = m[2] === String(year) ? m[1] : undefined;
	const seq = n === undefined ? undefined : Number(n);
	return seq !== undefined && seq >= 1 && seq < SALES_LIMITS.perYear ? seq : undefined;
}

/** What the company's own invoices of a year in `fatture/emesse/` say: the highest number and the latest date, each with its file. */
export type FilesSay = { readonly highest?: { readonly seq: number; readonly file: string }; readonly latest?: { readonly date: string; readonly file: string } };

/**
 * The company's invoices of `year` in `fatture/emesse/` (supplier = its partita IVA), dated up to
 * `today`, with a number written in one of the plain ways. A scan that fails says nothing.
 */
export async function filesSay(env: Pick<SalesEnv, "scanner">, signal: AbortSignal, vat: string, year: number, today: string): Promise<FilesSay> {
	let highest: FilesSay["highest"];
	let latest: FilesSay["latest"];
	try {
		const scan = await env.scanner.scan(signal);
		for (const found of scan.invoices) {
			if (!found.path.startsWith(`${ISSUED_FOLDER}/`)) continue;
			const s = found.fattura.supplier.vat;
			if (s === undefined || `${s.country ?? "IT"}${s.code}`.toUpperCase() !== vat) continue;
			for (const doc of found.fattura.documents) {
				if (doc.date === undefined || doc.date.slice(0, 4) !== String(year) || doc.date > today) continue;
				const seq = seqOf(doc.number, year);
				if (seq === undefined) continue;
				if (highest === undefined || seq > highest.seq) highest = { seq, file: found.path };
				if (latest === undefined || doc.date > latest.date) latest = { date: doc.date, file: found.path };
			}
		}
	} catch (error) {
		if (signal.aborted) throw error;
	}
	return { ...(highest === undefined ? {} : { highest }), ...(latest === undefined ? {} : { latest }) };
}
