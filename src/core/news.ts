/**
 * News headlines for instances: the RSS and Atom feeds of public newspapers and agencies, chosen
 * by the operator (a short built-in list by default). Only those fixed addresses are fetched, and
 * a redirect only to a public https address: nothing the person writes, a topic included, leaves
 * the server. Feeds are read with a few linear-time scans, never an XML library, and everything
 * they say is untrusted text.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decodeEntities, INVISIBLE, withoutBlocks } from "./html-text.ts";
import { getText, type HttpProblem, type RedirectRule } from "./http.ts";
import { pool } from "./pool.ts";
import { publicAddress } from "./web-fetch.ts";

/** The sections a feed can be tagged with: what people ask for («le ultime di economia»). */
export const NEWS_SECTIONS = ["ultima ora", "italia", "politica", "mondo", "economia", "tecnologia", "sport"] as const;
export type NewsSection = (typeof NEWS_SECTIONS)[number];

export type NewsFeed = {
	/** Shown with every headline and matched by the tool's source: 1 to 40 characters. */
	readonly name: string;
	/** An https address, fixed by the operator. */
	readonly url: string;
	readonly section?: NewsSection;
};

export type NewsConfig = { readonly feeds: readonly NewsFeed[] };

/** Feeds the operator may list in OWNI_NEWS_FEEDS, at most. */
export const MAX_FEEDS = 30;
/** A feed's name, at most, in characters. */
export const MAX_FEED_NAME = 40;

/**
 * The built-in feeds, when the operator sets no OWNI_NEWS_FEEDS: well-known public feeds,
 * Italian first, one or more per section. The addresses could not be fetched where this list was
 * written: verify them with `pnpm owni check`, which fetches each one and names those that fail.
 */
export const DEFAULT_NEWS_FEEDS: readonly NewsFeed[] = [
	{ name: "ANSA Ultima ora", url: "https://www.ansa.it/sito/notizie/topnews/topnews_rss.xml", section: "ultima ora" },
	{ name: "Rai News", url: "https://www.rainews.it/rss/tutti", section: "ultima ora" },
	{ name: "Sky TG24", url: "https://tg24.sky.it/rss/tg24.xml", section: "ultima ora" },
	{ name: "Corriere della Sera", url: "https://xml2.corriereobjects.it/rss/homepage.xml", section: "italia" },
	{ name: "la Repubblica", url: "https://www.repubblica.it/rss/homepage/rss2.0.xml", section: "italia" },
	{ name: "Il Post", url: "https://www.ilpost.it/feed/", section: "italia" },
	{ name: "ANSA Cronaca", url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml", section: "italia" },
	{ name: "ANSA Politica", url: "https://www.ansa.it/sito/notizie/politica/politica_rss.xml", section: "politica" },
	{ name: "ANSA Mondo", url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml", section: "mondo" },
	{ name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", section: "mondo" },
	{ name: "ANSA Economia", url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml", section: "economia" },
	{ name: "Il Sole 24 Ore", url: "https://www.ilsole24ore.com/rss/economia.xml", section: "economia" },
	{ name: "ANSA Tecnologia", url: "https://www.ansa.it/sito/notizie/tecnologia/tecnologia_rss.xml", section: "tecnologia" },
	{ name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", section: "tecnologia" },
	{ name: "ANSA Sport", url: "https://www.ansa.it/sito/notizie/sport/sport_rss.xml", section: "sport" },
];

export type Headline = {
	readonly title: string;
	/** An http(s) address, shown to the person and never fetched here. */
	readonly link?: string;
	/** Plain text, at most SUMMARY_CHARS. */
	readonly summary?: string;
	/** Milliseconds since the epoch; undefined when the feed gave no date that parses. */
	readonly published?: number;
	/** The feed gave a day without a time: published is that day's midnight UTC, and no time is shown. */
	readonly dateOnly?: true;
};

export type FeedResult = { readonly feed: NewsFeed; readonly headlines: readonly Headline[] } | { readonly feed: NewsFeed; readonly error: string };

export type ReadOptions = {
	/** Return what has arrived by then, the others named as late; they go on filling the cache. */
	readonly deadlineMs?: number;
};

export type News = {
	readonly feeds: readonly NewsFeed[];
	/** The headlines of each feed, in the feeds' order: a feed that fails or is late is named, never thrown. */
	read(feeds: readonly NewsFeed[], options?: ReadOptions): Promise<FeedResult[]>;
};

export type NewsOptions = {
	/** Each feed's own time, redirects and body included: 6 seconds for a person waiting, more for pnpm owni check. */
	readonly timeoutMs?: number;
	/** Tests: the addresses of a host a redirect points to. */
	readonly resolve?: (host: string) => Promise<readonly string[]>;
};

/** A failed download or a file that is not a feed: a reason in Italian, never the address. */
class NewsError extends Error {}

const MINUTE = 60_000;
/** A feed is a few hundred kilobytes at most; past this it is not a feed. */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6_000;
/** Feeds fetched at once: enough for the list in a few seconds, without a burst. */
const CONCURRENCY = 4;
/** A feed is kept this long: news moves, but not by the minute. */
const TTL_MS = 10 * MINUTE;
/** A failed feed is answered with the same error for this long, without asking again. */
const FAILURE_TTL_MS = 2 * MINUTE;
/** Redirects followed, at most: a moved feed takes one or two. */
const MAX_REDIRECTS = 3;
/** Items read from one feed, at most. */
export const MAX_ITEMS = 100;
export const SUMMARY_CHARS = 240;
const TITLE_CHARS = 300;
const LINK_CHARS = 2000;
export const LATE = "non ha risposto in tempo";
/** A date further ahead than this is a feed's mistake or a trick: the headline counts as undated. */
const MAX_AHEAD_MS = 24 * 60 * MINUTE;

type Entry = { readonly at: number; readonly result: Promise<Headline[]>; failed?: boolean };

/** The feeds in config, each kept in memory for ten minutes (a failure for two), fetched four at a time. */
export function feedNews(config: NewsConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date(), options: NewsOptions = {}): News {
	const cache = new Map<string, Entry>();
	const redirects = feedRedirects(options.resolve ?? systemResolve);
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	// When this process first saw each headline of a feed: a time no feed can move forward.
	const firstSeen = new Map<string, Map<string, number>>();
	const load = (feed: NewsFeed): Promise<Headline[]> => {
		const at = now().getTime();
		const hit = cache.get(feed.url);
		if (hit !== undefined && at - hit.at < (hit.failed === true ? FAILURE_TTL_MS : TTL_MS)) return hit.result;
		const entry: Entry = { at, result: fetchFeed(feed, { fetchImpl, now, timeoutMs, redirects }).then((headlines) => seenFirst(headlines, firstSeen, feed.url, now().getTime())) };
		entry.result.catch(() => {
			entry.failed = true;
		});
		cache.set(feed.url, entry);
		return entry.result;
	};
	return {
		feeds: config.feeds,
		async read(feeds, { deadlineMs } = {}) {
			const settled = new Map<NewsFeed, FeedResult>();
			const all = pool(feeds, CONCURRENCY, async (feed): Promise<FeedResult> => {
				let result: FeedResult;
				try {
					result = { feed, headlines: await load(feed) };
				} catch (error) {
					result = { feed, error: error instanceof NewsError ? error.message : "non risponde" };
				}
				settled.set(feed, result);
				return result;
			});
			if (deadlineMs === undefined) return all;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), deadlineMs);
			});
			const done = await Promise.race([all, late]);
			clearTimeout(timer);
			return done ?? feeds.map((feed) => settled.get(feed) ?? { feed, error: LATE });
		},
	};
}

/**
 * Each timed headline at most as recent as the first time this process saw it: a feed that dates
 * its items in the future, or always at the moment it is asked, cannot keep them at the top. The
 * map holds only the feed's current items, so it never grows past MAX_ITEMS a feed. A day alone
 * keeps its day: it is compared as a calendar day, never moved.
 */
function seenFirst(headlines: readonly Headline[], firstSeen: Map<string, Map<string, number>>, url: string, now: number): Headline[] {
	const before = firstSeen.get(url) ?? new Map<string, number>();
	const after = new Map<string, number>();
	const out = headlines.map((h) => {
		const key = h.link ?? `t:${h.title}`;
		const seen = after.get(key) ?? before.get(key) ?? now;
		after.set(key, seen);
		return h.published === undefined || h.dateOnly === true ? h : { ...h, published: Math.min(h.published, seen) };
	});
	firstSeen.set(url, after);
	return out;
}

type Fetching = { readonly fetchImpl: typeof fetch; readonly now: () => Date; readonly timeoutMs: number; readonly redirects: RedirectRule };

async function fetchFeed(feed: NewsFeed, { fetchImpl, now, timeoutMs, redirects }: Fetching): Promise<Headline[]> {
	const accept = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8";
	const xml = await getText(new URL(feed.url), { fetch: fetchImpl, headers: { accept }, maxBytes: MAX_BYTES, timeoutMs, redirect: redirects }, newsError);
	if (!looksLikeFeed(xml)) throw new NewsError("non ha mandato un feed");
	return parseFeed(xml, feed.url, now().getTime());
}

function newsError(problem: HttpProblem): NewsError {
	if (problem.kind === "status") return new NewsError(`risponde ${problem.status}`);
	return new NewsError({ unreachable: "non risponde", too_big: "ha mandato un file troppo grande", unreadable: "ha mandato un file illeggibile", redirect: "rimanda a un indirizzo non consentito" }[problem.kind]);
}

/**
 * A feed that moved is followed, at most three times, only to https on the standard port and
 * only to a host whose every address is public (no loopback, private network or cloud metadata
 * endpoint): an operator's feed cannot be turned into a probe of the server's network.
 */
function feedRedirects(resolve: (host: string) => Promise<readonly string[]>): RedirectRule {
	return {
		max: MAX_REDIRECTS,
		async allowed(url) {
			if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")) return false;
			const host = url.hostname.replace(/^\[|\]$/g, "");
			if (isIP(host) !== 0) return publicAddress(host);
			try {
				const addresses = await resolve(host);
				return addresses.length > 0 && addresses.every(publicAddress);
			} catch {
				return false;
			}
		},
	};
}

async function systemResolve(host: string): Promise<string[]> {
	return (await lookup(host, { all: true })).map((a) => a.address);
}

/**
 * An RSS, RDF or Atom document: markup from the first character (after a byte order mark and
 * spaces) and the root element within the first kilobytes. A web page, JSON or an error text is
 * refused: fail closed rather than read headlines out of something else.
 */
export function looksLikeFeed(text: string): boolean {
	const head = text.slice(0, 4096).replace(/^\ufeff/, "");
	return /^\s*</.test(head) && !/<html[\s>]/i.test(head) && /<(?:rss|feed|rdf:RDF)[\s>]/.test(head);
}

/**
 * The items of an RSS 2.0 or 1.0 feed, or the entries of an Atom one, in the feed's order, at most
 * MAX_ITEMS. Each needs a title; a link counts only when http(s), a relative one resolved against
 * the feed's address without its query (which may hold the operator's token); a date only when it
 * parses and is at most a day ahead of `now` (a day alone may be tomorrow in UTC and today in
 * Rome). Every scan moves forward with indexOf, so any input, a hostile one included, is read in
 * linear time.
 */
export function parseFeed(xml: string, feedUrl: string, now: number): Headline[] {
	const head = xml.slice(0, 4096);
	const atom = !/<(?:rss|rdf:RDF)[\s>]/.test(head) && /<feed[\s>]/.test(head);
	const base = new URL(feedUrl);
	base.search = "";
	base.hash = "";
	const headlines: Headline[] = [];
	for (const block of elements(xml, atom ? "entry" : "item")) {
		const title = clip(feedText(inner(block, ["title"]) ?? ""), TITLE_CHARS);
		if (title === "") continue;
		const rssLink = () => webLink(feedText(inner(block, ["link"]) ?? ""), base) ?? guidLink(block);
		const link = atom ? atomLink(block, base) : rssLink();
		const summary = clip(feedText(inner(block, atom ? ["summary", "content"] : ["description", "content:encoded"]) ?? ""), SUMMARY_CHARS);
		const date = parseDate(feedText(inner(block, atom ? ["published", "updated"] : ["pubDate", "dc:date"]) ?? ""));
		const trusted = date !== undefined && date.at - now <= MAX_AHEAD_MS ? date : undefined;
		headlines.push({
			title,
			...(link === undefined ? {} : { link }),
			...(summary === "" ? {} : { summary }),
			...(trusted === undefined ? {} : { published: trusted.at }),
			...(trusted?.dateOnly === true ? { dateOnly: true as const } : {}),
		});
		if (headlines.length >= MAX_ITEMS) break;
	}
	return headlines;
}


/** The contents of each `<tag …>…</tag>` in turn; an element left open ends the scan. */
function* elements(xml: string, tag: string): Generator<string> {
	const open = `<${tag}`;
	const close = `</${tag}>`;
	let from = 0;
	for (;;) {
		const start = xml.indexOf(open, from);
		if (start < 0) return;
		const after = xml.charAt(start + open.length);
		if (after !== ">" && !/\s/.test(after)) {
			from = start + open.length;
			continue;
		}
		const bodyStart = xml.indexOf(">", start);
		if (bodyStart < 0) return;
		if (xml.charAt(bodyStart - 1) === "/") {
			from = bodyStart + 1;
			continue;
		}
		const end = xml.indexOf(close, bodyStart);
		if (end < 0) return;
		yield xml.slice(bodyStart + 1, end);
		from = end + close.length;
	}
}

/** The contents of the first of `tags` found in the block. */
function inner(block: string, tags: readonly string[]): string | undefined {
	for (const tag of tags) {
		for (const found of elements(block, tag)) return found;
	}
	return undefined;
}

/** An Atom entry's link: the first `rel="alternate"` or without rel, else the first with an href. */
function atomLink(block: string, base: URL): string | undefined {
	const links = [...block.matchAll(/<link\b([^<>]*)>/g)].map(([, attributes = ""]) => ({ rel: attribute(attributes, "rel"), href: attribute(attributes, "href") }));
	const chosen = links.find((l) => l.href !== undefined && (l.rel === undefined || l.rel === "alternate")) ?? links.find((l) => l.href !== undefined);
	return chosen?.href === undefined ? undefined : webLink(decodeEntities(chosen.href), base);
}

/** An RSS guid as the link of feeds that leave `<link>` out: only a permalink that is a whole http(s) address on its own. */
function guidLink(block: string): string | undefined {
	const match = /<guid\b([^<>]*)>/.exec(block);
	if (match === null || attribute(match[1] ?? "", "isPermaLink") === "false") return undefined;
	return webLink(feedText(inner(block, ["guid"]) ?? ""));
}

function attribute(attributes: string, name: string): string | undefined {
	return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find((v) => v !== undefined);
}

/** An http(s) address, resolved against `base` when given; anything else (javascript:, data:…) is no link. */
function webLink(raw: string, base?: URL): string | undefined {
	const text = raw.trim();
	if (text === "" || text.length > LINK_CHARS) return undefined;
	try {
		const url = new URL(text, base);
		return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" ? url.href : undefined;
	} catch {
		return undefined;
	}
}


/**
 * The text of a feed field: CDATA unwrapped, entities decoded, then tags (and what scripts and
 * styles hold) dropped, twice, since many feeds escape their HTML once more; invisible characters
 * and runs of spaces become one space.
 */
function feedText(raw: string): string {
	const once = stripTags(unwrapCdata(raw));
	return stripTags(decodeEntities(once)).replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

/** CDATA sections as their literal text, entities decoded outside them. An unclosed one runs to the end. */
function unwrapCdata(raw: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const start = raw.indexOf("<![CDATA[", from);
		if (start < 0) return out + decodeEntities(raw.slice(from));
		out += decodeEntities(raw.slice(from, start));
		const end = raw.indexOf("]]>", start + 9);
		if (end < 0) return out + raw.slice(start + 9);
		out += raw.slice(start + 9, end);
		from = end + 3;
	}
}

/** Script and style out with what they hold, then whatever looks like a tag: «spread >150» and «a < b» stay. `[^<>]` keeps the scan linear. */
function stripTags(text: string): string {
	return withoutBlocks(text, ["script", "style"]).replace(/<\/?[A-Za-z!][^<>]*>/g, " ");
}

/** At most `max` characters, cut at a space with an ellipsis. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Month abbreviations in English (RFC 822) and in Italian, which Italian feeds write too. */
const MONTHS = new Map<string, number>([..."jan feb mar apr may jun jul aug sep oct nov dec".split(" ").map((m, i) => [m, i] as const), ..."gen feb mar apr mag giu lug ago set ott nov dic".split(" ").map((m, i) => [m, i] as const)]);
/** RFC 822's zones, and the European ones feeds write though the RFC has no name for them. */
const ZONES = new Map<string, number>(Object.entries({ UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, WET: 0, WEST: 1, BST: 1, CET: 1, CEST: 2, EET: 2, EEST: 3 }));
/**
 * The weekday in front (Sat, sab, sabato) is skipped, with or without a comma and a space after it;
 * day, month and year apart by spaces or, as RFC 850 writes them, dashes (17-Oct-26); the time may
 * be missing, and then it is a day alone.
 */
const RFC822 = /^(?:\p{L}{3,9}\.?,?\s*)?(\d{1,2})[\s-]+(\p{L}{3})\p{L}*\.?[\s-]+(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(?:([+-])(\d{2}):?(\d{2})|([A-Za-z]{1,5}))?$/u;
const ISO8601 = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?)?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i;

export type FeedDate = { readonly at: number; readonly dateOnly: boolean };

/**
 * An RFC 822 date (RSS's pubDate: «Sat, 17 Oct 2026 14:32:00 +0200», also with Italian names:
 * «sab, 17 ott 2026») or an ISO 8601 one (Atom, dc:date: «2026-10-17T14:32:00Z», or a day alone),
 * in milliseconds; a time without a zone, or with a zone name not known, is UTC; without a time it
 * is a day alone, at its midnight UTC. Undefined for anything else, or a day or time that does not exist.
 */
export function parseDate(text: string): FeedDate | undefined {
	const value = text.trim();
	if (value === "" || value.length > 64) return undefined;
	const rfc = RFC822.exec(value);
	if (rfc !== null) {
		const [, day, monthName = "", yearText = "", hour, minute, second, sign, zoneHours, zoneMinutes, zoneName] = rfc;
		const month = MONTHS.get(monthName.toLowerCase());
		const year = yearText.length === 2 ? (Number(yearText) < 50 ? 2000 : 1900) + Number(yearText) : Number(yearText);
		let offset = 0;
		if (sign !== undefined) offset = (sign === "-" ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes));
		// A zone name not in the list (feeds invent some) is read as UTC: off by a few hours at most.
		else if (zoneName !== undefined) offset = (ZONES.get(zoneName.toUpperCase()) ?? 0) * 60;
		if (month === undefined) return undefined;
		const at = hour === undefined ? utc(year, month, Number(day), 0, 0, 0, 0) : utc(year, month, Number(day), Number(hour), Number(minute), Number(second ?? 0), offset);
		return at === undefined ? undefined : { at, dateOnly: hour === undefined };
	}
	const iso = ISO8601.exec(value);
	if (iso === null) return undefined;
	const [, year, month, day, hour, minute, second, , sign, zoneHours, zoneMinutes] = iso;
	// A day alone is that calendar day as written, whatever zone follows it.
	const offset = sign === undefined || hour === undefined ? 0 : (sign === "-" ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes));
	const at = utc(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0), offset);
	return at === undefined ? undefined : { at, dateOnly: hour === undefined };
}

/** The instant, when every field is in range (no 30 February, no 25:00). */
function utc(year: number, month: number, day: number, hour: number, minute: number, second: number, offsetMinutes: number): number | undefined {
	if (hour > 23 || minute > 59 || second > 60 || Math.abs(offsetMinutes) > 14 * 60) return undefined;
	const local = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
	const check = new Date(local);
	if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
	return local - offsetMinutes * MINUTE;
}
