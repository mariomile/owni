import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningOwni[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

/** A Telegram that knows every token and has no messages: enough for a bot to be connected. */
const quietTelegram = (async (url: string | URL | Request) => {
	if (String(url).endsWith("/getUpdates")) await new Promise((r) => setTimeout(r, 20));
	return Response.json({ ok: true, result: String(url).endsWith("/getMe") ? { username: "owni_bot" } : [] });
}) as typeof fetch;

async function boot(env: Record<string, string> = {}) {
	const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", ...env });
	const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, telegramFetch: quietTelegram, log: () => {} });
	running.push(owni);
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	return { owni, base, api: await client(base, owni.ownerLink as string) };
}

async function client(base: string, link: string) {
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	return async (path: string, method = "GET", body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
}

const nothingDone = { model: false, instructions: false, tried: false, channel: false, web: false, people: false, can: { search: false, transcription: false, speech: false, images: false }, images: false, connectors: false };

describe("primi passi", () => {
	it("each step is checked from the real settings, and only the owner sees them", async () => {
		const { owni, base, api } = await boot();
		expect((await api("/api/instances/owni/setup")).setup).toEqual(nothingDone);
		await api("/api/instances/owni/settings", "PUT", { about: "Assistente di Studio Rossi." });
		const instructions = (await api("/api/instances/owni/settings")).settings.instructions as string;
		// Added to what Owni can do, not in its place.
		expect(instructions).toContain("watch_");
		expect(instructions.endsWith("Informazioni su chi ti usa:\nAssistente di Studio Rossi.")).toBe(true);
		const thread = (await api("/api/instances/owni/dm", "POST", {})).thread;
		await api(`/api/instances/owni/threads/${thread.id}/messages`, "POST", { text: "Ciao" });
		for (let i = 0; i < 200 && !(await api("/api/instances/owni/setup")).setup.tried; i++) await new Promise((r) => setTimeout(r, 30));
		const record = await owni.runtime.registry.getInstance("default", "owni");
		await owni.runtime.registry.setEgress("default", "owni", { ...record.egress, web: ["comune.roma.it"] });
		// Someone added who cannot write to this instance is not the team yet.
		const added = await api("/api/people", "POST", { name: "Giulia" });
		expect((await api("/api/instances/owni/setup")).setup.people).toBe(false);
		const owner = (await api("/api/me")).person.id as string;
		await api("/api/instances/owni/settings", "PUT", { webPeople: [owner, added.person.id] });
		expect((await api("/api/instances/owni/setup")).setup).toEqual({ ...nothingDone, instructions: true, tried: true, web: true, people: true });
		const giulia = await client(base, added.link);
		expect((await giulia("/api/instances/owni/setup")).status).toBe(403);
	});

	it("saving again replaces the owner's block, and bad or placeholder text is refused", async () => {
		const { api } = await boot();
		await api("/api/instances/owni/settings", "PUT", { about: "Primo testo." });
		await api("/api/instances/owni/settings", "PUT", { about: "Secondo testo." });
		const instructions = (await api("/api/instances/owni/settings")).settings.instructions as string;
		expect(instructions.match(/Informazioni su chi ti usa:/g)).toHaveLength(1);
		expect(instructions).not.toContain("Primo testo");
		expect(instructions.endsWith("Secondo testo.")).toBe(true);
		expect((await api("/api/instances/owni/settings", "PUT", { about: "  " })).status).toBe(400);
		expect((await api("/api/instances/owni/settings", "PUT", { about: "Assistente di [nome dell'attività]" })).status).toBe(400);
		expect((await api("/api/instances/owni/settings", "PUT", { about: "x".repeat(2001) })).status).toBe(400);
		expect((await api("/api/instances/owni/settings", "PUT", { about: "Ciao", instructions: "Altro" })).status).toBe(400);
		expect((await api("/api/instances/owni/settings")).settings.instructions).toBe(instructions);
	});

	it("an old copy of the default instructions is still the default; the owner's own text counts", async () => {
		const { owni, api } = await boot();
		await owni.runtime.registry.updateInstance("default", "owni", { instructions: "Sei Owni, l'assistente sempre attiva di un'azienda italiana. Puoi: cose di una versione vecchia." });
		expect((await api("/api/instances/owni/setup")).setup.instructions).toBe(false);
		await owni.runtime.registry.updateInstance("default", "owni", { instructions: "Sei il centralino della pizzeria Da Mario." });
		expect((await api("/api/instances/owni/setup")).setup.instructions).toBe(true);
	});

	it("a connected bot is a step done only once someone can write to it", async () => {
		const { owni, api } = await boot({ TELEGRAM_BOT_TOKEN: "1:T" });
		expect((await api("/api/instances/owni/setup")).setup.channel).toBe(false);
		await owni.runtime.registry.setAllowedUsers("default", "owni", "telegram", ["7"]);
		expect((await api("/api/instances/owni/setup")).setup.channel).toBe(true);
	});

	it("a new instance with the owner's words keeps what Owni can do", async () => {
		const { api } = await boot();
		await api("/api/instances", "POST", { id: "vendite", name: "Vendite", instructions: "Segui i clienti del negozio." });
		const instructions = (await api("/api/instances/vendite/settings")).settings.instructions as string;
		expect(instructions).toContain("watch_");
		expect(instructions.endsWith("Informazioni su chi ti usa:\nSegui i clienti del negozio.")).toBe(true);
		expect((await api("/api/instances/vendite/setup")).setup.instructions).toBe(true);
	});
});

describe("console as an app", () => {
	it("serves a manifest whose icons exist, a service worker that is always rechecked, and allows both in the CSP", async () => {
		const { base } = await boot();
		const manifest = await fetch(`${base}/manifest.webmanifest`);
		expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
		const m = (await manifest.json()) as { start_url: string; display: string; icons: { src: string; type: string; sizes: string; purpose?: string }[] };
		expect(m).toMatchObject({ start_url: "/", display: "standalone" });
		expect(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
		for (const icon of m.icons) {
			const res = await fetch(`${base}${icon.src}`);
			expect(res.status, icon.src).toBe(200);
			expect(res.headers.get("content-type")).toBe(icon.type);
		}
		const sw = await fetch(`${base}/sw.js`);
		expect(sw.headers.get("content-type")).toContain("text/javascript");
		expect(sw.headers.get("cache-control")).toBe("no-cache");
		const page = await fetch(`${base}/`);
		expect(await page.text()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
		expect(page.headers.get("content-security-policy")).toContain("manifest-src 'self'; worker-src 'self'");
		expect((await fetch(`${base}/apple-touch-icon.png`)).status).toBe(200);
	});

	it("the service worker keeps only the shell: never /api, other sites or uploads; offline, the page comes from the cache", async () => {
		const code = readFileSync(join(import.meta.dirname, "..", "src", "web", "ui", "sw.js"), "utf8");
		const handlers: Record<string, (event: unknown) => void> = {};
		const cached = new Map<string, string>([["/", "shell page"]]);
		const put: string[] = [];
		let online = true;
		const self = {
			location: { origin: "https://owni.example" },
			addEventListener: (type: string, fn: (event: unknown) => void) => (handlers[type] = fn),
			skipWaiting: async () => {},
			clients: { claim: async () => {} },
		};
		const caches = {
			open: async () => ({ addAll: async () => {}, put: async (req: string | { url: string }) => put.push(typeof req === "string" ? req : new URL(req.url).pathname) }),
			keys: async () => [],
			match: async (key: string | { url: string }) => {
				const path = typeof key === "string" ? key : new URL(key.url).pathname;
				return cached.has(path) ? { body: cached.get(path) } : undefined;
			},
		};
		const fetch = async (req: { url: string }) => {
			if (!online) throw new TypeError("offline");
			return { ok: true, type: "basic", body: `net ${new URL(req.url).pathname}`, clone: () => ({}) };
		};
		runInNewContext(code, { self, caches, fetch, URL, Response: { error: () => ({ error: true }) }, Promise });
		const request = async (path: string, mode = "cors", method = "GET", origin = "https://owni.example") => {
			let answer: Promise<unknown> | undefined;
			handlers.fetch?.({ request: { url: `${origin}${path}`, mode, method }, respondWith: (p: Promise<unknown>) => (answer = p) });
			return answer === undefined ? "not handled" : await answer;
		};
		expect(await request("/api/me")).toBe("not handled");
		expect(await request("/api/instances/owni/files/raw?path=a.pdf")).toBe("not handled");
		expect(await request("/app.js", "cors", "POST")).toBe("not handled");
		expect(await request("/app.js", "cors", "GET", "https://cdn.example")).toBe("not handled");
		// A file opened in a new tab, or the return from Google, is never answered with the shell.
		expect(await request("/api/instances/owni/files/raw?path=a.pdf", "navigate")).toBe("not handled");
		expect(await request("/oauth/google/callback?code=x", "navigate")).toBe("not handled");
		expect(await request("/app.js")).toMatchObject({ body: "net /app.js" });
		// The page opened online is the one kept for offline; another address is not kept as the page.
		expect(await request("/", "navigate")).toMatchObject({ body: "net /" });
		expect(await request("/qualcosa", "navigate")).toMatchObject({ body: "net /qualcosa" });
		await new Promise((r) => setTimeout(r, 0));
		expect(put).toEqual(["/app.js", "/"]);
		online = false;
		expect(await request("/qualsiasi", "navigate")).toMatchObject({ body: "shell page" });
		expect(await request("/app.css")).toMatchObject({ error: true });
	});
});
