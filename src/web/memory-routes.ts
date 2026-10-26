import { MemoryError, SHARED, subjectOf } from "../core/memory.ts";
import { parseSkillMd, type Skill, SkillError, toSkillMd } from "../core/skills.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";

export type MemoryRoutesDeps = {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly instanceAccess: (person: Person, instanceId: string) => Promise<{ readonly record: InstanceRecord; readonly member: boolean }>;
};

/** What an agente remembers (memoria) and knows how to do (skill, ADR 0059), as each person sees it. */
export function memoryRoutes(route: AddRoute, options: MemoryRoutesDeps): void {
	const { runtime, tenantId, instanceAccess } = options;
	// --- memoria: each person sees what the instance remembers about them, and the shared facts ---
	const subjectOfPerson = (p: Person) => subjectOf("web", p.id);
	route("GET", "/api/instances/:id/memory", "person", async ({ person, params }) => {
		await instanceAccess(person, params[0]);
		const all = runtime.memory(tenantId, params[0]).list();
		return { mine: all.filter((m) => m.about === subjectOfPerson(person)), shared: all.filter((m) => m.about === SHARED), canEditShared: person.role === "owner" };
	});
	route("POST", "/api/instances/:id/memory", "person", async ({ person: p, params, req }) => {
		await instanceAccess(p, params[0]);
		const body = (await readJson(req)) as { text?: unknown; shared?: unknown; archived?: unknown };
		const shared = body.shared === true;
		if (shared && p.role !== "owner") throw new HttpError(403, "Solo l'owner aggiunge memorie condivise");
		try {
			const memory = runtime.memory(tenantId, params[0]).add({ about: shared ? SHARED : subjectOfPerson(p), text: String(body.text ?? ""), source: "person", archived: body.archived === true });
			await runtime.audit(tenantId).append({ type: "memory.saved", instanceId: params[0], personId: p.id, memoryId: memory.id, shared });
			return { memory };
		} catch (error) {
			if (error instanceof MemoryError) throw new HttpError(400, error.message);
			throw error;
		}
	});
	route("DELETE", "/api/instances/:id/memory/:mid", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const removed = runtime.memory(tenantId, params[0]).remove(params[1], (m) => m.about === subjectOfPerson(p) || (m.about === SHARED && p.role === "owner"));
		if (removed === undefined) throw new HttpError(404, "Memoria non trovata");
		await runtime.audit(tenantId).append({ type: "memory.forgotten", instanceId: params[0], personId: p.id, memoryId: removed.id });
		return { ok: true };
	});
	// --- skill (ADR 0059): everyone who talks to an agente sees its skills; each saves and deletes their own, the owner all ---
	route("GET", "/api/instances/:id/skills", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const store = runtime.skills(tenantId, params[0]);
		// Who saved it only to the owner: from a chat it is a phone number or a Telegram ID.
		const shown = ({ createdBy, ...s }: Skill) => ({ ...s, ...(p.role === "owner" ? { createdBy } : {}), mine: createdBy === subjectOfPerson(p), canEdit: p.role === "owner" || createdBy === subjectOfPerson(p), skillMd: toSkillMd(s) });
		return { skills: store.list().map(shown), drafts: store.drafts().filter((d) => d.createdBy === subjectOfPerson(p)).map(shown) };
	});
	route("PUT", "/api/instances/:id/skills", "person", async ({ person: p, params, req }) => {
		await instanceAccess(p, params[0]);
		const body = (await readJson(req)) as { name?: unknown; description?: unknown; body?: unknown; skillMd?: unknown };
		try {
			const input = typeof body.skillMd === "string" ? parseSkillMd(body.skillMd) : { name: String(body.name ?? ""), description: String(body.description ?? ""), body: String(body.body ?? "") };
			const { skill, replaced } = runtime.skills(tenantId, params[0]).save({ ...input, by: subjectOfPerson(p) }, (existing) => p.role === "owner" || existing.createdBy === subjectOfPerson(p));
			await runtime.audit(tenantId).append({ type: "skill.saved", instanceId: params[0], personId: p.id, skill: skill.name, replaced, source: "person" });
			return { skill, replaced };
		} catch (error) {
			if (error instanceof SkillError) throw new HttpError(/un'altra persona/.test(error.message) ? 409 : 400, error.message);
			throw error;
		}
	});
	route("DELETE", "/api/instances/:id/skills/:name", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const removed = runtime.skills(tenantId, params[0]).remove(params[1], (s) => p.role === "owner" || s.createdBy === subjectOfPerson(p));
		if (removed === undefined) throw new HttpError(404, "Skill non trovata, o salvata da un'altra persona");
		await runtime.audit(tenantId).append({ type: "skill.deleted", instanceId: params[0], personId: p.id, skill: removed.name, source: "person" });
		return { ok: true };
	});
}
