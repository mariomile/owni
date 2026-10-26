import { type Static, Type } from "@earendil-works/pi-ai";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { checkDate, type DayRates, type ExchangeRates, ExchangeRateError, FIRST_RATES_DATE, type RatesOn, type RatesSeries } from "../exchange-rates.ts";
import { addDays } from "../italian-calendar.ts";
import { capitalized, formatResult, italianDate, italianMoney, italianWeekday, MAX_MONEY } from "../italian-format.ts";

export type ExchangeToolsOptions = { readonly rates: ExchangeRates };

/** Amounts above this are not an invoice: a typo, refused rather than converted. */
const MAX_AMOUNT = 1e9;
const MAX_AMOUNTS = 20;

/** The ECB's currencies, past ones included, in Italian with their article. */
const NAMES: Readonly<Record<string, string>> = {
	EUR: "l'euro",
	USD: "il dollaro USA",
	JPY: "lo yen giapponese",
	CZK: "la corona ceca",
	DKK: "la corona danese",
	HUF: "il fiorino ungherese",
	PLN: "lo zloty polacco",
	RON: "il leu romeno",
	SEK: "la corona svedese",
	CHF: "il franco svizzero",
	ISK: "la corona islandese",
	NOK: "la corona norvegese",
	TRY: "la lira turca",
	AUD: "il dollaro australiano",
	BRL: "il real brasiliano",
	CAD: "il dollaro canadese",
	CNY: "lo yuan cinese",
	HKD: "il dollaro di Hong Kong",
	IDR: "la rupia indonesiana",
	ILS: "lo shekel israeliano",
	INR: "la rupia indiana",
	KRW: "il won sudcoreano",
	MXN: "il peso messicano",
	MYR: "il ringgit malese",
	NZD: "il dollaro neozelandese",
	PHP: "il peso filippino",
	SGD: "il dollaro di Singapore",
	THB: "il baht thailandese",
	ZAR: "il rand sudafricano",
	GBP: "la sterlina britannica",
	BGN: "il lev bulgaro",
	HRK: "la kuna croata",
	RUB: "il rublo russo",
};

/**
 * Euro-area currencies replaced by the euro at a fixed, irrevocable rate (Council Regulations):
 * units for one euro, and the day the euro took over.
 */
const LEGACY: Readonly<Record<string, { readonly perEuro: number; readonly since: string }>> = {
	ITL: { perEuro: 1936.27, since: "1999-01-01" },
	DEM: { perEuro: 1.95583, since: "1999-01-01" },
	FRF: { perEuro: 6.55957, since: "1999-01-01" },
	ESP: { perEuro: 166.386, since: "1999-01-01" },
	HRK: { perEuro: 7.5345, since: "2023-01-01" },
	BGN: { perEuro: 1.95583, since: "2026-01-01" },
};
/** Currencies written without decimals (ISO 4217 minor unit 0, and the forint as it is used): amounts to the unit. */
const NO_DECIMALS = new Set(["JPY", "KRW", "ISK", "HUF", "ITL", "ESP"]);
const LEGACY_NAMES: Readonly<Record<string, string>> = { ITL: "la lira italiana", DEM: "il marco tedesco", FRF: "il franco francese", ESP: "la peseta spagnola" };

/** Crypto-assets people ask about: not currencies, and the ECB publishes none. */
const CRYPTO = new Set(["BTC", "ETH", "USDT", "USDC", "XRP", "SOL", "BNB", "DOGE", "ADA", "LTC", "DOT", "TRX", "XMR", "DAI"]);
/** The rouble's last reference rate; the ECB suspended it the day after. */
const RUB_LAST = "2022-03-01";

const exchangeRateParameters = Type.Object(
	{
		from: Type.Optional(Type.String({ pattern: "^[A-Za-z]{3,5}$", description: "The currency of the amount, an ISO 4217 code: USD, GBP, CHF, JPY…" })),
		to: Type.Optional(Type.String({ pattern: "^[A-Za-z]{3,5}$", description: "The currency to convert to, an ISO 4217 code (EUR if not given)" })),
		amount: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_AMOUNT, description: "One amount in from to convert; without it, only the rate" })),
		amounts: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: MAX_AMOUNT }), { minItems: 1, maxItems: MAX_AMOUNTS, description: "Several amounts in from, converted at the same rate, with their total" })),
		date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `The day of the rate, YYYY-MM-DD, e.g. the invoice date: not in the future, not before ${FIRST_RATES_DATE} (today if not given)` })),
		since: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Start of a trend, YYYY-MM-DD, at most a year back: the rate at the start and the end, the lowest and highest, the change" })),
		list: Type.Optional(Type.Boolean({ description: "true for the currencies the ECB publishes that day, with their Italian names" })),
	},
	{ additionalProperties: false },
);
type ExchangeRateArgs = Static<typeof exchangeRateParameters>;

/**
 * Exchange rates and conversions with the ECB's reference rates. The numbers come from outside
 * but are validated numbers, and the answer echoes no provider text: no fence is needed.
 */
export function createExchangeTools(options: ExchangeToolsOptions): OwniTool[] {
	return [
		defineOwniTool({
			name: "exchange_rate",
			description:
				"Official exchange rates of the European Central Bank (euro foreign exchange reference rates, 29 currencies, published on working days around 16:00 CET), and conversions with them. " +
				"Use it whenever money in another currency appears or a rate is asked, rather than guessing a rate or giving one from memory. " +
				"Codes: yen JPY, franco svizzero CHF, lira turca TRY, sterlina GBP; «dollaro» is USD unless the context says otherwise; ask when a name is ambiguous (corona: SEK, NOK, DKK, CZK or ISK; rupia: INR or IDR). Old euro-area currencies (lira ITL, marco DEM…) convert at their fixed rate. " +
				"amount is a JSON number with a dot for decimals; Italian amounts use the dot for thousands and the comma for decimals: «1.250» is 1250, «1.250,50» is 1250.50, «1,2 milioni» is 1200000, «10k» is 10000. Several amounts at the same rate go in amounts, which also gives the total. " +
				"For an invoice or a payment pass the invoice or operation date; on a day without rates the last working day before applies, and the tool says so. A date without a year is its latest occurrence not in the future; if unsure, ask. Without date it is the latest published. " +
				"since gives the trend from that day (at most a year back) to date or today; list gives the currencies of the day. " +
				"For VAT, discounts or totals pass code_run the converted amount the tool gave (already rounded to the cent), not amount × rate; use document_create for a quote in another currency. " +
				"Say once per conversation, or when the person talks about paying or a bank, that banks and cards apply their own rate.",
			parameters: exchangeRateParameters,
			replaySafe: true,
			async execute(args, ctx) {
				const request = requestOf(args);
				if (typeof request === "string") return `Errore: ${request}.`;
				return ctx.step("rates", async () => {
					try {
						return await answer(options.rates, request);
					} catch (error) {
						return `Errore: ${error instanceof ExchangeRateError ? error.message : "i cambi della BCE non sono disponibili"}.`;
					}
				});
			},
		}),
	];
}

type Request =
	| { readonly kind: "list"; readonly date?: string }
	| { readonly kind: "trend"; readonly from: string; readonly to: string; readonly since: string; readonly date?: string }
	| { readonly kind: "convert"; readonly from: string; readonly to: string; readonly amounts?: readonly number[]; readonly date?: string };

/** The arguments checked, or what is wrong with them. */
function requestOf(args: ExchangeRateArgs): Request | string {
	for (const name of ["date", "since"] as const) {
		if (args[name] !== undefined && typeof args[name] !== "string") return `${name} è una data scritta come AAAA-MM-GG`;
	}
	if (args.list !== undefined && typeof args.list !== "boolean") return "list è true o false";
	const dated = args.date === undefined ? {} : { date: args.date };
	if (args.list === true) return { kind: "list", ...dated };
	if (args.from === undefined) return "manca from, la valuta di partenza (o list per l'elenco delle valute)";
	const from = currencyCode(args.from);
	const to = args.to === undefined ? "EUR" : currencyCode(args.to);
	if (from === undefined || to === undefined) return "le valute vanno scritte con il codice di tre lettere (USD, GBP, CHF…)";
	const crypto = [from, to].find((code) => CRYPTO.has(code));
	if (crypto !== undefined) return `${crypto} non è una valuta: la BCE non ne pubblica il cambio (per le criptovalute usa web_search, se ce l'hai)`;
	if (from.length !== 3 || to.length !== 3) return "le valute vanno scritte con il codice di tre lettere (USD, GBP, CHF…)";
	if (from === to) return `${from} e ${to} sono la stessa valuta`;
	if (args.amount !== undefined && args.amounts !== undefined) return "usa amount per un importo, amounts per più importi, non tutti e due";
	const amounts = args.amounts ?? (args.amount === undefined ? undefined : [args.amount]);
	if (amounts !== undefined && (amounts.length < 1 || amounts.length > MAX_AMOUNTS || !amounts.every(validAmount))) {
		return `gli importi sono numeri da 0 a un miliardo, al più ${MAX_AMOUNTS}`;
	}
	if (args.since !== undefined) return amounts === undefined ? { kind: "trend", from, to, since: args.since, ...dated } : "since dà l'andamento del cambio: senza importi";
	return { kind: "convert", from, to, ...(amounts === undefined ? {} : { amounts }), ...dated };
}

function validAmount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
}

function currencyCode(value: string): string | undefined {
	return /^[A-Za-z]{3,5}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined;
}

async function answer(rates: ExchangeRates, request: Request): Promise<string> {
	if (request.kind === "list") return listAnswer((await rates.rateOn(request.date)).day);
	if (request.kind === "trend") return trendAnswer(await rates.series(request.since, request.date), request.from, request.to);
	const asked = request.date ?? rates.today();
	// Between the euro and its old currencies the rate is fixed: nothing to download.
	if ([request.from, request.to].every((code) => code === "EUR" || legacyOn(code, asked) !== undefined)) {
		checkDate(asked, rates.today());
		return convertAnswer(undefined, request.from, request.to, request.amounts, asked);
	}
	return convertAnswer(await rates.rateOn(request.date), request.from, request.to, request.amounts, asked);
}

/** A fixed rate when `code` had been replaced by the euro on `date`. */
function legacyOn(code: string, date: string): number | undefined {
	const legacy = LEGACY[code];
	return legacy !== undefined && date >= legacy.since ? legacy.perEuro : undefined;
}

type Leg = { readonly code: string; readonly perEuro: number; readonly fixed: boolean };

/** The conversions, each on a line, a total for several, then the rate in one line with why that day. */
function convertAnswer(found: RatesOn | undefined, from: string, to: string, amounts: readonly number[] | undefined, asked: string): string {
	const legs: Leg[] = [];
	const missing: string[] = [];
	for (const code of [from, to].filter((c) => c !== "EUR")) {
		const fixed = legacyOn(code, asked);
		const published = found?.day.rates.get(code);
		if (fixed !== undefined) legs.push({ code, perEuro: fixed, fixed: true });
		else if (published !== undefined) legs.push({ code, perEuro: published, fixed: false });
		else missing.push(code);
	}
	if (missing.length > 0) return `Errore: ${missing.map((code) => unpublished(code, found?.day.date ?? asked)).join(" ")}`;
	const perEuro = (code: string) => (code === "EUR" ? 1 : (legs.find((l) => l.code === code) as Leg).perEuro);
	const rate = perEuro(to) / perEuro(from);
	const conversions = amounts === undefined ? [] : conversionLines(amounts, from, to, rate);
	if (typeof conversions === "string") return conversions;
	const reason = found?.fallback === undefined ? "" : ` ${reasonText(found)}`;
	return [...conversions, `${rateLine(legs, from, to, rate, found?.day.date)}${reason}`].join("\n");
}

/** «1.250,00 USD = 1.073,70 EUR» for each amount; for several, the total of what is shown. */
function conversionLines(amounts: readonly number[], from: string, to: string, rate: number): string[] | string {
	const converted = amounts.map((amount) => rounded(amount * rate, to));
	const total = rounded(converted.reduce((sum, value) => sum + value, 0), to);
	if (converted.some((value) => value >= MAX_MONEY) || total >= MAX_MONEY) return "Errore: il risultato è troppo grande per scriverlo al centesimo.";
	const lines = amounts.map((amount, i) => `${amountText(amount, from)} ${from} = ${italianMoney(converted[i] as number, decimalsOf(to))} ${to}`);
	if (amounts.length === 1) return lines;
	// Amounts given to the cent add up to the cent, without 0,1 + 0,2 showing as 0,30000000000000004.
	const sum = amounts.reduce((s, a) => s + a, 0);
	return [...lines, `Totale: ${amountText(amounts.every((a) => rounded(a, from) === a) ? rounded(sum, from) : sum, from)} ${from} = ${italianMoney(total, decimalsOf(to))} ${to}`];
}

function decimalsOf(code: string): number {
	return NO_DECIMALS.has(code) ? 0 : 2;
}

/** To the cent, or to the unit for a currency without decimals. */
function rounded(value: number, code: string): number {
	const scale = 10 ** decimalsOf(code);
	return Math.round(value * scale) / scale;
}

/** The amount as given: to the cent (the unit), or with its own decimals when it has more. */
function amountText(amount: number, code: string): string {
	return rounded(amount, code) === amount ? italianMoney(amount, decimalsOf(code)) : formatResult(amount);
}

/**
 * The ECB's own figure first (1 EUR = x, as published, without padded zeros), the other way in
 * parentheses; a fixed rate is named as such, and between two other currencies the rate through the euro follows.
 */
function rateLine(legs: readonly Leg[], from: string, to: string, rate: number, date: string | undefined): string {
	const published = legs.filter((l) => !l.fixed).map((l) => `1 EUR = ${formatResult(l.perEuro)} ${l.code}`);
	const fixed = legs.filter((l) => l.fixed).map((l) => `1 EUR = ${formatResult(l.perEuro)} ${l.code}`);
	const parts = [
		...(published.length === 0 ? [] : [`Cambio BCE del ${italianDate(date as string)}: ${published.join(" e ")}`]),
		...(fixed.length === 0 ? [] : [`cambio fisso irrevocabile: ${fixed.join(" e ")}`]),
	];
	const head = parts.join("; ");
	const capital = capitalized(head);
	const [only] = legs;
	if (legs.length === 1 && only !== undefined) return `${capital} (1 ${only.code} = ${rateText(1 / only.perEuro)} EUR).`;
	return `${capital}; quindi 1 ${from} = ${rateText(rate)} ${to} (1 ${to} = ${rateText(1 / rate)} ${from}).`;
}

/** A worked-out rate: 4 decimals, or 4 significant digits below 1 (1 JPY = 0,006160 EUR). */
function rateText(rate: number): string {
	return new Intl.NumberFormat("it-IT", rate < 1 ? { minimumSignificantDigits: 4, maximumSignificantDigits: 4, useGrouping: true } : { minimumFractionDigits: 4, maximumFractionDigits: 4, useGrouping: true }).format(rate);
}

/** Why the rate is of another day, in a short sentence. */
function reasonText(found: RatesOn): string {
	const { asked, today, day, fallback } = found;
	const used = `quello di ${italianWeekday(day.date)} ${italianDate(day.date)}`;
	const sinceToday = day.date === addDays(today, -1) ? "il cambio di ieri" : used;
	switch (fallback) {
		case "weekend":
			return asked === today ? `Oggi è ${italianWeekday(asked)} e la BCE non pubblica: vale ${used}.` : `${capitalized(italianWeekday(asked))} ${italianDate(asked)} la BCE non pubblica: vale ${used}.`;
		case "holiday":
			return asked === today ? `Oggi è festivo per la BCE: vale ${used}.` : `Il ${italianDate(asked)} era festivo per la BCE: vale ${used}.`;
		case "not_yet":
			return `Oggi la BCE pubblica verso le 16: vale ${sinceToday}.`;
		case "late":
			return `Oggi alle 16 la BCE non ha ancora pubblicato: vale ${sinceToday}.`;
		case "not_published":
			return `Oggi la BCE non ha pubblicato cambi: vale ${sinceToday}.`;
		default:
			return `Il ${italianDate(asked)} la BCE non ha pubblicato cambi: vale ${used}.`;
	}
}

/** Why there is no rate for `code`: the rouble's suspension, an old euro-area currency before its fixed rate, or not among the ECB's currencies. */
function unpublished(code: string, date: string): string {
	if (code === "RUB" && date > RUB_LAST) return `la BCE ha sospeso il cambio del rublo dal 02/03/2022 (ultimo: ${italianDate(RUB_LAST)}).`;
	const legacy = LEGACY[code];
	if (legacy !== undefined) return `la BCE non ha un cambio per ${code} il ${italianDate(date)}; dal ${italianDate(legacy.since)} vale il cambio fisso irrevocabile 1 EUR = ${formatResult(legacy.perEuro)} ${code}.`;
	return `${code} non è tra le valute della BCE del ${italianDate(date)}: per vederle chiama exchange_rate con list.`;
}

/** «USD dollaro USA, JPY yen giapponese, …» for the day, the euro aside. */
function listAnswer(day: DayRates): string {
	const codes = [...day.rates.keys()].sort();
	const named = codes.map((code) => (NAMES[code] === undefined ? code : `${code} ${withoutArticle(NAMES[code])}`));
	return `Valute della BCE del ${italianDate(day.date)} (${codes.length}, contro l'euro): ${named.join(", ")}.`;
}

/** Start, end, lowest and highest of 1 `from` in `to`, and the change, said as one currency gaining on the other. */
function trendAnswer(series: RatesSeries, from: string, to: string): string {
	if (series.days.length < 2) return "Errore: tra le due date la BCE non ha pubblicato nuovi cambi.";
	for (const day of [series.days[0], series.days.at(-1)]) {
		const code = [from, to].find((c) => day === undefined || perEuroOn(day, c) === undefined);
		if (code !== undefined) return `Errore: ${unpublished(code, day?.date ?? series.until)}`;
	}
	const points = series.days.flatMap((day) => {
		const fromRate = perEuroOn(day, from);
		const toRate = perEuroOn(day, to);
		return fromRate === undefined || toRate === undefined ? [] : [{ date: day.date, rate: toRate / fromRate }];
	});
	const first = points[0] as { date: string; rate: number };
	const last = points.at(-1) as { date: string; rate: number };
	const low = points.reduce((a, b) => (b.rate < a.rate ? b : a));
	const high = points.reduce((a, b) => (b.rate > a.rate ? b : a));
	const change = (last.rate / first.rate - 1) * 100;
	return [
		`Andamento BCE di 1 ${from} in ${to} dal ${italianDate(first.date)} al ${italianDate(last.date)}: all'inizio ${rateText(first.rate)}, alla fine ${rateText(last.rate)}; minimo ${rateText(low.rate)} il ${italianDate(low.date)}, massimo ${rateText(high.rate)} il ${italianDate(high.date)}.`,
		changeText(from, to, change),
	].join("\n");
}

/** Units of `code` for one euro that day: published, or fixed once the euro replaced it. */
function perEuroOn(day: DayRates, code: string): number | undefined {
	return code === "EUR" ? 1 : (legacyOn(code, day.date) ?? day.rates.get(code));
}

/** «Il dollaro USA si è rafforzato rispetto all'euro del 3,2%», with the article and the agreement each name needs. */
function changeText(from: string, to: string, change: number): string {
	const subject = NAMES[from] ?? LEGACY_NAMES[from] ?? from;
	const feminine = subject.startsWith("la ");
	const percent = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2 }).format(Math.abs(change));
	const against = `rispetto ${toThe(NAMES[to] ?? LEGACY_NAMES[to] ?? to)}`;
	if (percent === "0") return `${capitalized(subject)} è ${feminine ? "rimasta invariata" : "rimasto invariato"} ${against}.`;
	const verb = change > 0 ? (feminine ? "rafforzata" : "rafforzato") : feminine ? "indebolita" : "indebolito";
	return `${capitalized(subject)} si è ${verb} ${against} ${of(percent)}%.`;
}

/** «a» joined to the name's article: «all'euro», «al dollaro», «allo yen», «alla sterlina». */
function toThe(name: string): string {
	if (name.startsWith("l'")) return `all'${name.slice(2)}`;
	const ending = { il: "", lo: "lo", la: "la" }[name.split(" ")[0] ?? ""];
	return ending === undefined ? `a ${name}` : `al${ending} ${withoutArticle(name)}`;
}

/** «dello 0,5», «dell'1,5», «dell'8», «dell'11», «del 3,2». */
function of(percent: string): string {
	const whole = percent.split(",")[0] ?? "";
	if (whole === "0") return `dello ${percent}`;
	return whole === "1" || whole === "11" || whole.startsWith("8") ? `dell'${percent}` : `del ${percent}`;
}

function withoutArticle(name: string): string {
	return name.replace(/^(il |lo |la |l')/, "");
}
