import { COMPUTER_LIMITS, ComputerError, type ComputerProvider, type ComputerRun, type ComputerScreen, SCREEN_TIMEOUT_S, screenFromJson } from "../core/computer.ts";
import { computerToken } from "../web/compare.ts";

export type RemoteComputerOptions = {
	/** The control plane, as the cell reaches it. */
	readonly url: string;
	readonly tenant: string;
	readonly cellSecret: string;
	readonly fetch?: typeof fetch;
};

const API_TIMEOUT_MS = 60_000;

/**
 * A cell's computers in Owni Cloud (ADR 0015): the control plane runs them on micro-VMs and
 * holds the provider's token; the cell only asks, for its own tenant, with a token derived from
 * its secret. The control plane names each computer after the tenant and the cell's key, so a
 * cell can reach no other tenant's computers whatever key it sends.
 */
export class RemoteComputerProvider implements ComputerProvider {
	private readonly base: string;
	private readonly fetch: typeof fetch;

	constructor(private readonly options: RemoteComputerOptions) {
		this.base = `${options.url.replace(/\/+$/, "")}/internal/computer`;
		this.fetch = options.fetch ?? fetch;
	}

	/**
	 * Started with one request, then waited for with requests of at most 25 seconds each, so no
	 * proxy between cell and control plane cuts a long command. Cancelled, it is ended there and
	 * what it wrote so far comes back.
	 */
	async run(key: string, command: string, options: { readonly timeoutS: number; readonly signal?: AbortSignal }): Promise<ComputerRun> {
		const started = await this.call("POST", "/run", JSON.stringify({ key, command, timeoutS: options.timeoutS }), AbortSignal.timeout(API_TIMEOUT_MS));
		const job = String(((await started.json()) as { job?: string }).job ?? "");
		const deadline = Date.now() + (Math.min(COMPUTER_LIMITS.maxTimeoutS, options.timeoutS) + 6 * 60) * 1000;
		let cancelled = false;
		while (Date.now() < deadline) {
			if (options.signal?.aborted === true && !cancelled) {
				cancelled = true;
				await this.call("POST", `/cancel?job=${job}`, undefined, AbortSignal.timeout(API_TIMEOUT_MS)).catch(() => {});
			}
			const wait = options.signal === undefined || cancelled ? AbortSignal.timeout(API_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(API_TIMEOUT_MS), options.signal]);
			let answer: { done?: boolean; run?: ComputerRun };
			try {
				answer = (await (await this.call("GET", `/result?job=${job}&wait=${cancelled ? 5 : 25}`, undefined, wait)).json()) as typeof answer;
			} catch (error) {
				// The conversation cancelled mid-wait: the command is ended above, its output asked for once more.
				if (options.signal?.aborted === true && !cancelled) continue;
				throw error;
			}
			if (answer.done === true && answer.run !== undefined) return answer.run;
		}
		throw new Error("computer service: no result in time");
	}

	async put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		for (const file of files) await this.call("PUT", `/file?${new URLSearchParams({ key, path: file.path })}`, file.data, AbortSignal.timeout(5 * 60_000));
	}

	async get(key: string, path: string, maxBytes: number): Promise<Uint8Array> {
		const response = await this.call("GET", `/file?${new URLSearchParams({ key, path, max: String(maxBytes) })}`, undefined, AbortSignal.timeout(5 * 60_000));
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.length > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
		return data;
	}

	async screen(key: string, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ComputerScreen> {
		const timeout = AbortSignal.timeout((SCREEN_TIMEOUT_S + 20) * 1000);
		const response = await this.call("POST", "/screen", JSON.stringify({ key, tool, args }), signal === undefined ? timeout : AbortSignal.any([timeout, signal]));
		return screenFromJson(await response.json());
	}

	async reset(key: string): Promise<void> {
		await this.call("POST", "/reset", JSON.stringify({ key }), AbortSignal.timeout(API_TIMEOUT_MS));
	}

	async check(): Promise<string | undefined> {
		try {
			const response = await this.call("GET", "/check", undefined, AbortSignal.timeout(API_TIMEOUT_MS));
			return ((await response.json()) as { problem?: string }).problem;
		} catch (error) {
			return `il control plane non risponde (${(error instanceof Error ? error.message : String(error)).slice(0, 120)})`;
		}
	}

	async close(): Promise<void> {}

	/** A request to the control plane; what it refuses for a reason the person can act on comes back as a ComputerError. */
	private async call(method: string, path: string, body: string | Uint8Array | undefined, signal: AbortSignal): Promise<Response> {
		const response = await this.fetch(`${this.base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${computerToken(this.options.cellSecret)}`,
				"x-owni-tenant": this.options.tenant,
				...(body === undefined ? {} : { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream" }),
			},
			...(body === undefined ? {} : { body }),
			signal,
		});
		if (response.ok) return response;
		const text = await response.text().catch(() => "");
		let error = "";
		try {
			error = String((JSON.parse(text) as { error?: string }).error ?? "");
		} catch {}
		if (response.status === 422 || response.status === 402 || response.status === 413 || response.status === 429) throw new ComputerError(error.slice(0, 300) || "il computer ha rifiutato la richiesta");
		throw new Error(`computer service: HTTP ${response.status} ${error.slice(0, 200)}`);
	}
}
