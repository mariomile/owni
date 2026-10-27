import { computerLabel, createComputerProvider } from "../computer/create.ts";
import { createDesktopProvider, desktopLabel } from "../desktop/create.ts";
import { ecbRates, ExchangeRateError, type ExchangeRatesConfig } from "../core/exchange-rates.ts";
import { DEV_PROVIDER, modelProvider } from "../core/model-providers.ts";
import { feedNews, type NewsConfig } from "../core/news.ts";
import { viesClient, type ViesConfig, ViesError } from "../core/vies.ts";
import type { OwniConfig } from "./config.ts";

/**
 * `pnpm owni check`: before a live test, ask each configured service whether the keys in
 * `.env` work and whether this machine reaches it. Nothing secret is printed: a check reports
 * what it found (a bot name, a mailbox) or what to fix (which variable, which host).
 */

export type CheckResult = { readonly name: string; readonly ok: boolean; readonly detail: string };

const TIMEOUT_MS = 10_000;
/** Each feed's time in the check: a slow feed is reported as slow, not as down. */
const NEWS_TIMEOUT_MS = 15_000;

export async function runChecks(config: OwniConfig, fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
	const call = (url: string, init: RequestInit = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	const checks: Promise<CheckResult>[] = [check(`Modello (${config.modelProvider})`, () => modelCheck(config, call))];
	if (config.telegram !== undefined) {
		const token = config.telegram.token;
		checks.push(check("Telegram (agente)", () => telegramCheck(token, call)));
	}
	const transcription = config.transcription;
	if (transcription !== undefined) checks.push(check("Trascrizione dei vocali", () => transcriptionCheck(transcription, call)));
	const speech = config.speech;
	if (speech !== undefined) checks.push(check("Risposte a voce", () => speechCheck(speech, call)));
	const search = config.webSearch;
	if (search !== undefined) checks.push(check("Ricerca sul web", () => searchCheck(search, call)));
	const weather = config.weather;
	if (weather !== undefined) checks.push(check("Meteo", () => weatherCheck(weather, call)));
	const rates = config.exchangeRates;
	if (rates !== undefined) checks.push(check("Cambi", () => exchangeRatesCheck(rates, call)));
	const news = config.news;
	// Its own timeout per feed, longer than a person waits: not the checks' 10 seconds.
	if (news !== undefined) checks.push(check("Notizie", () => newsCheck(news, fetchImpl)));
	const vatCheck = config.vatCheck;
	if (vatCheck !== undefined) checks.push(check("Partita IVA", () => vatCheckCheck(vatCheck, call)));
	const computer = config.computer;
	if (computer !== undefined) checks.push(check(`Computer (${computerLabel(computer)})`, () => computerCheck(config, computer)));
	const desktop = config.desktop;
	if (desktop !== undefined) checks.push(check(`Schermo (${desktopLabel(desktop)})`, () => desktopCheck(desktop, fetchImpl)));
	return Promise.all(checks);
}

type Call = (url: string, init?: RequestInit) => Promise<Response>;

class CheckFailed extends Error {}

/** Run one check; a network error names the host only, never the URL (it may hold a token). */
async function check(name: string, run: () => Promise<string>): Promise<CheckResult> {
	try {
		return { name, ok: true, detail: await run() };
	} catch (error) {
		if (error instanceof CheckFailed) return { name, ok: false, detail: error.message };
		return { name, ok: false, detail: "errore inatteso nel controllo" };
	}
}

async function reach(call: Call, url: string, init?: RequestInit): Promise<Response> {
	try {
		return await call(url, init);
	} catch {
		const host = new URL(url).host;
		throw new CheckFailed(`${host} non raggiungibile: controlla la rete, o che il dominio sia tra quelli consentiti`);
	}
}

async function modelCheck(config: OwniConfig, call: Call): Promise<string> {
	if (config.modelProvider === DEV_PROVIDER) return "modello locale di sviluppo, nessuna chiave";
	const key = config.modelApiKeys[config.modelProvider] ?? "";
	const variable = modelProvider(config.modelProvider)?.keyEnv ?? "la chiave del modello";
	// The providers whose model list is checked here; the others prove the key at the first reply.
	if (config.modelProvider !== "anthropic" && config.modelProvider !== "openai") return `chiave presente in ${variable}, modello ${config.modelId}: la prima risposta in chat la verifica`;
	const response =
		config.modelProvider === "anthropic"
			? await reach(call, "https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
			: await reach(call, "https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed(`chiave rifiutata: controlla ${variable}`);
	if (!response.ok) throw new CheckFailed(`il provider risponde ${response.status}`);
	const models = ((await response.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
	const found = models.includes(config.modelId);
	if (models.length > 0 && !found) throw new CheckFailed(`chiave valida, ma il modello ${config.modelId} non è tra quelli disponibili (OWNI_MODEL_ID)`);
	return `chiave valida, modello ${config.modelId}`;
}

/** The Docker host answers and has the image (ADR 0013), Fly takes the token, or the control plane answers (ADR 0015). */
async function computerCheck(config: OwniConfig, computer: NonNullable<OwniConfig["computer"]>): Promise<string> {
	const problem = await createComputerProvider(computer, { tenant: config.tenantId, dataDir: config.dataDir, ...(config.cell.secret === undefined ? {} : { cellSecret: config.cell.secret }) }).check();
	if (problem !== undefined) throw new CheckFailed(problem);
	if (computer.kind === "docker") return `Docker risponde, immagine ${computer.image} presente`;
	if (computer.kind === "fly") return `Fly accetta il token dell'organizzazione ${computer.org}; l'immagine ${computer.image} si prova al primo comando`;
	return "il control plane risponde";
}

/** The Docker host answers, is amd64 and has Cua's image, or the desktop run elsewhere answers with its token (ADR 0045). */
async function desktopCheck(desktop: NonNullable<OwniConfig["desktop"]>, fetchImpl: typeof fetch): Promise<string> {
	const problem = await createDesktopProvider(desktop, { fetch: fetchImpl }).check();
	if (problem !== undefined) throw new CheckFailed(problem);
	if (desktop.kind === "docker") return `Docker risponde, immagine di Cua presente; il primo schermo si prova alla prima azione${desktop.network === "internet" ? " (con internet)" : " (senza internet)"}`;
	return "lo schermo risponde e accetta il token";
}

/** The service's model list: the key works and the model is there (the services that list models). */
async function transcriptionCheck(config: { url: string; apiKey: string; model: string }, call: Call): Promise<string> {
	const response = await reach(call, `${config.url.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed("chiave rifiutata: controlla OWNI_TRANSCRIBE_API_KEY");
	if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla OWNI_TRANSCRIBE_URL`);
	const models = ((await response.json().catch(() => ({}))) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
	// Aliases (voxtral-mini-latest) are not always listed: a warning, not a failure.
	if (models.length > 0 && !models.includes(config.model)) return `chiave valida; il modello ${config.model} non compare nell'elenco del servizio, prova un vocale per esserne certo`;
	return `chiave valida, modello ${config.model}`;
}

/** The key works: the service lists its models. No audio is made, so the check costs nothing. */
async function speechCheck(config: { url: string; apiKey: string; model: string; voice: string }, call: Call): Promise<string> {
	const response = await reach(call, `${config.url}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed("chiave rifiutata: controlla OWNI_SPEECH_API_KEY");
	if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla OWNI_SPEECH_URL`);
	return `chiave valida (modello ${config.model} e voce ${config.voice} non verificati: prova un vocale)`;
}

/** One search for a word everyone has: the key works and results come back. */
async function searchCheck(config: { url: string; apiKey: string; country: string; language: string }, call: Call): Promise<string> {
	const url = new URL(config.url);
	url.searchParams.set("q", "Roma");
	url.searchParams.set("count", "1");
	url.searchParams.set("country", config.country);
	url.searchParams.set("search_lang", config.language);
	const response = await reach(call, url.toString(), { headers: { accept: "application/json", "x-subscription-token": config.apiKey } });
	if (response.status === 401 || response.status === 403) throw new CheckFailed("chiave rifiutata: controlla OWNI_SEARCH_API_KEY");
	if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla OWNI_SEARCH_URL`);
	return `chiave valida, ${url.host} risponde`;
}

/** One place and a one-day forecast for it: both addresses answer (with the key, on a paid plan). Bodies are not read. */
async function weatherCheck(config: { forecastUrl: string; geocodingUrl: string; apiKey?: string }, call: Call): Promise<string> {
	const geocoding = new URL(config.geocodingUrl);
	for (const [name, value] of [["name", "Roma"], ["count", "1"], ["format", "json"]]) geocoding.searchParams.set(name as string, value as string);
	const forecast = new URL(config.forecastUrl);
	for (const [name, value] of [["latitude", "41.89"], ["longitude", "12.51"], ["daily", "weather_code"], ["forecast_days", "1"]]) forecast.searchParams.set(name as string, value as string);
	for (const [url, variable] of [[geocoding, "OWNI_WEATHER_GEOCODING_URL"], [forecast, "OWNI_WEATHER_URL"]] as const) {
		if (config.apiKey !== undefined) url.searchParams.set("apikey", config.apiKey);
		const response = await reach(call, url.toString(), { headers: { accept: "application/json" } });
		await response.body?.cancel().catch(() => {});
		if (response.status === 401 || response.status === 403) throw new CheckFailed(config.apiKey === undefined ? "richiesta rifiutata: per un uso commerciale serve un piano e OWNI_WEATHER_API_KEY" : "chiave rifiutata: controlla OWNI_WEATHER_API_KEY");
		if (!response.ok) throw new CheckFailed(`il servizio risponde ${response.status}: controlla ${variable}`);
	}
	return `${geocoding.host} e ${forecast.host} rispondono${config.apiKey === undefined ? "" : ", chiave valida"}`;
}

/** The day's file of reference rates, downloaded and read: the host answers and the file makes sense. */
async function exchangeRatesCheck(config: ExchangeRatesConfig, call: Call): Promise<string> {
	const host = new URL(config.url).host;
	// The check's own call and timeout, like the other checks.
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => call(String(input), init)) as typeof fetch;
	try {
		const { day } = await ecbRates(config, fetchImpl).rateOn();
		return `${host} risponde, cambi del ${day.date} per ${day.rates.size} valute`;
	} catch (error) {
		if (error instanceof ExchangeRateError) throw new CheckFailed(`${error.message}: controlla che ${host} sia raggiungibile, o OWNI_EXCHANGE_RATES_URL`);
		throw error;
	}
}

/**
 * Every feed downloaded and read, four at a time, each with 15 seconds: each named with what came
 * of it, never its address (an operator's feed may carry a query). Some feeds failing is a
 * warning, as for a model the service does not list; none answering is a failure.
 */
async function newsCheck(config: NewsConfig, fetchImpl: typeof fetch): Promise<string> {
	const results = await feedNews(config, fetchImpl, undefined, { timeoutMs: NEWS_TIMEOUT_MS }).read(config.feeds);
	const report = results.map((r) => ("error" in r ? `${r.feed.name} ${r.error}` : r.headlines.some((h) => h.published !== undefined) ? `${r.feed.name} ok` : `${r.feed.name} senza notizie datate`));
	const failed = results.filter((r) => "error" in r).map((r) => r.feed.name);
	// A feed without a single dated headline shows nothing either: it counts toward the warning.
	const undated = results.flatMap((r) => ("error" in r || r.headlines.some((h) => h.published !== undefined) ? [] : [r.feed.name]));
	const summary = `${results.length - failed.length} feed su ${results.length} rispondono: ${report.join("; ")}`;
	if (failed.length === results.length) throw new CheckFailed(`${summary}. Controlla la rete e OWNI_NEWS_FEEDS`);
	const warnings = [...(failed.length === 0 ? [] : [`non vanno ${failed.join(", ")}`]), ...(undated.length === 0 ? [] : [`senza notizie datate ${undated.join(", ")}`])];
	return warnings.length === 0 ? summary : `${summary}. Attenzione: ${warnings.join("; ")}. Controlla OWNI_NEWS_FEEDS, o togli quei feed`;
}

/**
 * ENI S.p.A.'s partita IVA, a large listed company's, published on its website and invoices:
 * stable for decades, so a «not active» answer means the VIES or this number changed.
 */
const VIES_PROBE = { country: "IT", number: "00905811006" } as const;

/** One known partita IVA asked to the VIES: the endpoint answers and reads as expected. A member state down is a warning. */
async function vatCheckCheck(config: ViesConfig, call: Call): Promise<string> {
	const host = new URL(config.url).host;
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => call(String(input), init)) as typeof fetch;
	const probe = `${VIES_PROBE.country}${VIES_PROBE.number}`;
	try {
		const answer = await viesClient(config, fetchImpl).check("check", VIES_PROBE.country, VIES_PROBE.number, () => true);
		if (!answer.valid) return `${host} risponde. Attenzione: la partita IVA di prova ${probe} risulta non attiva: aggiorna VIES_PROBE in src/main/check.ts`;
		return `${host} risponde, la partita IVA di prova ${probe} risulta attiva`;
	} catch (error) {
		if (!(error instanceof ViesError)) throw error;
		// Errors that pass by themselves are a warning, not a failure.
		if (error.temporary) return `${host} risponde. Attenzione: ${error.message}`;
		throw new CheckFailed(`${error.message}: controlla che ${host} sia raggiungibile, o OWNI_VAT_CHECK_URL`);
	}
}

async function telegramCheck(token: string, call: Call): Promise<string> {
	const response = await reach(call, `https://api.telegram.org/bot${token}/getMe`);
	const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
	if (response.status === 401 || response.status === 404) throw new CheckFailed("token del bot rifiutato da Telegram: rigeneralo da @BotFather");
	if (payload.ok !== true) throw new CheckFailed(`Telegram risponde ${response.status}`);
	return `bot @${payload.result?.username ?? "?"}`;
}
