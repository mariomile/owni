import type { AuditEvent } from "../core/audit.ts";
import { checkOrg, onlyKnown, type Org, OrgError, orgLinks, type OrgStore, orgVersion } from "../core/org.ts";
import type { Person } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";

export type OrgAgent = {
	readonly id: string;
	readonly name: string;
	/** The agenti that may write to it now (ADR 0042). */
	readonly accepts: readonly string[];
};

export type OrgRoutesDeps = {
	readonly store: OrgStore;
	/** The agenti in the organigramma: all of them. */
	readonly agents: () => Promise<readonly OrgAgent[]>;
	/** Set the agenti that may write to `id`. */
	readonly allow: (person: Person, id: string, from: readonly string[]) => Promise<unknown>;
	readonly audit: (event: AuditEvent) => Promise<void>;
};

/** One permission a save would change: from now on `from` may write to `to`, or no longer. */
export type OrgChange = { readonly from: string; readonly to: string; readonly allowed: boolean };

/**
 * The organigramma (ADR 0117), for the owner: read it with who may write to whom now, and save it
 * whole. Saving rewrites every agente's permission to hear from the others.
 */
export function orgRoutes(route: AddRoute, deps: OrgRoutesDeps): void {
	const view = async () => {
		const agents = await deps.agents();
		const org = onlyKnown(deps.store.read(), new Map(agents.map((a) => [a.id, a.name])));
		return {
			org,
			version: orgVersion(org),
			saved: deps.store.saved(),
			agents: agents.map((a) => ({ id: a.id, name: a.name })),
			// What is in effect: until the first save, the permissions set by hand before.
			accepts: Object.fromEntries(agents.map((a) => [a.id, [...a.accepts].sort()])),
		};
	};
	// One save at a time: two would apply their permissions in between each other.
	let queue: Promise<unknown> = Promise.resolve();
	const saveNow = async (person: Person, change: (current: Org) => Org) => {
		const agents = await deps.agents();
		const names = new Map(agents.map((a) => [a.id, a.name]));
		let saved: Org | undefined;
		try {
			deps.store.update((current) => (saved = checkOrg(change(onlyKnown(current, names)), names)));
		} catch (error) {
			if (error instanceof OrgError) throw new HttpError(400, error.message);
			throw error;
		}
		const org = saved as Org;
		const links = orgLinks(org, agents.map((a) => a.id));
		// Every agente gets its permissions even if one fails; the next save tries the ones left again.
		const missed: string[] = [];
		for (const a of agents) {
			const from = links.get(a.id) ?? [];
			if (from.join(",") === [...a.accepts].sort().join(",")) continue;
			try {
				await deps.allow(person, a.id, from);
			} catch {
				missed.push(a.name);
			}
		}
		await deps.audit({ type: "org.saved", personId: person.id, teams: org.teams.length, agents: Object.keys(org.agents).length });
		if (missed.length > 0) throw new HttpError(500, `Organigramma salvato, ma chi può scrivere a ${missed.join(", ")} non è cambiato: salva di nuovo`);
		return org;
	};
	/** What saving `change` would do to who may write to whom, by name, for the owner to confirm first. */
	const preview = async (change: (current: Org) => Org): Promise<OrgChange[]> => {
		const agents = await deps.agents();
		const names = new Map(agents.map((a) => [a.id, a.name]));
		let next: Org;
		try {
			next = checkOrg(change(onlyKnown(deps.store.read(), names)), names);
		} catch (error) {
			if (error instanceof OrgError) throw new HttpError(400, error.message);
			throw error;
		}
		const links = orgLinks(next, agents.map((a) => a.id));
		const changes: OrgChange[] = [];
		for (const a of agents) {
			const before = new Set(a.accepts);
			const after = new Set(links.get(a.id) ?? []);
			for (const id of after) if (!before.has(id)) changes.push({ from: names.get(id) ?? id, to: a.name, allowed: true });
			for (const id of before) if (!after.has(id) && names.has(id)) changes.push({ from: names.get(id) ?? id, to: a.name, allowed: false });
		}
		return changes;
	};
	const save = (person: Person, change: (current: Org) => Org): Promise<Org> => {
		const run = queue.then(() => saveNow(person, change));
		queue = run.catch(() => {});
		return run;
	};
	route("GET", "/api/org", "owner", view);
	route("POST", "/api/org/preview", "owner", async ({ req }) => {
		const body = (await readJson(req)) as { org?: unknown };
		return { changes: await preview(() => body.org as Org) };
	});
	route("PUT", "/api/org", "owner", async ({ person, req }) => {
		const body = (await readJson(req)) as { org?: unknown; version?: unknown };
		await save(person, (current) => {
			// Two pages open: the older page does not erase the newer save.
			if (body.version !== orgVersion(current)) throw new HttpError(409, "L'organigramma è cambiato da quando hai aperto la pagina: ricaricala e rifai la modifica");
			return body.org as Org;
		});
		return view();
	});
}
