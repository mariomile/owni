/**
 * The European Commission's VIES: whether a VAT number is active for intra-EU operations, with
 * the registered name and address when the member state gives them. Free and without a key; only
 * the country and the number leave the server, to the Commission. VIES rate-limits, and member
 * states' services go down at night: errors are named, never turned into an answer.
 */
import { INVISIBLE } from "./html-text.ts";
import { getJson, type HttpProblem, plain, type RedirectRule } from "./http.ts";
import { EU_VAT_COUNTRIES, type EuVatCountry, euVatProblem } from "./tax-ids.ts";
import { dailyCounter } from "./web-search.ts";

export type ViesConfig = {
	/** The REST API's base, e.g. https://ec.europa.eu/taxation_customs/vies/rest-api. */
	readonly url: string;
	/** Requests to the VIES a tenant may make in a day, all its instances together (cached answers are free). */
	readonly maxPerDay: number;
	/** Requests to the VIES the whole server may make in a day, every tenant together: the VIES blocks an address that asks too much. */
	readonly maxPerDayServer: number;
};

/** The server's requests a day unless the operator says otherwise: ten accounts at their default. */
export const DEFAULT_MAX_PER_DAY_SERVER = 2000;

export const DEFAULT_VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";

/**
 * The check of one number: GET {base}/ms/{country}/vat/{number}, the REST API's public endpoint
 * (the same API also takes a POST to /check-vat-number). It could not be reached where this was
 * written: verify with pnpm owni check.
 */
export function viesCheckUrl(base: string, country: EuVatCountry, number: string): URL {
	return new URL(`${base.replace(/\/+$/, "")}/ms/${country}/vat/${encodeURIComponent(number)}`);
}

export type ViesAnswer = {
	/** Active in the VIES: registered for intra-EU operations. false is not «does not exist». */
	readonly valid: boolean;
	readonly country: EuVatCountry;
	readonly number: string;
	/** As the member state gives them; never for a number that is not valid. Untrusted text. */
	readonly name?: string;
	readonly address?: string;
	/** When the VIES answered, in milliseconds: the date that proves the check. */
	readonly checkedAt: number;
};

/** The VIES's own errors, and ours: the network, an answer we cannot read, the day's quota. */
type ViesErrorCode =
	| "INVALID_INPUT"
	| "MS_UNAVAILABLE"
	| "MS_MAX_CONCURRENT_REQ"
	| "GLOBAL_MAX_CONCURRENT_REQ"
	| "TIMEOUT"
	| "SERVICE_UNAVAILABLE"
	| "BLOCKED"
	| "OTHER"
	| "UNREACHABLE"
	| "UNREADABLE"
	| "DAILY_LIMIT";

/** Errors that pass by themselves: a member state down, a busy or unavailable VIES. Worth trying again in a few minutes. */
const TEMPORARY: ReadonlySet<ViesErrorCode> = new Set(["MS_UNAVAILABLE", "MS_MAX_CONCURRENT_REQ", "GLOBAL_MAX_CONCURRENT_REQ", "TIMEOUT", "SERVICE_UNAVAILABLE"]);

/** Why there is no answer, in Italian; never the address. */
export class ViesError extends Error {
	constructor(
		readonly code: ViesErrorCode,
		message: string,
	) {
		super(message);
	}

	/** It may pass by itself: try again in a few minutes. */
	get temporary(): boolean {
		return TEMPORARY.has(this.code);
	}
}

export type Vies = {
	/**
	 * The VIES's answer for `tenant`, for a number already checked on paper (tax-ids.ts, checked
	 * again here). `allow` (the tenant's daily quota) is asked only when a request would leave,
	 * and counts it: a cached answer costs nothing.
	 */
	check(tenant: string, country: EuVatCountry, number: string, allow: () => boolean): Promise<ViesAnswer>;
};

export type ViesOptions = {
	/** The whole exchange: 10 seconds. */
	readonly timeoutMs?: number;
};

const MINUTE = 60_000;
/** An answer is a few hundred bytes: past this it is not the VIES. */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
/** An answer, valid or not, is kept an hour: registrations do not change by the minute. */
const ANSWER_TTL_MS = 60 * MINUTE;
/** A member state down, a busy VIES or a failed request: two minutes, then asked again. */
const FAILURE_TTL_MS = 2 * MINUTE;
/** Numbers kept at most, every tenant together: past this the oldest goes. */
const MAX_CACHED = 2000;
const NAME_CHARS = 200;
const ADDRESS_CHARS = 300;
/** A requestDate further than this from our clock is not trusted: ours is used. */
const MAX_SKEW_MS = 24 * 60 * MINUTE;
/** The VIES answers where it is asked: a redirect is refused, never followed. */
const NO_REDIRECTS: RedirectRule = { max: 0, allowed: async () => false };

type Entry = { readonly at: number; readonly result: Promise<ViesAnswer>; ttl: number };

/**
 * The VIES REST API at `config.url`, each tenant's answer for a number kept an hour (a failure two
 * minutes): a tenant never sees when another one checked. At most `maxPerDayServer` requests a day
 * leave the server, whatever each tenant's own quota.
 */
export function viesClient(config: Pick<ViesConfig, "url"> & Partial<Pick<ViesConfig, "maxPerDayServer">>, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date(), options: ViesOptions = {}): Vies {
	const cache = new Map<string, Entry>();
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	const server = dailyCounter(config.maxPerDayServer ?? DEFAULT_MAX_PER_DAY_SERVER, now);
	return {
		check(tenant, country, number, allow) {
			// Only well-formed numbers leave, whoever calls.
			if (euVatProblem(country, number) !== undefined) return Promise.reject(new ViesError("INVALID_INPUT", `il numero non ha la forma di un numero IVA ${EU_VAT_COUNTRIES[country].of}`));
			const key = `${tenant}:${country}${number}`;
			const at = now().getTime();
			const hit = cache.get(key);
			if (hit !== undefined && at - hit.at < hit.ttl) return hit.result;
			// Not cached: the quotas are asked before anything leaves, the server's spent only if the tenant's allows; a refusal is not kept.
			if (server.left("") < 1) return Promise.reject(new ViesError("DAILY_LIMIT", "per oggi i controlli nel VIES di questo server sono finiti"));
			if (!allow()) return Promise.reject(new ViesError("DAILY_LIMIT", "per oggi i controlli nel VIES di questo account sono finiti"));
			server.spend("", 1);
			const entry: Entry = { at, ttl: ANSWER_TTL_MS, result: ask(config.url, country, number, { fetchImpl, timeoutMs, now }) };
			entry.result.catch((error: unknown) => {
				// A malformed number stays malformed; anything else may pass.
				entry.ttl = error instanceof ViesError && error.code === "INVALID_INPUT" ? ANSWER_TTL_MS : FAILURE_TTL_MS;
			});
			cache.delete(key);
			if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
			cache.set(key, entry);
			return entry.result;
		},
	};
}

type Asking = { readonly fetchImpl: typeof fetch; readonly timeoutMs: number; readonly now: () => Date };

async function ask(base: string, country: EuVatCountry, number: string, { fetchImpl, timeoutMs, now }: Asking): Promise<ViesAnswer> {
	const body = await getJson(viesCheckUrl(base, country, number), { fetch: fetchImpl, maxBytes: MAX_BYTES, timeoutMs, redirect: NO_REDIRECTS }, httpError);
	return answerOf(body as Record<string, unknown>, country, number, now().getTime());
}

/**
 * The answer read defensively: an error code wins over any flag; then `valid` (POST) or
 * `isValid` (GET), which must be a boolean and agree with a VALID or INVALID userError. Nothing
 * else counts as an answer: validity is never guessed.
 */
export function answerOf(body: Record<string, unknown>, country: EuVatCountry, number: string, at: number): ViesAnswer {
	const code = errorCodeOf(body);
	if (code !== undefined && code !== "VALID" && code !== "INVALID") throw viesError(code, country);
	const valid = typeof body.valid === "boolean" ? body.valid : typeof body.isValid === "boolean" ? body.isValid : undefined;
	if (valid === undefined || (code === "VALID" && !valid) || (code === "INVALID" && valid)) throw new ViesError("UNREADABLE", "il VIES ha risposto in modo illeggibile");
	const name = valid ? field(body.name ?? body.traderName, NAME_CHARS) : undefined;
	const address = valid ? field(body.address ?? body.traderAddress, ADDRESS_CHARS) : undefined;
	return { valid, country, number, ...(name === undefined ? {} : { name }), ...(address === undefined ? {} : { address }), checkedAt: checkedAt(body.requestDate, at) };
}

/** userError (GET), or the first errorWrappers' error (POST); only a code-shaped string. */
function errorCodeOf(body: Record<string, unknown>): string | undefined {
	const wrappers = body.errorWrappers;
	const wrapped = Array.isArray(wrappers) && typeof wrappers[0] === "object" && wrappers[0] !== null ? (wrappers[0] as Record<string, unknown>).error : undefined;
	const code = typeof body.userError === "string" && body.userError !== "" ? body.userError : wrapped;
	return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : undefined;
}

/** Each error the VIES documents, in Italian, with what to do. */
function viesError(code: string, country: EuVatCountry): ViesError {
	const state = EU_VAT_COUNTRIES[country].of;
	switch (code) {
		case "INVALID_INPUT":
			// Only numbers written right are sent: the member state checks more than the shape tax-ids.ts knows.
			return new ViesError("INVALID_INPUT", "il VIES rifiuta questo numero (il suo Stato membro ha regole più strette)");
		case "MS_UNAVAILABLE":
			return new ViesError("MS_UNAVAILABLE", `il servizio ${state} non risponde al VIES in questo momento (succede spesso di notte e nei fine settimana)`);
		case "MS_MAX_CONCURRENT_REQ":
		case "MS_MAX_CONCURRENT_REQ_TIME":
			return new ViesError("MS_MAX_CONCURRENT_REQ", `il servizio ${state} ha troppe richieste in questo momento`);
		case "GLOBAL_MAX_CONCURRENT_REQ":
		case "GLOBAL_MAX_CONCURRENT_REQ_TIME":
			return new ViesError("GLOBAL_MAX_CONCURRENT_REQ", "il VIES ha troppe richieste in questo momento");
		case "TIMEOUT":
			return new ViesError("TIMEOUT", `il servizio ${state} non ha risposto in tempo al VIES`);
		case "SERVICE_UNAVAILABLE":
			return new ViesError("SERVICE_UNAVAILABLE", "il VIES non è disponibile in questo momento");
		case "VAT_BLOCKED":
		case "IP_BLOCKED":
			return new ViesError("BLOCKED", "il VIES rifiuta per ora le richieste di questo server: riprova più tardi");
		default:
			// The code is not echoed: it is the service's text, and an unknown one tells the person nothing.
			return new ViesError("OTHER", "il VIES ha risposto con un errore che Owni non conosce");
	}
}

function httpError(problem: HttpProblem): ViesError {
	if (problem.kind === "status") {
		if (problem.status === 429) return new ViesError("GLOBAL_MAX_CONCURRENT_REQ", "il VIES ha troppe richieste in questo momento");
		if (problem.status >= 500) return new ViesError("SERVICE_UNAVAILABLE", "il VIES non è disponibile in questo momento");
		return new ViesError("OTHER", `il VIES risponde ${problem.status}`);
	}
	if (problem.kind === "unreachable") return new ViesError("UNREACHABLE", "il VIES non risponde");
	return new ViesError("UNREADABLE", { too_big: "il VIES ha mandato una risposta troppo grande", unreadable: "il VIES ha risposto in modo illeggibile", redirect: "il VIES rimanda a un altro indirizzo" }[problem.kind]);
}

/** A name or an address as plain text on one line; «---» (what VIES sends for «not given») is none. */
function field(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value
		.split(/\r?\n/)
		.map((line) => plain(line.replace(INVISIBLE, " ")))
		.filter((line) => line !== "")
		.join(", ");
	if (text === "" || /^-+$/.test(text)) return undefined;
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The VIES's requestDate when it has a time, parses and is near our clock; else our clock. */
function checkedAt(value: unknown, at: number): number {
	// A day alone («2026-10-17+02:00») has no time to show: ours is closer.
	const parsed = typeof value === "string" && /T\d{2}:\d{2}/.test(value) ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) && Math.abs(parsed - at) <= MAX_SKEW_MS ? parsed : at;
}
