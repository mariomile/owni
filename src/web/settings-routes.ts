import { IMAGE_CONNECTOR } from "../core/image-generation.ts";
import { desktopConnector } from "../core/desktop.ts";
import { WEB_SEARCH_CONNECTOR } from "../core/web-search.ts";
import { connectorEgressName } from "../connectors/mcp.ts";
import { cleanName, type Persona } from "../core/persona.ts";
import { DEV_PROVIDER } from "../core/model-providers.ts";
import { WEB_HOST_PATTERN, withChannel } from "../core/policy.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person } from "./auth.ts";
import type { WebChannel } from "./channel.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import { ABOUT_MAX, INSTRUCTIONS_MAX, ownInstructions, withAbout } from "./setup.ts";
import { CANNED_REPLIES } from "../gateway.ts";
import type { WebAppOptions } from "./server.ts";

export type SettingsRoutesDeps = Pick<WebAppOptions, "computer" | "desktop" | "people" | "defaultInstructions" | "browser" | "connectedChannels" | "connectors" | "search" | "voice" | "speech" | "images"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly knownInstance: (id: string) => Promise<InstanceRecord>;
	readonly instanceAccess: (person: Person, instanceId: string) => Promise<{ readonly record: InstanceRecord; readonly member: boolean }>;
	readonly channelOf: (instanceId: string) => WebChannel;
	readonly personaOf: (input: unknown) => Persona;
	/** Whether the owner may delete this instance. */
	readonly deletable: (id: string) => boolean;
};

/** The owner's settings of an instance: its computer and screen, name and people, primi passi, the sites it reads. */
export function settingsRoutes(route: AddRoute, options: SettingsRoutesDeps): void {
	const { runtime, tenantId, knownInstance, instanceAccess, channelOf, personaOf, deletable } = options;
	// --- owner: the instance's computer (ADR 0013) ---
	route("DELETE", "/api/instances/:id/computer", "owner", async ({ params }) => {
		if (options.computer === undefined) throw new HttpError(501, "Il computer non è disponibile su questo server");
		const id = params[0];
		await knownInstance(id);
		await options.computer.reset(id);
		await runtime.audit(tenantId).append({ type: "computer.reset", instanceId: id });
		return { ok: true };
	});

	// --- owner: the agente's screen (ADR 0045) ---
	route("POST", "/api/desktop/permissions", "owner", async ({ req }) => {
		const desktop = options.desktop;
		if (desktop?.kind !== "local" || desktop.requestPermission === undefined) throw new HttpError(501, "I permessi Computer Use si gestiscono nell'app Owni su questo Mac");
		const body = (await readJson(req)) as { permission?: unknown };
		if (body.permission !== "screenRecording" && body.permission !== "accessibility") throw new HttpError(400, "permission: screenRecording o accessibility");
		const permissions = await desktop.requestPermission(body.permission);
		await runtime.audit(tenantId).append({ type: "desktop.permission.requested", permission: body.permission });
		return { permissions };
	});
	route("DELETE", "/api/instances/:id/desktop", "owner", async ({ params }) => {
		if (options.desktop === undefined) throw new HttpError(501, "Lo schermo non è disponibile su questo server");
		if (options.desktop.shared) throw new HttpError(501, "Lo schermo è condiviso: si riavvia da dove gira");
		const id = params[0];
		await knownInstance(id);
		await options.desktop.reset(id);
		await runtime.audit(tenantId).append({ type: "desktop.reset", instanceId: id });
		return { ok: true };
	});
	route("GET", "/api/instances/:id/settings", "owner", async ({ params }) => {
		const r = await runtime.registry.getInstance(tenantId, params[0]);
		return { settings: { name: r.name, instructions: r.instructions ?? "", persona: r.persona ?? {}, model: r.model, egress: r.egress, allowedUsers: r.allowedUsers, approvers: r.approvers ?? {}, deletable: deletable(r.id) } };
	});
	route("PUT", "/api/instances/:id/settings", "owner", async ({ params, req }) => {
		const body = (await readJson(req)) as { name?: string; instructions?: string; persona?: unknown; about?: unknown; webPeople?: string[]; webApprovers?: string[] };
		const id = params[0];
		const persona = body.persona === undefined ? undefined : personaOf(body.persona);
		const people = new Set((await options.people.list()).map((p) => p.id));
		const pick = (list: unknown) => (Array.isArray(list) ? list.map(String).filter((x) => people.has(x)) : undefined);
		const record = await runtime.registry.getInstance(tenantId, id);
		// From «Primi passi»: who the owner is, as one block after the instructions, replaced on each save.
		let about: string | undefined;
		if (body.about !== undefined) {
			if (typeof body.instructions === "string") throw new HttpError(400, "Manda le istruzioni o le informazioni su di te, non tutte e due");
			const text = typeof body.about === "string" ? body.about.trim() : "";
			if (text === "") throw new HttpError(400, "Scrivi due righe su di te o sulla tua azienda");
			if (text.length > ABOUT_MAX) throw new HttpError(400, `Al massimo ${ABOUT_MAX} caratteri`);
			if (/\[[^\]\n]{1,60}\]/.test(text)) throw new HttpError(400, "Sostituisci le parti tra parentesi quadre con i tuoi dati");
			about = withAbout(record.instructions ?? options.defaultInstructions ?? "", text);
			if (about.length > INSTRUCTIONS_MAX) throw new HttpError(400, "Le istruzioni sono già al limite: accorciale in Impostazioni");
		}
		const webPeople = pick(body.webPeople);
		const webApprovers = pick(body.webApprovers);
		if (webPeople !== undefined) {
			await runtime.registry.setAllowedUsers(tenantId, id, "web", webPeople);
			// Reconcile against all current people, not only the old allowlist: if cleanup
			// fails after membership was saved, repeating this request must retry it.
			for (const personId of people) if (!webPeople.includes(personId)) await options.browser?.clearProfile(id, personId);
			await runtime.registry.setEgress(tenantId, id, (egress) => withChannel(egress, "web", true));
		}
		await runtime.registry.updateInstance(tenantId, id, {
			...(typeof body.name === "string" && cleanName(body.name) !== "" ? { name: cleanName(body.name) } : {}),
			...(persona === undefined ? {} : { persona }),
			...(typeof body.instructions === "string" ? { instructions: body.instructions.slice(0, 20_000) || null } : {}),
			...(about === undefined ? {} : { instructions: about }),
			...(webApprovers === undefined ? {} : { approvers: { ...(record.approvers ?? {}), web: webApprovers } }),
		});
		await runtime.reopen(tenantId, id);
		return { ok: true };
	});
	// --- primo avvio: what is left to make the instance useful, checked from the real settings ---
	route("GET", "/api/instances/:id/setup", "owner", async ({ person, params }) => {
		const me = person;
		const { record } = await instanceAccess(me, params[0]);
		// Cheap on purpose: the console asks on every open. No network, at most a few transcripts.
		let tried = false;
		if (record.egress.channels.includes("web")) {
			const channel = channelOf(record.id);
			for (const thread of (await channel.threads(me.id)).slice(0, 5)) {
				if ((await channel.transcript(thread.id)).some((e) => e.from === "owni" && !CANNED_REPLIES.has(e.text ?? ""))) {
					tried = true;
					break;
				}
			}
		}
		// A channel counts once someone can write to it: an empty «chi può scrivere» refuses everyone.
		const connected = options.connectedChannels?.(record.id) ?? [];
		const others = (record.allowedUsers.web ?? []).filter((id) => id !== me.id);
		return {
			setup: {
				// The local development model answers with an echo: the owner picks a real one in Impostazioni.
				model: record.model.provider !== DEV_PROVIDER,
				instructions: ownInstructions(record.instructions ?? undefined, options.defaultInstructions),
				tried,
				channel: connected.some((c) => (record.allowedUsers[c] ?? []).length > 0),
				web: (record.egress.web ?? []).length > 0 || (record.egress.connectors ?? []).includes(WEB_SEARCH_CONNECTOR),
				images: (record.egress.connectors ?? []).includes(IMAGE_CONNECTOR),
				connectors: (await options.connectors(record.id).list()).some((c) => c.enabled && (record.egress.connectors ?? []).includes(connectorEgressName(c.id))),
				people: others.length > 0,
				...(options.desktop?.kind === "local" ? { computerUse: (record.egress.connectors ?? []).includes(desktopConnector(options.desktop)) } : {}),
				// What this server offers, so the console does not count a step nobody can take here.
				can: { search: options.search !== undefined, transcription: options.voice !== undefined, speech: options.speech !== undefined, images: options.images !== undefined, ...(options.desktop?.kind === "local" ? { computerUse: true } : {}) },
			},
		};
	});
	// --- owner: the sites an instance may read with its web tools ---
	route("PUT", "/api/instances/:id/web", "owner", async ({ params, req }) => {
		const id = params[0];
		const record = await knownInstance(id);
		const body = (await readJson(req)) as { hosts?: unknown };
		if (!Array.isArray(body.hosts) || body.hosts.length > 200) throw new HttpError(400, "hosts: un elenco di domini (al massimo 200)");
		const hosts = [...new Set(body.hosts.map((h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter((h) => h !== ""))];
		const wrong = hosts.filter((h) => !WEB_HOST_PATTERN.test(h));
		if (wrong.length > 0) throw new HttpError(400, `Non sono domini: ${wrong.slice(0, 5).join(", ")}. Scrivi per esempio comune.roma.it, oppure * per tutti i siti pubblici`);
		await runtime.registry.setEgress(tenantId, id, (egress) => ({ ...egress, web: hosts }));
		await runtime.audit(tenantId).append({ type: "web.hosts_changed", instanceId: id, count: hosts.length, any: hosts.includes("*") });
		return { hosts };
	});
}
