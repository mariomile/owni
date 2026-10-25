/**
 * The tool `recurring_invoices`: le fatture ricorrenti (canoni). The person says once «canone
 * mensile di manutenzione 300 € a Rossi srl»; every period Owni prepares the sales invoice DRAFT
 * (recurring-invoice-run.ts, with sales_invoices' own draft builder) and says so in the
 * conversation it was set in. She never issues, numbers or sends it: the person issues it with
 * sales_invoices. What a draft needs is asked once, when the recurring invoice is set. Another
 * agente gets only how many there are and the monthly amount, never a customer; the audit only the
 * op and a count.
 */
import { AGENT_CHANNEL } from "../agent-messages.ts";
import { type Candidate, FORM_NOTE, findNamed } from "../client-find.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import { todayIn } from "../italian-calendar.ts";
import type { Marker } from "../marker.ts";
import { PeriodError, readPeriod } from "../periods.ts";
import type { RecurringBook, RecurringState } from "../recurring-invoice-store.ts";
import { RECURRING_BROKEN } from "../recurring-invoice-store.ts";
import {
	addMonths,
	CADENCE_NAMES,
	CADENCE_WORDS,
	CADENCES,
	type Cadence,
	dueDate,
	duePeriod,
	type DueDay,
	firstPeriod,
	monthLabel,
	monthsBetween,
	monthsOf,
	ofLabel,
	overlaps,
	periodLabel,
	periodOn,
	RECURRING_LIMITS,
	RECURRING_OPS,
	recurringAgentReads,
	type RecurringCustomer,
	RecurringError,
	type RecurringOp,
	rangeLabel,
	type Run,
	runLabel,
	runMonths,
	type Schedule,
	scheduleId,
	within,
} from "../recurring-invoices.ts";
import { FIELD_LIMITS, RITENUTA_CAUSALI } from "../sales-invoice-rules.ts";
import { isIssued, SalesInvoiceError } from "../sales-invoices.ts";
import { cleanText } from "../text-input.ts";
import { WorkspaceError } from "../workspace.ts";
import { isProblem, noteProblem, periodAmount, readCadence, readCount, readDay, readMonth, readNote, readScheduleLines, readStart, readTerms } from "./recurring-invoice-input.ts";
import { agentAnswer, choiceRow, fencedRecurring, listAnswer, monthsWords, NO_SCHEDULES, nextDue, periodsWords, type Shown, showAnswer } from "./recurring-invoice-render.ts";
import { billedFor, checkDraft, coveredMonths, draftGone, invoiceOf, preparePeriod, type RecurringEnv, type RecurringEvent } from "./recurring-invoice-run.ts";
import { findBuyer } from "./sales-invoice-buyer.ts";
import { type BuyerFields, readBuyerFields } from "./sales-invoice-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";

export type { RecurringEvent } from "./recurring-invoice-run.ts";

export type RecurringToolsOptions = RecurringEnv & {
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
};

const DESCRIPTION = [
	"Le fatture ricorrenti (canoni), una fattura che si ripete allo stesso cliente (non schedule_create né renewals; la emette sales_invoices dopo averla vista): an invoice that repeats every month, two months, quarter, six months or year to the same customer is recurring_invoices (not schedule_create, not renewals: renewals are what the person pays). Owni prepares the sales invoice DRAFT of each period by herself, on its day, and says so in this conversation; she never issues it, never numbers it and never sends it: the person issues it with sales_invoices after seeing it.",
	"What the person says → op: «canone mensile di manutenzione 300 € a Rossi srl dal 1° ottobre» → add (customer, lines [{description «Canone di manutenzione», price 300}], cadence monthly, start «1 ottobre»); «ogni trimestre, a fine mese» → cadence quarterly, day «fine mese»; «il 5 di ogni mese» → day «il 5»; «per 12 mesi» → end, the 12th month from the start (count only when the person says how many invoices); «fino a dicembre 2027» → end; a voce of the listino → a line with item; «quali canoni ho?» → list; «fammi vedere il canone di Rossi» → show (customer, or id RI-0001); «sospendi / riprendi il canone di Rossi» → pause / resume; «porta il canone di Rossi a 350» → change with amount (a recurring invoice of one line) or lines; «togli il canone di Rossi» → remove; «prepara adesso la fattura del canone di Rossi», «riprova» → run_now (the period of today); «prepara anche quella di agosto», a period skipped or left out → run_now with period. Never two drafts for the same months.",
	"Prices are without VAT: when the person says an amount with VAT included («300 IVA inclusa») ask whether it is the total or the imponibile, and never compute it yourself. The period is added to each line's description («Canone di manutenzione, ottobre 2026», «…, 4º trimestre 2026») unless the description has {mese} or {periodo}; the note may have them too. The customer must be a client's card or a customer already invoiced (or given with partita IVA and the data the tool asks). When the tool asks for data, ask the person everything it lists in one message and never fill it in yourself; the customer's address, codice destinatario and PEC go in this tool (add or change), the draft's terms (vat, natura, ritenuta, cassa, bollo_to_client, payment_days, method, iban) too, only as the person says them. Repeat amounts and dates as given, never compute them yourself.",
].join(" ");

/** «mese», «trimestre»…: a run of so many months, for a sentence. */
const UNIT: Readonly<Record<number, string>> = { 1: "mese", 2: "bimestre", 3: "trimestre", 6: "semestre", 12: "anno" };

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Le fatture ricorrenti: the schedules kept here; each period's draft made by the sweep or by
 * run_now with the same env (recurring-invoice-run.ts). Today is read once per call.
 */
/** The ops that need a person's own message (ADR 0088), with the step in words for the refusal. Pause is always fine. */
const PERSON_OPS: Partial<Record<RecurringOp, string>> = {
	add: "programmo una fattura ricorrente",
	change: "cambio la fattura ricorrente",
	resume: "faccio ripartire la fattura ricorrente",
	run_now: "preparo la bozza del canone",
	remove: "tolgo la fattura ricorrente",
};

export function createRecurringInvoiceTools(options: RecurringToolsOptions): OwniTool[] {
	const env: RecurringEnv = options;
	const { store, timeZone, sales } = env;
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: env.now().toISOString() });
	const audit = async (ctx: ToolContext, op: RecurringEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step(`audit-${op}`, async () => {
			await env.record?.({ type: "recurring_invoices.changed", op, count });
			return true;
		});
	};
	const src = { ...(sales.priceList === undefined ? {} : { priceList: sales.priceList }), company: sales.company, taxes: sales.taxes };
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const line = {
		type: "object",
		properties: {
			item: text(120, "a voce of the listino (price_list): its name as said or LS-0001; its price is the listino's at each draft"),
			description: text(FIELD_LIMITS.descrizione - RECURRING_LIMITS.label, "as said, without the period (added by itself); {mese} or {periodo} to place it"),
			quantity: { type: ["number", "string"], description: "default 1" },
			unit: text(FIELD_LIMITS.unitaMisura, "«ore», «pz»"),
			price: { type: ["number", "string"], description: "unit price, VAT excluded" },
			discount: { type: ["number", "string"], description: "percent" },
			vat: { type: ["number", "string"], description: "this line's rate, when it differs" },
			natura: text(5, "this line's nature at 0%"),
			reference: text(FIELD_LIMITS.riferimentoNormativo, "the law of a 0% line, as said"),
			advance: { type: "boolean", description: "a spesa anticipata in nome e per conto del cliente (N1)" },
		},
		additionalProperties: false,
	};
	return [
		{
			name: "recurring_invoices",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...RECURRING_OPS] },
					id: text(12, "show, pause, resume, change, remove, run_now: the recurring invoice's id, RI-0001"),
					customer: text(200, "add: the customer as said, partita IVA, or card id CL-0001; show, pause, resume, change, remove, run_now: whose recurring invoice"),
					vat_number: text(40, "add, change: the customer's partita IVA, as the person says it"),
					cf: text(20, "add, change: the customer's codice fiscale"),
					address: text(200, "add, change: the customer's address with CAP, comune, provincia, as the person says it"),
					recipient_code: text(7, "add, change: the customer's codice destinatario"),
					pec: text(FIELD_LIMITS.pec, "add, change: the customer's PEC"),
					country: text(2, "add, change: a foreign customer's country (DE, FR…)"),
					lines: { type: "array", maxItems: RECURRING_LIMITS.lines, items: line, description: "add, change: the lines of every invoice" },
					amount: { type: ["number", "string"], description: "change: the new price of a recurring invoice with one line" },
					cadence: { type: "string", enum: [...CADENCE_NAMES], description: "add, change: every month, two months, quarter, six months, year" },
					day: { type: ["integer", "string"], description: "add, change: the day of the month the draft is prepared, 1 to 28, «il 5», or «fine mese» (default 1, or the day said with the start)" },
					start: text(40, "add, change: the first month invoiced, «ottobre», «1 novembre», «ottobre 2026», «2026-10» (default this month)"),
					end: text(40, "add, change: the last month a period may start in, as said; «mai» clears it"),
					count: { type: ["integer", "string"], description: "add, change: how many invoices in all, only when the person says a number of invoices; «mai» clears it" },
					note: text(RECURRING_LIMITS.note, "add, change: the invoice's causale, with {mese} or {periodo} if wanted; «niente» clears it"),
					period: text(40, "run_now: the month or period to prepare, if not today's: «novembre», «agosto 2027», «4º trimestre 2026»"),
					vat: { type: ["number", "string"], description: "add, change: VAT rate of the lines (22, 10, 5, 4, 0)" },
					natura: text(5, "add, change: nature of the 0% lines"),
					reference: text(FIELD_LIMITS.riferimentoNormativo, "add, change: the law of the 0% lines, as said"),
					ritenuta: { anyOf: [{ type: "boolean" }, { type: "string", enum: [...RITENUTA_CAUSALI] }], description: "add, change: only as the person says" },
					cassa: {
						type: "object",
						properties: { kind: { type: "string", enum: ["rivalsa_inps", "contributo_integrativo"] }, type: text(4, "TC01…TC21, for a cassa"), rate: { type: ["number", "string"] } },
						required: ["kind"],
						additionalProperties: false,
					},
					bollo_to_client: { type: "boolean" },
					split_payment: { type: "boolean" },
					payment_days: { type: "integer", minimum: 0, maximum: 365 },
					end_of_month: { type: "boolean" },
					method: text(20, "bonifico (default), contanti, assegno, carta, riba, rid, pagopa"),
					iban: text(40, "default the first IBAN saved with the company"),
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!RECURRING_OPS.includes(args.op as RecurringOp)) return "Errore: non conosco questa operazione sulle fatture ricorrenti.";
				const op = args.op as RecurringOp;
				// Another agente's request is not the person's word: the totals only, never by a customer.
				const agent = isAgentTurn(ctx);
				if (agent && !recurringAgentReads(args)) {
					return "Errore: a un altro agente do solo quante fatture ricorrenti ci sono e quanto valgono al mese, in tutto. Non le cambio, non preparo bozze e non dico per quali clienti; il resto lo chiede chi ti scrive, nella sua conversazione.";
				}
				// A standing schedule, a draft made now, a removal: only on a person's own message, never a notice's, a schedule's or another agente's (ADR 0088).
				const personal = PERSON_OPS[op];
				const notPerson = personal === undefined ? undefined : requirePersonFor(ctx, personal);
				if (notPerson !== undefined) return notPerson;
				const day = todayIn(timeZone, env.now());
				try {
					switch (op) {
						case "add":
							return await add(args, ctx, day);
						case "list":
							return agent ? agentAnswer(schedules().map((s) => shown(s, day))) : listAnswer(schedules().map((s) => shown(s, day)));
						case "show":
							return show(args, day);
						case "pause":
						case "resume":
							return await setStatus(args, ctx, day, op);
						case "change":
							return await change(args, ctx, day);
						case "remove":
							return await remove(args, ctx, day);
						case "run_now":
							return await runNow(args, ctx, day);
					}
				} catch (error) {
					if (error instanceof RecurringError || error instanceof SalesInvoiceError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function book(): RecurringBook {
		const b = store.read();
		if (b.broken) throw new RecurringError(RECURRING_BROKEN);
		return b;
	}

	function schedules(): readonly Schedule[] {
		return book().schedules;
	}

	function runsOf(id: string): readonly Run[] {
		return book().runs.filter((r) => r.schedule === id);
	}

	function shown(s: Schedule, day: string): Shown {
		const b = book();
		const runs = b.runs.filter((r) => r.schedule === s.id);
		const last = [...runs].sort((x, y) => (x.period < y.period ? -1 : 1)).at(-1);
		const amount = periodAmount(src, s);
		const covered = coveredMonths(env, b, s);
		const next = nextDue(s, day, covered);
		// The draft as it is now: one made in its place (sales_invoices replace) is still this period's.
		const lastId = last === undefined ? undefined : invoiceOf(env, last.call)?.id;
		const leftOut = (s.leftOut ?? []).filter((m) => !covered.has(m));
		return {
			schedule: s,
			today: day,
			...(amount === undefined ? {} : { amount }),
			...(last === undefined ? {} : { last, lastGone: draftGone(env, last) }),
			...(lastId === undefined ? {} : { lastId }),
			...(next === undefined ? {} : { next }),
			...(leftOut.length === 0 ? {} : { leftOut }),
		};
	}

	/** The customer's data said now, as kept for each draft. */
	function fieldsOf(f: BuyerFields): Partial<RecurringCustomer> {
		return {
			...(f.address === undefined ? {} : { address: f.address }),
			...(f.code === undefined ? {} : { code: f.code }),
			...(f.pec === undefined ? {} : { pec: f.pec }),
			...(f.country === undefined ? {} : { country: f.country }),
		};
	}

	/** The customer said for a new recurring invoice: a card, a customer already invoiced, or one given with partita IVA or codice fiscale; else what to say. */
	function customerOf(args: Record<string, unknown>, notes: string[]): RecurringCustomer | string {
		const said = cleanText(args.customer, 200, "il cliente");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		if (said === undefined) return "Errore: dimmi a quale cliente va la fattura ricorrente.";
		const fields = readBuyerFields(args);
		if (isProblem(fields)) return `Errore: ${fields.problem}.`;
		const cardBook = sales.clients?.read();
		const cards = cardBook === undefined || cardBook.broken ? [] : cardBook.cards;
		const salesBook = sales.store.read();
		const invoices = salesBook.broken ? [] : salesBook.invoices;
		const found = findBuyer(said, cards, invoices, { ...(fields.vat === undefined ? {} : { vat: fields.vat }), ...(fields.cf === undefined ? {} : { cf: fields.cf }) });
		if (found.kind === "close") return ["Intendi uno di questi? Non so dire quale:", fencedRecurring(found.candidates.map((c) => `• ${c}`).join("\n")), "Chiedi a chi ti scrive quale, e ripeti con il nome scritto come qui o con la sua partita IVA."].join("\n");
		if (found.kind === "conflict") return [fencedRecurring(`${found.known.name} che conosco ha ${found.id}.`), "Chiedi a chi ti scrive se è lo stesso cliente: se sì, ripeti senza quella partita IVA o codice fiscale; se è un altro, ripeti con i suoi dati."].join("\n");
		if (found.kind === "none") {
			// A new customer, with a tax id said: the draft check asks the rest.
			if (fields.vat !== undefined || fields.cf !== undefined) return { name: said.slice(0, 200), ...(fields.vat === undefined ? {} : { vat: fields.vat }), ...(fields.cf === undefined ? {} : { cf: fields.cf }), ...fieldsOf(fields) };
			return [
				"Non trovo questo cliente tra le schede dei clienti né tra quelli già fatturati:",
				fencedRecurring(said),
				"Per preparare ogni volta la bozza servono i suoi dati per la fattura elettronica: chiedi a chi ti scrive la partita IVA (o il codice fiscale per un privato), l'indirizzo con CAP, comune e provincia e il codice destinatario o la PEC, poi ripeti con questi dati.",
			].join("\n");
		}
		if (found.form === true) notes.push(FORM_NOTE);
		const k = found.known;
		if (k.card !== undefined) return { name: k.card.name.slice(0, 200), card: k.card.id, ...fieldsOf(fields) };
		const b = k.previous;
		return { name: k.name.slice(0, 200), ...(b?.vat === undefined ? {} : { vat: b.vat }), ...(b?.cf === undefined ? {} : { cf: b.cf }), ...fieldsOf(fields) };
	}

	type Shape = Pick<Schedule, "customer" | "lines" | "terms" | "cadence" | "day" | "start" | "end" | "count" | "note">;

	/** The schedule as said now, over the one kept (a change); what to say instead when something does not read. */
	function shapeOf(args: Record<string, unknown>, day: string, notes: string[], kept?: Schedule): Shape | string {
		let customer: RecurringCustomer | string;
		if (kept === undefined) customer = customerOf(args, notes);
		else {
			const fields = readBuyerFields(args);
			if (isProblem(fields)) return `Errore: ${fields.problem}.`;
			customer = { ...kept.customer, ...fieldsOf(fields), ...(kept.customer.card === undefined && fields.vat !== undefined ? { vat: fields.vat } : {}), ...(kept.customer.card === undefined && fields.cf !== undefined ? { cf: fields.cf } : {}) };
		}
		if (typeof customer === "string") return customer;
		const cadence = readCadence(args.cadence);
		if (isProblem(cadence)) return `Errore: ${cadence.problem}.`;
		if (cadence === undefined && kept === undefined) return "Errore: dimmi ogni quanto: ogni mese, ogni due mesi, ogni trimestre, ogni sei mesi o ogni anno.";
		const every = (cadence ?? kept?.cadence) as Cadence;
		const terms = readTerms(args, kept?.terms);
		if (isProblem(terms)) return `Errore: ${terms.problem}.`;
		let given: unknown = args.lines;
		if (kept !== undefined && args.lines === undefined) {
			if (args.amount === undefined) given = kept.lines;
			else if (kept.lines.length !== 1) return "Errore: questa fattura ricorrente ha più voci: dimmi tutte le voci con i prezzi nuovi.";
			else given = [{ ...kept.lines[0], price: args.amount }];
		}
		// The lines read again with the terms and the cadence now: a description too long, or a voce whose rate no longer fits, is said now.
		const lines = readScheduleLines(src, given, terms, every);
		if (isProblem(lines)) return `Errore: ${lines.problem}.`;
		if ("ask" in lines) return lines.ask;
		const saidDay = readDay(args.day);
		if (isProblem(saidDay)) return `Errore: ${saidDay.problem}.`;
		if (typeof saidDay === "object") return saidDay.ask;
		const start = readStart(args.start, day);
		if (isProblem(start)) return `Errore: ${start.problem}.`;
		// The day said with the start («dal 1° novembre») when none is said on its own.
		if (saidDay === undefined && typeof start.day === "object") return start.day.ask;
		const dueDay = saidDay ?? (typeof start.day === "number" ? start.day : undefined);
		const end = readMonth(args.end, day, "last", "l'ultimo mese", true);
		if (isProblem(end)) return `Errore: ${end.problem}.`;
		const count = readCount(args.count);
		if (isProblem(count)) return `Errore: ${count.problem}.`;
		const note = readNote(args.note);
		if (isProblem(note)) return `Errore: ${note.problem}.`;
		const first = start.month ?? kept?.start ?? day.slice(0, 7);
		const last = end === null ? undefined : (end ?? kept?.end);
		// «mai» for the end clears the number of invoices too: it never ends.
		const many = count === null || end === null ? undefined : (count ?? kept?.count);
		if (last !== undefined && last < first) return "Errore: l'ultimo mese viene prima del primo.";
		const text = note === null ? undefined : (note ?? kept?.note);
		const long = noteProblem(text, every);
		if (long !== undefined) return `Errore: ${long.problem}.`;
		return {
			customer,
			lines,
			terms,
			cadence: every,
			day: (dueDay ?? kept?.day ?? 1) as DueDay,
			start: first,
			...(last === undefined ? {} : { end: last }),
			...(many === undefined ? {} : { count: many }),
			...(text === undefined ? {} : { note: text }),
		};
	}

	function customerKey(c: RecurringCustomer): string {
		return c.card ?? c.vat ?? c.cf ?? `name:${c.name.toLowerCase()}`;
	}

	function sameShape(a: Shape, b: Shape): boolean {
		return customerKey(a.customer) === customerKey(b.customer) && a.cadence === b.cadence && JSON.stringify(a.lines) === JSON.stringify(b.lines);
	}

	function sameAll(a: Shape, b: Shape): boolean {
		return (["customer", "lines", "terms", "cadence", "day", "start", "end", "count", "note"] as const).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
	}

	/** The period whose draft would come first (due now, or the next one), and whether it is due now. */
	function firstToPrepare(s: Schedule, day: string, covered: ReadonlySet<string>): { period: string; now: boolean } | undefined {
		const due = duePeriod(s, day, covered);
		if (due !== undefined) return { period: due.period, now: true };
		const next = nextDue(s, day, covered);
		const p = next === undefined ? undefined : periodOn(s, next);
		return p === undefined ? undefined : { period: p, now: false };
	}

	/** What is missing for a draft of the schedule, asked once when it is set or changed; undefined when a draft can be made. */
	async function missingFor(s: Schedule, day: string, signal: AbortSignal): Promise<string | undefined> {
		const first = firstToPrepare(s, day, coveredMonths(env, book(), s)) ?? { period: s.start };
		const missing = await checkDraft(env, s, first.period, CADENCES[s.cadence], signal);
		if (missing === undefined) return undefined;
		return [`Non ho ancora salvato la fattura ricorrente: per prepararne le bozze serve qualcosa che manca. Ecco cosa risponde la preparazione della bozza (nel riquadro):`, fencedRecurring(missing), "Chiedi a chi ti scrive tutto insieme, non inventarlo, poi ripeti con le sue risposte: i dati del cliente e della fattura vanno qui, i tuoi dati con set_company delle fatture."].join("\n");
	}

	async function add(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const done = schedules().find((s) => s.callId === ctx.callId);
		if (done !== undefined) return answerFor("Fatto, nuova fattura ricorrente", done, day, []);
		const notes: string[] = [];
		const shape = shapeOf(args, day, notes);
		if (typeof shape === "string") return shape;
		const twin = schedules().find((s) => sameShape(s, shape));
		if (twin !== undefined) return answerFor("C'è già una fattura ricorrente uguale, non ne ho fatta un'altra:", twin, day, ["Se è un'altra davvero, dimmi cosa cambia."]);
		const thread = ctx.thread !== undefined && ctx.thread.channel !== AGENT_CHANNEL ? { channel: ctx.thread.channel, threadId: ctx.thread.threadId } : undefined;
		const by = marker(ctx);
		const draftOf = (id: string): Schedule => ({ ...by, id, ...shape, status: "active", from: day, ...(thread === undefined ? {} : { thread }), callId: ctx.callId });
		// The id it would take: the months of the same canone removed before are held back from it.
		const missing = await missingFor(draftOf(scheduleId(book().nextId)), day, ctx.signal);
		if (missing !== undefined) return missing;
		const id = await ctx.step("apply", async () => {
			let made = "";
			const outcome = store.update(ctx.callId, (state): RecurringState => {
				if (state.schedules.length >= RECURRING_LIMITS.schedules) throw new RecurringError(`ci sono già ${RECURRING_LIMITS.schedules} fatture ricorrenti, il massimo: togline qualcuna prima`);
				made = scheduleId(state.nextId);
				return { nextId: state.nextId + 1, schedules: [...state.schedules, draftOf(made)] };
			});
			return outcome === "rerun" ? (schedules().find((s) => s.callId === ctx.callId)?.id ?? "") : made;
		});
		await audit(ctx, "add", 1);
		const saved = schedules().find((s) => s.id === id);
		if (saved === undefined) return "Fatto.";
		const b = book();
		// The months a recurring invoice removed for this customer already has in a draft: never billed twice.
		const now = periodOn(saved, day);
		const billed = now === undefined ? undefined : billedFor(env, b, saved).find((x) => runMonths(x).some((m) => monthsOf(now, CADENCES[saved.cadence]).includes(m)));
		if (billed !== undefined) notes.push(`${capital(runLabel(billed))} per questo cliente è già nella bozza ${invoiceOf(env, billed.call)?.id ?? ""} di una fattura ricorrente tolta: non la rifaccio.`);
		const first = firstToPrepare(saved, day, coveredMonths(env, b, saved));
		if (first?.now === true) notes.push(`La prima bozza, ${ofLabel(shortLabel(saved, first.period, day))}, la preparo oggi.`);
		return answerFor("Fatto, nuova fattura ricorrente", saved, day, notes);
	}

	/** A period in words without this year: «ottobre», «4º trimestre», «novembre 2027». */
	function shortLabel(s: Schedule, period: string, day: string): string {
		const label = periodLabel(s, period);
		const year = day.slice(0, 4);
		return label.endsWith(` ${year}`) && !label.includes(" - ") ? label.slice(0, -5) : label;
	}

	function answerFor(head: string, s: Schedule, day: string, notes: readonly string[]): string {
		const body = showAnswer(shown(s, day)).split("\n");
		const first = body.shift() ?? "";
		return [`${head} ${first}`, ...body, ...notes, "Ogni periodo preparo la bozza e lo dico qui: la emette chi ti scrive, dopo averla vista. Non la emetto e non la mando io."].join("\n");
	}

	/** The schedule `args` names: by id, else by customer (the one they have); what to say otherwise. */
	function named(args: Record<string, unknown>, verb: string, day: string): Schedule | string {
		const all = schedules();
		if (all.length === 0) return NO_SCHEDULES;
		if (args.id !== undefined) {
			const id = typeof args.id === "string" ? args.id.trim().toUpperCase() : "";
			return all.find((s) => s.id === id) ?? "Errore: non c'è una fattura ricorrente con questo numero.";
		}
		if (args.customer === undefined) {
			if (all.length === 1) return all[0] as Schedule;
			return `Errore: dimmi quale fattura ricorrente ${verb}: il cliente o il numero (RI-0001).`;
		}
		const said = cleanText(args.customer, 200, "il cliente");
		if (isProblem(said)) return `Errore: ${said.problem}.`;
		// One candidate per customer: its recurring invoices together.
		const groups = new Map<string, Schedule[]>();
		for (const s of all) groups.set(customerKey(s.customer), [...(groups.get(customerKey(s.customer)) ?? []), s]);
		const candidates: Candidate<Schedule[]>[] = [...groups.values()].map((list) => {
			const c = (list[0] as Schedule).customer;
			return { item: list, names: [c.name], ...(c.vat === undefined ? {} : { vat: c.vat.replace(/^IT/, "") }), ...(c.cf === undefined ? {} : { cf: c.cf }), ...(c.card === undefined ? {} : { ids: [c.card] }) };
		});
		const found = findNamed(candidates, said ?? "", 200);
		if (found.kind === "none") return ["Non c'è una fattura ricorrente per questo cliente:", fencedRecurring(said ?? ""), listAnswer(all.map((s) => shown(s, day)))].join("\n");
		const list = found.kind === "close" ? found.candidates.flat() : found.item;
		// Among the person's own recurring invoices one close name is the one meant: its id is in every answer.
		if (list.length === 1) return list[0] as Schedule;
		const rows = fencedRecurring(list.map((s) => `${choiceRow(shown(s, day))} (${s.customer.name})`).join("\n"));
		// Close to one customer only: theirs to choose among.
		if (found.kind === "close" && found.candidates.length > 1) return ["Intendi una di queste? Non so dire quale:", rows, "Chiedi a chi ti scrive quale, e ripeti con il numero (RI-0001)."].join("\n");
		return [`Questo cliente ha ${list.length} fatture ricorrenti: quale ${verb}?`, rows, "Ripeti con il numero (RI-0001)."].join("\n");
	}

	function show(args: Record<string, unknown>, day: string): string {
		if (args.id === undefined && args.customer === undefined) return listAnswer(schedules().map((s) => shown(s, day)));
		const s = named(args, "vedere", day);
		return typeof s === "string" ? s : showAnswer(shown(s, day));
	}

	/** The periods due while paused (from `pausedOn` to today, the period of today aside) that no draft covers. */
	function pausedPeriods(s: Schedule, pausedOn: string, day: string): string[] {
		const now = periodOn(s, day);
		if (now === undefined) return [];
		const covered = coveredMonths(env, book(), s);
		const out: string[] = [];
		for (let p = firstPeriod(s); monthsBetween(p, now) > 0; p = addMonths(p, CADENCES[s.cadence])) {
			const due = dueDate(p, s.day);
			if (within(s, p) && due >= pausedOn && due <= day && !overlaps(s, p, covered)) out.push(p);
		}
		return out;
	}

	async function setStatus(args: Record<string, unknown>, ctx: ToolContext, day: string, op: "pause" | "resume"): Promise<string> {
		const done = book().calls.includes(ctx.callId);
		const s = named(args, op === "pause" ? "sospendere" : "riprendere", day);
		if (typeof s === "string") return s;
		const status = op === "pause" ? "paused" : "active";
		if (!done && s.status === status) return op === "pause" ? `${s.id} è già in pausa: non preparo bozze finché non la riprendi.` : `${s.id} è già attiva.`;
		const missed = op === "resume" && s.pausedOn !== undefined ? pausedPeriods(s, s.pausedOn, day) : [];
		const by = marker(ctx);
		await ctx.step("apply", async () => {
			store.update(ctx.callId, (state) => ({
				...state,
				schedules: state.schedules.map((x) => {
					if (x.id !== s.id) return x;
					const { pausedOn: _p, ...rest } = x;
					return op === "pause" ? { ...rest, status, pausedOn: day, edited: by } : { ...rest, status, from: day, edited: by };
				}),
			}));
			return true;
		});
		await audit(ctx, op, 1);
		const now = schedules().find((x) => x.id === s.id) ?? s;
		if (op === "pause") return `Fatto, ${s.id} è in pausa: non preparo bozze finché non la riprendi. Le bozze già preparate restano.`;
		const next = shown(now, day).next;
		const out = [`Fatto, ${s.id} riprende${next === undefined ? ", ma i suoi periodi sono finiti" : `: la prossima bozza è ${ofLabel(periodLabel(now, periodOn(now, next) ?? now.start))}, ${next === day ? "oggi" : withDay(next)}`}.`];
		if (missed.length > 0) out.push(`Le bozze ${ofLabel(periodsWords(now, missed))} non le ho preparate mentre era in pausa: se servono, dimmelo.`);
		return out.join("\n");
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const s = named(args, "cambiare", day);
		if (typeof s === "string") return s;
		if (book().calls.includes(ctx.callId)) return answerFor("Fatto, ho cambiato", s, day, []);
		const notes: string[] = [];
		const shape = shapeOf({ ...args, customer: undefined }, day, notes, s);
		if (typeof shape === "string") return shape;
		if (sameAll(s, shape)) return answerFor("Era già così, non ho cambiato niente:", s, day, []);
		// A new cadence or first month: the months covered stay covered, and periods count from after them.
		const regrid = shape.cadence !== s.cadence || shape.start !== s.start;
		const runs = runsOf(s.id);
		const lastCovered = regrid ? runs.flatMap(runMonths).sort().at(-1) : undefined;
		const after = lastCovered === undefined ? undefined : `${addMonths(lastCovered, 1)}-01`;
		const from = after !== undefined && after > s.from ? after : s.from;
		const { end: _e, count: _c, note: _n, leftOut: _l, ...rest } = s;
		const moved: Schedule = { ...rest, ...shape, from, edited: marker(ctx) };
		// The months the new grid leaves out, with those left out before and not covered yet: said by show until a draft covers them.
		const grid = lastCovered === undefined ? undefined : regridOf(moved, lastCovered);
		const covered = coveredMonths(env, book(), moved);
		const leftOut = [...new Set([...(s.leftOut ?? []), ...(grid?.left ?? [])])].filter((m) => !covered.has(m) && (grid?.first === undefined || m < grid.first)).sort().slice(-11);
		const next: Schedule = leftOut.length === 0 ? moved : { ...moved, leftOut };
		const missing = await missingFor(next, day, ctx.signal);
		if (missing !== undefined) return missing.replace("Non ho ancora salvato la fattura ricorrente", "Non ho ancora cambiato la fattura ricorrente");
		await ctx.step("apply", async () => {
			store.update(ctx.callId, (state) => {
				if (!state.schedules.some((x) => x.id === s.id)) throw new RecurringError("la fattura ricorrente non c'è più");
				return { ...state, schedules: state.schedules.map((x) => (x.id === s.id ? next : x)) };
			});
			return true;
		});
		await audit(ctx, "change", 1);
		const saved = schedules().find((x) => x.id === s.id) ?? next;
		// The months left out are said with the recurring invoice (show), until a draft covers them.
		if (lastCovered !== undefined) notes.push(regridWords(saved, runs, lastCovered, grid?.first));
		return answerFor("Fatto, ho cambiato", saved, day, [...notes, "Vale dalle prossime bozze: quelle già preparate restano come sono."]);
	}

	/** After a new cadence or first month: the first period now (none when they are over), and the months between the last covered and it that no draft covers. */
	function regridOf(s: Schedule, lastCovered: string): { first?: string; left: string[] } {
		const covered = coveredMonths(env, book(), s);
		const step = CADENCES[s.cadence];
		let first: string | undefined;
		for (let p = firstPeriod(s), i = 0; i < 400 && within(s, p); p = addMonths(p, step), i++) {
			if (!overlaps(s, p, covered)) {
				first = p;
				break;
			}
		}
		if (first === undefined) return { left: [] };
		const left: string[] = [];
		for (let m = addMonths(lastCovered, 1); m < first; m = addMonths(m, 1)) if (m >= s.start && !covered.has(m)) left.push(m);
		return { first, left };
	}

	/** After a new cadence or first month, in words: what is covered already and the first period now. */
	function regridWords(s: Schedule, runs: readonly Run[], lastCovered: string, first: string | undefined): string {
		const lastRun = runs.find((r) => runMonths(r).includes(lastCovered)) as Run;
		const step = CADENCES[s.cadence];
		const head = `${capital(runLabel(lastRun))} è già fatturato come ${UNIT[lastRun.months] ?? "periodo"}`;
		if (first === undefined) return `${head}: dopo non ci sono altri periodi da preparare.`;
		return `${head}: il primo ${UNIT[step]} sarà ${rangeLabel(first, step)}.`;
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const done = book().calls.includes(ctx.callId);
		if (done) return "Fatto, la fattura ricorrente è tolta. Le bozze già preparate restano.";
		const s = named(args, "togliere", day);
		if (typeof s === "string") return s;
		await ctx.step("apply", async () => {
			store.update(ctx.callId, (state) => ({ ...state, schedules: state.schedules.filter((x) => x.id !== s.id) }));
			return true;
		});
		await audit(ctx, "remove", 1);
		return `Fatto, ho tolto la fattura ricorrente ${s.id}: non preparo più bozze. Quelle già preparate restano tra le bozze delle fatture.`;
	}

	/** The months the person asks for: a month, a quarter, a year as said («novembre», «4º trimestre 2026», «2027-08»); without a year the latest one begun, or the next one with `ahead`. */
	function askedMonths(said: unknown, day: string, ahead: boolean): string[] | string {
		if (typeof said !== "string" || said.trim() === "") return "Errore: dimmi il mese o il periodo da preparare, come «novembre» o «4º trimestre 2026».";
		const t = said.trim().slice(0, 40);
		if (/^\d{4}-(0[1-9]|1[0-2])$/.test(t)) return [t];
		try {
			const p = readPeriod(t, day, ahead ? { ahead: true } : {});
			const from = p.from.slice(0, 7);
			return monthsOf(from, monthsBetween(from, p.to.slice(0, 7)) + 1);
		} catch (error) {
			if (!(error instanceof PeriodError)) throw error;
			return "Errore: non riconosco il periodo: scrivilo come «novembre», «agosto 2027» o «4º trimestre 2026».";
		}
	}

	/** Who covers a month already: the draft or invoice, in words. */
	function coveredBy(s: Schedule, month: string, blocking: readonly Run[]): string {
		const r = blocking.find((x) => runMonths(x).includes(month));
		const what = capital(monthLabel(month));
		if (r !== undefined) {
			if (r.state === "claimed") return `${what} è in preparazione proprio ora (${runLabel(r)}).`;
			const inv = invoiceOf(env, r.call);
			if (inv !== undefined && isIssued(inv)) return `${what} è già fatturato con la fattura n. ${inv.number} (${runLabel(r)}).`;
			return `${what} è già nella bozza ${inv?.id ?? r.draft ?? ""} (${runLabel(r)}).`;
		}
		const billed = billedFor(env, book(), s).find((b) => runMonths(b).includes(month));
		if (billed !== undefined) return `${what} per questo cliente è già nella bozza ${invoiceOf(env, billed.call)?.id ?? ""} di una fattura ricorrente tolta (${runLabel(billed)}).`;
		return `${what} è già coperto.`;
	}

	/**
	 * The draft of today's period, or of the one asked (a past one too: skipped, paused, left out),
	 * now: never over months a draft covers (said, with the draft); one that failed, or whose draft
	 * the person removed, is made again.
	 */
	async function runNow(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const s = named(args, "preparare", day);
		if (typeof s === "string") return s;
		if (s.status === "paused") return `${s.id} è in pausa: non preparo bozze finché non la riprendi. Vuoi che la riprenda?`;
		const step = CADENCES[s.cadence];
		let asked: string[];
		if (args.period === undefined) {
			const now = periodOn(s, day);
			if (now === undefined) return `${s.id} comincia da ${monthLabel(s.start)}: la prima bozza la preparo allora.`;
			asked = monthsOf(now, step);
		} else {
			const read = askedMonths(args.period, day, false);
			if (typeof read === "string") return read;
			// «novembre» before the first month: the next one, not last year's.
			const next = periodOn(s, `${read[0]}-01`) === undefined ? askedMonths(args.period, day, true) : read;
			asked = typeof next === "string" ? read : next;
		}
		const grid = periodOn(s, `${asked[0]}-01`);
		if (grid === undefined) return `${s.id} comincia da ${monthLabel(s.start)}: prima non ci sono bozze da preparare.`;
		const gridMonths = monthsOf(grid, step);
		if (asked.some((m) => !gridMonths.includes(m))) return `Dimmi un periodo alla volta: ${s.id} si fattura ${CADENCE_WORDS[s.cadence]}, e ${rangeLabel(asked[0] as string, asked.length)} ne prende più d'uno.`;
		if (!within(s, grid)) return args.period === undefined ? `I periodi di ${s.id} sono finiti: non ci sono altre bozze da preparare.` : `${capital(periodLabel(s, grid))} non è tra i periodi di ${s.id}: non preparo la bozza.`;
		// A period still to come is prepared on its day, not before (today's may be made early).
		const current = periodOn(s, day);
		if (current === undefined || grid > current) return `${capital(periodLabel(s, grid))} non è ancora arrivato: la bozza la preparo ${dateWords(dueDate(grid, s.day), day)}.`;
		const b = book();
		const overlapping = b.runs.filter((r) => r.schedule === s.id && runMonths(r).some((m) => gridMonths.includes(m)));
		const gone = overlapping.filter((r) => draftGone(env, r));
		const replaceable = overlapping.filter((r) => r.state === "failed" || gone.includes(r));
		const blocking = overlapping.filter((r) => !replaceable.includes(r));
		const covered = coveredMonths(env, b, s, (r) => replaceable.includes(r));
		const leftOut = (s.leftOut ?? []).filter((m) => !covered.has(m));
		const month = asked[0] as string;
		// A month a new cadence left out, asked alone: made alone, with its share of the period's amount.
		if (step > 1 && asked.length === 1 && leftOut.includes(month)) return await prepared(month, 1, step);
		const taken = gridMonths.filter((m) => covered.has(m));
		if (taken.length === 0) return await prepared(grid, step);
		if (asked.every((m) => covered.has(m))) return [coveredBy(s, asked.find((m) => covered.has(m)) ?? month, blocking), "Non ne preparo un'altra per gli stessi mesi."].join("\n");
		// Part of the period is in a draft already: never a draft for the rest with a whole period's amount.
		const left = leftOut.filter((m) => gridMonths.includes(m));
		const leftWords = left.length === 0 ? [] : [`${capital(monthsWords(left))} ${left.length === 1 ? "è rimasto fuori dal cambio di cadenza: se serve, chiedimi solo quel mese e lo preparo." : "sono rimasti fuori dal cambio di cadenza: se servono, chiedimi un mese alla volta e li preparo."}`];
		return [coveredBy(s, taken[0] as string, blocking), `Non preparo una bozza solo per una parte del ${UNIT[step]}.`, ...leftWords].join("\n");

		/** The draft of `months` months from `period` (with `share`: a month alone, its share of the amount); a draft removed or failed over them made again. */
		async function prepared(period: string, months: number, share?: number): Promise<string> {
			const these = monthsOf(period, months);
			const label = rangeLabel(period, months);
			const head = gone.filter((r) => runMonths(r).some((m) => these.includes(m))).map((r) => `La bozza ${ofLabel(runLabel(r))} era stata tolta: la rifaccio.`);
			const replace = replaceable.filter((r) => runMonths(r).some((m) => these.includes(m))).map((r) => r.period);
			const p = await preparePeriod(env, s as Schedule, period, { months, ...(share === undefined ? {} : { share }), replace, signal: ctx.signal });
			if (p.kind !== "handled") store.markTold((s as Schedule).id, period);
			const id = (s as Schedule).id;
			const part = share === undefined ? [] : [`L'importo di ogni voce è quello di un ${UNIT[step]} diviso per ${share}, arrotondato al centesimo: controllalo con chi ti scrive prima che la emetta.`];
			if (p.kind === "drafted") return [...head, `Fatto, ho preparato la bozza ${p.draft.id} del canone ${ofLabel(label)} (fattura ricorrente ${id}). È solo una bozza, senza numero: la emette chi ti scrive, dopo averla vista.`, ...part, p.answer].join("\n");
			if (p.kind === "failed") return [...head, `Non ho potuto preparare la bozza del canone ${ofLabel(label)} (fattura ricorrente ${id}). Ecco cosa ha risposto la preparazione della bozza (nel riquadro):`, fencedRecurring(p.run.why ?? ""), "Dimmi i dati che mancano e la rifaccio."].join("\n");
			if (p.run.state === "claimed") return `La bozza del canone ${ofLabel(label)} è in preparazione: riprova tra poco.`;
			return [coveredBy(s as Schedule, period, [p.run]), "Non ne preparo un'altra per gli stessi mesi."].join("\n");
		}
	}
}

/** «il 1º novembre», with the year only when it is not this one: «il 1º gennaio 2027». */
function dateWords(date: string, today: string): string {
	const d = Number(date.slice(8, 10));
	const label = monthLabel(date.slice(0, 7));
	return `il ${d === 1 ? "1º" : d} ${date.slice(0, 4) === today.slice(0, 4) ? label.slice(0, -5) : label}`;
}

/** «il 31 ottobre 2026». */
function withDay(day: string): string {
	return `il ${Number(day.slice(8, 10)) === 1 ? "1º" : Number(day.slice(8, 10))} ${monthLabel(day.slice(0, 7))}`;
}
