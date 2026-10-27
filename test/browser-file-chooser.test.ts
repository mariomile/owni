import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { publicAddress } from "../src/core/web-fetch.ts";
import { createWebTools } from "../src/core/tools/web-tools.ts";
import { type Browser, BrowseSessions, sessionKey } from "../src/core/web-session.ts";
import { type Workspace, WorkspaceError } from "../src/core/workspace.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";
import { chromiumAvailable, launchChromium } from "./playwright-browsers.ts";

// Real Chromium (test/playwright-browsers.ts): the file chooser is refused where it opens, whatever way the page reaches it (ADR 0103).
const available = await chromiumAvailable();

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A target at 100,100 to 300,200 in every page, so one click point (150, 150) reaches it. */
const BOX = "position:fixed;left:100px;top:100px;width:200px;height:100px;margin:0;border:0";
/** A second target, at 100,300 to 300,400. */
const BELOW = "position:fixed;left:100px;top:300px;width:200px;height:100px;margin:0;border:0";
/** A third, at 100,500 to 300,600. */
const LOWEST = "position:fixed;left:100px;top:500px;width:200px;height:100px;margin:0;border:0";
const CHOOSE = "const i = document.createElement('input'); i.type = 'file'; i.click()";
const pages: Record<string, string> = {
	"/direct": `<input type="file" style="${BOX}">`,
	"/label": `<label for="f" style="${BOX};background:#ccc">Scegli</label><input id="f" type="file" style="display:none">`,
	"/shadow": `<div id="h" style="${BOX}"></div><script>document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = '<input type="file" style="width:200px;height:100px">'</script>`,
	"/iframe": `<iframe src="/inside" style="${BOX}"></iframe>`,
	"/inside": `<body style="margin:0"><input type="file" style="width:200px;height:100px"></body>`,
	"/button": `<button style="${BOX}" onclick="const i = document.createElement('input'); i.type = 'file'; i.click()">Carica</button>`,
	"/plain": `<button style="${BOX}" onclick="document.title = 'cliccato'">Vai</button>`,
	// The chooser opens 1.6 s after the click, on the page's own timer; the other button waits for a slow request.
	"/late": `<button style="${BOX}" onclick="setTimeout(() => { ${CHOOSE} }, 1600)">Carica dopo</button><button style="${BELOW}" onclick="fetch('/slow').then(() => { document.title = 'fatto' })">Altro</button><input type="file" style="${LOWEST}">`,
	// The page is busy while the view is read, and opens the chooser at the end of it.
	"/busy": `<button style="${BOX}" onclick="setTimeout(() => { const end = Date.now() + 1000; while (Date.now() < end); ${CHOOSE} }, 200)">Carica</button>`,
	// The chooser again and again, every millisecond, from a timer the click starts.
	"/spam": `<button style="${BOX}" onclick="setTimeout(() => setInterval(() => { ${CHOOSE} }, 1), 600)">Carica</button>`,
	// The refused click also changes the page: the title, and what the other button does.
	"/swap": `<title>prima</title><button style="${BOX}" onclick="document.title = 'cambiata'; document.getElementById('x').onclick = () => { document.title = 'altro gestore' }; ${CHOOSE}">Carica</button><button id="x" style="${BELOW}" onclick="document.title = 'gestore di prima'">Pulsante X</button>`,
};

async function serve(): Promise<string> {
	const server = createServer(async (req, res) => {
		if (req.url === "/slow") await new Promise((r) => setTimeout(r, 2000));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(pages[req.url ?? ""] ?? "no");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(() => r())));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function start(limits?: { max: number; idleMs: number }) {
	const base = await serve();
	const { chromium } = await import("playwright-core");
	const browser = (await launchChromium()) as unknown as Browser;
	const refused: string[] = [];
	const sessions = new BrowseSessions(limits, (key, host) => refused.push(`${key} ${host}`));
	closers.push(async () => {
		await sessions.closeAll();
		await browser.close();
	});
	return { base, sessions, browser, refused };
}
const guard = { hostAllowed: () => true, addressAllowed: () => true };

describe.skipIf(!available)("no file uploads, in real Chromium", () => {
	for (const name of ["direct", "label", "shadow", "iframe", "button"]) {
		it(`refuses a person's click that opens a file chooser: ${name}`, async () => {
			const { base, sessions, browser } = await start();
			await sessions.open("k", browser, `${base}/${name}`, guard);
			await expect(sessions.clickAt("k", 150 / 1280, 150 / 800, guard, { person: true })).rejects.toMatchObject({ kind: "no-files", message: "Owni non carica file sui siti" });
			// The session stays usable after a refusal.
			await sessions.open("k", browser, `${base}/plain`, guard);
			expect((await sessions.clickAt("k", 150 / 1280, 150 / 800, guard)).title).toBe("cliccato");
		}, 60_000);
	}

	it("refuses the agent's click on a numbered input and button, and its typing in a file input", async () => {
		const { base, sessions, browser } = await start();
		for (const name of ["direct", "button"]) {
			const view = await sessions.open("a", browser, `${base}/${name}`, guard);
			const element = view.elements[0];
			expect(element).toBeDefined();
			await expect(sessions.click("a", element?.ref as number, guard)).rejects.toMatchObject({ kind: "no-files" });
		}
		const view = await sessions.open("a", browser, `${base}/direct`, guard);
		expect(await sessions.type("a", view.elements[0]?.ref as number, "x", false, guard)).toMatchObject({ failed: true });
	}, 60_000);

	const LATE = "La pagina ha provato da sola ad aprire la scelta di un file: rifiutata, Owni non carica file sui siti.";
	const at = { top: [150 / 1280, 150 / 800], below: [150 / 1280, 350 / 800], lowest: [150 / 1280, 550 / 800] } as const;

	it("a site's first refused chooser is reported as it opens, own or late, with the page's host", async () => {
		const { base, sessions, browser, refused } = await start();
		await sessions.open("k", browser, `${base}/late`, guard);
		await sessions.clickAt("k", ...at.top, guard, { person: true });
		// The late one is reported with no view read, whoever reads next.
		await new Promise((r) => setTimeout(r, 2000));
		expect(refused).toEqual(["k 127.0.0.1"]);
		await sessions.open("j", browser, `${base}/late`, guard);
		await expect(sessions.clickAt("j", ...at.lowest, guard, { person: true })).rejects.toMatchObject({ kind: "no-files" });
		expect(refused).toEqual(["k 127.0.0.1", "j 127.0.0.1"]);
	}, 60_000);

	it("a page that opens the chooser in a loop is one report and a few remembered, and the agent still hears of it", async () => {
		const { base, sessions, browser, refused } = await start();
		await sessions.open("k", browser, `${base}/spam`, guard);
		await sessions.clickAt("k", ...at.top, guard, { person: true });
		await new Promise((r) => setTimeout(r, 3000));
		expect(refused).toEqual(["k 127.0.0.1"]);
		expect(sessions["sessions"].get("k")?.choosers.length).toBeLessThanOrEqual(3);
		expect((await sessions.view("k", guard)).notes).toContain(LATE);
	}, 60_000);

	it("a late chooser is still told when the screenshot cannot be saved", async () => {
		const { base, sessions, browser } = await start();
		const full = { write: async () => { throw new WorkspaceError("Workspace full: over 10 bytes"); } } as unknown as Workspace;
		const tools = createWebTools({ policy: async () => ({ modelProviders: [], channels: [], web: ["127.0.0.1"] }), workspace: full, chromium: async () => browser, sessions, addressAllowed: () => true });
		const browse = tools.find((t) => t.name === "web_browse");
		const thread = { channel: "web", threadId: "t" };
		const ctx = { thread, step: (_: string, work: () => Promise<string>) => work() } as any;
		await browse?.execute({ url: `${base}/late` }, ctx);
		await sessions.clickAt(sessionKey("default", thread), ...at.top, guard, { person: true });
		await new Promise((r) => setTimeout(r, 2000));
		const shown = String(await browse?.execute({ screenshot: true }, ctx));
		expect(shown).toContain("Screenshot non salvato: Workspace full: over 10 bytes.");
		expect(shown).toContain(LATE);
		expect(shown).toContain("Carica dopo");
		expect(String(await browse?.execute({}, ctx))).not.toContain(LATE);
	}, 60_000);

	it("a late chooser outlives the browser closing after a while idle: the agent hears it in the closure, once", async () => {
		const { base, sessions, browser } = await start({ max: 4, idleMs: 2500 });
		await sessions.open("k", browser, `${base}/late`, guard);
		await sessions.clickAt("k", ...at.top, guard, { person: true });
		await new Promise((r) => setTimeout(r, 3000));
		expect(sessions.has("k")).toBe(false);
		// A person's action on the closed page does not use it up.
		await expect(sessions.view("k", guard, { person: true })).rejects.not.toThrow(LATE);
		await expect(sessions.view("k", guard)).rejects.toThrow(`la pagina di questa conversazione è stata chiusa dopo qualche minuto senza azioni: riaprila con web_browse. ${LATE}`);
		await expect(sessions.view("k", guard)).rejects.not.toThrow(LATE);
		expect((await sessions.open("k", browser, `${base}/plain`, guard)).notes).not.toContain(LATE);
	}, 60_000);

	it("a late chooser outlives the browser closed to make room: the next browser of the conversation tells it", async () => {
		const { base, sessions, browser } = await start({ max: 1, idleMs: 60_000 });
		await sessions.open("k", browser, `${base}/late`, guard);
		await sessions.clickAt("k", ...at.top, guard, { person: true });
		await new Promise((r) => setTimeout(r, 2000));
		await sessions.open("j", browser, `${base}/plain`, guard);
		expect(sessions.has("k")).toBe(false);
		// Opened again, by the person first (the panel shows the page, not the notes): still the agent's to hear.
		await sessions.open("k", browser, `${base}/plain`, guard, { person: true });
		expect((await sessions.view("k", guard)).notes).toContain(LATE);
		expect((await sessions.view("k", guard)).notes).not.toContain(LATE);
	}, 60_000);

	it("a chooser the page opens later, between actions, is told in the next view, once", async () => {
		const { base, sessions, browser } = await start();
		await sessions.open("k", browser, `${base}/late`, guard);
		const clicked = await sessions.clickAt("k", ...at.top, guard, { person: true });
		expect(clicked.notes).not.toContain(LATE);
		await new Promise((r) => setTimeout(r, 2000));
		expect((await sessions.view("k", guard)).notes).toContain(LATE);
		expect((await sessions.view("k", guard)).notes).not.toContain(LATE);
	}, 60_000);

	it("a chooser the page opens later, during another click, is not that click's refusal", async () => {
		const { base, sessions, browser } = await start();
		await sessions.open("k", browser, `${base}/late`, guard);
		await sessions.clickAt("k", ...at.top, guard, { person: true });
		// This click waits 2 s for its request: the earlier click's chooser opens meanwhile.
		const other = await sessions.clickAt("k", ...at.below, guard, { person: true });
		expect(other.title).toBe("fatto");
		expect(other.failed).toBeUndefined();
		expect(other.notes).toContain(LATE);
	}, 60_000);

	it("a person's own refused chooser does not use up one the page opened earlier", async () => {
		const { base, sessions, browser } = await start();
		await sessions.open("k", browser, `${base}/late`, guard);
		await sessions.clickAt("k", ...at.top, guard, { person: true });
		await new Promise((r) => setTimeout(r, 2000));
		await expect(sessions.clickAt("k", ...at.lowest, guard, { person: true })).rejects.toMatchObject({ kind: "no-files" });
		expect((await sessions.view("k", guard)).notes).toContain(LATE);
	}, 60_000);

	it("a chooser that opens while the view is read is told in that view", async () => {
		const { base, sessions, browser } = await start();
		await sessions.open("k", browser, `${base}/busy`, guard);
		const view = await sessions.clickAt("k", ...at.top, guard, { person: true, screenshot: true });
		expect(view.notes).toContain(LATE);
	}, 60_000);

	it("a refused person's click still leaves the agent's numbers behind and updates what the panel shows", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/swap`, guard);
		const x = view.elements.find((e) => e.label === "Pulsante X");
		expect(x).toBeDefined();
		await expect(sessions.clickAt("k", ...at.top, guard, { person: true })).rejects.toMatchObject({ kind: "no-files" });
		expect(sessions.state("k")).toMatchObject({ title: "cambiata" });
		await expect(sessions.click("k", x?.ref as number, guard)).rejects.toThrow(/chi ti scrive ha aperto un'altra pagina/);
	}, 60_000);

	it("a person's click through the panel leaves a late chooser for the agent's next view", async () => {
		const site = await serve();
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", OWNI_SCREENSHOTS_WITHOUT_SANDBOX: "1" });
		const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { webAddressAllowed: (address) => address === "127.0.0.1" || publicAddress(address), schedulerIntervalMs: 60_000, log: () => {} });
		closers.push(() => owni.stop());
		const policy = (await owni.runtime.registry.getInstance("default", "owni")).egress;
		await owni.runtime.registry.setEgress("default", "owni", () => ({ ...policy, web: ["127.0.0.1"] }));
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body?: unknown) => {
			const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, ...((await res.json()) as any) };
		};
		const thread = (await api("/api/instances/owni/dm", {})).thread.id as string;
		const answers = async () => ((await api(`/api/instances/owni/threads/${thread}`)).entries as { from: string; text?: string }[]).filter((e) => e.from === "owni");
		const say = async (text: string): Promise<string> => {
			const before = (await answers()).length;
			await api(`/api/instances/owni/threads/${thread}/messages`, { text });
			for (const begun = Date.now(); Date.now() - begun < 30_000; ) {
				const now = await answers();
				if (now.length > before) return now.at(-1)?.text ?? "";
				await new Promise((r) => setTimeout(r, 30));
			}
			throw new Error("no reply");
		};
		const click = (x: number, y: number) => api(`/api/instances/owni/threads/${thread}/browser/click`, { x, y });

		expect(await say(`/tool web_browse {"url":"${site}/late"}`)).toContain("Carica dopo");
		// The person clicks the button whose page opens the chooser 1.6 s later, on its own.
		expect((await click(...at.top)).status).toBe(200);
		await new Promise((r) => setTimeout(r, 2000));
		// Then another button in the panel, which works: the panel answers with the page only.
		const other = await click(...at.below);
		expect(other.status).toBe(200);
		expect(other.browser).toMatchObject({ open: true, title: "fatto" });
		// The agent still learns of the refusal, once.
		expect(await say("/tool web_browse {}")).toContain(LATE);
		expect(await say("/tool web_browse {}")).not.toContain(LATE);
		// And the person can read it on the activity page, whatever the agent reads.
		expect((await owni.runtime.audit("default").read()).filter((e) => e.type === "web.browser.file_refused").map((e) => [e.instanceId, e.host])).toEqual([["owni", "127.0.0.1"]]);
	}, 90_000);
});
