import { assertConnectorAllowed, type EgressPolicy } from "../core/policy.ts";
import { EgressDenied } from "../core/errors.ts";

/** An HTTP error from a connector's API. Never carries tokens or request URLs with secrets. */
export class ConnectorHttpError extends Error {
	override readonly name = "ConnectorHttpError";
	constructor(
		readonly connector: string,
		readonly operation: string,
		readonly status: number,
		readonly detail: string,
	) {
		super(`${connector} ${operation} failed: HTTP ${status}${detail === "" ? "" : ` ${detail}`}`);
	}

	/** Worth retrying later: rate limits and server errors. */
	get transient(): boolean {
		return this.status === 429 || this.status >= 500 || /rateLimitExceeded/i.test(this.detail);
	}
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A fetch that only reaches `hosts`, and only if the instance's egress policy lists
 * `connector`. The policy is checked on every request: it is the last word.
 */
export function egressFetch(
	connector: string,
	hosts: readonly string[],
	policy: () => EgressPolicy | Promise<EgressPolicy>,
	base: typeof fetch = fetch,
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		assertConnectorAllowed(await policy(), connector);
		const url = new URL(input instanceof Request ? input.url : String(input));
		// Plain http only to this machine (a local MCP server); everything else is https.
		const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
		if (!secure || !hosts.includes(url.hostname)) throw new EgressDenied("connector", `${connector}@${url.hostname}`);
		// A redirect would reach a host that was never checked.
		return base(input, { ...init, redirect: "error" });
	}) as typeof fetch;
}

export type JsonRequest = {
	readonly connector: string;
	readonly operation: string;
	readonly method?: "GET" | "POST" | "PATCH";
	readonly headers?: Record<string, string>;
	readonly body?: unknown;
	/** Extra attempts on transient errors. Only for requests that are safe to repeat. */
	readonly retries?: number;
	readonly retryBaseMs?: number;
};

/** One JSON request with bounded retries on transient errors (exponential backoff with jitter). */
export async function requestJson<T>(fetchImpl: typeof fetch, url: string, request: JsonRequest): Promise<T> {
	const retries = request.retries ?? 0;
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetchImpl(url, {
				method: request.method ?? (request.body === undefined ? "GET" : "POST"),
				headers: { ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...request.headers },
				...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
			});
			if (!response.ok) throw new ConnectorHttpError(request.connector, request.operation, response.status, await errorDetail(response));
			if (response.status === 204) return undefined as T;
			return (await response.json()) as T;
		} catch (error) {
			if (!(error instanceof ConnectorHttpError) || !error.transient || attempt >= retries) throw error;
			const base = (request.retryBaseMs ?? 1000) * 2 ** attempt;
			await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base * 0.25));
		}
	}
}

/** A short, token-free summary of an error body (Google answers in JSON). */
async function errorDetail(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const body = JSON.parse(text) as { error?: string | { message?: string; status?: string; errors?: { reason?: string }[] }; error_description?: string; message?: string; category?: string; correlationId?: string };
		if (typeof body.error === "string") return [body.error, body.error_description].filter(Boolean).join(": ");
		if (body.error !== undefined) return [body.error.errors?.[0]?.reason ?? body.error.status, body.error.message].filter(Boolean).join(": ");
		return [body.category, body.message, body.correlationId === undefined ? undefined : `(correlationId ${body.correlationId})`].filter(Boolean).join(" ");
	} catch {
		return text.slice(0, 200);
	}
}
