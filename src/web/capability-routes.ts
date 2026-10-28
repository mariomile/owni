import { COMPUTER_CONNECTOR } from "../core/computer.ts";
import { desktopConnector } from "../core/desktop.ts";
import { WEB_ACTIONS_CONNECTOR } from "../core/web-actions.ts";
import { WEB_SEARCH_CONNECTOR } from "../core/web-search.ts";
import { IMAGE_CONNECTOR } from "../core/image-generation.ts";
import { withConnector } from "../core/policy.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { SPEECH_CONNECTOR } from "../channels/speech.ts";
import { VOICE_CONNECTOR } from "../channels/voice.ts";
import { GOOGLE_CONNECTOR } from "../connectors/google.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type CapabilityRoutesDeps = Pick<WebAppOptions, "voice" | "speech" | "images" | "search" | "computer" | "desktop" | "google"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly knownInstance: (id: string) => Promise<{ readonly egress: { readonly connectors?: readonly string[] } }>;
};

/** An on/off switch of the egress policy: one connector name, one audit event. */
type Capability = {
	readonly name: string;
	readonly connector: string;
	readonly auditType: string;
	/** Whether this server offers it; when not, the switch answers 501 with `missing`. */
	readonly available: boolean;
	readonly missing: string;
	/** What the card shows besides on and off. */
	readonly detail?: () => Promise<Record<string, unknown>>;
	/** Runs before the switch flips; throws to refuse. */
	readonly check?: (enabled: boolean) => Promise<void>;
	/** Runs after it flipped. */
	readonly after?: (instanceId: string) => Promise<unknown>;
};

/**
 * The agent's capability switches in the console: one list and one switch for all of them.
 * Google's accounts, the computer's and the screen's reset, and the web hosts are not switches
 * and keep their own routes.
 */
export function capabilityRoutes(route: AddRoute, { runtime, tenantId, knownInstance, voice, speech, images, search, computer, desktop, google }: CapabilityRoutesDeps): void {
	// Kept for 30 seconds: Impostazioni asks at every visit, and the Docker check reads the image list.
	let desktopCheck: { at: number; problem: Promise<string | undefined> } | undefined;
	const desktopStatus = async (): Promise<Record<string, unknown>> => {
		if (desktop === undefined) return {};
		if (desktop.kind === "local" && desktop.permissions !== undefined) {
			const permissions = await desktop.permissions();
			return { kind: "local", connector: desktopConnector(desktop), shared: desktop.shared, permissions, ...(permissions.problem === undefined ? {} : { problem: permissions.problem }) };
		}
		if (desktopCheck === undefined || Date.now() - desktopCheck.at > 30_000) desktopCheck = { at: Date.now(), problem: desktop.check() };
		const problem = await desktopCheck.problem;
		return { shared: desktop.shared, ...(problem === undefined ? {} : { problem }) };
	};
	const specs: readonly Capability[] = [
		{ name: "web-actions", connector: WEB_ACTIONS_CONNECTOR, auditType: "web_actions.allowed", available: true, missing: "" },
		{
			name: "computer",
			connector: COMPUTER_CONNECTOR,
			auditType: "computer.allowed",
			available: computer !== undefined,
			missing: "Il computer non è disponibile su questo server",
			detail: async () => {
				const problem = await computer?.check();
				return problem === undefined ? {} : { problem };
			},
		},
		{
			name: "desktop",
			connector: desktop === undefined ? "" : desktopConnector(desktop),
			auditType: "desktop.allowed",
			available: desktop !== undefined,
			missing: "Lo schermo non è disponibile su questo server",
			detail: desktopStatus,
			check: async (enabled) => {
				if (!enabled || desktop?.kind !== "local") return;
				const permissions = await desktop.permissions?.();
				if (permissions?.supported !== true || !permissions.screenRecording || !permissions.accessibility) throw new HttpError(409, "Concedi Registrazione schermo e Accessibilità a Owni prima di abilitare Computer Use");
			},
			// The screen's tools are offered only while it is on: the agente opens again with or without them.
			after: (id) => runtime.reopen(tenantId, id),
		},
		{ name: "google", connector: GOOGLE_CONNECTOR, auditType: "google.allowed", available: google !== undefined, missing: "Google non è configurato su questo server" },
		{ name: "voice", connector: VOICE_CONNECTOR, auditType: "voice.allowed", available: voice !== undefined, missing: "La trascrizione dei vocali non è configurata su questo server", detail: async () => ({ host: voice?.host }) },
		{ name: "speech", connector: SPEECH_CONNECTOR, auditType: "speech.allowed", available: speech !== undefined, missing: "Le risposte a voce non sono configurate su questo server", detail: async () => ({ host: speech?.host, voice: speech?.voice }) },
		{ name: "images", connector: IMAGE_CONNECTOR, auditType: "images.allowed", available: images !== undefined, missing: "La generazione di immagini non è configurata su questo server", detail: async () => ({ host: images?.host, maxPerDay: images?.maxPerDay }) },
		{ name: "search", connector: WEB_SEARCH_CONNECTOR, auditType: "web_search.allowed", available: search !== undefined, missing: "La ricerca sul web non è configurata su questo server", detail: async () => ({ host: search?.host }) },
	];

	route("GET", "/api/instances/:id/capabilities", "owner", async ({ params }) => {
		const record = await knownInstance(params[0]);
		return {
			capabilities: await Promise.all(
				specs.map(async (s) => ({ name: s.name, available: s.available, enabled: s.available && (record.egress.connectors ?? []).includes(s.connector), ...(s.available ? await s.detail?.() : {}) })),
			),
		};
	});
	route("PUT", "/api/instances/:id/capabilities/:name", "owner", async ({ params, req }) => {
		const [id, name] = params;
		const spec = specs.find((s) => s.name === name);
		if (spec === undefined) throw new HttpError(404, "Capacità inesistente");
		if (!spec.available) throw new HttpError(501, spec.missing);
		await knownInstance(id);
		const body = (await readJson(req)) as { enabled?: unknown };
		if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled: true o false");
		const enabled = body.enabled;
		await spec.check?.(enabled);
		await runtime.registry.setEgress(tenantId, id, (egress) => withConnector(egress, spec.connector, enabled));
		await runtime.audit(tenantId).append({ type: spec.auditType, instanceId: id, allowed: enabled });
		await spec.after?.(id);
		return { enabled };
	});
}
