import type { DesktopProvider } from "../core/desktop.ts";
import type { DesktopConfig } from "../main/config.ts";
import { DockerDesktopProvider } from "./docker-desktop.ts";
import { RemoteDesktopProvider } from "./remote-desktop.ts";
import { LocalDesktopProvider } from "./local-desktop.ts";

/** The desktops this configuration asks for (ADR 0045): a container each on this Docker host, or one run elsewhere. */
export function createDesktopProvider(config: DesktopConfig, context: { readonly log?: (message: string) => void; readonly fetch?: typeof fetch } = {}): DesktopProvider {
	if (config.kind === "local") return new LocalDesktopProvider({ helperPath: config.helperPath });
	const extra = context.fetch === undefined ? {} : { fetch: context.fetch };
	if (config.kind === "docker") return new DockerDesktopProvider({ network: config.network, socketPath: config.socketPath, ...extra, ...(context.log === undefined ? {} : { log: context.log }) });
	return new RemoteDesktopProvider({ url: config.url, token: config.token, ...extra });
}

/** What the desktops are, for the log and `pnpm owni check`. */
export function desktopLabel(config: DesktopConfig): string {
	if (config.kind === "local") return "questo Mac";
	return config.kind === "docker" ? `Docker${config.network === "internet" ? ", con internet" : ""}` : "remoto";
}
