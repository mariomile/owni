import { randomBytes } from "node:crypto";
import { checkedUrl, CookieJar, USER_AGENT, WebFetchRefused, webFetch, type WebPage } from "./web-fetch.ts";
import type { BrowserProfiles } from "./web-profiles.ts";

/** What the browser needs from Chromium (Playwright's Browser satisfies it). */
export type Browser = {
	newContext(options: { viewport: { width: number; height: number }; userAgent: string; acceptDownloads: boolean; serviceWorkers: "block" }): Promise<BrowserContext>;
	close(): Promise<void>;
	on(event: "disconnected", listener: () => void): unknown;
};
export type BrowserContext = {
	route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
	routeWebSocket(url: RegExp, handler: (socket: { close(): Promise<void> }) => Promise<void> | void): Promise<void>;
	exposeBinding?(name: string, callback: (source: { page: Page; frame: unknown }, document: unknown, edit: unknown, value: unknown) => Promise<boolean>): Promise<void>;
	addInitScript(script: string): Promise<void>;
	on(event: "page", listener: (page: Page) => void): unknown;
	newPage(): Promise<Page>;
	close(): Promise<void>;
};
type Route = {
	request(): { url(): string; method(): string; isNavigationRequest(): boolean; frame?(): unknown; headers?(): Record<string, string>; postDataBuffer?(): Buffer | null };
	fulfill(response: { status: number; headers?: Record<string, string>; body?: Buffer }): Promise<void>;
	abort(reason?: string): Promise<void>;
};
export type Page = {
	mainFrame?(): unknown;
	goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	goBack(options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	screenshot(options: { fullPage: boolean; type: "png"; timeout?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
	title(): Promise<string>;
	url(): string;
	evaluate<T>(expression: string): Promise<T>;
	click(selector: string, options: { timeout: number }): Promise<void>;
	mouse: { click(x: number, y: number): Promise<void> };
	fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
	selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
	press(selector: string, key: string, options: { timeout: number }): Promise<void>;
	waitForLoadState(state: "load", options: { timeout: number }): Promise<void>;
	/** Listening to this makes Chromium hold back its file chooser: the page never gets to open one. */
	on(event: "filechooser", listener: () => void): void;
	close(): Promise<void>;
};

/** The guard of every request a page makes: the owner's sites, never an internal address. */
export type Guard = { readonly hostAllowed: (host: string) => boolean; readonly addressAllowed: (address: string) => boolean };

/** What a page may load in all, per screenshot or per page of a browser session. */
export type Budget = { requests: number; bytes: number };

/** What the routing refused or is still doing, told to Owni after each action. */
export type Traffic = { sends: Set<string>; hosts: Set<string>; files: Set<string>; overBudget: boolean; inflight: number };

/** Each list of refused things stays short: a page cannot grow it without end. */
const MAX_NOTED = 8;
/** Methods named as they are; any other token a page invents is just "altro". */
const METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function noted(set: Set<string>, value: string): void {
	if (set.size < MAX_NOTED) set.add(value.slice(0, 120));
}

/**
 * Chromium touches no network: every request a page makes is answered by the guarded fetch, one
 * redirect at a time, GET or the person's basic form, within a budget. WebSockets close. Anything else is refused and,
 * with `traffic`, noted (ADR 0009, ADR 0014).
 */
type BrowserAccess = { allowed(): Promise<boolean>; current(): boolean; page(): Page | undefined; human(): boolean; retain(): Promise<void>; submitted(host: string): void; redact(text: string): string };
export async function guardContext(context: BrowserContext, guard: () => Guard, budget: Budget, traffic?: Traffic, cookies?: CookieJar, access?: BrowserAccess): Promise<void> {
	await context.routeWebSocket(/.*/, (socket) => socket.close());
	await context.route("**/*", async (route) => {
		const request = route.request();
		const target = request.url();
		const clean = (text: string) => access?.redact(text) ?? text;
		if (/^(data|blob|about):/.test(target)) return route.fulfill({ status: 204 });
		const host = hostOf(target);
		if (access !== undefined && !(await access.allowed())) return route.abort("blockedbyclient");
		const page = access?.page();
		const top = request.isNavigationRequest() && page?.mainFrame !== undefined && request.frame?.() === page.mainFrame();
		if (top && access !== undefined) {
			// An input handler can submit DURING fill/press. Wait for the source document's
			// input-event acknowledgement before serving a destination that discards it.
			try { await access.retain(); }
			catch { return route.abort("blockedbyclient"); }
			if (!access.current()) return route.abort("blockedbyclient");
		}
		let send: { contentType: string; body: Buffer } | undefined;
		if (request.method() === "POST" && top && access?.human()) {
			const contentType = request.headers?.()["content-type"] ?? "";
			const body = request.postDataBuffer?.();
			// Only a basic form sent from this page, never a cross-origin credential redirect.
			if (contentType.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded" && body !== null && body !== undefined && body.length <= 64 * 1024 && new URL(target).origin === new URL(page.url()).origin) send = { contentType, body };
		}
		if (request.method() !== "GET" && send === undefined) {
			// A send to a site that is not allowed (an analytics beacon) is only a blocked host.
			if (traffic !== undefined) {
				if (guard().hostAllowed(host.replace(/:\d+$/, ""))) noted(traffic.sends, clean(`${METHODS.has(request.method()) ? request.method() : "altro"} ${host}`));
				else noted(traffic.hosts, clean(host));
			}
			return route.abort("blockedbyclient");
		}
		if (--budget.requests < 0) {
			if (traffic !== undefined) traffic.overBudget = true;
			return route.abort("blockedbyclient");
		}
		if (traffic !== undefined) traffic.inflight++;
		try {
			let current = target;
			let answer: WebPage;
			for (let hop = 0; ; hop++) {
				if (access !== undefined && (!(await access.allowed()) || !access.current())) throw new WebFetchRefused("accesso al browser revocato");
				const firstParty = access === undefined || top || (page !== undefined && hostOf(page.url()) === hostOf(current));
				answer = await webFetch(current, { ...guard(), followRedirects: false, maxBytes: Math.min(5 * 1024 * 1024, Math.max(0, budget.bytes)), timeoutMs: 10_000, ...(cookies === undefined || !firstParty ? {} : { cookies }), ...(send === undefined ? {} : { send }) });
				if (send !== undefined) access?.submitted(hostOf(current));
				if (answer.location === undefined) break;
				checkedUrl(answer.location, guard());
				if (send !== undefined && (answer.status === 307 || answer.status === 308)) throw new WebFetchRefused("questo reindirizzamento richiederebbe un altro invio: non supportato");
				if (request.isNavigationRequest()) {
					// Chromium bypasses context.route on native HTTP redirect chains. A fresh
					// navigation re-enters the guard, loads cookies and cannot replay a POST body.
					const destination = JSON.stringify(answer.location).replaceAll("<", "\\u003c");
					return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(`<!doctype html><script>location.replace(${destination})</script>`) });
				}
				if (hop >= 5 || --budget.requests < 0) throw new WebFetchRefused("troppi redirect");
				current = answer.location;
			}
			budget.bytes -= answer.bytes.length;
			const type = answer.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
			// A link to a file (a PDF, a spreadsheet): the browser does not download, Owni is told.
			if (traffic !== undefined && request.isNavigationRequest() && answer.status < 300 && type !== "" && !/^(text\/(html|plain)|application\/xhtml\+xml)$/.test(type)) {
				noted(traffic.files, `${clean(type).slice(0, 60)} ${clean(target).slice(0, 200)}`);
				// 204 to a navigation: the browser stays on the page it was on.
				return route.fulfill({ status: 204 });
			}
			const headers: Record<string, string> = answer.contentType ? { "content-type": answer.contentType } : {};
			return route.fulfill({ status: answer.status, headers, body: answer.bytes });
		} catch (error) {
			if (error instanceof WebFetchRefused && traffic !== undefined) {
				noted(traffic.hosts, clean(host));
				// A link to a site that is not allowed: the page stays, and Owni is told.
				if (request.isNavigationRequest()) return route.fulfill({ status: 204 });
			}
			return route.abort("blockedbyclient");
		} finally {
			if (traffic !== undefined) traffic.inflight--;
		}
	});
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "?";
	}
}

/** The first line of an error, without what could pass for markup. */
export function plainError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message.split("\n")[0] ?? "").replace(/[^\w\s.:/()=-]/g, "").slice(0, 120);
}

/** Where to act: what the last view numbered. */
export type Element = { readonly ref: number; readonly kind: string; readonly label: string; readonly tag: string; readonly type: string; readonly href?: string; readonly value?: string };

export type View = {
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly elements: readonly Element[];
	/** Ours, fixed sentences: shown outside the fence. */
	readonly notes: readonly string[];
	/** Names and addresses the page chose: shown inside the fence. */
	readonly details: readonly string[];
	readonly screenshot?: Uint8Array;
	/** The action itself failed (the browser raised): the agente reads why in the notes, a person's panel treats it as an error. */
	readonly failed?: true;
};

export type ViewOptions = {
	readonly find?: string;
	readonly from?: number;
	readonly screenshot?: boolean;
	/** A person drove the page from the console's panel: the agente's last view no longer matches it. */
	readonly person?: true;
};

/** The size of every page's window: the picture of the panel is this big, and a click on it is placed in it. */
const VIEWPORT = { width: 1280, height: 800 };

/** A point of the picture, as fractions of its width and height (already checked to be 0 to 1 by the caller), in the page's own pixels. */
export function viewportPoint(fx: number, fy: number): { x: number; y: number } {
	return { x: Math.min(Math.floor(fx * VIEWPORT.width), VIEWPORT.width - 1), y: Math.min(Math.floor(fy * VIEWPORT.height), VIEWPORT.height - 1) };
}

const PAGE_BUDGET: Budget = { requests: 400, bytes: 40 * 1024 * 1024 };
export const MAX_ELEMENTS = 80;
/** Text of one view, in characters; `from` reads on. */
const VIEW_TEXT = 8_000;
const ACTION_TIMEOUT_MS = 10_000;
/** Reading the page (text, elements, title, screenshot): a page that hangs it is closed. */
const READ_TIMEOUT_MS = 5_000;
/** After an action, how long to wait at most for the page's requests to end. */
const SETTLE_MS = 5_000;
/**
 * A file chooser Chromium reports within this long after a click or a typing returned is that action's
 * own (measured: a few tens of ms). Any later one comes from the page on its own (a timer): told in the next view.
 */
const OWN_CHOOSER_MS = 500;

/**
 * Before the page's own scripts: popups open in the same page, forms cannot send unless a
 * person is driving, and WebRTC, which our routing does not see, is gone.
 */
function initScript(flag: string, humanFlag: string, privateAttr: string, privateBinding: string): string {
	return `(() => {
	${DEEP}
	const flag = ${JSON.stringify(flag)};
	const humanFlag = ${JSON.stringify(humanFlag)};
	const privateAttr = ${JSON.stringify(privateAttr)};
	const privateBinding = ${JSON.stringify(privateBinding)};
	const privateDocument = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
	Object.defineProperty(window, privateBinding + 'Document', { value: privateDocument });
	// Capture the browser's actual value before the page's oninput handler can navigate.
	// Only this event's bounded value leaves the page; old private history never enters it.
	document.addEventListener('input', (event) => {
		const e = event.target;
		if (!(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)) return;
		const edit = e.getAttribute(privateAttr);
		if (!edit || typeof window[privateBinding] !== 'function') return;
		void window[privateBinding](privateDocument, edit, String(e.value).slice(0, ${MAX_TYPED + 1})).catch(() => {});
	}, true);
	for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription"]) {
		try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
	}
	window.open = (url) => { if (url) location.href = String(url); return null; };
	// The event target is the shadow host from outside a shadow root: the path has the anchor itself.
	document.addEventListener("click", (e) => {
		const a = e.composedPath().find((n) => n instanceof Element && n.matches("a[target], form[target]"));
		if (a) a.removeAttribute("target");
	}, true);
	const onSubmit = (e) => {
		const form = e.target;
		if (!(form instanceof HTMLFormElement)) return;
		form.removeAttribute("target");
		const method = ((e.submitter && e.submitter.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
		if (method !== "get" && !window[humanFlag]) { e.preventDefault(); e.stopImmediatePropagation(); window[flag] = (window[flag] || 0) + 1; }
	};
	document.addEventListener("submit", onSubmit, true);
	// A submit does not leave its shadow root: every root, open or closed, listens for itself.
	const watched = new WeakSet();
	const watch = (root) => { if (!watched.has(root)) { watched.add(root); root.addEventListener("submit", onSubmit, true); } };
	const attach = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function (init) { const root = attach.call(this, init); watch(root); return root; };
	// Roots the parser made (declarative shadow DOM) never went through attachShadow.
	document.addEventListener("DOMContentLoaded", () => { for (const h of deep("*")) if (h.shadowRoot) watch(h.shadowRoot); });
})();`;
}

/** Most nodes one lookup visits: a bigger page is cut short, and a lookup that needs the whole page to decide fails closed. */
const MAX_NODES = 100_000;

/**
 * Page-script helper, put in front of every script that looks elements up: the elements matching
 * `selector` in the document and in open shadow roots (web components), in order, at most `max`.
 * The walk itself stops after MAX_NODES nodes, and says so (`over` on the result). Closed roots
 * cannot be reached and iframes are not entered. Playwright's own selectors pierce open shadow
 * roots, so a numbered element is found again by the same marker.
 */
const DEEP = `const deep = (selector, max = Infinity) => {
		const out = [];
		let left = ${MAX_NODES};
		const walk = (root) => {
			const tree = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
			for (let e = tree.nextNode(); e; e = tree.nextNode()) {
				if (out.length >= max) return;
				if (--left < 0) { out.over = true; return; }
				if (e.matches(selector)) out.push(e);
				if (e.shadowRoot) walk(e.shadowRoot);
			}
		};
		walk(document);
		return out;
	};`;

/**
 * Numbers the visible elements one can act on, under a fresh random attribute, fields and
 * buttons first, then the page's main part, then the rest; and reads the text. Extraction is
 * bounded, with enough overlap for host-side redaction before the final view limits.
 */
function snapshotScript(attr: string, old: string | undefined, flag: string, options: ViewOptions, padding: number): string {
	return `(() => {
	${DEEP}
	const attr = ${JSON.stringify(attr)};
	const old = ${JSON.stringify(old ?? "")};
	const flag = ${JSON.stringify(flag)};
	const find = ${JSON.stringify((options.find ?? "").toLowerCase().slice(0, 100))};
	const from = ${Math.max(0, Math.floor(options.from ?? 0))};
	// Capture enough overlap to recognize a whole private value before the host cuts the view.
	// Only its maximum length enters the page; old private values never do.
	const padding = ${padding};
	const cut = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n + padding);
	if (old) for (const e of deep("[" + old + "]")) e.removeAttribute(old);
	const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [onclick]";
	const textOf = (root, id) => { const e = root.getElementById(id); return e ? cut(e.innerText, 80) : ""; };
	const labelOf = (e, tag, type, field) => {
		const by = e.getAttribute("aria-labelledby");
		const named = by ? by.split(/\\s+/).slice(0, 5).map((id) => textOf(e.getRootNode(), id)).join(" ") : "";
		const own = e.labels && e.labels.length ? Array.from(e.labels).slice(0, 3).map((l) => cut(l.innerText, 80)).join(" ") : "";
		const img = e.querySelector ? e.querySelector("img[alt]") : null;
		const svg = e.querySelector ? e.querySelector("svg title") : null;
		const button = tag === "input" && /^(submit|button|reset)$/.test(type) ? e.value : "";
		return cut(e.getAttribute("aria-label") || named || own || (field ? "" : cut(e.innerText, 200)) || button || e.getAttribute("placeholder") || e.getAttribute("title") || (img && img.getAttribute("alt")) || (svg && svg.textContent) || e.getAttribute("name"), 80);
	};
	// closest() stops at a shadow root: go on from its host.
	const inMain = (e) => { for (let n = e; n; n = n.parentElement || n.getRootNode().host) if (n.matches("main, article, [role=main]")) return true; return false; };
	const found = [];
	const seen = new Set();
	let scanned = 0;
	const list = deep(selector, 3001);
	for (const e of list) {
		if (++scanned > 3000) break;
		const box = e.getBoundingClientRect();
		if (box.width === 0 || box.height === 0 || e.disabled) continue;
		const style = getComputedStyle(e);
		if (style.visibility === "hidden" || style.display === "none") continue;
		const tag = e.tagName.toLowerCase();
		const type = cut(e.getAttribute("type"), 20).toLowerCase();
		const role = cut(e.getAttribute("role"), 20).toLowerCase();
		const field = tag === "input" || tag === "textarea" || tag === "select";
		const label = labelOf(e, tag, type, field);
		const href = tag === "a" ? cut(e.href, 300) : "";
		if (tag === "a") {
			if (seen.has(href + " " + label)) continue;
			seen.add(href + " " + label);
		}
		if (find && !(label + " " + href).toLowerCase().includes(find)) continue;
		const options = tag === "select" ? Array.from(e.options).slice(0, 15).map((o) => ({ text: cut(o.text, 40), value: cut(o.value, 40), different: o.value !== o.text })) : [];
		const optionCount = tag === "select" ? e.options.length : 0;
		const value = field && type !== "password" && type !== "file" ? cut(tag === "select" && e.selectedOptions[0] ? e.selectedOptions[0].text : e.value, 80) : "";
		const checked = type === "checkbox" || type === "radio" ? !!e.checked : e.getAttribute("aria-checked") === "true";
		const priority = field || tag === "button" || role === "button" ? 0 : inMain(e) ? 1 : 2;
		found.push({ e, index: scanned, priority, info: { tag, type, role, label, href, options, optionCount, value, checked } });
	}
	const shown = found.slice().sort((a, b) => a.priority - b.priority || a.index - b.index).slice(0, ${MAX_ELEMENTS}).sort((a, b) => a.index - b.index);
	shown.forEach((f, i) => f.e.setAttribute(attr, String(i + 1)));
	// body.innerText stops at shadow roots: what they show is appended.
	const shadow = deep("*").filter((h) => h.shadowRoot).flatMap((h) => Array.from(h.shadowRoot.children).filter((c) => c.getClientRects().length).map((c) => String(c.innerText)));
	const all = document.body ? [String(document.body.innerText), ...shadow].join("\\n") : "";
	const blocked = Number(window[flag]) || 0;
	window[flag] = 0;
	return {
		elements: shown.map((f) => f.info),
		more: found.length - shown.length,
		scannedAll: scanned <= 3000 && !list.over,
		text: all.slice(Math.max(0, from - padding), from + ${VIEW_TEXT} + padding),
		textLength: all.length,
		frames: deep("iframe[src]", 5).map((f) => cut(f.src, 200)),
		postForms: deep("form", 50).filter((f) => cut(f.getAttribute("method"), 10).toLowerCase() === "post").length,
		blockedForms: blocked,
	};
})()`;
}

type Raw = { elements?: unknown; more?: unknown; scannedAll?: unknown; text?: unknown; textLength?: unknown; frames?: unknown; postForms?: unknown; blockedForms?: unknown };

/** What the page script returned, checked: the page can patch the DOM and the builtins it uses. */
function cleanElements(raw: unknown, clean: (text: string, limit: number) => string): Element[] {
	if (!Array.isArray(raw)) return [];
	const text = (value: unknown, n: number) => (typeof value === "string" ? clean(value.replace(/\s+/g, " ").trim(), n) : "");
	const token = (value: unknown) => typeof value === "string" ? value.slice(0, 20) : "";
	return raw.slice(0, MAX_ELEMENTS).flatMap((item: unknown, i) => {
		if (item === null || typeof item !== "object") return [];
		const e = item as Record<string, unknown>;
		const tag = token(e.tag);
		const type = token(e.type);
		const options = Array.isArray(e.options) ? e.options.slice(0, 15).flatMap((option: unknown) => {
			if (option === null || typeof option !== "object") return [];
			const o = option as Record<string, unknown>;
			return [text(o.text, 40) + (o.different === true ? ` = ${text(o.value, 40)}` : "")];
		}).join(", ") + (typeof e.optionCount === "number" && e.optionCount > 15 ? `, +${e.optionCount - 15} altri` : "") : "";
		const own = text(e.label, 80);
		const label = `${own}${options ? `${own ? " " : ""}(valori: ${options})` : ""}`;
		const href = text(e.href, 300);
		const value = text(e.value, 80);
		return [{ ref: i + 1, kind: kindOf(tag, type, token(e.role), e.checked === true), label, tag, type, ...(href ? { href } : {}), ...(value ? { value } : {}) }];
	});
}

/** Redact whole matches before selecting a window, including matches crossing either edge.
 * Offsets stay in the original text, so the next page cannot reveal a private value's suffix.
 */
function privateSlice(text: string, forms: readonly string[], from = 0, to = text.length): string {
	const end = Math.min(to, text.length);
	if (from >= end) return "";
	let hidden: Uint8Array | undefined;
	for (const form of forms) {
		let at = text.indexOf(form, Math.max(0, from - form.length + 1));
		while (at >= 0 && at < end) {
			hidden ??= new Uint8Array(end - from);
			hidden.fill(1, Math.max(0, at - from), Math.min(end, at + form.length) - from);
			at = text.indexOf(form, at + 1);
		}
	}
	if (hidden === undefined) return text.slice(from, end);
	const out: string[] = [];
	for (let at = 0; at < hidden.length;) {
		const masked = hidden[at] === 1;
		let next = at + 1;
		while (next < hidden.length && (hidden[next] === 1) === masked) next++;
		out.push(masked ? "[privato]" : text.slice(from + at, from + next));
		at = next;
	}
	return out.join("");
}

function kindOf(tag: string, type: string, role: string, checked: boolean): string {
	const mark = checked ? " (selezionata)" : "";
	if (tag === "a" || role === "link") return "link";
	if (tag === "select" || role === "combobox") return "scelta";
	if (tag === "textarea") return "campo di testo";
	if (tag === "input") {
		if (/^(submit|button|reset|image)$/.test(type)) return "pulsante";
		if (type === "checkbox") return `casella${mark}`;
		if (type === "radio") return `opzione${mark}`;
		if (type === "password") return "campo password";
		if (type === "file") return "caricamento file";
		return "campo di testo";
	}
	if (role === "checkbox" || role === "switch") return `casella${mark}`;
	if (role === "radio" || role === "option") return `opzione${mark}`;
	if (role === "tab") return "scheda";
	return "pulsante";
}

export class BrowseError extends Error {
	override readonly name = "BrowseError";
	/** Why, for the callers that word it themselves; the message stays for the agente. */
	constructor(message: string, readonly kind?: "no-files" | "no-page" | "busy" | "unavailable" | "failed" | "held" | "denied" | "no-field") {
		super(message);
	}
}

const NO_FILES = "Owni non carica file sui siti";
const LATE_CHOOSER = "La pagina ha provato da sola ad aprire la scelta di un file: rifiutata, Owni non carica file sui siti.";

/** A page that stopped answering a read: its session is closed. */
class Hung extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Hung()), ms);
	});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type Session = {
	readonly scope: string;
	readonly thread: { channel: string; threadId: string };
	readonly owner?: string;
	readonly profile?: Profile;
	readonly humanFlag: string;
	readonly privateAttr: string;
	readonly privateBinding: string;
	readonly privateValues: Set<string>;
	privateEdit: { readonly token: string; readonly document: string; readonly done: Promise<boolean>; readonly acknowledge: (retained: boolean) => void } | undefined;
	control: "agent" | "person";
	humanAction: boolean;
	readonly key: string;
	readonly context: BrowserContext;
	readonly page: Page;
	readonly flag: string;
	readonly traffic: Traffic;
	readonly budget: Budget;
	/** Read fresh at every request: the owner's list as of the current action. */
	readonly guard: { current: Guard };
	attr: string | undefined;
	elements: Map<number, Element>;
	timer: NodeJS.Timeout | undefined;
	used: number;
	busy: boolean;
	queue: Promise<unknown>;
	/** Counts the actions done: what someone watching compares to know the page may have changed. */
	version: number;
	/** The last picture taken for someone watching, and at which version. */
	picture: { readonly version: number; readonly png: Uint8Array } | undefined;
	/** Where the page was after the last action, for someone watching without asking Chromium. */
	shown: { readonly url: string; readonly title: string };
	/** A person moved the page since the agente's last view: its numbers point elsewhere now. */
	movedByPerson: boolean;
	/** When the page opened a file chooser (refused, whatever the way: label, shadow DOM, frame, input.click()), not yet told to the agente. */
	choosers: number[];
};

/** A conversation's browser as someone watching it sees it (the console's browser panel). */
export type BrowserState = { readonly open: true; readonly url: string; readonly title: string; readonly version: number; readonly busy: boolean; readonly control: "agent" | "person"; readonly profile: boolean } | { readonly open: false; readonly closed?: string };
export const MAX_TYPED = 1000;
const MAX_PRIVATE_VALUES = 256;
export const PRESS_KEYS = ["Enter", "Tab", "Shift+Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type PressKey = (typeof PRESS_KEYS)[number];
export type BrowseAccounts = {
	readonly owner: (scope: string, thread: { readonly channel: string; readonly threadId: string }) => Promise<string | undefined>;
	readonly profiles?: BrowserProfiles;
	readonly submitted?: (key: string, person: string, host: string) => void;
};
type Profile = { scope: string; person: string; jar: CookieJar; active: boolean; queue: Promise<void> };

/**
 * Browsers that stay open for a conversation (ADR 0014): one per conversation, closed after a
 * while with no actions, a few at most on this server. Agent actions read; the person can
 * take control to submit basic forms privately.
 */
export class BrowseSessions {
	private readonly sessions = new Map<string, Session>();
	private readonly starting = new Map<string, Promise<void>>();
	private readonly profiles = new Map<string, Promise<Profile>>();
	private readonly clearing = new Map<string, Promise<void>>();
	private readonly uncleared = new Set<string>();
	/** Why a conversation's browser is gone, so Owni can say it, and the late file choosers the agente has not heard of yet. */
	private readonly closed = new Map<string, { readonly why: string; choosers: number[] }>();

	constructor(
		private readonly limits: { readonly max: number; readonly idleMs: number } = { max: 4, idleMs: 5 * 60_000 },
		/** A site's first file chooser refused in this browser, as Chromium reports it (the audit, ADR 0103): the conversation's key and the page's host. */
		private readonly refused: (key: string, host: string) => void = () => {},
		private readonly accounts?: BrowseAccounts,
	) {}

	/** Opens `url` in the conversation's browser, starting one if needed. */
	async open(key: string, browser: Browser, url: string, guard: Guard, options: ViewOptions = {}): Promise<View> {
		if (!this.sessions.has(key)) {
			// Two calls at once for a new conversation start one browser, not two.
			let starting = this.starting.get(key);
			if (starting === undefined) {
				starting = this.start(key, browser, guard).finally(() => this.starting.delete(key));
				this.starting.set(key, starting);
			}
			await starting;
		}
		return this.act(key, guard, options, false, async (s) => {
			// Each page opened gets its own budget.
			Object.assign(s.budget, PAGE_BUDGET);
			await s.page.goto(url, { waitUntil: "load", timeout: 20_000 });
		});
	}

	/** The page as it is now, or the one before it. */
	view(key: string, guard: Guard, options: ViewOptions & { readonly back?: boolean } = {}): Promise<View> {
		return this.act(key, guard, options, false, async (s) => {
			if (options.back !== true) return;
			Object.assign(s.budget, PAGE_BUDGET);
			await s.page.goBack({ waitUntil: "load", timeout: 20_000 });
		});
	}

	click(key: string, ref: number, guard: Guard, options: ViewOptions = {}): Promise<View> {
		return this.act(key, guard, options, true, async (s) => {
			const { selector } = await this.target(s, ref);
			await s.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
		});
	}

	/**
	 * A click on the picture the panel shows (ADR 0103): the point `fx`, `fy` (fractions of the picture)
	 * of the page. Same limits as web_click: no file uploads (the file chooser is refused when it opens), and the page still only reads.
	 */
	clickAt(key: string, fx: number, fy: number, guard: Guard, options: ViewOptions = {}): Promise<View> {
		const point = viewportPoint(fx, fy);
		return this.act(key, guard, options, true, async (s) => {
			await s.page.mouse.click(point.x, point.y);
		});
	}

	type(key: string, ref: number, text: string, submit: boolean, guard: Guard, options: ViewOptions = {}): Promise<View> {
		return this.act(key, guard, options, true, async (s) => {
			const { selector, live } = await this.target(s, ref);
			if (live.type === "password") throw new BrowseError("Owni non scrive password: non entra negli account");
			if (live.type === "checkbox" || live.type === "radio") throw new BrowseError(`l'elemento ${ref} è una casella: si seleziona con web_click`);
			if (live.tag === "select") {
				const forms = this.privateForms(s);
				const limit = 80 + Math.max(0, ...forms.map((form) => form.length));
				const choices = await within(s.page.evaluate<unknown>(`(() => { ${DEEP} return Array.from(deep(${JSON.stringify(selector)})[0].options).slice(0, 200).map((o) => [String(o.value).slice(0, ${limit}), String(o.text).replace(/\\s+/g, " ").trim().slice(0, ${limit})]); })()`), READ_TIMEOUT_MS);
				const pairs = (Array.isArray(choices) ? choices : []).filter((c): c is [string, string] => Array.isArray(c) && typeof c[0] === "string" && typeof c[1] === "string");
				if (!pairs.some(([value, label]) => value.slice(0, 80) === text || label.slice(0, 80) === text)) throw new BrowseError(`«${this.redact(s, text).slice(0, 40)}» non è tra i valori di questa scelta: ${pairs.slice(0, 15).map(([, label]) => privateSlice(label, forms, 0, 80).slice(0, 80)).join(", ")}`);
				await s.page.selectOption(selector, text, { timeout: ACTION_TIMEOUT_MS });
			} else if (live.tag === "input" || live.tag === "textarea") await s.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
			else throw new BrowseError(`l'elemento ${ref} non è un campo: si clicca con web_click`);
			if (submit) await s.page.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
		});
	}

	async takeover(key: string, person: string, guard: Guard): Promise<BrowserState> {
		await this.act(key, guard, { person: true }, false, async (s) => {
			if (s.owner !== person || !(await this.allowed(s)) || !this.current(s)) throw new BrowseError("questo browser non ti appartiene", "denied");
			s.control = "person";
		});
		return this.state(key);
	}

	async release(key: string, person: string): Promise<BrowserState> {
		const s = this.sessions.get(key);
		if (s === undefined) return this.state(key);
		await this.act(key, s.guard.current, { person: true }, false, async (s) => {
			if (s.owner !== person) throw new BrowseError("questo browser non ti appartiene", "denied");
			await within(s.page.evaluate(`(() => { ${DEEP} for (const e of deep('[${s.privateAttr}]')) { e.value = ''; e.removeAttribute('${s.privateAttr}'); } })()`), READ_TIMEOUT_MS);
			s.control = "agent";
			s.humanAction = false;
		});
		return this.state(key);
	}

	typeText(key: string, person: string, text: string, guard: Guard): Promise<View> {
		return this.act(key, guard, { person: true }, true, async (s) => {
			this.holder(s, person);
			if (!text || text.length > MAX_TYPED || s.privateValues.size >= MAX_PRIVATE_VALUES) throw new BrowseError("testo non disponibile per questo campo", "no-field");
			await this.beginPrivateEdit(s);
			s.privateValues.add(text);
			try { await s.page.fill(":focus", text, { timeout: ACTION_TIMEOUT_MS }); }
			catch { throw new BrowseError("scrittura nel campo non riuscita", "failed"); }
		});
	}

	press(key: string, person: string, keyName: PressKey, guard: Guard): Promise<View> {
		return this.act(key, guard, { person: true }, true, async (s) => {
			this.holder(s, person);
			if (!(PRESS_KEYS as readonly string[]).includes(keyName)) throw new BrowseError("tasto non disponibile", "denied");
			const focused = await this.beginPrivateEdit(s, keyName);
			try { await s.page.press(focused ? ":focus" : "body", keyName, { timeout: ACTION_TIMEOUT_MS }); }
			catch { throw new BrowseError("pressione del tasto non riuscita", "failed"); }
		});
	}

	private holder(s: Session, person: string): void {
		if (s.owner !== person || s.control !== "person") throw new BrowseError("prendi prima il controllo del tuo browser", "denied");
	}

	/** Arm only native value-changing gestures. A random edit token and document identity
	 * let the input binding acknowledge this action, never an older document or another field. */
	private async beginPrivateEdit(s: Session, key?: PressKey): Promise<boolean> {
		const token = randomBytes(12).toString("hex");
		const raw = await within(s.page.evaluate<unknown>(`(() => {
			const editToken = ${JSON.stringify(token)};
			const key = ${JSON.stringify(key ?? "")};
			const e = document.activeElement;
			const field = e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && /^(text|password|email|search|tel|url|number)$/.test(e.type));
			const editing = field && (!key || (e.hasAttribute('${s.privateAttr}') && (key === 'Backspace' || (key === 'Enter' && e instanceof HTMLTextAreaElement) || (/^Arrow(Up|Down)$/.test(key) && e.type === 'number'))));
			if (editing) e.setAttribute('${s.privateAttr}', editToken);
			return { focused: e !== document.body && e !== document.documentElement, editing, document: window[${JSON.stringify(s.privateBinding + "Document")}] };
		})()`), READ_TIMEOUT_MS);
		const field = raw !== null && typeof raw === "object" ? raw as { focused?: unknown; editing?: unknown; document?: unknown } : undefined;
		if (field === undefined || typeof field.focused !== "boolean" || typeof field.editing !== "boolean") return this.privateFailure(s);
		if (key === undefined && !field.editing) throw new BrowseError("seleziona prima un campo di testo", "no-field");
		if (field.editing) {
			if (typeof field.document !== "string" || !field.document || field.document.length > 128) return this.privateFailure(s);
			let acknowledge!: (retained: boolean) => void;
			const done = new Promise<boolean>((resolve) => { acknowledge = resolve; });
			s.privateEdit = { token, document: field.document, done, acknowledge };
		}
		return field.focused;
	}

	private async retainPrivateEdit(s: Session): Promise<void> {
		const edit = s.privateEdit;
		if (edit === undefined) return;
		try {
			if (await within(edit.done, READ_TIMEOUT_MS)) return;
		} catch {}
		return this.privateFailure(s);
	}

	private async privateFailure(s: Session): Promise<never> {
		s.privateEdit?.acknowledge(false);
		await this.end(s, "chiusa per proteggere i dati privati");
		throw new BrowseError("il browser non può proteggere altri dati privati: riapri la pagina", "failed");
	}

	private owner(scope: string, thread: { channel: string; threadId: string }): Promise<string | undefined> {
		return this.accounts?.owner(scope, thread).catch(() => undefined) ?? Promise.resolve(undefined);
	}

	private async sharedProfile(scope: string, person: string): Promise<Profile> {
		const key = `${scope}\0${person}`;
		await this.clearing.get(key);
		if (this.uncleared.has(key)) throw new BrowseError("riprova a cancellare gli accessi ai siti", "denied");
		let pending = this.profiles.get(key);
		if (pending === undefined) {
			pending = (async () => ({ scope, person, jar: await this.accounts!.profiles!.load(scope, person), active: true, queue: Promise.resolve() }))();
			this.profiles.set(key, pending);
			void pending.catch(() => { if (this.profiles.get(key) === pending) this.profiles.delete(key); });
		}
		return pending;
	}

	private async save(s: Session): Promise<void> {
		const p = s.profile;
		if (p === undefined || !p.active) return;
		const write = p.queue.catch(() => {}).then(async () => {
			if (!p.active || await this.owner(s.scope, s.thread) !== s.owner || !p.active) return;
			// Closing normally still saves; a profile invalidated while ownership was read never does.
			await this.accounts?.profiles?.save(p.scope, p.person, p.jar);
		});
		p.queue = write;
		await write;
	}

	async profile(scope: string, person: string): Promise<{ readonly hosts: readonly string[] }> {
		if (this.accounts?.profiles === undefined) return { hosts: [] };
		const p = await this.sharedProfile(scope, person);
		return { hosts: p.active ? p.jar.hosts() : [] };
	}

	clearProfile(scope: string, person: string): Promise<void> {
		const key = `${scope}\0${person}`;
		const existing = this.clearing.get(key);
		if (existing !== undefined) return existing;
		this.uncleared.add(key);
		const run = (async () => {
			const pending = this.profiles.get(key);
			const p = await pending;
			if (p !== undefined) p.active = false;
			await Promise.all([...this.sessions.values()].filter((s) => s.scope === scope && s.owner === person).map((s) => this.end(s, "accessi ai siti cancellati")));
			const clear = async () => { await this.accounts?.profiles?.clear(scope, person); };
			const cleared = p === undefined ? clear() : p.queue.catch(() => {}).then(clear);
			if (p !== undefined) p.queue = cleared;
			await cleared;
			if (this.profiles.get(key) === pending) this.profiles.delete(key);
			this.uncleared.delete(key);
		})();
		this.clearing.set(key, run);
		void run.finally(() => { if (this.clearing.get(key) === run) this.clearing.delete(key); }).catch(() => {});
		return run;
	}

	private current(s: Session): boolean {
		return this.sessions.get(s.key) === s && (s.profile === undefined || s.profile.active);
	}

	private async allowed(s: Session, starting = false): Promise<boolean> {
		const current = () => (starting ? !this.sessions.has(s.key) : this.sessions.get(s.key) === s) && (s.profile === undefined || s.profile.active);
		if (!current()) return false;
		const owner = s.owner === undefined || await this.owner(s.scope, s.thread) === s.owner;
		return owner && current();
	}

	private async revoke(s: Session): Promise<void> {
		// A delayed operation on a detached session must not clear its replacement's profile.
		if (this.sessions.get(s.key) !== s) return;
		if (s.owner !== undefined) await this.clearProfile(s.scope, s.owner);
		else await this.end(s, "accesso revocato");
	}

	/** Native edits and maxlength can change a supplied value. Read only marked fields,
	 * before a submit/navigation or release can remove them, and retain their history on the host. */
	private async capturePrivate(s: Session): Promise<void> {
		if (s.privateValues.size === 0) return;
		try {
			const read = () => within(s.page.evaluate<unknown>(`(() => {
				${DEEP}
				const values = [];
				for (const e of deep('[${s.privateAttr}]')) {
					if (!(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)) continue;
					values.push(String(e.value).slice(0, ${MAX_TYPED + 1}));
					if (values.length > ${MAX_PRIVATE_VALUES}) break;
				}
				return values;
			})()`), READ_TIMEOUT_MS);
			const values = await read().catch(async (error: unknown) => {
				if (error instanceof Hung) throw error;
				// A navigation can replace the execution context just after the action returned.
				await within(s.page.waitForLoadState("load", { timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS);
				return read();
			});
			this.keepPrivate(s, values);
		} catch {
			// Never discard history or truncate an unknown value and then expose its remainder.
			return this.privateFailure(s);
		}
	}

	private keepPrivate(s: Session, values: unknown): void {
		if (!Array.isArray(values) || values.length > MAX_PRIVATE_VALUES) throw new Error("private field limit");
		for (const value of values) {
			if (typeof value !== "string" || value.length > MAX_TYPED) throw new Error("private value limit");
			if (!value || s.privateValues.has(value)) continue;
			if (s.privateValues.size >= MAX_PRIVATE_VALUES) throw new Error("private history limit");
			s.privateValues.add(value);
		}
	}

	private privateForms(s: Session): readonly string[] {
		const forms = new Set<string>();
		for (const value of s.privateValues) {
			// Textareas expose LF, native forms send CRLF, and single-line inputs remove line breaks.
			for (const plain of [value, value.replace(/\r\n|\r|\n/g, "\n"), value.replace(/\r\n|\r|\n/g, "\r\n"), value.replace(/[\r\n]/g, ""), value.replace(/\s+/g, " ").trim()]) {
				if (!plain) continue;
				forms.add(plain);
				forms.add(new URLSearchParams({ q: plain }).toString().slice(2));
				// URLSearchParams also handles malformed surrogate input; encodeURIComponent does not.
				try { forms.add(encodeURIComponent(plain)); } catch {}
			}
		}
		return [...forms];
	}

	private redact(s: Session, text: string): string {
		return privateSlice(text, this.privateForms(s));
	}

	private redactView(s: Session, view: View): View {
		const clean = (text: string) => this.redact(s, text);
		return { ...view, url: clean(view.url), title: clean(view.title), text: clean(view.text), notes: view.notes.map(clean), details: view.details.map(clean), elements: view.elements.map((e) => ({ ...e, label: clean(e.label), ...(e.value === undefined ? {} : { value: clean(e.value) }), ...(e.href === undefined ? {} : { href: clean(e.href) }) })) };
	}

	has(key: string): boolean {
		return this.sessions.has(key);
	}

	/** Where the conversation's browser is, as of its last action: no question to Chromium, so it is cheap to ask often. */
	state(key: string): BrowserState {
		const s = this.sessions.get(key);
		if (s === undefined) {
			const closed = this.closed.get(key)?.why;
			return closed === undefined ? { open: false } : { open: false, closed };
		}
		return { open: true, ...s.shown, version: s.version, busy: s.busy, control: s.control, profile: s.profile !== undefined };
	}

	/**
	 * What is on screen, for someone watching: taken between actions, and taken again only after
	 * one. It changes nothing on the page, so the numbers of the agente's last view stay valid.
	 */
	async picture(key: string): Promise<{ readonly png: Uint8Array; readonly version: number } | undefined> {
		const s = this.sessions.get(key);
		if (s === undefined) return Promise.resolve(undefined);
		if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); return undefined; }
		// Never ahead of the agente: while it acts, the last picture is what there is.
		if (s.picture?.version === s.version || s.busy) return Promise.resolve(s.picture);
		const run = s.queue
			.catch(() => {})
			.then(async () => {
				if (this.sessions.get(key) !== s) return undefined;
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); return undefined; }
				if (s.picture?.version === s.version) return s.picture;
				const version = s.version;
				// Busy, so the idle timer and the room for other conversations leave this session alone meanwhile.
				s.busy = true;
				const png = await within(s.page.screenshot({ fullPage: false, type: "png", timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 1_000)
					.catch(() => undefined)
					.finally(() => {
						s.busy = false;
					});
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); return undefined; }
				if (png === undefined) return s.picture;
				s.picture = { version, png };
				return s.picture;
			});
		s.queue = run;
		return run;
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((s) => this.end(s, "chiusa")));
	}

	/** Close every conversation's browser of one scope (an agente deleted, ADR 0046), and forget them. */
	async closeScope(scope: string): Promise<void> {
		const prefix = `${scope}|`;
		await Promise.allSettled([...this.starting].filter(([key]) => key.startsWith(prefix)).map(([, starting]) => starting));
		for (const key of [...this.profiles.keys()]) if (key.startsWith(`${scope}\0`)) await this.clearProfile(scope, key.slice(scope.length + 1));
		await Promise.all([...this.sessions.values()].filter((s) => s.key.startsWith(prefix)).map((s) => this.end(s, "chiusa")));
		for (const key of [...this.closed.keys()]) if (key.startsWith(prefix)) this.closed.delete(key);
	}

	/** Closes this session, and only it: a newer one of the same conversation stays. */
	private async end(s: Session, reason: string): Promise<void> {
		s.privateEdit?.acknowledge(false);
		if (this.sessions.get(s.key) === s) {
			this.sessions.delete(s.key);
			// The late choosers not yet told go with the closure: the agente hears them in its next answer.
			this.closed.set(s.key, { why: reason, choosers: s.choosers });
			if (this.closed.size > 500) this.closed.delete(this.closed.keys().next().value as string);
		}
		clearTimeout(s.timer);
		await s.context.close().catch(() => {});
		await this.save(s);
	}

	/** The element `ref` of the last view, checked on the page as it is now: one element, the same kind. */
	private async target(s: Session, ref: number): Promise<{ selector: string; live: { tag: string; type: string } }> {
		if (s.movedByPerson) throw new BrowseError("chi ti scrive ha aperto un'altra pagina nel browser: guardala di nuovo con web_browse senza url");
		const known = s.elements.get(ref);
		if (known === undefined || s.attr === undefined) throw new BrowseError(`nella pagina non c'è l'elemento ${ref}: usa i numeri dell'ultima vista`);
		const selector = `[${s.attr}="${ref}"]`;
		const live = await within(
			s.page.evaluate<unknown>(`(() => { ${DEEP} const all = deep(${JSON.stringify(selector)}); if (all.length !== 1 || all.over) return null; return { tag: all[0].tagName.toLowerCase(), type: String(all[0].getAttribute("type") || "").toLowerCase().slice(0, 20) }; })()`),
			READ_TIMEOUT_MS,
		);
		const found = live !== null && typeof live === "object" ? (live as { tag?: unknown; type?: unknown }) : undefined;
		if (found === undefined || found.tag !== known.tag || found.type !== known.type) throw new BrowseError("la pagina è cambiata dall'ultima vista: guardala di nuovo con web_browse senza url");
		return { selector, live: { tag: known.tag, type: known.type } };
	}

	private async start(key: string, browser: Browser, guard: Guard): Promise<void> {
		// Room for one more: the idle session unused the longest closes. Busy ones are never cut.
		// The new session counts too; other conversations still starting already hold their place.
		const others = () => [...this.starting.keys()].filter((k) => k !== key).length;
		while (this.sessions.size + others() >= this.limits.max) {
			const oldest = [...this.sessions.values()].filter((s) => !s.busy && s.control !== "person").sort((a, b) => a.used - b.used)[0];
			if (oldest === undefined) throw new BrowseError("su questo server ci sono già troppi browser al lavoro: riprova tra poco", "busy");
			await this.end(oldest, "chiusa per fare posto a un'altra conversazione");
		}
		const context = await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT, acceptDownloads: false, serviceWorkers: "block" });
		const traffic: Traffic = { sends: new Set(), hosts: new Set(), files: new Set(), overBudget: false, inflight: 0 };
		const budget = { ...PAGE_BUDGET };
		const current = { current: guard };
		const flag = `__owni${randomBytes(6).toString("hex")}`;
		const humanFlag = `__person${randomBytes(6).toString("hex")}`;
		const privateAttr = `data-private-${randomBytes(6).toString("hex")}`;
		const privateBinding = `__private${randomBytes(12).toString("hex")}`;
		const split = key.indexOf("|");
		const scope = split < 0 ? "" : key.slice(0, split);
		const address = key.slice(split + 1);
		const colon = address.indexOf(":");
		const thread = { channel: address.slice(0, colon), threadId: address.slice(colon + 1) };
		const owner = await this.owner(scope, thread);
		let session: Session | undefined;
		try {
			const profile = owner === undefined || this.accounts?.profiles === undefined ? undefined : await this.sharedProfile(scope, owner);
			await guardContext(context, () => current.current, budget, traffic, profile?.jar ?? new CookieJar(), {
				allowed: async () => session !== undefined && await this.allowed(session),
				current: () => session !== undefined && this.current(session),
				page: () => session?.page,
				human: () => session?.control === "person" && session.humanAction,
				retain: async () => { if (session !== undefined) await this.retainPrivateEdit(session); },
				submitted: (host) => { if (session?.owner !== undefined) this.accounts?.submitted?.(key, session.owner, host); },
				redact: (text) => session === undefined ? text : this.redact(session, text),
			});
			await context.exposeBinding?.(privateBinding, async (source, document, edit, value) => {
				const s = session;
				const pending = s?.privateEdit;
				if (s === undefined || pending === undefined || !this.current(s) || source.page !== s.page || source.frame !== s.page.mainFrame?.() || pending.document !== document || pending.token !== edit) return false;
				try { this.keepPrivate(s, [value]); }
				catch { await this.privateFailure(s).catch(() => {}); return false; }
				pending.acknowledge(true);
				return true;
			});
			await context.addInitScript(initScript(flag, humanFlag, privateAttr, privateBinding));
			const page = await context.newPage();
			// Any other window (one the page opens anyway) is closed: everything happens in one page.
			context.on("page", (other) => {
				if (other !== page) void other.close().catch(() => {});
			});
			session = { key, scope, thread, owner, profile, humanFlag, privateAttr, privateBinding, privateValues: new Set(), privateEdit: undefined, control: "agent", humanAction: false, context, page, flag, traffic, budget, guard: current, attr: undefined, elements: new Map(), timer: undefined, used: Date.now(), busy: false, queue: Promise.resolve(), version: 0, picture: undefined, shown: { url: "about:blank", title: "" }, movedByPerson: false, choosers: this.closed.get(key)?.choosers ?? [] };
			const started = session;
			if (!(await this.allowed(started, true)) || (profile !== undefined && !profile.active)) throw new BrowseError("accesso al browser revocato", "denied");
			// Owni uploads no files (ADR 0103): the chooser itself is the one place where it is refused.
			// The audit hears of the first one per site of this browser: a page that retries in a loop is one line, not thousands.
			const told = new Set<string>();
			page.on("filechooser", () => {
				// Three at most, the last always the newest: with the one an action starts from (below) that is enough to tell its own from a late one.
				if (started.choosers.length < 3) started.choosers.push(Date.now());
				else started.choosers[2] = Date.now();
				const host = new URL(page.url()).hostname;
				if (told.has(host)) return;
				told.add(host);
				this.refused(key, host);
			});
			this.sessions.set(key, session);
			this.closed.delete(key);
		} catch (error) {
			await context.close().catch(() => {});
			throw error;
		}
	}

	/**
	 * One action at a time per session; then the page as it is after it. A `gesture` (a click, a typing)
	 * that opens a file chooser is refused as a whole; a chooser the page opens on its own is a note.
	 */
	private act(key: string, guard: Guard, options: ViewOptions, gesture: boolean, action: (s: Session) => Promise<unknown>): Promise<View> {
		const s = this.sessions.get(key);
		if (s === undefined) {
			const why = this.closed.get(key)?.why;
			return Promise.reject(new BrowseError(why === undefined ? "nessuna pagina aperta in questa conversazione: aprila con web_browse" : `la pagina di questa conversazione è stata ${why}: riaprila con web_browse${this.unheard(key, options)}`, why === undefined ? "no-page" : undefined));
		}
		const run = s.queue
			.catch(() => {})
			.then(async () => {
				if (this.sessions.get(key) !== s) throw new BrowseError(`la pagina di questa conversazione è stata chiusa: riaprila con web_browse${this.unheard(key, options)}`);
				if (options.person !== true && s.control === "person") throw new BrowseError("la persona sta usando il browser: attendi che restituisca il controllo", "held");
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); throw new BrowseError("accesso al browser revocato", "denied"); }
				s.guard.current = guard;
				s.busy = true;
				// A person drives the page: the agente's numbers point elsewhere from now, however the action ends.
				if (options.person === true) s.movedByPerson = true;
				// Idle counts from the end of the last action, never during one.
				clearTimeout(s.timer);
				let result: View;
				try {
					s.humanAction = options.person === true && s.control === "person";
					if (s.humanAction) await within(s.page.evaluate(`window[${JSON.stringify(s.humanFlag)}] = true`), READ_TIMEOUT_MS);
					if (options.person === true) await this.capturePrivate(s);
					if (!this.current(s)) throw new BrowseError("accesso al browser revocato", "denied");
					let failure: string | undefined;
					// The ones before the action are all late: one says it.
					s.choosers = s.choosers.slice(0, 1);
					const started = Date.now();
					try {
						await action(s);
					} catch (error) {
						if (error instanceof BrowseError || error instanceof Hung) throw error;
						failure = s.humanAction ? "Operazione non riuscita" : plainError(this.redact(s, error instanceof Error ? error.message : String(error)));
						// A browser that went away (a restart of Chromium) leaves nothing to look at.
						if (/closed|disconnected|Target page/i.test(failure)) {
							await this.end(s, "chiusa perché il browser si è fermato");
							throw new BrowseError(`il browser si è chiuso: riapri la pagina con web_browse${this.unheard(key, options)}`);
						}
					} finally {
						if (options.person === true && this.current(s)) await this.capturePrivate(s);
					}
					const own = Date.now() + OWN_CHOOSER_MS;
					await this.settle(s);
					// A gesture's own chooser is known only once its time has passed.
					if (gesture && Date.now() < own) await new Promise((resolve) => setTimeout(resolve, own - Date.now()));
					const mine = (t: number) => t >= started && t <= own;
					if (gesture && s.choosers.some(mine)) {
						// Only its own: one the page opened earlier is still the agente's to hear.
						s.choosers = s.choosers.filter((t) => !mine(t));
						// The agente's numbers stay those of its last view; what someone watching reads is the page now.
						await this.remember(s);
						throw new BrowseError(NO_FILES, "no-files");
					}
					if (!(await this.allowed(s))) { await this.revoke(s); throw new BrowseError("accesso al browser revocato", "denied"); }
					const view = s.control === "person" && options.person === true
						? { ...await this.remember(s), text: "", elements: [], notes: [], details: [], ...(failure === undefined ? {} : { failed: true as const }) }
						: this.redactView(s, await this.snapshot(s, failure, options));
					// Read after the whole view, screenshot included: one opened meanwhile is told now, not lost.
					// Only the agente's view uses it up: the panel shows a person the page, not the notes.
					const late = s.choosers.length > 0;
					if (options.person !== true) s.choosers = [];
					result = late ? { ...view, notes: [...view.notes, LATE_CHOOSER] } : view;
				} catch (error) {
					if (!(error instanceof Hung)) throw error;
					await this.end(s, "chiusa perché non rispondeva");
					throw new BrowseError(`la pagina non risponde ed è stata chiusa: riaprila con web_browse, o leggila con web_read${this.unheard(key, options)}`);
				} finally {
					s.privateEdit = undefined;
					s.humanAction = false;
					if (s.owner !== undefined) await within(s.page.evaluate(`window[${JSON.stringify(s.humanFlag)}] = false`), READ_TIMEOUT_MS).catch(() => {});
					s.busy = false;
					s.version += 1;
					s.used = Date.now();
					if (this.sessions.get(key) === s) {
						s.timer = setTimeout(() => void this.end(s, "chiusa dopo qualche minuto senza azioni").catch(() => console.error("owni: browser profile could not be saved")), this.limits.idleMs);
						s.timer.unref();
						await this.save(s);
					}
				}
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); throw new BrowseError("accesso al browser revocato", "denied"); }
				return result;
			});
		s.queue = run;
		return run;
	}

	/** The late choosers of a conversation whose browser closed, told once, in an answer to the agente. */
	private unheard(key: string, options: ViewOptions): string {
		const closed = this.closed.get(key);
		if (options.person === true || closed === undefined || closed.choosers.length === 0) return "";
		closed.choosers = [];
		return `. ${LATE_CHOOSER}`;
	}

	/** The page loaded, and its requests ended (content that arrives after the load). */
	private async settle(s: Session): Promise<void> {
		await s.page.waitForLoadState("load", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
		const until = Date.now() + SETTLE_MS;
		for (let quiet = 0; quiet < 3 && Date.now() < until; ) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			quiet = s.traffic.inflight === 0 ? quiet + 1 : 0;
		}
	}

	/** Where the page is now, for someone watching (`state`). */
	private async remember(s: Session): Promise<{ readonly url: string; readonly title: string }> {
		const title = await within(s.page.title(), READ_TIMEOUT_MS).catch((error: unknown) => {
			if (error instanceof Hung) throw error;
			return "";
		});
		s.shown = { url: this.redact(s, s.page.url()).slice(0, 500), title: this.redact(s, String(title)).slice(0, 200) };
		return s.shown;
	}

	private async snapshot(s: Session, failure: string | undefined, options: ViewOptions): Promise<View> {
		const attr = `data-owni-${randomBytes(4).toString("hex")}`;
		const forms = this.privateForms(s);
		const padding = Math.max(0, ...forms.map((form) => form.length));
		const clean = (text: string, limit: number) => privateSlice(text, forms, 0, limit).slice(0, limit);
		const read = () => within(s.page.evaluate<Raw>(snapshotScript(attr, s.attr, s.flag, options, padding)), READ_TIMEOUT_MS);
		// In the middle of a navigation the page has no document yet: once more, a moment later.
		const rawOrNot = await read().catch(async (error: unknown) => {
			if (error instanceof Hung) throw error;
			await new Promise((resolve) => setTimeout(resolve, 500));
			return read().catch((again: unknown) => {
				if (again instanceof Hung) throw again;
				return undefined;
			});
		});
		const raw: Raw | undefined = rawOrNot !== null && typeof rawOrNot === "object" ? rawOrNot : undefined;
		s.attr = attr;
		const elements = cleanElements(raw?.elements, clean);
		s.elements = new Map(elements.map((e) => [e.ref, e]));
		const from = Math.max(0, Math.floor(options.from ?? 0));
		const offset = from - Math.max(0, from - padding);
		const text = typeof raw?.text === "string" ? privateSlice(raw.text, forms, offset, offset + VIEW_TEXT).slice(0, VIEW_TEXT) : "";
		const length = typeof raw?.textLength === "number" ? raw.textLength : from + text.length;
		const next = Math.min(length, from + VIEW_TEXT);
		const more = typeof raw?.more === "number" ? raw.more : 0;
		const frames = Array.isArray(raw?.frames) ? raw.frames.filter((f): f is string => typeof f === "string").map((f) => clean(f, 200)).slice(0, 5) : [];
		const t = s.traffic;
		const notes: string[] = [];
		const details: string[] = [];
		if (raw === undefined) notes.push("La pagina sta ancora caricando: guardala di nuovo con web_browse senza url.");
		if (failure !== undefined) {
			notes.push("L'azione non è riuscita.");
			details.push(`Errore del browser: ${failure}`);
		}
		if (t.sends.size > 0 || Number(raw?.blockedForms) > 0) {
			notes.push("La pagina ha provato a inviare dati: bloccato, non è partito niente. Il browser legge soltanto; per inviare un modulo si apre la pagina con web_read e si usa web_submit, che chiede l'approvazione.");
			if (t.sends.size > 0) details.push(`Invii bloccati: ${[...t.sends].join(", ")}`);
		} else if (Number(raw?.postForms) > 0) notes.push("Questa pagina ha moduli che inviano dati: il browser non li invia. Per inviarne uno si apre la pagina con web_read e si usa web_submit, che chiede l'approvazione.");
		if (t.files.size > 0) {
			notes.push("Un link porta a un file, non a una pagina: il browser non lo apre. Se è un PDF o un documento, leggilo con web_read passando il suo indirizzo (in «File» qui sotto), o salvalo con web_download.");
			details.push(`File: ${[...t.files].join("; ")}`);
		}
		if (t.hosts.size > 0) details.push(`Bloccato quello che la pagina voleva caricare da siti non consentiti: ${[...t.hosts].join(", ")}`);
		if (t.overBudget) notes.push("La pagina ha caricato troppo: il resto è bloccato. Riaprirla con web_browse e l'url dà un nuovo margine.");
		if (more > 0 || raw?.scannedAll === false) details.push(`Altri ${more > 0 ? more : "molti"} elementi non elencati: web_browse con find e una parola li cerca.`);
		if (frames.length > 0) details.push(`Riquadri con altre pagine dentro (si aprono con web_browse): ${frames.join(", ")}`);
		if (length > next) details.push(`[testo da ${from} a ${next} di ${length} caratteri: web_browse con from=${next} per il resto]`);
		t.sends.clear();
		t.hosts.clear();
		t.files.clear();
		t.overBudget = false;
		// Pixels cannot use text redaction: private input may be echoed anywhere, even after navigation.
		// The owner's separate picture() path remains available in their browser panel.
		const privateScreenshot = options.screenshot === true && options.person !== true && s.privateValues.size > 0;
		if (privateScreenshot) notes.push("Screenshot non disponibile per proteggere i dati privati inseriti in questo browser. Usa la vista testuale con i dati privati oscurati.");
		const screenshot = options.screenshot === true && !privateScreenshot ? await within(s.page.screenshot({ fullPage: false, type: "png", timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 1_000) : undefined;
		const { url, title } = await this.remember(s);
		// The agente reads this view: its numbers are these now.
		if (options.person !== true) s.movedByPerson = false;
		return { url, title, text, elements, notes, details, ...(screenshot === undefined ? {} : { screenshot }), ...(failure === undefined ? {} : { failed: true as const }) };
	}
}

/** A view as Owni reads it: what the page chose goes in the fence, our sentences outside. */
export function describeView(view: View, fence: (text: string) => string): string {
	const list = view.elements.map((e) => `[${e.ref}] ${e.kind}${e.label ? `: ${e.label}` : ""}${e.href ? ` → ${e.href}` : ""}${e.value ? ` (ora: «${e.value}»)` : ""}`).join("\n");
	const body = fence([`URL: ${view.url}${view.title ? `\nTitolo: ${view.title}` : ""}`, view.text, list ? `Elementi (web_click, web_type con il numero):\n${list}` : "", view.details.join("\n")].filter(Boolean).join("\n\n"));
	return [...view.notes, body].join("\n");
}

/** The browser of a conversation; there is none outside one. */
export function sessionKey(scope: string, thread: { readonly channel: string; readonly threadId: string }): string {
	return `${scope}|${thread.channel}:${thread.threadId}`;
}
