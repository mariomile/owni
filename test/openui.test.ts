import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { OPENUI_GUIDE } from "../src/core/openui-guide.ts";
import { OwniRuntime } from "../src/core/runtime.ts";
import { createOpenuiTools } from "../src/core/tools/openui-tools.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { createWebApp } from "../src/web/server.ts";
import { tempDataDir } from "./helpers.ts";

vi.stubGlobal("document", { getElementById: () => null });
// @ts-expect-error Browser modules intentionally use plain JavaScript.
const { actionText } = (await import("../src/web/ui/openui.js")) as { actionText(action: unknown): string };
vi.unstubAllGlobals();

// Match browser-file-chooser.test.ts: use the installed browser, never download one.
const chrome = process.env.OWNI_CHROMIUM_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
// Safari and the Mac app (WKWebView) draw with WebKit: Playwright's build of it is the stand-in, used when installed (`playwright-core install webkit`).
const { chromium, webkit } = await import("playwright-core");
const engines = [
	{ name: "Chromium", available: chrome !== undefined && existsSync(chrome), launch: () => chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] }) },
	{ name: "WebKit", available: existsSync(webkit.executablePath()), launch: () => webkit.launch() },
];

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function server() {
	const dataDir = tempDataDir();
	const dir = join(dataDir, "tenants", "acme");
	const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	const app = createWebApp({ runtime, tenantId: "acme", people: new PeopleStore(dir), sessions: new SessionStore(dir), channels: new Map(), connectors: () => new ConnectorStore(dir), connectorStatus: () => [], usage: new UsageLedger(dir), uiDir: join(import.meta.dirname, "../src/web/ui"), secureCookies: false, defaultTimeZone: "Europe/Rome" });
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	closers.push(async () => {
		app.closeAllConnections();
		await new Promise((resolve) => app.close(resolve));
		await runtime.close();
	});
	return `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}

const context = (channel: string): ToolContext => ({ callId: "c1", signal: new AbortController().signal, progress: () => {}, thread: { channel, threadId: "t1" }, step: async (_key, work) => work() });

describe("interactive answers in the chat (ADR 0118)", () => {
	it("the guide is read in a console conversation; elsewhere the agente is told to answer in text", async () => {
		const [tool] = createOpenuiTools();
		expect(tool?.name).toBe("openui_guide");
		expect(await tool?.execute({}, context("web"))).toBe(OPENUI_GUIDE);
		expect(String(await tool?.execute({}, context("telegram")))).toMatch(/^Errore: .*solo nella console/);
		// Owni's rules come first, and the guide never offers what the frame cannot do.
		expect(OPENUI_GUIDE).toMatch(/^# Interactive answers in the console/);
		expect(OPENUI_GUIDE).toContain("Never invent data");
		expect(OPENUI_GUIDE).not.toContain("picsum.photos");
		// The registries are gone (ADR 0121): no example offers a quote.
		expect(OPENUI_GUIDE).not.toMatch(/preventiv/i);
	});

	it("a click writes the action's words, then the form's values, then the context: only strings, at most 4000 characters", () => {
		expect(actionText({ message: " Conferma il preventivo ", fields: [["cliente", "Rossi Srl"], ["note", " 3 finestre "]], context: "preventivo 12" })).toBe("Conferma il preventivo\n- cliente: Rossi Srl\n- note: 3 finestre\npreventivo 12");
		expect(actionText({ message: "Ok", fields: [["vuoto", ""], [1, "x"], "nope", ["a", { b: 1 }]], context: 7 })).toBe("Ok");
		expect(actionText({ fields: "nope" })).toBe("");
		expect(actionText({ message: "x".repeat(5000) })).toHaveLength(4000);
	});

	it("the frame is served sandboxed with no network, framable only by the console; the bundle is kept, the fonts are readable by it", async () => {
		const base = await server();
		const frame = await fetch(`${base}/openui/frame`);
		expect(frame.status).toBe(200);
		const csp = frame.headers.get("content-security-policy") ?? "";
		expect(csp).toMatch(/^sandbox allow-scripts;/);
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).toContain("frame-ancestors 'self'");
		// Scripts go by a nonce of this response (WebKit does not match 'self' in a sandboxed frame), no host and no 'self'.
		const nonce = /script-src 'nonce-([\w+/=]+)'(?:;|$)/.exec(csp)?.[1];
		expect(nonce).toBeDefined();
		expect(csp).not.toMatch(/script-src[^;]*('self'|https?:|\*|unsafe)/);
		expect(csp).not.toMatch(/https?:\/\//);
		expect(frame.headers.get("x-frame-options")).toBeNull();
		expect(frame.headers.get("cache-control")).toBe("no-cache");
		const html = await frame.text();
		expect(html).toContain(`<script nonce="${nonce}" src="/openui/frame.js"></script>`);
		expect(html).toContain(`<script nonce="${nonce}" src="/openui/openui-bundle.min.js?v=0.2.1"></script>`);
		expect(html).not.toContain("__NONCE__");
		expect(((await fetch(`${base}/openui/frame`)).headers.get("content-security-policy") ?? "").includes(`'nonce-${nonce}'`)).toBe(false);
		expect((await fetch(`${base}/openui/openui-bundle.min.js?v=0.2.1`)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect((await fetch(`${base}/openui/frame.js`)).headers.get("cache-control")).toBe("no-cache");
		expect((await fetch(`${base}/fonts/archivo-latin.woff2?frame`)).headers.get("access-control-allow-origin")).toBe("*");
		for (const missing of ["/openui/", "/openui/LICENSE", "/openui/../server.ts"]) expect((await fetch(`${base}${missing}`)).status).toBe(404);
	});
});

describe.for(engines)("interactive answers, in real $name", ({ available, launch }) => {
	it.skipIf(!available)("draws the block, writes the click with the form's values in the box, opens links, fits its height, follows the theme, falls back to code, and reaches nothing", async () => {
		const base = await server();
		const browser = await launch();
		closers.push(() => browser.close());
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("console", (message) => void (message.type() === "error" && errors.push(message.text())));
		page.on("pageerror", (error) => void errors.push(error.message));
		const form = [
			"root = Card([header, form])",
			'header = CardHeader("Nuovo preventivo", "Due dettagli")',
			'form = Form("preventivo", buttons, [fc])',
			'buttons = Buttons([send, site], "row")',
			'send = Button("Prepara", @ToAssistant("Prepara il preventivo"), "primary")',
			'site = Button("Sito", @OpenUrl("https://example.com/listino"), "secondary")',
			'fc = FormControl("Cliente", client)',
			'client = Input("cliente", "es. Rossi Srl", "text")',
		].join("\n");
		const short = ["root = Card([note])", 'note = TextContent("Vedi il [listino](https://example.com/testo)", "default")'].join("\n");
		// A page of the console's origin with a box holding a draft and three answers: a form, a line of text with a link, and text that is not OpenUI.
		await page.route(`${base}/qa`, (route) =>
			route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><body><script type="module">
					import { fillComposer, openuiBlock } from "/openui.js";
					window.opened = [];
					window.open = (...args) => void window.opened.push(args);
					const box = Object.assign(document.createElement("textarea"), { id: "box", value: "Bozza" });
					document.body.append(box);
					document.body.addEventListener("openui-action", (event) => fillComposer(box, event.detail.text));
					for (const source of ${JSON.stringify([form, short, "solo testo, niente interfaccia"])}) document.body.append(openuiBlock(source, () => Object.assign(document.createElement("pre"), { className: "fallback", textContent: source })));
				</script></body>`,
			}),
		);
		await page.goto(`${base}/qa`);
		await page.waitForFunction(`document.querySelectorAll(".openui.drawn").length === 2`);
		await page.waitForSelector("pre.fallback");
		expect(await page.locator("iframe.openui-frame").count()).toBe(2);
		const inside = page.frameLocator("iframe.openui-frame").first();
		await inside.getByPlaceholder("es. Rossi Srl").fill("Rossi Srl");
		await inside.getByRole("button", { name: "Prepara" }).click();
		// Written after the draft, not sent: the person reads it and sends it.
		await page.waitForFunction(`document.getElementById("box").value !== "Bozza"`);
		expect(await page.inputValue("#box")).toBe("Bozza\n\nPrepara il preventivo\n- cliente: Rossi Srl");
		await inside.getByRole("button", { name: "Sito" }).click();
		await page.waitForFunction("window.opened.length === 1");
		// A link in the text: the frame cannot open it, the console does.
		await page.frameLocator("iframe.openui-frame").nth(1).getByRole("link", { name: "listino" }).click();
		await page.waitForFunction("window.opened.length === 2");
		expect(await page.evaluate("window.opened")).toEqual([
			["https://example.com/listino", "_blank", "noopener,noreferrer"],
			["https://example.com/testo", "_blank", "noopener,noreferrer"],
		]);
		// As tall as what it draws, no inner scroll: the form is tall, the line of text is short.
		const heights = await page.evaluate<number[]>(`[...document.querySelectorAll("iframe.openui-frame")].map((f) => parseInt(f.style.height, 10))`);
		expect(heights[0]).toBeGreaterThan(100);
		expect(heights[1]).toBeLessThan(100);
		await page.evaluate(`document.documentElement.dataset.theme = "dark"`);
		const frame = page.frames().find((f) => f.url().endsWith("/openui/frame"));
		await frame?.waitForFunction(`document.documentElement.dataset.openuiTheme === "dark"`);
		// Fonts and scripts load; nothing failed before the frame is asked to reach out.
		expect(errors).toEqual([]);
		expect(await frame?.evaluate(`document.fonts.check('16px "Archivo"') && [...document.fonts].some((f) => f.family.includes("Archivo") && f.status === "loaded")`)).toBe(true);
		// No origin of its own: no cookie of the console, no call to its API.
		expect(await frame?.evaluate(`(() => { try { return document.cookie; } catch { return "blocked"; } })()`)).toBe("blocked");
		expect(await frame?.evaluate(`fetch("/api/me").then(() => "reached", () => "blocked")`)).toBe("blocked");
	});
});
