import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/core/engine.ts";
import { createWebTools } from "../src/core/tools/web-tools.ts";
import { BrowserProfiles } from "../src/core/web-profiles.ts";
import { type Browser, type BrowseAccounts, BrowseSessions, describeView, sessionKey, type View } from "../src/core/web-session.ts";
import { Workspace } from "../src/core/workspace.ts";
import { tempDataDir } from "./helpers.ts";

// Match browser-file-chooser.test.ts: use the installed browser, never download one.
const chrome = process.env.OWNI_CHROMIUM_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const available = chrome !== undefined && existsSync(chrome);
const scope = "acme/ops";
const alice = sessionKey(scope, { channel: "web", threadId: "alice-main" });
const sibling = sessionKey(scope, { channel: "web", threadId: "alice-other" });
const bob = sessionKey(scope, { channel: "web", threadId: "bob-main" });
const username = "fixture-alice-947b";
const password = "fixture-password-368c";
const cookie = "sid=fixture-session";
const guard = { hostAllowed: (host: string) => host === "127.0.0.1", addressAllowed: (address: string) => address === "127.0.0.1" };
const human = { person: true } as const;
const point = (y: number) => [150 / 1280, y / 800] as const;
const box = (y: number) => `position:fixed;left:100px;top:${y}px;width:240px;height:60px;margin:0`;
const closers: (() => Promise<void>)[] = [];
const unblock: (() => void)[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

afterEach(async () => {
	for (const release of unblock.splice(0)) release();
	for (const close of closers.splice(0).reverse()) await close();
});

type Seen = { method: string; path: string; cookie: string; contentType: string; body: string };

async function serve() {
	const seen: Seen[] = [];
	const gates = new Map<string, { entered: ReturnType<typeof deferred<Seen>>; release: ReturnType<typeof deferred<void>> }>();
	let redirectTo = "";
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const path = req.url ?? "/";
		const item: Seen = { method: req.method ?? "GET", path, cookie: req.headers.cookie ?? "", contentType: req.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString() };
		seen.push(item);
		const gate = gates.get(path);
		if (gate !== undefined) {
			gate.entered.resolve(item);
			await gate.release.promise;
		}
		const pathname = new URL(path, "http://127.0.0.1").pathname;
		if (pathname === "/private-file") {
			res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4");
			return;
		}
		if (pathname === "/login" && req.method === "POST") {
			const fields = new URLSearchParams(item.body);
			if (fields.get("username") !== username || fields.get("password") !== password) {
				res.writeHead(401, { "content-type": "text/html" }).end("Login refused");
				return;
			}
			res.writeHead(303, { location: "/account", "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Lax` }).end();
			return;
		}
		if (/^\/redirect-(307|308)$/.test(pathname) && req.method === "POST") {
			res.writeHead(Number(pathname.slice(-3)), { location: redirectTo }).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(pathname === "/rotate" ? { "set-cookie": "sid=late-session; Path=/" } : {}) });
		const form = (action: string, enctype = "application/x-www-form-urlencoded") => `<form method="post" action="${action}" enctype="${enctype}"><label>Username<input name="username" style="${box(100)}"></label><label>Password<input name="password" type="password" style="${box(220)}"></label><button style="${box(340)}">Sign in</button></form>`;
		const pages: Record<string, string> = {
			"/login": form("/login"),
			"/account": `<h1>${item.cookie.includes(cookie) ? "Signed in" : "Signed out"}</h1>`,
			"/plain": "<title>Ready</title><p>Ready</p>",
			"/slow-page": "<title>Finished</title><p>Finished</p>",
			"/rotate": "<p>Rotated</p>",
			"/requests": `<form method="post" action="/agent-post"><button style="${box(100)}">Send form</button></form><button style="${box(220)}" onclick="Promise.all([fetch('/fetch-post', { method: 'POST', body: 'synthetic-fetch' }).then(() => 'sent', () => 'blocked'), new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.open('POST', '/xhr-post'); xhr.onload = () => resolve('sent'); xhr.onerror = () => resolve('blocked'); xhr.send('synthetic-xhr'); })]).then(results => document.body.dataset.results = results.join(','))">Fetch and XHR</button>`,
			"/private": `<input id="text" aria-label="Private text" style="${box(100)}"><textarea id="note" aria-label="Private note" style="${box(220)}"></textarea><input id="password" aria-label="Private password" type="password" style="${box(340)}"><output id="echo"></output><a id="mirror" href="/plain">Continue</a><script>document.addEventListener('input', () => { const value = [...document.querySelectorAll('input,textarea')].map(e => e.value).join(' '); document.getElementById('echo').textContent = value; document.title = value; document.getElementById('mirror').setAttribute('aria-label', value); document.getElementById('mirror').href = '/plain?value=' + encodeURIComponent(document.getElementById('text').value); });</script>`,
			"/private-get": `<form method="get" action="/private-search"><input name="q" style="${box(100)}"><button>Search</button></form>`,
			"/private-get-multiline": `<form method="get" action="/private-search"><textarea name="q" style="${box(100)}"></textarea><button style="${box(220)}">Search</button></form>`,
			"/private-native": `<form method="get" action="/private-echo"><input id="field" name="q" ${new URL(path, "http://127.0.0.1").searchParams.has("maxlength") ? 'maxlength="10"' : ""} style="${box(100)}"><button style="${box(220)}">Search</button></form><output id="history"></output><script>document.getElementById('field').addEventListener('input', e => { document.getElementById('history').textContent += ' ' + e.target.value; document.title = e.target.value; });</script>`,
			"/private-autosubmit": `<form method="get" action="/private-echo"><input id="field" name="q" ${new URL(path, "http://127.0.0.1").searchParams.has("edit") ? 'oninput="if (event.inputType === \'deleteContentBackward\') this.form.requestSubmit()"' : 'maxlength="10" oninput="this.form.requestSubmit()"'} style="${box(100)}"><button>Search</button></form>`,
			"/private-echo": `<h1>Ordinary form result</h1><p id="echo"></p><script>document.getElementById('echo').textContent = new URL(location.href).searchParams.get('q')</script>`,
			"/private-search": `<main id="echo"></main><button id="label"></button><a id="link">Link</a><input id="copy"><select id="options"></select><button>Public action</button><a id="file">Download</a><script>const value = new URL(location.href).searchParams.get('q'); document.title = value; document.getElementById('echo').textContent = 'p'.repeat(7980) + value + ' Public end'; document.getElementById('label').textContent = value + value; document.getElementById('link').href = '/plain?' + new URLSearchParams({q:value + value}); document.getElementById('copy').value = value + value; document.getElementById('options').add(new Option(value + value, value + value)); document.getElementById('file').href = '/private-file?' + new URLSearchParams({q:value});</script>`,
			"/redirect-form-307": form("/redirect-307"),
			"/redirect-form-308": form("/redirect-308"),
			"/multipart": form("/unsupported", "multipart/form-data"),
			"/text-plain": form("/unsupported", "text/plain"),
			"/cross-origin": form(redirectTo),
		};
		res.end(`<!doctype html><meta charset="utf-8">${pages[pathname] ?? "<p>OK</p>"}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		base, seen,
		redirect(url: string) { redirectTo = url; },
		hold(path: string) {
			const gate = { entered: deferred<Seen>(), release: deferred<void>() };
			gates.set(path, gate);
			const release = () => gate.release.resolve();
			unblock.push(release);
			return { entered: gate.entered.promise, release };
		},
	};
}

async function start() {
	const dataDir = tempDataDir();
	closers.push(() => rm(dataDir, { recursive: true, force: true }));
	for (const [tenant, instance] of [["acme", "ops"], ["acme", "other"], ["other", "ops"]]) {
		await mkdir(join(dataDir, "tenants", tenant!, "instances", instance!), { recursive: true });
	}
	const site = await serve();
	const { chromium } = await import("playwright-core");
	const chromiumBrowser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
	const browser = chromiumBrowser as unknown as Browser;
	const allowedUsers = new Set(["alice", "bob"]);
	const submissions: [string, string, string][] = [];
	const owner: BrowseAccounts["owner"] = async (_scope, thread) => {
		const person = thread.threadId.split("-")[0];
		return thread.channel === "web" && person !== undefined && allowedUsers.has(person) ? person : undefined;
	};
	const managers: BrowseSessions[] = [];
	const createSessions = () => {
		const sessions = new BrowseSessions({ max: 8, idleMs: 60_000 }, undefined, {
			owner,
			profiles: new BrowserProfiles(dataDir),
			submitted: (key, person, host) => submissions.push([key, person, host]),
		});
		managers.push(sessions);
		return sessions;
	};
	const sessions = createSessions();
	closers.push(async () => {
		for (const manager of managers) await manager.closeAll();
		await chromiumBrowser.close();
	});
	const pageAt = (url: string): Page => {
		const page = chromiumBrowser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === url);
		expect(page, `page at ${url}`).toBeDefined();
		return page!;
	};
	return { ...site, dataDir, browser, chromiumBrowser, sessions, createSessions, allowedUsers, submissions, pageAt };
}

type Fixture = Awaited<ReturnType<typeof start>>;

function privateResult(value: unknown, ...secrets: string[]) {
	const serialized = JSON.stringify(value);
	for (const secret of secrets) expect(serialized).not.toContain(secret);
}

async function login(f: Fixture) {
	await f.sessions.open(alice, f.browser, `${f.base}/login`, guard);
	expect(await f.sessions.takeover(alice, "alice", guard)).toMatchObject({ open: true, control: "person", profile: true });
	await f.sessions.clickAt(alice, ...point(130), guard, human);
	privateResult(await f.sessions.typeText(alice, "alice", username, guard), username);
	await f.sessions.press(alice, "alice", "Tab", guard);
	privateResult(await f.sessions.typeText(alice, "alice", password, guard), username, password);
	privateResult(await f.sessions.press(alice, "alice", "Enter", guard), username, password);
	expect(f.seen.filter((request) => request.path === "/login" && request.method === "POST")).toHaveLength(1);
	expect(f.seen.find((request) => request.path === "/account")?.cookie, "the 303 redirect must pass through the guarded cookie jar").toBe(cookie);
	expect(f.sessions.state(alice)).toMatchObject({ open: true, control: "person", url: `${f.base}/account` });
	expect(await f.sessions.release(alice, "alice")).toMatchObject({ control: "agent" });
	expect((await f.sessions.view(alice, guard)).text).toContain("Signed in");
}

describe.skipIf(!available)("browser takeover, in real Chromium", () => {
	it("submits the person's basic login and restores only their saved cookies after a new BrowseSessions", async () => {
		const f = await start();
		await login(f);
		const sent = f.seen.find((request) => request.method === "POST");
		expect(sent?.contentType).toMatch(/^application\/x-www-form-urlencoded/);
		expect(Object.fromEntries(new URLSearchParams(sent?.body))).toEqual({ username, password });
		expect(f.submissions).toEqual([[alice, "alice", new URL(f.base).host]]);
		expect(await f.sessions.profile(scope, "alice")).toEqual({ hosts: ["127.0.0.1"] });
		await f.sessions.closeAll();
		expect(f.chromiumBrowser.contexts()).toHaveLength(0);
		const profileDir = join(f.dataDir, "tenants", "acme", "instances", "ops", "browser");
		const files = (await readdir(profileDir)).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(1);
		privateResult(await readFile(join(profileDir, files[0]!), "utf8"), username, password);
		const restarted = f.createSessions();
		expect((await restarted.open(alice, f.browser, `${f.base}/account?restart`, guard)).text).toContain("Signed in");
		expect(f.seen.find((request) => request.path === "/account?restart")?.cookie).toBe(cookie);
	});

	it("shares the live profile with the same person, while denying another person and isolating tenant and instance", async () => {
		const f = await start();
		expect((await f.sessions.open(sibling, f.browser, `${f.base}/account?sibling-before`, guard)).text).toContain("Signed out");
		await login(f);
		expect((await f.sessions.open(sibling, f.browser, `${f.base}/account?sibling-after`, guard)).text).toContain("Signed in");
		await f.sessions.takeover(alice, "alice", guard);
		for (const action of [() => f.sessions.takeover(alice, "bob", guard), () => f.sessions.release(alice, "bob"), () => f.sessions.typeText(alice, "bob", "intruder", guard), () => f.sessions.press(alice, "bob", "Enter", guard)]) {
			await expect(action()).rejects.toMatchObject({ kind: "denied" });
		}
		expect(f.sessions.state(alice)).toMatchObject({ control: "person" });
		for (const [key, label] of [[bob, "other-person"], [sessionKey("acme/other", { channel: "web", threadId: "alice-main" }), "other-instance"], [sessionKey("other/ops", { channel: "web", threadId: "alice-main" }), "other-tenant"]] as const) {
			expect((await f.sessions.open(key, f.browser, `${f.base}/account?${label}`, guard)).text).toContain("Signed out");
			expect(f.seen.find((request) => request.path === `/account?${label}`)?.cookie).toBe("");
		}
		expect(f.chromiumBrowser.contexts()).toHaveLength(5);
	});

	it("clears all the person's browsers and cannot revive cookies from an old in-flight response or a restart", async () => {
		const f = await start();
		await login(f);
		await f.sessions.open(sibling, f.browser, `${f.base}/plain`, guard);
		await f.sessions.open(bob, f.browser, `${f.base}/account?bob`, guard);
		const gate = f.hold("/rotate");
		const oldPage = f.pageAt(`${f.base}/plain`);
		const closed = oldPage.waitForEvent("close");
		const lateAction = f.sessions.open(sibling, f.browser, `${f.base}/rotate`, guard).catch((error: unknown) => error);
		expect((await gate.entered).cookie).toBe(cookie);
		const clearing = f.sessions.clearProfile(scope, "alice");
		await closed;
		gate.release();
		await clearing;
		await lateAction;
		expect(f.sessions.state(alice)).toMatchObject({ open: false });
		expect(f.sessions.state(sibling)).toMatchObject({ open: false });
		expect(f.sessions.state(bob)).toMatchObject({ open: true });
		expect(await f.sessions.profile(scope, "alice")).toEqual({ hosts: [] });
		expect((await f.sessions.open(alice, f.browser, `${f.base}/account?cleared`, guard)).text).toContain("Signed out");
		expect(f.seen.find((request) => request.path === "/account?cleared")?.cookie).toBe("");
		await f.sessions.closeAll();
		expect((await f.createSessions().open(alice, f.browser, `${f.base}/account?cleared-restart`, guard)).text).toContain("Signed out");
		expect(f.seen.find((request) => request.path === "/account?cleared-restart")?.cookie).toBe("");
	});

	it("rechecks the allowedUsers-backed owner before an agent action and each autonomous request can send cookies", async () => {
		const f = await start();
		await login(f);
		const page = f.pageAt(`${f.base}/account`);
		const gate = f.hold("/permission-barrier");
		const background = page.evaluate<string>("fetch('/permission-barrier').then(() => fetch('/account?revoked-background')).then(() => 'sent', () => 'blocked')");
		expect((await gate.entered).cookie).toBe(cookie);
		f.allowedUsers.delete("alice");
		gate.release();
		expect(await background).toBe("blocked");
		expect(f.seen.some((request) => request.path === "/account?revoked-background")).toBe(false);
		await expect(f.sessions.open(alice, f.browser, `${f.base}/account?revoked-agent`, guard)).rejects.toMatchObject({ kind: "denied" });
		expect(f.sessions.state(alice)).toMatchObject({ open: false });
		await expect(f.sessions.view(alice, guard)).rejects.toThrow();
		await expect(f.sessions.takeover(alice, "alice", guard)).rejects.toThrow();
		expect(f.seen.some((request) => request.path === "/account?revoked-agent")).toBe(false);
	});

	it("rejects every held agent action and blocks agent form submits plus person-triggered fetch and XHR POST", async () => {
		const f = await start();
		const initial = await f.sessions.open(alice, f.browser, `${f.base}/requests`, guard);
		const button = initial.elements.find((element) => element.label === "Send form")!;
		expect(button).toBeDefined();
		await f.sessions.click(alice, button.ref, guard);
		expect(f.seen.filter((request) => request.method === "POST")).toEqual([]);
		await f.sessions.takeover(alice, "alice", guard);
		for (const action of [() => f.sessions.open(alice, f.browser, `${f.base}/never-open`, guard), () => f.sessions.view(alice, guard), () => f.sessions.click(alice, button.ref, guard), () => f.sessions.clickAt(alice, ...point(130), guard), () => f.sessions.type(alice, button.ref, "agent", true, guard)]) {
			await expect(action()).rejects.toMatchObject({ kind: "held" });
		}
		const page = f.pageAt(`${f.base}/requests`);
		const finished = page.waitForFunction("document.body.dataset.results === 'blocked,blocked'");
		await f.sessions.clickAt(alice, ...point(250), guard, human);
		await finished;
		expect(f.seen.filter((request) => request.method === "POST")).toEqual([]);
		expect(f.seen.some((request) => request.path === "/never-open")).toBe(false);
		expect(f.submissions).toEqual([]);
	});

	it("keeps private input out of views and model results, including page echoes after release, and blanks every typed field", async () => {
		const f = await start();
		await f.sessions.open(alice, f.browser, `${f.base}/private`, guard);
		await f.sessions.takeover(alice, "alice", guard);
		await expect(f.sessions.typeText(alice, "alice", "not-focused", guard)).rejects.toMatchObject({ kind: "no-field" });
		const secrets = ["private-text-947b", "private-note-368c", "private-password-752d"];
		const views: View[] = [];
		for (const [index, y] of [130, 250, 370].entries()) {
			views.push(await f.sessions.clickAt(alice, ...point(y), guard, human));
			views.push(await f.sessions.typeText(alice, "alice", secrets[index]!, guard));
		}
		views.push(await f.sessions.view(alice, guard, human));
		for (const view of views) {
			privateResult(view, ...secrets);
			privateResult(describeView(view, (text) => text), ...secrets);
		}
		const page = f.pageAt(`${f.base}/private`);
		expect(await page.locator("#text").inputValue()).toBe(secrets[0]);
		expect(await page.locator("#note").inputValue()).toBe(secrets[1]);
		expect(await page.locator("#password").inputValue()).toBe(secrets[2]);
		privateResult(await f.sessions.release(alice, "alice"), ...secrets);
		for (const selector of ["#text", "#note", "#password"]) expect(await page.locator(selector).inputValue()).toBe("");
		const released = await f.sessions.view(alice, guard);
		privateResult(released, ...secrets);
		privateResult(describeView(released, (text) => text), ...secrets);
		expect(released.elements.some((element) => element.tag === "input")).toBe(true);
		const profileDir = join(f.dataDir, "tenants", "acme", "instances", "ops", "browser");
		for (const file of await readdir(profileDir)) privateResult(await readFile(join(profileDir, file), "utf8"), ...secrets);
	});

	it.each(["Backspace and Enter", "maxlength and click"] as const)("retains actual private field values after native edits: %s", async (mode) => {
		const f = await start();
		const limited = mode === "maxlength and click";
		const url = `${f.base}/private-native${limited ? "?maxlength" : ""}`;
		await f.sessions.open(alice, f.browser, url, guard);
		await f.sessions.takeover(alice, "alice", guard);
		await f.sessions.clickAt(alice, ...point(130), guard, human);
		const supplied = "private-value-947bX";
		const actual = limited ? supplied.slice(0, 10) : supplied.slice(0, -1);
		const filled = await f.sessions.typeText(alice, "alice", supplied, guard);
		const edited = limited ? filled : await f.sessions.press(alice, "alice", "Backspace", guard);
		expect(await f.pageAt(url).locator("#field").inputValue()).toBe(actual);
		expect.soft(JSON.stringify(edited)).not.toContain(actual);
		const submitted = limited ? await f.sessions.clickAt(alice, ...point(250), guard, human) : await f.sessions.press(alice, "alice", "Enter", guard);
		const request = f.seen.find((request) => request.path.startsWith("/private-echo?"));
		expect(new URL(request!.path, f.base).searchParams.get("q")).toBe(actual);
		const released = await f.sessions.release(alice, "alice");
		const view = await f.sessions.view(alice, guard);
		for (const result of [submitted, released, view, describeView(view, (text) => text)]) expect.soft(JSON.stringify(result)).not.toContain(actual);
		expect(view.text).toContain("Ordinary form result");
	});

	it.each(["click-submit", "release", "navigation"] as const)("captures the current marked field before %s can discard it", async (action) => {
		const f = await start();
		const url = `${f.base}/private-native`;
		await f.sessions.open(alice, f.browser, url, guard);
		await f.sessions.takeover(alice, "alice", guard);
		await f.sessions.clickAt(alice, ...point(130), guard, human);
		const supplied = "original-private-947b";
		const actual = "edited-private-368c";
		await f.sessions.typeText(alice, "alice", supplied, guard);
		// An ordinary native edit/autofill between panel actions, while the marked field is live.
		const page = f.pageAt(url);
		await page.locator("#field").fill(actual);
		expect(await page.locator("#history").textContent()).toContain(supplied);
		expect(await page.locator("#history").textContent()).toContain(actual);
		if (action === "click-submit") await f.sessions.clickAt(alice, ...point(250), guard, human);
		if (action === "navigation") await f.sessions.open(alice, f.browser, `${f.base}/private-echo?${new URLSearchParams({ q: actual })}`, guard, human);
		privateResult(await f.sessions.release(alice, "alice"), supplied, actual);
		if (action === "release") expect(await page.locator("#field").inputValue()).toBe("");
		else expect(await page.locator("#echo").textContent()).toBe(actual);
		const view = await f.sessions.view(alice, guard);
		privateResult(view, supplied, actual);
		privateResult(describeView(view, (text) => text), supplied, actual);
	});

	it("suppresses web_browse screenshot artifacts after private input while preserving the owner's picture and other sessions", async () => {
		const f = await start();
		const workspace = new Workspace(join(f.dataDir, "workspace"));
		const tool = createWebTools({ scope, sessions: f.sessions, workspace, chromium: async () => f.browser, policy: async () => ({ modelProviders: [], channels: [], web: ["127.0.0.1"] }), addressAllowed: guard.addressAllowed }).find((tool) => tool.name === "web_browse")!;
		const ctx: ToolContext = { thread: { channel: "web", threadId: "alice-main" }, callId: "private-screenshot", signal: new AbortController().signal, progress() {}, step: (_key, run) => run() };
		const ordinary = await tool.execute({ url: `${f.base}/private-native`, screenshot: true }, ctx);
		expect(ordinary).toContain("Screenshot salvato in");
		const original = await workspace.list();
		expect(original).toHaveLength(1);
		expect((await workspace.read(original[0]!.path)).subarray(1, 4).toString()).toBe("PNG");
		await workspace.remove(original[0]!.path);
		await f.sessions.takeover(alice, "alice", guard);
		await f.sessions.clickAt(alice, ...point(130), guard, human);
		const secret = "R3-PRIVATE-SCREENSHOT-9284";
		await f.sessions.typeText(alice, "alice", secret, guard);
		await f.sessions.press(alice, "alice", "Enter", guard);
		await f.sessions.release(alice, "alice");
		const request = f.seen.find((request) => request.path.startsWith("/private-echo?"))!;
		const page = f.pageAt(`${f.base}${request.path}`);
		expect(await page.locator("#echo").textContent()).toBe(secret);
		const picture = await f.sessions.picture(alice);
		expect(Buffer.from(picture!.png).subarray(1, 4).toString()).toBe("PNG");
		const screenshots = vi.spyOn(page, "screenshot");
		const view = await f.sessions.view(alice, guard, { screenshot: true });
		expect.soft(view.screenshot).toBeUndefined();
		privateResult(describeView(view, (text) => text), secret);
		for (const args of [{ screenshot: true }, { url: `${f.base}/plain`, screenshot: true }]) {
			const response = await tool.execute(args, ctx);
			expect.soft(response).toContain("Screenshot non disponibile");
			expect.soft(response).not.toContain("Screenshot salvato");
			privateResult(response, secret);
		}
		expect.soft(screenshots).not.toHaveBeenCalled();
		expect.soft(await workspace.list()).toEqual([]);
		const other = await tool.execute({ url: `${f.base}/plain`, screenshot: true }, { ...ctx, thread: { channel: "web", threadId: "bob-main" } });
		expect(other).toContain("Screenshot salvato in");
	});

	it.each(["maxlength fill", "Backspace edit"] as const)("retains private values before oninput autosubmit replaces the source document: %s", async (mode) => {
		const f = await start();
		const edit = mode === "Backspace edit";
		const url = `${f.base}/private-autosubmit${edit ? "?edit" : ""}`;
		await f.sessions.open(alice, f.browser, url, guard);
		await f.sessions.takeover(alice, "alice", guard);
		await f.sessions.clickAt(alice, ...point(130), guard, human);
		const supplied = "private-value-947b";
		const actual = edit ? supplied.slice(0, -1) : supplied.slice(0, 10);
		const page = f.pageAt(url);
		if (edit) await f.sessions.typeText(alice, "alice", supplied, guard);
		const navigation = page.waitForURL("**/private-echo?*");
		const [result] = await Promise.all([edit ? f.sessions.press(alice, "alice", "Backspace", guard) : f.sessions.typeText(alice, "alice", supplied, guard), navigation]);
		const request = f.seen.find((request) => request.path.startsWith("/private-echo?"))!;
		expect(new URL(request.path, f.base).searchParams.get("q")).toBe(actual);
		expect(await page.locator("#echo").textContent()).toBe(actual);
		const released = await f.sessions.release(alice, "alice");
		const view = await f.sessions.view(alice, guard, { screenshot: true });
		const workspace = new Workspace(join(f.dataDir, "autosubmit-workspace"));
		const tool = createWebTools({ scope, sessions: f.sessions, workspace, chromium: async () => f.browser, policy: async () => ({ modelProviders: [], channels: [], web: ["127.0.0.1"] }), addressAllowed: guard.addressAllowed }).find((tool) => tool.name === "web_browse")!;
		const toolText = await tool.execute({ screenshot: true }, { thread: { channel: "web", threadId: "alice-main" }, callId: "private-autosubmit", signal: new AbortController().signal, progress() {}, step: (_key, run) => run() });
		for (const value of [result, released, view, describeView(view, (text) => text), toolText]) expect.soft(JSON.stringify(value)).not.toContain(actual);
		expect(view.text).toContain("Ordinary form result");
		expect(view.screenshot).toBeUndefined();
		expect(toolText).toContain("Screenshot non disponibile");
		expect(await workspace.list()).toEqual([]);
	});

	it("refuses unsupported form encodings, direct cross-origin submits and 307/308 redirects without forwarding the body", async () => {
		const f = await start();
		const destination = await serve();
		f.redirect(`${destination.base}/sink`);
		await f.sessions.open(alice, f.browser, `${f.base}/multipart`, guard);
		await f.sessions.takeover(alice, "alice", guard);
		for (const path of ["/multipart", "/text-plain", "/cross-origin"]) {
			await f.sessions.open(alice, f.browser, `${f.base}${path}`, guard, human);
			await f.sessions.clickAt(alice, ...point(370), guard, human);
		}
		expect(f.seen.filter((request) => request.method === "POST")).toEqual([]);
		expect(destination.seen).toEqual([]);
		for (const status of [307, 308]) {
			await f.sessions.open(alice, f.browser, `${f.base}/redirect-form-${status}`, guard, human);
			await f.sessions.clickAt(alice, ...point(130), guard, human);
			await f.sessions.typeText(alice, "alice", username, guard);
			await f.sessions.press(alice, "alice", "Enter", guard);
			expect(f.seen.filter((request) => request.path === `/redirect-${status}` && request.method === "POST")).toHaveLength(1);
		}
		expect(destination.seen).toEqual([]);
	});

	it.each([{ name: "form encoding", secret: "synthetic private value", multiline: false }, { name: "long value", secret: "long-private-fragment-".repeat(30), multiline: false }, { name: "native textarea newlines", secret: "synthetic\nprivate\rvalue", multiline: true }])("redacts private GET input before URL, title, element and paginated text truncation: $name", async ({ secret, multiline }) => {
		const f = await start();
		await f.sessions.open(alice, f.browser, `${f.base}/private-get${multiline ? "-multiline" : ""}`, guard);
		await f.sessions.takeover(alice, "alice", guard);
		await f.sessions.clickAt(alice, ...point(130), guard, human);
		await f.sessions.typeText(alice, "alice", secret, guard);
		const submitted = multiline ? await f.sessions.clickAt(alice, ...point(250), guard, human) : await f.sessions.press(alice, "alice", "Enter", guard);
		const request = f.seen.find((request) => request.path.startsWith("/private-search?"));
		expect(new URL(request!.path, f.base).searchParams.get("q")).toBe(multiline ? secret.replace(/\r\n|\r|\n/g, "\r\n") : secret);
		if (multiline) expect(await f.pageAt(`${f.base}${request!.path}`).locator("#copy").inputValue()).toBe(secret.replace(/[\r\n]/g, "").repeat(2));
		const released = await f.sessions.release(alice, "alice");
		const encoded = new URLSearchParams({ q: secret }).toString().slice(2);
		const marker = secret.startsWith("long-") ? "long-private" : "synthetic";
		for (const value of [submitted, released]) {
			expect.soft(JSON.stringify(value)).not.toContain(marker);
			expect.soft(JSON.stringify(value)).not.toContain(encoded);
		}
		for (const from of [0, 8000, 8100]) {
			const view = await f.sessions.view(alice, guard, { from });
			expect.soft(JSON.stringify(view).includes(marker), `private fragment in view from=${from}`).toBe(false);
			expect.soft(describeView(view, (text) => text).includes(marker), `private fragment in model result from=${from}`).toBe(false);
			expect.soft(view.elements.some((element) => element.label === "Public action")).toBe(true);
			expect.soft(view.text.length).toBeLessThanOrEqual(8000);
			if (from === 0) expect.soft(view.details.some((detail) => detail.includes("from=8000"))).toBe(true);
			if (from === 8000) expect.soft(view.text).toContain("Public end");
		}
		const view = await f.sessions.view(alice, guard);
		const select = view.elements.find((element) => element.tag === "select")!;
		await expect(f.sessions.type(alice, select.ref, "public-invalid", false, guard)).rejects.not.toThrow(marker);
		const file = view.elements.find((element) => element.label === "Download")!;
		const download = await f.sessions.click(alice, file.ref, guard);
		expect(download.details.some((detail) => detail.includes("application/pdf"))).toBe(true);
		expect(JSON.stringify(download.details)).not.toContain(marker);
	});

	it("serializes takeover behind an in-flight agent navigation and rejects the following queued agent action", async () => {
		const f = await start();
		await f.sessions.open(alice, f.browser, `${f.base}/plain`, guard);
		const gate = f.hold("/slow-page");
		const inFlight = f.sessions.open(alice, f.browser, `${f.base}/slow-page`, guard);
		await gate.entered;
		const taking = f.sessions.takeover(alice, "alice", guard);
		const queued = f.sessions.open(alice, f.browser, `${f.base}/never-open`, guard).then(() => ({ kind: "unexpected-success" }), (error: unknown) => error);
		expect(f.sessions.state(alice)).toMatchObject({ control: "agent", busy: true });
		gate.release();
		expect((await inFlight).text).toContain("Finished");
		expect(await taking).toMatchObject({ control: "person" });
		expect(await queued).toMatchObject({ kind: "held" });
		expect(f.seen.some((request) => request.path === "/never-open")).toBe(false);
	});
});
