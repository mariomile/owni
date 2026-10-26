import { checkedUrl, CookieJar, WebFetchRefused, webFetch, type WebPage } from "./web-fetch.ts";
import type { BrowserContext, Page } from "./web-session.ts";

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
