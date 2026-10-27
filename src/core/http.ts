/**
 * JSON or text from the operator's services (search, the VIES): one GET with a
 * timeout and a size cap, every failure handed to the caller to name in its own words. Never the
 * address or the key.
 */

/** redirect: a redirect the caller's rule refused, or one too many. */
export type HttpProblem = { readonly kind: "status"; readonly status: number } | { readonly kind: "unreachable" | "too_big" | "unreadable" | "redirect" };

/** Redirects followed here instead of by fetch: at most `max`, each target allowed by the caller before it is asked. */
export type RedirectRule = { readonly max: number; readonly allowed: (url: URL) => Promise<boolean> };

type GetInit = {
	readonly fetch: typeof fetch;
	readonly headers?: Record<string, string>;
	/** Larger bodies are refused unread. */
	readonly maxBytes: number;
	/** For the whole exchange, body included: 15 seconds unless a large file needs longer. */
	readonly timeoutMs?: number;
	/** "follow" (default): fetch follows redirects on its own. A rule: followed here, each hop checked (feeds that must not be sent inside the network). */
	readonly redirect?: "follow" | RedirectRule;
};

/** Thrown by `capped` only, turned into the caller's error by getText. */
class BodyTooLarge extends Error {}

/** The JSON object at `url`, or the caller's error for what went wrong. */
export async function getJson(url: URL, init: GetInit, error: (problem: HttpProblem) => Error): Promise<object> {
	const text = await getText(url, { ...init, headers: { accept: "application/json", ...init.headers } }, error);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw error({ kind: "unreadable" });
	}
	if (typeof body !== "object" || body === null) throw error({ kind: "unreadable" });
	return body;
}

/** The body at `url` as text, or the caller's error for what went wrong. */
export async function getText(url: URL, init: GetInit, error: (problem: HttpProblem) => Error): Promise<string> {
	const rule = init.redirect === undefined || init.redirect === "follow" ? undefined : init.redirect;
	// One timeout for the whole exchange, redirects included.
	const signal = AbortSignal.timeout(init.timeoutMs ?? 15_000);
	let response: Response;
	let target = url;
	for (let hop = 0; ; hop++) {
		try {
			response = await init.fetch(target, { headers: { ...init.headers }, signal, ...(rule === undefined ? {} : { redirect: "manual" as const }) });
		} catch {
			throw error({ kind: "unreachable" });
		}
		const location = rule !== undefined && response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
		if (rule === undefined || location === null) break;
		await response.body?.cancel().catch(() => {});
		let next: URL;
		try {
			next = new URL(location, target);
		} catch {
			throw error({ kind: "redirect" });
		}
		if (hop >= rule.max || !(await rule.allowed(next))) throw error({ kind: "redirect" });
		target = next;
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw error({ kind: "status", status: response.status });
	}
	try {
		return await capped(response, init.maxBytes);
	} catch (cause) {
		throw error({ kind: cause instanceof BodyTooLarge ? "too_big" : "unreachable" });
	}
}

/** The body as text, refused past `max` bytes. */
async function capped(response: Response, max: number): Promise<string> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Text without tags or entities a service may still put in. */
export function plain(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}
