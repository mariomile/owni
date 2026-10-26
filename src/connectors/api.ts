import { EgressDenied } from "../core/errors.ts";
import { ConnectorActionError, ConnectorActionUncertain, CONNECTOR_ACTION_LIMITS } from "../core/connector-actions.ts";
import type { OwniTool } from "../core/engine.ts";
import type { EgressPolicy } from "../core/policy.ts";
import { egressFetch } from "./http.ts";

/**
 * How an API collegamento sends its key (ADR 0116): as a bearer token, in a header the service
 * names, or as a parameter of the address. The key itself is a secret, never in the connector.
 */
export type ApiAuth = { readonly kind: "bearer" } | { readonly kind: "header"; readonly name: string } | { readonly kind: "query"; readonly name: string };

export type ApiTransport = {
	readonly type: "api";
	/** Every request goes under this address, to its host only. */
	readonly baseUrl: string;
	readonly auth?: ApiAuth;
	/** The secret store entry with the key; set by the server, never by the model. */
	readonly secret?: string;
	/** What the API can do, in the owner's words: given to the model with the tools. */
	readonly notes?: string;
};

export const API_LIMITS = {
	maxNotesChars: 2_000,
	maxPathChars: 500,
	maxQuery: 30,
	maxBodyChars: 20_000,
	maxResultChars: 100_000,
	timeoutMs: 30_000,
} as const;

export const API_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
export const API_QUERY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** Headers Owni sets itself, or that would change where or how the request goes. */
const RESERVED_HEADERS = new Set(["host", "content-type", "content-length", "accept", "transfer-encoding", "connection"]);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Why a transport is not one Owni can call, in Italian; undefined when it is. */
export function apiTransportProblem(t: ApiTransport): string | undefined {
	let url: URL;
	try {
		url = new URL(t.baseUrl);
	} catch {
		return "l'indirizzo base non è un indirizzo web";
	}
	if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) return "l'indirizzo base deve essere https";
	if (url.username !== "" || url.password !== "") return "l'indirizzo base non può contenere nome utente o password: usa la chiave";
	if (url.search !== "" || url.hash !== "") return "l'indirizzo base non può avere parametri: la chiave va nel campo apposito";
	if (t.auth?.kind === "header" && (!API_HEADER_NAME.test(t.auth.name) || RESERVED_HEADERS.has(t.auth.name.toLowerCase()))) return "nome dell'header non valido";
	if (t.auth?.kind === "query" && !API_QUERY_NAME.test(t.auth.name)) return "nome del parametro non valido";
	if ((t.notes ?? "").length > API_LIMITS.maxNotesChars) return `la nota supera ${API_LIMITS.maxNotesChars} caratteri`;
	return undefined;
}

/** A refusal of what the model asked: said back to it, nothing sent. */
export class ApiRequestRefused extends Error {
	override readonly name = "ApiRequestRefused";
}

type Query = Readonly<Record<string, unknown>>;

/**
 * The address of one request: `path` under the base, never out of it, and `query` as given.
 * The key's own parameter is not the model's to set.
 */
export function apiUrl(t: Pick<ApiTransport, "baseUrl" | "auth">, path: unknown, query: unknown): URL {
	if (path !== undefined && typeof path !== "string") throw new ApiRequestRefused("path deve essere testo");
	const p = (path ?? "").trim();
	if (p.length > API_LIMITS.maxPathChars) throw new ApiRequestRefused(`path oltre ${API_LIMITS.maxPathChars} caratteri`);
	// Only a path: no other host, no way up, no query or fragment smuggled in.
	if (/[\s\p{Cc}\\?#;]/u.test(p) || p.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(p)) throw new ApiRequestRefused("path deve essere un percorso relativo all'indirizzo base, senza parametri (vanno in query)");
	let decoded: string;
	try {
		decoded = decodeURIComponent(p);
	} catch {
		throw new ApiRequestRefused("path con caratteri codificati male");
	}
	// What some servers still read as a way up once decoded: a backslash, a ";" or a second encoding.
	if (/[\p{Cc}\\;%]/u.test(decoded) || decoded.split("/").some((segment) => segment === ".." || segment === ".")) throw new ApiRequestRefused("path non può risalire fuori dall'indirizzo base");
	const base = new URL(t.baseUrl);
	const root = base.pathname.replace(/\/+$/, "");
	const url = new URL(base.origin);
	url.pathname = p === "" || p === "/" ? base.pathname : `${root}/${p.replace(/^\/+/, "")}`;
	if (url.origin !== base.origin || !(url.pathname === base.pathname || url.pathname.startsWith(`${root}/`))) throw new ApiRequestRefused("path esce dall'indirizzo base");
	if (query !== undefined && query !== null) {
		if (typeof query !== "object" || Array.isArray(query)) throw new ApiRequestRefused("query deve essere un oggetto nome → valore");
		const entries = Object.entries(query as Query);
		if (entries.length > API_LIMITS.maxQuery) throw new ApiRequestRefused(`al massimo ${API_LIMITS.maxQuery} parametri in query`);
		for (const [name, value] of entries) {
			if (t.auth?.kind === "query" && name.toLowerCase() === t.auth.name.toLowerCase()) throw new ApiRequestRefused(`il parametro ${name} lo mette Owni: non va in query`);
			for (const item of Array.isArray(value) ? value : [value]) {
				if (!["string", "number", "boolean"].includes(typeof item)) throw new ApiRequestRefused(`query.${name}: solo testo, numeri, sì/no o elenchi di questi`);
				url.searchParams.append(name, String(item));
			}
		}
	}
	return url;
}

export type ApiCall = { readonly method: "GET" | (typeof WRITE_METHODS)[number]; readonly path?: string; readonly query?: Query; readonly body?: unknown };

export type ApiResponse = { readonly status: number; readonly ok: boolean; readonly text: string };

export type ApiCaller = {
	/** Sends one request. Throws ApiRequestRefused before sending, EgressDenied when the policy says no. */
	send(call: ApiCall, signal?: AbortSignal): Promise<ApiResponse>;
};

/**
 * Sends requests of one collegamento: to its host only, under the agente's egress policy, with
 * its key added here and removed from anything that comes back.
 */
export function apiCaller(connector: { readonly id: string; readonly transport: ApiTransport }, egressName: string, key: string | undefined, policy: () => Promise<EgressPolicy>, base?: typeof fetch): ApiCaller {
	const t = connector.transport;
	const host = new URL(t.baseUrl).hostname;
	const fetchFn = egressFetch(egressName, [host], policy, base);
	// The key as it was sent, and as a service may write it back: encoded in an address or inside JSON.
	const forms = key !== undefined && key.length >= 4 ? [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2), JSON.stringify(key).slice(1, -1)])] : [];
	const hide = (text: string) => forms.reduce((out, form) => out.split(form).join("[chiave]"), text);
	return {
		async send(call, signal) {
			const url = apiUrl(t, call.path, call.query);
			const headers: Record<string, string> = { accept: "application/json, text/*;q=0.9, */*;q=0.1" };
			let body: string | undefined;
			if (call.body !== undefined && call.body !== null) {
				if (call.method === "GET") throw new ApiRequestRefused("una lettura non ha corpo");
				body = typeof call.body === "string" ? call.body : JSON.stringify(call.body);
				if (body.length > API_LIMITS.maxBodyChars) throw new ApiRequestRefused(`corpo oltre ${API_LIMITS.maxBodyChars} caratteri`);
				headers["content-type"] = typeof call.body === "string" ? "text/plain; charset=utf-8" : "application/json";
			}
			if (t.auth !== undefined) {
				if (key === undefined) throw new ApiRequestRefused("manca la chiave: l'owner la mette nei Servizi dell'agente");
				if (t.auth.kind === "bearer") headers.authorization = `Bearer ${key}`;
				else if (t.auth.kind === "header") headers[t.auth.name.toLowerCase()] = key;
				else url.searchParams.set(t.auth.name, key);
			}
			const timeout = AbortSignal.timeout(API_LIMITS.timeoutMs);
			const response = await fetchFn(url, { method: call.method, headers, ...(body === undefined ? {} : { body }), signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
			return { status: response.status, ok: response.ok, text: await responseText(response, hide) };
		},
	};
}

/** The body as the model reads it: text and JSON as they are (pretty JSON), anything else described; the key hidden before anything is cut. */
async function responseText(response: Response, hide: (text: string) => string): Promise<string> {
	const type = (response.headers.get("content-type") ?? "").toLowerCase();
	const textual = type === "" || type.startsWith("text/") || /json|xml|javascript|x-www-form-urlencoded/.test(type);
	if (!textual) {
		const size = (await response.arrayBuffer()).byteLength;
		return `[contenuto non testuale: ${type.split(";")[0]}, ${size} byte]`;
	}
	let text = hide(await response.text());
	if (type.includes("json")) {
		try {
			// Parsing undoes escapes like \u0041: hidden again once written back.
			text = hide(JSON.stringify(JSON.parse(text), null, 1));
		} catch {}
	}
	return text.length > API_LIMITS.maxResultChars ? `${text.slice(0, API_LIMITS.maxResultChars)}\n[... troncato]` : text;
}

/** Why a request did not go, in words for the model; the address (which may carry the key) is never said. */
function failure(name: string, host: string, error: unknown): string {
	if (error instanceof ApiRequestRefused) return `Errore: ${error.message}. Niente è stato mandato a ${name}.`;
	if (error instanceof EgressDenied) return `Errore: ${name} non è consentito per questo agente ora. Niente è stato mandato.`;
	if (error instanceof Error && error.name === "TimeoutError") return `Errore: ${name} (${host}) non ha risposto entro ${API_LIMITS.timeoutMs / 1000} secondi.`;
	return `Errore: la richiesta a ${name} (${host}) non è riuscita.`;
}

/** The response as the model gets it: the status first, a hint on a refused key. */
function said(name: string, response: ApiResponse): string {
	if (response.ok) return `HTTP ${response.status}\n${response.text}`;
	const key = response.status === 401 || response.status === 403 ? ` ${name} rifiuta l'accesso: la chiave può essere sbagliata, scaduta o senza i permessi. Dillo alla persona: l'owner la cambia nei Servizi dell'agente.` : "";
	return `Errore da ${name}: HTTP ${response.status}.${key}\n${response.text.slice(0, 4_000)}`;
}

const QUERY_SCHEMA = { type: "object", description: "Address parameters, name → value (text, number, boolean, or a list of these)", additionalProperties: true };

export type ApiToolsOptions = {
	readonly connector: { readonly id: string; readonly name: string; readonly approval?: "writes" | "none"; readonly transport: ApiTransport };
	readonly caller: ApiCaller;
	readonly toolName: (tool: string) => string;
	/** A write that waits for a person; without it writes are refused. */
	readonly propose?: (input: { tool: string; toolTitle: string; args: Record<string, unknown>; reason: string; destructive: boolean }, ctx: Parameters<OwniTool["execute"]>[1]) => Promise<string>;
};

/** The two tools of a collegamento API: read (GET, at once) and write (waits for approval unless the owner turned it off). */
export function apiTools({ connector, caller, toolName, propose }: ApiToolsOptions): OwniTool[] {
	const t = connector.transport;
	const host = new URL(t.baseUrl).hostname;
	const about = `[${connector.name}] HTTP API at ${t.baseUrl}.${t.notes ? ` What the owner says about it: ${t.notes}` : ""} Owni adds the key: never ask for it, never put it in path, query or body.`;
	const asks = (connector.approval ?? "writes") === "writes";
	const read: OwniTool = {
		name: toolName("read"),
		description: `${about} Read: one GET request; returns the HTTP status and the body.`,
		parameters: {
			type: "object",
			properties: { path: { type: "string", maxLength: API_LIMITS.maxPathChars, description: `Path under ${t.baseUrl}, e.g. "/customers/42". No host, no "?"` }, query: QUERY_SCHEMA },
			additionalProperties: false,
		},
		replaySafe: true,
		execute: async (args, ctx) => {
			try {
				return said(connector.name, await caller.send({ method: "GET", path: args.path as string | undefined, query: args.query as Query | undefined }, ctx.signal));
			} catch (error) {
				return failure(connector.name, host, error);
			}
		},
	};
	const writeProperties = {
		method: { type: "string", enum: [...WRITE_METHODS] },
		path: { type: "string", maxLength: API_LIMITS.maxPathChars, description: `Path under ${t.baseUrl}. No host, no "?"` },
		query: QUERY_SCHEMA,
		body: { description: "JSON body (object or array); a string is sent as plain text" },
	};
	const write: OwniTool = asks
		? {
				name: toolName("write"),
				description: `${about} Write: one POST, PUT, PATCH or DELETE request. Needs a person's approval: nothing happens until they approve this exact call; you get the outcome later in this conversation. Only when the person you are talking to asked for it. Put in owni_reason one sentence for the approver.`,
				parameters: {
					type: "object",
					properties: { ...writeProperties, owni_reason: { type: "string", minLength: 3, maxLength: 300, description: "For the person approving: what this does and for whom, in Italian, plain words, no tool names" } },
					required: ["method", "path", "owni_reason"],
					additionalProperties: false,
				},
				replaySafe: true,
				execute: async (args, ctx) => {
					if (propose === undefined) return `Errore: ${connector.name} chiede l'approvazione per scrivere, ma qui non si può approvare.`;
					const call = writeCall(args);
					if (typeof call === "string") return call;
					// Checked now, so a person never approves a request that cannot go.
					try {
						apiUrl(t, call.path, call.query);
						if (call.body !== undefined && JSON.stringify(call.body).length > API_LIMITS.maxBodyChars) throw new ApiRequestRefused(`corpo oltre ${API_LIMITS.maxBodyChars} caratteri`);
					} catch (error) {
						return failure(connector.name, host, error);
					}
					const reason = typeof args.owni_reason === "string" && args.owni_reason.trim() !== "" ? args.owni_reason.trim() : `${call.method} su ${connector.name}`;
					return ctx.step("propose", () => propose({ tool: "write", toolTitle: `${call.method} ${call.path}`, args: { ...call }, reason, destructive: call.method === "DELETE" }, ctx));
				},
			}
		: {
				name: toolName("write"),
				description: `${about} Write: one POST, PUT, PATCH or DELETE request, sent at once (the owner turned approval off for this API). Only when the person you are talking to asked for it.`,
				parameters: { type: "object", properties: writeProperties, required: ["method", "path"], additionalProperties: false },
				// A write that may have reached the service is never sent twice.
				replaySafe: false,
				execute: async (args, ctx) => {
					const call = writeCall(args);
					if (typeof call === "string") return call;
					try {
						return said(connector.name, await caller.send(call, ctx.signal));
					} catch (error) {
						return failure(connector.name, host, error);
					}
				},
			};
	return [read, write];
}

/** The model's write arguments as a call, or what is wrong with them. */
function writeCall(args: Record<string, unknown>): ApiCall | string {
	const method = String(args.method ?? "").toUpperCase();
	if (!(WRITE_METHODS as readonly string[]).includes(method)) return `Errore: method deve essere ${WRITE_METHODS.join(", ")}.`;
	if (typeof args.path !== "string") return "Errore: manca path.";
	return { method: method as ApiCall["method"], path: args.path, ...(args.query === undefined ? {} : { query: args.query as Query }), ...(args.body === undefined ? {} : { body: args.body }) };
}

/**
 * Runs an approved write (ADR 0025): refused before it leaves means not done; once it has left,
 * a missing answer is an unknown outcome.
 */
export async function sendApproved(name: string, caller: ApiCaller, args: Readonly<Record<string, unknown>>): Promise<{ text: string; isError: boolean }> {
	const call = writeCall({ ...args });
	if (typeof call === "string") throw new ConnectorActionError(call.replace(/^Errore: /, ""));
	let response: ApiResponse;
	try {
		response = await caller.send(call);
	} catch (error) {
		if (error instanceof ApiRequestRefused) throw new ConnectorActionError(error.message);
		if (error instanceof EgressDenied || (error instanceof Error && error.cause instanceof EgressDenied)) throw new ConnectorActionError(`${name} non è più consentito per questo agente`);
		throw new ConnectorActionUncertain(`la richiesta a ${name} è partita ma la risposta non è arrivata`);
	}
	return { text: said(name, response).slice(0, CONNECTOR_ACTION_LIMITS.maxResultChars), isError: !response.ok };
}
