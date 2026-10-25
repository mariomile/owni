import type { OwniTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { euros, n1 } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { dayOfIn, todayIn } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import { inPeriod, PeriodError, readPeriod } from "../periods.ts";
import { findItems, parseItemId, type PriceItem } from "../price-list.ts";
import { PRICE_LIST_BROKEN, type PriceListStore } from "../price-list-store.ts";
import { decimalText, halfUp, scaled } from "../quote-sums.ts";
import { readRegister } from "../register-read.ts";
import { findStockItem, moveId, type Movement, type Pack, type Reason, REASON_WORDS, REASONS, STOCK_LIMITS, STOCK_OPS, stockAgentReads, StockError, type StockItem, stockItemId, type StockOp, stockUnit } from "../stock.ts";
import { STOCK_BROKEN, type StockState, type StockStore } from "../stock-store.ts";
import { costOf, costText, type ItemState, isLow, packUnits, qtyOf, qtyText, stateOf } from "../stock-sums.ts";
import { findSupplier, loadSuppliers, meantSupplier } from "../supplier-find.ts";
import type { SupplierStore } from "../supplier-store.ts";
import { cleanText, isProblem, readAmount } from "../text-input.ts";
import type { PurchaseStore } from "../purchase-store.ts";
import type { OrderLink } from "../order-receive.ts";
import { OrderError } from "../orders.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { receiveInvoice } from "./stock-invoice.ts";
import { BRIEF_NOTHING, briefAnswer, costWords, fencedStock, listAnswer, lowAnswer, movesAnswer, nameOf, NO_ITEMS, qtyNumber, qtyWords, statusAnswer, stockCsv, unitPlural, valueAnswer } from "./stock-render.ts";

/** What changed, for the audit: the op and how many, never names, quantities, costs or suppliers. */
export type StockEvent = { readonly type: "stock.changed"; readonly op: "add_item" | "receive" | "receive_invoice" | "unload" | "count" | "fix_cost" | "remove_item" | "close_year" | "export"; readonly count: number };

export type StockToolsOptions = {
	readonly workspace: Workspace;
	readonly store: StockStore;
	/** The listino, read only: an article may be one of its voci (then an invoice issued with it unloads it). */
	readonly priceList?: Pick<PriceListStore, "read">;
	/** Where a carico's supplier is found, the suppliers' way (supplier-find.ts), read only: the scadenzario through its scanner, the expenses, the supplier cards. Without them the supplier is kept as said. */
	readonly invoices?: Pick<InvoiceStore, "read">;
	readonly scanner?: InvoiceScanner;
	readonly expenses?: Pick<ExpenseStore, "read">;
	readonly suppliers?: Pick<SupplierStore, "read">;
	/** The increases of an invoice's prices already said (purchase_prices'), so the proposal of an invoice received says each once. */
	readonly purchases?: PurchaseStore;
	/** The orders to suppliers: an invoice received loaded marks the goods on the orders awaited from its supplier. */
	readonly orders?: OrderLink;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: StockEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Il magazzino, le quantità (il DDT emesso e le fatture emesse con una voce del listino scaricano da soli, non scaricare a mano; la merce di una fattura ricevuta è receive_invoice; cosa riordinare è orders suggest): the stock of the person's shop or workshop, article by article (MG-0001), from its movements: carichi, scarichi, inventory counts and the credit notes' returns. Quantities may have 3 decimals (kg, m, l). The value is at the weighted average cost, which only a carico changes.",
	"What the person says → op: «ho ricevuto 50 cartucce XL dal fornitore Beta a 12 € l'una» → receive (item, quantity 50, cost 12, supplier; an article not there yet is added by it, with unit and min if said); «3 scatole da 12 a 30 € la scatola» → receive (quantity 3, unit scatole, per_pack 12, pack_cost 30); «la fattura di Beta n. 12: carica la merce in magazzino» → receive_invoice (supplier with invoice or date: «ieri», «18/10», «la più recente»; or file), which first proposes each line's article, quantity and cost with a check: show it, and only after the person's yes repeat with confirm true, the same lines and that check (lines to load only some; to fix one, propose again with lines [{line, item}] for its article, [{line, new: {unit}}] to add it as a new article, each for how many of the article's units one of the invoice's unit is); «aggiungi le cartucce XL al magazzino, a pezzi, avvisami sotto le 10» → add_item (item, unit, min); «avvisami sotto le 10 cartucce» on an article there already → add_item with min; «una scatola ne contiene 12» → add_item with pack_unit and per_pack; «ne ho usate 2 in negozio» → unload (reason uso_interno); «ho buttato 3 rotoli rovinati» → unload (reason scarto); «quante cartucce mi restano?» → status; «cosa ho in magazzino?» → list; «cosa sta finendo?» → low; «quanto vale il magazzino?» → value; «movimenti delle cartucce di ottobre» → movements (item, period); «ho contato 37 cartucce, sistema» → count (item, quantity 37: an adjustment, the history stays as it was); «l'ultimo carico era a 11 €, non 12» → fix_cost; «togli le cartucce dal magazzino» → remove_item; «chiudi il 2025 del magazzino» → close_year; «fammi il file del magazzino» → export, then file_send.",
	"The cost is per unit and without IVA: if the person says it with IVA, or it is unclear, ask once; never take the VAT out yourself. A move to another shelf only changes the article's place (add_item with place): stock split across two places is not kept, say so.",
	"An article that is a voce of the listino (item LS-0001 on add_item) is unloaded by the sales invoices issued with that voce, and put back by their credit notes: never unload a sale invoiced so. price_list is the prices, stock the quantities. A scarico past what there is, and closing a year, ask first: repeat with confirm true only after the person's yes. summary of the brief: low with compact true. Repeat quantities and amounts as given, never compute them yourself.",
].join(" ");

/** «sotto i 10», «sotto 1». */
const underWords = (min: string) => (Number(min) === 1 ? "sotto 1" : `sotto i ${decimalText(min)}`);

/**
 * Il magazzino (stock.ts): the articles and their movements kept here, the listino and the
 * suppliers read only. add_item, receive, unload, count, fix_cost, remove_item, close_year and
 * the export change something (and the brief's low, which marks its alerts as said); the rest
 * only reads. Today is read once per call.
 */
export function createStockTools(options: StockToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: StockEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "stock.changed", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const amount = (description: string) => ({ type: ["number", "string"], description });
	/** What receive_invoice reads and writes through this tool. */
	const invoiceEnv = {
		store,
		book: () => book(),
		register: async (ctx: ToolContext) => {
			if (options.invoices === undefined) return "Qui non vedo le fatture ricevute.";
			const read = await readRegister(options.invoices, options.scanner ?? new InvoiceScanner(workspace), ctx, {
				broken: "Lo stato delle fatture non si legge: senza, non so quali sono le fatture ricevute.",
				noCompany: "Non so ancora qual è la tua azienda (la sua partita IVA): senza, non distinguo le fatture ricevute da quelle emesse.",
			});
			if (read.invoices === undefined || read.noCompany) return read.notes.join("\n") || "Non trovo fatture ricevute nel workspace.";
			const cards = options.suppliers?.read();
			const expenses = options.expenses?.read();
			const loaded = loadSuppliers({ cards: cards === undefined || cards.broken ? [] : cards.cards, invoices: read.invoices, expenses: expenses === undefined || expenses.broken ? [] : expenses.expenses, dayOf: dayOfIn(timeZone) });
			return { invoices: read.invoices, suppliers: loaded.suppliers };
		},
		...(options.purchases === undefined ? {} : { purchases: options.purchases }),
		...(options.orders === undefined ? {} : { orders: options.orders }),
		marker,
		audit: (ctx: ToolContext, count: number) => audit(ctx, "receive_invoice", count),
	};

	return [
		{
			name: "stock",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...STOCK_OPS] },
					item: text(STOCK_LIMITS.name, "the article: its name as said, its id MG-0001, its code, or (add_item) a voce of the listino LS-0001"),
					unit: text(STOCK_LIMITS.unit, "add_item, receive (new article): pezzi, kg, m, litri… (default: the listino's unit, else pezzi); receive, unload: the unit the quantity is said in, when not the article's («scatole»)"),
					min: amount("add_item, receive: the minimum level, under it the article is sottoscorta («avvisami sotto le 10»); 0 removes it"),
					code: text(STOCK_LIMITS.code, "add_item: the person's own code or SKU"),
					place: text(STOCK_LIMITS.place, "add_item: where it is kept («scaffale B»): one place per article"),
					category: text(STOCK_LIMITS.category, "add_item: a category, for the value by category"),
					pack_unit: text(STOCK_LIMITS.unit, "add_item: the article's pack («scatola»), with per_pack"),
					per_pack: amount("add_item: how many units in the article's pack; receive, unload: how many units in each pack said («3 scatole da 12»: quantity 3, per_pack 12)"),
					quantity: amount("receive, unload: how many (packs, with per_pack); count: how many were counted"),
					cost: amount("receive, fix_cost: the cost of one unit in euros, without IVA («12», «0,85»)"),
					pack_cost: amount("receive: the cost of one pack in euros, without IVA, instead of cost"),
					supplier: text(STOCK_LIMITS.name, "receive, receive_invoice: the supplier, as said or partita IVA"),
					invoice: text(40, "receive_invoice: the number of the invoice received"),
					date: text(40, "receive_invoice: the invoice's day as said («ieri», «18/10», «la più recente»), with the supplier"),
					check: text(20, "receive_invoice with confirm: the check given with the proposal the person said yes to"),
					file: text(300, "receive_invoice: the invoice's file in the workspace, instead of supplier and number"),
					lines: {
						type: "array",
						maxItems: 500,
						description: "receive_invoice: only these lines (by number), each maybe with item (its article: MG-0001 or the name), new (add an article named as the line, in this unit), each (how many of the article's units is one of the line's unit)",
						items: {
							type: "object",
							properties: {
								line: { type: "integer" },
								item: { type: "string", maxLength: STOCK_LIMITS.name },
								new: { type: "object", properties: { unit: { type: "string", maxLength: STOCK_LIMITS.unit } }, additionalProperties: false },
								each: { type: ["number", "string"] },
							},
							required: ["line"],
							additionalProperties: false,
						},
					},
					doc: text(STOCK_LIMITS.doc, "receive: the document's reference (DDT, invoice number)"),
					reason: { type: "string", enum: [...REASONS], description: "unload: why: vendita, uso_interno, reso (to the supplier), scarto" },
					note: text(STOCK_LIMITS.note, "receive, unload, count: a short note"),
					period: text(40, "movements: «ottobre», «questo mese», «2026»"),
					year: { type: "integer", description: "close_year: the year to close (its movements become one apertura per article)" },
					confirm: { type: "boolean", description: "unload: the person said yes to going under zero; close_year, receive_invoice: the person said yes" },
					compact: { type: "boolean", description: "low: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!STOCK_OPS.includes(args.op as StockOp)) return "Errore: non conosco questa operazione sul magazzino.";
				const op = args.op as StockOp;
				for (const key of ["compact", "confirm"]) if (args[key] !== undefined && typeof args[key] !== "boolean") return `Errore: ${key === "compact" ? "compact" : "la conferma"} è sì o no.`;
				// Another agente's request is not the person's word: names and quantities, nothing else.
				const agent = isAgentTurn(ctx);
				if (agent && !stockAgentReads(args)) return "Errore: a un altro agente do solo l'elenco degli articoli e cosa sta finendo, con nomi e quantità. Non do costi, valori, fornitori o movimenti e non cambio niente; il resto lo chiede chi ti scrive, nella sua conversazione.";
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "add_item":
							return await addItem(args, ctx);
						case "receive":
							return await receive(args, ctx, day);
						case "receive_invoice":
							return await receiveInvoice(invoiceEnv, args, ctx, day);
						case "unload":
							return await unload(args, ctx, day);
						case "count":
							return await count(args, ctx, day);
						case "fix_cost":
							return await fixCost(args, ctx, day);
						case "status":
							return status(args);
						case "list":
							return listAnswer(states(), agent);
						case "low":
							return args.compact === true ? await brief(ctx) : lowAnswer(states(), agent);
						case "value":
							return valueAnswer(states());
						case "movements":
							return movements(args, day);
						case "remove_item":
							return await removeItem(args, ctx);
						case "close_year":
							return await closeYear(args, ctx, day);
						case "export":
							return await exportCsv(ctx, day);
					}
				} catch (error) {
					if (error instanceof StockError) return `Errore: ${error.message}.`;
					if (error instanceof OrderError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function book() {
		const b = store.read();
		if (b.broken) throw new StockError(STOCK_BROKEN);
		return b;
	}

	function active(items: readonly StockItem[]): StockItem[] {
		return items.filter((i) => i.removed === undefined);
	}

	function states(): ItemState[] {
		const b = book();
		return active(b.items).map((i) => stateOf(i, b.moves));
	}

	type Named = { readonly item: StockItem; readonly took?: string };

	/** The question when the words fit more than one article. */
	function which(close: readonly StockItem[]): string {
		return [close.length === 1 ? "Intendi questo articolo? Nessuno si chiama esattamente così:" : "Intendi uno di questi? Più articoli vanno bene con queste parole:", fencedStock(close.slice(0, 8).map((i) => `• ${i.name} (${i.id})`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il suo numero."].join("\n");
	}

	/** The line said when a read took the article from other words: outside the fence, so it is said; the name stays inside. */
	function tookLine(item: StockItem): string {
		return `Ho preso l'articolo ${item.id} (nel riquadro): dillo a chi ti scrive.`;
	}

	/**
	 * The article an op names, or the answer to give instead. A name that is not the article's own
	 * (other words, the other number) is asked about before a change (`write`): «Intendi questo
	 * articolo?», confirmed by its number; a read takes it, with the line to say.
	 */
	function named(args: Record<string, unknown>, items: readonly StockItem[], write: boolean): Named | string {
		const said = cleanText(args.item, STOCK_LIMITS.name, "il nome dell'articolo");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi quale articolo: il nome, o il suo numero (MG-0001).";
		const f = findStockItem(active(items), said);
		if (f === "none") return ["Non trovo questo articolo in magazzino:", fencedStock(said), "Chiedi a chi ti scrive se va aggiunto, con la sua unità (pezzi, kg, metri, litri)."].join("\n");
		if ("close" in f) return which(f.close);
		if (f.respelled && write) return which([f.item]);
		return { item: f.item, ...(f.respelled ? { took: tookLine(f.item) } : {}) };
	}

	function readQuantity(value: unknown, what: string, zero: boolean): string | { problem: string } {
		const read = readAmount(value, 3, what, fencedStock);
		if (read === undefined) return { problem: `dimmi ${what}` };
		if (isProblem(read)) return read;
		if ((!zero && Number(read) <= 0) || Number(read) > STOCK_LIMITS.maxQuantity) return { problem: `${what}: un numero ${zero ? "da zero" : "maggiore di zero"} a ${STOCK_LIMITS.maxQuantity.toLocaleString("it-IT")}, al più 3 decimali` };
		return read;
	}

	/** The voce of the listino `said` is: by its id, or by its exact name; undefined when none. */
	function listinoOf(said: string): PriceItem | string | undefined {
		if (options.priceList === undefined) return parseItemId(said) === undefined ? undefined : "Errore: qui non vedo il listino.";
		const list = options.priceList.read();
		if (list.broken) return parseItemId(said) === undefined ? undefined : `Errore: ${PRICE_LIST_BROKEN}.`;
		const f = findItems(list.items, said);
		if (parseItemId(said) !== undefined) return f.kind === "exact" ? f.item : "Errore: nel listino non c'è una voce con questo numero.";
		return f.kind === "exact" && f.slip !== true ? f.item : undefined;
	}

	/** The pack an article is given on add_item (pack_unit and per_pack), or why not. */
	function readPack(args: Record<string, unknown>, unit: string | undefined): Pack | undefined | string {
		if (args.pack_unit === undefined) return args.per_pack === undefined ? undefined : "Errore: dimmi anche come si chiama la confezione (scatola, cartone…).";
		const word = cleanText(args.pack_unit, STOCK_LIMITS.unit, "la confezione");
		if (isProblem(word) || word === undefined) return `Errore: ${isProblem(word) ? word.problem : "dimmi la confezione"}.`;
		const size = readQuantity(args.per_pack, "quanti ne contiene una confezione", false);
		if (isProblem(size)) return `Errore: ${size.problem}.`;
		const packUnit = stockUnit(word);
		if (unit !== undefined && packUnit === unit) return "Errore: la confezione è un'altra unità da quella dell'articolo.";
		return { unit: packUnit, size };
	}

	/** What the voce says of a new article: its unit, unless a forfait. */
	function voceUnit(voce: PriceItem | undefined): string | undefined {
		return voce?.unit === undefined || voce.unit === "forfait" ? undefined : stockUnit(voce.unit);
	}

	/** How «si conta» an article is said: «si conta a pezzi, ti avviso sotto i 10». */
	function counting(item: StockItem): string {
		return `si conta a ${unitPlural(item.unit)}${item.min === undefined ? ", senza un minimo per gli avvisi" : `, ti avviso ${underWords(item.min)}`}${item.pack === undefined ? "" : `, ogni ${item.pack.unit} ne contiene ${decimalText(item.pack.size)}`}`;
	}

	async function addItem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const said = cleanText(args.item, STOCK_LIMITS.name, "il nome dell'articolo");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi il nome dell'articolo, o la voce del listino (LS-0001).";
		const code = cleanText(args.code, STOCK_LIMITS.code, "il codice");
		if (isProblem(code)) return `Errore: ${code.problem}.`;
		const place = cleanText(args.place, STOCK_LIMITS.place, "il posto");
		if (isProblem(place)) return `Errore: ${place.problem}.`;
		const category = cleanText(args.category, STOCK_LIMITS.category, "la categoria");
		if (isProblem(category)) return `Errore: ${category.problem}.`;
		const unitSaid = cleanText(args.unit, STOCK_LIMITS.unit, "l'unità");
		if (isProblem(unitSaid)) return `Errore: ${unitSaid.problem}.`;
		const min = args.min === undefined ? undefined : readQuantity(args.min, "il minimo", true);
		if (isProblem(min)) return `Errore: ${min.problem}.`;
		const voce = listinoOf(said);
		if (typeof voce === "string") return voce;
		const b = book();
		const by = marker(ctx);
		// The same article said again (by name, code, id or voce): its minimum, place, category, code, pack change.
		const there = findStockItem(active(b.items), said, true);
		if (typeof there === "object" && "close" in there) return which(there.close);
		const old = typeof there === "object" ? there.item : voce === undefined ? undefined : active(b.items).find((i) => i.listino === voce.id);
		const unit = unitSaid === undefined ? undefined : stockUnit(unitSaid);
		const pack = readPack(args, unit ?? old?.unit ?? voceUnit(voce) ?? "pezzo");
		if (typeof pack === "string") return pack;
		const applied = await ctx.step("apply", async () => {
			let id = "";
			let changed = false;
			const outcome = store.update(ctx.callId, (state): StockState => {
				const now = old === undefined ? undefined : state.items.find((i) => i.id === old.id && i.removed === undefined);
				if (old !== undefined && now === undefined) throw new StockError("l'articolo è stato tolto nel frattempo");
				if (now !== undefined) {
					id = now.id;
					if (unit !== undefined && unit !== now.unit && state.moves.some((m) => m.item === now.id)) throw new StockError(`questo articolo ha già movimenti a ${unitPlural(now.unit)}: l'unità non si cambia più`);
					const { min: _min, ...rest } = now;
					const next: StockItem = {
						...rest,
						...(min === undefined ? (now.min === undefined ? {} : { min: now.min }) : Number(min) === 0 ? {} : { min }),
						...(unit === undefined ? {} : { unit }),
						...(code === undefined ? {} : { code }),
						...(place === undefined ? {} : { place }),
						...(category === undefined ? {} : { category }),
						...(pack === undefined ? {} : { pack }),
					};
					if (JSON.stringify(next) === JSON.stringify(now)) return state;
					changed = true;
					clash(state.items, next);
					return { ...state, items: state.items.map((i) => (i.id === now.id ? { ...next, edited: by } : i)) };
				}
				const made = newItem(state, voce, said, unit, min, { code, place, category, pack }, ctx, by);
				id = made.id;
				changed = true;
				return { ...state, nextItem: state.nextItem + 1, items: [...state.items, made] };
			});
			if (outcome === "rerun") return { id: book().items.find((i) => i.callId === ctx.callId)?.id ?? old?.id ?? "", changed: true, created: old === undefined };
			return { id, changed, created: old === undefined };
		});
		if (applied.changed) await audit(ctx, "add_item", 1);
		const item = book().items.find((i) => i.id === applied.id);
		if (item === undefined) return "Fatto.";
		const s = stateOf(item, book().moves);
		const lines = [
			!applied.changed
				? `Era già così, non ho cambiato niente: l'articolo (${item.id}) ${counting(item)}.`
				: applied.created
					? `Fatto, ho aggiunto l'articolo (${item.id}): ${counting(item)}.`
					: `Fatto, ho aggiornato l'articolo (${item.id}): ${counting(item)}; ora ${qtyWords(s.onHand, item.unit)}.`,
		];
		if (applied.created && unit === undefined && item.listino === undefined) lines.push("Se non si conta a pezzi (kg, metri, litri), dimmelo.");
		if (item.listino !== undefined && applied.created) lines.push(`È la voce ${item.listino} del listino: le fatture emesse con quella voce lo scaricano da sole, e le note di credito lo rimettono.`);
		if (applied.created) lines.push("Per caricare la merce dimmi quanta e a che costo per unità, senza IVA.");
		lines.push(fencedStock(`Articolo: ${item.name}${item.code === undefined ? "" : `, codice ${item.code}`}${item.place === undefined ? "" : `, posto: ${item.place}`}${item.category === undefined ? "" : `, categoria: ${item.category}`}`));
		return lines.join("\n");
	}

	/** A new article, numbered from `state`: from the voce of the listino when there is one. */
	function newItem(state: StockState, voce: PriceItem | undefined, said: string, unit: string | undefined, min: string | undefined, more: { code?: string; place?: string; category?: string; pack?: Pack }, ctx: ToolContext, by: Marker): StockItem {
		if (active(state.items).length >= STOCK_LIMITS.items) throw new StockError(`ci sono già ${STOCK_LIMITS.items} articoli, il massimo: togline qualcuno prima`);
		const made: StockItem = {
			id: stockItemId(state.nextItem),
			name: (voce?.name ?? said).slice(0, STOCK_LIMITS.name),
			unit: unit ?? voceUnit(voce) ?? "pezzo",
			...(min === undefined || Number(min) === 0 ? {} : { min }),
			...(more.code === undefined ? {} : { code: more.code }),
			...(more.place === undefined ? {} : { place: more.place }),
			...(more.category === undefined ? {} : { category: more.category }),
			...(more.pack === undefined ? {} : { pack: more.pack }),
			...(voce === undefined ? {} : { listino: voce.id }),
			callId: ctx.callId,
			...by,
		};
		clash(state.items, made);
		return made;
	}

	/** Name, code and voce are one article's on the list. */
	function clash(items: readonly StockItem[], next: StockItem): void {
		const others = active(items).filter((i) => i.id !== next.id);
		if (others.some((i) => spellingKey(i.name) === spellingKey(next.name))) throw new StockError("c'è già un articolo con questo nome");
		if (next.code !== undefined && others.some((i) => i.code?.toLowerCase() === next.code?.toLowerCase())) throw new StockError("questo codice è già di un altro articolo");
		if (next.listino !== undefined && others.some((i) => i.listino === next.listino)) throw new StockError(`la voce ${next.listino} del listino è già un altro articolo`);
	}

	/** The supplier said for a carico: the one found the suppliers' way, as said when none is, or what to ask when it may be more than one. */
	async function supplierOf(said: string, ctx: ToolContext): Promise<{ name: string; vat?: string; note?: string } | string> {
		if (options.invoices === undefined && options.suppliers === undefined) return { name: said };
		const read = options.invoices === undefined ? undefined : await readRegister(options.invoices, options.scanner ?? new InvoiceScanner(workspace), ctx);
		const cards = options.suppliers?.read();
		const expenses = options.expenses?.read();
		const loaded = loadSuppliers({ cards: cards === undefined || cards.broken ? [] : cards.cards, invoices: read?.invoices ?? [], expenses: expenses === undefined || expenses.broken ? [] : expenses.expenses, dayOf: dayOfIn(timeZone) });
		const f = findSupplier(loaded.suppliers, said);
		if (f.kind === "close") return meantSupplier(f.candidates, fencedStock);
		if (f.kind === "none") return { name: said, note: "Il fornitore non è tra quelli che conosco: l'ho segnato come detto." };
		return { name: f.supplier.name.slice(0, STOCK_LIMITS.name), ...(f.supplier.vat === undefined ? {} : { vat: f.supplier.vat }) };
	}

	/** A quantity in the article's units, with how packs made it («3 scatole da 12 = 36 pezzi»). */
	type Units = { readonly qty: bigint; readonly packs?: { readonly said: string; readonly size: string; readonly word: string } };

	/**
	 * The quantity said, in the article's units: as it is; in packs of per_pack (or of the
	 * article's own pack, said by its name), times the pack, exactly; in another unit with no pack
	 * to turn it, the question.
	 */
	function unitsOf(args: Record<string, unknown>, item: Pick<StockItem, "unit" | "pack">, what: string): Units | string {
		const quantity = readQuantity(args.quantity, what, false);
		if (isProblem(quantity)) return `Errore: ${quantity.problem}.`;
		const unitSaid = cleanText(args.unit, STOCK_LIMITS.unit, "l'unità");
		if (isProblem(unitSaid)) return `Errore: ${unitSaid.problem}.`;
		const unit = unitSaid === undefined ? undefined : stockUnit(unitSaid);
		let size: string | undefined;
		let word = "";
		if (args.per_pack !== undefined) {
			const per = readQuantity(args.per_pack, "quanti ne contiene ogni confezione", false);
			if (isProblem(per)) return `Errore: ${per.problem}.`;
			size = per;
			word = unit !== undefined && unit !== item.unit ? unit : (item.pack?.unit ?? "confezione");
		} else if (unit !== undefined && unit !== item.unit) {
			if (item.pack === undefined || unit !== item.pack.unit) return `Questo articolo si conta a ${unitPlural(item.unit)}: ${qtyWords(qtyOf(quantity), unit)} quanti ${unitPlural(item.unit)} sono? Chiedilo a chi ti scrive, poi ripeti con quanti ne contiene ognuna.`;
			size = item.pack.size;
			word = item.pack.unit;
		}
		if (size === undefined) return { qty: qtyOf(quantity) };
		const qty = packUnits(quantity, size);
		if (qty === undefined || qty > scaled(String(STOCK_LIMITS.maxQuantity), 3)) return `Errore: ${decimalText(quantity)} per ${decimalText(size)} non viene un numero che so tenere (al più 3 decimali).`;
		return { qty, packs: { said: `${qtyWords(qtyOf(quantity), word)} da ${decimalText(size)} = ${qtyWords(qty, item.unit)}`, size, word } };
	}

	/** The cost of one unit (ten-thousandths): said for the unit, or for the pack and divided, half up to the fourth decimal (and said when it is not exact). */
	function unitCost(args: Record<string, unknown>, units: Units, unit: string): { cost: bigint; said?: string } | string {
		if (args.cost !== undefined && args.pack_cost !== undefined) return "Errore: dimmi il costo per unità oppure quello per confezione, non tutti e due.";
		const raw = args.pack_cost ?? args.cost;
		if (raw === undefined) return "Errore: dimmi il costo per unità, senza IVA: serve per il costo medio e il valore del magazzino.";
		const read = readAmount(raw, 4, args.pack_cost === undefined ? "il costo per unità" : "il costo per confezione", fencedStock);
		if (read === undefined || isProblem(read)) return `Errore: ${read?.problem ?? "dimmi il costo"}.`;
		if (Number(read) <= 0) return "Errore: il costo è più di zero.";
		let cost = costOf(read);
		let said: string | undefined;
		if (args.pack_cost !== undefined) {
			if (units.packs === undefined) return "Errore: dimmi quanti ne contiene ogni confezione, per fare il costo per unità.";
			const size = scaled(units.packs.size, 3);
			const exact = (cost * 1000n) % size === 0n;
			cost = halfUp(cost * 1000n, size);
			said = `${costWords(costOf(read))} per ${units.packs.word} da ${decimalText(units.packs.size)}: ${costWords(cost)} per ${unit}${exact ? "" : " (arrotondato al centesimo di centesimo)"}`;
		}
		if (cost <= 0n || cost > costOf(String(STOCK_LIMITS.maxCost))) return `Errore: il costo per unità va da più di zero a ${STOCK_LIMITS.maxCost.toLocaleString("it-IT")} €.`;
		return { cost, ...(said === undefined ? {} : { said }) };
	}

	async function receive(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const said = cleanText(args.item, STOCK_LIMITS.name, "il nome dell'articolo");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi quale articolo è arrivato.";
		const f = findStockItem(active(b.items), said);
		if (typeof f === "object" && "close" in f) return which(f.close);
		// Other words for an article there: asked, never loaded onto it (nor a new one made) on a guess.
		if (typeof f === "object" && f.respelled) return which([f.item]);
		const found = f === "none" ? undefined : f;
		// Nothing there by these words: the carico adds the article, from the voce of the listino of the same name when there is one.
		const voce = found === undefined ? listinoOf(said) : undefined;
		if (typeof voce === "string") return voce;
		const unitSaid = cleanText(args.unit, STOCK_LIMITS.unit, "l'unità");
		if (isProblem(unitSaid)) return `Errore: ${unitSaid.problem}.`;
		const min = args.min === undefined ? undefined : readQuantity(args.min, "il minimo", true);
		if (isProblem(min)) return `Errore: ${min.problem}.`;
		// A new article in packs: its unit is the voce's or pezzo, its pack the one said.
		const newUnit = args.per_pack !== undefined ? (voceUnit(voce) ?? "pezzo") : unitSaid === undefined ? (voceUnit(voce) ?? "pezzo") : stockUnit(unitSaid);
		const perPack = args.per_pack === undefined ? undefined : readQuantity(args.per_pack, "quanti ne contiene ogni confezione", false);
		if (isProblem(perPack)) return `Errore: ${perPack.problem}.`;
		const newPack: Pack | undefined = found === undefined && perPack !== undefined && unitSaid !== undefined && stockUnit(unitSaid) !== newUnit ? { unit: stockUnit(unitSaid), size: perPack } : undefined;
		const shape = found?.item ?? { unit: newUnit, ...(newPack === undefined ? {} : { pack: newPack }) };
		const units = unitsOf(args, shape, "quanti ne sono arrivati");
		if (typeof units === "string") return units;
		const cost = unitCost(args, units, shape.unit);
		if (typeof cost === "string") return cost;
		const doc = cleanText(args.doc, STOCK_LIMITS.doc, "il documento");
		if (isProblem(doc)) return `Errore: ${doc.problem}.`;
		const note = cleanText(args.note, STOCK_LIMITS.note, "la nota");
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		if (found !== undefined && stateOf(found.item, b.moves).onHand + units.qty > scaled(String(STOCK_LIMITS.maxQuantity), 3)) return `Errore: con questo carico ne risulterebbero più di ${STOCK_LIMITS.maxQuantity.toLocaleString("it-IT")}, il massimo che tengo per un articolo. Controlla la quantità con chi ti scrive.`;
		// A wrong cost cannot be taken back: only the person's own turn records one.
		const refused = requirePersonFor(ctx, "registro un carico con il suo costo");
		if (refused !== undefined) return refused;
		const supplierSaid = cleanText(args.supplier, STOCK_LIMITS.name, "il fornitore");
		if (isProblem(supplierSaid)) return `Errore: ${supplierSaid.problem}.`;
		const supplier = supplierSaid === undefined ? undefined : await supplierOf(supplierSaid, ctx);
		if (typeof supplier === "string") return supplier;
		const by = marker(ctx);
		const before = found === undefined ? undefined : stateOf(found.item, b.moves);
		const written = await ctx.step("apply", async () => {
			let made = { item: found?.item.id ?? "", move: "", created: false };
			const outcome = store.update(ctx.callId, (state) => {
				let items = state.items;
				let nextItem = state.nextItem;
				let item: StockItem;
				if (found === undefined) {
					item = newItem(state, voce, said, newUnit, min, { ...(newPack === undefined ? {} : { pack: newPack }) }, ctx, by);
					items = [...items, item];
					nextItem += 1;
				} else {
					const now = items.find((i) => i.id === found.item.id && i.removed === undefined);
					if (now === undefined) throw new StockError("l'articolo è stato tolto nel frattempo");
					item = now;
					if (min !== undefined && min !== now.min) {
						const { min: _old, ...rest } = now;
						item = { ...rest, ...(Number(min) === 0 ? {} : { min }), edited: by };
						items = items.map((i) => (i.id === now.id ? item : i));
					}
					if (stateOf(now, state.moves).onHand + units.qty > scaled(String(STOCK_LIMITS.maxQuantity), 3)) throw new StockError(`con questo carico ne risulterebbero più di ${STOCK_LIMITS.maxQuantity.toLocaleString("it-IT")}, il massimo che tengo per un articolo`);
				}
				const m: Movement = {
					id: moveId(state.nextMove),
					item: item.id,
					kind: "carico",
					qty: qtyText(units.qty),
					day,
					cost: costText(cost.cost),
					...(supplier === undefined ? {} : { supplier: { name: supplier.name, ...(supplier.vat === undefined ? {} : { vat: supplier.vat }) } }),
					...(doc === undefined ? {} : { doc }),
					...(note === undefined ? {} : { note }),
					callId: ctx.callId,
					...by,
				};
				made = { item: item.id, move: m.id, created: found === undefined };
				return { nextItem, nextMove: state.nextMove + 1, items, moves: [...state.moves, m] };
			});
			if (outcome === "rerun") {
				const mine = book().moves.find((m) => m.callId === ctx.callId);
				return { item: mine?.item ?? "", move: mine?.id ?? "", created: book().items.some((i) => i.callId === ctx.callId) };
			}
			return made;
		});
		await audit(ctx, "receive", 1);
		const now = book();
		const item = now.items.find((i) => i.id === written.item);
		if (item === undefined) return "Fatto.";
		const after = stateOf(item, now.moves);
		const amount = units.packs === undefined ? qtyWords(units.qty, item.unit) : units.packs.said;
		const priced = `${amount} a ${costWords(cost.cost)} per unità, senza IVA`;
		const totals = `Ora ${qtyWords(after.onHand, item.unit)}, costo medio ${after.average === undefined ? "da sapere" : costWords(after.average)}${before?.average !== undefined && after.average !== before.average ? ` (era ${costWords(before.average)})` : ""}, valore ${euros(after.value ?? 0n)}.`;
		const lines = written.created
			? [`Fatto: ho aggiunto l'articolo (${item.id}, nel riquadro) al magazzino, a ${unitPlural(item.unit)}${item.listino === undefined ? "" : ` (è la voce ${item.listino} del listino)`}${item.min === undefined ? "" : `, con l'avviso ${underWords(item.min)}`}, e caricato ${priced}. ${totals}`]
			: [`Fatto, ho caricato ${priced}. ${totals}`];
		if (cost.said !== undefined) lines.push(`Il costo: ${cost.said}.`);
		if (supplier?.note !== undefined) lines.push(supplier.note);
		const inside = [`Articolo: ${item.name}`, ...(supplier === undefined ? [] : [`Fornitore: ${supplier.name}`]), ...(doc === undefined ? [] : [`Documento: ${doc}`]), ...(note === undefined ? [] : [`Nota: ${note}`])];
		lines.push(fencedStock(inside.join("\n")));
		return lines.join("\n");
	}

	/** A movement written once per call (the step keeps its id): the one this call wrote, run again. */
	async function write(ctx: ToolContext, item: StockItem, make: (id: string, state: StockState) => Omit<Movement, "by" | "at">, check?: (state: StockState) => void): Promise<Movement> {
		const by = marker(ctx);
		const id = await ctx.step("apply", async () => {
			let made = "";
			const outcome = store.update(ctx.callId, (state) => {
				if (!state.items.some((i) => i.id === item.id && i.removed === undefined)) throw new StockError("l'articolo è stato tolto nel frattempo");
				check?.(state);
				const m = { ...make(moveId(state.nextMove), state), callId: ctx.callId, ...by } as Movement;
				made = m.id;
				return { ...state, nextMove: state.nextMove + 1, moves: [...state.moves, m] };
			});
			if (outcome === "rerun") return book().moves.find((m) => m.callId === ctx.callId)?.id ?? "";
			return made;
		});
		const move = book().moves.find((m) => m.id === id);
		if (move === undefined) throw new StockError("il movimento non risulta salvato");
		return move;
	}

	async function unload(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const n = named(args, b.items, true);
		if (typeof n === "string") return n;
		const item = n.item;
		const units = unitsOf(args, item, "quanti ne sono usciti");
		if (typeof units === "string") return units;
		if (!REASONS.some((r) => r === args.reason)) return "Errore: dimmi perché escono: vendita, uso interno, reso al fornitore o scarto.";
		const reason = args.reason as Reason;
		const note = cleanText(args.note, STOCK_LIMITS.note, "la nota");
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const q = units.qty;
		const mine = b.moves.find((m) => m.callId === ctx.callId);
		const before = stateOf(item, b.moves);
		const yes = args.confirm === true && ctx.origin === "person";
		// Past what there is: asked once, recorded only with the person's yes, in a turn of theirs.
		if (mine === undefined && before.onHand - q < 0n) {
			if (args.confirm !== true)
				return [
					`Di questo articolo (nel riquadro) ne risultano ${qtyWords(before.onHand, item.unit)}: togliendone ${qtyNumber(q)} il magazzino andrebbe a ${qtyNumber(before.onHand - q)}. Chiedi a chi ti scrive se va bene lo stesso (di solito manca un carico); con il suo sì ripeti con la conferma, e resta segnato in negativo fino al prossimo conteggio.`,
					fencedStock([`Articolo: ${nameOf(item)}`].join("\n")),
				].join("\n");
			const refused = requirePersonFor(ctx, "registro uno scarico che manda il magazzino in negativo");
			if (refused !== undefined) return refused;
		}
		await write(
			ctx,
			item,
			(id) => ({ id, item: item.id, kind: "scarico", qty: qtyText(q), day, reason, ...(note === undefined ? {} : { note }) }),
			(state) => {
				// Changed meanwhile: past zero now, without the person's own yes.
				if (!yes && stateOf(item, state.moves).onHand - q < 0n) throw new StockError("nel frattempo la quantità è cambiata e questo scarico manderebbe l'articolo in negativo: ricontrolla con chi ti scrive");
			},
		);
		await audit(ctx, "unload", 1);
		const after = stateOf(item, book().moves);
		const lines = [`Fatto, ho scaricato ${units.packs === undefined ? qtyWords(q, item.unit) : units.packs.said} (${REASON_WORDS[reason]}). Ora ${qtyWords(after.onHand, item.unit)}.`];
		if (after.negative) lines.push("È in negativo: resta segnato così fino al prossimo conteggio.");
		else if (after.lowSince !== undefined) lines.push("Ora è sottoscorta.");
		if (reason === "vendita" && item.listino !== undefined) lines.push(`Attenzione: questo articolo è la voce ${item.listino} del listino, e le fatture emesse con quella voce lo scaricano da sole. Se questa vendita ha una fattura così, è contata due volte: dillo a chi ti scrive.`);
		lines.push(fencedStock([`Articolo: ${item.name}`, ...(note === undefined ? [] : [`Nota: ${note}`])].join("\n")));
		return lines.join("\n");
	}

	async function count(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const n = named(args, b.items, true);
		if (typeof n === "string") return n;
		const item = n.item;
		const counted = readQuantity(args.quantity, "quanti ne hai contati", true);
		if (isProblem(counted)) return `Errore: ${counted.problem}.`;
		const refused = requirePersonFor(ctx, "correggo il magazzino con un conteggio");
		if (refused !== undefined) return refused;
		const note = cleanText(args.note, STOCK_LIMITS.note, "la nota");
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const before = stateOf(item, b.moves);
		// The difference from what there is as saved when it is written: a movement meanwhile counts.
		const move = await write(ctx, item, (id, state) => ({ id, item: item.id, kind: "rettifica", qty: qtyText(qtyOf(counted) - stateOf(item, state.moves).onHand), day, counted, ...(note === undefined ? {} : { note }) }));
		await audit(ctx, "count", 1);
		const d = qtyOf(move.qty);
		const c = qtyWords(qtyOf(counted), item.unit);
		const lines = [d === 0n ? `Fatto, ho segnato il conteggio: ${c}, corrisponde a quello che risultava.` : `Fatto, ho corretto il magazzino con il conteggio: contati ${c}, ${d < 0n ? `ne mancano ${qtyNumber(-d)}` : `ce ne sono ${qtyNumber(d)} in più`}.`];
		if (before.negative) lines.push("Non è più in negativo.");
		const after = stateOf(item, book().moves);
		if (after.lowSince !== undefined) lines.push("È sottoscorta.");
		lines.push(fencedStock([`Articolo: ${item.name}`, ...(note === undefined ? [] : [`Nota: ${note}`])].join("\n")));
		return lines.join("\n");
	}

	/**
	 * The cost of the article's last carico corrected: a costo movement, so the average is worked
	 * out again as if that carico had always had the right cost. Only the last one, and only the
	 * person's own turn.
	 */
	async function fixCost(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const b = book();
		const n = named(args, b.items, true);
		if (typeof n === "string") return n;
		const item = n.item;
		const before = stateOf(item, b.moves);
		const last = before.lastCarico;
		if (last === undefined) return "Di questo articolo non c'è un carico da correggere (o è in un anno già chiuso).";
		const cost = unitCost({ cost: args.cost }, { qty: 0n }, item.unit);
		if (typeof cost === "string") return cost;
		if (cost.cost === costOf(last.cost)) return `L'ultimo carico era già a ${costWords(cost.cost)} per unità: non ho cambiato niente.`;
		const refused = requirePersonFor(ctx, "correggo il costo di un carico");
		if (refused !== undefined) return refused;
		await write(
			ctx,
			item,
			(id) => ({ id, item: item.id, kind: "costo", qty: "0", day, cost: costText(cost.cost), was: last.cost, fixes: last.move.id }),
			(state) => {
				if (stateOf(item, state.moves).lastCarico?.move.id !== last.move.id) throw new StockError("nel frattempo è arrivato un altro carico: ricontrolla con chi ti scrive quale correggere");
			},
		);
		await audit(ctx, "fix_cost", 1);
		const after = stateOf(item, book().moves);
		return [
			`Fatto, ho corretto il costo dell'ultimo carico (${qtyWords(qtyOf(last.move.qty), item.unit)} ${italianDate(last.move.day)}): ${costWords(cost.cost)} per unità invece di ${costWords(costOf(last.cost))}. Ora il costo medio è ${after.average === undefined ? "da sapere" : costWords(after.average)}, valore ${euros(after.value ?? 0n)}.`,
			fencedStock([`Articolo: ${item.name}`].join("\n")),
		].join("\n");
	}

	function status(args: Record<string, unknown>): string {
		const b = book();
		if (active(b.items).length === 0) return NO_ITEMS;
		if (args.item === undefined) return listAnswer(states(), false);
		const n = named(args, b.items, false);
		if (typeof n === "string") return n;
		const answer = statusAnswer(stateOf(n.item, b.moves));
		return n.took === undefined ? answer : `${answer}\n${n.took}`;
	}

	function movements(args: Record<string, unknown>, day: string): string {
		const b = book();
		let moves = b.moves;
		const parts: string[] = [];
		let tookNote = "";
		if (args.item !== undefined) {
			const n = named(args, b.items, false);
			if (typeof n === "string") return n;
			moves = moves.filter((m) => m.item === n.item.id);
			parts.push(`di ${n.item.id}`);
			if (n.took !== undefined) tookNote = `\n${n.took}\n${fencedStock(`Articolo: ${n.item.name}`)}`;
		}
		if (args.period !== undefined) {
			if (typeof args.period !== "string") return "Errore: il periodo è un testo, come «ottobre».";
			try {
				const p = readPeriod(args.period.slice(0, 40), day);
				moves = moves.filter((m) => inPeriod(m.day, p));
				parts.push(p.of);
			} catch (error) {
				if (error instanceof PeriodError) return `Errore: non capisco il periodo: ${fencedStock(args.period.slice(0, 40))}. Dimmi un mese, come «ottobre», o «questo mese».`;
				throw error;
			}
		}
		return movesAnswer(moves, b.items, parts.length === 0 ? "in tutto" : parts.join(" ")) + tookNote;
	}

	async function removeItem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const b = book();
		const done = b.calls.includes(ctx.callId);
		let item: StockItem | undefined;
		if (!done) {
			const n = named(args, b.items, true);
			if (typeof n === "string") return n;
			const s = stateOf(n.item, b.moves);
			if (s.onHand !== 0n) return `Non lo tolgo: di questo articolo (${n.item.id}) risultano ancora ${qtyWords(s.onHand, n.item.unit)}. Se in realtà non ce ne sono, prima un conteggio a zero, poi lo tolgo; i suoi movimenti restano comunque nello storico.`;
			item = n.item;
		}
		const refused = requirePersonFor(ctx, "tolgo un articolo dal magazzino");
		if (refused !== undefined) return refused;
		const by = marker(ctx);
		// A call run again after it removed: the same answer, from the step.
		const gone = await ctx.step("apply", async () => {
			if (item === undefined) return "";
			const id = item.id;
			const outcome = store.update(ctx.callId, (state) => {
				const now = state.items.find((i) => i.id === id);
				if (now === undefined || now.removed !== undefined) return state;
				if (stateOf(now, state.moves).onHand !== 0n) throw new StockError("nel frattempo la quantità è cambiata: non lo tolgo");
				return { ...state, items: state.items.map((i) => (i.id === id ? { ...i, removed: by } : i)) };
			});
			return outcome === "written" ? id : "";
		});
		// Nothing removed (a call run again with its steps lost): nothing to audit.
		if (gone === "") return done ? "Fatto, l'articolo è tolto." : "L'articolo non c'è già più nell'elenco.";
		await audit(ctx, "remove_item", 1);
		return [`Fatto, ho tolto l'articolo (${gone}) dall'elenco del magazzino. I suoi movimenti restano nello storico.`, ...(item === undefined ? [] : [fencedStock(`Articolo: ${item.name}`)])].join("\n");
	}

	/**
	 * A year closed: its movements (up to 31/12, or up to yesterday for this year) become one
	 * apertura per article, with what there was and the average cost exactly; the sales keep their
	 * keys. Asked first, and only with the person's yes in a turn of theirs.
	 */
	async function closeYear(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const current = Number(day.slice(0, 4));
		const year = args.year ?? current - 1;
		if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > current) return `Errore: l'anno da chiudere è uno passato, o questo (fino a ieri).`;
		const yesterday = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
		const cutoff = year < current ? `${year}-12-31` : yesterday;
		book();
		const by = marker(ctx);
		if (args.confirm !== true) {
			const plan = store.close(`plan-${ctx.callId}`, cutoff, by, true);
			if (plan === undefined || plan === "rerun") return `Non c'è niente da chiudere fino al ${italianDate(cutoff)}: nessun movimento da riassumere.`;
			return `Chiudendo il ${year} riassumo ${n1(plan.folded, "un movimento", "# movimenti")} fino al ${italianDate(cutoff)} in ${n1(plan.items, "una riga di apertura", "# righe di apertura")}, una per articolo, con la quantità e il costo medio di allora: i valori non cambiano, le vendite restano contate una volta sola e le note di credito non rimettono più di quanto uscito. Dopo, quei movimenti non si vedono più uno per uno. Chiedi a chi ti scrive se va bene (se vuole, prima il file del magazzino); con il suo sì ripeti con la conferma.`;
		}
		const refused = requirePersonFor(ctx, "chiudo l'anno del magazzino");
		if (refused !== undefined) return refused;
		const closed = await ctx.step("apply", async () => {
			const r = store.close(ctx.callId, cutoff, by);
			return r === undefined || r === "rerun" ? { folded: 0, items: 0 } : r;
		});
		if (closed.folded === 0) return "Fatto, il magazzino è chiuso fino a quella data.";
		await audit(ctx, "close_year", closed.folded);
		return `Fatto, ho chiuso il ${year}: ${n1(closed.folded, "un movimento", "# movimenti")} fino al ${italianDate(cutoff)} ${closed.folded === 1 ? "è diventato" : "sono diventati"} ${n1(closed.items, "una riga di apertura", "# righe di apertura")}. Quantità e valori sono gli stessi di prima.`;
	}

	/** The brief's line: the articles that went under their minimum, or in negativo without one, each crossing said once. */
	async function brief(ctx: ToolContext): Promise<string> {
		const all = states();
		const low = all.filter((s) => s.lowSince !== undefined);
		const negative = all.filter((s) => s.lowSince === undefined && s.negativeSince !== undefined);
		if (low.length === 0 && negative.length === 0) return BRIEF_NOTHING;
		const wanted = [...low.map((s) => ({ item: s.item.id, crossing: s.lowSince as string })), ...negative.map((s) => ({ item: s.item.id, crossing: `neg@${s.negativeSince}` }))];
		const claims = await ctx.step("claim", async () => store.claim(ctx.callId, wanted));
		const said = new Set(claims.map((c) => `${c.item}|${c.crossing}`));
		return briefAnswer(
			low.filter((s) => said.has(`${s.item.id}|${s.lowSince}`)),
			negative.filter((s) => said.has(`${s.item.id}|neg@${s.negativeSince}`)),
		);
	}

	async function exportCsv(ctx: ToolContext, day: string): Promise<string> {
		const all = states();
		if (all.length === 0) return NO_ITEMS;
		const csv = stockCsv(all);
		// The name only from today's date, under magazzino/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `magazzino/magazzino-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		await audit(ctx, "export", all.length);
		const low = all.filter(isLow).length;
		return [`Salvato ${written}: ${n1(all.length, "un articolo", "# articoli")}${low === 0 ? "" : `, ${low} sottoscorta o in negativo in cima`}, con quantità, minimo, costo medio e valore (separatore «;», si apre con Excel).`, "Mandalo con file_send se chi ti scrive lo vuole."].join("\n");
	}
}

