import { randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TenantSecrets } from "../core/secrets.ts";
import { SerialQueue } from "../core/serial-queue.ts";
import { publicAddress } from "../core/web-fetch.ts";

/**
 * Signing in to an MCP server with OAuth (ADR 0024): the MCP authorization flow, with Owni as
 * the client. The owner presses «Collega», signs in on the service's page, and comes back to the
 * console; the tokens stay on the server, in the tenant's secret store, and refresh by themselves.
 */

/** What one connector's sign-in keeps, as one secret: the client registered, the tokens, the servers found. */
type Saved = {
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	discovery?: OAuthDiscoveryState;
};

/** The secret holding a connector's sign-in. Per instance: two instances with the same connector sign in apart. */
export function mcpOAuthSecret(instanceId: string, connectorId: string): string {
	return `mcp-oauth.${instanceId}.${connectorId}`;
}

/** The connector has no valid sign-in: the owner has to press «Collega». */
export class McpSignInNeeded extends Error {
	override readonly name = "McpSignInNeeded";
	constructor() {
		super("serve l'accesso al servizio: premi «Collega»");
	}
}

/** Why a sign-in did not go through, in words for the owner: never a token or a code. */
export class McpOAuthError extends Error {
	override readonly name = "McpOAuthError";
}

/**
 * Writes to one secret, one at a time across every provider of the process: a background refresh
 * and a sign-in started meanwhile never lose each other's change.
 */
const writes = new SerialQueue();

type ProviderOptions = {
	readonly state?: string;
	/** While the owner signs in: the page to send them to is captured; in the background a sign-in never starts. */
	readonly interactive: boolean;
	/** The PKCE verifier of this sign-in, kept with its state (not with the connector: two sign-ins never share one). */
	readonly verifier?: { value?: string };
	/** Finishing a sign-in: a refused code never drops the tokens that still work. */
	readonly keepTokens?: boolean;
};

/** The SDK's view of one connector's sign-in, kept in the secret store. */
export class StoredOAuthProvider implements OAuthClientProvider {
	/** The service's sign-in page, once the SDK asks to go there. */
	authorizationUrl: URL | undefined;

	constructor(
		private readonly secrets: TenantSecrets,
		private readonly secret: string,
		readonly redirectUrl: string,
		private readonly options: ProviderOptions,
	) {}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Owni",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		return this.options.state ?? "";
	}

	async clientInformation() {
		const client = (await this.load()).client;
		// A client registered for another return address (OWNI_PUBLIC_URL changed) would be sent back elsewhere: register again.
		const uris = (client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
		if (Array.isArray(uris) && !uris.includes(this.redirectUrl)) return undefined;
		return client;
	}
	async saveClientInformation(client: OAuthClientInformationMixed) {
		await this.change((s) => ({ ...s, client }));
	}
	async tokens() {
		return (await this.load()).tokens;
	}
	async saveTokens(tokens: OAuthTokens) {
		await this.change((s) => ({ ...s, tokens }));
	}
	async redirectToAuthorization(url: URL) {
		if (!this.options.interactive) throw new McpSignInNeeded();
		this.authorizationUrl = url;
	}
	async saveCodeVerifier(verifier: string) {
		if (this.options.verifier !== undefined) this.options.verifier.value = verifier;
	}
	async codeVerifier() {
		const verifier = this.options.verifier?.value;
		if (verifier === undefined) throw new McpOAuthError("collegamento scaduto: premi di nuovo «Collega»");
		return verifier;
	}
	async discoveryState() {
		return (await this.load()).discovery;
	}
	async saveDiscoveryState(discovery: OAuthDiscoveryState) {
		await this.change((s) => ({ ...s, discovery }));
	}
	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
		if (scope === "verifier") {
			if (this.options.verifier !== undefined) this.options.verifier.value = undefined;
			return;
		}
		await this.change((s) => {
			const { client, tokens, discovery } = s;
			const keep = this.options.keepTokens === true && tokens !== undefined ? { tokens } : {};
			if (scope === "all") return keep;
			if (scope === "client") return { tokens, discovery };
			if (scope === "tokens") return { client, discovery, ...keep };
			return { client, tokens };
		});
	}

	/** The hosts a refresh talks to besides the MCP server: the authorization server and its token endpoint. */
	async authHosts(): Promise<string[]> {
		const discovery = (await this.load()).discovery;
		const urls = [discovery?.authorizationServerUrl, discovery?.authorizationServerMetadata?.token_endpoint];
		return [...new Set(urls.filter((u): u is string => typeof u === "string").map((u) => new URL(u).hostname))];
	}

	private async load(): Promise<Saved> {
		const raw = await this.secrets.get(this.secret);
		if (raw === undefined) return {};
		try {
			return JSON.parse(raw) as Saved;
		} catch {
			return {};
		}
	}

	private change(next: (saved: Saved) => Saved): Promise<void> {
		return writes.run(`${this.secrets.tenantId}/${this.secret}`, async () => {
			const value = next(await this.load());
			if (Object.keys(value).length === 0) await this.secrets.delete(this.secret);
			else await this.secrets.set(this.secret, JSON.stringify(value));
		});
	}
}

export type SignInFetchOptions = {
	/** Which addresses may be reached: public ones (tests: the loopback). */
	readonly addressAllowed?: (address: string) => boolean;
	/** Plain http too (tests only). */
	readonly allowHttp?: boolean;
	readonly timeoutMs?: number;
};

/** Largest answer of an authorization server: metadata and tokens are small. */
const MAX_ANSWER = 512 * 1024;

/**
 * A fetch for the requests whose addresses come from the MCP server's metadata (discovery,
 * registration, tokens and their refresh): https only, to public addresses only, checked on the
 * address the socket connects to (no DNS rebinding), never following a redirect, in 15 seconds.
 */
export function signInFetch(options: SignInFetchOptions = {}): typeof fetch {
	const allowed = options.addressAllowed ?? publicAddress;
	const timeoutMs = options.timeoutMs ?? 15_000;
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.protocol !== "https:" && !(options.allowHttp === true && url.protocol === "http:")) throw new McpOAuthError(`il servizio usa un indirizzo non sicuro per l'accesso (${url.hostname})`);
		if (url.username !== "" || url.password !== "") throw new McpOAuthError("indirizzo di accesso non valido");
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (isIP(host) !== 0 && !allowed(host)) throw new McpOAuthError(`${host} è un indirizzo interno: niente accesso`);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
		const raw = init?.body;
		if (raw !== undefined && raw !== null && typeof raw !== "string" && !(raw instanceof URLSearchParams)) throw new McpOAuthError("richiesta di accesso non supportata");
		const body = raw === undefined || raw === null ? undefined : Buffer.from(String(raw));
		if (body !== undefined && raw instanceof URLSearchParams && headers["content-type"] === undefined) headers["content-type"] = "application/x-www-form-urlencoded";
		if (body !== undefined) headers["content-length"] = String(body.length);
		const lookup = (hostname: string, opts: object, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
			dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
				if (error) return callback(error, "");
				const list = addresses as LookupAddress[];
				if (list.length === 0 || list.some((a) => !allowed(a.address))) return callback(new McpOAuthError(`${hostname} è un indirizzo interno: niente accesso`), "");
				if ((opts as { all?: boolean }).all) return callback(null, list);
				callback(null, list[0]?.address ?? "", list[0]?.family);
			});
		};
		return new Promise<Response>((resolve, reject) => {
			const send = url.protocol === "https:" ? httpsRequest : httpRequest;
			const req = send(url, { method, headers, lookup, agent: false }, (res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_ANSWER) return req.destroy(new McpOAuthError("risposta del servizio troppo grande"));
					chunks.push(chunk);
				});
				res.on("end", () => {
					clearTimeout(deadline);
					const status = res.statusCode ?? 502;
					const out = new Headers();
					for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(", ") : value);
					const empty = status === 204 || status === 304;
					resolve(new Response(empty ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status, headers: out }));
				});
				res.on("error", reject);
			});
			const deadline = setTimeout(() => req.destroy(new McpOAuthError("il servizio non risponde")), timeoutMs);
			init?.signal?.addEventListener("abort", () => req.destroy(new McpOAuthError("richiesta interrotta")), { once: true });
			req.on("error", (error) => {
				clearTimeout(deadline);
				reject(error);
			});
			req.end(body);
		});
	}) as typeof fetch;
}

type Pending = { readonly instanceId: string; readonly connectorId: string; readonly personId: string; readonly serverUrl: string; readonly verifier: { value?: string }; readonly expiresAt: number };

export type McpOAuthOptions = {
	readonly tenantId: string;
	readonly secrets: TenantSecrets;
	/** Where the service sends the owner back: <console address>/oauth/mcp/callback. */
	readonly redirectUrl: string;
	/** The sign-in's own requests (tests: loopback over http). */
	readonly fetch?: SignInFetchOptions;
	readonly now?: () => number;
};

/** The sign-ins of one tenant: started by the owner, finished when the service sends them back. */
export class McpOAuth {
	private readonly pending = new Map<string, Pending>();
	/** For the sign-in and for the refreshes of the connections. */
	readonly fetch: typeof fetch;

	constructor(private readonly options: McpOAuthOptions) {
		this.fetch = signInFetch(options.fetch);
	}

	get redirectUrl(): string {
		return this.options.redirectUrl;
	}

	/** The provider a connection uses in the background: it refreshes tokens, never starts a sign-in. */
	provider(instanceId: string, connectorId: string): StoredOAuthProvider {
		return new StoredOAuthProvider(this.options.secrets, mcpOAuthSecret(instanceId, connectorId), this.options.redirectUrl, { interactive: false });
	}

	/**
	 * Starts a sign-in: the page to send the owner to, or `undefined` when the tokens kept still
	 * work (refreshed if needed). Tokens that no longer refresh are dropped and a sign-in starts.
	 */
	async start(personId: string, instanceId: string, connectorId: string, serverUrl: string): Promise<string | undefined> {
		this.prune();
		// A new «Collega» replaces one left halfway.
		for (const [s, p] of this.pending) if (p.instanceId === instanceId && p.connectorId === connectorId) this.pending.delete(s);
		const state = `${this.options.tenantId}~${randomBytes(18).toString("base64url")}`;
		const verifier: { value?: string } = {};
		const provider = new StoredOAuthProvider(this.options.secrets, mcpOAuthSecret(instanceId, connectorId), this.options.redirectUrl, { state, interactive: true, verifier });
		let result: Awaited<ReturnType<typeof auth>>;
		try {
			result = await auth(provider, { serverUrl, fetchFn: this.fetch });
		} catch (error) {
			throw oauthWords(error);
		}
		const page = provider.authorizationUrl;
		if (result === "AUTHORIZED" || page === undefined) return undefined;
		// The console opens this address: a service's own page, never another scheme.
		if (page.protocol !== "https:" && !(this.options.fetch?.allowHttp === true && page.protocol === "http:")) throw new McpOAuthError("il servizio indica una pagina di accesso non sicura");
		this.pending.set(state, { instanceId, connectorId, personId, serverUrl, verifier, expiresAt: this.now() + 10 * 60_000 });
		return page.toString();
	}

	/**
	 * Back from the service: the code becomes tokens. Only the person who started it finishes it.
	 * With `code` undefined (the owner cancelled), the sign-in is dropped. Says which connector it was.
	 */
	async finish(personId: string, state: string, code: string | undefined): Promise<{ instanceId: string; connectorId: string }> {
		this.prune();
		const pending = this.pending.get(state);
		if (pending === undefined || pending.personId !== personId) throw new McpOAuthError("collegamento scaduto o già usato: premi di nuovo «Collega»");
		this.pending.delete(state);
		const done = { instanceId: pending.instanceId, connectorId: pending.connectorId };
		if (code === undefined) return done;
		const provider = new StoredOAuthProvider(this.options.secrets, mcpOAuthSecret(pending.instanceId, pending.connectorId), this.options.redirectUrl, { state, interactive: true, verifier: pending.verifier, keepTokens: true });
		try {
			await auth(provider, { serverUrl: pending.serverUrl, authorizationCode: code, fetchFn: this.fetch });
		} catch (error) {
			throw oauthWords(error);
		}
		return done;
	}

	/** Drops a connector's sign-in (the connector removed, or pointed elsewhere). */
	/** Sign-ins left halfway by a deleted agente (ADR 0046) can no longer finish. */
	forgetInstance(instanceId: string): void {
		for (const [state, p] of this.pending) if (p.instanceId === instanceId) this.pending.delete(state);
	}

	async forget(instanceId: string, connectorId: string): Promise<void> {
		const secret = mcpOAuthSecret(instanceId, connectorId);
		await writes.run(`${this.options.secrets.tenantId}/${secret}`, () => this.options.secrets.delete(secret));
		for (const [state, p] of this.pending) if (p.instanceId === instanceId && p.connectorId === connectorId) this.pending.delete(state);
	}

	private prune(): void {
		const now = this.now();
		for (const [state, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(state);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

/**
 * An error of a sign-in or a refresh, in words for the owner: the SDK's messages and the
 * service's error descriptions can carry addresses, codes or tokens, so none of their text is kept.
 */
export function oauthWords(error: unknown): McpOAuthError {
	if (error instanceof McpOAuthError) return error;
	const name = error instanceof Error ? error.name : "";
	if (/InvalidClient|UnauthorizedClient/.test(name)) return new McpOAuthError("il servizio non riconosce Owni come applicazione: riprova più tardi");
	if (/InvalidGrant/.test(name)) return new McpOAuthError("il servizio ha rifiutato il codice di accesso: premi di nuovo «Collega»");
	if (/AccessDenied/.test(name)) return new McpOAuthError("accesso negato dal servizio");
	if (error instanceof Error && /does not support dynamic client registration/i.test(error.message))
		return new McpOAuthError("questo servizio non accetta nuove applicazioni da sola: per ora non si collega da qui");
	if (error instanceof OAuthError) return new McpOAuthError("il servizio non ha completato l'accesso: riprova più tardi");
	if (error instanceof TypeError || (error as NodeJS.ErrnoException)?.code !== undefined) return new McpOAuthError("il servizio non è raggiungibile da questo server");
	return new McpOAuthError("il servizio non ha completato l'accesso: riprova più tardi");
}
