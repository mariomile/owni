import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { asciiLower, decodeEntities, INVISIBLE, withoutBlocks, withoutComments } from "./html-text.ts";

/**
 * Reading a public web page for an instance, without letting it reach anything else: only
 * http(s), only hosts the policy allows, never an address inside a network (loopback, private,
 * link-local, the cloud's metadata endpoint, in any IPv4 or IPv6 spelling), checked on the
 * address actually connected to (so a DNS answer that changes between check and connect does
 * not help), and again after every redirect. Bounded in size and in total time.
 */
export type WebFetchOptions = {
	/** Whether this host may be read at all (the instance's egress policy). */
	readonly hostAllowed: (host: string) => boolean;
	/** Whether an address may be connected to; public addresses only unless a test says otherwise. */
	readonly addressAllowed?: (address: string) => boolean;
	readonly maxBytes?: number;
	/** A different limit by the answer's content type and address (documents are larger than pages); maxBytes otherwise. */
	readonly maxBytesFor?: (contentType: string, url: URL) => number | undefined;
	/** The whole request, redirects included, however slowly the server trickles. */
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
	/** false: a redirect comes back as it is (the browser follows it, through us again). */
	readonly followRedirects?: boolean;
	/** A form being sent (web_submit): POST with this body. A redirect after it is followed with GET, as browsers do. */
	readonly send?: { readonly contentType: string; readonly body: Buffer };
	/** Cookies of this visit, per host: read before each request, filled from each answer. */
	readonly cookies?: CookieJar;
};

/** One cookie as a jar keeps it and a saved profile stores it (plain JSON). */
export type CookieEntry = {
	readonly name: string;
	readonly value: string;
	/** Always the host that set it. */
	readonly domain: string;
	/** false: also its subdomains (it named its own host as Domain). */
	readonly hostOnly: boolean;
	readonly path: string;
	readonly secure: boolean;
	/** Epoch milliseconds. */
	readonly expires: number;
};

const MAX_COOKIES = 50;
const MAX_COOKIE_SIZE = 4096;
const DAY_MS = 86_400_000;
/** Without Max-Age or Expires a cookie would last as long as the browser: here at most 30 days. */
const SESSION_MS = 30 * DAY_MS;
const MAX_LIFE_MS = 400 * DAY_MS;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL = /[\u0000-\u001f\u007f;]/;

/**
 * Cookies of one visit (web_submit) or of one browser, or a person's saved sign-ins (a profile).
 * A cookie goes back only to the host that set it (to its subdomains too when it named that very
 * host as Domain), on its path, a Secure one only over https. Without a public suffix list a parent
 * domain cannot be told from a suffix like "co.uk", so a Domain above the host is not trusted: the
 * cookie stays the host's own, never its siblings'. Bounded: 50 cookies of 4 KB, none past 400 days.
 */
export class CookieJar {
	private readonly cookies = new Map<string, CookieEntry>();

	/** From `snapshot()` (a saved profile). Anything malformed throws: a damaged file gives no cookies, never wrong ones. */
	constructor(snapshot?: unknown) {
		if (snapshot === undefined) return;
		if (!Array.isArray(snapshot) || snapshot.length > MAX_COOKIES) throw new Error("cookie salvati non validi");
		const now = Date.now();
		for (const raw of snapshot) {
			const cookie = cookieEntry(raw);
			if (cookie === undefined) throw new Error("cookie salvati non validi");
			// A clock moved back does not stretch a cookie past the limit.
			if (cookie.expires > now) this.cookies.set(cookieKey(cookie), { ...cookie, expires: Math.min(cookie.expires, now + MAX_LIFE_MS) });
		}
	}

	header(url: URL): string | undefined {
		const host = url.hostname.toLowerCase();
		const now = Date.now();
		const out = [...this.cookies.values()]
			.filter((c) => c.expires > now && reaches(c, host) && pathMatches(url.pathname, c.path) && (!c.secure || url.protocol === "https:"))
			// Longer paths first, as browsers send them.
			.sort((a, b) => b.path.length - a.path.length)
			.map((c) => `${c.name}=${c.value}`);
		return out.length === 0 ? undefined : out.join("; ");
	}

	/** The answer's Set-Cookie lines (headers only, never the body). A malformed or refused cookie is skipped. */
	take(url: URL, setCookies: readonly string[]): void {
		const host = url.hostname.toLowerCase();
		const https = url.protocol === "https:";
		const now = Date.now();
		for (const line of setCookies) {
			const [pair = "", ...parts] = line.split(";");
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			// The last of each attribute counts.
			const attrs = new Map<string, string>();
			for (const part of parts) {
				const at = part.indexOf("=");
				attrs.set((at < 0 ? part : part.slice(0, at)).trim().toLowerCase(), at < 0 ? "" : part.slice(at + 1).trim());
			}
			const named = attrs.get("domain")?.toLowerCase().replace(/^\./, "");
			let hostOnly = true;
			if (named !== undefined && named !== "" && named !== host) {
				// A domain the host is not under is not its to set; a parent one is kept for this host only.
				if (!host.endsWith(`.${named}`)) continue;
			} else if (named === host && isIP(host.replace(/^\[|\]$/g, "")) === 0) hostOnly = false;
			const given = attrs.get("path");
			const path = given?.startsWith("/") ? given : defaultPath(url.pathname);
			const secure = attrs.has("secure");
			// Only https sets a Secure cookie; the prefixes promise what browsers check (RFC 6265bis).
			if (secure && !https) continue;
			const lower = name.toLowerCase();
			if (lower.startsWith("__secure-") && !secure) continue;
			if (lower.startsWith("__host-") && (!secure || attrs.has("domain") || given !== "/")) continue;
			// Plain http neither replaces nor shadows a live Secure cookie of that name: refused wherever a
			// request would carry both (RFC 6265bis 5.7, a host-only cookie kept to its own host).
			const scope = { domain: host, hostOnly, path };
			if (!https && [...this.cookies.values()].some((c) => c.secure && c.expires > now && c.name === name && overlaps(c, scope))) continue;
			const key = `${host};${path};${name}`;
			const maxAge = attrs.get("max-age");
			const expiresAt = Date.parse(attrs.get("expires") ?? "");
			const expires = Math.min(maxAge !== undefined && /^-?\d+$/.test(maxAge) ? now + Number(maxAge) * 1000 : Number.isNaN(expiresAt) ? now + SESSION_MS : expiresAt, now + MAX_LIFE_MS);
			if (expires <= now || value === "") {
				this.cookies.delete(key);
				continue;
			}
			const cookie = cookieEntry({ name, value, domain: host, hostOnly, path, secure, expires });
			if (cookie === undefined) continue;
			// A renewed cookie goes to the end: when the jar is full the oldest goes first.
			this.cookies.delete(key);
			if (this.cookies.size >= MAX_COOKIES) for (const [old, c] of this.cookies) if (c.expires <= now) this.cookies.delete(old);
			if (this.cookies.size >= MAX_COOKIES) this.cookies.delete(this.cookies.keys().next().value as string);
			this.cookies.set(key, cookie);
		}
	}

	/** The live cookies, as plain JSON, for saving. */
	snapshot(): readonly CookieEntry[] {
		const now = Date.now();
		return [...this.cookies.values()].filter((c) => c.expires > now);
	}

	/** Sites that have live cookies here. */
	hosts(): readonly string[] {
		return [...new Set(this.snapshot().map((c) => c.domain))].sort();
	}
}

function cookieKey(c: CookieEntry): string {
	return `${c.domain};${c.path};${c.name}`;
}

/** A well-formed cookie, or undefined: the same rules for an answer's cookie and a saved one. */
function cookieEntry(raw: unknown): CookieEntry | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { name, value, domain, hostOnly, path, secure, expires } = raw as Record<string, unknown>;
	if (typeof name !== "string" || !COOKIE_NAME.test(name)) return undefined;
	if (typeof value !== "string" || value === "" || CONTROL.test(value) || name.length + value.length > MAX_COOKIE_SIZE) return undefined;
	if (typeof domain !== "string" || domain.length > 253 || !canonicalHost(domain)) return undefined;
	if (typeof path !== "string" || !path.startsWith("/") || path.length > 1024 || CONTROL.test(path)) return undefined;
	if (typeof hostOnly !== "boolean" || typeof secure !== "boolean" || typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
	return { name, value, domain, hostOnly, path, secure, expires };
}

function canonicalHost(host: string): boolean {
	try {
		return new URL(`http://${host}/`).hostname === host;
	} catch {
		return false;
	}
}

/** RFC 6265 5.1.4: the request path up to its last "/", "/" when there is none past the first. */
function defaultPath(path: string): string {
	const last = path.lastIndexOf("/");
	return !path.startsWith("/") || last <= 0 ? "/" : path.slice(0, last);
}

function pathMatches(requested: string, path: string): boolean {
	return requested === path || (requested.startsWith(path) && (path.endsWith("/") || requested[path.length] === "/"));
}

type CookieScope = Pick<CookieEntry, "domain" | "hostOnly" | "path">;

/** The cookie goes to this host: its own, or one under it when it named its host as Domain. */
function reaches(c: CookieScope, host: string): boolean {
	return host === c.domain || (!c.hostOnly && host.endsWith(`.${c.domain}`));
}

/** Some request would carry both cookies: a host both go to and a path both match. */
function overlaps(a: CookieScope, b: CookieScope): boolean {
	return (reaches(a, b.domain) || reaches(b, a.domain)) && (pathMatches(a.path, b.path) || pathMatches(b.path, a.path));
}

export type WebPage = {
	readonly url: string;
	readonly status: number;
	readonly contentType: string;
	readonly bytes: Buffer;
	/** The bytes as UTF-8, decoded on first use: a document of 20 MB never needs it. */
	readonly body: string;
	readonly truncated: boolean;
	/** The Content-Disposition header, where a download says its file name. */
	readonly disposition?: string;
	/** Set on a redirect that was not followed. */
	readonly location?: string;
	readonly setCookies: readonly string[];
};

export const USER_AGENT = "Owni/1.0 (+https://github.com/mariomile/owni)";

export class WebFetchRefused extends Error {
	override readonly name = "WebFetchRefused";
}

/** Bodies larger than a page being received at once, in the whole process: documents add up. */
const LARGE_BODIES = { maxBytes: 100 * 1024 * 1024 };
let largeBytes = 0;

type Answer = Omit<WebPage, "url" | "body">;

/** The page with its text decoded only if someone reads it. */
function pageOf(answer: Answer, url: string, location?: string): WebPage {
	let text: string | undefined;
	return {
		...answer,
		url,
		...(location === undefined ? {} : { location }),
		get body() {
			text ??= answer.bytes.toString("utf8");
			return text;
		},
	};
}

export async function webFetch(url: string, options: WebFetchOptions): Promise<WebPage> {
	let current = url;
	let send = options.send;
	const until = Date.now() + (options.timeoutMs ?? 15_000);
	for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
		const target = checkedUrl(current, options);
		const answer = await get(target, { ...options, send }, until);
		options.cookies?.take(target, answer.setCookies);
		if (answer.status >= 300 && answer.status < 400 && answer.location !== undefined) {
			const next = new URL(answer.location, target).toString();
			if (options.followRedirects === false) return pageOf(answer, target.toString(), next);
			// 307 and 308 keep the method and the body; the others turn into a GET. A form goes
			// only where the person approved it: never on to another origin with its body.
			if (answer.status !== 307 && answer.status !== 308) send = undefined;
			else if (send !== undefined && new URL(next).origin !== target.origin) throw new WebFetchRefused(`il sito voleva inoltrare il modulo a ${new URL(next).host}, non approvato`);
			current = next;
			continue;
		}
		return pageOf(answer, target.toString());
	}
	throw new WebFetchRefused("troppi redirect");
}

/** Whether a URL may be fetched at all, before any connection: scheme, credentials, IP literal, host list. */
export function checkedUrl(raw: string, options: Pick<WebFetchOptions, "hostAllowed" | "addressAllowed">): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new WebFetchRefused("indirizzo non valido");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebFetchRefused("solo indirizzi http e https");
	if (url.username !== "" || url.password !== "") throw new WebFetchRefused("niente credenziali nell'indirizzo");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) !== 0 && !(options.addressAllowed ?? publicAddress)(host)) throw new WebFetchRefused(`${host} è un indirizzo interno`);
	if (!options.hostAllowed(host)) throw new WebFetchRefused(`${host} non è tra i siti che questo agente può leggere`);
	return url;
}

function get(url: URL, options: WebFetchOptions, until: number): Promise<Answer> {
	const allowed = options.addressAllowed ?? publicAddress;
	const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const left = Math.max(1, until - Date.now());
	// The check runs on the address the socket connects to.
	const lookup = (hostname: string, opts: object, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
		dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
			if (error) return callback(error, "");
			const list = addresses as LookupAddress[];
			const bad = list.find((a) => !allowed(a.address));
			if (bad !== undefined) return callback(new WebFetchRefused(`${hostname} porta a un indirizzo interno`), "");
			if ((opts as { all?: boolean }).all) return callback(null, list);
			callback(null, list[0]?.address ?? "", list[0]?.family);
		});
	};
	return new Promise((resolve, reject) => {
		let counted = 0;
		const release = () => {
			largeBytes -= counted;
			counted = 0;
		};
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1", "accept-encoding": "identity" };
		const cookie = options.cookies?.header(url);
		if (cookie !== undefined) headers.cookie = cookie;
		if (options.send !== undefined) {
			headers["content-type"] = options.send.contentType;
			headers["content-length"] = String(options.send.body.length);
		}
		const req = send(url, { method: options.send === undefined ? "GET" : "POST", lookup, agent: false, headers }, (res: IncomingMessage) => {
			const status = res.statusCode ?? 0;
			const contentType = String(res.headers["content-type"] ?? "");
			const setCookies = res.headers["set-cookie"] ?? [];
			const disposition = res.headers["content-disposition"];
			const limit = status >= 300 && status < 400 ? maxBytes : (options.maxBytesFor?.(contentType, url) ?? maxBytes);
			// A large body counts against the process's budget while it arrives.
			const large = limit > 2 * 1024 * 1024;
			const done = (bytes: Buffer, truncated: boolean, location?: string) => {
				clearTimeout(deadline);
				release();
				resolve({ status, contentType, bytes, truncated, setCookies, ...(location === undefined ? {} : { location }), ...(disposition === undefined ? {} : { disposition }) });
			};
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				return done(Buffer.alloc(0), false, res.headers.location);
			}
			// One buffer of the announced size when there is one: no second copy at the end.
			const announced = Number(res.headers["content-length"]);
			let into = Number.isSafeInteger(announced) && announced > 0 && announced <= limit ? Buffer.allocUnsafe(announced) : undefined;
			const chunks: Buffer[] = [];
			let size = 0;
			let truncated = false;
			const collected = () => (into !== undefined ? into.subarray(0, size) : Buffer.concat(chunks));
			res.on("data", (chunk: Buffer) => {
				if (truncated) return;
				if (large) {
					counted += chunk.length;
					largeBytes += chunk.length;
					if (largeBytes > LARGE_BODIES.maxBytes) {
						res.destroy();
						release();
						clearTimeout(deadline);
						return reject(new WebFetchRefused("troppi documenti in arrivo insieme, riprova tra poco"));
					}
				}
				const room = limit - size;
				const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
				if (into !== undefined && size + part.length > into.length) {
					// The server sent more than it said: back to pieces.
					chunks.push(into.subarray(0, size));
					into = undefined;
				}
				if (into !== undefined) part.copy(into, size);
				else chunks.push(part);
				size += part.length;
				if (chunk.length > room) {
					truncated = true;
					res.destroy();
					return done(collected(), true);
				}
			});
			res.on("end", () => done(collected(), truncated));
			res.on("error", (error) => {
				clearTimeout(deadline);
				release();
				reject(error);
			});
		});
		// A total deadline: a server sending a byte at a time never trips an idle timeout.
		const deadline = setTimeout(() => req.destroy(new WebFetchRefused(`la pagina non arriva in ${timeoutMs / 1000} secondi`)), left);
		req.on("error", (error) => {
			clearTimeout(deadline);
			release();
			reject(error);
		});
		req.end(options.send?.body);
	});
}

/** Public unicast addresses only: no loopback, private, link-local, CGNAT, multicast or reserved ranges, in any spelling. */
export function publicAddress(address: string): boolean {
	if (isIP(address) === 4) return publicV4(address);
	if (isIP(address) !== 6) return false;
	const words = ipv6Words(address);
	if (words === undefined) return false;
	const v4At = (i: number) => `${words[i]! >> 8}.${words[i]! & 255}.${words[i + 1]! >> 8}.${words[i + 1]! & 255}`;
	const zeros = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);
	// ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): the IPv4 inside decides.
	if (zeros(0, 6)) return words[6] !== 0 || words[7]! > 1 ? publicV4(v4At(6)) : false;
	if (zeros(0, 5) && words[5] === 0xffff) return publicV4(v4At(6));
	const first = words[0]!;
	if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
	if (first === 0x64 && words[1] === 0xff9b) return false; // 64:ff9b::/96 NAT64, reaches any IPv4
	if (first === 0x2001 && words[1] === 0) return false; // 2001::/32 Teredo, IPv4 hidden inside
	if (first === 0x2002) return publicV4(v4At(1)); // 2002::/16 6to4, IPv4 in the next 32 bits
	if (first === 0x2001 && words[1] === 0x0db8) return false; // documentation
	return true;
}

function publicV4(v4: string): boolean {
	const [a = 0, b = 0] = v4.split(".").map(Number);
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	return true;
}

/** The eight 16-bit words of an IPv6 address, whatever its spelling ("::", embedded IPv4, zone). */
function ipv6Words(address: string): number[] | undefined {
	let text = address.toLowerCase().replace(/%.*$/, "");
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
	if (v4 !== undefined) {
		const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map(Number);
		text = `${text.slice(0, -v4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", tail] = text.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = tail === undefined || tail === "" ? [] : tail.split(":");
	const fill = tail === undefined ? 0 : 8 - left.length - right.length;
	const words = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right].map((w) => Number.parseInt(w, 16));
	return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : undefined;
}

/** The readable text of an HTML page, and its title. Linear in the page's size: no backtracking regex. */
export function pageText(html: string): { title: string; text: string } {
	// ASCII only: a lowercase that changed the length would shift every index below.
	const lower = asciiLower(html);
	const titleStart = lower.indexOf("<title");
	const titleOpen = titleStart < 0 ? -1 : lower.indexOf(">", titleStart);
	const titleEnd = titleOpen < 0 ? -1 : lower.indexOf("</title", titleOpen);
	const title = titleEnd < 0 ? "" : html.slice(titleOpen + 1, titleEnd).trim();
	const text = withoutComments(withoutBlocks(html, ["script", "style", "noscript", "svg", "template", "title"], lower))
		.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
		.replace(/<[^>]*>/g, " ");
	// Invisible characters out, line breaks kept (INVISIBLE holds the controls, \n among them).
	const visible = (t: string) => t.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(INVISIBLE, " ")).join("\n");
	return { title: visible(decodeEntities(title)).replace(/\s+/g, " ").trim(), text: visible(decodeEntities(text)).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim() };
}
