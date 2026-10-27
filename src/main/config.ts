import type { WebSearchConfig } from "../core/web-search.ts";
import { DEFAULT_RATES_URL, type ExchangeRatesConfig } from "../core/exchange-rates.ts";
import { DEFAULT_NEWS_FEEDS, MAX_FEED_NAME, MAX_FEEDS, NEWS_SECTIONS, type NewsConfig, type NewsFeed, type NewsSection } from "../core/news.ts";
import { DEFAULT_MAX_PER_DAY_SERVER, DEFAULT_VIES_URL, type ViesConfig } from "../core/vies.ts";
import { DEFAULT_FORECAST_URL, DEFAULT_GEOCODING_URL, PAID_FORECAST_URL, type WeatherConfig } from "../core/weather.ts";
import type { SpeakerConfig } from "../channels/speech.ts";
import type { ImageGenerationConfig } from "../core/image-generation.ts";
import { TIMESTAMP_STYLES, type TimestampStyle, type TranscriberConfig } from "../channels/voice.ts";
import { GOOGLE_SERVICES, type GoogleService } from "../connectors/google.ts";
import { DEV_MODEL_ID, DEV_PROVIDER, MODEL_PROVIDERS, modelProvider as offeredProvider, providerIds, subscriptionProvider } from "../core/model-providers.ts";
export type TelegramConfig = {
	readonly telegramBotToken: string;
	readonly modelProvider: string;
	readonly modelId: string;
	/** Undefined for the local "faux" model, which needs no key. */
	readonly modelApiKey: string | undefined;
	readonly dataDir: string;
	readonly tenantId: string;
	readonly instanceId: string;
	/** Telegram user IDs allowed to talk to the bot; undefined leaves the instance's list as it is. */
	readonly telegramAllowedUsers: readonly string[] | undefined;
};

export const DEFAULT_MODEL_PROVIDER = "anthropic";

/** OWNI_MODEL_PROVIDER and OWNI_MODEL_ID, checked; `keyEnv` is undefined for the local model. */
function modelChoice(env: Readonly<Record<string, string | undefined>>): { modelProvider: string; modelId: string; keyEnv: string | undefined } {
	const modelProvider = nonEmpty(env.OWNI_MODEL_PROVIDER) ?? (env.OWNI_LOCAL_PROVIDERS === "1" ? DEV_PROVIDER : DEFAULT_MODEL_PROVIDER);
	if (subscriptionProvider(modelProvider) !== undefined && env.OWNI_LOCAL_PROVIDERS !== "1") throw new ConfigError("Subscription providers require OWNI_LOCAL_PROVIDERS=1 in the local app");
	if (modelProvider === DEV_PROVIDER) return { modelProvider, modelId: nonEmpty(env.OWNI_MODEL_ID) ?? DEV_MODEL_ID, keyEnv: undefined };
	const offered = offeredProvider(modelProvider);
	if (offered === undefined) {
		throw new ConfigError(`OWNI_MODEL_PROVIDER="${modelProvider}" is not supported. Use one of: ${providerIds().join(", ")}`);
	}
	return { modelProvider, modelId: nonEmpty(env.OWNI_MODEL_ID) ?? offered.defaultModel, keyEnv: offered.keyEnv };
}

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

/** Reads the configuration of `pnpm dev:telegram`. Throws ConfigError naming each missing variable. */
export function loadTelegramConfig(env: Readonly<Record<string, string | undefined>>): TelegramConfig {
	const missing: string[] = [];
	const telegramBotToken = nonEmpty(env.TELEGRAM_BOT_TOKEN);
	if (telegramBotToken === undefined) missing.push("TELEGRAM_BOT_TOKEN");

	const { modelProvider, modelId, keyEnv } = modelChoice(env);
	const modelApiKey = keyEnv === undefined ? undefined : nonEmpty(env[keyEnv]);
	if (keyEnv !== undefined && modelApiKey === undefined) missing.push(keyEnv);

	const allowedRaw = nonEmpty(env.OWNI_TELEGRAM_ALLOWED_USERS);
	const telegramAllowedUsers = allowedRaw?.split(",").map((id) => id.trim()).filter((id) => id !== "");
	const invalid = telegramAllowedUsers?.filter((id) => !/^\d+$/.test(id)) ?? [];
	if (invalid.length > 0) {
		throw new ConfigError(`OWNI_TELEGRAM_ALLOWED_USERS must be a comma-separated list of numeric Telegram user IDs; invalid: ${invalid.join(", ")}`);
	}

	if (missing.length > 0) {
		throw new ConfigError(
			`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in .env (see .env.example).`,
		);
	}
	return {
		telegramBotToken: telegramBotToken as string,
		modelProvider,
		modelId,
		modelApiKey,
		dataDir: nonEmpty(env.OWNI_DATA_DIR) ?? "data",
		tenantId: nonEmpty(env.OWNI_TENANT_ID) ?? "default",
		instanceId: nonEmpty(env.OWNI_INSTANCE_ID) ?? "telegram",
		telegramAllowedUsers,
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export type OwniConfig = {
	/** Opt-in access to official CLI subscriptions; only for a local single-tenant app. */
	readonly localProviders?: boolean;
	readonly dataDir: string;
	readonly tenantId: string;
	readonly instanceId: string;
	readonly instanceName: string;
	readonly modelProvider: string;
	readonly modelId: string;
	/** Provider → the key the operator gave for it (ANTHROPIC_API_KEY, GEMINI_API_KEY, ...). */
	readonly modelApiKeys: Readonly<Record<string, string>>;
	readonly timeZone: string;
	readonly web: { readonly host: string; readonly port: number; readonly publicUrl: string | undefined };
	readonly telegram:
		| {
				readonly token: string;
				readonly allowedUsers: readonly string[] | undefined;
				readonly approvers: readonly string[] | undefined;
				/** Webhook instead of long polling: Telegram pushes to OWNI_PUBLIC_URL with this secret. */
				readonly webhookSecret: string | undefined;
		  }
		| undefined;
	/** Running as a cell of Owni Cloud: set by the control plane. */
	readonly cell: { readonly secret: string | undefined };
	/** The OAuth client people connect their Google account with (Gmail and Calendar, read only). */
	readonly google: { readonly clientId: string; readonly clientSecret: string; readonly redirectUrl: string; readonly services: readonly GoogleService[]; readonly write: boolean } | undefined;
	/** Chromium for web_screenshot; Playwright's own if unset. */
	readonly chromiumPath: string | undefined;
	/** The operator accepts Chromium without its sandbox where the sandbox cannot start (ADR 0009). */
	readonly screenshotsWithoutSandbox: boolean;
	/** Where voice messages are transcribed (an OpenAI-compatible service); off if unset. */
	readonly transcription: TranscriberConfig | undefined;
	/** Replies as voice notes (ADR 0020), when the operator set a speech service. */
	readonly speech: SpeakerConfig | undefined;
	/** Pictures made on request (ADR 0023), when the operator set an image service. */
	readonly images: ImageGenerationConfig | undefined;
	/** Web search for the instances (ADR 0017): Brave Search, or the same API elsewhere; off if unset. */
	readonly webSearch: WebSearchConfig | undefined;
	/** The weather tool (Open-Meteo, or the same APIs elsewhere), when the operator turns it on with OWNI_WEATHER=1; maxPerDay counts tool calls. */
	readonly weather: WeatherConfig | undefined;
	/** The exchange_rate tool (the ECB's reference rates), when the operator turns it on with OWNI_EXCHANGE_RATES=1. */
	readonly exchangeRates: ExchangeRatesConfig | undefined;
	/** The news_headlines tool (public RSS/Atom feeds, the built-in list or OWNI_NEWS_FEEDS), when the operator turns it on with OWNI_NEWS=1. */
	readonly news: NewsConfig | undefined;
	/** The VIES lookup of vat_check (the European Commission's VAT numbers), when the operator turns it on with OWNI_VAT_CHECK=1; without it vat_check checks on paper only. */
	readonly vatCheck: ViesConfig | undefined;
	/** Phone calls (ADR 0012): Twilio's REST API (the Ireland region for data in the EU) and the language spoken. */
	readonly phone: { readonly apiBase: string; readonly voice: string };
	/** The instances' computers: a container each on this Docker host (ADR 0013), a Fly machine each, or, in a cell of Owni Cloud, through the control plane (ADR 0015). */
	readonly computer: ComputerConfig | undefined;
	/** The agenti's screens through Cua (ADR 0045): a container each on this Docker host, or one desktop run elsewhere; off if unset. */
	readonly desktop: DesktopConfig | undefined;
};

/**
 * An operator's service address: https, or http on this machine only. No user name or password
 * (keys have their own variables), no query or fragment, a valid port. Returned as given.
 */
function serviceUrl(name: string, value: string, example: string, allow: { readonly query?: boolean } = {}): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`${name}: an https address with a valid host and port, e.g. ${example}`);
	}
	const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if ((url.protocol !== "https:" && !local) || /\s/.test(value) || url.port === "0") throw new ConfigError(`${name}: an https address (http only on localhost), e.g. ${example}`);
	if (url.username !== "" || url.password !== "") throw new ConfigError(`${name}: no user name or password in the address, e.g. ${example}`);
	if (allow.query === true ? value.includes("#") : /[?#]/.test(value)) throw new ConfigError(`${name}: an address without ${allow.query === true ? "" : "a query or "}a fragment, e.g. ${example}`);
	return value;
}

/**
 * OWNI_WEATHER=1 and its overrides: place names and coordinates leave the server only when
 * the operator says so. Open-Meteo is free only for private, non-commercial use: a business sets a plan's key.
 */
function loadWeatherConfig(env: Readonly<Record<string, string | undefined>>): WeatherConfig | undefined {
	const on = nonEmpty(env.OWNI_WEATHER);
	if (on !== undefined && !["0", "1", "true", "false"].includes(on)) throw new ConfigError("OWNI_WEATHER: 1 to offer the weather tool (Open-Meteo), 0 (default) for no weather");
	const overrides = ["OWNI_WEATHER_URL", "OWNI_WEATHER_GEOCODING_URL", "OWNI_WEATHER_API_KEY", "OWNI_WEATHER_MAX_PER_DAY"].filter((name) => nonEmpty(env[name]) !== undefined);
	if (on !== "1" && on !== "true") {
		if (overrides.length > 0) throw new ConfigError(`${overrides.join(", ")} set without OWNI_WEATHER=1`);
		return undefined;
	}
	const apiKey = nonEmpty(env.OWNI_WEATHER_API_KEY);
	// A paid plan: its forecast host by default; its geocoding address is the one Open-Meteo gives.
	const forecastDefault = apiKey === undefined ? DEFAULT_FORECAST_URL : PAID_FORECAST_URL;
	const forecastUrl = serviceUrl("OWNI_WEATHER_URL", nonEmpty(env.OWNI_WEATHER_URL) ?? forecastDefault, forecastDefault);
	const geocoding = nonEmpty(env.OWNI_WEATHER_GEOCODING_URL);
	if (apiKey !== undefined && geocoding === undefined) throw new ConfigError("OWNI_WEATHER_API_KEY needs OWNI_WEATHER_GEOCODING_URL: the geocoding address Open-Meteo gives with the plan");
	const geocodingUrl = serviceUrl("OWNI_WEATHER_GEOCODING_URL", geocoding ?? DEFAULT_GEOCODING_URL, DEFAULT_GEOCODING_URL);
	// Tool calls, each one a geocoding and a forecast request.
	const maxPerDay = Number(nonEmpty(env.OWNI_WEATHER_MAX_PER_DAY) ?? "200");
	if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100_000) throw new ConfigError("OWNI_WEATHER_MAX_PER_DAY: a whole number from 1 to 100000");
	return { forecastUrl, geocodingUrl, ...(apiKey === undefined ? {} : { apiKey }), maxPerDay };
}

/**
 * OWNI_EXCHANGE_RATES=1 and its address: off unless the operator says so, like every service
 * Owni reaches. Only the ECB's public files are fetched; nothing about the person leaves.
 */
function loadExchangeRatesConfig(env: Readonly<Record<string, string | undefined>>): ExchangeRatesConfig | undefined {
	const on = nonEmpty(env.OWNI_EXCHANGE_RATES);
	if (on !== undefined && !["0", "1", "true", "false"].includes(on)) throw new ConfigError("OWNI_EXCHANGE_RATES: 1 to offer the ECB exchange rates, 0 (default) for none");
	const url = nonEmpty(env.OWNI_EXCHANGE_RATES_URL);
	if (on !== "1" && on !== "true") {
		if (url !== undefined) throw new ConfigError("OWNI_EXCHANGE_RATES_URL set without OWNI_EXCHANGE_RATES=1");
		return undefined;
	}
	return { url: serviceUrl("OWNI_EXCHANGE_RATES_URL", url ?? DEFAULT_RATES_URL, DEFAULT_RATES_URL) };
}

/**
 * OWNI_NEWS=1 and its feeds: off unless the operator says so. Only the feeds' fixed addresses
 * are fetched; nothing the person writes, a topic included, leaves the server.
 */
function loadNewsConfig(env: Readonly<Record<string, string | undefined>>): NewsConfig | undefined {
	const on = nonEmpty(env.OWNI_NEWS);
	if (on !== undefined && !["0", "1", "true", "false"].includes(on)) throw new ConfigError("OWNI_NEWS: 1 to offer the news headlines (public RSS/Atom feeds), 0 (default) for none");
	const list = nonEmpty(env.OWNI_NEWS_FEEDS);
	if (on !== "1" && on !== "true") {
		if (list !== undefined) throw new ConfigError("OWNI_NEWS_FEEDS set without OWNI_NEWS=1");
		return undefined;
	}
	return { feeds: list === undefined ? DEFAULT_NEWS_FEEDS : newsFeeds(list) };
}

/**
 * OWNI_VAT_CHECK=1 and its overrides: off unless the operator says so. Then the country and the
 * VAT number someone asks about go to the European Commission's VIES, nothing else.
 */
function loadVatCheckConfig(env: Readonly<Record<string, string | undefined>>): ViesConfig | undefined {
	const on = nonEmpty(env.OWNI_VAT_CHECK);
	if (on !== undefined && !["0", "1", "true", "false"].includes(on)) throw new ConfigError("OWNI_VAT_CHECK: 1 to look VAT numbers up in the EU's VIES, 0 (default) for the formal check only");
	const overrides = ["OWNI_VAT_CHECK_URL", "OWNI_VAT_CHECK_MAX_PER_DAY", "OWNI_VAT_CHECK_MAX_PER_DAY_SERVER"].filter((name) => nonEmpty(env[name]) !== undefined);
	if (on !== "1" && on !== "true") {
		if (overrides.length > 0) throw new ConfigError(`${overrides.join(", ")} set without OWNI_VAT_CHECK=1`);
		return undefined;
	}
	const url = serviceUrl("OWNI_VAT_CHECK_URL", nonEmpty(env.OWNI_VAT_CHECK_URL) ?? DEFAULT_VIES_URL, DEFAULT_VIES_URL);
	// Requests to the VIES, cached answers not counted: it rate-limits, and a loop must not get the server blocked.
	const maxPerDay = Number(nonEmpty(env.OWNI_VAT_CHECK_MAX_PER_DAY) ?? "200");
	if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100_000) throw new ConfigError("OWNI_VAT_CHECK_MAX_PER_DAY: a whole number from 1 to 100000");
	// Every account together: the VIES blocks an address, not an account.
	const maxPerDayServer = Number(nonEmpty(env.OWNI_VAT_CHECK_MAX_PER_DAY_SERVER) ?? String(DEFAULT_MAX_PER_DAY_SERVER));
	if (!Number.isInteger(maxPerDayServer) || maxPerDayServer < 1 || maxPerDayServer > 1_000_000) throw new ConfigError("OWNI_VAT_CHECK_MAX_PER_DAY_SERVER: a whole number from 1 to 1000000");
	return { url, maxPerDay, maxPerDayServer };
}

const FEEDS_EXAMPLE = "Il Post|https://www.ilpost.it/feed/|italia;BBC World|https://feeds.bbci.co.uk/news/world/rss.xml|mondo";

/**
 * OWNI_NEWS_FEEDS: «Nome|https://indirizzo» or «Nome|https://indirizzo|sezione», separated by
 * semicolons. Names of 1 to 40 characters without control characters, each once; addresses
 * checked like every service address, a query allowed (some feeds need one), each once.
 */
function newsFeeds(value: string): NewsFeed[] {
	const parts = value.split(";").map((part) => part.trim()).filter((part) => part !== "");
	if (parts.length === 0 || parts.length > MAX_FEEDS) throw new ConfigError(`OWNI_NEWS_FEEDS: 1 to ${MAX_FEEDS} feeds, e.g. ${FEEDS_EXAMPLE}`);
	const feeds = parts.map((part): NewsFeed => {
		const [name = "", url = "", section, ...rest] = part.split("|").map((field) => field.trim());
		if (url === "" || rest.length > 0) throw new ConfigError(`OWNI_NEWS_FEEDS: each feed is Nome|https://indirizzo, with |sezione if you like, e.g. ${FEEDS_EXAMPLE}`);
		if (name.length < 1 || name.length > MAX_FEED_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new ConfigError(`OWNI_NEWS_FEEDS: a feed's name is 1 to ${MAX_FEED_NAME} characters, without control characters`);
		if (section !== undefined && !(NEWS_SECTIONS as readonly string[]).includes(section)) throw new ConfigError(`OWNI_NEWS_FEEDS: the section of ${name} is one of ${NEWS_SECTIONS.join(", ")}`);
		return { name, url: serviceUrl(`OWNI_NEWS_FEEDS (${name})`, url, "https://www.ilpost.it/feed/", { query: true }), ...(section === undefined ? {} : { section: section as NewsSection }) };
	});
	for (const key of ["name", "url"] as const) {
		const seen = new Set<string>();
		for (const feed of feeds) {
			const value = key === "name" ? feed.name.toLowerCase() : feed.url;
			if (seen.has(value)) throw new ConfigError(`OWNI_NEWS_FEEDS: ${key === "name" ? `the name ${feed.name}` : `the address of ${feed.name}`} is listed twice`);
			seen.add(value);
		}
	}
	return feeds;
}

export type ComputerConfig =
	| { readonly kind: "docker"; readonly image: string; readonly socketPath: string; readonly runtime?: string; readonly memoryMb: number; readonly cpus: number; readonly diskMb: number }
	| { readonly kind: "fly"; readonly token: string; readonly org: string; readonly region: string; readonly image: string; readonly memoryMb: number; readonly cpus: number; readonly diskMb: number; readonly appPrefix?: string; readonly maxConcurrent?: number }
	| { readonly kind: "cloud"; readonly url: string };

/**
 * OWNI_COMPUTER and its settings: docker (ADR 0013), fly (ADR 0015) or, in a cell, cloud. The
 * control plane of Owni Cloud reads the same settings with `kind` from OWNI_CLOUD_COMPUTER.
 */
export function loadComputerConfig(env: Readonly<Record<string, string | undefined>>, kind = nonEmpty(env.OWNI_COMPUTER), variable = "OWNI_COMPUTER"): ComputerConfig | undefined {
	if (kind === undefined) return undefined;
	if (kind === "cloud") {
		const url = nonEmpty(env.OWNI_COMPUTER_URL);
		if (url === undefined || !/^https?:\/\/[^\s/]+\/?$/.test(url)) throw new ConfigError("OWNI_COMPUTER=cloud needs OWNI_COMPUTER_URL, the control plane's address (http(s)://host[:port])");
		if (nonEmpty(env.OWNI_CELL_SECRET) === undefined) throw new ConfigError("OWNI_COMPUTER=cloud is for a cell of Owni Cloud: it needs OWNI_CELL_SECRET");
		return { kind, url: url.replace(/\/$/, "") };
	}
	if (kind !== "docker" && kind !== "fly") throw new ConfigError(`${variable}: docker or fly, or unset for no computer`);
	const memoryMb = Number(nonEmpty(env.OWNI_COMPUTER_MEMORY_MB) ?? "1024");
	if (!Number.isInteger(memoryMb) || memoryMb < 128 || memoryMb > 16384) throw new ConfigError("OWNI_COMPUTER_MEMORY_MB: whole megabytes between 128 and 16384");
	const cpus = Number(nonEmpty(env.OWNI_COMPUTER_CPUS) ?? "1");
	if (!(cpus >= 0.25 && cpus <= 16)) throw new ConfigError("OWNI_COMPUTER_CPUS: between 0.25 and 16");
	const diskMb = Number(nonEmpty(env.OWNI_COMPUTER_DISK_MB) ?? "2048");
	if (!Number.isInteger(diskMb) || diskMb < 64 || diskMb > 102400) throw new ConfigError("OWNI_COMPUTER_DISK_MB: whole megabytes between 64 and 102400");
	if (kind === "fly") {
		const token = nonEmpty(env.FLY_API_TOKEN);
		const org = nonEmpty(env.OWNI_FLY_ORG);
		const image = nonEmpty(env.OWNI_COMPUTER_IMAGE);
		const region = nonEmpty(env.OWNI_FLY_REGION) ?? "fra";
		if (token === undefined || org === undefined || image === undefined) throw new ConfigError(`${variable}=fly needs FLY_API_TOKEN, OWNI_FLY_ORG and OWNI_COMPUTER_IMAGE (the fly target of docker/computer.Dockerfile, in a registry Fly can pull from)`);
		if (!/^[a-z0-9-]{1,40}$/.test(org)) throw new ConfigError("OWNI_FLY_ORG: the organization's slug");
		if (!/^[a-z]{3}$/.test(region)) throw new ConfigError("OWNI_FLY_REGION: a Fly region code, e.g. fra");
		if (!Number.isInteger(cpus) || cpus > 8) throw new ConfigError("OWNI_COMPUTER_CPUS: Fly machines have 1 to 8 whole CPUs");
		if (memoryMb < 256 || memoryMb % 256 !== 0 || memoryMb > cpus * 2048) throw new ConfigError("OWNI_COMPUTER_MEMORY_MB: on Fly, steps of 256 MB, at most 2048 MB per CPU");
		const appPrefix = nonEmpty(env.OWNI_FLY_APP_PREFIX);
		if (appPrefix !== undefined && !/^[a-z][a-z0-9-]{1,20}$/.test(appPrefix)) throw new ConfigError("OWNI_FLY_APP_PREFIX: 2 to 21 lowercase letters, digits and dashes, starting with a letter");
		const concurrent = nonEmpty(env.OWNI_COMPUTER_MAX_RUNNING);
		if (concurrent !== undefined && !(/^\d+$/.test(concurrent) && Number(concurrent) >= 1 && Number(concurrent) <= 200)) throw new ConfigError("OWNI_COMPUTER_MAX_RUNNING: commands at once on Fly, 1 to 200");
		return { kind, token, org, region, image, memoryMb, cpus, diskMb, ...(appPrefix === undefined ? {} : { appPrefix }), ...(concurrent === undefined ? {} : { maxConcurrent: Number(concurrent) }) };
	}
	const runtime = nonEmpty(env.OWNI_COMPUTER_RUNTIME);
	if (runtime !== undefined && !/^[\w.-]{1,40}$/.test(runtime)) throw new ConfigError("OWNI_COMPUTER_RUNTIME: a Docker runtime name, e.g. runsc");
	return { kind, image: nonEmpty(env.OWNI_COMPUTER_IMAGE) ?? "owni-computer:latest", socketPath: nonEmpty(env.OWNI_DOCKER_SOCKET) ?? "/var/run/docker.sock", memoryMb, cpus, diskMb, ...(runtime === undefined ? {} : { runtime }) };
}

export type DesktopConfig = { readonly kind: "docker"; readonly socketPath: string; readonly network: "none" | "internet" } | { readonly kind: "remote"; readonly url: string; readonly token: string } | { readonly kind: "local"; readonly helperPath: string };

/**
 * OWNI_DESKTOP and its settings (ADR 0045): docker, a container of Cua's image per agente, with
 * no internet unless OWNI_DESKTOP_NETWORK=internet; or remote, one Cua desktop at
 * OWNI_DESKTOP_URL with its OWNI_DESKTOP_TOKEN. Unset: no screen, and its tools are not offered.
 */
export function loadDesktopConfig(env: Readonly<Record<string, string | undefined>>): DesktopConfig | undefined {
	const kind = nonEmpty(env.OWNI_DESKTOP);
	const network = nonEmpty(env.OWNI_DESKTOP_NETWORK);
	const remote = ["OWNI_DESKTOP_URL", "OWNI_DESKTOP_TOKEN"].filter((name) => nonEmpty(env[name]) !== undefined);
	if (kind !== undefined && kind !== "docker" && kind !== "remote" && kind !== "local") throw new ConfigError("OWNI_DESKTOP: docker, remote or local, or unset for no screen");
	if (network !== undefined && kind !== "docker") throw new ConfigError("OWNI_DESKTOP_NETWORK set without OWNI_DESKTOP=docker");
	if (remote.length > 0 && kind !== "remote") throw new ConfigError(`${remote.join(", ")} set without OWNI_DESKTOP=remote`);
	if (kind === undefined) return undefined;
	if (nonEmpty(env.OWNI_CELL_SECRET) !== undefined) throw new ConfigError("OWNI_DESKTOP is not for a cell of Owni Cloud: a cell has no Docker socket, and a shared screen would mix tenants");
	if (kind === "local") {
		const host = nonEmpty(env.OWNI_WEB_HOST) ?? "127.0.0.1";
		if (env.OWNI_LOCAL_PROVIDERS !== "1" || !["127.0.0.1", "::1", "localhost"].includes(host) || nonEmpty(env.OWNI_PUBLIC_URL) !== undefined) {
			throw new ConfigError("OWNI_DESKTOP=local needs OWNI_LOCAL_PROVIDERS=1, a loopback OWNI_WEB_HOST and no OWNI_PUBLIC_URL");
		}
		const helperPath = nonEmpty(env.OWNI_LOCAL_DESKTOP_HELPER);
		if (helperPath === undefined || !helperPath.startsWith("/") || /[\r\n\0]/.test(helperPath)) throw new ConfigError("OWNI_DESKTOP=local needs an absolute OWNI_LOCAL_DESKTOP_HELPER path from the desktop app");
		return { kind, helperPath };
	}
	if (kind === "docker") {
		if (network !== undefined && network !== "none" && network !== "internet") throw new ConfigError("OWNI_DESKTOP_NETWORK: none (default, no internet) or internet");
		return { kind, socketPath: nonEmpty(env.OWNI_DOCKER_SOCKET) ?? "/var/run/docker.sock", network: network === "internet" ? "internet" : "none" };
	}
	const url = nonEmpty(env.OWNI_DESKTOP_URL);
	const token = nonEmpty(env.OWNI_DESKTOP_TOKEN);
	if (url === undefined || token === undefined) throw new ConfigError("OWNI_DESKTOP=remote needs OWNI_DESKTOP_URL (Cua's daemon, e.g. https://schermo.example:3211) and OWNI_DESKTOP_TOKEN (its CUA_ENV_TOKEN)");
	return { kind, url: serviceUrl("OWNI_DESKTOP_URL", url.replace(/\/+$/, ""), "https://schermo.example:3211"), token };
}

/** Reads the configuration of `pnpm start`. Only the model key is required; Telegram is optional. */
export function loadOwniConfig(env: Readonly<Record<string, string | undefined>>): OwniConfig {
	const missing: string[] = [];
	const { modelProvider, modelId, keyEnv } = modelChoice(env);
	if (keyEnv !== undefined && nonEmpty(env[keyEnv]) === undefined) missing.push(keyEnv);
	// Every key the operator gave: the owner can switch the model to any of these providers.
	const modelApiKeys: Record<string, string> = Object.fromEntries(MODEL_PROVIDERS.flatMap((p) => (nonEmpty(env[p.keyEnv]) === undefined ? [] : [[p.id, nonEmpty(env[p.keyEnv]) as string]])));
	const ids = (name: string): readonly string[] | undefined => {
		const raw = nonEmpty(env[name]);
		if (raw === undefined) return undefined;
		const list = raw.split(",").map((id) => id.trim()).filter((id) => id !== "");
		const invalid = list.filter((id) => !/^\d+$/.test(id));
		if (invalid.length > 0) throw new ConfigError(`${name} must be a comma-separated list of numeric Telegram user IDs; invalid: ${invalid.join(", ")}`);
		return list;
	};
	const port = Number(nonEmpty(env.OWNI_WEB_PORT) ?? "8080");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("OWNI_WEB_PORT must be a port number");
	const publicUrl = nonEmpty(env.OWNI_PUBLIC_URL)?.replace(/\/+$/, "");
	if (publicUrl !== undefined && !/^https?:\/\//.test(publicUrl)) throw new ConfigError("OWNI_PUBLIC_URL must start with http:// or https://");
	const webhookSecret = nonEmpty(env.OWNI_TELEGRAM_WEBHOOK_SECRET);
	if (webhookSecret !== undefined) {
		// Telegram's rule for secret_token: 1-256 characters, letters, digits, _ and -.
		if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) throw new ConfigError("OWNI_TELEGRAM_WEBHOOK_SECRET: 1 to 256 characters, only letters, digits, _ and -");
		if (publicUrl === undefined) throw new ConfigError("OWNI_TELEGRAM_WEBHOOK_SECRET needs OWNI_PUBLIC_URL: Telegram sends the updates there");
	}
	const cellSecret = nonEmpty(env.OWNI_CELL_SECRET);
	const localProviders = env.OWNI_LOCAL_PROVIDERS === "1";
	if (localProviders && (!["127.0.0.1", "localhost", "::1"].includes(nonEmpty(env.OWNI_WEB_HOST) ?? "127.0.0.1") || publicUrl !== undefined || cellSecret !== undefined)) throw new ConfigError("OWNI_LOCAL_PROVIDERS requires a loopback server without OWNI_PUBLIC_URL or OWNI_CELL_SECRET");
	if (cellSecret !== undefined && cellSecret.length < 16) throw new ConfigError("OWNI_CELL_SECRET: at least 16 characters");
	const googleId = nonEmpty(env.OWNI_GOOGLE_CLIENT_ID);
	const googleSecret = nonEmpty(env.OWNI_GOOGLE_CLIENT_SECRET);
	let google: OwniConfig["google"];
	if (googleId !== undefined || googleSecret !== undefined) {
		if (googleId === undefined || googleSecret === undefined) throw new ConfigError("Set both OWNI_GOOGLE_CLIENT_ID and OWNI_GOOGLE_CLIENT_SECRET, or neither");
		const redirectUrl = nonEmpty(env.OWNI_GOOGLE_REDIRECT_URL) ?? (publicUrl === undefined ? `http://localhost:${port}` : publicUrl) + "/oauth/google/callback";
		if (!/^https?:\/\/[^/]+\/oauth\/google\/callback$/.test(redirectUrl)) throw new ConfigError("OWNI_GOOGLE_REDIRECT_URL must be an http(s) address ending in /oauth/google/callback (Google accepts http only on localhost)");
		const services = (nonEmpty(env.OWNI_GOOGLE_SERVICES) ?? GOOGLE_SERVICES.join(",")).split(",").map((x) => x.trim()).filter((x) => x !== "");
		const unknown = services.filter((x) => !(GOOGLE_SERVICES as readonly string[]).includes(x));
		if (services.length === 0 || unknown.length > 0) throw new ConfigError(`OWNI_GOOGLE_SERVICES: a comma-separated list of ${GOOGLE_SERVICES.join(", ")}${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}`);
		const write = nonEmpty(env.OWNI_GOOGLE_WRITE) ?? "0";
		if (!["0", "1", "true", "false"].includes(write)) throw new ConfigError("OWNI_GOOGLE_WRITE: 1 to let people approve mail and events Owni writes for them, 0 (default) to only read");
		google = { clientId: googleId, clientSecret: googleSecret, redirectUrl, services: [...new Set(services)] as GoogleService[], write: write === "1" || write === "true" };
	}
	const transcribeUrl = nonEmpty(env.OWNI_TRANSCRIBE_URL);
	const transcribeKey = nonEmpty(env.OWNI_TRANSCRIBE_API_KEY);
	let transcription: TranscriberConfig | undefined;
	if (transcribeUrl !== undefined || transcribeKey !== undefined) {
		if (transcribeUrl === undefined || transcribeKey === undefined) throw new ConfigError("Set both OWNI_TRANSCRIBE_URL and OWNI_TRANSCRIBE_API_KEY, or neither");
		serviceUrl("OWNI_TRANSCRIBE_URL", transcribeUrl, "https://api.mistral.ai/v1");
		// Mistral's model unless told otherwise: a service in the EU.
		const model = nonEmpty(env.OWNI_TRANSCRIBE_MODEL) ?? (transcribeUrl.includes("api.mistral.ai") ? "voxtral-mini-latest" : transcribeUrl.includes("api.openai.com") ? "whisper-1" : undefined);
		if (model === undefined) throw new ConfigError("OWNI_TRANSCRIBE_MODEL: the model of this transcription service");
		const maxSeconds = Number(nonEmpty(env.OWNI_TRANSCRIBE_MAX_SECONDS) ?? "300");
		if (!Number.isInteger(maxSeconds) || maxSeconds < 10 || maxSeconds > 3600) throw new ConfigError("OWNI_TRANSCRIBE_MAX_SECONDS: whole seconds between 10 and 3600");
		// The time of each passage of a recording: Mistral and OpenAI's whisper-1 give it, each its own way.
		const mistral = new URL(transcribeUrl).hostname === "api.mistral.ai";
		const timestamps = nonEmpty(env.OWNI_TRANSCRIBE_TIMESTAMPS) ?? (mistral ? "mistral" : model === "whisper-1" ? "openai" : "none");
		if (!(TIMESTAMP_STYLES as readonly string[]).includes(timestamps)) throw new ConfigError(`OWNI_TRANSCRIBE_TIMESTAMPS: one of ${TIMESTAMP_STYLES.join(", ")}`);
		const speakers = nonEmpty(env.OWNI_TRANSCRIBE_SPEAKERS) ?? (mistral ? "1" : "0");
		if (!["0", "1", "true", "false"].includes(speakers)) throw new ConfigError("OWNI_TRANSCRIBE_SPEAKERS: 1 when the service tells voices apart (Mistral's diarize), 0 otherwise");
		const maxMinutes = Number(nonEmpty(env.OWNI_TRANSCRIBE_MAX_MINUTES) ?? "180");
		if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 600) throw new ConfigError("OWNI_TRANSCRIBE_MAX_MINUTES: whole minutes between 1 and 600");
		const minutesPerDay = Number(nonEmpty(env.OWNI_TRANSCRIBE_MINUTES_PER_DAY) ?? "600");
		if (!Number.isInteger(minutesPerDay) || minutesPerDay < 0 || minutesPerDay > 100_000) throw new ConfigError("OWNI_TRANSCRIBE_MINUTES_PER_DAY: whole minutes between 0 and 100000");
		transcription = { url: transcribeUrl, apiKey: transcribeKey, model, maxSeconds, timestamps: timestamps as TimestampStyle, speakers: speakers === "1" || speakers === "true", maxMinutes, minutesPerDay };
	}
	const speechUrl = nonEmpty(env.OWNI_SPEECH_URL);
	const speechKey = nonEmpty(env.OWNI_SPEECH_API_KEY);
	let speech: SpeakerConfig | undefined;
	if (speechUrl !== undefined || speechKey !== undefined) {
		if (speechUrl === undefined || speechKey === undefined) throw new ConfigError("Set both OWNI_SPEECH_URL and OWNI_SPEECH_API_KEY, or neither");
		serviceUrl("OWNI_SPEECH_URL", speechUrl, "https://api.openai.com/v1");
		const openai = speechUrl.includes("api.openai.com");
		const model = nonEmpty(env.OWNI_SPEECH_MODEL) ?? (openai ? "gpt-4o-mini-tts" : undefined);
		if (model === undefined) throw new ConfigError("OWNI_SPEECH_MODEL: the model of this speech service");
		const voice = nonEmpty(env.OWNI_SPEECH_VOICE) ?? (openai ? "nova" : undefined);
		if (voice === undefined) throw new ConfigError("OWNI_SPEECH_VOICE: the voice of this speech service");
		const maxChars = Number(nonEmpty(env.OWNI_SPEECH_MAX_CHARS) ?? "1500");
		if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 4000) throw new ConfigError("OWNI_SPEECH_MAX_CHARS: whole characters between 100 and 4000");
		const maxPerDay = Number(nonEmpty(env.OWNI_SPEECH_MAX_PER_DAY) ?? "300");
		if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100_000) throw new ConfigError("OWNI_SPEECH_MAX_PER_DAY: voice notes per day, a whole number from 1");
		const style = nonEmpty(env.OWNI_SPEECH_STYLE);
		if (style !== undefined && style.length > 500) throw new ConfigError("OWNI_SPEECH_STYLE: at most 500 characters");
		speech = { url: speechUrl.replace(/\/+$/, ""), apiKey: speechKey, model, voice, maxChars, maxPerDay, ...(style === undefined ? {} : { style }) };
	}
	const imageUrl = nonEmpty(env.OWNI_IMAGE_URL);
	const imageKey = nonEmpty(env.OWNI_IMAGE_API_KEY);
	let images: ImageGenerationConfig | undefined;
	if (imageUrl !== undefined || imageKey !== undefined) {
		if (imageUrl === undefined || imageKey === undefined) throw new ConfigError("Set both OWNI_IMAGE_URL and OWNI_IMAGE_API_KEY, or neither");
		serviceUrl("OWNI_IMAGE_URL", imageUrl, "https://api.openai.com/v1");
		const model = nonEmpty(env.OWNI_IMAGE_MODEL) ?? (imageUrl.includes("api.openai.com") ? "gpt-image-1" : undefined);
		if (model === undefined) throw new ConfigError("OWNI_IMAGE_MODEL: the model of this image service");
		const maxPerDay = Number(nonEmpty(env.OWNI_IMAGE_MAX_PER_DAY) ?? "100");
		if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100_000) throw new ConfigError("OWNI_IMAGE_MAX_PER_DAY: pictures per day for each account, a whole number from 1");
		images = { url: imageUrl.replace(/\/+$/, ""), apiKey: imageKey, model, maxPerDay };
	}
	const searchKey = nonEmpty(env.OWNI_SEARCH_API_KEY);
	let webSearch: WebSearchConfig | undefined;
	if (searchKey !== undefined) {
		const url = serviceUrl("OWNI_SEARCH_URL", nonEmpty(env.OWNI_SEARCH_URL) ?? "https://api.search.brave.com/res/v1/web/search", "https://api.search.brave.com/res/v1/web/search");
		const country = (nonEmpty(env.OWNI_SEARCH_COUNTRY) ?? "IT").toUpperCase();
		if (!/^([A-Z]{2}|ALL)$/.test(country)) throw new ConfigError("OWNI_SEARCH_COUNTRY: two letters (IT, FR, US…) or ALL");
		const language = (nonEmpty(env.OWNI_SEARCH_LANG) ?? "it").toLowerCase();
		if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(language)) throw new ConfigError("OWNI_SEARCH_LANG: a language code, e.g. it or en");
		const maxPerDay = Number(nonEmpty(env.OWNI_SEARCH_MAX_PER_DAY) ?? "200");
		if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 100_000) throw new ConfigError("OWNI_SEARCH_MAX_PER_DAY: a whole number from 1 to 100000");
		webSearch = { url, apiKey: searchKey, country, language, maxPerDay };
	} else if (nonEmpty(env.OWNI_SEARCH_URL) !== undefined) {
		throw new ConfigError("OWNI_SEARCH_URL is set without OWNI_SEARCH_API_KEY");
	}
	const weather = loadWeatherConfig(env);
	const exchangeRates = loadExchangeRatesConfig(env);
	const news = loadNewsConfig(env);
	const vatCheck = loadVatCheckConfig(env);
	const computer = loadComputerConfig(env);
	const desktop = loadDesktopConfig(env);
	const token = nonEmpty(env.TELEGRAM_BOT_TOKEN);
	const telegram = token === undefined ? undefined : { token, allowedUsers: ids("OWNI_TELEGRAM_ALLOWED_USERS"), approvers: ids("OWNI_TELEGRAM_APPROVERS"), webhookSecret };
	const timeZone = nonEmpty(env.OWNI_TIME_ZONE) ?? "Europe/Rome";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
	} catch {
		throw new ConfigError(`OWNI_TIME_ZONE="${timeZone}" is not a time zone`);
	}
	if (missing.length > 0) throw new ConfigError(`Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} in .env (see .env.example).`);
	return {
		dataDir: nonEmpty(env.OWNI_DATA_DIR) ?? "data",
		localProviders,
		tenantId: nonEmpty(env.OWNI_TENANT_ID) ?? "default",
		instanceId: nonEmpty(env.OWNI_INSTANCE_ID) ?? "owni",
		instanceName: nonEmpty(env.OWNI_INSTANCE_NAME) ?? "Owni",
		modelProvider,
		modelId,
		modelApiKeys,
		timeZone,
		web: { host: nonEmpty(env.OWNI_WEB_HOST) ?? "127.0.0.1", port, publicUrl },
		telegram,
		cell: { secret: cellSecret },
		google,
		chromiumPath: nonEmpty(env.OWNI_CHROMIUM_PATH),
		screenshotsWithoutSandbox: nonEmpty(env.OWNI_SCREENSHOTS_WITHOUT_SANDBOX) === "1",
		transcription,
		speech,
		images,
		webSearch,
		weather,
		exchangeRates,
		news,
		vatCheck,
		computer,
		desktop,
		phone: { apiBase: (nonEmpty(env.OWNI_TWILIO_API) ?? "https://api.twilio.com").replace(/\/$/, ""), voice: nonEmpty(env.OWNI_PHONE_VOICE) ?? "Polly.Bianca" },
	};
}
