import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { apiCaller, apiTransportProblem, apiUrl } from "../src/connectors/api.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const KEY = "sk-live-0123456789";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

/** A small API under /v1: every request in `seen`; /v1/echo sends back what it got, key included. */
async function service() {
	const seen: Seen[] = [];
	const http: Server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		seen.push({ method: req.method as string, url: req.url as string, headers: req.headers, body });
		const path = new URL(req.url as string, "http://x").pathname;
		if (path === "/v1/echo") {
			res.setHeader("content-type", "application/json");
			return res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, url: req.url }));
		}
		if (path === "/v1/links") {
			// What a paginated API sends back: its own address, key included, and the key inside JSON.
			const key = new URL(req.url as string, "http://x").searchParams.get("api_key") ?? "";
			res.setHeader("content-type", "application/json");
			return res.end(`{"next":"http://x${(req.url as string).replace(/\?.*/, "")}?page=2&${new URLSearchParams({ api_key: key })}","raw":${JSON.stringify(key)},"u":"${[...key].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`);
		}
		if (path === "/v1/denied") {
			res.statusCode = 401;
			return res.end("bad key");
		}
		res.setHeader("content-type", "application/json");
		res.statusCode = req.method === "POST" ? 201 : 200;
		res.end(JSON.stringify(req.method === "POST" ? { id: 7, created: JSON.parse(body || "null") } : [{ id: 1, nome: "Rossi" }]));
	});
	await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
	closers.push(() => {
		http.closeAllConnections();
		return new Promise((r) => http.close(() => r()));
	});
	return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`, seen };
}

async function boot() {
	const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
	const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
	closers.push(() => owni.stop());
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	const api = async (path: string, body?: unknown, method?: string): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
	const thread = (await api("/api/instances/owni/dm", {})).thread;
	const entries = async () => (await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string }[];
	const reply = async (text: string, count = 1): Promise<string> => {
		const before = (await entries()).filter((e) => e.from === "owni").length;
		if (text !== "") await api(`/api/instances/owni/threads/${thread.id}/messages`, { text });
		for (const start = Date.now(); Date.now() - start < 20_000; ) {
			const now = (await entries()).filter((e) => e.from === "owni");
			if (now.length >= before + count) return now.at(-1)?.text ?? "";
			await new Promise((r) => setTimeout(r, 30));
		}
		throw new Error("no reply");
	};
	return { owni, api, reply };
}

const save = (api: Awaited<ReturnType<typeof boot>>["api"], baseUrl: string, extra: Record<string, unknown> = {}) =>
	api("/api/instances/owni/connectors/crm", { name: "CRM", transport: { type: "api", baseUrl, auth: { kind: "bearer" }, notes: "GET /clienti cerca; POST /clienti crea" }, key: KEY, ...extra }, "PUT");

describe("the address of a request stays under the base (ADR 0116)", () => {
	const t = { baseUrl: "https://api.example.com/v1", auth: { kind: "query" as const, name: "api_key" } };

	it("puts a relative path under the base, with the query as given", () => {
		expect(apiUrl(t, "/clienti/42", { q: "rossi", tag: ["a", "b"], n: 3 }).href).toBe("https://api.example.com/v1/clienti/42?q=rossi&tag=a&tag=b&n=3");
		expect(apiUrl(t, "clienti", undefined).href).toBe("https://api.example.com/v1/clienti");
		expect(apiUrl(t, "", undefined).href).toBe("https://api.example.com/v1");
	});

	it("refuses a path that leaves it, and the key's own parameter", () => {
		for (const path of ["../admin", "/v1/../../admin", "%2e%2e/admin", "//evil.example/x", "https://evil.example/x", "a?b=1", "a#b", "a b", "a\\b", "./x", "..;/other", "..%3b/other", "..%5c..%5cadmin", "%252e%252e/admin", "x/..%00/y", "a%2f..%2f..%2fadmin"]) expect(() => apiUrl(t, path, undefined), path).toThrow();
		expect(apiUrl(t, "/clienti/caff%C3%A8", undefined).pathname).toBe("/v1/clienti/caff%C3%A8");
		expect(() => apiUrl(t, "/x", { API_KEY: "mine" })).toThrow(/lo mette Owni/);
		expect(() => apiUrl(t, "/x", { deep: { a: 1 } })).toThrow(/solo testo/);
		expect(() => apiUrl(t, "/x", Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, i])))).toThrow(/al massimo/);
	});

	it("accepts only an https base without credentials or parameters, and a header Owni does not set itself", () => {
		expect(apiTransportProblem({ type: "api", baseUrl: "https://api.example.com/v1" })).toBeUndefined();
		expect(apiTransportProblem({ type: "api", baseUrl: "http://127.0.0.1:9/v1" })).toBeUndefined();
		expect(apiTransportProblem({ type: "api", baseUrl: "http://api.example.com" })).toMatch(/https/);
		expect(apiTransportProblem({ type: "api", baseUrl: "https://u:p@api.example.com" })).toMatch(/password/);
		expect(apiTransportProblem({ type: "api", baseUrl: "https://api.example.com?k=1" })).toMatch(/parametri/);
		expect(apiTransportProblem({ type: "api", baseUrl: "https://api.example.com", auth: { kind: "header", name: "Host" } })).toMatch(/header/);
		expect(apiTransportProblem({ type: "api", baseUrl: "https://api.example.com", notes: "x".repeat(2001) })).toMatch(/nota/);
	});

	it("adds the key where the service wants it, only to its host, and hides it in what comes back", async () => {
		const s = await service();
		const allow = async () => ({ modelProviders: [], channels: [], connectors: ["mcp:crm"] });
		const query = apiCaller({ id: "crm", transport: { type: "api", baseUrl: s.base, auth: { kind: "query", name: "api_key" } } }, "mcp:crm", KEY, allow);
		const echoed = await query.send({ method: "GET", path: "/echo", query: { q: "x" } });
		expect(s.seen[0]?.url).toBe(`/v1/echo?q=x&api_key=${KEY}`);
		expect(echoed.text).not.toContain(KEY);
		expect(echoed.text).toContain("[chiave]");
		const odd = "ab+/c\"d=";
		const encoded = apiCaller({ id: "crm", transport: { type: "api", baseUrl: s.base, auth: { kind: "query", name: "api_key" } } }, "mcp:crm", odd, allow);
		const links = await encoded.send({ method: "GET", path: "/links" });
		expect(s.seen.at(-1)?.url).toContain(new URLSearchParams({ api_key: odd }).toString());
		expect(links.text.match(/\[chiave\]/g)).toHaveLength(3);
		for (const form of [odd, encodeURIComponent(odd), new URLSearchParams({ k: odd }).toString().slice(2), JSON.stringify(odd).slice(1, -1)]) expect(links.text).not.toContain(form);
		s.seen.splice(1);
		const header = apiCaller({ id: "crm", transport: { type: "api", baseUrl: s.base, auth: { kind: "header", name: "X-API-Key" } } }, "mcp:crm", KEY, allow);
		await header.send({ method: "POST", path: "/clienti", body: { nome: "Rossi" } });
		expect(s.seen[1]).toMatchObject({ method: "POST", url: "/v1/clienti", body: '{"nome":"Rossi"}' });
		expect(s.seen[1]?.headers).toMatchObject({ "x-api-key": KEY, "content-type": "application/json" });
		await expect(header.send({ method: "GET", path: "/x", body: { a: 1 } })).rejects.toThrow(/corpo/);
		const denied = apiCaller({ id: "crm", transport: { type: "api", baseUrl: s.base } }, "mcp:crm", undefined, async () => ({ modelProviders: [], channels: [] }));
		await expect(denied.send({ method: "GET", path: "/x" })).rejects.toThrow();
		expect(s.seen).toHaveLength(2);
	});
});

describe("a collegamento API of an agente (ADR 0116)", () => {
	it("reads at once with the key, which never reaches the model, the console or the audit", async () => {
		const s = await service();
		const { owni, api, reply } = await boot();
		const saved = await save(api, s.base);
		expect(saved.status).toMatchObject({ connected: true, approval: ["crm__write"] });
		const listed = JSON.stringify((await api("/api/instances/owni/connectors")).connectors);
		expect(listed).toContain("connector.crm.owni.authorization");
		expect(listed).not.toContain(KEY);
		expect(await reply('/tool crm__read {"path":"/clienti","query":{"q":"rossi"}}')).toMatch(/^Fatto\. HTTP 200\n[\s\S]*Rossi/);
		expect(s.seen[0]).toMatchObject({ method: "GET", url: "/v1/clienti?q=rossi" });
		expect(s.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
		// A service that sends the key back does not hand it to the model.
		const echoed = await reply('/tool crm__read {"path":"/echo"}');
		expect(echoed).toContain("Bearer [chiave]");
		expect(echoed).not.toContain(KEY);
		expect(await reply('/tool crm__read {"path":"/denied"}')).toMatch(/HTTP 401[\s\S]*Servizi dell'agente/);
		expect(await reply('/tool crm__read {"path":"../admin"}')).toMatch(/Niente è stato mandato/);
		expect(s.seen).toHaveLength(3);
		expect(await owni.runtime.secrets("default").get("connector.crm.owni.authorization")).toBe(KEY);
		expect(JSON.stringify(await owni.runtime.audit("default").read())).not.toContain(KEY);
	});

	it("writes only after a person approves, once, to the address that was approved", async () => {
		const s = await service();
		const { owni, api, reply } = await boot();
		await save(api, s.base);
		const asked = await reply(`/tool crm__write ${JSON.stringify({ method: "POST", path: "/clienti", body: { nome: "Bianchi" }, owni_reason: "Aggiungo il cliente che mi hai dato" })}`);
		expect(asked).toMatch(/Richiesta [0-9a-f]{12} pronta \(POST \/clienti su CRM\)/);
		expect(s.seen).toEqual([]);
		const [action] = (await api("/api/instances/owni/connector-actions")).actions;
		expect(action).toMatchObject({ status: "pending", connectorId: "crm", tool: "write", toolTitle: "POST /clienti", destructive: false, args: { method: "POST", path: "/clienti", body: { nome: "Bianchi" } } });
		expect(JSON.stringify(action)).not.toContain(KEY);
		const decided = await api(`/api/instances/owni/connector-actions/${action.id}/decision`, { decision: "approved" });
		expect(decided.action).toMatchObject({ status: "done", result: { text: expect.stringContaining("HTTP 201") } });
		expect(s.seen).toEqual([expect.objectContaining({ method: "POST", url: "/v1/clienti", body: '{"nome":"Bianchi"}' })]);
		// The outcome comes back to the conversation.
		expect(await reply("", 1)).toMatch(/Esito della richiesta [0-9a-f]{12}[\s\S]*HTTP 201/);
		expect((await api(`/api/instances/owni/connector-actions/${action.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		expect(s.seen).toHaveLength(1);
		// A DELETE is marked as one; a request that cannot go is not asked at all.
		await reply(`/tool crm__write ${JSON.stringify({ method: "DELETE", path: "/clienti/7", owni_reason: "Tolgo il cliente doppio" })}`);
		expect((await api("/api/instances/owni/connector-actions")).actions.find((a: { status: string }) => a.status === "pending")).toMatchObject({ destructive: true, toolTitle: "DELETE /clienti/7" });
		expect(await reply(`/tool crm__write ${JSON.stringify({ method: "POST", path: "//evil.example/x", owni_reason: "Prova" })}`)).toMatch(/Niente è stato mandato/);
		expect((await api("/api/instances/owni/connector-actions")).actions).toHaveLength(2);
		expect(JSON.stringify(await owni.runtime.audit("default").read())).not.toContain(KEY);
	});

	it("an API write always waits: no approval setting turns it off or is kept for an API", async () => {
		const s = await service();
		const { api, reply } = await boot();
		for (const approval of ["none", "writes"]) {
			const saved = await save(api, s.base, { approval });
			expect(saved.status).toMatchObject({ connected: true, approval: ["crm__write"] });
			expect((await api("/api/instances/owni/connectors")).connectors[0]).not.toHaveProperty("approval");
			expect(await reply(`/tool crm__write ${JSON.stringify({ method: "POST", path: "/clienti", body: { nome: "Verdi" }, owni_reason: "Aggiungo il cliente" })}`)).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		}
		expect(s.seen).toHaveLength(0);
	});

	it("keeps the key for the same service, asks it again for a new host, and drops it with the collegamento", async () => {
		const s = await service();
		const other = await service();
		const { owni, api, reply } = await boot();
		expect((await api("/api/instances/owni/connectors/crm", { name: "CRM", transport: { type: "api", baseUrl: s.base, auth: { kind: "bearer" } } }, "PUT")).status).toBe(400);
		await save(api, s.base, { key: `Bearer ${KEY}` });
		const secrets = owni.runtime.secrets("default");
		expect(await secrets.get("connector.crm.owni.authorization")).toBe(KEY);
		// Saved again without a key, same service: the key stays.
		expect((await save(api, `${s.base}/`, { key: undefined })).status).toMatchObject({ connected: true });
		await reply('/tool crm__read {"path":"/clienti"}');
		expect(s.seen.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
		// Another host never gets the old key.
		const moved = await save(api, other.base, { key: undefined });
		expect(moved).toMatchObject({ status: 400, error: expect.stringContaining("indirizzo nuovo") });
		expect((await save(api, other.base, { key: "sk-other-key" })).status).toMatchObject({ connected: true });
		await reply('/tool crm__read {"path":"/clienti"}');
		expect(other.seen.at(-1)?.headers.authorization).toBe("Bearer sk-other-key");
		// Without a way in, there is no key to keep.
		await api("/api/instances/owni/connectors/crm", { name: "CRM", transport: { type: "api", baseUrl: other.base } }, "PUT");
		expect(await secrets.get("connector.crm.owni.authorization")).toBeUndefined();
		// Nor once the collegamento becomes another kind of connector.
		await save(api, other.base);
		await api("/api/instances/owni/connectors/crm", { name: "CRM", transport: { type: "http", url: "https://mcp.example.com/mcp", headerSecrets: { authorization: "connector.crm.owni.authorization" } } }, "PUT");
		expect(await secrets.get("connector.crm.owni.authorization")).toBeUndefined();
		await save(api, other.base);
		expect((await api("/api/instances/owni/connectors/crm", undefined, "DELETE")).removed).toBe(true);
		expect(await secrets.get("connector.crm.owni.authorization")).toBeUndefined();
	});

	it("a secret is set only under the agente it belongs to", async () => {
		const { api } = await boot();
		expect((await api("/api/instances/owni/secrets/connector.crm.vendite.authorization", { value: "x" }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/secrets/telegram.botToken.owni", { value: "x" }, "PUT")).status).toBe(400);
		expect((await api("/api/instances/owni/secrets/connector.crm.owni.x-api-key", { value: "x" }, "PUT")).ok).toBe(true);
	});
});
