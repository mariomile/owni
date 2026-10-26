import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { EMPTY_ORG, orgNote } from "../src/core/org.ts";
import { TEAMS, team, withTeam } from "../src/core/teams.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningOwni[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

async function boot() {
	const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
	const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
	running.push(owni);
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	const login = async (link: string) => {
		const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
		const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return async (path: string, body?: unknown, method?: string) => {
			const r = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			// biome-ignore lint: test
			return { status: r.status, ...((await r.json()) as any) };
		};
	};
	return { api: await login(owni.ownerLink as string), login };
}

describe("ready-made squadre", () => {
	it("a squadra goes in the organigramma: the first coordinates, the others answer to it, each with its role and responsabilità", () => {
		const contenuti = team("contenuti");
		if (contenuti === undefined) throw new Error("no team");
		const ids = [{ id: "caporedattore" }, { id: "ricercatore-2" }, { id: "scrittore" }];
		const org = withTeam(EMPTY_ORG, contenuti, ids);
		expect(org.teams).toEqual([{ id: "contenuti", name: "Contenuti", purpose: contenuti.summary, lead: "caporedattore" }]);
		expect(org.agents.caporedattore).toEqual({ role: "Caporedattore", team: "contenuti", owns: ["Piano editoriale", "Revisione dei testi prima della consegna"] });
		expect(org.agents["ricercatore-2"]).toMatchObject({ role: "Ricercatore", team: "contenuti", reportsTo: "caporedattore" });
		// The same squadra again gets its own ID and name.
		const again = withTeam(org, contenuti, [{ id: "caporedattore-2" }, { id: "ricercatore-3" }, { id: "scrittore-2" }]);
		expect(again.teams.map((t) => [t.id, t.name, t.lead])).toEqual([
			["contenuti", "Contenuti", "caporedattore"],
			["contenuti-2", "Contenuti 2", "caporedattore-2"],
		]);
		expect(again.agents["scrittore-2"]?.reportsTo).toBe("caporedattore-2");
		// What each is told comes from there.
		const names = new Map([
			["caporedattore", "Caporedattore"],
			["ricercatore-2", "Ricercatore"],
			["scrittore", "Scrittore"],
		]);
		const lead = orgNote(org, "caporedattore", names) as string;
		expect(lead).toContain("- Squadra «Contenuti» (Post, articoli e newsletter: uno pianifica, uno cerca le fonti, uno scrive.): la coordini tu. Con te: Ricercatore (ricercatore-2), Ricercatore e Scrittore (scrittore), Scrittore.");
		expect(lead).toContain("Coordini «Contenuti»");
		expect(lead).toContain("board_create con parent");
		const writer = orgNote(org, "scrittore", names) as string;
		expect(writer).toContain("- Rispondi a Caporedattore (caporedattore).");
		expect(writer).toContain("te lo passa chi coordina, Caporedattore (caporedattore)");
		expect(writer).not.toContain("Coordini «Contenuti»");
		// Every squadra fits in a room, and every job in the form's limit; the responsabilità in the organigramma's.
		for (const t of TEAMS) {
			expect(t.members.length).toBeGreaterThanOrEqual(2);
			expect(t.members.length).toBeLessThanOrEqual(5);
			for (const m of t.members) {
				expect(m.job.length).toBeLessThan(2000);
				expect(m.owns.length).toBeGreaterThan(0);
				for (const o of m.owns) expect(o.length).toBeLessThanOrEqual(80);
			}
		}
	});

	it("one click makes the agenti, lets them ask each other and opens a room with all of them; again, with new IDs", async () => {
		const { api, login } = await boot();
		const list = await api("/api/teams");
		expect(list.available).toBe(true);
		expect(list.teams.map((t: { key: string }) => t.key)).toEqual(["contenuti", "vendite", "amministrazione"]);
		const made = await api("/api/teams", { team: "contenuti" });
		expect(made.status).toBe(200);
		expect(made.agents).toEqual([
			{ id: "caporedattore", name: "Caporedattore" },
			{ id: "ricercatore", name: "Ricercatore" },
			{ id: "scrittore", name: "Scrittore" },
		]);
		const agents = (await api("/api/agents")).agents as { id: string; acceptsFrom: string[]; emoji?: string }[];
		const of = (id: string) => agents.find((a) => a.id === id);
		expect(of("caporedattore")?.acceptsFrom.sort()).toEqual(["ricercatore", "scrittore"]);
		expect(of("scrittore")?.acceptsFrom.sort()).toEqual(["caporedattore", "ricercatore"]);
		// Nobody outside the squadra: the main agente does not ask them, nor they it.
		expect(of("owni")?.acceptsFrom).toEqual([]);
		const settings = (await api("/api/instances/caporedattore/settings")).settings;
		expect(settings.persona).toMatchObject({ emoji: "🗂️", named: true });
		// Only its job, after the default instructions like the form's: the squadra is in the organigramma.
		expect(settings.instructions.indexOf("Pianifica post, articoli e newsletter")).toBeGreaterThan(100);
		expect(settings.instructions).not.toContain("squadra");
		const org = (await api("/api/org")).org;
		expect(org.teams).toEqual([expect.objectContaining({ id: "contenuti", lead: "caporedattore" })]);
		expect(org.agents.scrittore).toMatchObject({ role: "Scrittore", reportsTo: "caporedattore" });
		const room = await api(`/api/rooms/${made.room}`);
		expect(room.room.title).toBe("Squadra Contenuti");
		expect(room.room.agents.map((a: { instanceId: string }) => a.instanceId)).toEqual(["caporedattore", "ricercatore", "scrittore"]);
		const again = await api("/api/teams", { team: "contenuti" });
		expect(again.agents.map((a: { id: string }) => a.id)).toEqual(["caporedattore-2", "ricercatore-2", "scrittore-2"]);
		expect((await api("/api/org")).org.agents["scrittore-2"]).toMatchObject({ team: "contenuti-2", reportsTo: "caporedattore-2" });
		expect((await api("/api/agents")).agents.find((a: { id: string }) => a.id === "scrittore-2").acceptsFrom.sort()).toEqual(["caporedattore-2", "ricercatore-2"]);
		expect((await api("/api/teams", { team: "nessuna" })).status).toBe(400);
		// Only the owner makes agenti.
		const { link } = await api("/api/people", { name: "Anna", role: "member" });
		const anna = await login(link);
		expect((await anna("/api/teams", { team: "vendite" })).status).toBe(403);
		expect((await anna("/api/teams")).status).toBe(403);
	}, 30_000);
});

describe("the squadre's routes, alone", () => {
	type Handler = (ctx: { person: unknown; req: unknown }) => Promise<unknown>;
	async function routes(over: Partial<import("../src/web/team-routes.ts").TeamRoutesDeps> = {}) {
		const { teamRoutes } = await import("../src/web/team-routes.ts");
		const { Readable } = await import("node:stream");
		const handlers = new Map<string, Handler>();
		const taken = new Set<string>();
		const made: string[] = [];
		const audit: Record<string, unknown>[] = [];
		const logs: string[] = [];
		teamRoutes((method, path, _auth, handler) => void handlers.set(`${method} ${path}`, handler as Handler), {
			canCreate: true,
			exists: async (id) => taken.has(id),
			make: async (_p, input) => {
				taken.add(input.id);
				made.push(input.id);
			},
			place: async (_p, change) => change({ teams: [], agents: {} }),
			room: async () => "r1",
			audit: async (e) => void audit.push(e),
			log: (m) => void logs.push(m),
			...over,
		});
		const post = (team: string) => (handlers.get("POST /api/teams") as Handler)({ person: { id: "p_owner" }, req: Readable.from([Buffer.from(JSON.stringify({ team }))]) });
		return { post, taken, made, audit, logs };
	}

	it("an agente that fails halfway: the ones made are named, an internal error is logged and not shown", async () => {
		let n = 0;
		const { post, logs } = await routes({
			make: async () => {
				n += 1;
				if (n === 2) throw new Error("EACCES /data/tenants/x");
			},
		});
		await expect(post("contenuti")).rejects.toMatchObject({ status: 500, message: "Errore interno. Creati intanto: Caporedattore" });
		expect(logs[0]).toContain("EACCES");
	});

	it("no room: the squadra is there, with a note; two at once take different IDs; out of IDs is a 409; without creation a 501", async () => {
		const { HttpError } = await import("../src/web/http.ts");
		const { post, made, taken } = await routes({
			room: async () => {
				throw new HttpError(400, "Hai già 50 stanze: cancellane una");
			},
		});
		const [a, b] = await Promise.all([post("contenuti"), post("contenuti")]);
		expect(a).toMatchObject({ room: null, note: "Squadra creata, ma la stanza no: Hai già 50 stanze: cancellane una" });
		expect((b as { agents: { id: string }[] }).agents.map((x) => x.id)).toEqual(["caporedattore-2", "ricercatore-2", "scrittore-2"]);
		expect(new Set(made).size).toBe(6);
		for (let i = 3; i <= 9; i += 1) taken.add(`caporedattore-${i}`);
		await expect(post("contenuti")).rejects.toMatchObject({ status: 409 });
		const off = await routes({ canCreate: false });
		await expect(off.post("contenuti")).rejects.toMatchObject({ status: 501 });
	});
});
