import type { BankStore } from "../bank-store.ts";
import { formNote } from "../client-find.ts";
import { cardCf, goodVat } from "../clients.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { addDays, dayOfIn, todayIn } from "../italian-calendar.ts";
import type { Marker } from "../marker.ts";
import { legalForm, spellingKey } from "../name-keys.ts";
import { cardNameKeys, withOptional } from "../party-cards.ts";
import { lookalikeParties } from "../party-groups.ts";
import { rollingPeriodOf } from "../periods.ts";
import type { RenewalStore } from "../renewal-store.ts";
import {
	ibanAlerts,
	type Ledger,
	lateSuppliers,
	rankedSuppliers,
	recordedTaxIds,
	type Supplier,
	spentIn,
	supplierFigures,
	supplierTotals,
} from "../supplier-sums.ts";
import { readRegister } from "../register-read.ts";
import { findSupplier, loadSuppliers, meantSupplier, supplierNotFound } from "../supplier-find.ts";
import { SUPPLIERS_BROKEN, type SupplierState, type SupplierStore } from "../supplier-store.ts";
import { SUPPLIER_ID_SAID, SUPPLIER_LIMITS, type SupplierCard, SupplierError, supplierAgentReads, supplierId } from "../suppliers.ts";
import { isProblem } from "../text-input.ts";
import { fold } from "../text-match.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { textOf } from "./field-input.ts";
import { mergedSuppliers, readSupplierEdits, SUPPLIER_EDIT_FIELDS, type SupplierEdits, supplierClash, supplierEdited, supplierMergeRefusal } from "./supplier-input.ts";
import {
	briefAnswer,
	fencedSuppliers,
	ibanWarnings,
	lateAnswer,
	summaryAnswer,
	supplierCardLines,
	supplierMergeLines,
	suppliersCsv,
	topSuppliersAgentAnswer,
	topSuppliersAnswer,
	totalsAgentAnswer,
	totalsAnswer,
} from "./supplier-render.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";

const SUPPLIER_OPS = ["summary", "top", "late", "note_add", "note_remove", "contact_set", "merge", "export"] as const;
type Op = (typeof SUPPLIER_OPS)[number];

/** What changed, for the audit: the op and how many, never names, amounts, IBAN, notes or contacts. */
export type SupplierEvent = { readonly type: "suppliers.changed"; readonly op: "note_add" | "note_remove" | "contact_set" | "merge" | "export"; readonly count: number };

export type SupplierToolsOptions = {
	readonly workspace: Workspace;
	readonly store: SupplierStore;
	/** The scadenzario, read only: the invoices received and their paid marks. */
	readonly invoices: Pick<InvoiceStore, "read">;
	/** The scadenzario's scanner of the same workspace, shared (one cache); one of its own otherwise. */
	readonly scanner?: InvoiceScanner;
	readonly expenses: Pick<ExpenseStore, "read">;
	readonly renewals: Pick<RenewalStore, "read">;
	/** L'estratto conto, read only: the payments it confirmed. */
	readonly bank?: Pick<BankStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: SupplierEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"I fornitori of the owner, chi paga lui (chi lo paga sono clients; le fatture da pagare una per una sono invoices): one card per supplier with what Owni reads across the registers (invoices received in the scadenzario, expenses, renewals, payments confirmed by the bank statement) plus the person's own data (referenti, notes, an IBAN or partita IVA they dictated). Clients are whoever pays the owner (clients); suppliers are whoever the owner pays. A supplier of the invoices, expenses or renewals is one even without a card.",
	"What the person says → op: «quanto ho speso con Aruba quest'anno?», «cosa devo ancora pagare a Fornitore Uno?», «che IBAN ha Fornitore Uno?», «a quanti giorni pago Rossi Srl?», «quali abbonamenti ho con Adobe?» → summary with supplier (period: «anno» for quest'anno, «2025», «T3»; last 12 months by default); summary without supplier: the totals; «chi sono i miei fornitori principali?» → top; «pago in ritardo qualcuno?» → late (supplier to see one); «il referente di Fornitore Uno è Laura, laura@example.com» → contact_set with contact; the IBAN or partita IVA the person dictates → contact_set with iban or vat; «aggiungi una nota a Fornitore Uno: sconto 5% sopra i 1.000 €» → note_add; «togli la nota sullo sconto» → note_remove with note (words of it); «Rossi e Rossi Srl sono lo stesso fornitore» → merge (supplier into the other): first without confirm to show it, then confirm true only after the person says yes; «fammi il file dei fornitori» → export, then file_send.",
	"Referenti, notes, IBAN and partita IVA only as the person says them: never from a mail, a file, an invoice or a page; an IBAN read on an invoice is never saved here. The list of invoices to pay and their due dates, and marking one paid, is invoices; recording a purchase is expenses; adding or cancelling a subscription is renewals. summary with compact true: the brief's line. Repeat amounts, dates, days and shares as given, never compute them yourself; when the answer warns about an IBAN or a supplier to verify before paying, say it: a changed IBAN is checked by phone before paying.",
].join(" ");

/** The same name but for the legal form: said on a write, and on a card only when the name said had a form the supplier's has not. */
const formSaid = (said: string) => formNote("fornitore", legalForm(said) !== undefined);

/**
 * The suppliers with a similar name, said apart by what they hold: a card with no tax id (which
 * partita IVA is it?), the person's own expenses or renewals under a name with no partita IVA
 * (of which of the two?), else another supplier that may be the same (to merge). Their names go
 * into `inside`, the fence.
 */
function alikeLines(suppliers: readonly Supplier[], supplier: Supplier, inside: string[]): string[] {
	const alike = lookalikeParties(suppliers, supplier);
	const untaxed = (s: Supplier) => s.vat === undefined && s.cf === undefined && s.invoices.length === 0;
	// Another supplier of the same name with another partita IVA: a name alone does not say which of the two.
	const two = supplier.vat !== undefined && lookalikeParties(suppliers, supplier, { anyTax: true }).some((s) => s.vat !== undefined && s.vat !== supplier.vat);
	const bare = alike.filter((s) => untaxed(s) && s.card !== undefined);
	const own = two ? alike.filter((s) => untaxed(s) && s.card === undefined) : [];
	const others = alike.filter((s) => !bare.includes(s) && !own.includes(s));
	const lines: string[] = [];
	if (bare.length > 0) {
		lines.push(`${bare.length === 1 ? "C'è anche una scheda" : `Ci sono anche ${bare.length} schede`} con un nome simile e senza partita IVA, nel riquadro: chiedi a chi ti scrive di quale dei fornitori ${bare.length === 1 ? "è" : "sono"}, e li unisco.`);
		for (const s of bare.slice(0, 3)) inside.push(`Scheda senza partita IVA: ${s.name}${s.card === undefined ? "" : ` (${s.card.id})`}`);
	}
	if (own.length > 0) {
		lines.push(`${own.length === 1 ? "C'è anche un fornitore" : `Ci sono anche ${own.length} fornitori`} con un nome simile senza partita IVA, con solo le spese o gli abbonamenti che mi hai detto tu, nel riquadro: dimmi di quale dei due ${own.length === 1 ? "è" : "sono"}.`);
		for (const s of own.slice(0, 3)) inside.push(`Senza partita IVA: ${s.name}`);
	}
	if (others.length > 0) {
		lines.push(`${others.length === 1 ? "C'è anche un altro fornitore" : `Ci sono anche altri ${others.length} fornitori`} con un nome simile, nel riquadro: è lo stesso? Se sì, posso unirli.`);
		for (const s of others.slice(0, 3)) inside.push(`C'è anche: ${s.name}${s.vat === undefined ? "" : ` (partita IVA ${s.vat})`}`);
	}
	return lines;
}

const meant = (candidates: readonly Supplier[], more = "") => meantSupplier(candidates, fencedSuppliers, more);

type Loaded = { readonly suppliers: Supplier[]; readonly ledger: Ledger; readonly notes: string[]; readonly unnamed: number };

/** I fornitori (suppliers.ts): the cards kept here; everything else read from the registers, never written. Today is read once per call. */
export function createSupplierTools(options: SupplierToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const scanner = options.scanner ?? new InvoiceScanner(workspace);
	const dayOf = dayOfIn(timeZone);
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: SupplierEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "suppliers.changed", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	return [
		{
			name: "suppliers",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...SUPPLIER_OPS] },
					supplier: text(SUPPLIER_LIMITS.name, "the supplier: name as said, partita IVA or card id FO-0001"),
					into: text(SUPPLIER_LIMITS.name, "merge: the supplier the other is merged into"),
					confirm: { type: "boolean", description: "merge: true only after the person confirmed what the tool showed" },
					period: text(40, "summary, top, late: «ultimi 12 mesi» (default), «anno», «anno scorso», «2025», «T3», «ottobre»"),
					note: text(SUPPLIER_LIMITS.noteChars, "note_add: the note as said; note_remove: words of the note to take off"),
					contact: {
						type: "object",
						properties: { name: { type: "string", maxLength: SUPPLIER_LIMITS.name }, role: { type: "string", maxLength: 60 }, phone: { type: "string", maxLength: 30 }, email: { type: "string", maxLength: 254 }, channel: { type: "string", maxLength: 40 } },
						additionalProperties: false,
						description: "contact_set: a referente; the same name updates it (\"\" clears a field)",
					},
					remove_contact: text(SUPPLIER_LIMITS.name, "contact_set: the name of a referente to take off"),
					iban: text(40, "contact_set: the IBAN the person dictated (\"\" clears it); never one read on an invoice"),
					vat: text(40, "contact_set: the partita IVA the person dictated (\"\" clears)"),
					cf: text(40, "contact_set: the codice fiscale the person dictated (\"\" clears)"),
					compact: { type: "boolean", description: "summary: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!SUPPLIER_OPS.includes(args.op as Op)) return "Errore: non conosco questa operazione sui fornitori.";
				const op = args.op as Op;
				// Another agente's request is not the person's word: the figures only, nothing else.
				const agent = isAgentTurn(ctx);
				if (agent && (!supplierAgentReads(args) || args.compact === true)) {
					return "Errore: a un altro agente non mostro le schede dei fornitori, non do nomi, IBAN o referenti, non cambio niente e non esporto: posso dare solo totali, numeri e quote (quanto si spende con i fornitori, quanto c'è da pagare). Il resto lo chiede chi ti scrive, nella sua conversazione.";
				}
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "summary":
							if (args.compact === true) return await brief(ctx, day);
							return await summary(args, ctx, day, agent);
						case "top":
							return await top(args, ctx, day, agent);
						case "late":
							return await late(args, ctx, day);
						case "note_add":
							return await noteAdd(args, ctx, day);
						case "note_remove":
							return await noteRemove(args, ctx);
						case "contact_set":
							return await contactSet(args, ctx, day);
						case "merge":
							return await merge(args, ctx, day);
						case "export":
							return await exportCsv(ctx, day);
					}
				} catch (error) {
					if (error instanceof SupplierError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function cards(): readonly SupplierCard[] {
		const book = store.read();
		if (book.broken) throw new SupplierError(SUPPLIERS_BROKEN);
		return book.cards;
	}

	/** Every supplier, from the cards and the registers; what does not read is said, never guessed. */
	async function load(ctx: ToolContext): Promise<Loaded> {
		const own = cards();
		const read = await readRegister(options.invoices, scanner, ctx, {
			broken: "Lo stato delle fatture non si legge: le fatture ricevute qui non ci sono.",
			noCompany: "Non so ancora qual è la tua azienda nelle fatture: senza, non distinguo le fatture ricevute e qui non ci sono.",
		});
		const notes = [...read.notes];
		const spent = options.expenses.read();
		if (spent.broken) notes.push("Il registro delle spese non si legge: le spese qui non ci sono.");
		const expenses = spent.broken ? [] : spent.expenses;
		const loaded = loadSuppliers({ cards: own, invoices: read.invoices ?? [], expenses, renewals: options.renewals.read(), ...(options.bank === undefined ? {} : { bank: options.bank.read() }), dayOf });
		notes.push(...loaded.notes);
		return { suppliers: loaded.suppliers, ledger: loaded.ledger, notes, unnamed: expenses.filter((e) => e.supplier === undefined && e.supplierVat === undefined).length };
	}

	function said(value: unknown): string | undefined {
		return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, SUPPLIER_LIMITS.name) : undefined;
	}


	async function summary(args: Record<string, unknown>, ctx: ToolContext, day: string, agent: boolean): Promise<string> {
		const period = rollingPeriodOf(args.period, day, fencedSuppliers);
		if (typeof period === "string") return period;
		const name = said(args.supplier);
		const { suppliers, ledger, notes, unnamed } = await load(ctx);
		if (agent) return [...(name === undefined ? [] : ["A un altro agente non do i dati di un fornitore solo: ecco i totali."]), totalsAgentAnswer(supplierTotals(suppliers, ledger, period.from, period.to, day, dayOf), period.span)].join("\n");
		if (name === undefined) return [totalsAnswer(supplierTotals(suppliers, ledger, period.from, period.to, day, dayOf), period.span, unnamed), ...notes].join("\n");
		const found = findSupplier(suppliers, name);
		if (found.kind === "none") return supplierNotFound(name, fencedSuppliers);
		// A name only close is asked before any card or IBAN is shown, even with one candidate.
		if (found.kind === "close") return meant(found.candidates);
		const supplier = found.supplier;
		const extra = [...notes];
		const inside: string[] = [];
		if (found.form === true && legalForm(name) !== undefined) extra.push(formSaid(name));
		extra.push(...alikeLines(suppliers, supplier, inside));
		return summaryAnswer(supplier, supplierFigures(supplier, ledger, period.from, period.to, day, dayOf, suppliers), period.span, day, { notes: extra, inside });
	}

	async function top(args: Record<string, unknown>, ctx: ToolContext, day: string, agent: boolean): Promise<string> {
		const period = rollingPeriodOf(args.period, day, fencedSuppliers);
		if (typeof period === "string") return period;
		const { suppliers, ledger, notes, unnamed } = await load(ctx);
		const { rows, total, twins } = rankedSuppliers(suppliers, ledger, period.from, period.to);
		if (agent) return topSuppliersAgentAnswer(rows, total, period.span, twins);
		return [topSuppliersAnswer(rows, total, period.span, unnamed, twins), ...notes].join("\n");
	}

	async function late(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const period = rollingPeriodOf(args.period, day, fencedSuppliers);
		if (typeof period === "string") return period;
		const { suppliers, notes } = await load(ctx);
		const name = said(args.supplier);
		let pool = suppliers;
		if (name !== undefined) {
			const found = findSupplier(suppliers, name);
			if (found.kind === "none") return supplierNotFound(name, fencedSuppliers, false);
			if (found.kind === "close") return meant(found.candidates);
			pool = [found.supplier];
		}
		return [lateAnswer(lateSuppliers(pool, period.from, period.to, day, dayOf), period.span), ...notes].join("\n");
	}

	/** The brief's line. Read only, always. */
	async function brief(ctx: ToolContext, day: string): Promise<string> {
		const { suppliers } = await load(ctx);
		return briefAnswer(ibanAlerts(suppliers, day, dayOf));
	}

	/**
	 * The supplier a write is for: the one named (a name the person already wrote keeps its
	 * spelling; one only in the files takes the person's); a name never seen starts a card. A name
	 * only close is asked ("ask"); for a merge, the same name but for the legal form is asked too
	 * ("exact").
	 */
	function target(suppliers: readonly Supplier[], name: string, mode: "ask" | "exact"): { supplier?: Supplier; name: string; notes: string[] } | string {
		const found = findSupplier(suppliers, name);
		if (found.kind === "exact") {
			const s = found.supplier;
			if (found.form === true && mode === "exact") return meant([s]);
			if (found.form === true) return { supplier: s, name: s.name, notes: [formSaid(name)] };
			const own = s.nameFrom === "file" && !SUPPLIER_ID_SAID.test(name.toUpperCase()) && spellingKey(name) === spellingKey(s.name);
			return { supplier: s, name: own ? name : s.name, notes: [] };
		}
		if (found.kind === "close") return meant(found.candidates, mode === "ask" ? " Se è un fornitore nuovo, ripeti con il nome completo." : "");
		if (mode === "exact") return ["Errore: non trovo questo fornitore tra le schede, le fatture ricevute, le spese e i rinnovi:", fencedSuppliers(name)].join("\n");
		if (SUPPLIER_ID_SAID.test(name.toUpperCase())) return "Errore: non c'è una scheda con questo numero.";
		return { name, notes: [] };
	}

	/**
	 * A new card for a supplier of the registers or for a name said: linked to the partita IVA the
	 * registers give it (so it is that supplier's card), never to an IBAN. Linked is not confirmed:
	 * the tax id is marked as taken from the registers until the person dictates one or an IBAN.
	 */
	function newCard(state: SupplierState, name: string, supplier: Supplier | undefined, ctx: ToolContext): SupplierCard {
		const vat = supplier?.vat !== undefined && !state.cards.some((c) => c.vat === supplier.vat) && goodVat(supplier.vat) ? supplier.vat : undefined;
		const cf = supplier?.cf !== undefined && !state.cards.some((c) => c.cf === supplier.cf) && "cf" in cardCf(supplier.cf) ? supplier.cf : undefined;
		const linked = vat !== undefined || cf !== undefined;
		return { id: supplierId(state.nextCard), name, ...(vat === undefined ? {} : { vat }), ...(cf === undefined ? {} : { cf }), ...(linked ? { taxFrom: "registers" as const } : {}), aliases: [], contacts: [], notes: [], ...marker(ctx) };
	}

	/**
	 * The card a write is for: a supplier of the registers writes only on its own card (none: a new
	 * one linked to it is made), never on another card found by the name (a stray card without a
	 * partita IVA, a homonym's, the real one's when someone uses its name). A name never seen: the
	 * card of that name. `written`: the card this call wrote, when known.
	 */
	function cardOf(list: readonly SupplierCard[], chosen: { supplier?: Supplier; name: string }, written?: string): SupplierCard | undefined {
		if (written !== undefined) return list.find((c) => c.id === written);
		const s = chosen.supplier;
		if (s !== undefined) return s.card === undefined ? undefined : list.find((c) => c.id === s.card?.id);
		return list.find((c) => cardNameKeys(c).includes(spellingKey(chosen.name)));
	}

	/** Under the lock, once per call: the card (made when there is none) changed by `change`. Returns the id of the card written, or undefined when the call wrote already (run again). */
	function writeCard(ctx: ToolContext, chosen: { supplier?: Supplier; name: string }, change: (card: SupplierCard) => SupplierCard | string): string | undefined {
		let id: string | undefined;
		store.update(ctx.callId, (state) => {
			let card = cardOf(state.cards, chosen);
			let next = state;
			if (card === undefined) {
				if (state.cards.length >= SUPPLIER_LIMITS.cards) throw new SupplierError(`ci sono già ${SUPPLIER_LIMITS.cards} schede di fornitori, il massimo`);
				card = newCard(state, chosen.name, chosen.supplier, ctx);
				next = { ...state, nextCard: state.nextCard + 1, cards: [...state.cards, card] };
			}
			const changed = change(card);
			if (typeof changed === "string") throw new SupplierError(changed);
			const rest = next.cards.filter((c) => c.id !== changed.id);
			const problem = supplierClash(changed, rest);
			if (problem !== undefined) throw new SupplierError(problem);
			id = changed.id;
			return { ...next, cards: next.cards.map((c) => (c.id === changed.id ? changed : c)) };
		});
		return id;
	}

	async function noteAdd(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const name = said(args.supplier);
		if (name === undefined) return "Errore: dimmi a quale fornitore va la nota.";
		const body = textOf(args.note, SUPPLIER_LIMITS.noteChars, "la nota");
		if (isProblem(body)) return `Errore: ${body.problem}.`;
		const { suppliers } = await load(ctx);
		const chosen = target(suppliers, name, "ask");
		if (typeof chosen === "string") return chosen;
		const applied = await ctx.step("apply", async () => {
			let full = false;
			const id = writeCard(ctx, chosen, (card) => {
				const notes = [...card.notes, { date: day, text: body, ...marker(ctx) }];
				full = notes.length > SUPPLIER_LIMITS.notes;
				return { ...card, notes: notes.slice(-SUPPLIER_LIMITS.notes), edited: marker(ctx) };
			});
			return { full, ...(id === undefined ? {} : { id }) };
		});
		const dropped = applied.full;
		await audit(ctx, "note_add", 1);
		const card = cardOf(cards(), chosen, applied.id);
		const lines = [`Fatto, nota salvata${card === undefined ? "" : ` nella scheda ${card.id}`}.`, ...chosen.notes];
		if (dropped) lines.push(`La scheda teneva già ${SUPPLIER_LIMITS.notes} note: ho tolto la più vecchia.`);
		lines.push(fencedSuppliers([`Fornitore: ${card?.name ?? chosen.name}`, `Nota: ${body}`].join("\n")));
		return lines.join("\n");
	}

	async function noteRemove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const name = said(args.supplier);
		if (name === undefined) return "Errore: dimmi di quale fornitore togliere la nota.";
		const words = textOf(args.note, SUPPLIER_LIMITS.noteChars, "la nota");
		if (isProblem(words)) return `Errore: dimmi le parole della nota da togliere.`;
		const { suppliers } = await load(ctx);
		// The same name but for the legal form is taken (and said): only the person's own note goes.
		const chosen = target(suppliers, name, "ask");
		if (typeof chosen === "string") return chosen;
		const card = cardOf(cards(), chosen);
		// A call run again after it removed: the note is gone; the same answer.
		if (store.read().calls.includes(ctx.callId)) {
			await audit(ctx, "note_remove", 1);
			return `Fatto, nota tolta${card === undefined ? "" : ` dalla scheda ${card.id}`}.`;
		}
		if (card === undefined || card.notes.length === 0) return "Questo fornitore non ha note: non c'è niente da togliere.";
		const key = fold(words).trim();
		const same = card.notes.filter((n) => fold(n.text).trim() === key);
		const matching = same.length > 0 ? same : card.notes.filter((n) => fold(n.text).includes(key));
		if (matching.length === 0) return ["Non trovo una nota con queste parole nella scheda:", fencedSuppliers([`Cercato: ${words}`, ...card.notes.map((n) => `Nota: ${n.text}`)].join("\n")), "Chiedi a chi ti scrive quale togliere, e ripeti con le sue parole."].join("\n");
		if (matching.length > 1) return [`Ci sono ${matching.length} note con queste parole, nel riquadro: quale tolgo?`, fencedSuppliers(matching.map((n) => `Nota: ${n.text}`).join("\n")), "Ripeti con più parole della nota da togliere."].join("\n");
		const gone = matching[0] as SupplierCard["notes"][number];
		await ctx.step("apply", async () => {
			writeCard(ctx, chosen, (c) => ({ ...c, notes: c.notes.filter((n) => !(n.at === gone.at && n.text === gone.text && n.date === gone.date)), edited: marker(ctx) }));
			return true;
		});
		await audit(ctx, "note_remove", 1);
		return [`Fatto, nota tolta dalla scheda ${card.id}.`, ...chosen.notes, fencedSuppliers([`Fornitore: ${card.name}`, `Nota tolta: ${gone.text}`].join("\n"))].join("\n");
	}

	async function contactSet(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const name = said(args.supplier);
		if (name === undefined) return "Errore: dimmi di quale fornitore.";
		if (!SUPPLIER_EDIT_FIELDS.some((f) => args[f] !== undefined)) return "Errore: dimmi il referente (nome, ruolo, telefono, email), l'IBAN o la partita IVA da segnare.";
		const edits = readSupplierEdits(args);
		if (isProblem(edits)) return `Errore: ${edits.problem}.`;
		const { suppliers, ledger } = await load(ctx);
		const chosen = target(suppliers, name, "ask");
		if (typeof chosen === "string") return chosen;
		const s = chosen.supplier;
		const refused = taxRefusal(suppliers, s, chosen.name, edits);
		if (refused !== undefined) return refused;
		const written = await ctx.step("apply", async () => {
			// An IBAN, a partita IVA or a codice fiscale dictated confirms the card; a referente alone does not.
			const dictated = typeof edits.iban === "string" || typeof edits.vat === "string" || typeof edits.cf === "string";
			const id = writeCard(ctx, chosen, (card) => {
				const changed = supplierEdited(card, edits, marker(ctx));
				return typeof changed === "string" || !dictated ? changed : withOptional(changed, "taxFrom", null);
			});
			return id ?? "";
		});
		await audit(ctx, "contact_set", 1);
		const card = cardOf(cards(), chosen, written === "" ? undefined : written);
		if (card === undefined) return "Fatto.";
		const shown: Supplier = { ...(s ?? { key: card.id, names: [], invoices: [], expenses: [], renewals: [], nameFrom: "card" as const }), card, name: card.name, ...(card.vat === undefined ? {} : { vat: card.vat }) } as Supplier;
		const f = supplierFigures(shown, ledger, day, day, day, dayOf, suppliers.map((x) => (x.key === s?.key ? shown : x)));
		const lines = [`Fatto, ho aggiornato la scheda ${card.id}.`, ...chosen.notes];
		if (edits.iban !== undefined) lines.push(edits.iban === null ? "Ho tolto l'IBAN che mi avevi dato: resta quello delle fatture." : "L'IBAN che mi hai dato resta questo finché non me lo cambi tu: un documento non lo cambia mai.");
		lines.push(...ibanWarnings(f).filter((w) => !w.startsWith("Un IBAN delle fatture da pagare non passa")));
		lines.push(fencedSuppliers(supplierCardLines(shown, f, day).filter((l) => !l.startsWith("Nota ")).join("\n")));
		return lines.join("\n");
	}

	/**
	 * A partita IVA or codice fiscale dictated is never written silently when it would move
	 * invoices between suppliers: refused when another supplier of the cards or the registers has
	 * it (a merge is the way), or when an invoice or expense of this one writes another (the two
	 * shown, to be asked), whatever the card holds now.
	 */
	function taxRefusal(suppliers: readonly Supplier[], s: Supplier | undefined, saidName: string, edits: SupplierEdits): string | undefined {
		for (const [kind, value] of [["vat", edits.vat], ["cf", edits.cf]] as const) {
			if (typeof value !== "string") continue;
			const owner = suppliers.find((t) => t.key !== s?.key && (t[kind] === value || (kind === "vat" ? recordedTaxIds(t).vats : recordedTaxIds(t).cfs).has(value)));
			if (owner !== undefined) {
				return [`Non ${kind === "vat" ? "la" : "lo"} segno: ${kind === "vat" ? "questa partita IVA è già" : "questo codice fiscale è già"} di un altro fornitore, nel riquadro. Se sono lo stesso fornitore, posso unirli.`, fencedSuppliers(`${owner.name}: ${owner[kind] ?? value}\n${kind === "vat" ? "Detta" : "Detto"} ora per ${s?.card === undefined ? saidName : s.name}: ${value}`)].join("\n");
			}
			if (s === undefined) continue;
			const recorded = [...(kind === "vat" ? recordedTaxIds(s).vats : recordedTaxIds(s).cfs)].filter((v) => v !== value);
			if (recorded.length > 0) {
				return [`Non ${kind === "vat" ? "la" : "lo"} segno: le fatture o le spese di questo fornitore hanno ${kind === "vat" ? "un'altra partita IVA" : "un altro codice fiscale"}, nel riquadro. Chiedi a chi ti scrive quale è ${kind === "vat" ? "giusta" : "giusto"}: se è un altro fornitore, ripeti con il suo nome.`, fencedSuppliers([`Fornitore: ${s.name}`, ...recorded.map((v) => `Nelle fatture o nelle spese: ${v}`), `${kind === "vat" ? "Detta" : "Detto"} ora: ${value}`].join("\n"))].join("\n");
			}
		}
		return undefined;
	}

	async function merge(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const fromName = said(args.supplier);
		const intoName = said(args.into);
		if (fromName === undefined || intoName === undefined) return "Errore: dimmi quale fornitore unire e in quale.";
		if (args.confirm !== undefined && typeof args.confirm !== "boolean") return "Errore: la conferma è sì o no.";
		const { suppliers, ledger } = await load(ctx);
		const from = target(suppliers, fromName, "exact");
		if (typeof from === "string") return from;
		const into = target(suppliers, intoName, "exact");
		if (typeof into === "string") return into;
		const a = from.supplier as Supplier;
		const b = into.supplier as Supplier;
		// A call run again after it merged: the two names are one card now.
		if (store.read().calls.includes(ctx.callId)) {
			await audit(ctx, "merge", 1);
			return [`Fatto, i due fornitori sono una sola scheda${b.card === undefined ? "" : `: ${b.card.id}`}.`, fencedSuppliers(supplierCardLines(b, undefined, day).join("\n"))].join("\n");
		}
		const refused = supplierMergeRefusal(a, b);
		if (refused === "same") return "Sono già lo stesso fornitore: non c'è niente da unire.";
		if (refused === "vat") return ["Non li unisco: hanno due partite IVA diverse, quindi sono due fornitori diversi.", fencedSuppliers(`${a.name}: ${a.vat}\n${b.name}: ${b.vat}`)].join("\n");
		if (refused === "cf") return ["Non li unisco: hanno due codici fiscali diversi, quindi sono due fornitori diversi.", fencedSuppliers(`${a.name}: ${a.cf}\n${b.name}: ${b.cf}`)].join("\n");
		if (refused === "iban") return ["Non li unisco: mi hai dato due IBAN diversi per loro, nel riquadro. Dimmi prima quale togliere.", fencedSuppliers(`${a.name}: ${a.card?.iban}\n${b.name}: ${b.card?.iban}`)].join("\n");
		const ever = (s: Supplier) => spentIn(s, ledger, "0000-01-01", day).cents;
		if (args.confirm !== true) {
			return [
				"Unirei questi due fornitori in una sola scheda (nel riquadro): i nomi, i referenti, le note e l'IBAN che mi hai dato per il primo passano al secondo, e il nome del primo resta come altro nome.",
				"Fatture, spese e rinnovi non cambiano. Chiedi conferma a chi ti scrive, poi ripeti la richiesta confermata.",
				fencedSuppliers(supplierMergeLines(a, b, ever).join("\n")),
			].join("\n");
		}
		// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
		const notPerson = requirePersonFor(ctx, "unisco i due fornitori");
		if (notPerson !== undefined) return notPerson;
		await ctx.step("apply", async () => {
			store.update(ctx.callId, (state) => mergedSuppliers(state, a, b, (st, n, sup) => newCard(st, n, sup, ctx), marker(ctx)));
			return true;
		});
		await audit(ctx, "merge", 1);
		const all = cards();
		const card = b.card !== undefined ? all.find((c) => c.id === b.card?.id) : a.card !== undefined ? all.find((c) => c.id === a.card?.id) : (all.find((c) => b.vat !== undefined && c.vat === b.vat) ?? all.find((c) => cardNameKeys(c).includes(spellingKey(b.name))));
		const shown = { ...b, ...(card === undefined ? {} : { card, name: card.name }) } as Supplier;
		return [`Fatto, ho unito i due fornitori${card === undefined ? "" : ` nella scheda ${card.id}`}. Fatture, spese e rinnovi restano dove sono e ora si leggono insieme.`, fencedSuppliers(supplierCardLines(shown, undefined, day).join("\n"))].join("\n");
	}

	async function exportCsv(ctx: ToolContext, day: string): Promise<string> {
		const { suppliers, ledger } = await load(ctx);
		const year = Number(day.slice(0, 4));
		const rows = suppliers
			.map((supplier) => ({ supplier, year: supplierFigures(supplier, ledger, `${year}-01-01`, day, day, dayOf, suppliers), lastYear: spentIn(supplier, ledger, `${year - 1}-01-01`, `${year - 1}-12-31`) }))
			.sort((x, y) => (y.year.spent.cents > x.year.spent.cents ? 1 : y.year.spent.cents < x.year.spent.cents ? -1 : x.supplier.name.localeCompare(y.supplier.name, "it")));
		if (rows.length === 0) return "Non ci sono fornitori da esportare: nessuna scheda, e nessun fornitore nelle fatture ricevute, nelle spese o nei rinnovi.";
		const csv = suppliersCsv(rows, year);
		// The name only from today's date, under fornitori/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `fornitori/fornitori-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		await audit(ctx, "export", rows.length);
		return [`Salvato ${written}: ${rows.length === 1 ? "un fornitore" : `${rows.length} fornitori`}, con speso (quest'anno e l'anno scorso), da pagare, scaduto, giorni medi di pagamento, ritardi, ultimo pagamento, abbonamenti, IBAN e i tuoi dati (separatore «;», si apre con Excel).`, "Mandalo con file_send se chi ti scrive lo vuole."].join("\n");
	}
}

