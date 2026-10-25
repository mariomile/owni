import type { OwniTool, ToolContext } from "../engine.ts";
import { addDays, dayOfIn, todayIn } from "../italian-calendar.ts";
import { italianLongDate as long, withDate } from "../italian-format.ts";
import { agendaOf, amountAt, deadlineFor, effectiveDue, effectiveTermEnd, lastCharge, movesBySelf, nextDue, normalised, noticeAlerts, noticeDeadline, placeDue, readDue, remindDays } from "../renewal-dates.ts";
import { costsOf } from "../renewal-sums.ts";
import { RENEWALS_BROKEN, type RenewalStore } from "../renewal-store.ts";
import { CATEGORIES, type Category, EXPENSE_CATEGORY, findRenewals, lookalike, matchCategory, RENEWAL_LIMITS, type Renewal, RenewalError, type Roll, renewalCallReads, renewalMatches } from "../renewals.ts";
import { METHODS } from "../payment-methods.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { type DayWords, readPastDay } from "./day-input.ts";
import type { ExpenseRecorded, ExpenseRecordInput, ExpenseSeam } from "./expense-tools.ts";
import { sameDraft } from "./field-input.ts";
import { isProblem } from "../text-input.ts";
import { applyFields, editsSomething, readFields, readPeriodAmount } from "./renewal-input.ts";
import { briefAnswer, fenced, listAnswer, renewalLine, renewalsCsv, summaryAnswer, upcomingAnswer} from "./renewal-render.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";


const RENEWAL_OPS = ["add", "list", "upcoming", "summary", "renewed", "paid", "cancel", "reactivate", "edit", "remove", "export"] as const;
type Op = (typeof RENEWAL_OPS)[number];

const STATUSES = ["active", "cancelled", "all"] as const;
type Status = (typeof STATUSES)[number];

/** The longest look ahead of upcoming: a year and a day. */
const MAX_DAYS = 366;

/** What changed, for the audit: the op and how many renewals (or rows), never names, amounts, dates, notes or paths. */
export type RenewalEvent = { readonly type: "renewal.changed"; readonly op: "add" | "edit" | "renewed" | "charge" | "cancel" | "reactivate" | "remove" | "export"; readonly count: number };


export type RenewalToolsOptions = {
	readonly workspace: Workspace;
	readonly store: RenewalStore;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: RenewalEvent) => Promise<void>;
	/** The expenses' own add (expense-tools.ts expensesOf): record_expense's only way to record a payment. */
	readonly expenses?: ExpenseSeam;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Rinnovi e abbonamenti of the owner, costi fissi e scadenze (i canoni che fattura lui sono recurring_invoices; un promemoria a un'ora precisa è schedule_create): recurring costs and deadlines (software, domains and hosting, insurance, rent and leasing, utilities, phone and internet, memberships, licences, contracts with tacit renewal and a disdetta notice). The canoni the owner invoices to a customer are recurring_invoices, not renewals.",
	"What the person says → op: «scade il…», «ricordami che…», «Canva 12 euro al mese» → add; «ho pagato», «l'ho rinnovato» → renewed (record_expense true if they want it in the expenses); «ho disdetto» → cancel; «quanto spendo di abbonamenti?» → summary; «cosa scade?», «cosa devo disdire?» → upcoming; «quali abbonamenti ho?» → list; a contract or policy read with file_read → add with the fields read and document = its path.",
	"add: name (required: what renews), due (required: the next payment or expiry: 12/03/2027, «12 marzo», «primo gennaio», «il 15», «ogni 15 del mese», «fine mese», «giugno» = its last day, «fine anno», «tra un mese»), frequency (how often one pays: mensile, bimestrale, trimestrale, semestrale, annuale, biennale, «ogni 18 mesi»; a number is months; default annuale), amount (euros of one payment, VAT included; «100 + IVA» or vat_excluded true with vat_rate; another currency: the person's approximate euros in amount and the amount as said in original_amount), vat_rate, provider, category, method, note, document.",
	"auto_renew true: the contract renews unless cancelled (tacit renewal). auto_pay true: the money leaves by itself (card, PayPal, addebito, RID, SDD, domiciliazione): it never shows as overdue or to pay; if not said, it is guessed only for auto_renew with such a method, and said back. notice_days (or notice_months, or «3 mesi»): the disdetta notice before the end of the term. term_months + term_end: the contract's term when it differs from how often one pays (a yearly contract paid monthly). trial true: a free trial ending on due. new_amount + new_amount_from: a price change from that due date (new_amount VAT included unless «+ IVA», with the renewal's vat_rate). remind_days: days before to tell in the brief (default 7 monthly, 14 up to 5 months, 30 from 6 months).",
	`category: ${CATEGORIES.join(", ")} (polizza, fibra, dominio, Canva… are understood; otherwise guessed from the name, or altro).`,
	"list: status active (default) | cancelled | all, category. upcoming: what needs doing in the next days (default 30), every payment in the window counted; compact true: the brief's line only. summary: yearly cost and monthly average, per category (category to narrow), the biggest, those without an amount.",
	"renewed (or paid): a payment by hand or a renewal confirmed: the due date moves one period on from the due date itself, once per call; refused when the due date is still far or it was already marked today, unless the person really paid ahead (advance true). record_expense true also records the payment in the expenses (amount: what was paid when different; paid_on: the day, default today); on a renewal already marked today it records only the expense. For auto_pay renewals nothing moves: record_expense true records the last charge as an expense.",
	"A manual due date gone never moves by itself: it shows as overdue until the person says it was renewed (renewed) or let go (cancel). cancel: the disdetta was sent (date: when, default today; ends: the last day in force); it stays in the list as cancelled. reactivate: undo a cancel (due: the new next due date).",
	"edit: id + only what changes (\"\" removes provider, amount, original_amount, notice_days, remind_days, method, note, document, term_months or new_amount). remove: deletes it for good, only when the person asks. id: the renewal's id (R-0001) or words of its name («l'assicurazione dell'auto»); when several match, the tool lists them; before cancel or remove, a name that fits only once generic words are dropped is shown to confirm.",
	"export: a CSV for Excel under rinnovi/ (status, default all); then send it with file_send. Repeat dates, amounts and totals as given, never compute them yourself. For a reminder at an exact time use schedule_create; the morning brief already tells what is due.",
].join(" ");

const RENEWAL_PAID_DAY: DayWords = { field: "paid_on è il giorno del pagamento", future: "un pagamento si registra quando è fatto" };
const CANCEL_DAY: DayWords = { field: "date è il giorno della disdetta", future: "una disdetta si registra quando è mandata" };

/** The keys of a renewal that are its id, state and who did it: not compared by an edit. */
const STATE_KEYS = ["id", "by", "at", "callId", "edited", "status", "cancelled", "rolls", "charges", "lastCall"];

/** What a payment to record is: the amount and day said once, checked before anything moves. */
type Payment = { readonly amount?: string; readonly day: string };

/**
 * Rinnovi (renewals.ts): recorded from a sentence or a contract read, listed, what is coming up,
 * the yearly cost, paid or renewed (one period on, and the payment as an expense when asked),
 * cancelled and reactivated, changed, removed, exported. Dates, amounts and ids are this tool's;
 * names, providers, notes and paths come from the person and are fenced.
 */
export function createRenewalTools(options: RenewalToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const today = () => todayIn(timeZone, now());
	const localDay = dayOfIn(timeZone);
	const audit = async (ctx: ToolContext, op: RenewalEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "renewal.changed", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", minLength: 1, maxLength: max, description });
	const amount = { type: ["number", "string"] };
	return [
		{
			name: "renewals",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...RENEWAL_OPS] },
					id: text(RENEWAL_LIMITS.name, "renewed, cancel, reactivate, edit, remove: the renewal's id (R-0001) or words of its name"),
					name: { type: "string", maxLength: RENEWAL_LIMITS.name, description: "add, edit: what renews, e.g. «Assicurazione auto», «Canva Pro», «Dominio rossi.it»" },
					provider: { type: "string", maxLength: RENEWAL_LIMITS.provider, description: "add, edit: who is paid (compagnia, fornitore)" },
					category: { type: "string", maxLength: 60, description: `add, edit, list, summary: ${CATEGORIES.join(", ")}` },
					amount: { ...amount, description: "add, edit: euros of one payment, VAT included unless «+ IVA»; renewed with record_expense: what was paid, when different" },
					vat_rate: { ...amount, description: "add, edit: the VAT rate (22, 10, 5, 4, 0), only as said" },
					vat_excluded: { type: "boolean", description: "add, edit: true when amount is said without VAT (needs vat_rate)" },
					original_amount: { type: "string", maxLength: RENEWAL_LIMITS.originalAmount, description: "add, edit: the amount as said in another currency, e.g. «20 USD»; amount holds the approximate euros" },
					frequency: { ...amount, description: "add, edit: how often one pays: mensile, bimestrale, trimestrale, semestrale, annuale, biennale, «ogni 18 mesi»; a number is months" },
					due: text(60, "add, edit, reactivate: the next payment or expiry: 12/03/2027, «12 marzo», «il 15», «fine mese», «giugno», «tra un mese»"),
					term_months: { ...amount, description: "add, edit: the contract's term in months when it differs from frequency" },
					term_end: text(60, "add, edit: when the current term ends (with term_months)"),
					auto_renew: { type: "boolean", description: "add, edit: true when the contract renews unless cancelled" },
					auto_pay: { type: "boolean", description: "add, edit: true when the money leaves by itself (card, PayPal, direct debit)" },
					trial: { type: "boolean", description: "add, edit: true for a free trial ending on due" },
					notice_days: { ...amount, description: "add, edit: the disdetta notice in days (or «3 mesi»)" },
					notice_months: { type: "integer", minimum: 1, maximum: RENEWAL_LIMITS.maxNoticeMonths, description: "add, edit: the disdetta notice in months" },
					remind_days: { ...amount, description: "add, edit: days before the due date (or the disdetta deadline) the brief starts telling" },
					new_amount: { ...amount, description: "add, edit: a new amount from new_amount_from on, VAT included unless «+ IVA» (then the renewal's vat_rate)" },
					new_amount_from: text(60, "add, edit: the due date the new amount starts from"),
					method: { type: "string", maxLength: 60, description: `add, edit: ${METHODS.join(", ")}, as said («carta», «addebito in conto», «PayPal»)` },
					note: { type: "string", maxLength: RENEWAL_LIMITS.note, description: "add, edit: a note of the person's" },
					document: { type: "string", maxLength: RENEWAL_LIMITS.document, description: "add, edit: the workspace path of the contract or policy" },
					status: { type: "string", enum: [...STATUSES], description: "list: default active; export: default all" },
					days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: "upcoming: how many days ahead, default 30" },
					compact: { type: "boolean", description: "upcoming: the brief's line only" },
					record_expense: { type: "boolean", description: "renewed: also record the payment in the expenses; default false" },
					advance: { type: "boolean", description: "renewed: the person really paid ahead (the due date is still far, or it was already marked today)" },
					paid_on: text(40, "renewed with record_expense: the day paid, default today"),
					date: text(40, "cancel: the day the disdetta was sent, default today"),
					ends: text(60, "cancel: the last day it is in force, if said"),
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!RENEWAL_OPS.includes(args.op as Op)) return `Errore: op è una di queste: ${RENEWAL_OPS.join(", ")}.`;
				const op = args.op as Op;
				// Another agente's request is not the person's word: it reads, it never records, changes or writes a file.
				if (isAgentTurn(ctx) && !renewalCallReads(args)) {
					return "Errore: in una richiesta di un altro agente non aggiungo, non cambio e non esporto rinnovi: lo fa chi ti scrive, nella sua conversazione.";
				}
				// Cancelled or removed only when the person asks, in their own message (ADR 0088).
				if (op === "cancel" || op === "remove") {
					const notPerson = requirePersonFor(ctx, op === "cancel" ? "disdico il rinnovo" : "tolgo il rinnovo");
					if (notPerson !== undefined) return notPerson;
				}
				try {
					switch (op) {
						case "add":
							return await add(args, ctx);
						case "list":
							return list(args);
						case "upcoming":
							return upcoming(args);
						case "summary":
							return summary(args);
						case "renewed":
						case "paid":
							return await renewed(args, ctx);
						case "cancel":
							return await cancel(args, ctx);
						case "reactivate":
							return await reactivate(args, ctx);
						case "edit":
							return await edit(args, ctx);
						case "remove":
							return await remove(args, ctx);
						case "export":
							return await exportCsv(args, ctx);
					}
				} catch (error) {
					if (error instanceof RenewalError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function readable(): readonly Renewal[] {
		const book = store.read();
		if (book.broken) throw new RenewalError(RENEWALS_BROKEN);
		return book.renewals;
	}

	/** Soonest due as of today first, then by id. */
	function sorted(rs: readonly Renewal[]): Renewal[] {
		const day = today();
		return [...rs].sort((a, b) => effectiveDue(a, day).localeCompare(effectiveDue(b, day)) || a.id.localeCompare(b.id));
	}

	/**
	 * Change the renewal `id` under the lock: `change` gets it with its moving dates written down as
	 * of today (renewal-dates.ts normalised), and gives it back changed; the same object back writes nothing.
	 */
	function write(id: string, change: (r: Renewal) => Renewal): Renewal {
		return store.edit(id, (r) => {
			const base = normalised(r, today());
			const next = change(base);
			return next === base ? r : next;
		});
	}

	/**
	 * The one renewal an id or a name names (among those `which` allows), or the answer saying why
	 * not. `sure`: for a disdetta, a name that fits only once generic words are dropped is asked.
	 */
	function pick(args: Record<string, unknown>, which: "active" | "cancelled" | "any", sure = false): Renewal | string {
		if (typeof args.id !== "string" || args.id.trim() === "") return "Errore: indica il rinnovo con id, per esempio R-0001, o con il suo nome.";
		const all = readable();
		const { found, loose } = renewalMatches(all, args.id);
		const allowed = found.filter((r) => which === "any" || r.status === which);
		if (allowed.length === 1 && sure && loose) return confirmAnswer(allowed);
		if (allowed.length === 1) return allowed[0] as Renewal;
		if (allowed.length > 1) return `Errore: più rinnovi corrispondono:\n${fenced(allowed.slice(0, 10).map((r) => renewalLine(r, today())).join("\n"))}\nChiedi a chi ti scrive quale, poi rifai con id.`;
		const other = found[0];
		if (other !== undefined && found.length === 1) {
			if (which === "active") return `Errore: il rinnovo ${other.id} è disdetto. Se chi ti scrive vuole riprenderlo, prima op reactivate.`;
			if (which === "cancelled") return `Errore: il rinnovo ${other.id} è già attivo.`;
		}
		return `Errore: non trovo il rinnovo ${fenced(args.id.slice(0, 40))} tra i ${all.length} registrati. Guarda l'elenco con op list (status all).`;
	}

	/** A name that fits only in part, before a disdetta or a removal: the renewal shown, to be confirmed by id. */
	function confirmAnswer(rs: readonly Renewal[]): string {
		return `Errore: il nome detto corrisponde solo in parte a:\n${fenced(rs.slice(0, 10).map((r) => renewalLine(r, today())).join("\n"))}\nChiedi a chi ti scrive se è questo; se sì, rifai con id.`;
	}

	/** The renewal this call changed already (a rerun after a stop), by its last call's marker. */
	function changedBy(ctx: ToolContext): Renewal | undefined {
		return readable().find((r) => r.lastCall === ctx.callId);
	}

	/** What to say about a disdetta deadline gone while the term's end is still ahead. */
	function deadlineGone(r: Renewal): string[] {
		const day = today();
		if (r.status !== "active" || !noticeAlerts(r)) return [];
		const end = effectiveTermEnd(r, day);
		const by = deadlineFor(r, end);
		if (by >= day) return [];
		return [`Il termine per disdire la scadenza ${withDate("del", end)} era ${withDate("il", by)}: questa si rinnova. Di' a chi ti scrive: «Per la scadenza ${withDate("del", end)} il termine per disdire è passato (era ${withDate("il", by)}).»`];
	}

	async function add(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		// This call recorded its renewal already (run again after a stop): its audit, then the same answer.
		const saved = readable().find((r) => r.callId === ctx.callId);
		if (saved !== undefined) {
			await audit(ctx, "add", 1);
			return added(saved, []);
		}
		const fields = await readFields(args, { today: today(), workspace, editing: false });
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		const applied = applyFields(fields, undefined, today());
		if (isProblem(applied)) return `Errore: ${applied.problem}.`;
		const { draft, notes } = applied;
		const id = await ctx.step("save", async () => store.add(ctx.callId, (n) => ({ id: n, ...draft, status: "active", by: who(ctx), at: now().toISOString(), callId: ctx.callId })).id);
		await audit(ctx, "add", 1);
		const all = readable();
		const renewal = all.find((r) => r.id === id);
		if (renewal === undefined) return `Errore: il rinnovo ${id} non c'è più.`;
		const twin = lookalike(all, renewal);
		const warning = twin === undefined ? [] : [`Attenzione: sembra lo stesso di ${twin} (stesso nome). Chiedi a chi ti scrive: «Mi sembra un doppione di uno che c'è già: lo tolgo?» Solo se dice sì, togli questo (${renewal.id}) con op remove.`];
		return added(renewal, [...warning, ...notes, ...deadlineGone(renewal)]);
	}

	function added(r: Renewal, notes: readonly string[]): string {
		const deadline = noticeDeadline(r, today()) !== undefined;
		const brief = r.autoPay === true && r.months < 6 ? `Si paga da solo: nel brief non lo segnalo a ogni addebito${deadline ? ", solo quando c'è da disdire" : ""}.` : `Nel brief del mattino lo segnalo da ${remindDays(r)} giorni prima${deadline ? " della scadenza e del termine per disdire" : ""}.`;
		const hints = [...notes, ...(r.amount === undefined ? ["Importo non indicato: se chi ti scrive lo sa, aggiungilo con op edit (amount), così entra nei costi."] : []), brief];
		return [`Aggiunto il rinnovo ${r.id}. Ripeti date e importo come sono scritti.`, fenced(renewalLine(r, today())), ...hints].join("\n");
	}

	function readCategoryArg(args: Record<string, unknown>): Category | undefined | string {
		if (typeof args.category !== "string" || args.category.trim() === "") return undefined;
		return matchCategory(args.category) ?? `Errore: non riconosco la categoria. Sono queste: ${CATEGORIES.join(", ")}.`;
	}

	function list(args: Record<string, unknown>): string {
		if (args.status !== undefined && !STATUSES.includes(args.status as Status)) return `Errore: status è uno di questi: ${STATUSES.join(", ")}.`;
		const status = (args.status ?? "active") as Status;
		const category = readCategoryArg(args);
		if (typeof category === "string" && category.startsWith("Errore")) return category;
		const shown = sorted(readable().filter((r) => (status === "all" || r.status === status) && (category === undefined || r.category === category)));
		return listAnswer(shown, { status, ...(category === undefined ? {} : { category: category as Category }) }, today());
	}

	function upcoming(args: Record<string, unknown>): string {
		const all = readable();
		const day = today();
		if (args.compact === true) return briefAnswer(agendaOf(all, day, addDays(day, MAX_DAYS), true));
		const days = args.days === undefined ? 30 : args.days;
		if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) return `Errore: days è un numero di giorni da 1 a ${MAX_DAYS}.`;
		return upcomingAnswer(agendaOf(all, day, addDays(day, days)), days, day);
	}

	function summary(args: Record<string, unknown>): string {
		const category = readCategoryArg(args);
		if (typeof category === "string" && category.startsWith("Errore")) return category;
		const active = readable().filter((r) => r.status === "active" && (category === undefined || r.category === category));
		return summaryAnswer(costsOf(active, today()), active.length, today(), category as Category | undefined);
	}

	/** The expense of a payment of `r` on `due`, paid on `pay.day`: at `then`, its amount as kept when it happened, else the price in force on `due`. */
	function expenseInput(r: Renewal, due: string, pay: Payment, then?: string): ExpenseRecordInput | string {
		const amount = pay.amount ?? then ?? amountAt(r, due);
		if (amount === undefined) return "per registrare la spesa serve l'importo pagato (amount): il rinnovo non ce l'ha. Chiedi a chi ti scrive quanto ha pagato";
		return {
			amount,
			date: pay.day,
			category: EXPENSE_CATEGORY[r.category],
			supplier: (r.provider ?? r.name).slice(0, 120),
			...(r.method === undefined ? {} : { method: r.method }),
			note: `Rinnovo ${r.id}`,
			...(r.vatRate === undefined || pay.amount !== undefined ? {} : { vatRate: r.vatRate }),
		};
	}

	/** The expense's lines in the answer: recorded, with a lookalike said, or why not. */
	function expenseLines(rec: ExpenseRecorded, rolled: boolean): string[] {
		if ("problem" in rec) return [`La spesa non è registrata: ${rec.problem}. ${rolled ? "La scadenza è già spostata: non rifare renewed. " : ""}Registra la spesa con expenses op add.`];
		const twin = rec.twin === undefined ? [] : [`Attenzione: sembra uguale alla spesa ${rec.twin.id} (${rec.twin.why}). Chiedi a chi ti scrive: «Mi sembra la stessa spesa di ${rec.twin.id}, già registrata: è un doppione? Se sì, la tolgo.» Solo se dice sì, togli la nuova con expenses op remove.`];
		return [`Registrata anche la spesa ${rec.id}:`, fenced(rec.line), ...twin];
	}

	/** record_expense, amount, paid_on and advance read once; amount and paid_on only with record_expense. */
	function readPayment(args: Record<string, unknown>): { want: boolean; advance: boolean; pay: Payment } | string {
		for (const flag of ["record_expense", "advance"]) if (args[flag] !== undefined && typeof args[flag] !== "boolean") return `Errore: ${flag} è true o false.`;
		const want = args.record_expense === true;
		if (!want && (args.amount !== undefined || args.paid_on !== undefined)) return "Errore: amount e paid_on in renewed servono solo con record_expense true (per la spesa); per cambiare l'importo del rinnovo usa op edit.";
		if (want && options.expenses === undefined) return "Errore: qui non posso registrare la spesa: rinnova senza record_expense e registra la spesa con expenses op add.";
		const paid = want ? readPeriodAmount(args.amount) : undefined;
		if (isProblem(paid)) return `Errore: ${paid.problem}.`;
		const day = want ? readPastDay(args.paid_on, today(), RENEWAL_PAID_DAY) : { date: today() };
		if (isProblem(day)) return `Errore: ${day.problem}.`;
		return { want, advance: args.advance === true, pay: { ...(paid === undefined ? {} : { amount: paid.amount }), day: day.date } };
	}

	async function renewed(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const read = readPayment(args);
		if (typeof read === "string") return read;
		const { want, advance, pay } = read;
		// A rerun of a call that rolled or recorded a charge already: its audit, then the same answer.
		const done = readable().find((r) => r.rolls?.some((x) => x.callId === ctx.callId || x.expenseCall === ctx.callId) || r.charges?.some((c) => c.callId === ctx.callId));
		if (done !== undefined) {
			const charge = done.charges?.find((c) => c.callId === ctx.callId);
			if (charge !== undefined) {
				await audit(ctx, "charge", 1);
				return chargedAnswer(done, charge.date, await recordPayment(done, charge.date, pay, ctx, charge.amount));
			}
			const roll = done.rolls?.find((x) => x.callId === ctx.callId || x.expenseCall === ctx.callId) as Roll;
			if (roll.callId === ctx.callId) await audit(ctx, "renewed", 1);
			const rec = want ? await payForRoll(done, roll, pay, ctx) : undefined;
			return roll.callId === ctx.callId ? rolledAnswer(done, roll, rec, want) : expenseOnlyAnswer(done, rec as ExpenseRecorded);
		}
		const found = pick(args, "active");
		if (typeof found === "string") return found;
		if (found.autoPay === true) return await charge(found, want, pay, ctx);
		const day = today();
		const rolledToday = [...(found.rolls ?? [])].reverse().find((x) => localDay(x.at) === day);
		// Marked today already, its expense not recorded: with record_expense (the hint after a roll
		// says so), only the expense of that payment, at its date and price; nothing moves, even when
		// the due date is still gone. Another payment is advance true.
		if (rolledToday !== undefined && want && !advance) {
			if (rolledToday.expense === undefined) {
				const input = expenseInput(found, rolledToday.from, pay, rolledToday.amount);
				const problem = typeof input === "string" ? input : options.expenses?.check(input, ctx);
				if (problem !== undefined) return `Errore: ${problem}.`;
				return expenseOnlyAnswer(found, await payForRoll(found, rolledToday, pay, ctx));
			}
			if (found.due >= day) return `La spesa di questo pagamento è già registrata: ${rolledToday.expense}. La scadenza resta ${withDate("il", found.due)}.`;
		}
		if (!advance && found.due >= day && (rolledToday !== undefined || addDays(found.due, -remindDays(found)) > day)) {
			const why = rolledToday !== undefined ? "È già stato segnato come pagato oggi" : `La prossima scadenza è ${withDate("il", found.due)}, ancora lontana`;
			return `Errore: ${why}: risulta già pagato fino ${withDate("al", found.due)}. Non segnarlo di nuovo. Se chi ti scrive vuole solo registrare una spesa, usa expenses op add; se ha davvero pagato in anticipo la scadenza ${withDate("del", found.due)}, rifai con advance true.`;
		}
		if (want) {
			const input = expenseInput(found, found.due, pay, amountAt(found, found.due));
			const problem = typeof input === "string" ? input : options.expenses?.check(input, ctx);
			if (problem !== undefined) return `Errore: ${problem}. Non ho spostato la scadenza.`;
		}
		await ctx.step("roll", async () => {
			write(found.id, (r) => {
				if (r.rolls?.some((x) => x.callId === ctx.callId)) return r;
				if (r.status !== "active") throw new RenewalError(`il rinnovo ${r.id} è disdetto: prima op reactivate`);
				const to = nextDue(r);
				const { trial: _t, ...rest } = r;
				// The payment's amount as it is now: a later price change never touches its expense.
				const paid = amountAt(r, r.due);
				return { ...rest, due: to, rolls: [...(r.rolls ?? []), { callId: ctx.callId, from: r.due, to, ...(paid === undefined ? {} : { amount: paid }), by: who(ctx), at: now().toISOString() }].slice(-RENEWAL_LIMITS.rolls) };
			});
			return true;
		});
		await audit(ctx, "renewed", 1);
		const renewal = readable().find((r) => r.id === found.id);
		const roll = renewal?.rolls?.find((x) => x.callId === ctx.callId);
		if (renewal === undefined || roll === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		const rec = want ? await payForRoll(renewal, roll, pay, ctx) : undefined;
		return rolledAnswer(renewal, roll, rec, want);
	}

	/** Records the expense of a roll's payment (or finds it, on a rerun) and keeps its id on the roll. */
	async function payForRoll(r: Renewal, roll: Roll, pay: Payment, ctx: ToolContext): Promise<ExpenseRecorded> {
		const rec = await recordPayment(r, roll.from, pay, ctx, roll.amount);
		if (!("problem" in rec) && roll.expense === undefined) {
			await ctx.step("attach", async () => {
				write(r.id, (x) => ({ ...x, rolls: (x.rolls ?? []).map((o) => (o.callId === roll.callId && o.expense === undefined ? { ...o, expense: rec.id, ...(o.callId === ctx.callId ? {} : { expenseCall: ctx.callId }) } : o)) }));
				return true;
			});
		}
		return rec;
	}

	/** The expense of the payment of `r` due on `due`, through the expenses' own add. */
	async function recordPayment(r: Renewal, due: string, pay: Payment, ctx: ToolContext, then?: string): Promise<ExpenseRecorded> {
		const input = expenseInput(r, due, pay, then);
		if (typeof input === "string") return { problem: input };
		if (options.expenses === undefined) return { problem: "qui le spese non si registrano" };
		return options.expenses.record(input, ctx);
	}

	function rolledAnswer(r: Renewal, roll: Roll, rec: ExpenseRecorded | undefined, want: boolean): string {
		const day = today();
		const lines = [`Fatto: ${r.id} segnato come pagato o rinnovato. La prossima scadenza ora è ${withDate("il", roll.to)} (era ${withDate("il", roll.from)}).`, fenced(renewalLine(r, day))];
		if (r.due < day) lines.push(`Anche la scadenza ${withDate("del", r.due)} è passata: chiedi a chi ti scrive se ha pagato anche quella; se sì, rifai op renewed.`);
		if (rec !== undefined) lines.push(...expenseLines(rec, true));
		else if (!want && options.expenses !== undefined) lines.push("Se chi ti scrive vuole anche la spesa nel registro, rifai renewed con record_expense true: oggi registra solo la spesa, senza spostare di nuovo la scadenza.");
		return lines.join("\n");
	}

	function expenseOnlyAnswer(r: Renewal, rec: ExpenseRecorded): string {
		const gone = r.due < today() ? [`La scadenza ${withDate("del", r.due)} è ancora passata: se chi ti scrive ha pagato anche quella, rifai renewed con advance true.`] : [];
		return [`${r.id} era già segnato come pagato oggi: la scadenza resta ${withDate("il", r.due)}, non l'ho spostata.`, ...expenseLines(rec, false), ...gone].join("\n");
	}

	/** An autoPay renewal: nothing moves; with record_expense, the last charge becomes an expense, once. */
	async function charge(r: Renewal, want: boolean, pay: Payment, ctx: ToolContext): Promise<string> {
		const day = today();
		if (!want) return `${r.id} si paga da solo: la scadenza va avanti da sola (prossimo addebito ${withDate("il", effectiveDue(r, day))}), non serve segnarlo. Se chi ti scrive vuole registrare la spesa dell'ultimo addebito, rifai con record_expense true.`;
		// The charge resolved once: a rerun records the same one even on another day.
		const date = (await ctx.step("resolve", async () => lastCharge(r, day) ?? null)) ?? undefined;
		if (date === undefined) return `Errore: per ${r.id} non è ancora partito nessun addebito: il primo è ${withDate("il", effectiveDue(r, day))}. Non c'è una spesa da registrare.`;
		const recorded = r.charges?.find((c) => c.date === date);
		if (recorded !== undefined) return `La spesa dell'addebito ${withDate("del", date)} è già registrata: ${recorded.expense}. Il prossimo addebito è ${withDate("il", effectiveDue(r, day))}.`;
		const charged: Payment = { ...pay, day: pay.day === day ? date : pay.day };
		const paid = amountAt(r, date);
		const input = expenseInput(r, date, charged, paid);
		const problem = typeof input === "string" ? input : options.expenses?.check(input, ctx);
		if (problem !== undefined) return `Errore: ${problem}.`;
		const rec = await recordPayment(r, date, charged, ctx, paid);
		if ("problem" in rec) return `Errore: ${rec.problem}. Registra la spesa con expenses op add.`;
		await ctx.step("charge", async () => {
			write(r.id, (x) => (x.charges?.some((c) => c.callId === ctx.callId) ? x : { ...x, charges: [...(x.charges ?? []), { date, callId: ctx.callId, expense: rec.id, ...(charged.amount ?? paid) === undefined ? {} : { amount: (charged.amount ?? paid) as string } }].slice(-RENEWAL_LIMITS.charges) }));
			return true;
		});
		await audit(ctx, "charge", 1);
		const renewal = readable().find((x) => x.id === r.id) ?? r;
		return chargedAnswer(renewal, date, rec);
	}

	function chargedAnswer(r: Renewal, date: string, rec: ExpenseRecorded): string {
		return [`${r.id} si paga da solo: la spesa è dell'addebito ${withDate("del", date)}; il prossimo addebito è ${withDate("il", effectiveDue(r, today()))}.`, ...expenseLines(rec, false)].join("\n");
	}

	async function cancel(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const again = changedBy(ctx);
		if (again?.status === "cancelled") {
			await audit(ctx, "cancel", 1);
			return cancelledAnswer(again, []);
		}
		const found = pick(args, "active", true);
		if (typeof found === "string") {
			const done = typeof args.id === "string" ? findRenewals(readable(), args.id).filter((r) => r.status === "cancelled") : [];
			return done.length === 1 && done[0]?.cancelled !== undefined ? `Il rinnovo ${done[0].id} era già segnato come disdetto ${withDate("il", done[0].cancelled.on)}.` : found;
		}
		const on = readPastDay(args.date, today(), CANCEL_DAY);
		if (isProblem(on)) return `Errore: ${on.problem}.`;
		let ends: string | undefined;
		if (args.ends !== undefined) {
			const read = readDue(args.ends, today());
			if (isProblem(read)) return `Errore: ends: ${read.problem}.`;
			if (read.date < on.date) return `Errore: ends (l'ultimo giorno valido, ${long(read.date)}) viene prima della disdetta (${long(on.date)}).`;
			ends = read.date;
		}
		const end = effectiveTermEnd(found, on.date);
		const by = noticeAlerts(found) ? deadlineFor(found, end) : undefined;
		await ctx.step("cancel", async () => {
			write(found.id, (r) => (r.status === "cancelled" ? r : { ...r, status: "cancelled", cancelled: { on: on.date, ...(ends === undefined ? {} : { ends }), by: who(ctx), at: now().toISOString() }, lastCall: ctx.callId }));
			return true;
		});
		await audit(ctx, "cancel", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		const late = by !== undefined && on.date > by ? [`Il termine per disdire era ${withDate("il", by)}. Di' a chi ti scrive: «La disdetta è arrivata dopo il termine ${withDate("del", by)}: controlla con il fornitore se la scadenza ${withDate("del", end)} si paga ancora.»`] : [];
		return cancelledAnswer(renewal, late);
	}

	function cancelledAnswer(r: Renewal, notes: readonly string[]): string {
		return [`Fatto, ${r.id} segnato come disdetto: resta nell'elenco dei disdetti e non lo segnalo più.`, fenced(renewalLine(r, today())), ...notes].join("\n");
	}

	async function reactivate(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const again = changedBy(ctx);
		if (again?.status === "active") {
			await audit(ctx, "reactivate", 1);
			return reactivatedAnswer(again);
		}
		const found = pick(args, "cancelled");
		if (typeof found === "string") return found;
		let due: { date: string; day: number } | undefined;
		if (args.due !== undefined) {
			const read = readDue(args.due, today());
			if (isProblem(read)) return `Errore: ${read.problem}.`;
			due = placeDue(read, found.months, today());
		}
		await ctx.step("reactivate", async () => {
			store.edit(found.id, (r) => {
				if (r.status === "active") return r;
				const { cancelled: _c, ...rest } = r;
				const back: Renewal = { ...rest, status: "active" };
				// Without a new due date, what moves by itself starts again from its next due as of
				// today: the periods while it was cancelled are neither charges nor to pay.
				const next = due ?? (movesBySelf(back) ? { date: effectiveDue(back, today()), day: r.day } : undefined);
				return { ...back, ...(next === undefined ? {} : { due: next.date, day: next.day, start: next.date }), lastCall: ctx.callId, edited: { by: who(ctx), at: now().toISOString() } };
			});
			return true;
		});
		await audit(ctx, "reactivate", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		return reactivatedAnswer(renewal);
	}

	function reactivatedAnswer(r: Renewal): string {
		const day = today();
		const late = movesBySelf(r)
			? r.cancelled === undefined && r.start === r.due && r.due >= day
				? [`Riparte ${withDate("dal", r.due)}: i periodi in cui era disdetto non li conto né come addebitati né come da pagare. Se chi ti scrive ha pagato qualcosa in quel tempo, registralo con expenses op add.`]
				: []
			: r.due < day
				? [`La scadenza ${withDate("del", r.due)} è passata: chiedi a chi ti scrive la prossima scadenza e correggila con op edit (due).`]
				: [];
		return [`Fatto, ${r.id} è di nuovo attivo.`, fenced(renewalLine(r, today())), ...late].join("\n");
	}

	async function edit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const again = changedBy(ctx);
		if (again !== undefined) {
			await audit(ctx, "edit", 1);
			return editedAnswer(again, []);
		}
		const found = pick(args, "any");
		if (typeof found === "string") return found;
		if (!editsSomething(args)) return "Errore: dimmi cosa cambia nel rinnovo (nome, fornitore, categoria, importo, frequenza, scadenza, durata, rinnovo automatico, addebito automatico, preavviso, promemoria, pagamento, nota o documento).";
		const fields = await readFields(args, { today: today(), workspace, editing: true, ...(found.vatRate === undefined ? {} : { vatRate: found.vatRate }) });
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		// Checked first on the renewal as read, to answer plainly; applied under the lock to the renewal as saved then.
		const base = normalised(found, today());
		const check = applyFields(fields, base, today());
		if (isProblem(check)) return `Errore: ${check.problem}.`;
		if (sameDraft(check.draft, base, STATE_KEYS)) return `Niente da cambiare: il rinnovo ${found.id} è già così.\n${fenced(renewalLine(found, today()))}`;
		const notes = await ctx.step("apply", async () => {
			let said: string[] = [];
			write(found.id, (r) => {
				const applied = applyFields(fields, r, today());
				if (isProblem(applied)) throw new RenewalError(applied.problem);
				said = applied.notes;
				const keep = { id: r.id, by: r.by, at: r.at, status: r.status, ...(r.callId === undefined ? {} : { callId: r.callId }), ...(r.cancelled === undefined ? {} : { cancelled: r.cancelled }), ...(r.rolls === undefined ? {} : { rolls: r.rolls }), ...(r.charges === undefined ? {} : { charges: r.charges }) };
				return { ...keep, ...applied.draft, lastCall: ctx.callId, edited: { by: who(ctx), at: now().toISOString() } };
			});
			return said;
		});
		await audit(ctx, "edit", 1);
		const renewal = readable().find((r) => r.id === found.id);
		if (renewal === undefined) return `Errore: il rinnovo ${found.id} non c'è più.`;
		return editedAnswer(renewal, notes);
	}

	function editedAnswer(r: Renewal, notes: readonly string[]): string {
		return [`Fatto, il rinnovo ${r.id} ora è:`, fenced(renewalLine(r, today())), ...notes, ...deadlineGone(r)].join("\n");
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		// The renewal resolved once: a rerun gets the same one even after it is gone.
		const resolved = await ctx.step("resolve", async (): Promise<{ id: string; line: string | null } | { error: string }> => {
			if (typeof args.id !== "string" || args.id.trim() === "") return { error: "Errore: indica il rinnovo da togliere con id, per esempio R-0001, o con il suo nome. Per una disdetta usa op cancel, che lo tiene nello storico." };
			const all = readable();
			const { found, loose } = renewalMatches(all, args.id);
			if (found.length === 1 && loose) return { error: confirmAnswer(found) };
			if (found.length === 1) return { id: (found[0] as Renewal).id, line: renewalLine(found[0] as Renewal, today()) };
			if (found.length > 1) return { error: `Errore: più rinnovi corrispondono:\n${fenced(found.slice(0, 10).map((r) => renewalLine(r, today())).join("\n"))}\nChiedi a chi ti scrive quale, poi rifai con id.` };
			const n = /^\s*r\s*-?\s*0*(\d{1,6})\s*$/i.exec(args.id);
			if (n !== null) return { id: `R-${n[1]?.padStart(4, "0")}`, line: null };
			return { error: `Errore: non trovo il rinnovo ${fenced(args.id.slice(0, 40))}. Guarda l'elenco con op list (status all).` };
		});
		if ("error" in resolved) return resolved.error;
		const result = await ctx.step("apply", async () => store.remove(resolved.id));
		if (result === "unknown") return `Errore: non trovo il rinnovo ${resolved.id}. Guarda l'elenco con op list (status all).`;
		if (result === "gone" && resolved.line === null) return `Il rinnovo ${resolved.id} era già stato tolto.`;
		await audit(ctx, "remove", 1);
		return `Fatto, tolto il rinnovo ${resolved.id}; il suo numero non sarà riusato.${resolved.line === null ? "" : `\n${fenced(resolved.line)}`}`;
	}

	async function exportCsv(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		if (args.status !== undefined && !STATUSES.includes(args.status as Status)) return `Errore: status è uno di questi: ${STATUSES.join(", ")}.`;
		const status = (args.status ?? "all") as Status;
		const rows = sorted(readable().filter((r) => status === "all" || r.status === status));
		if (rows.length === 0) return "Nessun rinnovo da esportare.";
		const day = today();
		// The name only from today's date, under rinnovi/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `rinnovi/rinnovi-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, renewalsCsv(rows, day))).path);
		await audit(ctx, "export", rows.length);
		return `Salvato ${written} (${rows.length === 1 ? "1 rinnovo" : `${rows.length} rinnovi`}; separatore «;», decimali con la virgola, si apre con Excel). Mandalo con file_send se chi ti scrive lo vuole.`;
	}
}
