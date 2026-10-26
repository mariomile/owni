import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { type BrowserState, MAX_TYPED, PRESS_KEYS, type PressKey } from "../core/web-session.ts";
import type { Person } from "./auth.ts";
import type { WebChannel } from "./channel.ts";
import { type AddRoute, HttpError, readJson, STREAMED } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

/**
 * The browser of a console conversation, for the panel next to the chat (ADR 0044): the same
 * browser the agente uses with web_browse, under the same site list.
 */
export type BrowserPanel = {
	/** False when Chromium did not start on this server: the panel says so instead of offering a browser. */
	available(): boolean;
	state(instanceId: string, threadId: string): Promise<BrowserState>;
	picture(instanceId: string, threadId: string): Promise<{ readonly png: Uint8Array; readonly version: number } | undefined>;
	/** Rejects with BrowserPanelError when the site is not allowed or the page does not open. */
	open(instanceId: string, threadId: string, url: string): Promise<BrowserState>;
	back(instanceId: string, threadId: string): Promise<BrowserState>;
	/** A click on the picture, at `x`, `y` as fractions of its width and height (ADR 0103). */
	click(instanceId: string, threadId: string, x: number, y: number): Promise<BrowserState>;
	takeover(instanceId: string, threadId: string, personId: string): Promise<BrowserState>;
	release(instanceId: string, threadId: string, personId: string): Promise<BrowserState>;
	typeText(instanceId: string, threadId: string, personId: string, text: string): Promise<BrowserState>;
	press(instanceId: string, threadId: string, personId: string, key: PressKey): Promise<BrowserState>;
	profile(instanceId: string, personId: string): Promise<{ readonly hosts: readonly string[] }>;
	clearProfile(instanceId: string, personId: string): Promise<void>;
};

/** What the person can read: a site not allowed, a page that does not open, no browser on this server. */
export class BrowserPanelError extends Error {
	override readonly name = "BrowserPanelError";
	constructor(message: string, readonly status = 400) { super(message); }
}

export type BrowserRoutesDeps = Pick<WebAppOptions, "browser"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly instanceAccess: (person: Person, instanceId: string) => Promise<{ readonly record: InstanceRecord; readonly member: boolean }>;
	readonly channelOf: (instanceId: string) => WebChannel;
	readonly ownThread: (person: Person, instanceId: string, threadId: string) => Promise<InstanceRecord>;
};

/** The conversation's browser (ADR 0044): watched and driven from the panel next to the chat. */
export function browserRoutes(route: AddRoute, options: BrowserRoutesDeps): void {
	const { runtime, tenantId, instanceAccess, channelOf, ownThread } = options;
	const browserThread = async (person: Person, instanceId: string, threadId: string) => {
		if (options.browser === undefined) {
			await instanceAccess(person, instanceId);
			throw new HttpError(404, "Il browser non è disponibile su questo server");
		}
		const record = await ownThread(person, instanceId, threadId);
		if ((await channelOf(instanceId).thread(threadId))?.room !== undefined) throw new HttpError(404, "No such thread");
		// Who may drive it: who may chat here now, the same rule as the console's chat.
		const canChat = (record.allowedUsers.web ?? []).includes(person.id) && record.egress.channels.includes("web");
		if (!canChat) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questo agente");
		return { browser: options.browser, canChat };
	};
	const browserCall = async <T>(work: () => Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			if (error instanceof BrowserPanelError) throw new HttpError(error.status, error.message);
			throw error;
		}
	};
	route("GET", "/api/instances/:id/threads/:thread/browser", "person", async ({ person, params }) => {
		const { browser } = await browserThread(person, params[0], params[1]);
		return { browser: await browser.state(params[0], params[1]), available: browser.available() };
	});
	route("GET", "/api/instances/:id/threads/:thread/browser.png", "person", async ({ person, params, res }) => {
		const { browser } = await browserThread(person, params[0], params[1]);
		const picture = await browser.picture(params[0], params[1]);
		if (picture === undefined) throw new HttpError(404, "Nessuna pagina aperta");
		res.writeHead(200, { "content-type": "image/png", "content-length": picture.png.length, "x-content-type-options": "nosniff", "cache-control": "no-store" });
		res.end(picture.png);
		return STREAMED;
	});
	route("POST", "/api/instances/:id/threads/:thread/browser", "person", async ({ person, params, req }) => {
		const { browser, canChat } = await browserThread(person, params[0], params[1]);
		if (!canChat) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questo agente");
		const body = (await readJson(req)) as { url?: unknown; back?: unknown };
		const [instanceId, threadId] = [params[0], params[1]];
		if (body.back === true) return { browser: await browserCall(() => browser.back(instanceId, threadId)) };
		if (typeof body.url !== "string" || body.url.trim() === "" || body.url.length > 2000) throw new HttpError(400, "Scrivi l'indirizzo di una pagina");
		const raw = body.url.trim();
		const url = /^[a-z][\w+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
		// Which site, never the full address: the audit keeps who drove the agente's browser where, refused or not.
		const host = URL.canParse(url) ? new URL(url).host : "";
		const record = (ok: boolean) => runtime.audit(tenantId).append({ type: "web.browser.opened", instanceId, personId: person.id, host, ok });
		try {
			const state = await browserCall(() => browser.open(instanceId, threadId, url));
			await record(true);
			return { browser: state };
		} catch (error) {
			await record(false);
			throw error;
		}
	});
	route("POST", "/api/instances/:id/threads/:thread/browser/click", "person", async ({ person, params, req }) => {
		const { browser, canChat } = await browserThread(person, params[0], params[1]);
		if (!canChat) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questo agente");
		const { x, y } = (await readJson(req)) as { x?: unknown; y?: unknown };
		if (typeof x !== "number" || typeof y !== "number" || !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new HttpError(400, "Il clic non è sulla pagina");
		const instanceId = params[0];
		const record = (ok: boolean) => runtime.audit(tenantId).append({ type: "web.browser.clicked", instanceId, personId: person.id, ok });
		try {
			const state = await browserCall(() => browser.click(instanceId, params[1], x, y));
			await record(true);
			return { browser: state };
		} catch (error) {
			await record(false);
			throw error;
		}
	});
	for (const action of ["takeover", "release"] as const) {
		route("POST", `/api/instances/:id/threads/:thread/browser/${action}`, "person", async ({ person: p, params }) => {
			const [instanceId, threadId] = params;
			const { browser } = await browserThread(p, instanceId, threadId);
			const state = await browserCall(() => browser[action](instanceId, threadId, p.id));
			await runtime.audit(tenantId).append({ type: action === "takeover" ? "web.browser.takeover" : "web.browser.released", instanceId, personId: p.id });
			return { browser: state };
		});
	}
	route("POST", "/api/instances/:id/threads/:thread/browser/type", "person", async ({ person: p, params, req }) => {
		const [instanceId, threadId] = params;
		const { browser } = await browserThread(p, instanceId, threadId);
		const body = (await readJson(req)) as { text?: unknown };
		if (typeof body.text !== "string" || body.text.length === 0 || body.text.length > MAX_TYPED) throw new HttpError(400, `Scrivi da 1 a ${MAX_TYPED} caratteri`);
		// Private input goes only to the focused field: never to a transcript or audit event.
		return { browser: await browserCall(() => browser.typeText(instanceId, threadId, p.id, body.text as string)) };
	});
	route("POST", "/api/instances/:id/threads/:thread/browser/press", "person", async ({ person: p, params, req }) => {
		const [instanceId, threadId] = params;
		const { browser } = await browserThread(p, instanceId, threadId);
		const body = (await readJson(req)) as { key?: unknown };
		if (typeof body.key !== "string" || !(PRESS_KEYS as readonly string[]).includes(body.key)) throw new HttpError(400, "Tasto non disponibile");
		return { browser: await browserCall(() => browser.press(instanceId, threadId, p.id, body.key as PressKey)) };
	});
	route("GET", "/api/instances/:id/threads/:thread/browser/profile", "person", async ({ person: p, params }) => {
		const { browser } = await browserThread(p, params[0], params[1]);
		return browserCall(() => browser.profile(params[0], p.id));
	});
	route("DELETE", "/api/instances/:id/threads/:thread/browser/profile", "person", async ({ person: p, params }) => {
		const instanceId = params[0];
		const { browser } = await browserThread(p, instanceId, params[1]);
		await browserCall(() => browser.clearProfile(instanceId, p.id));
		await runtime.audit(tenantId).append({ type: "web.browser.profile_cleared", instanceId, personId: p.id });
		return { ok: true };
	});
}
