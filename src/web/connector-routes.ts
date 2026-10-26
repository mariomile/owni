import { CONNECTOR_CATALOG } from "../connectors/catalog.ts";
import { apiTransportProblem } from "../connectors/api.ts";
import { type ConnectorStatus, CONNECTOR_ID, connectorEgressName, type McpConnector } from "../connectors/mcp.ts";
import { type McpOAuth, McpOAuthError } from "../connectors/mcp-oauth.ts";
import { withConnector } from "../core/policy.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type ConnectorRoutesDeps = Pick<WebAppOptions, "connectors" | "connectorStatus" | "cell" | "mcpOAuth" | "catalog"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
};

/** The owner's connectors of an instance (ADR 0024, 0116): saved by hand or from the catalog, signed in, removed with their secrets. */
export function connectorRoutes(route: AddRoute, options: ConnectorRoutesDeps): void {
	const { runtime, tenantId } = options;
	route("GET", "/api/instances/:id/connectors", "owner", async ({ params }) => {
		const list = await options.connectors(params[0]).list();
		const status = options.connectorStatus(params[0]);
		const record = await runtime.registry.getInstance(tenantId, params[0]);
		return { connectors: list.map((c) => ({ ...c, allowed: (record.egress.connectors ?? []).includes(connectorEgressName(c.id)), status: status.find((s) => s.id === c.id) })) };
	});
	route("PUT", "/api/instances/:id/connectors/:cid", "owner", async ({ params, req }) => {
		const instance = params[0];
		const body = (await readJson(req)) as Partial<McpConnector> & { allowed?: boolean };
		const id = params[1];
		if (!CONNECTOR_ID.test(id)) throw new HttpError(400, "ID: lettere minuscole, cifre e trattini");
		let transport = body.transport as McpConnector["transport"];
		if (transport?.type !== "http" && transport?.type !== "stdio" && transport?.type !== "api") throw new HttpError(400, "transport: http | stdio | api");
		// A cell runs no program of its customers: a command would run on Owni Cloud's machine.
		if (transport.type === "stdio" && options.cell !== undefined) throw new HttpError(400, "Su Owni Cloud i collegamenti sono a un indirizzo web, non a un programma locale");
		// With OAuth the sign-in is the only credential: a secret header would also reach the authorization server.
		if (transport.type === "http" && transport.auth === "oauth") transport = { type: "http", url: transport.url, auth: "oauth" };
		const store = options.connectors(instance);
		const before = (await store.list()).find((c) => c.id === id);
		// Headers saved for one host never go to another: on a new origin only the ones given in this save stay.
		if (transport.type === "http" && transport.headerSecrets !== undefined && before?.transport.type === "http" && URL.canParse(transport.url) && new URL(before.transport.url).origin !== new URL(transport.url).origin) {
			const saved = before.transport.headerSecrets ?? {};
			transport = { ...transport, headerSecrets: Object.fromEntries(Object.entries(transport.headerSecrets).filter(([header, secret]) => saved[header] !== secret)) };
		}
		// An API's key (ADR 0116): given here, kept by the server, never sent back. The connector names it.
		const keySecret = catalogTokenSecret(instance, id);
		let newKey: string | undefined;
		if (transport.type === "api") {
			const t = transport;
			const auth = t.auth?.kind === "bearer" ? { kind: "bearer" as const } : t.auth?.kind === "header" || t.auth?.kind === "query" ? { kind: t.auth.kind, name: String(t.auth.name ?? "").trim() } : undefined;
			const notes = typeof t.notes === "string" ? t.notes.trim() : "";
			transport = { type: "api", baseUrl: String(t.baseUrl ?? "").trim(), ...(auth === undefined ? {} : { auth }), ...(notes === "" ? {} : { notes }) };
			const problem = apiTransportProblem(transport);
			if (problem !== undefined) throw new HttpError(400, problem[0]?.toUpperCase() + problem.slice(1));
			const key = (body as { key?: unknown }).key;
			if (auth !== undefined && typeof key === "string" && key.trim() !== "") {
				newKey = key.trim().replace(auth?.kind === "bearer" ? /^Bearer\s+/i : /^$/, "");
				if (!/^[\x21-\x7e]{4,4096}$/.test(newKey)) throw new HttpError(400, "La chiave va incollata senza spazi né a capo");
			}
			const b = before?.transport;
			// A key given for one address never goes to another: a new host asks for the key again.
			const sameHost = b?.type === "api" && new URL(b.baseUrl).origin === new URL(transport.baseUrl).origin;
			const kept = b?.type === "api" && b.secret === keySecret && sameHost && newKey === undefined;
			// Without a way in there is no key: an old one is deleted below.
			if (auth !== undefined) {
				if (newKey !== undefined || kept) transport = { ...transport, secret: keySecret };
				else if (b?.type === "api" && b.secret !== undefined && !sameHost) throw new HttpError(400, "Il servizio ha un indirizzo nuovo: rimetti la chiave");
				else throw new HttpError(400, "Manca la chiave");
			}
		}
		const connector: McpConnector = { id, name: String(body.name ?? id), transport, enabled: body.enabled !== false, ...(body.approval === "writes" && transport.type !== "api" ? { approval: "writes" as const } : {}) };
		try {
			await store.save(connector);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		if (newKey !== undefined) {
			await runtime.secrets(tenantId).set(keySecret, newKey);
			await runtime.audit(tenantId).append({ type: "secret.set", instanceId: instance, name: keySecret });
		} else if (before?.transport.type === "api" && before.transport.secret !== undefined && (transport.type !== "api" || transport.secret === undefined)) {
			// An API's key with no API to go to (no way in, or now another kind of connector) is not kept for anything else.
			await runtime.secrets(tenantId).delete(before.transport.secret);
			await runtime.audit(tenantId).append({ type: "secret.deleted", instanceId: instance, name: before.transport.secret });
		}
		// Tokens got for one address never go to another: a new address or a new kind of access signs in again.
		const b = before?.transport;
		if (b?.type === "http" && b.auth === "oauth" && (transport.type !== "http" || transport.url !== b.url || transport.auth !== "oauth")) await options.mcpOAuth?.forget(instance, id);
		const allowed = body.allowed !== false;
		await runtime.registry.setEgress(tenantId, instance, (egress) => withConnector(egress, connectorEgressName(id), allowed));
		await runtime.audit(tenantId).append({ type: "connector.saved", instanceId: instance, connector: id, transport: connector.transport.type, allowed, approval: connector.approval ?? "risk" });
		await runtime.reopen(tenantId, instance);
		return { status: options.connectorStatus(instance).find((s) => s.id === id) };
	});
	// One click: a well-known server from the catalog, signed in with OAuth, a token, or nothing (ADR 0024).
	const catalog = options.catalog ?? CONNECTOR_CATALOG;
	route("GET", "/api/connector-catalog", "owner", async () => ({ catalog, oauth: options.mcpOAuth !== undefined, redirectUrl: options.mcpOAuth?.redirectUrl ?? null }));
	route("POST", "/api/instances/:id/connectors/catalog/:entry", "owner", async ({ params, req, person }) => {
		const instance = params[0];
		const entry = catalog.find((e) => e.id === params[1]);
		if (entry === undefined) throw new HttpError(404, "Connettore non in catalogo");
		await runtime.registry.getInstance(tenantId, instance);
		const body = (await readJson(req)) as { token?: unknown; replace?: unknown };
		const store = options.connectors(instance);
		const existing = (await store.list()).find((c) => c.id === entry.id);
		// «Cambia token» on a token connector already there; anything else added once.
		const replacing = body.replace === true && entry.auth === "token" && existing !== undefined;
		if (existing !== undefined && !replacing) throw new HttpError(409, `${entry.name} è già tra i connettori`);
		if (entry.auth === "oauth" && options.mcpOAuth === undefined) throw new HttpError(400, "L'accesso con l'account non è disponibile su questo server");
		const secret = catalogTokenSecret(instance, entry.id);
		let token: string | undefined;
		if (entry.auth === "token") {
			token = typeof body.token === "string" ? body.token.trim().replace(/^Bearer\s+/i, "") : "";
			if (!/^[\x21-\x7e]{8,4096}$/.test(token)) throw new HttpError(400, `Incolla il token di ${entry.name}, senza spazi`);
		}
		const connector: McpConnector = {
			id: entry.id,
			name: entry.name,
			transport: { type: "http", url: entry.url, ...(entry.auth === "token" ? { headerSecrets: { authorization: secret } } : {}), ...(entry.auth === "oauth" ? { auth: "oauth" as const } : {}) },
			enabled: true,
			// A payments service can move money: its writes always wait for a person (ADR 0120).
			...(entry.category === "pagamenti" ? { approval: "writes" as const } : {}),
		};
		const allow = async () => {
			await runtime.registry.setEgress(tenantId, instance, (egress) => withConnector(egress, connectorEgressName(entry.id), true));
		};
		if (entry.auth === "oauth") {
			// The sign-in starts before anything is saved: a service that refuses leaves nothing behind.
			let url: string | undefined;
			try {
				url = await (options.mcpOAuth as McpOAuth).start(person.id, instance, entry.id, entry.url);
			} catch (error) {
				await options.mcpOAuth?.forget(instance, entry.id);
				if (error instanceof McpOAuthError) throw new HttpError(502, `${entry.name}: ${error.message}`);
				throw error;
			}
			await store.save(connector);
			await allow();
			await runtime.audit(tenantId).append({ type: "connector.saved", instanceId: instance, connector: entry.id, transport: "http", allowed: true, catalog: true, approval: connector.approval ?? "risk" });
			if (url !== undefined) return { url };
			await runtime.reopen(tenantId, instance);
			return { status: options.connectorStatus(instance).find((s) => s.id === entry.id) };
		}
		if (token !== undefined) {
			await runtime.secrets(tenantId).set(secret, `Bearer ${token}`);
			await runtime.audit(tenantId).append({ type: "secret.set", instanceId: instance, name: secret });
		}
		if (!replacing) {
			await store.save(connector);
			await allow();
			await runtime.audit(tenantId).append({ type: "connector.saved", instanceId: instance, connector: entry.id, transport: "http", allowed: true, catalog: true, approval: connector.approval ?? "risk" });
		}
		await runtime.reopen(tenantId, instance);
		return { status: options.connectorStatus(instance).find((s) => s.id === entry.id) };
	});
	route("POST", "/api/instances/:id/connectors/:cid/sign-in", "owner", async ({ params, person }) => {
		const instance = params[0];
		const connector = (await options.connectors(instance).list()).find((c) => c.id === params[1]);
		if (connector === undefined) throw new HttpError(404, "Connettore non trovato");
		if (connector.transport.type !== "http" || connector.transport.auth !== "oauth") throw new HttpError(400, "Questo connettore non usa l'accesso con l'account");
		const record = await runtime.registry.getInstance(tenantId, instance);
		// A connector turned off or not allowed reaches nothing, not even to sign in.
		if (!connector.enabled || !(record.egress.connectors ?? []).includes(connectorEgressName(connector.id))) throw new HttpError(400, `${connector.name} è spento o non consentito: accendilo prima`);
		return signIn(person.id, instance, connector);
	});
	route("POST", "/api/connectors/oauth/finish", "owner", async ({ req, person }) => {
		const body = (await readJson(req)) as { state?: unknown; code?: unknown; error?: unknown };
		if (typeof body.state !== "string" || (typeof body.code !== "string" && typeof body.error !== "string")) throw new HttpError(400, "Collegamento incompleto: riprova");
		const oauth = options.mcpOAuth;
		if (oauth === undefined) throw new HttpError(400, "L'accesso con l'account non è disponibile su questo server");
		let done: { instanceId: string; connectorId: string };
		const cancelled = typeof body.code !== "string";
		try {
			done = await oauth.finish(person.id, body.state, cancelled ? undefined : (body.code as string));
		} catch (error) {
			if (error instanceof McpOAuthError) throw new HttpError(400, error.message);
			throw error;
		}
		if (cancelled) {
			await runtime.audit(tenantId).append({ type: "connector.sign_in_cancelled", instanceId: done.instanceId, connector: done.connectorId });
			return { ...done, cancelled: true };
		}
		await runtime.audit(tenantId).append({ type: "connector.authorized", instanceId: done.instanceId, connector: done.connectorId });
		await runtime.reopen(tenantId, done.instanceId);
		return { ...done, status: options.connectorStatus(done.instanceId).find((s) => s.id === done.connectorId) };
	});
	route("DELETE", "/api/instances/:id/connectors/:cid", "owner", async ({ params }) => {
		const instance = params[0];
		const id = params[1];
		const store = options.connectors(instance);
		const gone = (await store.list()).find((c) => c.id === id);
		const removed = await store.remove(id);
		await options.mcpOAuth?.forget(instance, id);
		// The connector's own secrets (its token, key or headers, ADR 0116) belong to it alone: they go with it.
		if (gone !== undefined) {
			const secrets = runtime.secrets(tenantId);
			for (const name of await secrets.names()) {
				if (!name.startsWith(connectorSecretPrefix(instance, id))) continue;
				await secrets.delete(name);
				await runtime.audit(tenantId).append({ type: "secret.deleted", instanceId: instance, name });
			}
		}
		await runtime.registry.setEgress(tenantId, instance, (egress) => withConnector(egress, connectorEgressName(id), false));
		if (removed) await runtime.audit(tenantId).append({ type: "connector.removed", instanceId: instance, connector: id });
		await runtime.reopen(tenantId, instance);
		return { removed };
	});
	route("PUT", "/api/instances/:id/secrets/:name", "owner", async ({ params, req }) => {
		const name = params[1];
		// Only this instance's own (ADR 0116): two agenti with a connector of the same ID never share a secret.
		const own = /^connector\.([a-z0-9-]{1,24})\.([^.]+)\.[a-zA-Z0-9_-]{1,40}$/.exec(name);
		if (own === null || own[2] !== params[0]) throw new HttpError(400, "Nome segreto: connector.<connettore>.<agente>.<nome>");
		const body = (await readJson(req)) as { value?: string };
		if (typeof body.value !== "string" || body.value === "") throw new HttpError(400, "Valore mancante");
		await runtime.secrets(tenantId).set(name, body.value);
		await runtime.audit(tenantId).append({ type: "secret.set", instanceId: params[0], name });
		return { ok: true };
	});

	/** Starts a connector's sign-in: the service's page to open, or the status when the tokens kept still work. */
	async function signIn(personId: string, instance: string, connector: McpConnector): Promise<{ url: string } | { status: ConnectorStatus | undefined }> {
		const oauth = options.mcpOAuth;
		if (oauth === undefined || connector.transport.type !== "http") throw new HttpError(400, "L'accesso con l'account non è disponibile su questo server");
		let url: string | undefined;
		try {
			url = await oauth.start(personId, instance, connector.id, connector.transport.url);
		} catch (error) {
			if (error instanceof McpOAuthError) throw new HttpError(502, `${connector.name}: ${error.message}`);
			throw error;
		}
		if (url !== undefined) return { url };
		await runtime.reopen(tenantId, instance);
		return { status: options.connectorStatus(instance).find((s) => s.id === connector.id) };
	}
}

/** The token a one-click connector or an API was given, per instance: two instances with GitHub keep their own. */
function catalogTokenSecret(instanceId: string, connectorId: string): string {
	return `connector.${connectorId}.${instanceId}.authorization`;
}

/** Where the secrets of one instance's connector start: they go with the connector (ADR 0116). */
function connectorSecretPrefix(instanceId: string, connectorId: string): string {
	return `connector.${connectorId}.${instanceId}.`;
}
