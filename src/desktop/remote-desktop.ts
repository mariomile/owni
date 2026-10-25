import { PerKey } from "../computer/queue.ts";
import { DesktopError, type DesktopProvider, type DesktopResult } from "../core/desktop.ts";
import { McpHttpClient } from "./mcp-client.ts";
import { Spaces } from "./spaces.ts";

export type RemoteDesktopOptions = {
	/** Cua's daemon as this server reaches it, e.g. https://schermo.example:3211. */
	readonly url: string;
	/** Its CUA_ENV_TOKEN. */
	readonly token: string;
	readonly fetch?: typeof fetch;
};

/**
 * One Cua desktop someone runs elsewhere (ADR 0045), with its daemon's address and token: every
 * agente that uses it shares the same screen, and Owni neither starts nor resets it. Whether it
 * reaches the internet depends on where it runs.
 */
export class RemoteDesktopProvider implements DesktopProvider {
	readonly network = "unknown";
	readonly shared = true;
	private readonly spaces: Spaces;
	/** One screen: one call at a time, whichever agente makes it, so two actions never interleave. */
	private readonly lock = new PerKey();
	private readonly base: string;
	private readonly fetch: typeof fetch;

	constructor(options: RemoteDesktopOptions) {
		this.base = options.url.replace(/\/+$/, "");
		this.fetch = options.fetch ?? fetch;
		this.spaces = new Spaces(new McpHttpClient({ url: `${this.base}/mcp`, token: options.token, fetch: this.fetch }));
	}

	call(_key: string, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<DesktopResult> {
		return this.lock.run("screen", () => this.spaces.call(tool, args, signal));
	}

	async reset(_key: string): Promise<void> {
		throw new DesktopError("lo schermo condiviso si riavvia da dove gira, non da Owni");
	}

	async check(): Promise<string | undefined> {
		try {
			const health = await this.fetch(`${this.base}/health`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
			await health.body?.cancel();
			if (!health.ok) return `lo schermo risponde ${health.status} su /health: controlla OWNI_DESKTOP_URL`;
		} catch {
			return `lo schermo non risponde su ${new URL(this.base).host}: controlla OWNI_DESKTOP_URL e che Cua sia acceso`;
		}
		try {
			const missing = await this.spaces.missing(AbortSignal.timeout(10_000));
			if (missing.length > 0) return `lo schermo non offre ${missing.join(", ")}: serve trycua/cua-xfce:0.3.0 o un'immagine con gli stessi strumenti`;
			return undefined;
		} catch (error) {
			if (/HTTP 40[13]/.test(error instanceof Error ? error.message : "")) return "lo schermo rifiuta il token: controlla OWNI_DESKTOP_TOKEN";
			return `lo schermo non parla MCP come previsto (${(error instanceof Error ? error.message : String(error)).slice(0, 120)})`;
		}
	}

	async close(): Promise<void> {}
}
