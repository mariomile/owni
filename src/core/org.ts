import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";

/**
 * The organigramma (ADR 0117): squadre, and each agente's role, squadra, who it answers to and
 * what it is responsible for. The owner decides it; who may write to whom comes from it.
 */
export type OrgTeam = {
	readonly id: string;
	readonly name: string;
	/** What the squadra is for, in one line. */
	readonly purpose: string;
	/** The agente that coordinates it: one of its members. */
	readonly lead?: string;
};

export type OrgPlace = {
	readonly role?: string;
	readonly team?: string;
	/** The agente above this one; none: it answers to the people who use it. */
	readonly reportsTo?: string;
	/** Its responsabilità, a short line each. */
	readonly owns: readonly string[];
	/** Every agente may ask it for help. */
	readonly open?: boolean;
};

export type Org = { readonly teams: readonly OrgTeam[]; readonly agents: Readonly<Record<string, OrgPlace>> };

export const EMPTY_ORG: Org = { teams: [], agents: {} };
export const ORG_LIMITS = { teams: 20, name: 40, purpose: 200, role: 60, owns: 10, own: 80 } as const;

export class OrgError extends Error {}

const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An agente's row, only if it is its own: an agente called «constructor» is not Object's. */
export function placeOf(org: Org, id: string): OrgPlace | undefined {
	return Object.hasOwn(org.agents, id) ? org.agents[id] : undefined;
}

/** One line of the owner's words: no control or invisible characters, no line breaks, spaces collapsed. */
function line(value: unknown, max: number, what: string): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new OrgError(`${what}: serve un testo`);
	const text = value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\p{Cf}+/gu, "").replace(/\s+/g, " ").trim();
	if (text.length > max) throw new OrgError(`${what}: al massimo ${max} caratteri`);
	return text;
}

/**
 * The organigramma as the owner sent it, checked against the agenti that exist. Empty places are dropped; a mistake throws an OrgError with words for the console.
 */
export function checkOrg(input: unknown, agents: ReadonlyMap<string, string>): Org {
	if (typeof input !== "object" || input === null) throw new OrgError("Organigramma non valido");
	const body = input as { teams?: unknown; agents?: unknown };
	const rawTeams = body.teams ?? [];
	if (!Array.isArray(rawTeams)) throw new OrgError("Le squadre devono essere un elenco");
	if (rawTeams.length > ORG_LIMITS.teams) throw new OrgError(`Al massimo ${ORG_LIMITS.teams} squadre`);
	const named = (id: string) => `«${agents.get(id) ?? id}»`;
	const teams: OrgTeam[] = [];
	for (const raw of rawTeams) {
		const t = (typeof raw === "object" && raw !== null ? raw : {}) as { id?: unknown; name?: unknown; purpose?: unknown; lead?: unknown };
		const id = typeof t.id === "string" ? t.id : "";
		if (!TEAM_ID.test(id)) throw new OrgError("ID di squadra non valido");
		if (teams.some((x) => x.id === id)) throw new OrgError("Due squadre con lo stesso ID");
		const name = line(t.name, ORG_LIMITS.name, "Nome della squadra");
		if (name === "") throw new OrgError("Ogni squadra ha bisogno di un nome");
		if (teams.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new OrgError(`Due squadre si chiamano «${name}»`);
		const purpose = line(t.purpose, ORG_LIMITS.purpose, `A cosa serve «${name}»`);
		const lead = t.lead === undefined || t.lead === null || t.lead === "" ? undefined : String(t.lead);
		if (lead !== undefined && !agents.has(lead)) throw new OrgError(`Chi coordina «${name}» non è un agente`);
		teams.push({ id, name, purpose, ...(lead === undefined ? {} : { lead }) });
	}
	const rawAgents = body.agents ?? {};
	if (typeof rawAgents !== "object" || rawAgents === null || Array.isArray(rawAgents)) throw new OrgError("Gli agenti devono essere un oggetto");
	const places: Record<string, OrgPlace> = {};
	for (const [id, raw] of Object.entries(rawAgents)) {
		if (!agents.has(id)) throw new OrgError(`Agente sconosciuto: ${id}`);
		const p = (typeof raw === "object" && raw !== null ? raw : {}) as { role?: unknown; team?: unknown; reportsTo?: unknown; owns?: unknown; open?: unknown };
		const role = line(p.role, ORG_LIMITS.role, `Ruolo di ${named(id)}`);
		const team = p.team === undefined || p.team === null || p.team === "" ? undefined : String(p.team);
		if (team !== undefined && !teams.some((t) => t.id === team)) throw new OrgError(`${named(id)} è in una squadra che non c'è`);
		const reportsTo = p.reportsTo === undefined || p.reportsTo === null || p.reportsTo === "" ? undefined : String(p.reportsTo);
		if (reportsTo !== undefined && !agents.has(reportsTo)) throw new OrgError(`${named(id)} risponde a un agente che non c'è`);
		if (reportsTo === id) throw new OrgError(`${named(id)} non può rispondere a se stesso`);
		const rawOwns = p.owns ?? [];
		if (!Array.isArray(rawOwns)) throw new OrgError(`Le responsabilità di ${named(id)} devono essere un elenco`);
		const owns = [...new Set(rawOwns.map((o) => line(o, ORG_LIMITS.own, `Una responsabilità di ${named(id)}`)).filter((o) => o !== ""))];
		if (owns.length > ORG_LIMITS.owns) throw new OrgError(`Al massimo ${ORG_LIMITS.owns} responsabilità per agente`);
		const open = p.open === true;
		if (role === "" && team === undefined && reportsTo === undefined && owns.length === 0 && !open) continue;
		places[id] = { ...(role === "" ? {} : { role }), ...(team === undefined ? {} : { team }), ...(reportsTo === undefined ? {} : { reportsTo }), owns, ...(open ? { open } : {}) };
	}
	const at = (id: string) => placeOf({ teams, agents: places }, id);
	for (const t of teams) if (t.lead !== undefined && at(t.lead)?.team !== t.id) throw new OrgError(`${named(t.lead)} coordina «${t.name}» ma non ne fa parte`);
	for (const start of Object.keys(places)) {
		const seen = new Set([start]);
		for (let up = at(start)?.reportsTo; up !== undefined; up = at(up)?.reportsTo) {
			if (seen.has(up)) throw new OrgError(`${named(start)}: chi risponde a chi torna su se stesso`);
			seen.add(up);
		}
	}
	return { teams, agents: places };
}

/**
 * Who may write to whom (ADR 0117), for each of `agents`: the members of a squadra among
 * themselves, an agente and the one above it both ways, the coordinators among themselves, and
 * everyone to an agente open to all. Agenti not in the organigramma accept nobody.
 */
export function orgLinks(org: Org, agents: readonly string[]): Map<string, string[]> {
	const known = new Set(agents);
	const accepts = new Map(agents.map((id) => [id, new Set<string>()]));
	const link = (a: string, b: string) => {
		if (a === b || !known.has(a) || !known.has(b)) return;
		accepts.get(a)?.add(b);
		accepts.get(b)?.add(a);
	};
	for (const t of org.teams) {
		const members = agents.filter((id) => placeOf(org, id)?.team === t.id);
		for (const a of members) for (const b of members) link(a, b);
	}
	for (const [id, p] of Object.entries(org.agents)) if (p.reportsTo !== undefined) link(id, p.reportsTo);
	const leads = org.teams.flatMap((t) => (t.lead === undefined ? [] : [t.lead]));
	for (const a of leads) for (const b of leads) link(a, b);
	for (const [id, p] of Object.entries(org.agents)) if (p.open === true && known.has(id)) for (const other of agents) if (other !== id) accepts.get(id)?.add(other);
	return new Map([...accepts].map(([id, from]) => [id, [...from].sort()]));
}

/** The organigramma without an agente that is gone: who answered to it answers to nobody, its squadra has no coordinator. */
export function withoutAgent(org: Org, gone: string): Org {
	const agents: Record<string, OrgPlace> = {};
	for (const [id, p] of Object.entries(org.agents)) {
		if (id === gone) continue;
		const { reportsTo, ...rest } = p;
		agents[id] = reportsTo === gone ? rest : p;
	}
	return { teams: org.teams.map(({ lead, ...t }) => (lead === gone ? t : { ...t, ...(lead === undefined ? {} : { lead }) })), agents };
}

/**
 * The organigramma with only the agenti that are still there: an agente deleted
 * while a save was running does not block the next save.
 */
export function onlyKnown(org: Org, agents: ReadonlyMap<string, string>): Org {
	let clean = org;
	for (const id of [...Object.keys(org.agents), ...org.teams.flatMap((t) => (t.lead === undefined ? [] : [t.lead])), ...Object.values(org.agents).flatMap((p) => (p.reportsTo === undefined ? [] : [p.reportsTo]))])
		if (!agents.has(id)) clean = withoutAgent(clean, id);
	return clean;
}

/** A short fingerprint of the organigramma: a save from a page that read an older one is refused. */
export function orgVersion(org: Org): string {
	return createHash("sha256").update(JSON.stringify(org)).digest("hex").slice(0, 16);
}

/** An agente as it reads in a sentence: «Contabile (contabile)». */
const who = (id: string, names: ReadonlyMap<string, string>) => `${names.get(id) ?? id} (${id})`;
const list = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items.at(-1)}` : items.join(""));

/** True when the agente has a place: a row of its own, a squadra it coordinates, or someone answering to it. */
function placed(org: Org, id: string): boolean {
	return placeOf(org, id) !== undefined || org.teams.some((t) => t.lead === id) || Object.values(org.agents).some((p) => p.reportsTo === id);
}

/**
 * What the agente is told about the company (ADR 0117), after its own instructions and before its
 * skills: its role, squadra, who it answers to, and where to send what is not its job.
 * Undefined when it has no place in the organigramma.
 */
export function orgNote(org: Org, self: string, names: ReadonlyMap<string, string>): string | undefined {
	if (!placed(org, self)) return undefined;
	const me = placeOf(org, self);
	const team = me?.team === undefined ? undefined : org.teams.find((t) => t.id === me.team);
	const lines = ["## Il tuo posto nell'azienda", "Dall'organigramma deciso dall'owner: chi fa cosa tra gli agenti di questa azienda."];
	if (me?.role !== undefined) lines.push(`- Ruolo: ${me.role}.`);
	if (me !== undefined && me.owns.length > 0) lines.push(`- Sei responsabile di: ${me.owns.join("; ")}.`);
	if (team !== undefined) {
		const others = Object.entries(org.agents).filter(([id, p]) => id !== self && p.team === team.id && names.has(id)).map(([id, p]) => `${who(id, names)}${p.role === undefined ? "" : `, ${p.role}`}`);
		const purpose = team.purpose === "" ? "" : ` (${team.purpose})`;
		const lead = team.lead === self ? "la coordini tu" : team.lead === undefined ? "nessuno la coordina" : `la coordina ${who(team.lead, names)}`;
		lines.push(`- Squadra «${team.name}»${purpose}: ${lead}.${others.length === 0 ? "" : ` Con te: ${list(others)}.`}`);
	}
	const above = me?.reportsTo;
	lines.push(above === undefined || !names.has(above) ? "- Rispondi alle persone che ti usano." : `- Rispondi a ${who(above, names)}.`);
	const below = Object.entries(org.agents).filter(([id, p]) => p.reportsTo === self && names.has(id)).map(([id]) => who(id, names));
	if (below.length > 0) lines.push(`- Rispondono a te: ${list(below)}.`);
	if (me?.open === true) lines.push("- Sei a disposizione di tutti: ogni agente può chiederti aiuto.");
	const leading = org.teams.filter((t) => t.lead === self);
	for (const t of leading)
		lines.push(
			"",
			`Coordini «${t.name}»: ricevi le richieste, dividi il lavoro e consegni il risultato. Chiedi agli altri con agent_message (una richiesta completa: non vedono la tua conversazione), o nella stanza della squadra chiamandoli con @nome. Per un lavoro affidato a te sulla board, dividilo in sotto-schede (board_create con parent) assegnate a loro; quando finiscono, rivedi e metti insieme.`,
		);
	if (team?.lead !== undefined && team.lead !== self && names.has(team.lead))
		lines.push("", `Il lavoro di solito te lo passa chi coordina, ${who(team.lead, names)}: fallo, rispondi con il risultato e, su una scheda della board, mettila in «Da rivedere» con un riassunto. Se ti manca qualcosa chiedilo a chi coordina o alla persona, senza inventare.`);
	lines.push("", "Se ti chiedono qualcosa che è responsabilità di un altro agente, non farlo al suo posto: passalo a lui con agent_message oppure, se non puoi scrivergli, a chi coordina la tua squadra o a chi rispondi. agent_list dice chi è responsabile di cosa.");
	return lines.join("\n");
}

/** One agente's place in a line for agent_list: «Responsabile vendite, squadra Vendite. Responsabile di: preventivi; clienti». */
export function placeLine(org: Org, id: string): string {
	const p = placeOf(org, id);
	if (p === undefined) return "";
	const team = p.team === undefined ? undefined : org.teams.find((t) => t.id === p.team);
	const head = [p.role, team === undefined ? undefined : `squadra ${team.name}${team.lead === id ? " (la coordina)" : ""}`].filter((x) => x !== undefined).join(", ");
	return [head, p.owns.length === 0 ? "" : `Responsabile di: ${p.owns.join("; ")}`].filter((x) => x !== "").join(". ");
}

/** The organigramma of a tenant, in its folder. Read on every request: it is small, and the owner may change it at any time. */
export class OrgStore {
	private readonly file: string;

	constructor(dir: string) {
		this.file = join(dir, "organigramma.json");
	}

	read(): Org {
		const org = readJsonFile<Org>(this.file, EMPTY_ORG);
		return { teams: org.teams ?? [], agents: org.agents ?? {} };
	}

	/** Change it under the file's lock; returns what was written. */
	update(change: (current: Org) => Org): Org {
		return updateJsonFile<Org>(this.file, EMPTY_ORG, (current) => change({ teams: current.teams ?? [], agents: current.agents ?? {} }));
	}

	/** Whether the owner ever saved one: until then the permissions set by hand stay. */
	saved(): boolean {
		return readJsonFile<Org | undefined>(this.file, undefined) !== undefined;
	}
}
