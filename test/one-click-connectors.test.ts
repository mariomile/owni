import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { CONNECTOR_CATALOG, type CatalogEntry } from "../src/connectors/catalog.ts";
import { CONNECTOR_ID } from "../src/connectors/mcp.ts";
import { McpOAuthError, mcpOAuthSecret, signInFetch } from "../src/connectors/mcp-oauth.ts";
import { publicAddress } from "../src/core/web-fetch.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { type OAuthMcp, oauthMcp } from "./fixtures/oauth-mcp-server.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningOwni[] = [];
const fakes: OAuthMcp[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
	await Promise.all(
		fakes.splice(0).map((f) => {
			f.server.closeAllConnections();
			return new Promise((r) => f.server.close(r));
		}),
	);
});

async function boot(catalog: CatalogEntry[], env: Record<string, string> = { OWNI_PUBLIC_URL: "https://owni.example" }) {
	const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", ...env });
	const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {}, connectorCatalog: catalog, mcpOAuthAddressAllowed: () => true });
	running.push(owni);
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: (owni.ownerLink as string).split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
	return { owni, base, api };
}

async function fake(): Promise<OAuthMcp> {
	const f = await oauthMcp();
	fakes.push(f);
	return f;
}

/** The owner on the service's page: signs in, and the service sends them back with a code. */
async function signInAt(f: OAuthMcp, base: string, page: string, redirect = "https://owni.example/oauth/mcp/callback"): Promise<{ code: string; state: string }> {
	const url = new URL(page);
	expect(url.origin + url.pathname).toBe(`${f.base}/authorize`);
	expect(url.searchParams.get("redirect_uri")).toBe(redirect);
	const code = f.codeFor(url.searchParams.get("code_challenge") as string);
	const state = url.searchParams.get("state") as string;
	// The callback hands code and state to the console in the fragment, nothing else.
	const back = await fetch(`${base}/oauth/mcp/callback?code=${code}&state=${encodeURIComponent(state)}&extra=x`, { redirect: "manual" });
	expect(back.status).toBe(302);
	const location = back.headers.get("location") as string;
	expect(location.startsWith("/#/connettore?")).toBe(true);
	const params = new URLSearchParams(location.slice("/#/connettore?".length));
	expect([...params.keys()].sort()).toEqual(["code", "state"]);
	return { code: params.get("code") as string, state: params.get("state") as string };
}

const entry = (f: OAuthMcp, over: Partial<CatalogEntry> = {}): CatalogEntry => ({ id: "demo", name: "Demo", description: "Demo.", url: f.url, auth: "oauth", category: "lavoro", ...over });

describe("connector catalog", () => {
	it("lists well-known servers over https, with ids a connector can have and help for tokens", () => {
		const ids = new Set<string>();
		for (const e of CONNECTOR_CATALOG) {
			expect(CONNECTOR_ID.test(e.id), e.id).toBe(true);
			expect(new URL(e.url).protocol, e.id).toBe("https:");
			expect(ids.has(e.id), e.id).toBe(false);
			ids.add(e.id);
			if (e.auth === "token") expect(e.tokenHelp, e.id).toBeTruthy();
		}
		expect(CONNECTOR_CATALOG.length).toBeGreaterThanOrEqual(10);
	});
});

describe("one-click connectors with OAuth", () => {
	it("adds a connector, signs in on the service's page and comes back with its tools; tokens stay in the secret store", async () => {
		const f = await fake();
		const { owni, base, api } = await boot([entry(f)]);
		const { catalog, oauth } = await api("/api/connector-catalog");
		expect(oauth).toBe(true);
		expect(catalog.map((e: CatalogEntry) => e.id)).toEqual(["demo"]);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		expect(started.status).toBe(200);
		expect(f.registrations).toBe(1);
		expect(f.redirects).toEqual(["https://owni.example/oauth/mcp/callback"]);
		// Before the sign-in finishes, the connector is there and says what it needs.
		const listed = await api("/api/instances/owni/connectors");
		expect(listed.connectors[0]).toMatchObject({ id: "demo", allowed: true, transport: { type: "http", url: f.url, auth: "oauth" } });
		const back = await signInAt(f, base, started.url);
		const done = await api("/api/connectors/oauth/finish", "POST", back);
		expect(done).toMatchObject({ instanceId: "owni", connectorId: "demo" });
		const after = await api("/api/instances/owni/connectors");
		expect(after.connectors[0].status).toEqual({ id: "demo", connected: true, tools: ["demo__add", "demo__whoami"] });
		// The tool call carries the token got at sign-in.
		const thread = (await api("/api/instances/owni/dm", "POST", {})).thread;
		await api(`/api/instances/owni/threads/${thread.id}/messages`, "POST", { text: "/tool demo__whoami {}" });
		let said = "";
		for (let i = 0; i < 300 && !said.includes("Fatto."); i++) {
			said = JSON.stringify((await api(`/api/instances/owni/threads/${thread.id}`)).entries ?? []);
			await new Promise((r) => setTimeout(r, 30));
		}
		expect(said).toContain("Fatto. token:at-1");
		// The same code and state cannot be used twice.
		expect((await api("/api/connectors/oauth/finish", "POST", back)).status).toBe(400);
		const saved = JSON.parse((await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))) as string);
		expect(saved.tokens.access_token).toBe("at-1");
		expect(saved.verifier).toBeUndefined();
		// The audit names the connector, never a token or a code.
		const audit = JSON.stringify(await owni.runtime.audit("default").read());
		expect(audit).not.toContain("at-1");
		expect(audit).not.toContain(back.code);
	});

	it("refreshes an expired token by itself; when the refresh is refused, asks the owner to sign in again", async () => {
		const f = await fake();
		const { owni, base, api } = await boot([entry(f)]);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, started.url));
		// The service forgets the access token: the next connection refreshes it.
		f.valid.clear();
		await owni.runtime.reopen("default", "owni");
		expect((await api("/api/instances/owni/connectors")).connectors[0].status).toMatchObject({ connected: true });
		expect(JSON.parse((await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))) as string).tokens.access_token).toBe("at-2");
		// Now the refresh token is revoked too.
		f.valid.clear();
		f.refreshable.clear();
		await owni.runtime.reopen("default", "owni");
		const status = (await api("/api/instances/owni/connectors")).connectors[0].status;
		expect(status).toMatchObject({ connected: false, signIn: true });
		expect(status.error).toContain("Collega");
		// «Collega» starts a new sign-in, with the client already registered.
		const again = await api("/api/instances/owni/connectors/demo/sign-in", "POST", {});
		expect(again.url).toContain(`${f.base}/authorize`);
		expect(f.registrations).toBe(1);
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, again.url));
		expect((await api("/api/instances/owni/connectors")).connectors[0].status).toMatchObject({ connected: true });
	});

	it("removing the connector drops its sign-in; adding it twice is refused", async () => {
		const f = await fake();
		const { owni, base, api } = await boot([entry(f)]);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		expect((await api("/api/instances/owni/connectors/catalog/demo", "POST", {})).status).toBe(409);
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, started.url));
		await api("/api/instances/owni/connectors/demo", "DELETE");
		expect(await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))).toBeUndefined();
		const record = await owni.runtime.registry.getInstance("default", "owni");
		expect(record.egress.connectors ?? []).not.toContain("mcp:demo");
	});

	it("a service that does not register apps by itself is explained, and nothing is left behind", async () => {
		const f = await fake();
		f.registration = false;
		const { owni, api } = await boot([entry(f)]);
		const res = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		expect(res.status).toBe(502);
		expect(res.error).toContain("non accetta nuove applicazioni");
		expect((await api("/api/instances/owni/connectors")).connectors).toEqual([]);
		expect(await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))).toBeUndefined();
		expect((await owni.runtime.registry.getInstance("default", "owni")).egress.connectors ?? []).not.toContain("mcp:demo");
	});

	it("cancelling on the service's page drops the sign-in and names the connector's instance; a state is finished only by who started it", async () => {
		const f = await fake();
		const { base, api } = await boot([entry(f)]);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		const state = new URL(started.url).searchParams.get("state") as string;
		const back = await fetch(`${base}/oauth/mcp/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual" });
		expect(back.headers.get("location")).toContain("error=access_denied");
		expect(await api("/api/connectors/oauth/finish", "POST", { state, error: "access_denied" })).toMatchObject({ status: 200, instanceId: "owni", connectorId: "demo", cancelled: true });
		expect((await api("/api/connectors/oauth/finish", "POST", { state, code: "x" })).status).toBe(400);
		// Another owner cannot finish this owner's sign-in.
		const again = await api("/api/instances/owni/connectors/demo/sign-in", "POST", {});
		const other = await api("/api/people", "POST", { name: "Socio", role: "owner" });
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: other.link.split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const theirs = await fetch(`${base}/api/connectors/oauth/finish`, { method: "POST", headers: { cookie, "x-owni": "1" }, body: JSON.stringify(await signInAt(f, base, again.url)) });
		expect(theirs.status).toBe(400);
	});

	it("a second sign-in replaces one left halfway; a refused code keeps the tokens that work", async () => {
		const f = await fake();
		const { owni, base, api } = await boot([entry(f)]);
		const first = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, first.url));
		f.valid.clear();
		f.refreshable.clear();
		await owni.runtime.reopen("default", "owni");
		const a = await api("/api/instances/owni/connectors/demo/sign-in", "POST", {});
		const b = await api("/api/instances/owni/connectors/demo/sign-in", "POST", {});
		const fromA = await signInAt(f, base, a.url);
		expect((await api("/api/connectors/oauth/finish", "POST", fromA)).status).toBe(400);
		const fromB = await signInAt(f, base, b.url);
		expect(await api("/api/connectors/oauth/finish", "POST", fromB)).toMatchObject({ connectorId: "demo", status: { connected: true } });
		const working = JSON.parse((await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))) as string).tokens;
		// While it works, «Collega» says so without a new sign-in.
		f.refreshable.add(working.refresh_token);
		expect(await api("/api/instances/owni/connectors/demo/sign-in", "POST", {})).toMatchObject({ status: { connected: true } });
		// A code the service refuses (forged, or used already) does not drop what works.
		f.valid.clear();
		f.refreshable.clear();
		const d = await api("/api/instances/owni/connectors/demo/sign-in", "POST", {});
		const before = await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"));
		expect((await api("/api/connectors/oauth/finish", "POST", { state: new URL(d.url).searchParams.get("state"), code: "forged" })).status).toBe(400);
		expect(JSON.parse((await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))) as string).tokens).toEqual(JSON.parse(before as string).tokens);
	});

	it("pointing the connector at another address drops its tokens; a turned-off connector does not sign in", async () => {
		const f = await fake();
		const g = await fake();
		const { owni, base, api } = await boot([entry(f)]);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		await api("/api/connectors/oauth/finish", "POST", await signInAt(f, base, started.url));
		await api("/api/instances/owni/connectors/demo", "PUT", { name: "Demo", transport: { type: "http", url: g.url, auth: "oauth", headerSecrets: { authorization: "connector.demo.x" } }, enabled: true });
		expect(await owni.runtime.secrets("default").get(mcpOAuthSecret("owni", "demo"))).toBeUndefined();
		const listed = (await api("/api/instances/owni/connectors")).connectors[0];
		expect(listed.transport.headerSecrets).toBeUndefined();
		expect(listed.status).toMatchObject({ connected: false, signIn: true });
		await api("/api/instances/owni/connectors/demo", "PUT", { name: "Demo", transport: { type: "http", url: g.url, auth: "oauth" }, enabled: false });
		expect((await api("/api/instances/owni/connectors/demo/sign-in", "POST", {})).status).toBe(400);
	});

	it("without a public address, the service sends the owner back to the address of the login link", async () => {
		const f = await fake();
		const { owni, base, api } = await boot([entry(f)], {});
		expect(owni.ownerLink).toMatch(/^http:\/\/127\.0\.0\.1:/);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		const port = new URL(owni.ownerLink as string).port;
		await signInAt(f, base, started.url, `http://127.0.0.1:${port}/oauth/mcp/callback`);
	});

	it("tells the model why a connector that needs a sign-in is missing", async () => {
		const f = await fake();
		const { owni, api } = await boot([entry(f)]);
		const started = await api("/api/instances/owni/connectors/catalog/demo", "POST", {});
		expect(started.url).toBeDefined();
		await owni.runtime.reopen("default", "owni");
		const thread = (await api("/api/instances/owni/dm", "POST", {})).thread;
		await api(`/api/instances/owni/threads/${thread.id}/messages`, "POST", { text: "/tool demo__non_collegato {}" });
		let said = "";
		for (let i = 0; i < 300 && !said.includes("Fatto."); i++) {
			said = JSON.stringify((await api(`/api/instances/owni/threads/${thread.id}`)).entries ?? []);
			await new Promise((r) => setTimeout(r, 30));
		}
		expect(said).toContain("premi «Collega»".replace("premi", "preme"));
	});
});

describe("one-click connectors with a token or nothing", () => {
	it("a token is kept per instance as the Authorization header, changed in place, and removed with the connector", async () => {
		const f = await fake();
		f.valid.add("pat-12345");
		f.valid.add("pat-67890");
		const { owni, api } = await boot([entry(f, { id: "gh", name: "GitHub", auth: "token", tokenHelp: "Da GitHub." })]);
		expect((await api("/api/instances/owni/connectors/catalog/gh", "POST", { token: " " })).status).toBe(400);
		expect((await api("/api/instances/owni/connectors/catalog/gh", "POST", { token: "pat 12345" })).status).toBe(400);
		const added = await api("/api/instances/owni/connectors/catalog/gh", "POST", { token: "Bearer pat-12345" });
		expect(added.status).toMatchObject({ connected: true, tools: ["gh__add", "gh__whoami"] });
		expect(await owni.runtime.secrets("default").get("connector.gh.owni.authorization")).toBe("Bearer pat-12345");
		// Another instance with GitHub keeps its own token.
		await api("/api/instances", "POST", { id: "vendite", name: "Vendite" });
		await api("/api/instances/vendite/connectors/catalog/gh", "POST", { token: "pat-67890" });
		expect(await owni.runtime.secrets("default").get("connector.gh.owni.authorization")).toBe("Bearer pat-12345");
		// A token the service refuses is said plainly, and «Cambia token» fixes it.
		f.valid.delete("pat-12345");
		await owni.runtime.reopen("default", "owni");
		const refused = (await api("/api/instances/owni/connectors")).connectors[0].status;
		expect(refused).toMatchObject({ connected: false, badToken: true });
		expect(refused.error).toContain("token non valido");
		expect((await api("/api/instances/owni/connectors/catalog/gh", "POST", { token: "pat-67890" })).status).toBe(409);
		const changed = await api("/api/instances/owni/connectors/catalog/gh", "POST", { token: "pat-67890", replace: true });
		expect(changed.status).toMatchObject({ connected: true });
		await api("/api/instances/owni/connectors/gh", "DELETE");
		expect(await owni.runtime.secrets("default").get("connector.gh.owni.authorization")).toBeUndefined();
		expect(await owni.runtime.secrets("default").get("connector.gh.vendite.authorization")).toBe("Bearer pat-67890");
		const audit = JSON.stringify(await owni.runtime.audit("default").read());
		expect(audit).toContain("connector.removed");
		expect(audit).not.toContain("pat-");
	});

	it("a public server connects at once; only the owner sees the catalog", async () => {
		const f = await fake();
		f.valid.add("");
		const { owni, base, api } = await boot([entry(f, { id: "docs", auth: "none" })]);
		const added = await api("/api/instances/owni/connectors/catalog/docs", "POST", {});
		expect(added.status).toMatchObject({ connected: true });
		expect((await api("/api/instances/owni/connectors/catalog/nope", "POST", {})).status).toBe(404);
		const person = await api("/api/people", "POST", { name: "Giulia" });
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: person.link.split("#")[1] }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		expect((await fetch(`${base}/api/connector-catalog`, { headers: { cookie } })).status).toBe(403);
		expect(owni).toBeDefined();
	});
});

describe("the sign-in's own requests", () => {
	it("go only to https and public addresses, checked where the socket connects, never following a redirect", async () => {
		const guarded = signInFetch();
		await expect(guarded("http://example.com/token")).rejects.toBeInstanceOf(McpOAuthError);
		await expect(guarded("https://127.0.0.1/token")).rejects.toThrow(/interno/);
		await expect(guarded("https://[::ffff:10.0.0.1]/token")).rejects.toThrow(/interno/);
		await expect(guarded("https://169.254.169.254/latest")).rejects.toThrow(/interno/);
		await expect(guarded("https://u:p@93.184.216.34/token")).rejects.toBeInstanceOf(McpOAuthError);
		// A name that resolves to this machine is refused when connecting, not only when named.
		await expect(guarded("https://localhost/token")).rejects.toThrow(/interno/);
		// Over the loopback (tests), a redirect comes back as it is: it is not followed.
		const mover = createServer((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/" }).end());
		await new Promise<void>((r) => mover.listen(0, "127.0.0.1", r));
		const loop = signInFetch({ addressAllowed: () => true, allowHttp: true });
		const moved = await loop(`http://127.0.0.1:${(mover.address() as AddressInfo).port}/moved`);
		mover.close();
		expect(moved.status).toBe(302);
		expect(publicAddress("93.184.216.34")).toBe(true);
	});
});
