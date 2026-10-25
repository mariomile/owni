import { createHash } from "node:crypto";
import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import type { DdtStore } from "../ddt-store.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { euros, n1 } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { Company } from "../invoices.ts";
import { daysBetween, todayIn } from "../italian-calendar.ts";
import { italianDay } from "../italian-format.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import { type LeadTime, type Order, type OrderLine, isAwaited, isOpen, ORDER_LIMITS, ORDER_OPS, OrderError, orderId, type OrderOp, orderState, remainingOf } from "../orders.ts";
import { ORDERS_BROKEN, type OrderStore } from "../order-store.ts";
import { incomingOf, latestBySupplier, type Offer, offersFor, sellersOf, type SuggestData, type Suggestion, suggestions, supplierKeyOf } from "../order-suggest.ts";
import { costOf, costText, qtyOf, qtyText } from "../stock-sums.ts";
import { moveId, type Movement, StockError, type StockItem } from "../stock.ts";
import { STOCK_BROKEN, type StockStore } from "../stock-store.ts";
import type { Supplier } from "../supplier-sums.ts";
import type { SupplierStore } from "../supplier-store.ts";
import { spellingKey } from "../name-keys.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { asked, daySaid, daysSaid, linesSaid, orderSaid, type SupplierSaid, supplierSaid } from "./order-input.ts";
import { agree, briefAnswer, coverWords, dayWords, expectedTotal, fencedOrders, type LeadSaid, lineWords, orderBlock, orderMarkdown, orderRow, ordersCsv, suggestAnswer } from "./order-render.ts";
import { costWords, qtyNumber, qtyWords } from "./stock-render.ts";
import { loadPurchases } from "./purchase-data.ts";
import { fileSlug } from "./quote-input.ts";

/** What was done, for the audit: the op and how many, never suppliers, articles, quantities or prices. */
export type OrderEvent = { readonly type: "orders.used"; readonly op: OrderOp | "brief"; readonly count: number };

export type OrderToolsOptions = {
	readonly workspace: Workspace;
	readonly store: OrderStore;
	/** The magazzino: the articles, their movements (the pace), the codes and units learned; written only by the goods the person says arrived with the delivery note. */
	readonly stock: Pick<StockStore, "read" | "update">;
	/** The scadenzario: the invoices received (the prices paid, through the shared scanner) and the company for the document's letterhead. */
	readonly invoices?: Pick<InvoiceStore, "read">;
	readonly scanner?: InvoiceScanner;
	readonly expenses?: Pick<ExpenseStore, "read">;
	readonly suppliers?: Pick<SupplierStore, "read">;
	/** I DDT: a conto visione counts in the pace only once billed (the client kept the goods). */
	readonly ddt?: Pick<DdtStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: OrderEvent) => Promise<void>;
	/** Tests: the clock and the document maker (default: the document worker). */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

const DESCRIPTION = [
	"Gli ordini ai fornitori (OR-0001), cosa riordinare e perché (stock dice solo cosa è sotto il minimo; la merce arrivata si carica con orders received o con stock receive_invoice; il PDF lo manda lui con file_send): what to reorder for the magazzino, the orders' drafts per supplier, their document, and whether the goods arrived. Owni never sends an order: the person does, and says so.",
	"What the person says → op: «cosa devo riordinare?», «cosa sta per finire?» → suggest (cover_days: the days of sales past the minimum, default 30); «fammi l'ordine per Beta» → create with supplier (the articles to reorder that Beta sells); «prepara gli ordini» → create (one draft per supplier: the usual one, or prefer cheapest); «ordina 50 cartucce XL dal fornitore che le fa pagare meno» → create with lines [{item, quantity 50}] and prefer cheapest; when Owni works out the drafts, create first shows them with a check: show them, and only after the person's yes repeat with confirm true and that check; «ordina a Beta 50 cartucce XL» (supplier and lines both said) makes the draft at once. «aggiungi 10 risme all'ordine di Beta», «togli il toner», «senza prezzi» → change (order or supplier; lines [{item, quantity}], quantity 0 takes it off; notes; no_prices) while it is a draft; «fammi il PDF dell'ordine per Beta» → document (format pdf or docx), then offer file_send, or google_mail_send to the supplier with the file attached (it leaves only after the person approves the card); «ho mandato l'ordine», «l'ho mandato venerdì» → mark_sent (day when said; only when the person says it went out); «è arrivata la merce di Beta», «è arrivato l'ordine OR-0003» → received (lines and quantities when only some came, day when said): it shows the load first with a check, like create; «annulla l'ordine OR-0002» → cancel; «è arrivato l'ordine di Beta?» → status (supplier or order); «quali ordini ho aperti?» → list (all true for every one); «Beta consegna in 10 giorni» → lead_time (supplier, days); «fammi il file degli ordini» → export, then file_send.",
	"The goods of an order arrive with the supplier's invoice (stock receive_invoice loads it and marks the order) or, before it, with the delivery note: then received. stock low says only what is already under the minimum; what to reorder, how many and from whom is suggest. Quantities are in the article's unit (or its pack, with unit); prices per unit without IVA. summary of the brief: list with compact true. Repeat quantities and amounts as given, never compute them yourself.",
].join(" ");

/** «venerdì 16 ottobre», «oggi». */
const italianDayOf = (date: string, today?: string) => (date === today ? "oggi" : italianDay(date));

const AGENT_REFUSAL = "Gli ordini dicono fornitori, articoli e prezzi: a un altro agente do solo quanti sono. Li prepara e li cambia chi ti scrive, nella sua conversazione.";

/** One line of a draft as proposed: the article, how many, the price expected and where it comes from. */
type DraftLine = { readonly item: StockItem; readonly qty: bigint; readonly price?: bigint; readonly priceFrom?: "purchase" | "said"; readonly priceDay?: string; readonly why?: string; readonly other?: string };
type Draft = { readonly supplier: SupplierSaid; readonly lines: readonly DraftLine[] };

/**
 * Gli ordini (orders.ts): the orders kept here, the magazzino and the invoices received read
 * only. create, change, mark_sent, cancel, document, export and lead_time write (and the brief's
 * list, which marks what it said); suggest, list and status only read. Today is read once per call.
 */
export function createOrderTools(options: OrderToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const make = options.make ?? ((input: MakeInput) => makeDocumentFile(input));
	const scanner = options.invoices === undefined ? undefined : (options.scanner ?? new InvoiceScanner(workspace));
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: OrderEvent["op"], count: number) => {
		await ctx.step("audit", async () => {
			await options.record?.({ type: "orders.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const amount = (description: string) => ({ type: ["number", "string"], description });

	type Loaded = { readonly data: SuggestData; readonly orders: readonly Order[]; readonly leads: readonly LeadTime[]; readonly suppliers: readonly Supplier[]; readonly notes: readonly string[] };

	/** The orders and the magazzino must read; the prices paid are said when they do not. */
	async function load(ctx: ToolContext): Promise<Loaded | string> {
		const book = store.read();
		if (book.broken) return `Errore: ${ORDERS_BROKEN}.`;
		const stock = options.stock.read();
		if (stock.broken) return `Errore: ${STOCK_BROKEN}.`;
		const notes: string[] = [];
		let rows: SuggestData["purchases"] = [];
		let suppliers: readonly Supplier[] = [];
		if (options.invoices !== undefined && scanner !== undefined) {
			const got = await loadPurchases({ invoices: options.invoices, scanner, ...(options.expenses === undefined ? {} : { expenses: options.expenses }), ...(options.suppliers === undefined ? {} : { suppliers: options.suppliers }), timeZone }, ctx);
			if (typeof got === "string") notes.push(`I prezzi delle fatture ricevute qui mancano: ${got.charAt(0).toLowerCase()}${got.slice(1)}`);
			else {
				rows = got.rows;
				suppliers = got.suppliers;
			}
		}
		const ddts = options.ddt?.read();
		const visioneSold = new Set(ddts === undefined || ddts.broken ? [] : ddts.ddts.filter((d) => d.causale === "conto_visione" && d.billed !== undefined).map((d) => d.id));
		return { data: { items: stock.items, moves: stock.moves, purchases: rows, codes: stock.codes, units: stock.units, visioneSold }, orders: book.orders, leads: book.leads, suppliers, notes };
	}

	/** A supplier's lead time, and whether the person said it (else the default, an assumption said as one). */
	const leadOf =
		(leads: readonly LeadTime[]) =>
		(key: string | undefined): LeadSaid => {
			const said = leads.find((l) => l.s === key)?.days;
			return said === undefined ? { days: ORDER_LIMITS.lead, known: false } : { days: said, known: true };
		};

	/** What to reorder today, what the open orders bring counted as had. */
	const suggested = (loaded: Loaded, day: string, cover: number): Suggestion[] => suggestions(loaded.data, day, { cover, lead: leadOf(loaded.leads), incoming: incomingOf(loaded.orders) });

	function coverOf(args: Record<string, unknown>): number | string {
		return daysSaid(args.cover_days, "i giorni di uscite da coprire", ORDER_LIMITS.maxCover) ?? ORDER_LIMITS.cover;
	}

	/** Late: sent more than the supplier's lead time ago, not all arrived. */
	function lateOf(loaded: Loaded, day: string): { order: Order; days: number; lead: LeadSaid }[] {
		const lead = leadOf(loaded.leads);
		return loaded.orders
			.filter((o) => isAwaited(o) && o.sentDay !== undefined && daysBetween(o.sentDay, day) > lead(o.supplier.key).days)
			.map((order) => ({ order, days: daysBetween(order.sentDay as string, day), lead: lead(order.supplier.key) }))
			.sort((a, b) => b.days - a.days || a.order.id.localeCompare(b.order.id));
	}

	/** The drafts the person's words make: their lines, or what to reorder; each article to the supplier said, else the usual one (or the cheapest). What is left out, with why. */
	function drafts(args: Record<string, unknown>, loaded: Loaded, day: string): { drafts: Draft[]; left: string[]; notes: string[] } | string {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return supplier;
		if (args.prefer !== undefined && args.prefer !== "usual" && args.prefer !== "cheapest") return "Errore: il fornitore da preferire è quello solito o il più conveniente.";
		const cheapest = args.prefer === "cheapest";
		let wanted: { item: StockItem; qty: bigint; price?: bigint; why?: string }[];
		const fromSuggest = args.lines === undefined;
		if (!fromSuggest) {
			const said = linesSaid(args.lines, loaded.data.items);
			if (typeof said === "string") return said;
			wanted = said;
		} else {
			const cover = coverOf(args);
			if (typeof cover === "string") return cover;
			wanted = suggested(loaded, day, cover).map((s) => ({ item: s.item, qty: s.qty, why: `ne hai ${qtyNumber(s.state.onHand)}${s.incoming === undefined ? "" : ` più ${qtyNumber(s.incoming.qty)} già ${agree(s.item.unit, "ordinati", "ordinate")}`}${s.item.min === undefined ? "" : `, il minimo è ${qtyNumber(qtyOf(s.item.min))}`}, per ${coverWords(cover)}` }));
			if (wanted.length === 0) return ["Niente da riordinare: nessun articolo è sotto il minimo o ci arriva prima che un ordine possa arrivare, contando quelli già ordinati. Se vuoi ordinare qualcosa lo stesso, dimmi l'articolo e quanti.", ...loaded.notes].join("\n");
		}
		const groups = new Map<string, { supplier: SupplierSaid; lines: DraftLine[] }>();
		const left: string[] = [];
		// Articles to reorder the supplier said never sold: counted, with who usually does.
		const elsewhere = new Map<string, number>();
		for (const w of wanted) {
			const offers = offersFor(w.item, loaded.data);
			const sellers = sellersOf(offers, day);
			let to: SupplierSaid | undefined = supplier;
			if (supplier !== undefined && fromSuggest && !offers.some((o) => o.key === supplier.key)) {
				const usual = (sellers.usual ?? sellers.cheapest)?.supplier ?? "";
				elsewhere.set(usual, (elsewhere.get(usual) ?? 0) + 1);
				continue;
			}
			let pick: Offer | undefined;
			if (to === undefined) {
				pick = cheapest ? (sellers.cheapest ?? sellers.usual) : (sellers.usual ?? sellers.cheapest);
				if (pick === undefined) {
					left.push(`• ${w.item.name}: non so da chi lo compri (nessuna fattura o carico con il fornitore): dimmi il fornitore`);
					continue;
				}
				to = { key: pick.key, name: pick.supplier.slice(0, ORDER_LIMITS.name), ...(pick.vat === undefined ? {} : { vat: pick.vat }) };
			}
			const latest = latestBySupplier(offers);
			const last = latest.find((o) => o.key === to.key);
			const line: DraftLine = w.price !== undefined ? { item: w.item, qty: w.qty, price: w.price, priceFrom: "said" } : last !== undefined ? { item: w.item, qty: w.qty, price: last.cost, priceFrom: "purchase", priceDay: last.day } : { item: w.item, qty: w.qty };
			// A cheaper supplier, said on the line when it saves at least 5%; with the cheapest chosen, against the usual one.
			let other: string | undefined;
			const low = sellers.cheapest;
			if (cheapest && pick !== undefined && sellers.usual !== undefined && sellers.usual.key !== pick.key && sellers.usual.cost > pick.cost) other = `da ${pick.supplier} perché costa meno: ${costWords(pick.cost)} il ${dayWords(pick.day, day)}, contro ${costWords(sellers.usual.cost)} di ${sellers.usual.supplier} il ${dayWords(sellers.usual.day, day)}`;
			else if (!cheapest && low !== undefined && low.key !== to.key && line.price !== undefined && (line.price - low.cost) * 100n >= 5n * line.price) other = `${low.supplier} l'ha fatto ${costWords(low.cost)}, il ${((line.price - low.cost) * 100n) / line.price}% in meno, il ${dayWords(low.day, day)}: se vuoi lo prendo da lì`;
			const g = groups.get(to.key) ?? { supplier: to, lines: [] };
			g.lines.push({ ...line, ...(w.why === undefined ? {} : { why: w.why }), ...(other === undefined ? {} : { other }) });
			groups.set(to.key, g);
		}
		const away = [...elsewhere.values()].reduce((a, b) => a + b, 0);
		const others = [...elsewhere.keys()].filter((k) => k !== "");
		if (supplier !== undefined && groups.size === 0 && away > 0) {
			return [`Da questo fornitore non c'è niente da riordinare. Ci sono altri ${n1(away, "un articolo", "# articoli")} da riordinare, che di solito compri da ${others.length === 1 ? "un altro fornitore" : "altri fornitori"} (nel riquadro): vuoi l'ordine per ${others.length === 1 ? "quello" : "loro"}?`, fencedOrders([`Fornitore chiesto: ${supplier.name}`, ...(others.length === 0 ? [] : [`Di solito da: ${others.join(", ")}`])].join("\n")), ...loaded.notes].join("\n");
		}
		const notes = away === 0 ? [] : [`(${n1(away, "un altro articolo da riordinare non l'hai mai comprato", "altri # articoli da riordinare non li hai mai comprati")} da questo fornitore: ${away === 1 ? "te lo metto" : "te li metto"} nell'ordine per ${others.length === 1 ? "il fornitore da cui li compri di solito" : "i fornitori da cui li compri di solito"}?)`];
		return { drafts: [...groups.values()], left, notes };
	}

	const checkOf = (ds: readonly Draft[]) => createHash("sha256").update(JSON.stringify(ds.map((d) => [d.supplier.key, d.lines.map((l) => [l.item.id, l.qty.toString(), l.price?.toString() ?? ""])]))).digest("hex").slice(0, 16);

	const draftLineRow = (l: DraftLine, n: number, day: string) => {
		const why = [...(l.why === undefined ? [] : [l.why]), l.price === undefined ? "prezzo non noto: chiedilo al fornitore" : l.priceFrom === "said" ? "prezzo detto da te" : `l'ultimo prezzo pagato, il ${dayWords(l.priceDay as string, day)}`];
		return `  ${n}. ${l.item.name}: ${lineWords({ qty: qtyText(l.qty), unit: l.item.unit, ...(l.price === undefined ? {} : { price: costText(l.price) }) })} (${why.join("; ")})${l.other === undefined ? "" : ` (${l.other})`}`;
	};

	/** The open orders that have the drafts' articles already: «Cartucce XL: OR-0003 (inviato)». */
	function alreadyOrdered(ds: readonly Draft[], orders: readonly Order[]): string[] {
		const out: string[] = [];
		for (const l of ds.flatMap((d) => d.lines)) {
			const on = orders.filter((o) => isOpen(o) && o.lines.some((x) => x.item === l.item.id && remainingOf(o, x) > 0n));
			if (on.length > 0) out.push(`• ${l.item.name}: già in ${on.map((o) => `${o.id} (${o.status === "draft" ? "bozza" : "inviato"})`).join(", ")}`);
		}
		return out;
	}

	function proposalText(ds: readonly Draft[], left: readonly string[], loaded: Loaded, day: string, notes: readonly string[] = [], first = ""): string {
		const rows: string[] = [];
		for (const d of ds) {
			rows.push(`Fornitore: ${d.supplier.name}`, ...d.lines.map((l, i) => draftLineRow(l, i + 1, day)));
			const total = expectedTotal(d.lines.map((l) => ({ qty: qtyText(l.qty), ...(l.price === undefined ? {} : { price: costText(l.price) }) })));
			if (total !== undefined) rows.push(`  Totale previsto: ${euros(total)} senza IVA`);
		}
		if (left.length > 0) rows.push("Non li metto in un ordine:", ...left);
		const already = alreadyOrdered(ds, loaded.orders);
		if (already.length > 0) rows.push("Già in un ordine aperto:", ...already);
		const drafted = ds.flatMap((d) => loaded.orders.filter((o) => o.supplier.key === d.supplier.key && o.status === "draft").map((o) => o.id));
		const out = [`${first}${ds.length === 0 ? "Nessuna bozza d'ordine da preparare" : `Preparerei ${n1(ds.length, "una bozza d'ordine", "# bozze d'ordine, una per fornitore")}`}, come nel riquadro (prezzi per unità, senza IVA).`, fencedOrders(rows.join("\n")), ...notes];
		if (already.length > 0) out.push(`${n1(already.length, "Un articolo è", "# articoli sono")} già in un ordine aperto (nel riquadro): controlla di non ordinarlo due volte.`);
		if (drafted.length > 0) out.push(`Per ${drafted.length === 1 ? "questo fornitore c'è già una bozza" : "questi fornitori ci sono già delle bozze"} (${drafted.join(", ")}): se preferisci, cambio quella invece di farne un'altra.`);
		if (ds.length > 0) out.push(`Va bene? Con il sì di chi ti scrive ripeti con la conferma e il controllo ${checkOf(ds)}. Non mando niente a nessuno: l'ordine al fornitore lo mandi tu, e poi me lo dici.`);
		return [...out, ...loaded.notes].join("\n");
	}

	async function create(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const built = drafts(args, loaded, day);
		if (typeof built === "string") return { text: built, count: 0 };
		// The person dictated both the supplier and the lines: nothing for Owni to work out, the draft is made at once (a draft sends nothing).
		// A supplier taken from words close to its name is shown first, never written at once.
		const dictated = args.supplier !== undefined && args.lines !== undefined && args.prefer !== "cheapest" && built.drafts.every((d) => d.supplier.close !== true);
		if (!dictated && args.confirm !== true) return { text: proposalText(built.drafts, built.left, loaded, day, built.notes), count: 0 };
		const refused = requirePersonFor(ctx, "preparo le bozze d'ordine");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (!dictated) {
			const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
			if (check === undefined || !/^[0-9a-f]{16}$/.test(check)) return { text: "Errore: per preparare le bozze serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
			if (built.drafts.length === 0) return { text: proposalText(built.drafts, built.left, loaded, day, built.notes), count: 0 };
			if (checkOf(built.drafts) !== check) return { text: proposalText(built.drafts, built.left, loaded, day, built.notes, "La proposta è cambiata da quando l'hai mostrata (il magazzino, i prezzi o le righe): non ho preparato niente. Ecco quella nuova.\n"), count: 0 };
		}
		if (built.drafts.length === 0) return { text: proposalText(built.drafts, built.left, loaded, day, built.notes), count: 0 };
		const by = marker(ctx);
		const ids = await ctx.step("create", async () => {
			store.update(ctx.callId, (state) => {
				const made: Order[] = built.drafts.map((d, i) => ({
					id: orderId(state.nextOrder + i),
					supplier: { key: d.supplier.key, name: d.supplier.name, ...(d.supplier.vat === undefined ? {} : { vat: d.supplier.vat }) },
					status: "draft",
					day,
					lines: d.lines.map((l, n): OrderLine => ({ n: n + 1, item: l.item.id, name: l.item.name, qty: qtyText(l.qty), unit: l.item.unit, ...(l.price === undefined ? {} : { price: costText(l.price), priceFrom: l.priceFrom as "purchase" | "said", ...(l.priceDay === undefined ? {} : { priceDay: l.priceDay }) }) })),
					receipts: [],
					callId: ctx.callId,
					...by,
				}));
				if (state.orders.length + made.length > ORDER_LIMITS.orders) throw new OrderError(`ci sono già troppi ordini (al massimo ${ORDER_LIMITS.orders}): esporta e annulla quelli vecchi`);
				return { ...state, nextOrder: state.nextOrder + made.length, orders: [...state.orders, ...made] };
			});
			return store.read().orders.filter((o) => o.callId === ctx.callId).map((o) => o.id);
		});
		const made = store.read().orders.filter((o) => ids.includes(o.id));
		const already = alreadyOrdered(built.drafts, loaded.orders);
		return {
			text: [
				`Fatto: ${n1(made.length, `ho preparato la bozza d'ordine ${ids[0]}`, `ho preparato # bozze d'ordine (${ids.join(", ")})`)}, come nel riquadro. È solo una bozza, non è partito niente.`,
				fencedOrders([...made.map((o) => orderBlock(o, day)), ...(already.length === 0 ? [] : ["Già in un ordine aperto:", ...already])].join("\n")),
				...(already.length === 0 ? [] : [`${n1(already.length, "Un articolo era", "# articoli erano")} già in un ordine aperto (nel riquadro): controlla di non ordinarlo due volte.`]),
				`Vuoi il PDF da mandare al fornitore? Quando l'hai mandato, dimmelo e lo segno come inviato.`,
			].join("\n"),
			count: made.length,
		};
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, (x) => x.status === "draft", "in bozza");
		if (typeof o === "string") return { text: o, count: 0 };
		if (o.status !== "draft") return { text: `L'ordine ${o.id} è ${o.status === "cancelled" ? "annullato" : "già inviato"}: si cambia solo una bozza. Per ordinare altro, ne preparo uno nuovo.`, count: 0 };
		const refused = requirePersonFor(ctx, `cambio l'ordine ${o.id}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const said = args.lines === undefined ? [] : linesSaid(args.lines, loaded.data.items, true);
		if (typeof said === "string") return { text: said, count: 0 };
		const notes = cleanText(args.notes, ORDER_LIMITS.notes, "le note", true);
		if (isProblem(notes)) return { text: `Errore: ${notes.problem}.`, count: 0 };
		if (args.no_prices !== undefined && typeof args.no_prices !== "boolean") return { text: "Errore: senza prezzi è sì o no.", count: 0 };
		if (said.length === 0 && notes === undefined && args.no_prices === undefined) return { text: "Errore: dimmi cosa cambiare: le righe (articolo e quanti, 0 per toglierlo), le note o se il documento va senza prezzi.", count: 0 };
		const offersOf = (item: StockItem) => latestBySupplier(offersFor(item, loaded.data)).find((x) => x.key === o.supplier.key);
		let lines = [...o.lines];
		for (const l of said) {
			const at = lines.findIndex((x) => x.item === l.item.id);
			if (l.qty === 0n) {
				if (at >= 0) lines.splice(at, 1);
				continue;
			}
			const last = offersOf(l.item);
			const price = l.price !== undefined ? { price: costText(l.price), priceFrom: "said" as const } : at >= 0 ? (lines[at]?.price === undefined ? {} : { price: lines[at]?.price as string, priceFrom: lines[at]?.priceFrom as "purchase" | "said", ...(lines[at]?.priceDay === undefined ? {} : { priceDay: lines[at]?.priceDay as string }) }) : last === undefined ? {} : { price: costText(last.cost), priceFrom: "purchase" as const, priceDay: last.day };
			const next: OrderLine = { n: at >= 0 ? (lines[at] as OrderLine).n : Math.max(0, ...lines.map((x) => x.n)) + 1, item: l.item.id, name: l.item.name, qty: qtyText(l.qty), unit: l.item.unit, ...price };
			if (at >= 0) lines[at] = next;
			else lines.push(next);
		}
		if (lines.length === 0) return { text: `Così l'ordine ${o.id} resterebbe senza righe: se non serve più, chi ti scrive può dirmi di annullarlo.`, count: 0 };
		lines = lines.map((l, i) => ({ ...l, n: i + 1 }));
		const by = marker(ctx);
		await ctx.step("change", async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.orders.find((x) => x.id === o.id);
				if (cur === undefined || cur.status !== "draft") throw new OrderError(`l'ordine ${o.id} non è più una bozza: non l'ho cambiato`);
				const changed: Order = { ...cur, lines, ...(notes === undefined ? {} : { notes }), ...(args.no_prices === true ? { noPrices: true as const } : {}), edited: by };
				const out = args.no_prices === false ? (({ noPrices: _, ...rest }) => rest)(changed) : changed;
				return { ...state, orders: state.orders.map((x) => (x.id === o.id ? (out as Order) : x)) };
			});
			return true;
		});
		const after = store.read().orders.find((x) => x.id === o.id) as Order;
		return { text: [`Fatto: ho cambiato la bozza ${o.id}, ora è così.`, fencedOrders(orderBlock(after, day)), ...(after.file === undefined ? [] : ["Il documento fatto prima non è più aggiornato: se serve, lo rifaccio."])].join("\n"), count: lines.length };
	}

	async function status(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string, op: "mark_sent" | "cancel"): Promise<{ text: string; count: number }> {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, op === "mark_sent" ? (x) => x.status === "draft" : isOpen, op === "mark_sent" ? "in bozza" : "aperto");
		if (typeof o === "string") return { text: o, count: 0 };
		if (op === "mark_sent" && o.status !== "draft") return { text: `L'ordine ${o.id} è ${o.status === "sent" ? "già segnato come inviato" : "annullato"}.`, count: 0 };
		if (op === "cancel" && (o.status === "cancelled" || orderState(o) === "received")) return { text: `L'ordine ${o.id} è ${o.status === "cancelled" ? "già annullato" : "già arrivato tutto"}: non c'è niente da annullare.`, count: 0 };
		const when = op === "mark_sent" ? (daySaid(args.day, day, "il giorno in cui l'hai mandato") ?? day) : day;
		if (typeof when === "object") return { text: `Errore: ${when.problem}.`, count: 0 };
		if (when < o.day) return { text: `L'ordine ${o.id} l'ho preparato il ${dayWords(o.day, day)}: non può essere partito prima. Dimmi il giorno giusto.`, count: 0 };
		const refused = requirePersonFor(ctx, op === "mark_sent" ? `segno come inviato l'ordine ${o.id}` : `annullo l'ordine ${o.id}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const by = marker(ctx);
		await ctx.step(op, async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.orders.find((x) => x.id === o.id);
				if (cur === undefined || (op === "mark_sent" ? cur.status !== "draft" : cur.status === "cancelled")) return state;
				const next: Order = op === "mark_sent" ? { ...cur, status: "sent", sentDay: when, sent: by } : { ...cur, status: "cancelled", cancelled: by };
				return { ...state, orders: state.orders.map((x) => (x.id === o.id ? next : x)) };
			});
			return true;
		});
		if (op === "cancel") return { text: `Annullato l'ordine ${o.id}.${o.status === "sent" ? " L'avevi già mandato al fornitore: avvisalo tu. Se vuoi ti preparo la mail." : ""}`, count: 1 };
		const lead = leadOf(loaded.leads)(o.supplier.key);
		const out = [`Segnato: ${o.id} inviato ${italianDayOf(when)}.`];
		out.push(lead.known ? `Se dopo ${n1(lead.days, "un giorno", "# giorni")} non è arrivato tutto, te lo ricordo.` : `Non so in quanti giorni consegna il fornitore: conto ${n1(lead.days, "un giorno", "# giorni")}. Se di solito ci mette di più o di meno, dimmelo e ti avviso al momento giusto.`);
		// Goods of this order loaded from this supplier since it was made: maybe it came before it was marked sent.
		const items = new Set(o.lines.map((l) => l.item));
		const came = loaded.data.moves.filter((m) => m.kind === "carico" && items.has(m.item) && m.day >= o.day && m.supplier !== undefined && supplierKeyOf(m.supplier.name, m.supplier.vat) === o.supplier.key);
		if (came.length > 0) out.push(`Dal fornitore ${n1(came.length, "è già stato caricato in magazzino un articolo", "sono già stati caricati in magazzino # carichi di articoli")} di questo ordine dopo che l'ho preparato: se era questa merce, dimmi «è arrivato»: la segno nell'ordine senza caricarla di nuovo.`);
		return { text: out.join(" "), count: 1 };
	}

	async function document(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, isOpen, "aperto");
		if (typeof o === "string") return { text: o, count: 0 };
		if (o.status === "cancelled") return { text: `L'ordine ${o.id} è annullato: non ne faccio il documento.`, count: 0 };
		const refused = requirePersonFor(ctx, `faccio il documento dell'ordine ${o.id}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const format = args.format === undefined ? "pdf" : args.format;
		if (format !== "pdf" && format !== "docx") return { text: "Errore: il documento è PDF o Word.", count: 0 };
		if (args.no_prices !== undefined && typeof args.no_prices !== "boolean") return { text: "Errore: senza prezzi è sì o no.", count: 0 };
		const order: Order = args.no_prices === true ? { ...o, noPrices: true } : args.no_prices === false ? (({ noPrices: _, ...rest }) => rest as Order)(o) : o;
		const book = options.invoices?.read();
		const company: Partial<Company> = book === undefined || book.broken ? {} : (book.company ?? {});
		const card = loaded.suppliers.find((s) => s.vat !== undefined && s.vat === o.supplier.vat)?.card ?? loaded.suppliers.find((s) => s.name === o.supplier.name)?.card;
		const contact = card?.contacts.find((c) => c.email !== undefined) ?? card?.contacts[0];
		const ext = `.${format}`;
		try {
			// The file made before is written again only when it is one of ours, under ordini/.
			const mine = o.file !== undefined && o.file.endsWith(ext) && /^ordini\/[^/\\]+$/.test(o.file) && !o.file.includes("..");
			const path = await ctx.step("path", async () => (mine ? (o.file as string) : await freePath(workspace, `ordini/Ordine-${o.id}${fileSlug(o.supplier.name) === "" ? "" : `-${fileSlug(o.supplier.name)}`}`, ext)));
			const made = await ctx.step("file", async () => {
				const doc = await make({ format, text: orderMarkdown(order, company, contact === undefined ? undefined : { ...(contact.name === undefined ? {} : { name: contact.name }), ...(contact.email === undefined ? {} : { email: contact.email }), ...(contact.phone === undefined ? {} : { phone: contact.phone }) }), name: `Ordine ${o.id}`, pictures: [], now: now().getTime() });
				const written = (await workspace.write(path, doc.data)).path;
				return { path: written, notes: [...doc.notes] };
			});
			await ctx.step("record", async () => {
				store.update(ctx.callId, (state) => ({ ...state, orders: state.orders.map((x) => (x.id === o.id ? { ...x, file: made.path.slice(0, ORDER_LIMITS.file), ...(order.noPrices === true ? { noPrices: true as const } : {}) } : x)).map((x) => (x.id === o.id && args.no_prices === false ? (({ noPrices: _, ...rest }) => rest as Order)(x) : x)) }));
				return true;
			});
			const bare = company.name === undefined ? ["Non ho i dati della tua azienda, quindi il documento è senza intestazione: dimmi ragione sociale, indirizzo e partita IVA e li salvo, poi lo rifaccio."] : [];
			const email = contact?.email === undefined ? "" : " L'indirizzo del referente del fornitore è nel riquadro.";
			return {
				text: [
					`Ecco il ${format === "pdf" ? "PDF" : "documento Word"} dell'ordine ${o.id} per il fornitore${order.noPrices === true ? ", senza prezzi" : ""}: il file è nel riquadro. Non l'ho mandato a nessuno.`,
					fencedOrders([`File: ${made.path}`, ...(contact?.email === undefined ? [] : [`Referente: ${[contact.name, contact.email].filter((x) => x !== undefined).join(", ")}`])].join("\n")),
					`Se vuoi, te lo mando qui, o lo mando per mail al fornitore con il file allegato: la mail parte solo dopo che approvi la richiesta.${email} Quando l'hai mandato, dimmelo e lo segno come inviato.`,
					...bare,
					...made.notes,
				].join("\n"),
				count: 1,
			};
		} catch (error) {
			if (error instanceof WorkspaceError || error instanceof DocumentError) return { text: `Errore: non sono riuscita a fare il documento dell'ordine (${error.message}).`, count: 0 };
			throw error;
		}
	}

	/** One line of what came: the order line, the article, how many, the price it is loaded at (needed only for what is loaded). */
	type Came = { readonly n: number; readonly item: StockItem; readonly qty: bigint; readonly price?: bigint };
	/** The document of a carico loaded from an invoice received (stock-invoice.ts): paid by that invoice already. */
	const INVOICE_DOC = "fattura n. ";

	/** Goods of an order line found in the magazzino already: the carico, how many of it, its day. */
	type Found = { readonly n: number; readonly move: string; readonly qty: bigint; readonly day: string; /** Loaded by hand, not from an invoice: the invoice still bills it. */ readonly bill: boolean };

	const cameCheck = (o: Order, when: string, rows: readonly Came[], found: readonly Found[]) => createHash("sha256").update(JSON.stringify([o.id, when, rows.map((r) => [r.n, r.item.id, r.qty.toString(), r.price?.toString() ?? ""]), found.map((f) => [f.n, f.move, f.qty.toString(), f.bill])])).digest("hex").slice(0, 16);

	/**
	 * The goods of `o` in the magazzino already: the carichi of its supplier for its articles since
	 * it was made (by hand, or an invoice that matched no order), never one a delivery note here
	 * loaded, never one an order claimed already, and past what the invoices marked on the orders
	 * of this supplier since then (those carichi are theirs). Oldest first, per line, up to `want`.
	 */
	function inStock(o: Order, loaded: Loaded, want: ReadonlyMap<number, bigint>): Found[] {
		const claimed = new Set(loaded.orders.flatMap((x) => x.receipts.filter((r) => r.from === "stock").map((r) => r.k.slice("carico:".length))));
		const same = (m: Movement) => m.supplier !== undefined && (supplierKeyOf(m.supplier.name, m.supplier.vat) === o.supplier.key || (o.supplier.vat === undefined && spellingKey(m.supplier.name) === spellingKey(o.supplier.name)));
		const out: Found[] = [];
		for (const l of o.lines) {
			let need = want.get(l.n) ?? 0n;
			if (need <= 0n) continue;
			// What invoices brought of this article to this supplier's orders since: their own carichi.
			let skip = loaded.orders
				.filter((x) => x.supplier.key === o.supplier.key)
				.flatMap((x) => x.receipts.filter((r) => r.from === undefined && r.day >= o.day && x.lines.some((y) => y.n === r.n && y.item === l.item)))
				.reduce((t, r) => t + qtyOf(r.qty), 0n);
			const moves = loaded.data.moves.filter((m) => m.kind === "carico" && m.item === l.item && m.day >= o.day && same(m) && !(m.doc ?? "").startsWith("bolla ") && !claimed.has(m.id));
			for (const m of moves) {
				let avail = qtyOf(m.qty);
				const used = skip < avail ? skip : avail;
				skip -= used;
				avail -= used;
				const take = avail < need ? avail : need;
				if (take <= 0n) continue;
				out.push({ n: l.n, move: m.id, qty: take, day: m.day, bill: !(m.doc ?? "").startsWith(INVOICE_DOC) });
				need -= take;
				if (need <= 0n) break;
			}
		}
		return out;
	}

	/**
	 * received: the goods of an order sent came. What is in the magazzino already (a carico by hand,
	 * an invoice that matched no order) is marked arrived without loading it again; the rest came
	 * with the delivery note, before its invoice. Shown first with a check; with the person's yes,
	 * the rest loaded at the order's prices (doc «bolla OR-0003») and marked as the person's, so
	 * that the invoice, when it comes, bills them instead of loading them again.
	 */
	async function received(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		const refused = requirePersonFor(ctx, "segno arrivata la merce di un ordine");
		if (refused !== undefined) return { text: refused, count: 0 };
		const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
		if (typeof supplier === "string") return { text: supplier, count: 0 };
		const o = orderSaid(args, loaded.orders, supplier, isAwaited, "in arrivo");
		if (typeof o === "string") return { text: o, count: 0 };
		const state = orderState(o);
		if (state === "draft") return { text: `${o.id} non risulta ancora inviato: se l'hai mandato, dimmelo e lo segno; poi segno la merce arrivata.`, count: 0 };
		if (state === "cancelled") return { text: `${o.id} è annullato: non segno merce arrivata su un ordine annullato.`, count: 0 };
		if (state === "received") return { text: `${o.id} è già arrivato tutto.`, count: 0 };
		const when = daySaid(args.day, day, "il giorno in cui è arrivata la merce") ?? day;
		if (typeof when === "object") return { text: `Errore: ${when.problem}.`, count: 0 };
		if (o.sentDay !== undefined && when < o.sentDay) return { text: `${o.id} è partito il ${dayWords(o.sentDay, day)}: la merce non può essere arrivata prima. Dimmi il giorno giusto.`, count: 0 };
		const items = loaded.data.items.filter((i) => i.removed === undefined);
		const came: Came[] = [];
		if (args.lines === undefined) {
			for (const l of o.lines) {
				const left = remainingOf(o, l);
				if (left <= 0n) continue;
				const item = items.find((i) => i.id === l.item);
				if (item === undefined) return { text: [`Un articolo dell'ordine ${o.id} non è più in magazzino: non lo posso segnare.`, fencedOrders(l.name)].join("\n"), count: 0 };
				came.push({ n: l.n, item, qty: left, ...(l.price === undefined ? {} : { price: costOf(l.price) }) });
			}
		} else {
			const said = linesSaid(args.lines, items, false, false);
			if (typeof said === "string") return { text: said, count: 0 };
			for (const x of said) {
				const l = o.lines.find((y) => y.item === x.item.id);
				if (l === undefined) return { text: [`Questo articolo non è nell'ordine ${o.id}: se è arrivato lo stesso, caricalo in magazzino a parte.`, fencedOrders(x.item.name)].join("\n"), count: 0 };
				const price = x.price ?? (l.price === undefined ? undefined : costOf(l.price));
				came.push({ n: l.n, item: x.item, qty: x.qty, ...(price === undefined ? {} : { price }) });
			}
		}
		if (came.length === 0) return { text: `Di ${o.id} non manca niente da segnare.`, count: 0 };
		// What is in the magazzino already is not loaded again: only the rest.
		const found = inStock(o, loaded, new Map(came.map((c) => [c.n, c.qty])));
		const foundOf = (n: number) => found.filter((f) => f.n === n).reduce((t, f) => t + f.qty, 0n);
		const rows: Came[] = came.map((c) => ({ ...c, qty: c.qty - foundOf(c.n) })).filter((c) => c.qty > 0n);
		const noPrice = rows.filter((r) => r.price === undefined).map((r) => r.item.name);
		if (noPrice.length > 0) return { text: [`Per caricarli in magazzino mi serve il prezzo per unità, senza IVA, ${noPrice.length === 1 ? "di un articolo" : `di ${noPrice.length} articoli`} che l'ordine non ha: dimmelo e li segno.`, fencedOrders(noPrice.map((n) => `• ${n}`).join("\n"))].join("\n"), count: 0 };
		const fence = fencedOrders(
			[
				`${o.id} a ${o.supplier.name}`,
				...rows.map((r) => `• ${r.item.name}: ${qtyWords(r.qty, r.item.unit)} a ${costWords(r.price as bigint)}, da caricare`),
				...came.filter((c) => foundOf(c.n) > 0n).map((c) => {
					const days = [...new Set(found.filter((f) => f.n === c.n).map((f) => dayWords(f.day, day)))].join(", ");
					return `• ${c.item.name}: ${qtyWords(foundOf(c.n), c.item.unit)} già in magazzino (${agree(c.item.unit, "caricati", "caricate")} il ${days}): non ${agree(c.item.unit, "li", "le")} carico di nuovo`;
				}),
			].join("\n"),
		);
		const check = cameCheck(o, when, rows, found);
		if (args.confirm !== true) {
			const head = rows.length === 0 ? `La merce di ${o.id} è già in magazzino, caricata prima che l'ordine fosse segnato (nel riquadro): la segno arrivata senza caricarla di nuovo.` : found.length === 0 ? `Segno arrivata con la bolla, ${italianDayOf(when)}, la merce di ${o.id} e la carico in magazzino al prezzo dell'ordine, come nel riquadro (prezzi per unità, senza IVA).` : `Segno arrivata la merce di ${o.id}, come nel riquadro: quella già in magazzino non la carico di nuovo, il resto lo carico con la bolla, ${italianDayOf(when)}, al prezzo dell'ordine (prezzi per unità, senza IVA).`;
			return { text: [head, fence, `${rows.length === 0 ? "" : "Quando arriva la fattura del fornitore, la merce della bolla non la carico di nuovo. "}Va bene? Con il sì di chi ti scrive ripeti con la conferma e il controllo ${check}.`].join("\n"), count: 0 };
		}
		const said = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
		if (said === undefined || !/^[0-9a-f]{16}$/.test(said)) return { text: "Errore: per segnare la merce serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
		if (said !== check) return { text: "L'ordine o il magazzino sono cambiati da quando l'hai mostrato: non ho caricato niente. Chiedimi di nuovo e ti faccio vedere com'è ora.", count: 0 };
		// Again just before loading: an order cancelled or arrived meanwhile loads nothing.
		const now2 = store.read();
		const cur = now2.broken ? undefined : now2.orders.find((x) => x.id === o.id);
		if (cur === undefined || !isAwaited(cur)) return { text: `${o.id} nel frattempo è ${cur === undefined ? "sparito" : orderState(cur) === "cancelled" ? "stato annullato" : "arrivato"}: non ho caricato niente.`, count: 0 };
		const by = marker(ctx);
		const vendor = { name: o.supplier.name.slice(0, ORDER_LIMITS.name), ...(o.supplier.vat === undefined ? {} : { vat: o.supplier.vat }) };
		if (rows.length > 0) {
			await ctx.step("stock", async () => {
				options.stock.update(ctx.callId, (st) => {
					const added: Movement[] = rows.map((r, i) => {
						if (!st.items.some((x) => x.id === r.item.id && x.removed === undefined)) throw new StockError("un articolo dell'ordine non è più in magazzino: non ho caricato niente");
						return { id: moveId(st.nextMove + i), item: r.item.id, kind: "carico", qty: qtyText(r.qty), day: when, cost: costText(r.price as bigint), supplier: vendor, doc: `bolla ${o.id}`, callId: ctx.callId, ...by };
					});
					return { ...st, nextMove: st.nextMove + added.length, moves: [...st.moves, ...added] };
				});
				return true;
			});
		}
		const k = `bolla:${createHash("sha256").update(ctx.callId).digest("hex").slice(0, 16)}`;
		const marked = await ctx.step("orders", async () => {
			try {
				store.receive(() => ({
					receipts: [...rows.map((r) => ({ order: o.id, k, n: r.n, qty: qtyText(r.qty), day: when, from: "person" as const })), ...found.map((f) => ({ order: o.id, k: `carico:${f.move}`, n: f.n, qty: qtyText(f.qty), day: f.day, from: "stock" as const, ...(f.bill ? { bill: true as const } : {}) }))],
					billed: [],
					found: true,
				}));
				return "";
			} catch (error) {
				if (error instanceof OrderError) return `${rows.length === 0 ? "Non ho caricato niente" : "La merce è caricata"}, ma non sono riuscita a segnarla nell'ordine: ${error.message}.`;
				throw error;
			}
		});
		if (marked !== "") return { text: [marked, fence].join("\n"), count: rows.length };
		const after = store.read();
		const now3 = after.broken ? undefined : after.orders.find((x) => x.id === o.id);
		const done = rows.length === 0 ? `Fatto: ho segnato in ${o.id} la merce che era già in magazzino, senza caricarla di nuovo.` : `Fatto: ho caricato in magazzino la merce arrivata con la bolla e l'ho segnata in ${o.id}, come nel riquadro${found.length === 0 ? "" : "; quella che era già in magazzino l'ho solo segnata"}. Quando arriva la fattura, non la carico di nuovo.`;
		return { text: [done, now3 === undefined ? fence : fencedOrders(orderBlock(now3, day, leadOf(loaded.leads)(o.supplier.key)))].join("\n"), count: rows.length + found.length };
	}

	async function brief(ctx: ToolContext, loaded: Loaded, day: string): Promise<string> {
		const late = lateOf(loaded, day);
		const list = suggested(loaded, day, ORDER_LIMITS.cover);
		const reorder = list.length;
		const lateIds = late.length === 0 ? [] : await ctx.step("claim-late", async () => store.claim(`${ctx.callId}:late`, day, late.map((l) => l.order.id), ORDER_LIMITS.briefPerDay, ORDER_LIMITS.briefAgain));
		const reorderSaid = reorder === 0 ? [] : await ctx.step("claim-reorder", async () => store.claim(`${ctx.callId}:reorder`, day, ["reorder"], 1, 1));
		const mine = late.filter((l) => lateIds.includes(l.order.id));
		const said = mine.length + (reorderSaid.length > 0 ? 1 : 0);
		if (said > 0) await audit(ctx, "brief", said);
		return briefAnswer(mine, reorderSaid.length > 0 ? { count: reorder, soon: list.filter((s) => s.why === "soon").length } : { count: 0, soon: 0 }, day);
	}

	/** Another agente: how many, nothing more. */
	function agentCounts(loaded: Loaded, day: string): string {
		const open = loaded.orders.filter(isOpen);
		const drafts = open.filter((o) => o.status === "draft").length;
		const late = lateOf(loaded, day).length;
		const reorder = suggested(loaded, day, ORDER_LIMITS.cover).length;
		return `Ordini ai fornitori: ${n1(open.length, "uno aperto", "# aperti")} (${n1(drafts, "una bozza", "# bozze")}, ${n1(open.length - drafts, "uno inviato", "# inviati")}), ${n1(late, "uno oltre il tempo di consegna", "# oltre il tempo di consegna")}; ${n1(reorder, "un articolo", "# articoli")} da riordinare. A un altro agente do solo i conteggi: fornitori, articoli e prezzi no.`;
	}

	async function run(op: OrderOp, args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<{ text: string; count: number }> {
		switch (op) {
			case "suggest": {
				const cover = coverOf(args);
				if (typeof cover === "string") return { text: cover, count: 0 };
				const list = suggested(loaded, day, cover);
				return { text: suggestAnswer(list, cover, loaded.notes, day), count: list.length };
			}
			case "create":
				return create(args, ctx, loaded, day);
			case "change":
				return change(args, ctx, loaded, day);
			case "mark_sent":
			case "cancel":
				return status(args, ctx, loaded, day, op);
			case "document":
				return document(args, ctx, loaded, day);
			case "received":
				return received(args, ctx, loaded, day);
			case "list": {
				if (args.all !== undefined && typeof args.all !== "boolean") return { text: "Errore: tutti è sì o no.", count: 0 };
				const shown = loaded.orders.filter((o) => args.all === true || isOpen(o)).sort((a, b) => b.id.localeCompare(a.id));
				if (shown.length === 0) return { text: args.all === true ? "Non c'è ancora nessun ordine ai fornitori." : "Nessun ordine aperto: niente in bozza e niente in arrivo.", count: 0 };
				const late = new Set(lateOf(loaded, day).map((l) => l.order.id));
				return { text: [`${n1(shown.length, "Un ordine", "# ordini")}${args.all === true ? "" : " aperti"}${late.size === 0 ? "" : `, ${n1(late.size, "uno oltre il tempo di consegna", "# oltre il tempo di consegna")}`}:`, fencedOrders([...shown.slice(0, ORDER_LIMITS.shown).map((o) => `${orderRow(o, day)}${late.has(o.id) ? ", in ritardo" : ""}`), ...(shown.length > ORDER_LIMITS.shown ? [`e altri ${shown.length - ORDER_LIMITS.shown}`] : [])].join("\n"))].join("\n"), count: shown.length };
			}
			case "status": {
				const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
				if (typeof supplier === "string") return { text: supplier, count: 0 };
				let found: Order[] | string;
				if (args.order === undefined && supplier !== undefined) {
					const mine = asked(loaded.orders, supplier.key);
					found = mine.length > 0 ? mine : [`Non c'è un ordine a questo fornitore.`, fencedOrders(supplier.name)].join("\n");
				} else {
					const one = orderSaid(args, loaded.orders, supplier, () => true, "");
					found = typeof one === "string" ? one : [one];
				}
				if (typeof found === "string") return { text: found, count: 0 };
				const lead = leadOf(loaded.leads);
				const headOf = (o: Order) => {
					const state = orderState(o);
					if (state === "received") return `${o.id} è arrivato tutto.`;
					if (state === "partial") return `${o.id} è arrivato in parte: nel riquadro cosa manca.`;
					if (state === "sent") return `Per me ${o.id} non è ancora arrivato: non ho ancora la fattura del fornitore con questa merce. Se la merce è già arrivata con la bolla, dimmi «è arrivato» e lo segno.`;
					if (state === "draft") return `${o.id} è ancora una bozza: non risulta inviato.`;
					return `${o.id} è annullato.`;
				};
				const head = found.length === 1 ? headOf(found[0] as Order) : `Da questo fornitore aspetti ${found.length} ordini: ${found.map(headOf).join(" ")}`;
				return { text: [head, fencedOrders(found.map((o) => orderBlock(o, day, lead(o.supplier.key))).join("\n"))].join("\n"), count: found.length };
			}
			case "export": {
				if (loaded.orders.length === 0) return { text: "Non c'è ancora nessun ordine da mettere nel file.", count: 0 };
				const path = await ctx.step("path", async () => freePath(workspace, `ordini/ordini-al-${day}`, ".csv"));
				const written = await ctx.step("write", async () => (await workspace.write(path, ordersCsv(loaded.orders))).path);
				return { text: `Salvato ${written}: ${n1(loaded.orders.length, "un ordine", "# ordini")}, una riga per articolo, con quanto è arrivato (separatore «;», decimali con la virgola, si apre con Excel). Mandalo con file_send se chi ti scrive lo vuole.`, count: loaded.orders.length };
			}
			case "lead_time": {
				const supplier = supplierSaid(args.supplier, loaded.suppliers, loaded.orders);
				if (typeof supplier === "string") return { text: supplier, count: 0 };
				if (supplier === undefined) return { text: "Errore: dimmi di quale fornitore è il tempo di consegna.", count: 0 };
				const days = daysSaid(args.days, "il tempo di consegna", ORDER_LIMITS.maxLead);
				if (days === undefined || typeof days === "string") return { text: days ?? "Errore: dimmi in quanti giorni consegna.", count: 0 };
				const refused = requirePersonFor(ctx, "salvo il tempo di consegna del fornitore");
				if (refused !== undefined) return { text: refused, count: 0 };
				await ctx.step("lead", async () => {
					store.update(ctx.callId, (state) => ({ ...state, leads: [...state.leads.filter((l) => l.s !== supplier.key), { s: supplier.key, days }] }));
					return true;
				});
				return { text: [`Fatto: questo fornitore consegna in ${n1(days, "un giorno", "# giorni")}. Un ordine inviato che dopo non è arrivato tutto te lo ricordo nel brief.`, fencedOrders(supplier.name)].join("\n"), count: 1 };
			}
		}
	}

	return [
		{
			name: "orders",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...ORDER_OPS] },
					supplier: text(ORDER_LIMITS.name, "create, change, mark_sent, received, cancel, status, document, lead_time: the supplier, as said or partita IVA"),
					order: text(20, "change, mark_sent, received, cancel, status, document: the order's number (OR-0001), instead of the supplier"),
					day: text(40, "mark_sent: the day it went out; received: the day the goods came; as said («ieri», «16/10»), default today"),
					lines: {
						type: "array",
						maxItems: ORDER_LIMITS.lines,
						description: "create: the articles to order (without: what to reorder); change: the lines to set, quantity 0 takes one off; received: what came, when not all (price when the order has none)",
						items: {
							type: "object",
							properties: {
								item: { type: "string", maxLength: 120, description: "the article of the magazzino: its name as said or MG-0001" },
								quantity: { type: ["number", "string"] },
								unit: { type: "string", maxLength: 10, description: "when not the article's own: its pack («scatole»)" },
								price: { type: ["number", "string"], description: "the price per unit in euros without IVA, only when the person says it" },
							},
							required: ["item", "quantity"],
							additionalProperties: false,
						},
					},
					prefer: { type: "string", enum: ["usual", "cheapest"], description: "create: each article from its usual supplier (default) or the cheapest of the recent prices" },
					cover_days: amount("suggest, create: the days of sales to cover past the minimum (default 30)"),
					days: amount("lead_time: in how many days the supplier delivers"),
					notes: text(ORDER_LIMITS.notes, "change: notes for the supplier («consegna al mattino»)"),
					no_prices: { type: "boolean", description: "change, document: the document without prices (false puts them back)" },
					format: { type: "string", enum: ["pdf", "docx"], description: "document: PDF (default) or Word" },
					all: { type: "boolean", description: "list: every order, the closed ones too" },
					confirm: { type: "boolean", description: "create, received: true only after the person's yes to what was shown" },
					check: text(20, "create, received with confirm: the check given with what the person said yes to"),
					compact: { type: "boolean", description: "list: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!ORDER_OPS.includes(args.op as OrderOp)) return "Errore: non conosco questa operazione sugli ordini.";
				const op = args.op as OrderOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				// Orders name suppliers, articles and prices: another agente gets counts only.
				if (isAgentTurn(ctx) && !["suggest", "list", "status"].includes(op)) return AGENT_REFUSAL;
				const day = todayIn(timeZone, now());
				try {
					const loaded = await load(ctx);
					if (typeof loaded === "string") return loaded;
					if (isAgentTurn(ctx)) return agentCounts(loaded, day);
					if (op === "list" && args.compact === true) return await brief(ctx, loaded, day);
					const answer = await run(op, args, ctx, loaded, day);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof OrderError) return `Errore: ${error.message}.`;
					if (error instanceof StockError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}

