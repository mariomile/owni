import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { type DurableEngine, OwniRuntime } from "../src/core/index.ts";
import { checkOrg, EMPTY_ORG, type Org, onlyKnown, orgLinks, orgNote, placeLine, withoutAgent } from "../src/core/org.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { FAUX_MODEL, tempDataDir } from "./helpers.ts";
import { chromiumFound, launchChromium } from "./playwright-browsers.ts";

const NAMES = new Map([
	["owni", "Owni"],
	["vendite", "Responsabile vendite"],
	["preventivi", "Preventivi"],
	["conti", "Contabile"],
	["ufficio", "Assistente d'ufficio"],
]);

/** Two squadre, each with its coordinator; Owni above both, and the office open to all. */
const COMPANY: Org = {
	teams: [
		{ id: "vendite", name: "Vendite", purpose: "Clienti e preventivi", lead: "vendite" },
		{ id: "amministrazione", name: "Amministrazione", purpose: "", lead: "conti" },
	],
	agents: {
		owni: { role: "Direzione", owns: [] },
		vendite: { role: "Responsabile vendite", team: "vendite", reportsTo: "owni", owns: ["Clienti da seguire"] },
		preventivi: { role: "Preventivi", team: "vendite", reportsTo: "vendite", owns: ["Preventivi e listino", "Preventivi in attesa"] },
		conti: { role: "Contabile", team: "amministrazione", reportsTo: "owni", owns: ["Fatture"] },
		ufficio: { role: "Ufficio", owns: ["Agenda"], open: true },
	},
};

describe("the organigramma (ADR 0117)", () => {
	it("is checked against the agenti there are: squadre, coordinators, chains, limits; empty places dropped, text cleaned", () => {
		expect(checkOrg(COMPANY, NAMES)).toEqual(COMPANY);
		const fails = (org: unknown) => {
			try {
				checkOrg(org, NAMES);
				return "";
			} catch (error) {
				return (error as Error).message;
			}
		};
		expect(fails({ teams: [], agents: { fantasma: { role: "X" } } })).toBe("Agente sconosciuto: fantasma");
		expect(fails({ teams: [{ id: "A B", name: "X" }] })).toBe("ID di squadra non valido");
		expect(fails({ teams: [{ id: "a", name: "Vendite" }, { id: "b", name: "vendite" }] })).toBe("Due squadre si chiamano «vendite»");
		expect(fails({ teams: [{ id: "a", name: " " }] })).toBe("Ogni squadra ha bisogno di un nome");
		expect(fails({ teams: [{ id: "a", name: "A", lead: "conti" }], agents: { conti: { owns: [] } } })).toBe("«Contabile» coordina «A» ma non ne fa parte");
		expect(fails({ agents: { conti: { team: "nessuna", owns: [] } } })).toBe("«Contabile» è in una squadra che non c'è");
		expect(fails({ agents: { conti: { reportsTo: "conti", owns: [] } } })).toBe("«Contabile» non può rispondere a se stesso");
		expect(fails({ agents: { conti: { reportsTo: "ufficio" }, ufficio: { reportsTo: "vendite" }, vendite: { reportsTo: "conti" } } })).toMatch(/torna su se stesso/);
		expect(fails({ agents: { conti: { owns: Array.from({ length: 11 }, (_, i) => `c${i}`) } } })).toBe("Al massimo 10 responsabilità per agente");
		expect(fails({ agents: { conti: { role: "x".repeat(61) } } })).toBe("Ruolo di «Contabile»: al massimo 60 caratteri");
		expect(fails({ teams: Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, name: `T${i}` })) })).toBe("Al massimo 20 squadre");
		expect(fails("x")).toBe("Organigramma non valido");
		const clean = checkOrg({ agents: { conti: { role: " Conta\nbile  ", owns: ["Fatture", " Fatture ", "", "Spese\u0007"] }, ufficio: { role: "", owns: [] } } }, NAMES);
		expect(clean).toEqual({ teams: [], agents: { conti: { role: "Conta bile", owns: ["Fatture", "Spese"] } } });
		// Invisible characters go too: a reversed line or a hidden one would read differently to the agente.
		expect(checkOrg({ agents: { conti: { role: "Conta\u202Ebile\u200B" } } }, NAMES).agents.conti?.role).toBe("Contabile");
	});

	it("says who writes to whom: a squadra among itself, up and down, the coordinators, everyone to the one open to all", () => {
		// For each agente, who may write to it.
		const links = orgLinks(COMPANY, [...NAMES.keys()]);
		expect(links.get("preventivi")).toEqual(["vendite"]);
		// Preventivi does not reach Contabile: it goes through who coordinates.
		expect(links.get("conti")).toEqual(["owni", "vendite"]);
		expect(links.get("vendite")).toEqual(["conti", "owni", "preventivi"]);
		// Open to all: everyone writes to it, and it writes to nobody it has no other link with.
		expect(links.get("ufficio")).toEqual(["conti", "owni", "preventivi", "vendite"]);
		expect(links.get("owni")).toEqual(["conti", "vendite"]);
		// An agente not placed accepts nobody, and is not reached.
		expect(orgLinks(EMPTY_ORG, ["owni", "conti"])).toEqual(
			new Map([
				["owni", []],
				["conti", []],
			]),
		);
	});

	it("tells each agente its place, and agent_list what each one owns", () => {
		const lead = orgNote(COMPANY, "vendite", NAMES) as string;
		expect(lead).toContain("## Il tuo posto nell'azienda");
		expect(lead).toContain("- Ruolo: Responsabile vendite.");
		expect(lead).toContain("- Squadra «Vendite» (Clienti e preventivi): la coordini tu. Con te: Preventivi (preventivi), Preventivi.");
		expect(lead).toContain("- Rispondi a Owni (owni).");
		expect(lead).toContain("- Rispondono a te: Preventivi (preventivi).");
		expect(lead).toContain("Coordini «Vendite»");
		expect(lead).toContain("agent_list dice chi è responsabile di cosa");
		const member = orgNote(COMPANY, "preventivi", NAMES) as string;
		expect(member).toContain("- Sei responsabile di: Preventivi e listino; Preventivi in attesa.");
		expect(member).toContain("te lo passa chi coordina, Responsabile vendite (vendite)");
		expect(orgNote(COMPANY, "owni", NAMES)).toContain("- Rispondono a te: Responsabile vendite (vendite) e Contabile (conti).");
		expect(orgNote(COMPANY, "ufficio", NAMES)).toContain("Sei a disposizione di tutti");
		expect(orgNote(EMPTY_ORG, "owni", NAMES)).toBeUndefined();
		expect(placeLine(COMPANY, "vendite")).toBe("Responsabile vendite, squadra Vendite (la coordina). Responsabile di: Clienti da seguire");
		expect(placeLine(COMPANY, "ufficio")).toBe("Ufficio. Responsabile di: Agenda");
		expect(placeLine(COMPANY, "nessuno")).toBe("");
	});

	it("reads an agente called «constructor» as an agente, not as part of Object", () => {
		const names = new Map([...NAMES, ["constructor", "Costruttore"]]);
		expect(placeLine(COMPANY, "constructor")).toBe("");
		expect(orgNote(COMPANY, "constructor", names)).toBeUndefined();
		const org = checkOrg({ teams: [{ id: "cantiere", name: "Cantiere", lead: "constructor" }], agents: { constructor: { team: "cantiere", owns: ["Lavori"] }, conti: { reportsTo: "constructor" } } }, names);
		expect(placeLine(org, "constructor")).toBe("squadra Cantiere (la coordina). Responsabile di: Lavori");
		expect(orgLinks(org, [...names.keys()]).get("constructor")).toEqual(["conti"]);
		expect(onlyKnown(org, NAMES)).toEqual({ teams: [{ id: "cantiere", name: "Cantiere", purpose: "" }], agents: { conti: { owns: [] } } });
	});

	it("forgets an agente that is gone: who answered to it answers to nobody, its squadra has no coordinator", () => {
		const left = withoutAgent(COMPANY, "vendite");
		expect(left.agents.vendite).toBeUndefined();
		expect(left.agents.preventivi).toEqual({ role: "Preventivi", team: "vendite", owns: ["Preventivi e listino", "Preventivi in attesa"] });
		expect(left.teams[0]).toEqual({ id: "vendite", name: "Vendite", purpose: "Clienti e preventivi" });
		expect(() => checkOrg(left, new Map([...NAMES].filter(([id]) => id !== "vendite")))).not.toThrow();
	});

	it("reaches the agente's instructions before every request, after its own and before its skills", async () => {
		const seen: (() => string | undefined)[] = [];
		const engine: DurableEngine = {
			open: async (options) => {
				if (typeof options.instructions === "function") seen.push(options.instructions);
				return { submit: async () => ({ submissionId: "s" }), resume: async () => ({ pending: 0 }), reattach: async () => false, setThreadModel: async () => {}, threadModel: async () => undefined, onReply: () => () => {}, idle: async () => {}, close: async () => {} };
			},
		};
		const runtime = new OwniRuntime({ dataDir: tempDataDir(), engine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		for (const [id, name] of NAMES) await runtime.registry.createInstance("acme", { id, name, model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: [] }, instructions: "Sei Owni." });
		await runtime.openInstance("acme", "preventivi");
		const now = seen[0] as () => string | undefined;
		expect(now()).not.toContain("Il tuo posto");
		runtime.org("acme").update(() => COMPANY);
		// No reopen: the next request reads it.
		expect(now()).toMatch(/^Sei Owni\.\n\n## Il tuo posto nell'azienda\n[\s\S]*\n\nSkill:/);
		await runtime.close();
	});
});

describe("the organigramma's routes", () => {
	const running: RunningOwni[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("only the owner reads and saves it; saving rewrites who writes to whom, and agent_list says who owns what", async () => {
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = async (link: string) => {
			const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
			const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
			// biome-ignore lint: test
			return async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> => {
				const r = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
				return { status: r.status, ...((await r.json()) as object) };
			};
		};
		const api = await login(owni.ownerLink as string);
		for (const [id, name] of NAMES) if (id !== "owni") await api("/api/instances", { id, name });
		// Permissions set by hand before stay until the first save.
		await owni.runtime.registry.setAllowedUsers("default", "conti", "agente", ["ufficio"]);
		await owni.runtime.registry.setEgress("default", "conti", () => ({ modelProviders: ["faux"], channels: ["web", "agente"] }));
		const first = await api("/api/org");
		expect(first).toMatchObject({ status: 200, saved: false, org: { teams: [], agents: {} } });
		expect(first.accepts.conti).toEqual(["ufficio"]);
		expect(first.agents.map((a: { id: string }) => a.id).sort()).toEqual([...NAMES.keys()].sort());

		const { version } = first;
		expect((await api("/api/org", { org: { teams: [{ id: "x", name: "X", lead: "conti" }], agents: {} }, version }, "PUT")).status).toBe(400);
		// Before saving, the owner sees what changes (ADR 0125): by name, nothing applied yet.
		const preview = await api("/api/org/preview", { org: COMPANY });
		expect(preview.status).toBe(200);
		expect(preview.changes).toContainEqual({ from: "Owni", to: "Responsabile vendite", allowed: true });
		expect(preview.changes).toContainEqual({ from: "Preventivi", to: "Responsabile vendite", allowed: true });
		// The permission set by hand goes: the organigramma does not link them.
		expect(preview.changes).toContainEqual({ from: "Assistente d'ufficio", to: "Contabile", allowed: false });
		expect((await api("/api/org")).accepts.conti).toEqual(["ufficio"]);
		expect((await api("/api/org/preview", { org: { teams: [{ id: "x", name: "X", lead: "conti" }], agents: {} } })).status).toBe(400);
		const saved = await api("/api/org", { org: COMPANY, version }, "PUT");
		expect(saved.status).toBe(200);
		// Taking it apart again would take those permissions away.
		expect((await api("/api/org/preview", { org: EMPTY_ORG })).changes).toContainEqual({ from: "Owni", to: "Responsabile vendite", allowed: false });
		expect(saved.saved).toBe(true);
		expect(saved.accepts).toEqual(Object.fromEntries(orgLinks(COMPANY, [...NAMES.keys()])));
		expect((await owni.runtime.registry.getInstance("default", "owni")).egress.channels).toContain("agente");
		const audit = await owni.runtime.audit("default").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "org.saved", teams: 2, agents: 5 }));

		// Preventivi lists who it may write to, with their place, then the rest of the company it reaches through others.
		const thread = (await api("/api/instances/preventivi/dm", {})).thread;
		await api(`/api/instances/preventivi/threads/${thread.id}/messages`, { text: "/tool agent_list {}" });
		let text = "";
		for (let i = 0; i < 100 && !text.includes("Altri agenti"); i += 1) {
			const entries = (await api(`/api/instances/preventivi/threads/${thread.id}`)).entries as { text?: string }[];
			text = entries.map((e) => e.text ?? "").join("\n");
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(text).toContain("- Responsabile vendite (vendite) [Responsabile vendite, squadra Vendite (la coordina). Responsabile di: Clienti da seguire]");
		expect(text).toContain("Altri agenti dell'azienda, a cui non puoi scrivere: per una cosa loro chiedi a chi coordina la tua squadra o a chi rispondi.\n- Contabile (conti) [Contabile, squadra Amministrazione (la coordina). Responsabile di: Fatture]\n- Owni (owni) [Direzione]");

		const { link } = await api("/api/people", { name: "Anna", role: "member" });
		const anna = await login(link);
		expect((await anna("/api/org")).status).toBe(403);
		expect((await anna("/api/org", { org: EMPTY_ORG, version: saved.version }, "PUT")).status).toBe(403);
		// A page opened before that save does not erase it.
		const stale = await api("/api/org", { org: EMPTY_ORG, version }, "PUT");
		expect(stale).toMatchObject({ status: 409, error: expect.stringContaining("ricaricala") });
		expect((await api("/api/org")).org).toEqual(COMPANY);
		// An agente deleted behind the organigramma's back does not lock it: it is dropped on read and on the next save.
		owni.runtime.org("default").update((org) => ({ ...org, agents: { ...org.agents, sparito: { owns: ["Niente"] } } }));
		const now = await api("/api/org");
		expect(now.org).toEqual(COMPANY);
		expect((await api("/api/org", { org: now.org, version: now.version }, "PUT")).status).toBe(200);
		// The old per-agente switch is gone: the organigramma is the one place.
		expect((await api("/api/instances/conti/agents", { from: [] }, "PUT")).status).toBe(404);
	});
});

describe.skipIf(!chromiumFound)("the organigramma as a tree, in real Chromium", () => {
	const running: RunningOwni[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("draws who answers to whom under the people, opens an agente's place on a click, and goes back to the squadre", async () => {
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const token = (owni.ownerLink as string).split("#")[1];
		const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token }) });
		const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = (path: string, body: unknown, method = "POST") => fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
		for (const [id, name] of NAMES) if (id !== "owni") await api("/api/instances", { id, name });
		const { version } = (await (await fetch(`${base}/api/org`, { headers: { cookie, "x-owni": "1" } })).json()) as { version: string };
		expect((await api("/api/org", { org: COMPANY, version }, "PUT")).status).toBe(200);

		const browser = await launchChromium();
		try {
			const page = await browser.newPage();
			const [name, value] = cookie.split("=") as [string, string];
			await page.context().addCookies([{ name, value, url: base }]);
			await page.goto(`${base}/#/organigramma/albero`);
			await page.waitForSelector(".org-tree");
			// Each node with what sits under it: the people at the root, then whoever answers to nobody.
			const tree = await page.evaluate(`(() => {
				const walk = (li) => ({ name: li.querySelector(":scope > .org-node b").textContent, below: [...li.querySelectorAll(":scope > ul > li")].map(walk) });
				return walk(document.querySelector(".org-tree > ul > li"));
			})()`);
			expect(tree).toEqual({
				name: "Le persone",
				below: [
					{ name: "Owni", below: [{ name: "Contabile", below: [] }, { name: "Responsabile vendite", below: [{ name: "Preventivi", below: [] }] }] },
					{ name: "Assistente d'ufficio", below: [] },
				],
			});
			// A screen reader hears what the box shows, not only the name.
			expect(await page.getByRole("button", { name: "Responsabile vendite, Coordina Vendite: modifica il suo posto" }).innerText()).toContain("Coordina Vendite");
			expect(await page.getByRole("button", { name: "Assistente d'ufficio, Ufficio, a disposizione di tutti: modifica il suo posto" }).count()).toBe(1);
			await page.getByRole("button", { name: "Preventivi, Vendite: modifica il suo posto" }).click();
			expect(await page.locator("dialog[open] h2").innerText()).toBe("Preventivi");
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Squadre", exact: true }).click();
			// The shell clears the page at once and draws the view when its data arrives: wait for that, not for the tree to go.
			await page.locator(".org-team").first().waitFor();
			expect(new URL(page.url()).hash).toBe("#/organigramma");
			// The view drawn after the click keeps the focus on its button.
			expect(await page.evaluate(`document.activeElement?.textContent`)).toBe("Squadre");
			await page.getByRole("button", { name: "Albero", exact: true }).click();
			await page.waitForSelector(".org-tree");
			expect(await page.evaluate(`document.activeElement?.textContent`)).toBe("Albero");
			// An agente created after the organigramma was saved has no place yet: it sits at the top, under the people.
			await api("/api/instances", { id: "nuovo", name: "Nuovo" });
			await page.reload();
			await page.waitForSelector(".org-tree");
			expect(await page.locator(".org-tree > ul > li > ul > li > .org-node b").allInnerTexts()).toEqual(["Nuovo", "Owni", "Assistente d'ufficio"]);
		} finally {
			await browser.close();
		}
	});
});
