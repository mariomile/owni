/**
 * Weather for instances: Open-Meteo (servers in Europe and North America) finds a place by
 * name, then gives its conditions now, the next hours and a forecast day by day. Free only for
 * private, non-commercial use; a business needs a plan and its key. Only the place name and its
 * coordinates leave the server.
 */
import { getJson, type HttpProblem, plain } from "./http.ts";

export type WeatherConfig = {
	/** The forecast endpoint, e.g. https://api.open-meteo.com/v1/forecast. */
	readonly forecastUrl: string;
	/** The geocoding endpoint, e.g. https://geocoding-api.open-meteo.com/v1/search. */
	readonly geocodingUrl: string;
	/** A paid plan's key: sent as the apikey parameter. */
	readonly apiKey?: string;
	/** Weather tool calls a tenant may make in a day, all its instances together. */
	readonly maxPerDay: number;
};

export const DEFAULT_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const DEFAULT_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
/** A paid plan's forecast host, with the key as apikey. */
export const PAID_FORECAST_URL = "https://customer-api.open-meteo.com/v1/forecast";
/** The longest forecast Open-Meteo gives, in days, today included. */
export const MAX_FORECAST_DAYS = 16;
/** Hours of hourly forecast, from now: enough for tonight and tomorrow. */
const FORECAST_HOURS = 48;

export type Place = {
	readonly name: string;
	/** The region, e.g. Lazio, Texas. */
	readonly admin1?: string;
	/** The province or county, e.g. Roma. */
	readonly admin2?: string;
	readonly country?: string;
	/** Two capital letters, e.g. IT. */
	readonly countryCode?: string;
	readonly latitude: number;
	readonly longitude: number;
	/** An IANA zone, e.g. Europe/Rome. */
	readonly timezone?: string;
	/** 0 when the service does not say. */
	readonly population: number;
};

export type CurrentWeather = {
	/** Local time at the place, YYYY-MM-DDTHH:MM. */
	readonly time: string;
	readonly code?: number;
	readonly temperature?: number;
	readonly feelsLike?: number;
	readonly humidity?: number;
	readonly precipitation?: number;
	readonly wind?: number;
	readonly gusts?: number;
	readonly isDay?: boolean;
};

export type HourForecast = {
	/** Local time at the place, YYYY-MM-DDTHH:MM. */
	readonly time: string;
	readonly code?: number;
	readonly temperature?: number;
	readonly rainChance?: number;
	readonly precipitation?: number;
};

export type DayForecast = {
	/** YYYY-MM-DD, local. */
	readonly date: string;
	readonly code?: number;
	readonly min?: number;
	readonly max?: number;
	readonly precipitation?: number;
	readonly rainChance?: number;
	readonly windMax?: number;
	/** Local HH:MM. */
	readonly sunrise?: string;
	readonly sunset?: string;
	readonly uvMax?: number;
};

export type Forecast = { readonly current?: CurrentWeather; readonly hours: readonly HourForecast[]; readonly days: readonly DayForecast[] };

export type Weather = {
	/** Up to ten places with this name, in this country (two letters) if given. */
	geocode(name: string, country?: string): Promise<Place[]>;
	/** Now, the next 48 hours, and `days` days from today (today included), 1 to 16. */
	forecast(place: Place, days: number): Promise<Forecast>;
};

/** The service refused or failed: a reason the model can pass on, never the key or the address. */
export class WeatherError extends Error {}

/** A place and a forecast are a few kilobytes: anything past this is not an answer. */
const MAX_BODY = 1024 * 1024;
const CURRENT = ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation", "weather_code", "wind_speed_10m", "wind_gusts_10m", "is_day"];
const HOURLY = ["temperature_2m", "precipitation_probability", "precipitation", "weather_code"];
const DAILY = ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"];

/** Open-Meteo's geocoding and forecast APIs (the same APIs at any address, for tests). */
export function openMeteo(config: WeatherConfig, fetchImpl: typeof fetch = fetch): Weather {
	const error = weatherError(config.apiKey !== undefined);
	const get = (endpoint: string, params: Record<string, string>): Promise<object> => {
		const url = new URL(endpoint);
		for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
		if (config.apiKey !== undefined) url.searchParams.set("apikey", config.apiKey);
		return getJson(url, { fetch: fetchImpl, maxBytes: MAX_BODY }, error);
	};
	return {
		async geocode(name, country) {
			const body = await get(config.geocodingUrl, { name, count: "10", language: "it", format: "json", ...(country === undefined ? {} : { countryCode: country }) });
			const results = (body as { results?: unknown }).results;
			return Array.isArray(results) ? results.flatMap(placeOf) : [];
		},
		async forecast(place, days) {
			const body = await get(config.forecastUrl, {
				latitude: String(place.latitude),
				longitude: String(place.longitude),
				current: CURRENT.join(","),
				hourly: HOURLY.join(","),
				daily: DAILY.join(","),
				timezone: place.timezone ?? "auto",
				forecast_days: String(Math.min(MAX_FORECAST_DAYS, Math.max(1, Math.floor(days)))),
				forecast_hours: String(FORECAST_HOURS),
			});
			const { current, hourly, daily } = body as { current?: unknown; hourly?: unknown; daily?: unknown };
			const now = currentOf(current);
			return { ...(now === undefined ? {} : { current: now }), hours: hoursOf(hourly), days: daysOf(daily) };
		},
	};
}

/** Each failure in Italian. A refusal without a key is most likely the free tier's terms. */
function weatherError(withKey: boolean): (problem: HttpProblem) => WeatherError {
	return (problem) => {
		if (problem.kind !== "status") {
			return new WeatherError({ unreachable: "il servizio meteo non risponde", too_big: "il servizio meteo ha mandato una risposta troppo grande", unreadable: "il servizio meteo ha risposto in modo illeggibile", redirect: "il servizio meteo rimanda a un indirizzo non consentito" }[problem.kind]);
		}
		const { status } = problem;
		if (status === 401 || status === 403) return new WeatherError(withKey ? "il servizio meteo rifiuta la chiave del server" : "il servizio meteo rifiuta la richiesta: per un uso commerciale serve un piano a pagamento e OWNI_WEATHER_API_KEY");
		if (status === 429) return new WeatherError("il servizio meteo ha raggiunto il limite di richieste, riprova più tardi");
		if (status === 400) return new WeatherError("il servizio meteo non accetta la richiesta");
		return new WeatherError(`il servizio meteo risponde ${status}`);
	};
}

function placeOf(item: unknown): Place[] {
	if (typeof item !== "object" || item === null) return [];
	const r = item as Record<string, unknown>;
	const name = text(r.name);
	const latitude = finite(r.latitude);
	const longitude = finite(r.longitude);
	if (name === undefined || latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
	const fields = {
		admin1: text(r.admin1),
		admin2: text(r.admin2),
		country: text(r.country),
		countryCode: typeof r.country_code === "string" && /^[A-Za-z]{2}$/.test(r.country_code) ? r.country_code.toUpperCase() : undefined,
		timezone: typeof r.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(r.timezone) ? r.timezone : undefined,
	};
	const population = finite(r.population);
	return [{ name, ...defined(fields), latitude, longitude, population: population !== undefined && population > 0 ? population : 0 }];
}

function currentOf(value: unknown): CurrentWeather | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const c = value as Record<string, unknown>;
	const time = localTime(c.time);
	if (time === undefined) return undefined;
	const fields = {
		code: wmo(c.weather_code),
		temperature: finite(c.temperature_2m),
		feelsLike: finite(c.apparent_temperature),
		humidity: finite(c.relative_humidity_2m),
		precipitation: finite(c.precipitation),
		wind: finite(c.wind_speed_10m),
		gusts: finite(c.wind_gusts_10m),
		isDay: c.is_day === 1 ? true : c.is_day === 0 ? false : undefined,
	};
	return { time, ...defined(fields) };
}

/** The value of each field at row i of Open-Meteo's column arrays. */
function columns(value: unknown): { times: unknown[]; at: (field: string, i: number) => unknown } {
	if (typeof value !== "object" || value === null) return { times: [], at: () => undefined };
	const d = value as Record<string, unknown>;
	return { times: Array.isArray(d.time) ? d.time : [], at: (field, i) => (Array.isArray(d[field]) ? (d[field] as unknown[])[i] : undefined) };
}

function hoursOf(value: unknown): HourForecast[] {
	const { times, at } = columns(value);
	return times.slice(0, FORECAST_HOURS).flatMap((t, i) => {
		const time = localTime(t);
		if (time === undefined) return [];
		const fields = { code: wmo(at("weather_code", i)), temperature: finite(at("temperature_2m", i)), rainChance: finite(at("precipitation_probability", i)), precipitation: finite(at("precipitation", i)) };
		return [{ time, ...defined(fields) }];
	});
}

function daysOf(value: unknown): DayForecast[] {
	const { times, at } = columns(value);
	return times.slice(0, MAX_FORECAST_DAYS).flatMap((date, i) => {
		if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || localTime(`${date}T00:00`) === undefined) return [];
		const fields = {
			code: wmo(at("weather_code", i)),
			min: finite(at("temperature_2m_min", i)),
			max: finite(at("temperature_2m_max", i)),
			precipitation: finite(at("precipitation_sum", i)),
			rainChance: finite(at("precipitation_probability_max", i)),
			windMax: finite(at("wind_speed_10m_max", i)),
			sunrise: localTime(at("sunrise", i))?.slice(11),
			sunset: localTime(at("sunset", i))?.slice(11),
			uvMax: finite(at("uv_index_max", i)),
		};
		return [{ date, ...defined(fields) }];
	});
}

/** The fields that have a value: optional properties stay absent, not undefined. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
	return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
	const clean = plain(value).slice(0, 100);
	return clean === "" ? undefined : clean;
}

/** YYYY-MM-DDTHH:MM, as Open-Meteo writes local times, and a real date and time (no 30 February). */
function localTime(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
	const minute = value.slice(0, 16);
	const parsed = Date.parse(`${minute}:00Z`);
	return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 16) === minute ? minute : undefined;
}

function wmo(value: unknown): number | undefined {
	const code = finite(value);
	return code !== undefined && Number.isInteger(code) ? code : undefined;
}

/** WMO weather codes, as Open-Meteo documents them, in Italian. */
export const WEATHER_CODES: Readonly<Record<number, string>> = {
	0: "sereno",
	1: "poco nuvoloso",
	2: "parzialmente nuvoloso",
	3: "coperto",
	45: "nebbia",
	48: "nebbia con brina",
	51: "pioviggine debole",
	53: "pioviggine moderata",
	55: "pioviggine intensa",
	56: "pioviggine gelata debole",
	57: "pioviggine gelata intensa",
	61: "pioggia debole",
	63: "pioggia moderata",
	65: "pioggia forte",
	66: "pioggia gelata debole",
	67: "pioggia gelata forte",
	71: "neve debole",
	73: "neve moderata",
	75: "neve forte",
	77: "neve granulosa",
	80: "rovesci deboli",
	81: "rovesci moderati",
	82: "rovesci violenti",
	85: "rovesci di neve deboli",
	86: "rovesci di neve forti",
	95: "temporale",
	96: "temporale con grandine debole",
	99: "temporale con grandine forte",
};

/** The words for a code; a code the table does not know is said as such. */
export function weatherWords(code: number | undefined): string {
	if (code === undefined) return "condizioni non indicate";
	return WEATHER_CODES[code] ?? `condizioni con codice ${code}`;
}

/** Drizzle, rain, snow, showers or a storm: what wins over clouds in a part of the day. */
export function wetCode(code: number): boolean {
	return code >= 51;
}
