import { StringEnum, type Static, Type } from "@earendil-works/pi-ai";
import {
	addMonths,
	addTo,
	ageOn,
	type CountedHoliday,
	DateError,
	type DateReading,
	dayOfYear,
	dueDates,
	holidaysKnown,
	isoWeek,
	LAST_YEAR,
	MAX_AMOUNT,
	NO_HOLIDAYS,
	offDayWhy,
	parseMonth,
	type Patrono,
	parsePatrono,
	type ReadDate,
	readDate,
	slipPhrase,
	span,
	UNITS,
	type Unit,
	workingDaysIn,
} from "../dates.ts";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { daysBetween, daysInMonth, type Holiday, HOLIDAYS_SINCE, holidayOn, isoDate, italianHolidays, leapYear, MONTH_NAMES, realDate, todayIn, weekdayOf, type WorkingWeek, workingDay } from "../italian-calendar.ts";
import { capitalized, italianDate, italianWeekday } from "../italian-format.ts";

export type DateToolsOptions = {
	/** The server's time zone (OWNI_TIME_ZONE): where "today" is. */
	readonly timeZone: string;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const OPS = ["info", "between", "add", "due", "working_days", "holidays", "age"] as const;
type Op = (typeof OPS)[number];
const MAX_TEXT = 60;
const MAX_INSTALMENTS = 12;
const MAX_DUE_DAYS = 720;
/** Holidays listed one by one in an answer; beyond, only how many. */
const MAX_LISTED = 15;
/** In between's working-days line, holidays are named up to this many; beyond, counted. */
const MAX_NAMED_IN_SPAN = 3;
const UNIT_WORDS: Readonly<Record<Unit, readonly [string, string]>> = {
	days: ["giorno", "giorni"],
	working_days: ["giorno lavorativo", "giorni lavorativi"],
	weeks: ["settimana", "settimane"],
	months: ["mese", "mesi"],
	years: ["anno", "anni"],
};
const DAYS: readonly [string, string] = ["giorno", "giorni"];
/** The years 4 October is named as just restored. */
const SAN_FRANCESCO_NEWS = new Set([2026, 2027]);

const dateCalcParameters = Type.Object(
	{
		op: StringEnum([...OPS]),
		date: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT, description: "The date: 15/03/2027, «15 marzo», oggi, Natale…" })),
		to: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT, description: "between and working_days: the end; age: the day of the age" })),
		amount: Type.Optional(Type.Integer({ minimum: -MAX_AMOUNT, maximum: MAX_AMOUNT })),
		unit: Type.Optional(StringEnum([...UNITS], { description: "add: days if absent" })),
		days: Type.Optional(
			Type.Union(
				[
					Type.Integer({ minimum: 0, maximum: MAX_DUE_DAYS }),
					Type.String({ minLength: 1, maxLength: MAX_TEXT }),
					Type.Array(Type.Integer({ minimum: 0, maximum: MAX_DUE_DAYS }), { minItems: 1, maxItems: MAX_INSTALMENTS }),
				],
				{ description: "due: 60, «30-60-90 dffm», [30, 60, 90]" },
			),
		),
		end_of_month: Type.Optional(Type.Boolean({ description: "due: true for fine mese (f.m.)" })),
		fixed_day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, description: "due: giorno fisso" })),
		month: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
		year: Type.Optional(Type.Integer({ minimum: HOLIDAYS_SINCE, maximum: LAST_YEAR })),
		inclusive: Type.Optional(Type.Boolean({ description: "between: count the first day too" })),
		patrono: Type.Optional(Type.String({ minLength: 1, maxLength: 30, description: "29/06, «7 dicembre» or Milano" })),
		saturday_working: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
type DateCalcArgs = Static<typeof dateCalcParameters>;
type TextArg = "date" | "to" | "month" | "patrono";

/**
 * Calendar arithmetic, which language models get wrong: what day a date falls on, days and
 * working days between dates, adding to a date, invoice due dates, Italian holidays, ages. Pure
 * and offline (no network, no keys), so always offered and safe in the brief's thread; nothing
 * from outside, so no fence. The rules live in dates.ts and italian-calendar.ts.
 */
export function createDateTools(options: DateToolsOptions): OwniTool[] {
	const now = options.now ?? (() => new Date());
	return [
		defineOwniTool({
			name: "date_calc",
			description:
				"Exact date arithmetic with the Italian calendar: use it for dates, days, deadlines and working days, never work them out in your head, and give the dates with their weekday. " +
				"info: weekday, holiday, working day, ISO week. " +
				"between: from date (today if absent) to to, for «quanti giorni mancano/sono passati»: days, also in weeks and months, and working days. " +
				"working_days: month («novembre 2026») or date to to, both ends included: for «giorni lavorativi tra/dal… al». " +
				"add: amount (negative to go back) of unit to date (today if absent); also for «fra due settimane». " +
				"due: invoice date, days 60 or «30,60,90»; d.f. = days from the invoice date; f.m. (end_of_month) = those days, then the end of that month; fixed_day = «giorno fisso». A due date on a holiday is given with the next working day; when the tool also gives the date counted by months, mention it. " +
				`holidays: national holidays of year (from ${HOLIDAYS_SINCE}). age: birth date → age and next birthday. ` +
				"Working days are Monday to Friday minus holidays; Saturday only with saturday_working. patrono is the patron saint's day or a capoluogo's name: use it when the city is known or said; don't ask just for this. " +
				"A date without a year is the next one (for due and age the latest past one). Today is the server's date.",
			parameters: dateCalcParameters,
			replaySafe: true,
			async execute(args) {
				const problem = argsProblem(args);
				if (problem !== undefined) return `Errore: ${problem}.`;
				try {
					return answer(args, todayIn(options.timeZone, now()));
				} catch (error) {
					if (error instanceof DateError) return `Errore: ${error.message}.`;
					throw error;
				}
			},
		}),
	];
}

/** Arguments of the wrong type, the way the other tools answer them. */
function argsProblem(args: DateCalcArgs): string | undefined {
	if (!OPS.includes(args.op as Op)) return `op è una di queste: ${OPS.join(", ")}`;
	for (const name of ["date", "to", "month", "patrono"] as const) {
		if (args[name] !== undefined && typeof args[name] !== "string") return `${name} è un testo`;
		if (typeof args[name] === "string" && (args[name] as string).length > MAX_TEXT) return `${name} è troppo lungo`;
	}
	for (const name of ["inclusive", "end_of_month", "saturday_working"] as const) {
		if (args[name] !== undefined && typeof args[name] !== "boolean") return `${name} è true o false`;
	}
	if (args.amount !== undefined && !(Number.isSafeInteger(args.amount) && Math.abs(args.amount as number) <= MAX_AMOUNT)) return `amount è un numero intero da −${number(MAX_AMOUNT)} a ${number(MAX_AMOUNT)}`;
	if (args.unit !== undefined && !UNITS.includes(args.unit as Unit)) return `unit è una di queste: ${UNITS.join(", ")}`;
	if (args.fixed_day !== undefined && !(Number.isInteger(args.fixed_day) && (args.fixed_day as number) >= 1 && (args.fixed_day as number) <= 31)) return "fixed_day è un giorno del mese, da 1 a 31";
	if (args.year !== undefined && !Number.isInteger(args.year)) return "year è un anno";
	if (typeof args.year === "number" && args.year < HOLIDAYS_SINCE) return NO_HOLIDAYS;
	if (typeof args.year === "number" && args.year > LAST_YEAR) return `year va al più fino al ${LAST_YEAR}`;
	return undefined;
}

function answer(args: DateCalcArgs, today: string): string {
	const text = (name: TextArg) => (args[name]?.trim() === "" ? undefined : args[name]);
	const patrono = text("patrono") === undefined ? undefined : parsePatrono(text("patrono") as string);
	const week: WorkingWeek = { ...(patrono === undefined ? {} : { patrono: patrono.day }), ...(args.saturday_working === true ? { saturdayWorking: true } : {}) };
	const warnings: string[] = [];
	const read = (value: string, reading: DateReading = {}): ReadDate => {
		const found = readDate(value, today, reading);
		if (found.warning !== undefined) warnings.push(found.warning);
		return found;
	};
	const result = respond(args, today, text, read, week, patrono);
	return result.startsWith("Errore:") ? result : [result, ...warnings.map((w) => `Attenzione: ${w}.`)].join("\n");
}

function respond(args: DateCalcArgs, today: string, text: (name: TextArg) => string | undefined, read: (value: string, reading?: DateReading) => ReadDate, week: WorkingWeek, patrono: Patrono | undefined): string {
	const date = text("date");
	const to = text("to");
	const names = holidayNames(patrono);
	switch (args.op) {
		case "info":
			if (date === undefined) return "Errore: manca date, la data da guardare.";
			return infoAnswer(read(date).date, today, week, names);
		case "between": {
			if (to === undefined) return "Errore: manca to, la data di arrivo.";
			const range = date === undefined ? { from: today, to: read(to).date } : rangeOf(read, date, to);
			if (typeof range === "string") return range;
			return betweenAnswer(range.from, range.to, today, args.inclusive === true, week, names);
		}
		case "add": {
			if (args.amount === undefined) return "Errore: manca amount, quanto aggiungere (negativo per andare indietro).";
			return addAnswer(read(date ?? "oggi").date, args.amount, args.unit ?? "days", today, week, names);
		}
		case "due": {
			if (date === undefined) return "Errore: manca date, la data della fattura.";
			const spec = dueSpecOf(args.days);
			if (typeof spec === "string") return `Errore: ${spec}.`;
			const asked = args.end_of_month;
			if (asked !== undefined && spec.endOfMonth !== undefined && asked !== spec.endOfMonth) return `Errore: days dice ${spec.endOfMonth ? "fine mese" : "data fattura"} ma end_of_month è ${asked}.`;
			const fixed = args.fixed_day;
			if (fixed !== undefined && spec.fixedDay !== undefined && fixed !== spec.fixedDay) return `Errore: days dice giorno fisso ${spec.fixedDay} ma fixed_day è ${fixed}.`;
			return dueAnswer(read(date, { rule: "past" }).date, spec.days, asked ?? spec.endOfMonth ?? false, fixed ?? spec.fixedDay, patrono?.day, names);
		}
		case "working_days": {
			if (text("month") !== undefined) {
				const { year, month } = parseMonth(text("month") as string, today);
				return workingAnswer(`${MONTH_NAMES[month - 1]} ${year}`, isoDate(year, month, 1), isoDate(year, month, daysInMonth(year, month)), week, names);
			}
			if (date === undefined || to === undefined) return "Errore: dammi month (un mese) oppure date e to (un intervallo).";
			const range = rangeOf(read, date, to);
			if (typeof range === "string") return range;
			if (range.to < range.from) return "Errore: to viene prima di date.";
			return workingAnswer(`da ${dayText(range.from)} a ${dayText(range.to)}, compresi`, range.from, range.to, week, names);
		}
		case "holidays":
			return holidaysAnswer(args.year ?? Number(today.slice(0, 4)), patrono, names);
		case "age": {
			if (date === undefined) return "Errore: manca date, la data di nascita.";
			const on = to === undefined ? today : read(to).date;
			return ageAnswer(read(date, { rule: "past", reference: on, yearNeeded: true }).date, on, today);
		}
	}
}

/**
 * Two written dates of a range. A `to` without a year is placed from `date`; when that would
 * carry it into a later year (10/12 → 1/12), it is refused rather than spanning a year silently.
 * From today (no date), a yearless `to` is simply its next occurrence: Natale.
 */
function rangeOf(read: (value: string, reading?: DateReading) => ReadDate, fromText: string, toText: string): { from: string; to: string } | string {
	const from = read(fromText);
	const to = read(toText, { reference: from.date });
	if (to.yearless && to.date.slice(0, 4) !== from.date.slice(0, 4)) return "Errore: to viene prima di date nello stesso anno: scrivi l'anno se intendi l'anno dopo.";
	return { from: from.date, to: to.date };
}

type DueSpec = { readonly days: number[]; readonly endOfMonth?: boolean; readonly fixedDay?: number };

/**
 * The payment days as written: 60, [30, 60, 90], or a text «30-60-90», «30/60/90 dffm»,
 * «60 gg fine mese data fattura», «30 gg FM 10». «dffm», «d.f.f.m.», «df fm», «ffm», «f.m.» and
 * «fine mese» say end of month; «data fattura» and «d.f.» alone say days from the invoice date; a
 * number after f.m. is the giorno fisso. d.f. and f.m. on different instalments are refused.
 */
function dueSpecOf(value: unknown): DueSpec | string {
	const wrong = `days sono i giorni di pagamento, da 0 a ${MAX_DUE_DAYS}: 60, «30,60,90», «30-60-90 dffm» o [30, 60, 90], al più ${MAX_INSTALMENTS}`;
	if (value === undefined) return "manca days, i giorni di pagamento (60, «30,60,90»…)";
	if (typeof value === "number" || Array.isArray(value)) {
		const days = checkedDays(Array.isArray(value) ? value : [value]);
		return days === undefined ? wrong : { days };
	}
	if (typeof value !== "string") return wrong;
	const word = (pattern: string) => new RegExp(`(?<![a-z])(?:${pattern})(?![a-z])`, "g");
	const tokens = ` ${value.toLowerCase()} `
		.replace(word("d\\.?\\s?f\\.?\\s?f\\.?\\s?m\\.?|ffm\\.?"), " FM ")
		.replace(word("fine mese|f\\.?\\s?m\\.?"), " FM ")
		.replace(word("data fattura|d\\.?\\s?f\\.?"), " DF ")
		.replace(word("giorni|gg\\.?|days"), " ")
		.replace(/\./g, " ")
		.split(/[\s,;/+-]+/)
		.filter((t) => t !== "");
	const isNumber = (t: string | undefined) => t !== undefined && /^\d{1,3}$/.test(t);
	let i = 0;
	const numbers: number[] = [];
	while (isNumber(tokens[i])) numbers.push(Number(tokens[i++]));
	const tags = new Set<string>();
	while (tokens[i] === "FM" || tokens[i] === "DF") tags.add(tokens[i++] as string);
	const fixedDay = isNumber(tokens[i]) ? Number(tokens[i++]) : undefined;
	if (i < tokens.length) return tokens.includes("FM") && tokens.includes("DF") ? "days mescola d.f. e f.m. su rate diverse: chiedi le rate una alla volta" : wrong;
	if (fixedDay !== undefined && !tags.has("FM")) return tags.has("DF") ? "il giorno fisso nel testo va dopo f.m.; con data fattura usa fixed_day" : wrong;
	if (fixedDay !== undefined && (fixedDay < 1 || fixedDay > 31)) return "il giorno fisso dopo f.m. va da 1 a 31";
	const days = checkedDays(numbers);
	if (days === undefined) return wrong;
	const endOfMonth = tags.has("FM") ? true : tags.has("DF") ? false : undefined;
	return { days, ...(endOfMonth === undefined ? {} : { endOfMonth }), ...(fixedDay === undefined ? {} : { fixedDay }) };
}

/** Whole days in range, at most MAX_INSTALMENTS, increasing and without repeats. */
function checkedDays(list: readonly unknown[]): number[] | undefined {
	if (list.length < 1 || list.length > MAX_INSTALMENTS || !list.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_DUE_DAYS)) return undefined;
	return [...new Set(list as number[])].sort((a, b) => a - b);
}

/** «lunedì 15/03/2027»: the weekday with every date. */
function dayText(date: string): string {
	return `${italianWeekday(date)} ${italianDate(date)}`;
}

const COUNT = new Intl.NumberFormat("it-IT", { useGrouping: true });

/** 2.973: counts with the Italian thousands separator, also with four digits. */
function number(n: number): string {
	return COUNT.format(n);
}

function count(n: number, [one, many]: readonly [string, string]): string {
	return `${number(n)} ${n === 1 ? one : many}`;
}

/** «oggi», «domani», «ieri», «fra 5 giorni», «5 giorni fa». */
function fromToday(date: string, today: string): string {
	const n = daysBetween(today, date);
	if (n === 0) return "oggi";
	if (n === 1) return "domani";
	if (n === -1) return "ieri";
	return n > 0 ? `fra ${count(n, DAYS)}` : `${count(-n, DAYS)} fa`;
}

/** A holiday's name as said: the patron saint with the capoluogo it was asked by. */
type Names = (name: string) => string;

function holidayNames(patrono: Patrono | undefined): Names {
	return (name) => (name === "Santo patrono" && patrono?.city !== undefined ? `Santo patrono di ${patrono.city}` : name);
}

/** What the day is for work: a holiday (named), a weekend day, or a working day. */
function dayKind(date: string, week: WorkingWeek, names: Names): string {
	const holiday = holidayOn(date, week.patrono);
	const weekday = weekdayOf(date);
	if (holiday !== undefined) return `festivo (${names(holiday)})${weekday === 0 ? ", ed è domenica" : ""}`;
	if (weekday === 0) return "domenica, non lavorativo";
	if (weekday === 6) return week.saturdayWorking === true ? "giorno lavorativo (sabato lavorativo)" : "sabato, non lavorativo";
	return "giorno lavorativo";
}

function infoAnswer(date: string, today: string, week: WorkingWeek, names: Names): string {
	const year = Number(date.slice(0, 4));
	const w = isoWeek(date);
	const isoYear = w.year === year ? "" : ` del ${w.year}`;
	const calendar = `Settimana ISO ${w.week}${isoYear}, ${dayOfYear(date)}º giorno dell'anno su ${leapYear(year) ? 366 : 365}.`;
	const head = `${capitalized(dayText(date))} (${fromToday(date, today)})`;
	if (!holidaysKnown(date)) return `${head}. ${calendar}\nFestivo o lavorativo: ${NO_HOLIDAYS}.`;
	return `${head}: ${dayKind(date, week, names)}. ${calendar}`;
}

function betweenAnswer(from: string, to: string, today: string, inclusive: boolean, week: WorkingWeek, names: Names): string {
	if (from === to) return from === today ? `È oggi: ${dayText(today)}.` : `È lo stesso giorno: ${dayText(from)}.`;
	const reversed = to < from;
	const [start, end] = reversed ? [to, from] : [from, to];
	const s = span(start, end, inclusive, week);
	const n = count(s.days, DAYS);
	const parts = [...(s.weeks > 0 ? [`${count(s.weeks, ["settimana", "settimane"])}${s.weekDays > 0 ? ` e ${count(s.weekDays, DAYS)}` : ""}`] : []), ...(s.months > 0 ? [`${count(s.months, ["mese", "mesi"])}${s.monthDays > 0 ? ` e ${count(s.monthDays, DAYS)}` : ""}`] : [])];
	const split = `${parts.length > 0 ? ` (${parts.join("; ")})` : ""}${inclusive ? `; ${count(s.days + 1, DAYS)} contando sia il primo sia l'ultimo` : ""}`;
	let head: string;
	if (from === today && !reversed) head = `Da oggi, ${dayText(from)}, a ${dayText(to)}: ${s.days === 1 ? "manca" : "mancano"} ${n}${split}.`;
	else if ((from === today && reversed) || (to === today && !reversed)) head = `Da ${dayText(start)} a oggi, ${dayText(end)}: ${s.days === 1 ? "è passato" : "sono passati"} ${n}${split}.`;
	else if (reversed) head = `${capitalized(dayText(to))} viene ${n} prima di ${dayText(from)}${split}.`;
	else head = `Da ${dayText(from)} a ${dayText(to)}: ${n}${split}.`;
	const lines = [head];
	if (s.working === undefined) lines.push(`Giorni lavorativi: ${NO_HOLIDAYS}.`);
	else {
		const { count: working, other } = s.working;
		const counted = inclusive ? "primo e ultimo giorno compresi" : "escluso il primo giorno e compreso l'ultimo";
		const otherWay = other === working ? "" : ` (${number(other)} ${inclusive ? "senza" : "contando anche"} il ${italianDate(start)})`;
		lines.push(`Giorni lavorativi: ${number(working)}${otherWay}, ${counted}; ${weekText(week, names)}${takenOff(s.working.holidays, names)}.`);
	}
	if (from !== today && to !== today) lines.push(`Rispetto a oggi, ${italianDate(to)} è ${fromToday(to, today)}.`);
	return lines.join("\n");
}

/** «lunedì–venerdì meno i festivi», with Saturday and the patrono when they count. */
function weekText(week: WorkingWeek, names: Names): string {
	const patrono = week.patrono === undefined ? "" : ` e il ${names("Santo patrono").replace(/^Santo /, "")}`;
	return `${week.saturdayWorking === true ? "lunedì–sabato" : "lunedì–venerdì"} meno i festivi${patrono}`;
}

/** «: tolti 08/12 Immacolata Concezione e 25/12 Natale» for the holidays that fell on an open weekday; beyond three, how many. */
function takenOff(holidays: readonly CountedHoliday[], names: Names): string {
	const off = holidays.filter((h) => h.offWorkday);
	if (off.length === 0) return ", nessun festivo da togliere";
	if (off.length > MAX_NAMED_IN_SPAN) return `, tolti ${number(off.length)} festivi`;
	return `: ${off.length === 1 ? "tolto" : "tolti"} ${joined(off.map((h) => `${italianDate(h.date)} ${names(h.name)}`))}`;
}

function joined(items: readonly string[]): string {
	return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

/** Up to MAX_LISTED holidays, «e altri N» for the rest; semicolons, since names have commas. */
function listed(holidays: readonly Holiday[], names: Names): string {
	const shown = holidays.slice(0, MAX_LISTED).map((h) => `${italianDate(h.date)} ${names(h.name)}`);
	if (holidays.length > MAX_LISTED) return `${shown.join("; ")} e altri ${number(holidays.length - MAX_LISTED)}`;
	return shown.length < 2 ? (shown[0] ?? "") : `${shown.slice(0, -1).join("; ")} e ${shown.at(-1)}`;
}

function addAnswer(date: string, amount: number, unit: Unit, today: string, week: WorkingWeek, names: Names): string {
	const added = addTo(date, amount, unit, week);
	const start = date === today ? `oggi, ${dayText(date)},` : dayText(date);
	const lines = [`${capitalized(start)} ${amount < 0 ? "−" : "+"} ${count(Math.abs(amount), UNIT_WORDS[unit])} = ${dayText(added.date)} (${fromToday(added.date, today)}).`];
	if (added.clamped) {
		const month = MONTH_NAMES[Number(added.date.slice(5, 7)) - 1] as string;
		lines.push(`${capitalized(month)} ${added.date.slice(0, 4)} non ha il giorno ${Number(date.slice(8, 10))}: la data va all'ultimo giorno del mese.`);
	}
	if (unit === "working_days") {
		// The patron saint is named among the skipped days only when it is not already a national holiday.
		const skipped = added.skipped.length === 0 ? "" : ` e i festivi (${listed(added.skipped, names)})`;
		lines.push(`Senza contare il giorno di partenza; saltati ${week.saturdayWorking === true ? "le domeniche" : "sabati e domeniche"}${skipped}.`);
	} else if (holidaysKnown(added.date) && !workingDay(added.date, week)) {
		const holiday = holidayOn(added.date, week.patrono);
		lines.push(`Non è un giorno lavorativo: ${offDayWhy(added.date, holiday === undefined ? undefined : names(holiday))}.`);
	}
	return lines.join("\n");
}

function dueAnswer(invoice: string, days: readonly number[], endOfMonth: boolean, fixedDay: number | undefined, patrono: string | undefined, names: Names): string {
	const dues = dueDates(invoice, days, { endOfMonth, ...(fixedDay === undefined ? {} : { fixedDay }), ...(patrono === undefined ? {} : { patrono }) });
	const how = endOfMonth ? "f.m. (giorni dalla data fattura, poi fine mese" : "d.f. (giorni dalla data fattura";
	const fixed = fixedDay === undefined ? ")" : endOfMonth ? `; poi il giorno ${fixedDay} del mese dopo)` : `; poi il primo giorno ${fixedDay} da lì)`;
	const lines = dues.map((d) => {
		const slip = d.slip === undefined ? "" : ` — ${slipPhrase(d.date, d.slip, { day: dayText, holiday: names })}`;
		return `${dayText(d.date)}${slip}`;
	});
	const head = `Fattura di ${dayText(invoice)}, ${days.join("-")} gg ${how}${fixed}`;
	const body = dues.length === 1 ? `${head}: scadenza ${lines[0]}.` : `${head}:\n${dues.map((d, i) => `• ${d.days} gg: ${lines[i]}`).join("\n")}`;
	const byMonths = dues.some((d) => d.byMonths !== undefined && d.byMonths !== d.date) ? `\nSe il gestionale conta a mesi (30 gg = un mese): ${dues.map((d) => italianDate(d.byMonths ?? d.date)).join(", ")}.` : "";
	return `${body}${byMonths}`;
}

function workingAnswer(label: string, from: string, to: string, week: WorkingWeek, names: Names): string {
	const c = workingDaysIn(from, to, week);
	const head = `${capitalized(label)}: ${count(c.working, ["giorno lavorativo", "giorni lavorativi"])} su ${number(c.total)} (${weekText(week, names)}).`;
	if (c.holidays.length === 0) return `${head} Nessun festivo.`;
	const shown = c.holidays.slice(0, MAX_LISTED).map((h) => `${dayText(h.date)} ${names(h.name)}${h.offWorkday ? "" : " (già non lavorativo)"}`);
	const more = c.holidays.length > MAX_LISTED ? ` e altri ${number(c.holidays.length - MAX_LISTED)}` : "";
	return `${head}\nFestivi: ${shown.join("; ")}${more}.`;
}

function holidaysAnswer(year: number, patrono: Patrono | undefined, names: Names): string {
	if (year < HOLIDAYS_SINCE) throw new DateError(NO_HOLIDAYS);
	const days = italianHolidays(year, patrono?.day);
	const note = (h: Holiday) => (h.date.endsWith("-10-04") && h.name.startsWith("San Francesco") && SAN_FRANCESCO_NEWS.has(year) ? " (di nuovo festivo dal 2026, legge 151/2025)" : "");
	const withPatrono = patrono === undefined ? "" : patrono.city === undefined ? " con il patrono" : ` con il patrono di ${patrono.city}`;
	const missing = patrono !== undefined && !realDate(`${year}-${patrono.day}`) ? `\nIl patrono (29/02) nel ${year} non cade: non è un anno bisestile.` : "";
	return `Festività nazionali del ${year}${withPatrono} (${days.length}):\n${days.map((h) => `• ${dayText(h.date)} ${names(h.name)}${note(h)}`).join("\n")}${missing}`;
}

function ageAnswer(birth: string, on: string, today: string): string {
	if (birth > on && on !== today) throw new DateError("la data di riferimento viene prima della data di nascita");
	if (birth === on) return on === today ? `È nato oggi, ${dayText(birth)}: il primo compleanno sarà ${dayText(addMonths(birth, 12).date)}.` : `Il ${italianDate(on)} è il giorno della nascita.`;
	const age = ageOn(birth, on);
	const when = on === today ? "" : ` il ${italianDate(on)}`;
	const lines: string[] = [];
	if (age.daysToNext === 0) lines.push(`Chi è nato ${dayText(birth)} compie ${count(age.years, ["anno", "anni"])}${when === "" ? " oggi" : when}.`);
	else {
		const verb = on === today ? "ha" : on > today ? "avrà" : "aveva";
		lines.push(`Chi è nato ${dayText(birth)} ${verb} ${count(age.years, ["anno", "anni"])}${when}. Il prossimo compleanno (${number(age.years + 1)}) è ${dayText(age.next)}, ${on === today ? fromToday(age.next, today) : `${count(age.daysToNext, DAYS)} dopo`}.`);
	}
	if (age.leapling) lines.push("Nato il 29 febbraio: negli anni non bisestili qui il compleanno si conta il 28 febbraio.");
	return lines.join(" ");
}
