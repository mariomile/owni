import { isAgentTurn } from "../turn-origin.ts";
import { cashBook } from "../cash-book.ts";
import { DateError, readDate } from "../dates.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import { euros } from "../format-words.ts";
import { InvoiceScanner } from "../invoice-scan.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import { type Invoice, register } from "../invoices.ts";
import { addDays, dayOfIn, todayIn } from "../italian-calendar.ts";
import { capitalized, withDate } from "../italian-format.ts";
import { scaled } from "../quote-sums.ts";
import { type FiguresPatch, TAXES_BROKEN, type TaxBook, type TaxStore } from "../tax-store.ts";
import { accontiOfYear, accontiPaid, baseOf, type CalendarInputs, calendar, creditOf, currentEstimate, type Deadline, type Incassi, incassiOf, limitBand, limitOf, plainCalendar, projected, ricaviOf, yearEstimate, yearIncassi } from "../tax-sums.ts";
import {
	BRIEF_DAYS,
	type FigureKey,
	GROUP_KEYS,
	GROUPS,
	type Group,
	GS_RATE_DEFAULT,
	GS_RATE_YEAR,
	groupOfAteco,
	groupOfWords,
	LIMIT_BAND_DAYS,
	NEW_2025_REDUCTION_PERCENT,
	NEW_2025_YEAR,
	type Pension,
	type PensionKind,
	RATE_FULL,
	RATE_START,
	START_RATE_YEARS,
	TAX_LIMITS,
	TaxError,
	type TaxProfile,
	taxAgentReads,
	UNSURE_GROUPS,
} from "../taxes.ts";
import { fold } from "../text-match.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { readItemAmount, readSignedEuros } from "../money-input.ts";
import { readPercent } from "./quote-input.ts";
import { isProblem, type Problem } from "../text-input.ts";
import { asWho, briefAnswer, calendarAnswer, ESTIMATE_NOTE, estimateAnswer, fenced, figureWords, percentText, plainAnswer, profileLines, rateNote, taxCsv, whatIfAnswer } from "./tax-render.ts";

const TAX_OPS = ["set_profile", "set_aside", "estimate", "calendar", "what_if", "export"] as const;
type Op = (typeof TAX_OPS)[number];

/** What changed, for the audit: the op and how many, never amounts, years, names or dates. */
export type TaxEvent = { readonly type: "taxes.changed"; readonly op: "set_profile" | "set_aside" | "export"; readonly count: number };

export type TaxToolsOptions = {
	readonly workspace: Workspace;
	readonly store: TaxStore;
	/** The scadenzario, read only: the company (its regime) and the paid marks. */
	readonly invoices: Pick<InvoiceStore, "read">;
	/** The scadenzario's scanner of the same workspace, shared (one cache); one of its own otherwise. */
	readonly scanner?: InvoiceScanner;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: TaxEvent) => Promise<void>;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Tasse del forfettario of the owner, solo regime forfettario (nell'ordinario l'IVA è vat_settlement; un F24 con importo fissato va in cashflow con add_item): how much to put aside, the imposta sostitutiva and INPS contributions of the year, the next F24 and how much, what another incasso leaves. The incassi are the invoices marked paid in the scadenzario, by the day marked paid. Fixed F24 voci the person adds in the cashflow are kept there; this tool estimates.",
	"What the person says → op: «quanto devo mettere da parte per le tasse?», «quante tasse pago quest'anno?» → estimate (project true for «se continuo così»); «quando scade il prossimo F24 e quanto?» → calendar; «se incasso altri 10.000 € quanto mi resta?» → what_if (amount, date optional); «ho accantonato 3.000» → set_aside (amount: the total put aside so far this year); «sono un consulente informatico, forfettario al 15%, gestione separata» → set_profile with activity «consulente informatico»: a generic activity gets a question for the ATECO code, ask the person and repeat with the code; «fammi il file per il commercialista» → export.",
	`set_profile, only with what the person says: activity (their words, «consulente», «commercio», or the ATECO code) or coefficient (the percentage); when the tool asks which group, ask the person. rate 15 or 5 (5: the first ${START_RATE_YEARS} years of a new activity with the requisites, start_year needed). start_year. pension: gestione separata (pension_rate, default ${percentText(GS_RATE_DEFAULT)}), artigiani or commercianti (fixed contributions, minimale and percentage default to the year's INPS figures; ask only about reduction: true for the 35% reduction; first_registered_2025 true for the ${NEW_2025_REDUCTION_PERCENT}% one; pension_fixed, minimale, pension_rate only when the person says them, the fixed amount whole, before any reduction), cassa professionale (pension_rate, pension_minimum, pension_integrativo: the contributo integrativo charged in the invoices, taken out of the incassi), nessuna. Last year's figures from the dichiarazione: last_year_imposta, last_year_contributi (for artigiani and commercianti only the part over the minimale), last_year_acconti_imposta, last_year_acconti_contributi (acconti paid last year); this year: paid_acconti_imposta, paid_acconti_contributi (acconti paid so far), paid_contributions (contributions paid). "" clears a figure.`,
	"calendar: the next F24 with amounts (metodo storico); method previsionale with expected_income when the person expects to earn less (warn about penalties); compact true: the brief's line. export: CSV under tasse/; then send it with file_send.",
	"Every answer is an estimate to check with the commercialista: say so, and repeat amounts and dates as given, never compute them yourself.",
].join(" ");

const PENSION_WORDS: readonly (readonly [PensionKind, RegExp])[] = [
	["nessuna", /^(?:nessun[ao]?|niente|no|nessuna cassa|nessun contributo)$/],
	["gestione_separata", /\b(?:gestione separata|separata|gs)\b/],
	["artigiani", /\bartigian[oiea]\b/],
	["commercianti", /\bcommerciant[ei]\b/],
	["cassa", /\b(?:cassa|inarcassa|forense|enpap|enpam|cnpadc|cipag|epap|enpacl|enpav|eppi|cassa professionale)\b/],
];

/** The profile's fields set_profile reads: any of them makes it a write; none shows the profile. */
const PROFILE_FIELDS = ["activity", "coefficient", "rate", "start_year", "pension", "pension_rate", "pension_fixed", "minimale", "reduction", "first_registered_2025", "pension_minimum", "pension_integrativo"] as const;
const FIGURE_FIELDS: Readonly<Record<string, { readonly key: FigureKey; readonly lastYear: boolean }>> = {
	last_year_imposta: { key: "imposta", lastYear: true },
	last_year_contributi: { key: "contributi", lastYear: true },
	last_year_acconti_imposta: { key: "accontiImposta", lastYear: true },
	last_year_acconti_contributi: { key: "accontiContributi", lastYear: true },
	paid_acconti_imposta: { key: "accontiImposta", lastYear: false },
	paid_acconti_contributi: { key: "accontiContributi", lastYear: false },
	paid_contributions: { key: "contributiVersati", lastYear: false },
};

/** The profile's change as said: each field undefined when not said. */
type Said = {
	coefficient?: string;
	group?: Group;
	groupFrom?: "ateco" | "parole";
	rate?: string;
	startYear?: number;
	pension?: PensionKind;
	pensionRate?: string;
	fixed?: string;
	minimale?: string;
	reduction?: boolean;
	new2025?: boolean;
	minimum?: string | null;
	integrativo?: string | null;
};

/**
 * Le tasse del forfettario (taxes.ts): the profile and the figures kept here; the estimate, the
 * calendar and the what_if from the scadenzario's incassi, read only; the CSV. Today is read once
 * per call.
 */
export function createTaxTools(options: TaxToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const scanner = options.scanner ?? new InvoiceScanner(workspace);
	const dayOf = dayOfIn(timeZone);
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const audit = async (ctx: ToolContext, op: TaxEvent["op"], count: number) => {
		// Its own step: an audit that failed is written on the rerun, after the change it records.
		await ctx.step("audit", async () => {
			await options.record?.({ type: "taxes.changed", op, count });
			return true;
		});
	};
	const amount = { type: ["number", "string"], description: "euros: a JSON number (1250.5) or a string as said («1.250,50», «3.000», «3k»)" };
	const percent = { type: ["number", "string"], description: "a percentage: 78, «26,07»" };
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	return [
		{
			name: "taxes",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...TAX_OPS] },
					activity: text(120, "set_profile: what the person does, in their words, or the ATECO code"),
					coefficient: { ...percent, description: "set_profile: the coefficiente di redditività, when the person says the percentage" },
					rate: { ...percent, description: "set_profile: 15 or 5" },
					start_year: { type: "integer", minimum: TAX_LIMITS.firstYear, maximum: 2200, description: "set_profile: the year the activity started" },
					pension: text(60, "set_profile: gestione separata, artigiani, commercianti, cassa professionale, nessuna"),
					pension_rate: { ...percent, description: "set_profile: the contributions' percentage" },
					pension_fixed: { ...amount, description: "set_profile: artigiani/commercianti, the fixed contributions of a year as paid" },
					minimale: { ...amount, description: "set_profile: artigiani/commercianti, the reddito minimale" },
					reduction: { type: "boolean", description: "set_profile: artigiani/commercianti with the 35% reduction" },
					first_registered_2025: { type: "boolean", description: `set_profile: artigiani/commercianti first registered with INPS in 2025, the ${NEW_2025_REDUCTION_PERCENT}% reduction` },
					pension_minimum: { ...amount, description: "set_profile: cassa professionale, the minimum contribution (\"\" clears)" },
					pension_integrativo: { ...percent, description: "set_profile: cassa professionale, the contributo integrativo percentage charged in the invoices (\"\" clears)" },
					last_year_imposta: { ...amount, description: "set_profile: last year's imposta sostitutiva due (\"\" clears)" },
					last_year_contributi: { ...amount, description: "set_profile: last year's contributions on the reddito (\"\" clears)" },
					last_year_acconti_imposta: { ...amount, description: "set_profile: acconti of imposta paid last year (\"\" clears)" },
					last_year_acconti_contributi: { ...amount, description: "set_profile: acconti of contributions paid last year (\"\" clears)" },
					paid_acconti_imposta: { ...amount, description: "set_profile: acconti of imposta paid so far this year (\"\" clears)" },
					paid_acconti_contributi: { ...amount, description: "set_profile: acconti of contributions paid so far this year (\"\" clears)" },
					paid_contributions: { ...amount, description: "set_profile: contributions actually paid this year (\"\" clears)" },
					amount: { ...amount, description: "set_aside: the total put aside so far; what_if: the further incasso" },
					date: text(40, "what_if: the day of the incasso (default this year)"),
					year: { type: "integer", minimum: TAX_LIMITS.firstYear, maximum: 2200, description: "estimate, set_aside, export: the year (default this one)" },
					project: { type: "boolean", description: "estimate, what_if: to the year's end if incassi go on as so far" },
					method: { type: "string", enum: ["storico", "previsionale"], description: "calendar: storico (default) or previsionale" },
					expected_income: { ...amount, description: "calendar previsionale: the incassi the person expects this year" },
					compact: { type: "boolean", description: "calendar: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!TAX_OPS.includes(args.op as Op)) return `Errore: op è una di queste: ${TAX_OPS.join(", ")}.`;
				const op = args.op as Op;
				// Another agente's request is not the person's word: it reads (estimate, calendar, what_if), nothing else.
				if (isAgentTurn(ctx) && !taxAgentReads(args)) {
					return "Errore: in una richiesta di un altro agente non cambio il profilo delle tasse, non salvo accantonamenti e non esporto: lo fa chi ti scrive, nella sua conversazione.";
				}
				const day = todayIn(timeZone, now());
				try {
					switch (op) {
						case "set_profile":
							return await setProfile(args, ctx, day);
						case "set_aside":
							return await setAside(args, ctx, day);
						case "estimate":
							return await estimateOp(args, ctx, day);
						case "calendar":
							return await calendarOp(args, ctx, day);
						case "what_if":
							return await whatIf(args, ctx, day);
						case "export":
							return await exportCsv(args, ctx, day);
					}
				} catch (error) {
					if (error instanceof TaxError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	function readable(): TaxBook {
		const book = store.read();
		if (book.broken) throw new TaxError(TAXES_BROKEN);
		return book;
	}

	function ordinario(): boolean {
		const b = options.invoices.read();
		return !b.broken && b.company?.regime === "ordinario";
	}

	async function invoicesOf(ctx: ToolContext): Promise<Invoice[]> {
		const scan = await scanner.scan(ctx.signal, (t) => ctx.progress(t));
		const book = options.invoices.read();
		return book.broken ? [] : register(scan.invoices, book.paid, book.company, book.reminders);
	}

	function incassiReader(invoices: readonly Invoice[], day: string): (year: number) => Incassi {
		return yearIncassi(invoices, day, dayOf);
	}

	/** A figure in euros, 0 allowed: "" clears (null). */
	function readFigure(value: unknown, what: string): string | null | undefined | Problem {
		if (value === undefined) return undefined;
		if (value === "" || value === null) return null;
		const read = readSignedEuros(value, fenced, what);
		if (read === undefined || isProblem(read)) return read;
		if (read.startsWith("-")) return { problem: `${what}: un importo senza segno meno` };
		return read;
	}

	function readYear(value: unknown, day: string): number | Problem {
		const current = Number(day.slice(0, 4));
		if (value === undefined) return current;
		if (typeof value !== "number" || !Number.isInteger(value) || value < TAX_LIMITS.firstYear || value > current) return { problem: `year è un anno dal ${TAX_LIMITS.firstYear} al ${current}` };
		return value;
	}

	/** The coefficient and its group from the words, the ATECO code or the percentage; a question when unsure. */
	function readCoefficient(args: Record<string, unknown>): { coefficient?: string; group?: Group; groupFrom?: "ateco" | "parole"; note?: string } | string {
		let group: Group | undefined;
		let groupFrom: "ateco" | "parole" | undefined;
		let note: string | undefined;
		if (args.activity !== undefined) {
			if (typeof args.activity !== "string" || args.activity.trim() === "" || args.activity.length > 120) return "Errore: activity è quello che fa chi ti scrive, a parole, o il codice ATECO.";
			const code = /^\s*(?:ateco\s*)?\d{2}(?:[.\d]{0,6})\s*$/i.test(args.activity);
			const found = code ? groupOfAteco(args.activity) : groupOfWords(args.activity);
			const table = GROUP_KEYS.map((g) => `• ${GROUPS[g].label}: ${GROUPS[g].coefficient}%`).join("\n");
			if (found === undefined) return `Questo codice ATECO non basta per sapere il gruppo: chiedi a chi ti scrive il codice completo (per esempio 47.81.01) o il coefficiente.\nI gruppi:\n${table}`;
			if (found === "ambiguous") return `Non l'ho salvato: da queste parole l'attività può stare in più gruppi, con coefficienti diversi:\n${fenced(args.activity)}\nChiedi a chi ti scrive quale di questi è il suo, o il codice ATECO:\n${table}`;
			if (found === "unsure") {
				const likely = UNSURE_GROUPS.map((u) => `• ${GROUPS[u.group].label}: ${GROUPS[u.group].coefficient}% (per esempio ATECO ${u.ateco}, ${u.example})`).join("\n");
				return `Non l'ho salvato: da queste parole il gruppo dell'attività dipende dal codice ATECO:\n${fenced(args.activity)}\nDi solito è uno di questi due:\n${likely}\nChiedi a chi ti scrive il suo codice ATECO (è nella visura o nel cassetto fiscale) o il coefficiente.`;
			}
			if (found === "unknown") return `Non l'ho salvato: da queste parole non so il gruppo dell'attività:\n${fenced(args.activity)}\nChiedi a chi ti scrive il codice ATECO o il coefficiente. I gruppi:\n${table}`;
			group = found;
			groupFrom = code ? "ateco" : "parole";
			if (code) note = "Ho preso il gruppo dal codice ATECO: con i codici ATECO 2025 alcuni sono cambiati, fai verificare il coefficiente al commercialista.";
		}
		if (args.coefficient !== undefined) {
			const c = readPercent(args.coefficient, "coefficient", fenced);
			if (c === null) return "Errore: coefficient va da 1 a 99.";
			if (isProblem(c)) return `Errore: ${c.problem}.`;
			if (c !== undefined && group !== undefined && GROUPS[group].coefficient !== c) return `Non l'ho salvato: per il gruppo «${GROUPS[group].label}» il coefficiente è ${GROUPS[group].coefficient}%, non ${percentText(c)}. Chiedi a chi ti scrive quale vale.`;
			const matching = GROUP_KEYS.filter((g) => GROUPS[g].coefficient === c);
			return { ...(c === undefined ? {} : { coefficient: c }), ...(group !== undefined ? { group, ...(groupFrom === undefined ? {} : { groupFrom }) } : matching.length === 1 ? { group: matching[0] as Group } : {}), ...(note === undefined ? {} : { note }) };
		}
		return group === undefined ? {} : { coefficient: GROUPS[group].coefficient, group, ...(groupFrom === undefined ? {} : { groupFrom }), ...(note === undefined ? {} : { note }) };
	}

	function readSaid(args: Record<string, unknown>): Said | string {
		const coefficient = readCoefficient(args);
		if (typeof coefficient === "string") return coefficient;
		const { note: _note, ...said0 } = coefficient;
		const said: Said = { ...said0 };
		if (args.rate !== undefined) {
			const r = readPercent(args.rate, "rate", fenced);
			if (r === null || isProblem(r) || (r !== RATE_FULL && r !== RATE_START)) return "Errore: rate è 15 o 5 (il 5% vale per i primi 5 anni di una nuova attività con i requisiti).";
			said.rate = r;
		}
		if (args.start_year !== undefined) {
			if (typeof args.start_year !== "number" || !Number.isInteger(args.start_year) || args.start_year < TAX_LIMITS.firstYear || args.start_year > 2200) return "Errore: start_year è l'anno in cui è iniziata l'attività, per esempio 2024.";
			said.startYear = args.start_year;
		}
		if (args.pension !== undefined) {
			const t = typeof args.pension === "string" ? fold(args.pension).trim() : "";
			const kind = PENSION_WORDS.find(([, re]) => re.test(t))?.[0];
			if (kind === undefined) return `Errore: pension è gestione separata, artigiani, commercianti, cassa professionale o nessuna${typeof args.pension === "string" ? `; non capisco:\n${fenced(args.pension)}` : ""}.`;
			said.pension = kind;
		}
		if (args.pension_rate !== undefined) {
			const r = readPercent(args.pension_rate, "pension_rate", fenced);
			if (r === null) return "Errore: pension_rate va da più di 0 a meno di 100.";
			if (isProblem(r)) return `Errore: ${r.problem}.`;
			if (r !== undefined) said.pensionRate = r;
		}
		for (const [field, key] of [
			["pension_fixed", "fixed"],
			["minimale", "minimale"],
		] as const) {
			const v = readFigure(args[field], field);
			if (v === null) return `Errore: ${field} non si toglie: dimmi l'importo.`;
			if (isProblem(v)) return `Errore: ${v.problem}.`;
			if (v !== undefined) said[key] = v;
		}
		const minimum = readFigure(args.pension_minimum, "pension_minimum");
		if (isProblem(minimum)) return `Errore: ${minimum.problem}.`;
		if (minimum !== undefined) said.minimum = minimum;
		if (args.pension_integrativo === "") said.integrativo = null;
		else if (args.pension_integrativo !== undefined) {
			const r = readPercent(args.pension_integrativo, "pension_integrativo", fenced);
			if (r === null) return "Errore: pension_integrativo va da più di 0 a meno di 100.";
			if (isProblem(r)) return `Errore: ${r.problem}.`;
			if (r !== undefined) said.integrativo = r;
		}
		for (const [field, key] of [
			["reduction", "reduction"],
			["first_registered_2025", "new2025"],
		] as const) {
			if (args[field] === undefined) continue;
			if (typeof args[field] !== "boolean") return `Errore: ${field} è true o false.`;
			said[key] = args[field];
		}
		return said;
	}

	/** The pension from what is said onto the old one; a question when something needed is missing. */
	function pensionOf(said: Said, old: Pension | undefined, year: number): Pension | string {
		const kind = said.pension ?? old?.kind;
		if (kind === undefined) return "Serve la cassa dei contributi: chiedi a chi ti scrive se versa alla gestione separata INPS, all'INPS come artigiano o come commerciante, a una cassa professionale, o niente.";
		const same = old?.kind === kind ? old : undefined;
		switch (kind) {
			case "gestione_separata": {
				const prev = same?.kind === "gestione_separata" ? same : undefined;
				// Only the person's own rate: the default is read at compute time (GS_RATE_DEFAULT).
				if (said.pensionRate !== undefined) return { kind, rate: said.pensionRate, rateYear: year };
				return prev?.rate === undefined ? { kind } : { kind, rate: prev.rate, ...(prev.rateYear === undefined ? {} : { rateYear: prev.rateYear }) };
			}
			case "artigiani":
			case "commercianti": {
				const prev = same?.kind === "artigiani" || same?.kind === "commercianti" ? same : undefined;
				// Only the person's own figures: the year's INPS ones are read at compute time (IVS_YEARS).
				const fixed = said.fixed ?? prev?.fixed;
				const rate = said.pensionRate ?? prev?.rate;
				const minimale = said.minimale ?? prev?.minimale;
				const top = prev?.top;
				const reduction = said.reduction ?? prev?.reduction;
				const new2025 = said.new2025 ?? prev?.new2025;
				if (reduction === undefined && new2025 === undefined) return `Per i contributi ${asWho(kind)} mi manca solo una cosa: chiedi a chi ti scrive se ha la riduzione del 35% per i forfettari (si chiede all'INPS) o, se si è iscritto all'INPS per la prima volta nel 2025, quella del ${NEW_2025_REDUCTION_PERCENT}%.`;
				return { kind, ...(fixed === undefined ? {} : { fixed }), ...(rate === undefined ? {} : { rate }), ...(minimale === undefined ? {} : { minimale }), ...(top === undefined ? {} : { top }), reduction: reduction ?? false, ...(new2025 === true ? { new2025: true as const } : {}) };
			}
			case "cassa": {
				const prev = same?.kind === "cassa" ? same : undefined;
				const rate = said.pensionRate ?? prev?.rate;
				if (rate === undefined) return "Per la cassa professionale mi serve la percentuale dei contributi (e il minimo, se c'è): chiedila a chi ti scrive.";
				const minimum = said.minimum === null ? undefined : (said.minimum ?? prev?.minimum);
				const integrativo = said.integrativo === null ? undefined : (said.integrativo ?? prev?.integrativo);
				return { kind, rate, ...(minimum === undefined ? {} : { minimum }), ...(integrativo === undefined ? {} : { integrativo }) };
			}
			case "nessuna":
				return { kind };
		}
	}

	/** The new profile from what is said onto `old`; a question (string) when something needed is missing. */
	function built(said: Said, old: TaxProfile | undefined, ctx: ToolContext, year: number): TaxProfile | string {
		const coefficient = said.coefficient ?? old?.coefficient;
		if (coefficient === undefined) return "Serve il coefficiente di redditività: chiedi a chi ti scrive che attività fa (o il codice ATECO) e ripeti con quelle parole.";
		const group = said.coefficient !== undefined ? said.group : old?.group;
		const groupFrom = said.coefficient !== undefined ? said.groupFrom : old?.groupFrom;
		// No default stored: undefined is the 15% (taxes.ts, TaxProfile.rate).
		const rate = said.rate ?? old?.rate;
		const startYear = said.startYear ?? old?.startYear;
		if (rate === RATE_START && startYear === undefined) return "Per l'imposta al 5% mi serve l'anno in cui è iniziata l'attività: vale per i primi 5 anni. Chiedilo a chi ti scrive.";
		const pension = pensionOf(said, old?.pension, year);
		if (typeof pension === "string") return pension;
		const at = now().toISOString();
		return {
			coefficient,
			...(group === undefined ? {} : { group }),
			...(groupFrom === undefined || group === undefined ? {} : { groupFrom }),
			...(rate === undefined ? {} : { rate }),
			...(startYear === undefined ? {} : { startYear }),
			pension,
			by: old?.by ?? who(ctx),
			at: old?.at ?? at,
			...(old === undefined ? {} : { edited: { by: who(ctx), at } }),
		};
	}

	async function setProfile(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		if (ordinario()) return "Errore: risulti in regime ordinario: so stimare solo le tasse del forfettario. Se chi ti scrive è passato al forfettario, aggiorna prima il regime nei dati dell'azienda.";
		const year = Number(day.slice(0, 4));
		const book = readable();
		// This call wrote already (run again after a stop): its audit, then the same answer.
		if (book.calls.includes(ctx.callId)) {
			await audit(ctx, "set_profile", 1);
			return book.profile === undefined ? "Fatto, cifre salvate." : ["Fatto, profilo delle tasse salvato:", ...profileLines(book.profile, year)].join("\n");
		}
		const profileSaid = PROFILE_FIELDS.some((f) => args[f] !== undefined);
		const figures: { year: number; patch: FiguresPatch }[] = [];
		const saidLines: string[] = [];
		for (const [field, { key, lastYear }] of Object.entries(FIGURE_FIELDS)) {
			const v = readFigure(args[field], field);
			if (isProblem(v)) return `Errore: ${v.problem}.`;
			if (v === undefined) continue;
			const y = lastYear ? year - 1 : year;
			const entry = figures.find((f) => f.year === y) ?? (figures.push({ year: y, patch: {} }), figures[figures.length - 1]);
			if (entry !== undefined) entry.patch[key] = v;
			saidLines.push(figureLine(key, y, v));
		}
		if (!profileSaid && figures.length === 0) {
			if (book.profile === undefined) return "Non c'è ancora un profilo delle tasse. Chiedi a chi ti scrive che attività fa (o il coefficiente), l'aliquota (15%, o 5% per i primi 5 anni di una nuova attività) e la cassa dei contributi.";
			return ["Il profilo delle tasse:", ...profileLines(book.profile, year)].join("\n");
		}
		const said = readSaid(args);
		if (typeof said === "string") return said;
		if (book.profile === undefined && !profileSaid) return "Prima del resto serve il profilo: chiedi a chi ti scrive che attività fa (o il coefficiente), l'aliquota e la cassa dei contributi.";
		const draft = profileSaid ? built(said, book.profile, ctx, year) : book.profile;
		if (typeof draft === "string") return draft;
		// Built again under the lock, onto the profile as saved then: another change in between stays.
		await ctx.step("apply", async () => {
			store.update(
				ctx.callId,
				profileSaid
					? (old) => {
							const made = built(said, old, ctx, year);
							if (typeof made === "string") throw new TaxError("il profilo è cambiato nel frattempo: ripeti la richiesta");
							return made;
						}
					: undefined,
				figures,
			);
			return true;
		});
		await audit(ctx, "set_profile", 1);
		const saved = readable().profile ?? draft;
		const lines = [profileSaid ? "Fatto, profilo delle tasse salvato:" : "Fatto, cifre salvate.", ...(profileSaid && saved !== undefined ? profileLines(saved, year) : []), ...saidLines];
		// The start year first: saldo and acconti depend on it.
		if (profileSaid && saved !== undefined && saved.startYear === undefined) lines.push("Chiedi a chi ti scrive in che anno ha aperto la partita IVA: mi serve per sapere se ci sono saldo e acconti da versare.");
		const start = saved?.startYear;
		if (profileSaid && said.rate === undefined && book.profile === undefined && (start === undefined || year < start + START_RATE_YEARS)) lines.push(`Ho messo l'imposta al 15%. ${start === undefined ? `Se l'attività ha meno di ${START_RATE_YEARS} anni, chiedi` : "Chiedi"} a chi ti scrive: ha i requisiti per il 5%?`);
		if (profileSaid && saved?.pension.kind === "gestione_separata" && said.pensionRate === undefined && book.profile?.pension.kind !== "gestione_separata") lines.push(`L'aliquota della gestione separata è quella del ${GS_RATE_YEAR}: se nel frattempo è cambiata, dimmi quella nuova.`);
		if (profileSaid && saved?.pension.kind === "cassa" && saved.pension.integrativo === undefined && said.integrativo === undefined) lines.push("Non so il contributo integrativo della cassa: chiedi a chi ti scrive la percentuale che mette in fattura, così lo tolgo dagli incassi. Finché non lo so, reddito e tasse vengono un po' più alti.");
		// The partita IVA can be older than the first registration with INPS as artigiano or commerciante: saved, the year to confirm.
		const p = saved?.pension;
		if (profileSaid && (p?.kind === "artigiani" || p?.kind === "commercianti") && p.new2025 === true && saved?.startYear !== NEW_2025_YEAR && (said.new2025 === true || said.startYear !== undefined))
			lines.push(`La riduzione del ${NEW_2025_REDUCTION_PERCENT}% vale per chi si è iscritto all'INPS ${asWho(p.kind)} per la prima volta nel ${NEW_2025_YEAR}${saved?.startYear === undefined ? "" : `, e l'attività risulta aperta nel ${saved.startYear}`}: chiedi a chi ti scrive di confermare l'anno della prima iscrizione (la partita IVA può essere più vecchia).`);
		const note = saved === undefined ? undefined : rateNote(saved, year);
		if (note !== undefined) lines.push(note);
		const coefficient = readCoefficient(args);
		if (typeof coefficient !== "string" && coefficient.note !== undefined) lines.push(coefficient.note);
		return lines.join("\n");
	}

	function figureLine(key: FigureKey, year: number, value: string | null): string {
		const words = figureWords(key, year);
		return value === null ? `Tolto: ${words}.` : `${capitalized(words)}: ${euros(scaled(value, 2))}.`;
	}

	async function setAside(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const year = readYear(args.year, day);
		if (isProblem(year)) return `Errore: ${year.problem}.`;
		const value = readFigure(args.amount, "amount");
		if (value === undefined) return "Errore: dimmi quanto ha messo da parte finora per le tasse di quest'anno (amount), in tutto.";
		if (isProblem(value)) return `Errore: ${value.problem}.`;
		readable();
		await ctx.step("apply", async () => {
			store.update(ctx.callId, undefined, [{ year, patch: { accantonato: value } }]);
			return true;
		});
		await audit(ctx, "set_aside", 1);
		if (value === null) return `Fatto, tolto quanto avevi messo da parte per il ${year}.`;
		const lines = [`Fatto: per le tasse del ${year} hai messo da parte ${euros(scaled(value, 2))} in tutto.`];
		const book = readable();
		if (book.profile !== undefined && !ordinario()) {
			const invoices = await invoicesOf(ctx);
			const inputs = inputsOf(book.profile, book, invoices, day);
			const e = yearEstimate(inputs, year, inputs.incassi(year).cents);
			const missing = e.total - scaled(value, 2);
			lines.push(missing > 0n ? `Con la stima di ora (${euros(e.total)}) ne mancano ${euros(missing)}.` : `Bastano per la stima di ora (${euros(e.total)}).`, ESTIMATE_NOTE);
		}
		return lines.join("\n");
	}

	/** The profile when the forfettario can be estimated; otherwise the answer with the dates only. */
	function profileOrPlain(day: string): TaxProfile | string {
		const ord = ordinario();
		const book = readable();
		if (ord || book.profile === undefined) return plainAnswer(plainCalendar(day, ord), ord);
		return book.profile;
	}

	async function estimateOp(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const year = readYear(args.year, day);
		if (isProblem(year)) return `Errore: ${year.problem}.`;
		if (args.project !== undefined && typeof args.project !== "boolean") return "Errore: project è true o false.";
		const profile = profileOrPlain(day);
		if (typeof profile === "string") return profile;
		const book = readable();
		const invoices = await invoicesOf(ctx);
		const inputs = inputsOf(profile, book, invoices, day);
		const incassi = inputs.incassi(year);
		const e = yearEstimate(inputs, year, incassi.cents);
		const soFar = year === Number(day.slice(0, 4));
		const p = args.project === true && soFar ? projected(incassi.cents, day) : undefined;
		const pe = p === undefined ? undefined : yearEstimate(inputs, year, p.ricavi);
		const accantonato = book.years.find((y) => y.year === year)?.accantonato;
		const limit = limitOf(e.ricavi);
		const projectedLimit = pe === undefined ? undefined : limitOf(pe.ricavi);
		return estimateAnswer({
			profile,
			estimate: e,
			incassi,
			soFar,
			today: day,
			...(p === undefined || pe === undefined ? {} : { projection: { p, estimate: pe } }),
			...(accantonato === undefined ? {} : { accantonato: scaled(accantonato, 2) }),
			...(limit === undefined ? {} : { limit }),
			...(projectedLimit === undefined ? {} : { projectedLimit }),
		});
	}

	function inputsOf(profile: TaxProfile, book: TaxBook, invoices: readonly Invoice[], day: string, previsionale?: { ricavi?: bigint }): CalendarInputs {
		return { profile, figures: book.years, incassi: incassiReader(invoices, day), today: day, ...(previsionale === undefined ? {} : { previsionale }) };
	}

	async function calendarOp(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è true o false.";
		if (args.compact === true) return compact(ctx, day);
		if (args.method !== undefined && args.method !== "storico" && args.method !== "previsionale") return "Errore: method è storico o previsionale.";
		const profile = profileOrPlain(day);
		if (typeof profile === "string") return profile;
		let expected: bigint | undefined;
		if (args.expected_income !== undefined) {
			if (args.method !== "previsionale") return "Errore: expected_income va con il metodo previsionale.";
			const v = readItemAmount(args.expected_income, fenced);
			if (isProblem(v)) return `Errore: ${v.problem.replace(/^amount/, "expected_income")}.`;
			if (v !== undefined) expected = scaled(v, 2);
		}
		const book = readable();
		const invoices = await invoicesOf(ctx);
		const previsionale = args.method === "previsionale" ? (expected === undefined ? {} : { ricavi: expected }) : undefined;
		const inputs = inputsOf(profile, book, invoices, day, previsionale);
		const lastYear = Number(day.slice(0, 4)) - 1;
		const storico = inputsOf(profile, book, invoices, day);
		const acconti = accontiOfYear(inputs, lastYear + 1);
		const juneUnknown = (acconti.imposta !== undefined && acconti.imposta.first === undefined) || (acconti.contributi !== undefined && acconti.contributi.first === undefined);
		const year = lastYear + 1;
		// The June F24 of this year already gone: what the storico method put there, «hai versato».
		const june = previsionale === undefined || juneUnknown ? undefined : calendar(storico, 366, `${year}-01-01`).find((d) => d.kind === "giugno" && d.due.startsWith(`${year}-`) && d.date < day);
		const firstOf = (d: Deadline, kind: string) => d.parts.find((p) => p.kind === kind && p.n === 1 && p.forYear === year)?.cents;
		const paidJune =
			june === undefined
				? undefined
				: (() => {
						const imposta = firstOf(june, "acconto_imposta");
						const contributi = firstOf(june, "acconto_contributi");
						const late = calendar(storico).some((d) => d.kind === "giugno" && d.due === june.due && d.late !== undefined);
						return { date: june.date, ...(imposta === undefined ? {} : { imposta }), ...(contributi === undefined ? {} : { contributi }), late };
					})();
		// A credit only on acconti said or with the previsionale method: early in the year the storico projection is too rough.
		const over = previsionale !== undefined || accontiPaid(storico, year).source === "detti" ? creditOf(inputs, year) : { imposta: 0n, contributi: 0n };
		const credit = over.imposta + over.contributi;
		return calendarAnswer({
			today: day,
			profile,
			deadlines: calendar(inputs),
			base: baseOf(storico, lastYear),
			lastYear,
			accontiSource: accontiPaid(storico, lastYear).source,
			...(previsionale === undefined ? {} : { previsionale: { estimate: currentEstimate(inputs), expected: expected !== undefined, storico: calendar(storico), juneUnknown, ...(paidJune === undefined ? {} : { paidJune }) } }),
			...(credit > 0n ? { credit } : {}),
		});
	}

	/**
	 * The brief's line: an F24 within BRIEF_DAYS with its amount, or a limit band (80%, 90%, past
	 * 85.000 €, past 100.000 €) the incassi of the last LIMIT_BAND_DAYS days crossed. Read only,
	 * always: the brief keeps no state, so «since the last brief» is the last week of incassi.
	 */
	async function compact(ctx: ToolContext, day: string): Promise<string> {
		const book = readable();
		if (book.profile === undefined || ordinario()) return briefAnswer([], day, undefined, 0n);
		const invoices = await invoicesOf(ctx);
		const inputs = inputsOf(book.profile, book, invoices, day);
		const soon = calendar(inputs, BRIEF_DAYS + 1);
		const year = Number(day.slice(0, 4));
		const pension = book.profile.pension;
		const ricavi = ricaviOf(pension, inputs.incassi(year).cents);
		const before = ricaviOf(pension, incassiOf(invoices, year, dayOf, addDays(day, -LIMIT_BAND_DAYS)).cents);
		const limit = limitOf(ricavi);
		// Past 100.000 € the forfettario ends this year: the brief keeps saying it until the 31st of December.
		return briefAnswer(soon, day, limit === "oltre_100" || limitBand(ricavi) > limitBand(before) ? limit : undefined, ricavi);
	}

	async function whatIf(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const extra = readItemAmount(args.amount, fenced);
		if (extra === undefined) return "Errore: dimmi quanto incasseresti in più (amount).";
		if (isProblem(extra)) return `Errore: ${extra.problem}.`;
		if (args.project !== undefined && typeof args.project !== "boolean") return "Errore: project è true o false.";
		const current = Number(day.slice(0, 4));
		let date: string | undefined;
		if (args.date !== undefined) {
			if (typeof args.date !== "string") return "Errore: date è il giorno dell'incasso, come 15/12/2026.";
			try {
				date = readDate(args.date, day).date;
			} catch (error) {
				// The person's words go back only inside the fence, never in the parser's message.
				if (error instanceof DateError) return `Errore: non capisco il giorno dell'incasso, dimmelo come 15/12/2026:\n${fenced(args.date.slice(0, 120))}`;
				throw error;
			}
			if (date < `${current}-01-01` || Number(date.slice(0, 4)) > current + 1) return `Errore: l'incasso ipotetico va nel ${current} o nel ${current + 1}.`;
		}
		const profile = profileOrPlain(day);
		if (typeof profile === "string") return profile;
		const book = readable();
		const year = date === undefined ? current : Number(date.slice(0, 4));
		const invoices = await invoicesOf(ctx);
		const inputs = inputsOf(profile, book, invoices, day);
		const so = inputs.incassi(year).cents;
		const projectedRicavi = args.project === true && year === current ? projected(so, day).ricavi : so;
		const before = yearEstimate(inputs, year, projectedRicavi);
		const add = scaled(extra, 2);
		const after = yearEstimate(inputs, year, projectedRicavi + add);
		const lb = limitOf(before.ricavi);
		const la = limitOf(after.ricavi);
		return whatIfAnswer({ amount: add, ...(date === undefined ? {} : { date }), before, after, projected: projectedRicavi !== so, ...(lb === undefined ? {} : { limitBefore: lb }), ...(la === undefined ? {} : { limitAfter: la }) });
	}

	async function exportCsv(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const year = readYear(args.year, day);
		if (isProblem(year)) return `Errore: ${year.problem}.`;
		const profile = profileOrPlain(day);
		if (typeof profile === "string") return profile;
		const book = readable();
		const invoices = await invoicesOf(ctx);
		const inputs = inputsOf(profile, book, invoices, day);
		const e = yearEstimate(inputs, year, inputs.incassi(year).cents);
		const current = year === Number(day.slice(0, 4));
		const deadlines = current ? calendar(inputs) : [];
		const incassi = cashBook(invoices, [], { from: `${year}-01-01`, to: current ? day : `${year}-12-31` }, dayOf).rows.filter((r) => r.kind === "in");
		const { csv, rows } = taxCsv({ estimate: e, profile, figures: book.years, incassi, deadlines });
		// The name only from the year and today's date, under tasse/; a new file never replaces one there.
		const path = await ctx.step("path", async () => freePath(workspace, `tasse/tasse-${year}-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, csv)).path);
		await audit(ctx, "export", rows);
		const next = deadlines[0];
		return [
			`Salvato ${written}: la stima del ${year}${deadlines.length > 0 ? " e le scadenze F24 dei prossimi 12 mesi" : ""} (separatore «;», decimali con la virgola, si apre con Excel).`,
			`Tasse e contributi stimati: ${euros(e.total)}${next === undefined ? "" : `; prossimo F24 ${withDate("il", next.date)}`}.`,
			ESTIMATE_NOTE,
			"Mandalo con file_send se chi ti scrive lo vuole.",
		].join("\n");
	}
}
