import type { AuditEvent } from "../core/audit.ts";
import { TEAMS, type Team, team, withTeam } from "../core/teams.ts";
import type { Person } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { PreviewOrg, SaveOrg } from "./org-routes.ts";

export type TeamRoutesDeps = {
	/** This installation makes agenti from the console. */
	readonly canCreate: boolean;
	readonly exists: (id: string) => Promise<boolean>;
	/** One agente, as the form «Nuovo agente» makes it; `persona` is checked like the form's. */
	readonly make: (person: Person, input: { id: string; name: string; instructions: string; persona: unknown }) => Promise<void>;
	/** Change the organigramma (ADR 0117): the squadra goes in it, and with it who writes to whom. */
	readonly place: SaveOrg;
	/** What placing it would change in who writes to whom, to confirm first. */
	readonly preview: PreviewOrg;
	/** A room of the person with these agenti (ADR 0063), its ID; undefined without rooms on this server. An HttpError says why not. */
	readonly room: (person: Person, title: string, agents: readonly string[]) => Promise<string | undefined>;
	readonly audit: (event: AuditEvent) => Promise<void>;
	/** For the operator: what went wrong, never shown in the console. */
	readonly log: (message: string) => void;
};

/** Suffixes tried for an ID already taken: «ricercatore-2»… */
const TRIES = 9;

/**
 * Ready-made squadre (ADR 0068): the owner picks one and gets its agenti, a squadra in the
 * organigramma (ADR 0117) and a room with all of them. Nothing more than what the console does by hand, in one go.
 */
export function teamRoutes(route: AddRoute, deps: TeamRoutesDeps): void {
	route("GET", "/api/teams", "owner", async () => ({
		available: deps.canCreate,
		teams: TEAMS.map((t) => ({ key: t.key, name: t.name, summary: t.summary, members: t.members.map((m) => ({ name: m.name, tagline: m.tagline })) })),
	}));
	const chosenOf = (body: { team?: unknown }) => {
		const chosen = typeof body.team === "string" ? team(body.team) : undefined;
		if (chosen === undefined) throw new HttpError(400, "Squadra sconosciuta");
		return chosen;
	};
	/** The IDs its agenti would get: theirs when free; otherwise -2, -3… */
	const idsOf = async (chosen: Team) => {
		const members: { id: string; name: string }[] = [];
		for (const m of chosen.members) {
			let id: string | undefined;
			for (let n = 1; n <= TRIES && id === undefined; n += 1) {
				const candidate = n === 1 ? m.id : `${m.id}-${n}`;
				if (!(await deps.exists(candidate))) id = candidate;
			}
			if (id === undefined) throw new HttpError(409, `Ci sono già troppi agenti che si chiamano ${m.id}`);
			members.push({ id, name: m.name });
		}
		return members;
	};
	// Before making it: who will write to whom, for the owner to confirm.
	route("POST", "/api/teams/preview", "owner", async ({ req }) => {
		const chosen = chosenOf((await readJson(req)) as { team?: unknown });
		const members = await idsOf(chosen);
		return { changes: await deps.preview((org) => withTeam(org, chosen, members), members.map((m) => ({ ...m, accepts: [] }))) };
	});
	// One squadra at a time: two at once would pick the same free IDs.
	let queue: Promise<unknown> = Promise.resolve();
	route("POST", "/api/teams", "owner", async ({ person: p, req }) => {
		if (!deps.canCreate) throw new HttpError(501, "Questa installazione non crea agenti dalla console");
		const chosen = chosenOf((await readJson(req)) as { team?: unknown });
		const run = queue.then(() => makeTeam(p, chosen));
		queue = run.catch(() => {});
		return run;
	});

	const makeTeam = async (p: Person, chosen: Team) => {
		const members = await idsOf(chosen);
		const made: string[] = [];
		// The ones made stay, ordinary agenti: said, so the owner deletes them or tries again.
		const halfway = (error: unknown): never => {
			if (made.length === 0) throw error;
			if (!(error instanceof HttpError)) deps.log(`teams: ${chosen.key} stopped halfway: ${error instanceof Error ? error.message : String(error)}`);
			throw new HttpError(error instanceof HttpError ? error.status : 500, `${error instanceof HttpError ? error.message : "Errore interno"}. Creati intanto: ${made.join(", ")}`);
		};
		try {
			for (const [i, m] of chosen.members.entries()) {
				const { id, name } = members[i] as { id: string; name: string };
				await deps.make(p, { id, name, instructions: m.job, persona: { tagline: m.tagline, tone: m.tone } });
				made.push(name);
			}
			// Roles, who coordinates and who writes to whom: the owner changes them in the organigramma.
			await deps.place(p, (org) => withTeam(org, chosen, members));
		} catch (error) {
			halfway(error);
		}
		let room: string | undefined;
		let note: string | undefined;
		try {
			room = await deps.room(p, `Squadra ${chosen.name}`, members.map((m) => m.id));
		} catch (error) {
			note = `Squadra creata, ma la stanza no: ${error instanceof HttpError ? error.message : "errore interno"}`;
			if (!(error instanceof HttpError)) deps.log(`teams: no room for ${chosen.key}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await deps.audit({ type: "team.created", team: chosen.key, personId: p.id, agents: members.map((m) => m.id).join(","), room: room !== undefined });
		return { agents: members, room: room ?? null, ...(note === undefined ? {} : { note }) };
	};
}
