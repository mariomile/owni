import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { instanceDir } from "../src/core/paths.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";
import { chromiumFound, launchChromium } from "./playwright-browsers.ts";

const ui = join(import.meta.dirname, "..", "src", "web", "ui");
const scripts = readdirSync(ui, { recursive: true, encoding: "utf8" })
	.map((f) => f.split(sep).join("/"))
	.filter((f) => f.endsWith(".js"));

describe("console modules", () => {
	it("the service worker's shell lists every script of the console (a forgotten one would never work offline)", () => {
		const sw = readFileSync(join(ui, "sw.js"), "utf8");
		const shell = JSON.parse((/const SHELL = (\[.*\]);/.exec(sw) as RegExpExecArray)[1] as string) as string[];
		const missing = scripts.filter((f) => f !== "sw.js" && !shell.includes(`/${f}`));
		expect(missing).toEqual([]);
	});

	it("the service worker's shell lists every font the stylesheet loads (a missing one falls back to the system font offline)", () => {
		const sw = readFileSync(join(ui, "sw.js"), "utf8");
		const shell = JSON.parse((/const SHELL = (\[.*\]);/.exec(sw) as RegExpExecArray)[1] as string) as string[];
		const fonts = [...readFileSync(join(ui, "app.css"), "utf8").matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1] as string);
		expect(fonts.length).toBeGreaterThan(0);
		expect(fonts.filter((f) => !shell.includes(f))).toEqual([]);
	});

	it("pages never import each other, and only shell.js imports from pages/", () => {
		const offenders: string[] = [];
		for (const file of scripts) {
			const source = readFileSync(join(ui, file), "utf8");
			for (const [, from] of source.matchAll(/^import .* from "([^"]+)";$/gm)) {
				const inPages = file.startsWith("pages/");
				if (inPages && (from as string).startsWith("./")) offenders.push(`${file} imports ${from}`);
				if (!inPages && file !== "shell.js" && (from as string).includes("pages/")) offenders.push(`${file} imports ${from}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("common.js imports nothing", () => {
		expect(readFileSync(join(ui, "common.js"), "utf8")).not.toMatch(/^import /m);
	});
});

describe("console accessibility floor", () => {
	const read = (f: string) => readFileSync(join(ui, f), "utf8");

	it("does not announce the whole app as a live region, and offers a skip link", () => {
		expect(read("index.html")).not.toMatch(/id="app"[^>]*aria-live/);
		expect(read("shell.js")).toContain("Salta al contenuto");
	});

	it("starts on the mark, said once to a screen reader, and the desktop app shows the same mark", () => {
		const page = read("index.html");
		expect(page).toMatch(/<div id="app"><div class="splash" role="status"><svg class="mark"[^>]*aria-hidden="true"/);
		expect(page).toContain('<span class="visually-hidden">Owni si sta accendendo</span>');
		const desktop = join(import.meta.dirname, "..", "desktop", "connect");
		expect(readFileSync(join(desktop, "icon.svg"), "utf8")).toBe(read("icon.svg"));
		expect(readFileSync(join(desktop, "index.html"), "utf8")).toContain('<main id="avvio" role="status" hidden>');
	});

	it("the phone drawer makes the page behind inert and closes on Esc", () => {
		const shell = read("shell.js");
		expect(shell).toMatch(/"main, \.topbar"\)\) behind\.inert/);
		expect(shell).toMatch(/e\.key !== "Escape"[^\n]*railPhone/);
	});

	it("form controls use the 3:1 edge, touch targets reach 44px, and motion keeps a still cue", () => {
		const css = read("app.css");
		expect(css).toMatch(/--control: color-mix\(in srgb, var\(--fg\) 50%, var\(--bg\)\)/);
		expect(css).toMatch(/min-height: 34px; padding: 7px 11px; border: 1px solid var\(--control\)/);
		expect(css).toMatch(/@media \(pointer: coarse\) \{\n\t\.icon-btn, \.icon-btn\.small \{ width: 44px; height: 44px; \}/);
		expect(css).not.toMatch(/@keyframes (toast-in|chip-in)[^\n]*blur/);
		expect(css).not.toMatch(/#toasts \{[^}]*transition: height/);
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n\t*"));
		expect(reduced).not.toMatch(/transition: none/);
		expect(reduced).toMatch(/\.board-dot \{ background: var\(--fg\)/);
	});
});

describe("console served from the UI directory", () => {
	const running: RunningOwni[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("serves every script and the stylesheet with no-cache, so the files of one deploy load together", async () => {
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		for (const file of scripts) {
			const res = await fetch(`${base}/${file}`);
			expect(res.status, file).toBe(200);
			expect(res.headers.get("cache-control"), file).toBe("no-cache");
			expect(res.headers.get("content-type"), file).toContain("text/javascript");
		}
		// A page drawn by a new script with the old stylesheet comes out unstyled (the organigramma after the 0.10.0 update).
		expect((await fetch(`${base}/app.css`)).headers.get("cache-control")).toBe("no-cache");
		expect((await fetch(`${base}/fonts/archivo-latin.woff2`)).status).toBe(200);
		expect((await fetch(`${base}/login`)).headers.get("content-type")).toContain("text/html");
	});

	it("sends a script compressed, and nothing when the browser has this version already", async () => {
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const first = await fetch(`${base}/app.js`, { headers: { "accept-encoding": "br" } });
		expect(first.headers.get("content-encoding")).toBe("br");
		expect(Number(first.headers.get("content-length"))).toBeLessThan(statSync(join(ui, "app.js")).size);
		expect(await first.text()).toBe(readFileSync(join(ui, "app.js"), "utf8"));
		const etag = first.headers.get("etag") as string;
		const again = await fetch(`${base}/app.js`, { headers: { "if-none-match": etag } });
		expect(again.status).toBe(304);
		expect((await fetch(`${base}/fonts/archivo-latin.woff2`, { headers: { "accept-encoding": "br" } })).headers.get("content-encoding")).toBeNull();
	});
});

describe.skipIf(!chromiumFound)("the agente's reaction under a message, in real Chromium (ADR 0132)", () => {
	const running: RunningOwni[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("a message of the direct conversation shows the reaction as a chip under it, and a live one replaces it", async () => {
		const dataDir = tempDataDir();
		const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const token = (owni.ownerLink as string).split("#")[1];
		const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token }) });
		const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-owni": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// A message written and answered, then the reaction as the channel writes it into the transcript.
		const { thread } = (await (await api("/api/instances/owni/dm", {})).json()) as { thread: { id: string } };
		const { entry } = (await (await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: "grazie" })).json()) as { entry: { id: string } };
		const entriesOf = async () => ((await (await api(`/api/instances/owni/threads/${thread.id}`)).json()) as { entries: unknown[] }).entries.length;
		for (let tries = 0; (await entriesOf()) < 2; tries++) {
			if (tries > 500) throw new Error("the answer never came");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		appendFileSync(join(instanceDir(dataDir, tenantId(config.tenantId), instanceId("owni")), "web", "messages", `${thread.id}.jsonl`), `${JSON.stringify({ id: "r_0123456789abcdef01234567", at: new Date().toISOString(), to: entry.id, emoji: "👍" })}\n`);

		const browser = await launchChromium();
		try {
			const page = await browser.newPage();
			const [name, value] = cookie.split("=") as [string, string];
			await page.context().addCookies([{ name, value, url: base }]);
			await page.goto(`${base}/#/`);
			const chips = page.locator(`[data-entry="${entry.id}"] > .reactions .reaction`);
			await chips.first().waitFor();
			expect(await chips.allInnerTexts()).toEqual(["👍"]);
			// The answer has none: no empty row of chips is drawn.
			expect(await page.locator(".msg.owni .reaction").count()).toBe(0);
			// A reaction arriving live changes the same row; the script is the page's own module.
			await page.evaluate(`(async () => (await import("/threads.js")).showReaction(${JSON.stringify(entry.id)}, [{ instanceId: "owni", emoji: "🔥" }]))()`);
			expect(await chips.allInnerTexts()).toEqual(["🔥"]);
		} finally {
			await browser.close();
		}
	});
});
