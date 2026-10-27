// A fetch for console modules that keep their real api(): answers from `server`, and drops a request whose signal aborts, as a browser does.
import { vi } from "vitest";

/** `server(path, init)` returns a body (answered as JSON, 200), a Response, or throws for a network failure. */
export function fakeFetch(server: (path: string, init: RequestInit) => unknown) {
	return vi.fn((path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
		const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
		if (init.signal?.aborted) return abort();
		init.signal?.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => server(path, init))
			.then((body) => resolve(body instanceof Response ? body : json(body)), reject);
	}));
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });

/** A promise the test settles when it wants: an answer still on its way. */
export function deferred<T = unknown>() {
	let release!: (value: T) => void;
	let fail!: (error: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => { release = resolve; fail = reject; });
	return { promise, release, fail };
}
