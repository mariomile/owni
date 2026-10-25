import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { OwniRuntime } from "../src/core/index.ts";
import { instanceDir } from "../src/core/paths.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { type Browser, BrowseSessions, viewportPoint } from "../src/core/web-session.ts";
import { connectChannel } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { type BrowserPanel, BrowserPanelError, createWebApp } from "../src/web/server.ts";
import { FAUX_MODEL, tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

describe("a click on the browser panel's picture (ADR 0103)", () => {
	it("places the point of the picture in the 1280x800 page", () => {
		expect(viewportPoint(0, 0)).toEqual({ x: 0, y: 0 });
		expect(viewportPoint(0.5, 0.25)).toEqual({ x: 640, y: 200 });
		expect(viewportPoint(1, 1)).toEqual({ x: 1279, y: 799 });
	});

	/** A browser with one page of one text field, that records the mouse and says whether a file input (or its label) is where the rule looks. */
	function fakeBrowser() {
		const clicks: [number, number][] = [];
		const page = {
			goto: async () => {},
			goBack: async () => {},
			screenshot: async () => new Uint8Array(),
			title: async () => "Prova",
			url: () => "https://example.test/",
			evaluate: async (expression: string) => {
				if (expression.includes("all.length !== 1")) return { tag: "input", type: "text" };
				return { elements: [{ tag: "input", type: "text", label: "Campo" }], text: "Prova", textLength: 5 };
			},
			click: async () => {},
			mouse: { click: async (x: number, y: number) => void clicks.push([x, y]) },
			fill: async () => {},
			selectOption: async () => {},
			press: async () => {},
			waitForLoadState: async () => {},
			on: () => {},
			close: async () => {},
		};
		const context = { route: async () => {}, routeWebSocket: async () => {}, addInitScript: async () => {}, on: () => {}, newPage: async () => page, close: async () => {} };
		const browser = { newContext: async () => context, close: async () => {}, on: () => {} } as unknown as Browser;
		return { browser, clicks, page };
	}
	const guard = { hostAllowed: () => true, addressAllowed: () => true };

	it("clicks the mapped point: nothing without an open page", async () => {
		const sessions = new BrowseSessions();
		closers.push(() => sessions.closeAll());
		await expect(sessions.clickAt("k", 0.5, 0.5, guard)).rejects.toMatchObject({ kind: "no-page" });
		const ok = fakeBrowser();
		await sessions.open("k", ok.browser, "https://example.test/", guard);
		const before = sessions.state("k");
		await sessions.clickAt("k", 0.5, 0.25, guard, { person: true });
		expect(ok.clicks).toEqual([[640, 200]]);
		// The click is an action: the picture is taken again.
		expect(sessions.state("k")).toMatchObject({ open: true, version: (before as { version: number }).version + 1 });
	});

	it("a click the browser could not do comes back as a failed view: the agent reads why, the panel gets an error", async () => {
		const sessions = new BrowseSessions();
		closers.push(() => sessions.closeAll());
		const broken = fakeBrowser();
		broken.page.mouse.click = async () => {
			throw new Error("Timeout 10000ms exceeded");
		};
		await sessions.open("b", broken.browser, "https://example.test/", guard);
		const view = await sessions.clickAt("b", 0.5, 0.5, guard, { person: true });
		expect(view.failed).toBe(true);
		expect(view.notes).toContain("L'azione non è riuscita.");
	});

	async function setup() {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		const tenantDir = join(dataDir, "tenants", "acme");
		const people = new PeopleStore(tenantDir);
		const anna = await people.add("Anna", "member");
		const luca = await people.add("Luca", "member");
		const owner = await people.add("Owner", "owner");
		await runtime.registry.createInstance("acme", { id: "ops", name: "Ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["web"] }, allowedUsers: { web: [anna.person.id, luca.person.id] } });
		const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, instanceDir(dataDir, tenantId("acme"), instanceId("ops")));
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
		const clicks: [number, number][] = [];
		const controls: string[] = [];
		const cleared: [string, string][] = [];
		let clearFailure: string | undefined;
		let failing = false;
		const state = { open: true as const, url: "https://example.test/", title: "Prova", version: 3, busy: false, control: "agent" as const, profile: false };
		const browser: BrowserPanel = {
			available: () => true,
			state: async () => state,
			picture: async () => undefined,
			open: async () => state,
			back: async () => state,
			takeover: async () => { controls.push("takeover"); return { ...state, control: "person" }; },
			release: async () => { controls.push("release"); return state; },
			typeText: async () => { controls.push("type"); return state; },
			press: async () => { controls.push("press"); return state; },
			profile: async () => ({ hosts: ["example.test"] }),
			clearProfile: async (instance, person) => { cleared.push([instance, person]); if (person === clearFailure) { clearFailure = undefined; throw new Error("temporary disk failure"); } },
			click: async (_i, _t, x, y) => {
				clicks.push([x, y]);
				if (failing) throw new BrowserPanelError("Non è andata a buon fine: guarda la pagina e riprova.");
				return { ...state, version: 4 };
			},
		};
		const server = createWebApp({
			runtime,
			tenantId: "acme",
			people,
			sessions: new SessionStore(tenantDir),
			channels: new Map([["ops", channel]]),
			connectors: (id) => new ConnectorStore(instanceDir(dataDir, tenantId("acme"), instanceId(id))),
			connectorStatus: () => [],
			usage: new UsageLedger(tenantDir),
			uiDir: join(import.meta.dirname, "..", "src", "web", "ui"),
			secureCookies: false,
			defaultTimeZone: "Europe/Rome",
			browser,
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		closers.push(async () => {
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			await runtime.close();
		});
		const as = async (token: string) => {
			const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1", "content-type": "application/json" }, body: JSON.stringify({ token }) });
			const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
			return async (path: string, body?: unknown, method = "POST") => {
				const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
				return { status: res.status, body: (await res.json()) as any };
			};
		};
		return { base, anna, luca, owner, runtime, channel, as, clicks, controls, cleared, failClear: (person: string) => { clearFailure = person; }, fail: () => void (failing = true) };
	}

	it("keeps takeover, private input and saved logins inside the person's private conversation", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const luca = await h.as(h.luca.token);
		const owner = await h.as(h.owner.token);
		const thread = await h.channel.createThread(h.anna.person.id, "Chat");
		const base = `/api/instances/ops/threads/${thread.id}/browser`;
		const secret = "synthetic-login-value";
		for (const other of [luca, owner]) {
			for (const [suffix, body, method] of [["takeover", {}, "POST"], ["release", {}, "POST"], ["type", { text: secret }, "POST"], ["press", { key: "Enter" }, "POST"], ["profile", undefined, "GET"], ["profile", undefined, "DELETE"]] as const) {
				expect((await other(`${base}/${suffix}`, body, method)).status).toBe(404);
			}
		}
		expect(h.controls).toEqual([]);
		expect((await anna(`${base}/takeover`, {})).body.browser.control).toBe("person");
		expect((await anna(`${base}/type`, { text: secret })).status).toBe(200);
		expect((await anna(`${base}/press`, { key: "Enter" })).status).toBe(200);
		expect((await anna(`${base}/press`, { key: "Control+L" })).status).toBe(400);
		expect((await anna(`${base}/type`, { text: "x".repeat(1001) })).status).toBe(400);
		expect((await anna(`${base}/release`, {})).status).toBe(200);
		expect(h.controls).toEqual(["takeover", "type", "press", "release"]);
		expect(JSON.stringify(await h.runtime.audit("acme").read())).not.toContain(secret);
		expect(await h.channel.transcript(thread.id)).toEqual([]);
		expect((await anna(`${base}/profile`, undefined, "GET")).body).toEqual({ hosts: ["example.test"] });
		expect((await anna(`${base}/profile`, undefined, "DELETE")).status).toBe(200);
		expect(h.cleared).toEqual([["ops", h.anna.person.id]]);
		const room = await h.channel.createThread(h.anna.person.id, "Room", { room: "shared-room" });
		expect((await anna(`/api/instances/ops/threads/${room.id}/browser/takeover`, {})).status).toBe(404);
		await h.runtime.registry.setAllowedUsers("acme", "ops", "web", [h.luca.person.id]);
		expect((await anna(base, undefined, "GET")).status).toBe(404);
	});

	it("clears saved logins when membership or the person is removed", async () => {
		const h = await setup();
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/settings", { webPeople: [h.luca.person.id] }, "PUT")).status).toBe(200);
		expect(h.cleared).toEqual(expect.arrayContaining([["ops", h.anna.person.id]]));
		expect((await owner(`/api/people/${h.luca.person.id}`, undefined, "DELETE")).status).toBe(200);
		expect(h.cleared).toEqual(expect.arrayContaining([["ops", h.anna.person.id], ["ops", h.luca.person.id]]));
	});

	it("retries failed profile cleanup after membership was already persisted", async () => {
		const h = await setup();
		const owner = await h.as(h.owner.token);
		h.failClear(h.anna.person.id);
		expect((await owner("/api/instances/ops/settings", { webPeople: [h.luca.person.id] }, "PUT")).status).toBe(500);
		expect((await h.runtime.registry.getInstance("acme", "ops")).allowedUsers.web).not.toContain(h.anna.person.id);
		expect((await owner("/api/instances/ops/settings", { webPeople: [h.luca.person.id] }, "PUT")).status).toBe(200);
		expect(h.cleared.filter(([, person]) => person === h.anna.person.id)).toHaveLength(2);
	});

	it("the endpoint takes a click from the person who owns the conversation, and from nobody else", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const thread = (await anna("/api/instances/ops/dm", {})).body.thread;
		const path = `/api/instances/ops/threads/${thread.id}/browser/click`;
		const done = await anna(path, { x: 0.5, y: 0.25 });
		expect(done.status).toBe(200);
		expect(done.body.browser.version).toBe(4);
		expect(h.clicks).toEqual([[0.5, 0.25]]);
		// The edges of the picture are on it.
		expect((await anna(path, { x: 0, y: 1 })).status).toBe(200);
		// Out of range or not numbers: refused before the browser hears about it.
		for (const click of [{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.1 }, { x: "0.5", y: 0.5 }, { x: 0.5 }, { x: null, y: null }]) {
			const refused = await anna(path, click);
			expect(refused.status).toBe(400);
			expect(refused.body.error).toBe("Il clic non è sulla pagina");
		}
		expect(h.clicks).toHaveLength(2);
		// Each click of the person is in the audit, who and whether it worked; a refused point never reached the browser.
		expect((await h.runtime.audit("acme").read()).filter((e) => e.type === "web.browser.clicked").map((e) => [e.instanceId, e.personId, e.ok])).toEqual([["ops", h.anna.person.id, true], ["ops", h.anna.person.id, true]]);
		// A click the browser could not do: refused, and the audit says it did not work.
		h.fail();
		const failed = await anna(path, { x: 0.5, y: 0.5 });
		expect(failed.status).toBe(400);
		expect((await h.runtime.audit("acme").read()).filter((e) => e.type === "web.browser.clicked").map((e) => e.ok)).toEqual([true, true, false]);
		// Another person: it is not their conversation. Nobody logged in: nothing.
		const luca = await h.as(h.luca.token);
		expect((await luca(path, { x: 0.5, y: 0.5 })).status).toBe(404);
		const anonymous = await fetch(`${h.base}${path}`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ x: 0.5, y: 0.5 }) });
		expect(anonymous.status).toBe(401);
		// A person no longer allowed to write to the agente does not drive its browser.
		await h.runtime.registry.setAllowedUsers("acme", "ops", "web", [h.luca.person.id]);
		expect((await anna(path, { x: 0.5, y: 0.5 })).status).toBe(404);
		expect(h.clicks).toHaveLength(3);
	});
});
