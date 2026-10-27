import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Browser, BrowseSessions } from "../src/core/web-session.ts";
import { chromiumFound } from "./playwright-browsers.ts";

// Real Chromium, found by test/playwright-browsers.ts (and so run in CI): a page built with web components (ADR 0014).

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A custom element with an open shadow root made of `html`, and `script` run on it. */
const component = (name: string, html: string, script = "") => `customElements.define(${JSON.stringify(name)}, class extends HTMLElement {
	constructor() {
		super();
		const root = this.attachShadow({ mode: "open" });
		root.innerHTML = ${JSON.stringify(html)};
		${script}
	}
});`;

const pages: Record<string, string> = {
	"/": `<title>Componenti</title><main><x-modulo><span>Testo nello slot</span></x-modulo></main><x-chiuso></x-chiuso><iframe src="/dentro"></iframe>
<script>
${component("x-modulo", '<label>Nome <input></label><p>Testo nel componente</p><button>Conferma</button><div><slot></slot></div><x-nipote></x-nipote>', 'root.querySelector("button").addEventListener("click", () => { root.querySelector("p").textContent = "Confermato"; });')}
${component("x-nipote", '<a href="/due">Link annidato</a>')}
customElements.define("x-chiuso", class extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "closed" }).innerHTML = '<button>Pulsante chiuso</button>';
	}
});
</script>`,
	"/dentro": "<button>Pulsante nel riquadro</button>",
	"/due": "<title>Due</title><p>Seconda pagina</p>",
	"/moduli": `<title>Moduli</title>
<script>${component("x-invio", '<form method="post" action="/invia"><input name="a"><button>Invia dal componente</button></form>')}</script>
<x-invio></x-invio>
<x-dichiarato><template shadowrootmode="open"><form method="post" action="/invia"><button>Invia dichiarato</button></form></template></x-dichiarato>`,
	"/popup": `<title>Popup</title><script>${component("x-link", '<a href="/due" target="_blank">Apri altrove</a>')}</script><x-link></x-link>`,
	"/segreti": `<title>Segreti</title><script>${component("x-segreti", '<input type="password" aria-label="Chiave" value="segreto123"><input aria-label="Codice" value="valore-privato">')}</script><x-segreti></x-segreti>`,
	"/doppio": `<title>Doppio</title><script>${component("x-uno", "<button>Uno</button>")}${component("x-due", "<button>Due</button>")}</script><x-uno></x-uno><x-due></x-due>`,
	// More nodes than one lookup visits: the button is found, the page cannot be shown to hold only it.
	"/enorme": `<title>Enorme</title><button>Unico</button><script>document.body.insertAdjacentHTML("beforeend", "<i></i>".repeat(120000))</script>`,
};

async function start() {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(pages[req.url ?? ""] ?? "<title>Altro</title>no");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	closers.push(() => new Promise((r) => server.close(() => r())));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const { chromium: launcher } = await import("playwright-core");
	const browser = (await launcher.launch({ chromiumSandbox: false })) as unknown as Browser;
	const sessions = new BrowseSessions();
	closers.push(async () => {
		await sessions.closeAll();
		await browser.close();
	});
	return { base, hits, sessions, browser };
}
const guard = { hostAllowed: () => true, addressAllowed: () => true };

describe.skipIf(!chromiumFound)("web components, in real Chromium", () => {
	it("numbers the buttons, fields and links inside open shadow roots, and clicks and types on them", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/`, guard);
		const named = (label: string) => view.elements.find((e) => e.label === label);
		const field = named("Nome");
		const button = named("Conferma");
		expect(field).toMatchObject({ kind: "campo di testo", tag: "input" });
		expect(button).toMatchObject({ kind: "pulsante", tag: "button" });
		expect(named("Link annidato")).toMatchObject({ kind: "link" });
		// The text inside a shadow root is read as well, and text passed through a slot only once.
		expect(view.text).toContain("Testo nel componente");
		expect(view.text.split("Testo nello slot")).toHaveLength(2);

		const typed = await sessions.type("k", field?.ref as number, "Mario", false, guard);
		expect(typed.elements.find((e) => e.label === "Nome")?.value).toBe("Mario");
		const clicked = await sessions.click("k", typed.elements.find((e) => e.label === "Conferma")?.ref as number, guard);
		expect(clicked.text).toContain("Confermato");
	}, 60_000);

	it("still does not read closed shadow roots or the content of iframes, and still reports the iframe", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/`, guard);
		expect(view.elements.map((e) => e.label)).not.toContain("Pulsante chiuso");
		expect(view.elements.map((e) => e.label)).not.toContain("Pulsante nel riquadro");
		expect(view.details.join("\n")).toContain("Riquadri con altre pagine dentro (si aprono con web_browse): http://127.0.0.1");
	}, 60_000);

	it("a form that sends, inside a shadow root, is blocked on the page: the page stays, the agent is told", async () => {
		const { base, hits, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/moduli`, guard);
		expect(view.notes.join("\n")).toContain("Questa pagina ha moduli che inviano dati");
		for (const label of ["Invia dal componente", "Invia dichiarato"]) {
			const sent = await sessions.click("k", view.elements.find((e) => e.label === label)?.ref as number, guard);
			expect(sent.url).toBe(`${base}/moduli`);
			expect(sent.title).toBe("Moduli");
			expect(sent.failed).toBeUndefined();
			expect(sent.notes.join("\n")).toContain("La pagina ha provato a inviare dati: bloccato, non è partito niente.");
		}
		expect(hits.filter((h) => h.startsWith("POST"))).toEqual([]);
	}, 60_000);

	it("a link that opens a new window, inside a shadow root, opens in the same page", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/popup`, guard);
		const opened = await sessions.click("k", view.elements.find((e) => e.label === "Apri altrove")?.ref as number, guard);
		expect(opened.url).toBe(`${base}/due`);
		expect(opened.text).toContain("Seconda pagina");
	}, 60_000);

	it("a password in a shadow root shows no value, and a private value is hidden there as anywhere", async () => {
		const { base, sessions, browser } = await start();
		(await sessions.open("k", browser, `${base}/segreti`, guard));
		sessions["sessions"].get("k")?.person.privateValues.add("valore-privato");
		const view = await sessions.view("k", guard);
		const key = view.elements.find((e) => e.label === "Chiave");
		expect(key).toMatchObject({ kind: "campo password" });
		expect(key?.value).toBeUndefined();
		expect(view.elements.find((e) => e.label === "Codice")?.value).toBe("[privato]");
		expect(JSON.stringify(view)).not.toMatch(/segreto123|valore-privato/);
	}, 60_000);

	it("a marker found twice, in two shadow roots, is refused: the page changed", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/doppio`, guard);
		const uno = view.elements.find((e) => e.label === "Uno");
		const due = view.elements.find((e) => e.label === "Due");
		expect(uno && due).toBeTruthy();
		// Alone with its number, an element in a shadow root is clicked.
		expect(await sessions.click("k", uno?.ref as number, guard)).toMatchObject({ title: "Doppio" });
		const s = sessions["sessions"].get("k");
		// The page copies the marker of "Uno" onto "Due", which sits in another root.
		await s?.page.evaluate(`document.querySelector("x-due").shadowRoot.querySelector("button").setAttribute(${JSON.stringify(s.attr)}, ${JSON.stringify(String(uno?.ref))})`);
		await expect(sessions.click("k", uno?.ref as number, guard)).rejects.toThrow("la pagina è cambiata");
	}, 60_000);

	it("a page too big to look through is cut short, and an element is then not acted on: it could not be shown to be alone", async () => {
		const { base, sessions, browser } = await start();
		const view = await sessions.open("k", browser, `${base}/enorme`, guard);
		expect(view.elements.map((e) => e.label)).toContain("Unico");
		expect(view.details.join("\n")).toContain("elementi non elencati");
		await expect(sessions.click("k", view.elements.find((e) => e.label === "Unico")?.ref as number, guard)).rejects.toThrow("la pagina è cambiata");
	}, 60_000);
});
