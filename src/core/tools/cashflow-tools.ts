import { BRIEF_DAYS, CASHFLOW_LIMITS, type CashItem, CashflowError, cashflowAgentReads, itemId, itemRecurrence, parseItemId, ROLL_NOTE_DAYS, signedCents, STALE_BALANCE_DAYS } from "../cashflow.ts";
import { applyPatch, editPatch, findItem, type Found, lookalikes } from "../cashflow-items.ts";
import { project, type Projection } from "../cashflow-projection.ts";
import { applyChanges, averageSpend, canoneFlows, type Change, dedupe, type Hypothetical, hypotheticalFlows, invoiceFlows, itemFlows, type Movement, quoteFlows, renewalFlows, rollForward, TAX_TWIN_DAYS, taxDuplicates, taxFlows, unbilledPotential, voceDuplicates } from "../cashflow-sources.ts";
import { statementOf } from "../bank.ts";
import type { BankStore } from "../bank-store.ts";
import { CASHFLOW_BROKEN, type CashflowStore, latestBalance } from "../cashflow-store.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import type { ExpenseStore } from "../expense-store.ts";
import { euros, n1 } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { register } from "../invoices.ts";
import { addDays, dayOfIn, daysBetween, todayIn } from "../italian-calendar.ts";
import { withDate } from "../italian-format.ts";
import type { ClientStore } from "../client-store.ts";
import type { PriceListStore } from "../price-list-store.ts";
import type { QuoteStore } from "../quote-store.ts";
import type { RecurringStore } from "../recurring-invoice-store.ts";
import { scaled } from "../quote-sums.ts";
import type { RenewalStore } from "../renewal-store.ts";
import { REGIME_ORDINARIO } from "../sales-invoice-rules.ts";
import type { SalesInvoiceStore } from "../sales-invoice-store.ts";
import { regimeOf } from "../sales-invoices.ts";
import type { TaxStore } from "../tax-store.ts";
import { taxPayments, yearIncassi } from "../tax-sums.ts";
import type { TimesheetStore } from "../timesheet-store.ts";
import { vatForecast } from "../vat-forecast.ts";
import type { VatStore } from "../vat-store.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { readSignedEuros } from "../money-input.ts";
import { readHorizon, readHypothetical, readItemFields } from "./cashflow-input.ts";
import { briefAnswer, briefHint, type ChangeLine, daysText, fenced, forecastAnswer, itemLine, listAnswer, movementLabel, projectionCsv, staleLine, startOf, type View, whatIfAnswer } from "./cashflow-render.ts";
import { type DayWords, readPastDay } from "./day-input.ts";
import { expectedCanoni } from "./recurring-invoice-cash.ts";
import { isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";

const CASHFLOW_OPS = ["set_balance", "set_alert", "add_item", "edit_item", "remove_item", "list_items", "forecast", "what_if", "export"] as const;
type Op = (typeof CASHFLOW_OPS)[number];

/** What changed, for the audit: the op and how many (balances, voci, rows), never amounts, names, notes or dates. */
export type CashflowEvent = { readonly type: "cashflow.changed"; readonly op: "set_balance" | "set_alert" | "add_item" | "edit_item" | "remove_item" | "export"; readonly count: number };

export type CashflowToolsOptions = {
	readonly workspace: Workspace;
	readonly store: CashflowStore;
	/** The other registers, read only: the scadenzario (company and paid marks), the expenses, the renewals, the quotes, the hours. */
	readonly invoices: Pick<InvoiceStore, "read">;
	/** The scadenzario's scanner of the same workspace, shared (one cache); one of its own otherwise. */
	readonly scanner?: InvoiceScanner;
	readonly expenses: Pick<ExpenseStore, "read">;
	readonly renewals: Pick<RenewalStore, "read">;
	readonly quotes?: Pick<QuoteStore, "read">;
	readonly timesheet: Pick<TimesheetStore, "read">;
	/** The tax profile (taxes.ts), read only: its estimated F24 are a source when it exists. */
	readonly taxes?: Pick<TaxStore, "read">;
	/** La liquidazione IVA (vat.ts) and the fatture in uscita, read only: for the ordinario, the estimated F24 of the IVA are a source. */
	readonly vat?: Pick<VatStore, "read">;
	readonly sales?: Pick<SalesInvoiceStore, "read">;
	/** Le fatture ricorrenti, read only, with the listino and the client cards their drafts read: the canoni not drafted yet are a source (ADR 0088). */
	readonly recurring?: Pick<RecurringStore, "read">;
	readonly priceList?: Pick<PriceListStore, "read">;
	readonly clients?: Pick<ClientStore, "read">;
	/** L'estratto conto, read only: its movements for a balance that came from a statement. */
	readonly bank?: Pick<BankStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: CashflowEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Previsione di cassa of the owner (i costi fissi vanno in renewals, qui solo F24, prelievi, rate e incassi senza fattura con add_item): how much money there will be on the bank account, day by day, from the balance they say plus what comes in and goes out (open invoices to collect and to pay by due date, accepted quotes not invoiced yet, the canoni of the recurring invoices until they are issued (to prepare, then drafts to issue), renewals, the average spending of the expenses, the voci added here).",
	"What the person says → op: «ho 3.200 euro sul conto» → set_balance; «avvisami se scendo sotto 1000» → set_alert; «quanti soldi avrò a fine mese?», «come sono messo nei prossimi 90 giorni?», «quando vado in rosso?» → forecast (horizon); «posso permettermi un computer da 2000 euro a dicembre?» → what_if (amount, date, name); «e se Gamma paga con 30 giorni di ritardo?» → what_if with delay; «e se Beta non paga?» → what_if with drop; nothing of a what_if is saved.",
	`Rule: fixed recurring costs (rent, software, insurance, utilities, subscriptions) belong to renewals, not here. Voci (add_item) are only for F24 not estimated by taxes or vat_settlement (other taxes; the IVA only when the person wants to fix its amount: the voce then counts instead of the estimate. An F24 the taxes or vat_settlement tool estimates is counted already, and a voce named F24 IVA, liquidazione IVA, acconto IVA, or F24, tasse, INPS, IRPEF, sostitutiva, Agenzia delle Entrate, or saldo/acconto with imposta or contributi, within ${TAX_TWIN_DAYS} days of it replaces the estimate, or its part when well below it), the owner's withdrawals, loan instalments and money expected without an invoice. Before adding, the tool checks for a renewal or voce of about the same amount and name: when it asks, ask the person and repeat with confirm true only if it is a different one.`,
	"set_balance: amount (euros on the account, a minus when overdrawn; «8.400», «8,4k», «8 mila» are read), date (default today, never in the future). set_alert: amount, the balance under which the morning brief warns (\"\" removes; alert_below on set_balance works too).",
	"add_item: kind entrata | uscita, amount (euros, always positive), name, date (12/11/2026, «il 27», «ogni 27 del mese», «ogni lunedì», «fine mese», «dicembre» = its last day), frequency (settimanale, quindicinale, «ogni 15 giorni», «ogni lunedì», mensile, trimestrale, annuale, «ogni 2 mesi»; none: once), until, note, confirm. edit_item: id or name, and the fields to change (name, amount, date, until, note, frequency, kind; new_amount with new_amount_from: a new amount from that day; \"\" clears until, note, new_amount). remove_item: id or name. list_items: the balance, the threshold and the voci.",
	"forecast: horizon («fine mese», «fine mese prossimo», «fine trimestre», «prossima settimana», «30 giorni», «3 mesi», «fino a dicembre», «fine anno», a date; or days; default 30 days, today included); include_overdue (default true: overdue invoices to collect counted today); include_average_spend (default true); include_quotes (default true: accepted quotes not invoiced yet); include_taxes (default true: the F24 estimated by the taxes tool, when the person has a tax profile, or for the regime ordinario the F24 of the IVA estimated by vat_settlement; a voce of theirs for the same F24 counts instead, an expense recorded for it marks it paid); compact true: the brief's line only.",
	`what_if: as forecast plus hypothetical voci (amount, date, kind default uscita, frequency, name; or several in items, at most ${CASHFLOW_LIMITS.whatIf}), delay ({party or invoice, days}: paid that many days later) and drop ({party or invoice}: not paid).`,
	"export: the daily projection as a CSV for Excel under cassa/ (horizon as forecast); then send it with file_send. Repeat amounts and dates as given, never compute them yourself.",
].join(" ");

const BALANCE_DAY: DayWords = { field: "date è il giorno del saldo", future: "il saldo si dice per oggi o un giorno passato" };

type Flags = { readonly includeOverdue: boolean; readonly includeAverage: boolean; readonly includeQuotes: boolean; readonly includeTaxes: boolean };

/**
 * La previsione di cassa (cashflow.ts): the balance and the voci kept here; the forecast and the
 * what_if from the other registers, read only; the daily CSV. Amounts, dates and ids are this
 * tool's; names of clients, suppliers, renewals, quotes and voci, and notes, are fenced. Today is
 * read once per call.
 */
export function createCashflowTools(options: CashflowToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const scanner = options.scanner ?? new InvoiceScanner(workspace);
	const dayOf = dayOfIn(timeZone);
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const audit = async (ctx: ToolContext, op: CashflowEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "cashflow.changed", op, count });
			return true;
		});
	};
	const amount = { type: ["number", "string"], description: "euros: a JSON number (1250.5) or a string as said («1.250,50», «8.400», «1,5k»)" };
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const kind = { type: "string", enum: ["entrata", "uscita"], description: "entrata (money in) or uscita (money out); «entra», «esce», «costo» are read too" };
	const frequency = text(60, "settimanale, quindicinale, «ogni 15 giorni», «ogni lunedì», mensile, bimestrale, trimestrale, semestrale, annuale, «ogni N mesi»; none: once");
	const hypothetical = {
		type: "object",
		properties: { amount, date: text(60, "the day"), kind: { ...kind, description: "default uscita" }, frequency, name: text(CASHFLOW_LIMITS.name, "what it is") },
		required: ["amount", "date"],
		additionalProperties: false,
	};
	const change = (days: boolean) => ({
		type: "object",
		properties: {
			party: text(120, "the client's or supplier's name or partita IVA"),
			invoice: text(40, "the invoice number"),
			...(days ? { days: { type: "integer", minimum: 1, maximum: CASHFLOW_LIMITS.maxDelay, description: "days later" } } : {}),
		},
		required: days ? ["days"] : [],
		additionalProperties: false,
	});
	const changes = (days: boolean, description: string) => ({ anyOf: [change(days), { type: "array", maxItems: CASHFLOW_LIMITS.whatIf, items: change(days) }], description });
	return [
		{
			name: "cashflow",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...CASHFLOW_OPS] },
					amount: { ...amount, description: `set_balance: ${amount.description} on the account, a minus when overdrawn; set_alert: the threshold; add_item, edit_item, what_if: of the voce, positive` },
					date: text(60, "set_balance: the day of the balance (default today); add_item, edit_item, what_if: the day of the voce"),
					alert_below: { ...amount, description: "set_balance: the brief warns below this balance; \"\" removes" },
					kind,
					name: text(CASHFLOW_LIMITS.name, "add_item, edit_item, what_if: what it is; edit_item, remove_item: finds the voce when no id"),
					frequency,
					until: text(60, "add_item, edit_item: the last day of a recurring voce (\"\" clears)"),
					note: text(CASHFLOW_LIMITS.note, "add_item, edit_item: a note of the person's (\"\" clears)"),
					new_amount: { ...amount, description: "edit_item: the amount from new_amount_from on (\"\" clears)" },
					new_amount_from: text(60, "edit_item: the day new_amount starts"),
					confirm: { type: "boolean", description: "add_item: true only after the person said it is not the lookalike the tool found" },
					id: text(40, "edit_item, remove_item: the voce's id, C-0001"),
					items: { type: "array", maxItems: CASHFLOW_LIMITS.whatIf, items: hypothetical, description: "what_if: several hypothetical voci" },
					delay: changes(true, "what_if: an invoice (or a party's invoices) paid days later"),
					drop: changes(false, "what_if: an invoice (or a party's invoices) not paid"),
					horizon: text(60, "forecast, what_if, export: «fine mese», «fine mese prossimo», «fine trimestre», «prossima settimana», «90 giorni», «3 mesi», «fino a dicembre», «fine anno», a date; default 30 days, today included"),
					days: { type: "integer", minimum: 1, maximum: CASHFLOW_LIMITS.maxDays, description: "forecast, what_if, export: days, today included, instead of horizon" },
					include_overdue: { type: "boolean", description: "forecast, what_if, export: count invoices to collect already overdue today (default true)" },
					include_average_spend: { type: "boolean", description: "forecast, what_if, export: the average daily spending as an estimate (default true)" },
					include_quotes: { type: "boolean", description: "forecast, what_if, export: accepted quotes not invoiced yet as expected income (default true)" },
					include_taxes: { type: "boolean", description: "forecast, what_if, export: the F24 estimated from the tax profile, when there is one (default true)" },
					compact: { type: "boolean", description: "forecast: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!CASHFLOW_OPS.includes(args.op as Op)) return `Errore: op è una di queste: ${CASHFLOW_OPS.join(", ")}.`;
				const op = args.op as Op;
				// Another agente's request is not the person's word: it reads (forecast, list_items, what_if), nothing else.
				if (isAgentTurn(ctx) && !cashflowAgentReads(args)) {
					return "Errore: in una richiesta di un altro agente non cambio il saldo o la soglia, non aggiungo, cambio o tolgo voci e non esporto la cassa: lo fa chi ti scrive, nella sua conversazione.";
				}
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "set_balance":
							return await setBalance(args, ctx, day);
						case "set_alert":
							return await setAlert(args, ctx);
						case "add_item":
							return await addItem(args, ctx, day);
						case "edit_item":
							return await editItem(args, ctx, day);
						case "remove_item":
							return await removeItem(args, ctx, day);
						case "list_items":
							return listItems(day, ctx);
						case "forecast":
							return await forecast(args, ctx, day);
						case "what_if":
							return await whatIf(args, ctx, day);
						case "export":
							return await exportCsv(args, ctx, day);
					}
				} catch (error) {
					if (error instanceof CashflowError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function readable() {
		const book = store.read();
		if (book.broken) throw new CashflowError(CASHFLOW_BROKEN);
		return book;
	}

	function readAlert(value: unknown, what: string): string | null | undefined | { problem: string } {
		if (value === "" || value === null) return null;
		return readSignedEuros(value, fenced, what);
	}

	function alertLine(alert: string | null): string {
		if (alert === null) return "Tolta la soglia: il brief del mattino avvisa solo se il saldo previsto va sotto zero.";
		return `Fatto: se il brief del mattino è attivo, ti avviso lì quando nei prossimi ${BRIEF_DAYS} giorni il saldo previsto scende sotto ${listAmount(alert)}.`;
	}

	async function setBalance(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const balance = readSignedEuros(args.amount, fenced, "amount");
		if (isProblem(balance)) return `Errore: ${balance.problem}.`;
		const alert = readAlert(args.alert_below, "alert_below");
		if (alert !== null && isProblem(alert)) return `Errore: ${alert.problem}.`;
		if (balance === undefined && alert === undefined) return "Errore: dimmi il saldo del conto (amount), o la soglia sotto cui avvisare (set_alert).";
		const said = readPastDay(args.date, day, BALANCE_DAY);
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (balance === undefined && args.date !== undefined) return "Errore: date va con amount, il saldo di quel giorno.";
		await ctx.step("apply", async () => {
			store.setBalance(balance === undefined ? undefined : { amount: balance, date: said.date, by: who(ctx), at: now().toISOString(), callId: ctx.callId }, alert);
			return true;
		});
		await audit(ctx, "set_balance", 1);
		const book = readable();
		const latest = latestBalance(book.balances);
		const lines: string[] = [];
		if (balance !== undefined) {
			lines.push(`Fatto, saldo ${withDate("del", said.date)}: ${listAmount(balance)}.`);
			if (latest !== undefined && latest.date > said.date) lines.push(`C'è già un saldo più recente, ${withDate("del", latest.date)}: la previsione parte da quello.`);
			const stale = latest === undefined ? undefined : staleLine(latest, day, STALE_BALANCE_DAYS);
			if (stale !== undefined) lines.push(stale);
			else if (latest !== undefined && daysBetween(latest.date, day) > ROLL_NOTE_DAYS) lines.push("La previsione lo porta a oggi con gli incassi e le spese registrati nel frattempo.");
		}
		if (alert !== undefined) lines.push(alertLine(alert));
		return lines.join("\n");
	}

	async function setAlert(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const raw = args.amount !== undefined ? args.amount : args.alert_below;
		if (raw === undefined) return "Errore: dimmi la soglia in euro (amount), o \"\" per toglierla.";
		const alert = readAlert(raw, "amount");
		if (alert === undefined) return "Errore: dimmi la soglia in euro (amount).";
		if (alert !== null && isProblem(alert)) return `Errore: ${alert.problem}.`;
		await ctx.step("apply", async () => {
			store.setBalance(undefined, alert);
			return true;
		});
		await audit(ctx, "set_alert", 1);
		return alertLine(alert);
	}

	function listAmount(value: string): string {
		return euros(signedCents(value));
	}

	function textField(value: unknown, max: number, what: string): string | undefined | { problem: string } {
		if (value === undefined) return undefined;
		if (typeof value !== "string") return { problem: `${what} è un testo` };
		const t = value.trim();
		if (t.length > max) return { problem: `${what} è al massimo ${max} caratteri` };
		return t;
	}

	async function addItem(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		// This call recorded its voce already (run again after a stop): its audit, then the same answer.
		const book = readable();
		const saved = book.items.find((i) => i.callId === ctx.callId);
		if (saved !== undefined) {
			await audit(ctx, "add_item", 1);
			return added(saved, [], day);
		}
		const name = textField(args.name, CASHFLOW_LIMITS.name, "name");
		if (name !== undefined && isProblem(name)) return `Errore: ${name.problem}.`;
		if (name === undefined || name === "") return "Errore: serve name, cos'è la voce (F24, stipendio del titolare, rata del mutuo, incasso dal cliente…).";
		const note = textField(args.note, CASHFLOW_LIMITS.note, "note");
		if (note !== undefined && isProblem(note)) return `Errore: ${note.problem}.`;
		if (args.confirm !== undefined && typeof args.confirm !== "boolean") return "Errore: confirm è true o false.";
		const fields = readItemFields(args, day, fenced);
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		const renewals = options.renewals.read();
		const recurrence = itemRecurrence(fields);
		const voce = { name, kind: fields.kind, cents: scaled(fields.amount, 2), date: fields.date, ...(recurrence === undefined ? {} : { recurrence }) };
		const twins = lookalikes(voce, book.items, renewals.broken ? [] : renewals.renewals, day, (i) => itemLine(i, day), euros);
		if (args.confirm === true && twins.length > 0) {
			// The yes over a lookalike is a person's own message, never a notice, a schedule or another agente (ADR 0088).
			const notPerson = requirePersonFor(ctx, "aggiungo una voce simile a una che c'è già");
			if (notPerson !== undefined) return notPerson;
		}
		if (args.confirm !== true) {
			if (twins.length > 0) {
				return [
					"Non l'ho aggiunta: c'è già qualcosa di simile, con un importo quasi uguale:",
					fenced(twins.join("\n")),
					"Chiedi a chi ti scrive se è la stessa cosa: se è un'altra, ripeti add_item con confirm true; se è la stessa, non serve aggiungerla.",
				].join("\n");
			}
		}
		const item = await ctx.step("save", async () =>
			store.add(ctx.callId, (id) => ({
				id,
				kind: fields.kind,
				amount: fields.amount,
				name,
				date: fields.date,
				...(fields.months === undefined ? {} : { months: fields.months, day: fields.day as number }),
				...(fields.everyDays === undefined ? {} : { everyDays: fields.everyDays }),
				...(fields.until === undefined ? {} : { until: fields.until }),
				...(note === undefined || note === "" ? {} : { note }),
				by: who(ctx),
				at: now().toISOString(),
				callId: ctx.callId,
			})),
		);
		await audit(ctx, "add_item", 1);
		return added(item, fields.notes, day);
	}

	function added(i: CashItem, notes: readonly string[], day: string): string {
		return [`Aggiunta la voce ${i.id}, entra nella previsione.`, fenced(itemLine(i, day)), ...notes, "Ripeti date e importo come sono scritti."].join("\n");
	}

	/** The voce an id or a name names, or the error to say. */
	function located(found: Found): CashItem | string {
		if ("item" in found) return found.item;
		if ("missing" in found) return `Errore: non trovo la voce ${found.missing}. Guarda l'elenco con op list_items.`;
		return `Errore: ${found.error}.`;
	}

	async function editItem(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const book = readable();
		// This call changed its voce already (run again after a stop): its audit, then the same answer.
		const again = book.items.find((i) => i.lastCall === ctx.callId);
		if (again !== undefined) {
			await audit(ctx, "edit_item", 1);
			return edited(again, [], day);
		}
		const found = located(findItem(args.id !== undefined ? { id: args.id } : { name: args.name }, book.items, (i) => itemLine(i, day), fenced));
		if (typeof found === "string") return found;
		const change = editPatch(found, args, day, fenced);
		if (typeof change === "string") return change;
		// Only the fields this call touches, onto the voce as it is saved at the write: another change in between stays.
		const saved = await ctx.step("apply", async () => store.edit(found.id, (current) => ({ ...applyPatch(current, change.patch), lastCall: ctx.callId, edited: { by: who(ctx), at: now().toISOString() } })));
		await audit(ctx, "edit_item", 1);
		return edited(saved, change.notes, day);
	}

	function edited(i: CashItem, notes: readonly string[], day: string): string {
		return [`Fatto, cambiata la voce ${i.id}:`, fenced(itemLine(i, day)), ...notes, "Ripeti date e importo come sono scritti."].join("\n");
	}

	async function removeItem(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const book = readable();
		let id: string;
		let line: string | null;
		if (typeof args.id === "string" && args.id.trim() !== "") {
			const n = parseItemId(args.id);
			if (n === undefined) return "Errore: indica la voce con id, per esempio C-0001 (le vedi con op list_items).";
			id = itemId(n);
			line = await ctx.step("resolve", async () => {
				const item = book.items.find((i) => i.id === id);
				return item === undefined ? null : itemLine(item, day);
			});
		} else {
			// The voce named, kept by the step: a rerun removes the same one, and says it.
			const resolved: string[] = await ctx.step("resolve", async () => {
				const found = located(findItem({ name: args.name }, book.items, (i) => itemLine(i, day), fenced));
				return typeof found === "string" ? [found] : [found.id, itemLine(found, day)];
			});
			if (resolved.length === 1) return resolved[0] as string;
			id = resolved[0] as string;
			line = resolved[1] as string;
		}
		const result = await ctx.step("apply", async () => store.remove(id));
		if (result === "unknown") return `Errore: non trovo la voce ${id}. Guarda l'elenco con op list_items.`;
		if (result === "gone" && line === null) return `La voce ${id} era già stata tolta.`;
		await audit(ctx, "remove_item", 1);
		return `Fatto, tolta la voce ${id}; il suo numero non sarà riusato.${line === null ? "" : `\n${fenced(line)}`}`;
	}

	function listItems(day: string, ctx: ToolContext): string {
		const book = readable();
		return listAnswer(latestBalance(book.balances), book.alertBelow === undefined ? undefined : signedCents(book.alertBelow), book.items, day, isAgentTurn(ctx));
	}

	type Gathered = { readonly movements: readonly Movement[]; readonly dailySpend: bigint; readonly view: View; readonly somethingToForecast: boolean };

	/** What every register says from today (`day`) to `end`, read only. */
	async function gather(ctx: ToolContext, day: string, end: string, o: Flags): Promise<Gathered | string> {
		const book = readable();
		const balance = latestBalance(book.balances);
		if (balance === undefined) return "Errore: per la previsione serve il saldo del conto. Chiedi a chi ti scrive quanto ha sul conto oggi e salvalo con op set_balance.";
		const scan = await scanner.scan(ctx.signal, (t) => ctx.progress(t));
		const invoiceBook = options.invoices.read();
		const invoices = invoiceBook.broken ? [] : register(scan.invoices, invoiceBook.paid, invoiceBook.company, invoiceBook.reminders);
		const renewalBook = options.renewals.read();
		const rawInvoices = invoiceFlows(invoices, day, end, o.includeOverdue);
		const rawRenewals = renewalBook.broken ? undefined : renewalFlows(renewalBook.renewals, day, end);
		const { invoices: inv, renewals: ren, duplicates: invoiceTwins, maybe, autoPaid } = dedupe(rawInvoices, rawRenewals, renewalBook.broken ? [] : renewalBook.renewals, day);
		// A voce that is a renewal's payment: the renewal counts.
		const voci = voceDuplicates(itemFlows(book.items, day, end), ren?.movements ?? []);
		const duplicates = [...invoiceTwins, ...voci.duplicates];
		const quoteBook = o.includeQuotes ? options.quotes?.read() : undefined;
		const quotes = quoteBook === undefined || quoteBook.broken ? undefined : quoteFlows(quoteBook.quotes, invoices, day, end, dayOf);
		const expenseBook = options.expenses.read();
		// The F24 estimated from the tax profile, for the forfettario only: a voce of the person's for the same F24 counts instead, an expense recorded for it says it is paid.
		const taxBook = options.taxes?.read();
		const profile = taxBook === undefined || taxBook.broken ? undefined : taxBook.profile;
		const taxOn = o.includeTaxes && taxBook !== undefined && profile !== undefined && invoiceBook.company?.regime !== "ordinario";
		// The F24 of the IVA, for the ordinario only (never with the forfettario's): the same way.
		const ordinario = regimeOf(invoiceBook.broken ? undefined : invoiceBook.company, profile) === REGIME_ORDINARIO;
		const vatBook = o.includeTaxes && ordinario ? options.vat?.read() : undefined;
		const vatOn = vatBook !== undefined && !vatBook.broken && vatBook.settings !== undefined;
		const salesBook = vatOn ? options.sales?.read() : undefined;
		const vatDue = vatOn ? vatForecast({ book: vatBook, sales: salesBook === undefined || salesBook.broken ? [] : salesBook.invoices, register: invoices, dayOf, today: day, end }) : [];
		const payments = [...(taxOn ? taxPayments({ profile, figures: taxBook.years, incassi: yearIncassi(invoices, day, dayOf), today: day }, end) : []), ...vatDue];
		const taxed = taxOn || vatOn ? taxDuplicates(taxFlows(payments, day, end), voci.items, expenseBook.broken ? [] : expenseBook.expenses) : { taxes: [], twins: [], maybe: [] };
		const average = o.includeAverage && !expenseBook.broken ? averageSpend(expenseBook.expenses, renewalBook.renewals, book.items, invoices, day, vatOn ? "iva" : taxOn) : undefined;
		const hours = options.timesheet.read();
		const potential = hours.broken ? undefined : unbilledPotential(hours.entries, hours.rates);
		// The balance brought to now with what was marked paid or recorded after it, when the registers read and it is not too old.
		const canRoll = !invoiceBook.broken && !expenseBook.broken && !renewalBook.broken && daysBetween(balance.date, day) <= CASHFLOW_LIMITS.maxDays;
		const bankBook = balance.source === "bank" ? options.bank?.read() : undefined;
		const rolled = canRoll ? rollForward(balance, now().toISOString(), day, invoices, expenseBook.expenses, renewalBook.renewals, dayOf, bankBook === undefined || bankBook.broken ? [] : statementOf(bankBook.movements, bankBook.matches)) : undefined;
		// The canoni of the recurring invoices until issued: to draft, then drafts to issue; issued, among the invoices.
		const canoni = options.recurring === undefined || options.sales === undefined ? undefined : expectedCanoni({ recurring: options.recurring, sales: { store: options.sales, ...(options.clients === undefined ? {} : { clients: options.clients }) }, company: options.invoices, ...(options.taxes === undefined ? {} : { taxes: options.taxes }), ...(options.priceList === undefined ? {} : { priceList: options.priceList }) }, day, end);
		const canoneMoves = canoni === undefined ? [] : canoneFlows(canoni.expected, day, end);
		const movements = [...inv.movements, ...(ren?.movements ?? []), ...(quotes?.movements ?? []), ...canoneMoves, ...voci.items, ...taxed.taxes];
		const notes: string[] = [];
		if (canoni?.broken === true) notes.push("Le fatture ricorrenti non si leggono: canoni previsti esclusi.");
		else if ((canoni?.unpriced ?? 0) > 0) notes.push(`${n1(canoni?.unpriced ?? 0, "Un canone previsto non è contato", "# canoni previsti non sono contati")}: il suo importo ora non si può dire (una voce del listino che non c'è più, o il regime non ancora detto).`);
		if (taxBook?.broken === true) notes.push("Il profilo delle tasse non si legge: tasse stimate escluse.");
		else if (!o.includeTaxes && profile !== undefined) notes.push("Tasse stimate (F24) escluse.");
		if (vatBook?.broken === true) notes.push("La liquidazione IVA non si legge: IVA stimata esclusa.");
		else if (vatOn && salesBook?.broken === true) notes.push("Le fatture in uscita non si leggono: l'IVA stimata conta solo le fatture XML.");
		else if (!o.includeTaxes && ordinario && options.vat?.read().settings !== undefined) notes.push("IVA stimata (F24) esclusa.");
		if (o.includeAverage && average !== undefined && average.count === 0) notes.push("Nessuna spesa da contare negli ultimi 90 giorni: niente spesa media nella previsione.");
		if (!o.includeAverage) notes.push("Spesa media esclusa: contate solo fatture, preventivi, canoni, rinnovi e voci.");
		if (!o.includeQuotes) notes.push("Preventivi accettati esclusi.");
		const view: View = {
			today: day,
			balance,
			...(rolled === undefined ? {} : { rolled }),
			...(!canRoll && balance.date < day ? { unrolled: true as const } : {}),
			...(book.alertBelow === undefined ? {} : { alertBelow: signedCents(book.alertBelow) }),
			includeOverdue: o.includeOverdue,
			invoices: inv,
			invoiceNotes: { companySet: invoiceBook.company !== undefined, broken: invoiceBook.broken, unread: scan.unread.length, found: invoices.length },
			duplicates,
			maybe,
			autoPaid,
			...(ren === undefined ? {} : { renewals: ren }),
			renewalsBroken: renewalBook.broken,
			...(quotes === undefined ? {} : { quotes }),
			quotesBroken: quoteBook?.broken === true,
			...(canoneMoves.length === 0 ? {} : { canoni: canoneMoves.length }),
			...(average === undefined || average.count === 0 ? {} : { average }),
			expensesBroken: expenseBook.broken,
			...(potential === undefined ? {} : { potential }),
			...(taxOn || vatOn ? { taxTwins: taxed.twins, taxMaybe: taxed.maybe } : {}),
			...(taxOn ? { taxes: true as const } : {}),
			...(vatOn ? { vat: true as const } : {}),
			notes,
			// Another agente reads the forecast with no name of anyone (ADR 0088).
			...(isAgentTurn(ctx) ? { agent: true as const } : {}),
		};
		const openInvoices = invoices.some((i) => !i.paid && i.side !== undefined && !i.doc.integration);
		const activeRenewals = renewalBook.renewals.some((r) => r.status === "active");
		return { movements, dailySpend: average === undefined || average.count === 0 ? 0n : average.perDay, view, somethingToForecast: openInvoices || activeRenewals || canoneMoves.length > 0 };
	}

	function flags(args: Record<string, unknown>): Flags | string {
		for (const k of ["include_overdue", "include_average_spend", "include_quotes", "include_taxes", "compact"]) if (args[k] !== undefined && typeof args[k] !== "boolean") return `Errore: ${k} è true o false.`;
		return { includeOverdue: args.include_overdue !== false, includeAverage: args.include_average_spend !== false, includeQuotes: args.include_quotes !== false, includeTaxes: args.include_taxes !== false };
	}

	async function forecast(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const f = flags(args);
		if (typeof f === "string") return f;
		if (args.compact === true) return compact(ctx, day);
		const horizon = readHorizon(args.horizon, args.days, day);
		if (isProblem(horizon)) return `Errore: ${horizon.problem}.`;
		const g = await gather(ctx, day, horizon.end, f);
		if (typeof g === "string") return g;
		return forecastAnswer(project(startOf(g.view), g.movements, day, horizon.end, g.dailySpend), g.view);
	}

	/** The brief's line: the red, the threshold, an old balance; with no balance and no voce but invoices or renewals, a short hint. Read only, always. */
	async function compact(ctx: ToolContext, day: string): Promise<string> {
		const book = readable();
		const balance = latestBalance(book.balances);
		const end = addDays(day, BRIEF_DAYS - 1);
		if (balance === undefined) {
			if (book.items.length > 0) return briefAnswer(undefined, { today: day, somethingToForecast: false });
			const scan = await scanner.scan(ctx.signal, (t) => ctx.progress(t));
			const invoiceBook = options.invoices.read();
			const invoices = invoiceBook.broken ? [] : register(scan.invoices, invoiceBook.paid, invoiceBook.company, invoiceBook.reminders);
			const renewals = options.renewals.read();
			const something = invoices.length > 0 || (!renewals.broken && renewals.renewals.some((r) => r.status === "active"));
			return something ? briefHint() : briefAnswer(undefined, { today: day, somethingToForecast: false });
		}
		const g = await gather(ctx, day, end, { includeOverdue: true, includeAverage: true, includeQuotes: true, includeTaxes: true });
		if (typeof g === "string") return g;
		const p = project(startOf(g.view), g.movements, day, end, g.dailySpend);
		return briefAnswer(p, { balance, today: day, ...(g.view.alertBelow === undefined ? {} : { alertBelow: g.view.alertBelow }), somethingToForecast: g.somethingToForecast });
	}

	/** The delays or drops of a what_if, as said: one object or a list; an invoice number with its party when both are said. */
	function readChanges(value: unknown, withDays: boolean): Change[] | string {
		if (value === undefined) return [];
		const list = Array.isArray(value) ? value : [value];
		const what = withDays ? "delay" : "drop";
		if (list.length > CASHFLOW_LIMITS.whatIf) return `Errore: al massimo ${CASHFLOW_LIMITS.whatIf} in ${what}.`;
		const out: Change[] = [];
		for (const raw of list) {
			const o = typeof raw === "string" ? { party: raw } : (raw as Record<string, unknown>);
			if (typeof o !== "object" || o === null) return `Errore: ${what} è {party o invoice${withDays ? ", days" : ""}}.`;
			const said = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
			const invoice = said(o.invoice);
			const party = said(o.party);
			if ((invoice === undefined && party === undefined) || (invoice?.length ?? 0) > 40 || (party?.length ?? 0) > 120) return `Errore: ${what}: dimmi party (il cliente o fornitore) o invoice (il numero della fattura), o tutti e due.`;
			const change: Change = { ...(invoice === undefined ? {} : { invoice }), ...(party === undefined ? {} : { party }) };
			if (withDays) {
				if (typeof o.days !== "number" || !Number.isInteger(o.days) || o.days < 1 || o.days > CASHFLOW_LIMITS.maxDelay) return `Errore: delay: days è un numero di giorni da 1 a ${CASHFLOW_LIMITS.maxDelay}.`;
				out.push({ ...change, days: o.days });
			} else out.push(change);
		}
		return out;
	}

	async function whatIf(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const f = flags(args);
		if (typeof f === "string") return f;
		// A copy: the call's own arguments are never changed (a rerun reads them again).
		const raw: unknown[] = Array.isArray(args.items) ? [...args.items] : [];
		if (args.amount !== undefined || args.date !== undefined) raw.unshift({ amount: args.amount, date: args.date, ...(args.kind === undefined ? {} : { kind: args.kind }), ...(args.frequency === undefined ? {} : { frequency: args.frequency }), ...(args.name === undefined ? {} : { name: args.name }) });
		const delays = readChanges(args.delay, true);
		if (typeof delays === "string") return delays;
		const drops = readChanges(args.drop, false);
		if (typeof drops === "string") return drops;
		const all = [...delays, ...drops];
		// Another agente moves or drops an invoice by its number only: a name, existing or not, gets the same answer, so nothing tells whether that customer is there (ADR 0088).
		const agentAsks = isAgentTurn(ctx);
		if (agentAsks && all.some((c) => c.party !== undefined)) return "Un altro agente può spostare o togliere solo una fattura per numero, non un cliente.";
		if (raw.length === 0 && all.length === 0) return "Errore: dimmi l'ipotesi: amount e date (e kind, frequency, name), o più ipotesi in items; oppure delay o drop per una fattura pagata in ritardo o non pagata.";
		if (raw.length > CASHFLOW_LIMITS.whatIf) return `Errore: al massimo ${CASHFLOW_LIMITS.whatIf} ipotesi per volta.`;
		const hyps: Hypothetical[] = [];
		for (const r of raw) {
			const h = readHypothetical(r, day, fenced);
			if (isProblem(h)) return `Errore: ${h.problem}.`;
			hyps.push(h);
		}
		const horizon = readHorizon(args.horizon, args.days, day);
		if (isProblem(horizon)) return `Errore: ${horizon.problem}.`;
		// Not said: far enough to see a month past the last hypothesis (or delay), within the cap.
		let end = horizon.end;
		if (!horizon.said) {
			const longest = delays.reduce((n, d) => Math.max(n, d.days ?? 0), 0);
			const last = hyps.reduce((d, h) => (h.date > d ? h.date : d), addDays(day, longest));
			const wanted = addDays(last, BRIEF_DAYS - 1);
			const cap = addDays(day, CASHFLOW_LIMITS.maxDays - 1);
			if (wanted > end) end = wanted > cap ? cap : wanted;
		}
		const outside = hyps.filter((h) => h.date > end);
		if (outside.length > 0) return `Errore: l'ipotesi ${withDate("del", outside[0]?.date as string)} cade dopo la fine della previsione (${withDate("il", end)}): allarga horizon.`;
		const g = await gather(ctx, day, end, f);
		if (typeof g === "string") return g;
		const start = startOf(g.view);
		const late = new Set<Movement>(g.view.invoices?.late ?? []);
		const changed = applyChanges(g.movements, all, day);
		if (changed.ambiguous !== undefined) {
			const rows = changed.ambiguous.movements.map((m) => `• ${movementLabel(m, day, false, g.view.agent === true)}, ${euros(m.cents)}`);
			if (agentAsks) return "Errore: più fatture aperte hanno questo numero: quale sia lo dice solo chi ti scrive, nella sua conversazione.";
			return `Errore: più fatture aperte hanno questo numero; quale? Ripeti con party, il cliente o il fornitore:\n${fenced(rows.join("\n"))}`;
		}
		const missing = all.filter((_, i) => (changed.touched[i] ?? []).length === 0);
		if (missing.length > 0 && agentAsks) return "Errore: non trovo fatture aperte con questo numero nella previsione.";
		if (missing.length > 0) return `Errore: non trovo fatture aperte o preventivi accettati per questo, nella previsione:\n${fenced(missing.map((c) => `• ${[c.invoice, c.party].filter((x) => x !== undefined).join(", ")}`).join("\n"))}\nControlla il nome o il numero con chi ti scrive.`;
		const added = hypotheticalFlows(hyps, day, end);
		const withMoves = [...changed.movements, ...added];
		const p = (list: readonly Movement[]): Projection => project(start, list, day, end, g.dailySpend);
		// The cautious case: no late money to collect, no accepted quote, no canone not issued yet.
		const cautious = (list: readonly Movement[]) => list.filter((m) => !late.has(m) && m.source !== "quote" && m.source !== "recurring" && m.source !== "recurring_draft");
		const lateCents = (g.view.invoices?.late ?? []).reduce((n, m) => n + m.cents, 0n);
		const quoteCents = g.movements.filter((m) => m.source === "quote").reduce((n, m) => n + m.cents, 0n);
		const canoneCents = g.movements.filter((m) => m.source === "recurring" || m.source === "recurring_draft").reduce((n, m) => n + m.cents, 0n);
		const changes: ChangeLine[] = changed.touched.map((touched) => ({ touched }));
		return whatIfAnswer({ base: p(g.movements), withThem: p(withMoves), cautiousBase: p(cautious(g.movements)), cautiousWith: p(cautious(withMoves)), hyps, changes, lateCents, quoteCents, canoneCents }, g.view);
	}

	async function exportCsv(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const f = flags(args);
		if (typeof f === "string") return f;
		const horizon = readHorizon(args.horizon, args.days, day);
		if (isProblem(horizon)) return `Errore: ${horizon.problem}.`;
		const g = await gather(ctx, day, horizon.end, f);
		if (typeof g === "string") return g;
		const p: Projection = project(startOf(g.view), g.movements, day, horizon.end, g.dailySpend);
		const { csv, rows } = projectionCsv(p, g.view);
		// The name only from today's date, under cassa/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `cassa/previsione-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		await audit(ctx, "export", rows);
		return `Salvato ${written} (${withDate("dal", day)} ${withDate("al", horizon.end)}, ${daysText(horizon.days)}; separatore «;», decimali con la virgola, si apre con Excel). Saldo previsto ${withDate("al", horizon.end)}: ${euros(p.end)}. Mandalo con file_send se chi ti scrive lo vuole.`;
	}
}
