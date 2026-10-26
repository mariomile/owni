import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieJar } from "../src/core/web-fetch.ts";
import { BrowserProfiles } from "../src/core/web-profiles.ts";
import { MAX_TYPED } from "../src/core/web-page-scripts.ts";
import { type Browser, type BrowserContext, BrowseSessions, type Page } from "../src/core/web-session.ts";
import { tempDataDir } from "./helpers.ts";

const key = "acme/ops|web:alice";
const guard = { hostAllowed: (host: string) => host === "127.0.0.1", addressAllowed: (address: string) => address === "127.0.0.1" };
const closers: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const close of closers.splice(0).reverse()) await close();
});

// Keep a detached page responsive so late operations cannot hide behind Chromium closing it.
function fakeContext() {
	let route!: Parameters<BrowserContext["route"]>[1];
	let url = "about:blank";
	let closed = false;
	const closing = barrier();
	const frame = {};
	const document = "fixture-document";
	let edit = "";
	let binding: Parameters<NonNullable<BrowserContext["exposeBinding"]>>[1] | undefined;
	const page = {
		mainFrame: () => frame,
		goto: async (next: string) => { url = next; }, goBack: async () => {},
		screenshot: async () => new Uint8Array([1, 2, 3]),
		title: async () => "Private page", url: () => url,
		evaluate: async (expression: string): Promise<unknown> => {
			if (expression.includes("const editToken =")) {
				edit = JSON.parse(/const editToken = ("[a-f0-9]+");/.exec(expression)![1]!);
				return { focused: true, editing: true, document };
			}
			return expression.includes("const values = []") ? [] : { text: "Private page", textLength: 12, elements: [] };
		},
		click: async () => {}, mouse: { click: async () => {} }, fill: async (_selector: string, value: string) => { await binding?.({ page: page as unknown as Page, frame }, document, edit, value); },
		selectOption: async () => {}, press: async () => {}, waitForLoadState: async () => {}, on: () => {}, close: async () => {},
	};
	const context = { route: async (_url: string, handler: typeof route) => { route = handler; }, routeWebSocket: async () => {}, exposeBinding: async (_name: string, callback: NonNullable<typeof binding>) => { binding = callback; }, addInitScript: async () => {}, on: () => {}, newPage: async () => page, close: async () => { closed = true; closing.resolve(); } };
	return { context, page, document, edit: () => edit, input: (doc: string, token: string, value: unknown, sourceFrame: unknown = frame) => binding!({ page: page as unknown as Page, frame: sourceFrame }, doc, token, value), closed: () => closed, closing: closing.promise, request: (request: Parameters<typeof route>[0]) => route(request) };
}

async function start() {
	const seen: string[] = [];
	const server = createServer((req, res) => { seen.push(req.headers.cookie ?? ""); res.end("OK"); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const dataDir = tempDataDir();
	closers.push(() => rm(dataDir, { recursive: true, force: true }));
	await mkdir(join(dataDir, "tenants/acme/instances/ops"), { recursive: true });
	const profiles = new BrowserProfiles(dataDir);
	const jar = new CookieJar();
	jar.take(new URL(base), ["sid=old-login; Path=/"]);
	await profiles.save("acme/ops", "alice", jar);
	const contexts: ReturnType<typeof fakeContext>[] = [];
	const browser = { newContext: async () => { const next = fakeContext(); contexts.push(next); return next.context; }, close: async () => {}, on: () => {} } as unknown as Browser;
	let held: { remaining: number; entered: ReturnType<typeof barrier>; resume: ReturnType<typeof barrier> } | undefined;
	const sessions = new BrowseSessions(undefined, undefined, { profiles, owner: async () => {
		if (held !== undefined && --held.remaining === 0) {
			const gate = held;
			held = undefined;
			gate.entered.resolve();
			await gate.resume.promise;
		}
		return "alice";
	} });
	closers.push(() => sessions.closeAll());
	await sessions.open(key, browser, base, guard);
	return { sessions, profiles, browser, base, seen, contexts, holdOwner(after = 1) {
		const gate = { remaining: after, entered: barrier(), resume: barrier() };
		held = gate;
		releases.push(gate.resume.resolve);
		return { entered: gate.entered.promise, resume: gate.resume.resolve };
	} };
}

describe("browser revocation across asynchronous boundaries", () => {
	it("does not send old cookies after clearProfile completes during the request's final ownership read", async () => {
		const f = await start();
		const old = f.contexts[0]!;
		const gate = f.holdOwner(2);
		let aborted = false;
		const pending = old.request({ request: () => ({ url: () => `${f.base}/after-clear`, method: () => "GET", isNavigationRequest: () => false }), fulfill: async () => {}, abort: async () => { aborted = true; } });
		await gate.entered;
		await f.sessions.clearProfile("acme/ops", "alice");
		expect(old.closed()).toBe(true);
		await f.sessions.open(key, f.browser, f.base, guard);
		gate.resume();
		await pending;
		expect(f.seen).toEqual([]);
		expect(aborted).toBe(true);
		expect(f.sessions.has(key)).toBe(true);
	});

	it("rejects a paused old action without closing a replacement session of the same person", async () => {
		const f = await start();
		const gate = f.holdOwner();
		const pending = f.sessions.view(key, guard).then(() => "unexpected-view", (error: unknown) => error);
		await gate.entered;
		await f.sessions.clearProfile("acme/ops", "alice");
		await f.sessions.open(key, f.browser, f.base, guard);
		gate.resume();
		expect(await pending).toMatchObject({ kind: "denied" });
		expect(f.sessions.has(key)).toBe(true);
	});

	it("does not save an invalidated profile when the save's ownership read resumes", async () => {
		const f = await start();
		const save = vi.spyOn(f.profiles, "save");
		// Action admission, pre-snapshot ownership, then the queued profile save's read.
		const gate = f.holdOwner(3);
		const pending = f.sessions.view(key, guard).catch((error: unknown) => error);
		await gate.entered;
		const clearing = f.sessions.clearProfile("acme/ops", "alice");
		await f.contexts[0]!.closing;
		gate.resume();
		await clearing;
		await pending;
		expect(save).not.toHaveBeenCalled();
		expect((await f.profiles.load("acme/ops", "alice")).snapshot()).toEqual([]);
	});

	it.each(["cached", "capturing"] as const)("does not return a %s picture from a cleared session", async (mode) => {
		const f = await start();
		let entered: Promise<void>;
		let resume: () => void;
		if (mode === "cached") {
			await f.sessions.picture(key);
			({ entered, resume } = f.holdOwner());
		} else {
			const began = barrier();
			const done = barrier();
			entered = began.promise;
			resume = done.resolve;
			releases.push(resume);
			f.contexts[0]!.page.screenshot = async () => { began.resolve(); await done.promise; return new Uint8Array([1, 2, 3]); };
		}
		const pending = f.sessions.picture(key);
		await entered;
		await f.sessions.clearProfile("acme/ops", "alice");
		await f.sessions.open(key, f.browser, f.base, guard);
		resume();
		expect(await pending).toBeUndefined();
		expect(f.sessions.has(key)).toBe(true);
	});

	it("redacts private values before browser error messages are shortened", async () => {
		const f = await start();
		const secret = "sensitive-error-fragment-".repeat(24);
		await f.sessions.takeover(key, "alice", guard);
		await f.sessions.typeText(key, "alice", secret, guard);
		await f.sessions.release(key, "alice");
		f.contexts[0]!.page.goto = async () => { throw new Error(`Navigation failed: ${secret}`); };
		const view = await f.sessions.open(key, f.browser, f.base, guard);
		expect(view.failed).toBe(true);
		expect(view.details.join(" ")).toContain("Navigation failed");
		expect(view.details.join(" ")).not.toContain("sensitive-error");
	});

	it.each(["value length", "history count"] as const)("closes instead of exposing native private edits beyond the %s limit", async (limit) => {
		const f = await start();
		await f.sessions.takeover(key, "alice", guard);
		const page = f.contexts[0]!.page;
		const evaluate = page.evaluate;
		page.evaluate = (expression) => expression.includes("const values = []")
			? Promise.resolve(limit === "value length" ? ["x".repeat(MAX_TYPED + 1)] : Array.from({ length: 256 }, (_, i) => `native-private-${i}`))
			: evaluate(expression);
		await expect(f.sessions.typeText(key, "alice", "supplied-private", guard)).rejects.toMatchObject({ kind: "failed" });
		expect(f.contexts[0]!.closed()).toBe(true);
		expect(f.sessions.state(key)).toMatchObject({ open: false });
		await expect(f.sessions.view(key, guard, { screenshot: true })).rejects.toThrow();
	});

	it.each(["missing", "malformed"] as const)("aborts navigation on a %s private-input acknowledgement instead of trusting empty destination fields", async (mode) => {
		const f = await start();
		await f.sessions.takeover(key, "alice", guard);
		const old = f.contexts[0]!;
		let aborted = false;
		old.page.fill = async () => {
			const navigation = old.request({ request: () => ({ url: () => `${f.base}/private-echo`, method: () => "GET", isNavigationRequest: () => true, frame: () => old.page.mainFrame() }), fulfill: async () => {}, abort: async () => { aborted = true; } });
			if (mode === "malformed") expect(await old.input(old.document, old.edit(), { invalid: true })).toBe(false);
			await navigation;
		};
		await expect(f.sessions.typeText(key, "alice", "private-original", guard)).rejects.toThrow();
		expect(aborted).toBe(true);
		expect(f.seen).toEqual([]);
		expect(old.closed()).toBe(true);
		expect(f.sessions.has(key)).toBe(false);
	});

	it("rejects stale edit, document, iframe and cleared-session acknowledgements before any cookies are sent", async () => {
		const f = await start();
		await f.sessions.takeover(key, "alice", guard);
		await f.sessions.typeText(key, "alice", "private-original", guard);
		const old = f.contexts[0]!;
		const previous = old.edit();
		const entered = barrier();
		let aborted = false;
		old.page.fill = async () => {
			await old.request({ request: () => ({ url: () => `${f.base}/after-capture`, method: () => "GET", isNavigationRequest: () => true, frame: () => { entered.resolve(); return old.page.mainFrame(); } }), fulfill: async () => {}, abort: async () => { aborted = true; } });
		};
		const action = f.sessions.typeText(key, "alice", "private-next", guard).catch((error: unknown) => error);
		await entered.promise;
		const current = old.edit();
		expect(await old.input(old.document, previous, "stale-value")).toBe(false);
		expect(await old.input("replacement-document", current, "other-document-value")).toBe(false);
		expect(await old.input(old.document, current, "iframe-value", {})).toBe(false);
		expect(f.seen).toEqual([]);
		await f.sessions.clearProfile("acme/ops", "alice");
		await f.sessions.open(key, f.browser, f.base, guard);
		expect(await old.input(old.document, current, "late-value")).toBe(false);
		expect(await action).toBeInstanceOf(Error);
		expect(aborted).toBe(true);
		expect(f.seen).toEqual([]);
		expect(f.sessions.has(key)).toBe(true);
	});
});
