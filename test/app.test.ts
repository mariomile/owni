import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { BoardStore } from "../src/core/board.ts";
import { instanceId as toInstanceId, tenantId as toTenantId } from "../src/core/ids.ts";
import { instanceDir, tenantDir } from "../src/core/paths.ts";
import { romeDayKey } from "../src/core/usage.ts";
import { proxyToken } from "../src/web/compare.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

const running: RunningOwni[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

/** Fake Telegram: queued updates in, every call recorded; bots told apart by their token. */
function fakeTelegram() {
	const queues = new Map<string, unknown[][]>();
	const queue = (token: string) => queues.get(token) ?? (queues.set(token, []).get(token) as unknown[][]);
	const sent: { token: string; chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
	const methods: string[] = [];
	const calls: { token: string; method: string }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const [, token = "", method = ""] = /\/bot([^/]+)\/(\w+)$/.exec(String(url)) ?? [];
		methods.push(method);
		calls.push({ token, method });
		if (token === "bad") return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
		if (method === "getMe") return Response.json({ ok: true, result: { username: `bot_${token.split(":")[0]}` } });
		if (method === "getUpdates") {
			const batch = queue(token).shift();
			if (batch === undefined) await new Promise((r) => setTimeout(r, 20));
			return Response.json({ ok: true, result: batch ?? [] });
		}
		if (method === "sendMessage") sent.push({ token, ...JSON.parse(String(init?.body)) });
		return Response.json({ ok: true, result: { message_id: 1 } });
	}) as typeof fetch;
	return { updates: queue("1:T"), queue, sent, methods, calls, fetch: fetchImpl };
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 30));
	}
}

async function boot(dataDir: string, telegram = fakeTelegram(), env: Record<string, string> = {}) {
	const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", TELEGRAM_BOT_TOKEN: "1:T", OWNI_TELEGRAM_ALLOWED_USERS: "7", OWNI_TELEGRAM_APPROVERS: "9", ...env });
	const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { telegramFetch: telegram.fetch, schedulerIntervalMs: 60_000, log: process.env.DEBUG_APP ? console.error : () => {} });
	running.push(owni);
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	return { owni, base, telegram };
}

async function client(base: string, link: string, extra: Record<string, string> = {}) {
	const token = link.split("#")[1] as string;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1", ...extra }, body: JSON.stringify({ token }) });
	expect(login.status).toBe(200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	const call = async (path: string, body?: unknown) => {
		const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-owni": "1", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// biome-ignore lint: test
		return (await res.json()) as any;
	};
	return Object.assign(call, { cookie });
}

describe("pnpm start (startOwni)", () => {
	it("first start: owner link, web chat, a tool proposed in the chat and approved with a Telegram tap", async () => {
		const dataDir = tempDataDir();
		const { owni, base, telegram } = await boot(dataDir);
		expect(owni.ownerLink).toMatch(/^http:\/\/127\.0\.0\.1:0\/login#[\w-]{40,}$/);
		const api = await client(base, owni.ownerLink as string);
		const instances = (await api("/api/instances")).instances;
		expect(instances).toEqual([{ id: "owni", name: "Owni", canChat: true, isApprover: true, hasSegreteria: false, main: true }]);
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		const proposal = { name: "double", description: "Raddoppia", parameters: { type: "object", properties: { x: { type: "number" } } }, code: "export default async (a) => String(a.x * 2)", hosts: [] };
		await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: `/tool tool_propose ${JSON.stringify(proposal)}` });
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "9" && m.text.startsWith("Nuovo tool da approvare")));
		const card = telegram.sent.find((m) => m.chat_id === "9");
		const approve = card?.reply_markup?.inline_keyboard[0]?.find((b) => b.text === "Approva")?.callback_data as string;
		telegram.updates.push([{ update_id: 1, callback_query: { id: "cq1", from: { id: 9 }, message: { message_id: 5, chat: { id: 9 } }, data: approve } }]);
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "9" && m.text === "custom_double: approvato."));
		const entries = async () => (await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		await until(async () => (await entries()).some((e) => e.text?.includes("è stato approvato")));
		await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: '/tool custom_double {"x":21}' });
		await until(async () => (await entries()).some((e) => e.text === "Fatto. 42"));
	});

	it("a proposal whose code does not fit the Telegram card can only be approved from the console", async () => {
		const { owni, base, telegram } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		const code = `// ${"riempitivo innocuo ".repeat(120)}\nexport default async () => "payload"`;
		const proposal = { name: "lungo", description: "Codice lungo", parameters: { type: "object" }, code, hosts: [] };
		await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: `/tool tool_propose ${JSON.stringify(proposal)}` });
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "9"));
		const card = telegram.sent.find((m) => m.chat_id === "9");
		expect(card?.text).toContain("leggilo tutto e decidi nella console web");
		expect(card?.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(["Rifiuta"]);
		// A forged approve tap is ignored.
		const id = (await owni.runtime.proposals("default", "owni").list())[0]!.id;
		telegram.updates.push([{ update_id: 2, callback_query: { id: "cq2", from: { id: 9 }, message: { message_id: 5, chat: { id: 9 } }, data: `tool:${id}:approved` } }]);
		await new Promise((r) => setTimeout(r, 300));
		expect((await owni.runtime.proposals("default", "owni").get(id))?.status).toBe("pending");
	});

	it("a task programmato created from the web delivers into its web thread; a restart keeps the owner", async () => {
		const dataDir = tempDataDir();
		const first = await boot(dataDir);
		const api = await client(first.base, first.owni.ownerLink as string);
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		const at = new Date(Date.now() + 60_000).toISOString();
		const created = await api("/api/instances/owni/schedules", { instruction: "Promemoria riunione", at, threadId: thread.id });
		expect(created.schedule.nextRunAt).toBe(at);
		await api("/api/instances/owni/schedules", { instruction: "Riassunto mail", cron: "0 9 * * 1-5", threadId: thread.id });
		// The list says each schedule in words, for the Task page.
		expect(((await api("/api/instances/owni/schedules")).schedules as { instruction: string; whenText?: string }[]).find((s) => s.instruction === "Riassunto mail")?.whenText).toBe("dal lunedì al venerdì alle 9:00");
		expect(await first.owni.scheduler.tick(new Date(Date.now() + 120_000))).toBe(1);
		await until(async () => ((await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string }[]).some((e) => e.from === "owni" && e.text?.includes("Promemoria riunione")));
		await first.owni.stop();
		running.splice(running.indexOf(first.owni), 1);
		const second = await boot(dataDir);
		expect(second.owni.ownerLink).toBeUndefined();
		const again = await client(second.base, first.owni.ownerLink as string);
		expect((await again("/api/me")).person.role).toBe("owner");
	});

	it("agenti (ADR 0041): created with a face and a tone, listed with what they do, changed in Impostazioni", async () => {
		const dataDir = tempDataDir();
		const { owni, base } = await boot(dataDir);
		const api = await client(base, owni.ownerLink as string);
		const created = await api("/api/instances", { id: "ricerca", name: "Ricercatore", persona: { emoji: "🔎", tagline: "Cerca e confronta fornitori", tone: "conciso" } });
		expect(created.instance).toMatchObject({ id: "ricerca", name: "Ricercatore", emoji: "🔎", tagline: "Cerca e confronta fornitori" });
		expect((await api("/api/instances", { id: "brutta", name: "Brutta", persona: { emoji: "ciao" } })).error).toMatch(/emoji/);
		expect((await owni.runtime.registry.listInstances("default")).map((r) => r.id)).not.toContain("brutta");
		// biome-ignore lint: test
		const { agents } = (await api("/api/agents")) as { agents: any[] };
		expect(agents.map((a) => a.id)).toEqual(["owni", "ricerca"]);
		expect(agents[1]).toMatchObject({ emoji: "🔎", tone: "conciso", channels: ["web"], schedules: 0, watches: 0, memories: 0 });
		expect(agents[1].model).toMatchObject({ provider: "faux" });
		// Who is doing what (ADR 0109): nobody is working here.
		expect(agents.map((a) => [a.busy, a.doing])).toEqual([[false, ""], [false, ""]]);
		expect(agents[1]).not.toHaveProperty("busyFor");
		const put = (body: unknown) => fetch(`${base}/api/instances/ricerca/settings`, { method: "PUT", headers: { "x-owni": "1", "content-type": "application/json", cookie: api.cookie }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>);
		expect((await put({ persona: { tone: "arrogante" } })).error).toMatch(/Tono/);
		expect((await put({ name: "  ", persona: { emoji: "🧭", tone: "formale" } })).ok).toBe(true);
		// A member sees only the agenti they may write to, and only the tasks that act for them.
		const { link, person } = await api("/api/people", { name: "Anna", role: "member" });
		await put({ webPeople: [person.id] });
		await owni.runtime.schedules("default", "ricerca").create({ instruction: "Del owner", when: { at: new Date(Date.now() + 3_600_000).toISOString() }, channel: "web", threadId: "t-owner", createdBy: { kind: "person", channel: "web", userId: "owner-x" } });
		const member = await client(base, link);
		const seen = (await member("/api/agents")).agents as { id: string; schedules: number }[];
		expect(seen.map((a) => a.id)).toEqual(["ricerca"]);
		expect(seen[0]?.schedules).toBe(0);
		expect((await api("/api/agents")).agents[1].schedules).toBe(1);
		// Who is doing what (ADR 0109): a scheda In corso on ricerca shows to the owner and to the member who may talk to it, as number and title only.
		const board = new BoardStore(tenantDir(dataDir, toTenantId("default")));
		const made = board.create({ title: "Fornitori carta", description: "Cliente Rossi SpA, 12.000 euro", assignee: "ricerca" }, { kind: "person", id: "owner-x" });
		board.update(made.id, { status: "in_corso" }, { kind: "person", id: "owner-x" });
		const mine = (await api("/api/agents")).agents[1];
		expect(mine).toMatchObject({ busy: false, doing: "#1 Fornitori carta" });
		expect(JSON.stringify(mine)).not.toMatch(/Rossi/);
		expect((await member("/api/agents")).agents[0]).toMatchObject({ id: "ricerca", busy: false, doing: "#1 Fornitori carta" });
		// A runs.json that cannot be read leaves that agente idle; the page still loads.
		writeFileSync(join(instanceDir(dataDir, toTenantId("default"), toInstanceId("ricerca")), "runs.json"), "{rotto");
		const broken = (await api("/api/agents")).agents as { id: string; busy: boolean }[];
		expect(broken.map((a) => [a.id, a.busy])).toEqual([["owni", false], ["ricerca", false]]);
		const settings = (await api("/api/instances/ricerca/settings")).settings;
		expect(settings.name).toBe("Ricercatore");
		expect(settings.persona).toEqual({ emoji: "🧭", tone: "formale", named: true });
	});

	it("agenti write to each other (ADR 0042): only those allowed, and the answer comes back to the conversation", async () => {
		const { owni, base } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "ricerca", name: "Ricercatore", persona: { emoji: "🔎", tagline: "Cerca fornitori" } });
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		const entries = async () => (await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string; text?: string }[];
		const say = (text: string) => api(`/api/instances/owni/threads/${thread.id}/messages`, { text });
		await say("/tool agent_list {}");
		await until(async () => (await entries()).some((e) => e.text?.includes("Nessun altro agente accetta i tuoi messaggi")));
		await say('/tool agent_message {"agent":"ricerca","message":"Trova tre fornitori di carta"}');
		await until(async () => (await entries()).some((e) => e.text?.includes("Errore: nessun altro agente accetta")));
		// biome-ignore lint: test
		const put = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "PUT", headers: { "x-owni": "1", "content-type": "application/json", cookie: api.cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...((await r.json()) as any) }));
		// The organigramma decides it (ADR 0117): Ricercatore answers to Owni, so they write to each other.
		expect((await put("/api/org", { org: { teams: [], agents: { ignoto: { role: "X" } } }, version: (await api("/api/org")).version })).error).toBe("Agente sconosciuto: ignoto");
		const saved = await put("/api/org", { org: { teams: [], agents: { ricerca: { role: "Ricerca fornitori", reportsTo: "owni", owns: ["Fornitori e prezzi"] } } }, version: (await api("/api/org")).version });
		expect(saved.accepts).toEqual({ owni: ["ricerca"], ricerca: ["owni"] });
		expect(saved.saved).toBe(true);
		expect((await owni.runtime.registry.getInstance("default", "ricerca")).egress.channels).toContain("agente");
		expect((await api("/api/agents")).agents[1].acceptsFrom).toEqual(["owni"]);
		await say("/tool agent_list {}");
		await until(async () => (await entries()).some((e) => e.text?.includes("- Ricercatore (ricerca): Cerca fornitori [Ricerca fornitori. Responsabile di: Fornitori e prezzi]")));
		await say('/tool agent_message {"agent":"Ricercatore","message":"Trova tre fornitori di carta"}');
		await until(async () => (await entries()).some((e) => e.text?.includes("Messaggio mandato a «Ricercatore»")));
		// Ricercatore got it in a conversation of its own, and its answer came back here as a notice.
		await until(async () => (await entries()).some((e) => e.from === "owni" && e.text?.includes("[Risposta dell'agente «Ricercatore» (ricerca)]")));
		const audit = await owni.runtime.audit("default").read();
		expect(audit.some((e) => e.type === "message.received" && e.instanceId === "ricerca" && e.channel === "agente" && e.userId === "owni")).toBe(true);
		expect(audit.some((e) => e.type === "notice.submitted" && e.instanceId === "owni" && e.source === "agent" && e.from === "ricerca")).toBe(true);
		// Taken back: the next message is refused, and nothing reaches Ricercatore.
		await put("/api/org", { org: { teams: [], agents: {} }, version: (await api("/api/org")).version });
		expect((await owni.runtime.registry.getInstance("default", "ricerca")).egress.channels).not.toContain("agente");
		await say('/tool agent_message {"agent":"ricerca","message":"Ancora"}');
		await until(async () => (await entries()).filter((e) => e.text?.includes("Errore: nessun altro agente accetta")).length === 2);
	});

	it("the owner creates an instance from the console: chat works at once and after a restart", async () => {
		const dataDir = tempDataDir();
		const first = await boot(dataDir);
		const api = await client(first.base, first.owni.ownerLink as string);
		const created = await api("/api/instances", { id: "vendite", name: "Vendite", instructions: "Rispondi sulle offerte." });
		expect(created.instance).toEqual({ id: "vendite", name: "Vendite", canChat: true, isApprover: true, hasSegreteria: false });
		expect((await api("/api/instances", { id: "vendite", name: "Doppia" })).error).toMatch(/esiste già/);
		expect((await api("/api/instances", { id: "../x", name: "X" })).error).toMatch(/ID/);
		expect((await api("/api/instances", { id: "vuota", name: "  " })).error).toMatch(/nome/);
		const settings = (await api("/api/instances/vendite/settings")).settings;
		// The owner's words go after what Owni can do (ADR 0019), not in its place.
		expect(settings.instructions.startsWith("Sei Owni")).toBe(true);
		expect(settings.instructions.endsWith("Informazioni su chi ti usa:\nRispondi sulle offerte.")).toBe(true);
		expect(settings.egress).toEqual({ modelProviders: ["faux"], channels: ["web"] });
		const thread = (await api("/api/instances/vendite/dm", {})).thread;
		await api(`/api/instances/vendite/threads/${thread.id}/messages`, { text: "ciao vendite" });
		const replied = async (a: typeof api, id: string) => ((await a(`/api/instances/vendite/threads/${id}`)).entries as { from: string }[]).some((e) => e.from === "owni");
		await until(() => replied(api, thread.id));
		await first.owni.stop();
		running.splice(running.indexOf(first.owni), 1);
		const second = await boot(dataDir);
		const again = await client(second.base, first.owni.ownerLink as string);
		expect((await again("/api/instances")).instances.map((i: { id: string }) => i.id).sort()).toEqual(["owni", "vendite"]);
		const t2 = (await again("/api/instances/vendite/dm", {})).thread;
		expect(t2.id).toBe(thread.id);
		await again(`/api/instances/vendite/threads/${t2.id}/messages`, { text: "di nuovo" });
		await until(async () => ((await again(`/api/instances/vendite/threads/${t2.id}`)).entries as { from: string; text?: string }[]).some((e) => e.from === "owni" && (e.text ?? "").includes("di nuovo")));
	});

	it("the owner deletes an agente (ADR 0046): name to confirm, bot stopped, keys and automations gone, colleagues forget it", async () => {
		const dataDir = tempDataDir();
		const telegram = fakeTelegram();
		const { owni, base } = await boot(dataDir, telegram);
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "vendite", name: "Vendite" });
		const send = (method: string, path: string, body?: unknown, cookie = api.cookie) =>
			fetch(`${base}${path}`, { method, headers: { "x-owni": "1", "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => ({ status: r.status, ...((await r.json()) as { error?: string; deletable?: boolean }) }));
		expect((await send("PUT", "/api/instances/vendite/telegram", { token: "2:V", allowedUsers: ["8"] })).status).toBe(200);
		// Owni accepts messages from Vendite: that permission must not outlive Vendite.
		await send("PUT", "/api/org", { org: { teams: [{ id: "commerciale", name: "Commerciale", purpose: "", lead: "vendite" }], agents: { vendite: { team: "commerciale", reportsTo: "owni", owns: ["Offerte"] } } }, version: (await api("/api/org")).version });
		const thread = (await api("/api/instances/vendite/dm", {})).thread;
		await api("/api/instances/vendite/schedules", { instruction: "Controlla le offerte", at: new Date(Date.now() + 60_000).toISOString(), threadId: thread.id });
		const secrets = owni.runtime.secrets("default");
		for (const name of ["mcp-oauth.vendite.github", "connector.github.vendite.authorization", "connector.github.owni.authorization", "mcp-oauth.vendite2.github"]) await secrets.set(name, "x");
		expect((await api("/api/instances/vendite/settings")).settings.deletable).toBe(true);
		expect((await api("/api/instances/owni/settings")).settings.deletable).toBe(false);

		const { link } = await api("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await send("DELETE", "/api/instances/vendite", { confirm: "Vendite" }, member.cookie)).status).toBe(403);
		expect((await send("DELETE", "/api/instances/vendite", { confirm: "vendite" })).error).toMatch(/scrivi il nome/);
		expect((await send("DELETE", "/api/instances/vendite", {})).status).toBe(400);
		expect((await send("DELETE", "/api/instances/owni", { confirm: "Owni" })).error).toMatch(/non si elimina/);
		expect((await send("DELETE", "/api/instances/nessuno", { confirm: "Nessuno" })).status).toBe(404);

		const deleted = await send("DELETE", "/api/instances/vendite", { confirm: "Vendite" });
		expect(deleted.status).toBe(200);
		expect((await api("/api/instances")).instances.map((i: { id: string }) => i.id)).toEqual(["owni"]);
		expect(existsSync(join(dataDir, "tenants", "default", "instances", "vendite"))).toBe(false);
		// Its own keys went, those of the other agenti stayed.
		const left = await secrets.names();
		for (const gone of ["telegram.botToken.vendite", "mcp-oauth.vendite.github", "connector.github.vendite.authorization"]) expect(left).not.toContain(gone);
		expect(left).toEqual(expect.arrayContaining(["telegram.botToken.owni", "connector.github.owni.authorization", "mcp-oauth.vendite2.github"]));
		expect((await owni.runtime.registry.getInstance("default", "owni")).allowedUsers.agente).toEqual([]);
		// And it left the organigramma: its squadra stays, with nobody coordinating it.
		expect((await api("/api/org")).org).toEqual({ teams: [{ id: "commerciale", name: "Commerciale", purpose: "" }], agents: {} });
		// The bot stopped asking Telegram, and its automations are no longer run.
		const polls = telegram.calls.filter((c) => c.token === "2:V" && c.method === "getUpdates").length;
		await new Promise((r) => setTimeout(r, 200));
		expect(telegram.calls.filter((c) => c.token === "2:V" && c.method === "getUpdates").length).toBeLessThanOrEqual(polls + 1);
		expect(await owni.scheduler.tick(new Date(Date.now() + 120_000))).toBe(0);
		const audit = await owni.runtime.audit("default").read();
		expect(audit.some((e) => e.type === "web.instance_deleted" && e.instanceId === "vendite")).toBe(true);

		// The ID is free again, and the new agente starts empty.
		await api("/api/instances", { id: "vendite", name: "Vendite 2" });
		expect((await api("/api/instances/vendite/schedules")).schedules).toEqual([]);
		expect((await api("/api/instances/vendite/telegram")).telegram.connected).toBe(false);
	});

	it("schede that come back (ADR 0069): set from the board, made at their time and started with who set them", async () => {
		const { owni, base } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "ricerca", name: "Ricercatore" });
		const send = (method: string, path: string, body?: unknown, cookie = api.cookie) =>
			// biome-ignore lint: test
			fetch(`${base}${path}`, { method, headers: { "x-owni": "1", "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => ({ status: r.status, ...((await r.json()) as any) }));
		expect((await api("/api/board", { title: "Report", repeat: { every: "giorno", time: "9:00" } })).error).toMatch(/affidata a un agente/);
		expect((await api("/api/board", { title: "Report", assignee: "ricerca", repeat: { every: "settimana", time: "9:00" } })).error).toMatch(/giorno della settimana/);
		const { routine } = await api("/api/board", { title: "Report vendite", description: "Le vendite della settimana", assignee: "ricerca", auto: true, repeat: { every: "settimana", time: "9:00", day: 1 } });
		expect(routine).toMatchObject({ title: "Report vendite", whenText: "ogni lunedì alle 9:00", auto: true, assignee: "ricerca" });
		const board = await api("/api/board");
		expect(board.cards).toEqual([]);
		expect(board.routines.map((r: { id: string }) => r.id)).toEqual([routine.id]);
		// Its time comes: a scheda, In corso with the owner, alone.
		await owni.scheduler.tick(new Date(Date.parse(routine.next) + 1000));
		const [card] = (await api("/api/board")).cards;
		expect(card).toMatchObject({ title: "Report vendite", status: "in_corso", work: { agent: "ricerca" } });
		expect(card.auto).toBeDefined();
		// Paused, and started again from now; only who set it, or the owner, sees and changes it.
		expect((await send("PUT", `/api/board/routines/${routine.id}`, { paused: true })).routine.paused).toBe(true);
		const { link } = await api("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await member("/api/board")).routines).toEqual([]);
		expect((await send("DELETE", `/api/board/routines/${routine.id}`, undefined, member.cookie)).status).toBe(404);
		expect((await send("PUT", `/api/board/routines/${routine.id}`, { paused: false })).routine.paused).toBeUndefined();
		expect((await send("DELETE", `/api/board/routines/${routine.id}`)).ok).toBe(true);
		expect((await api("/api/board")).routines).toEqual([]);

		// Scadenze (ADR 0073): set when created, moved, taken off; a wrong day is said.
		const { card: dated } = await api("/api/board", { title: "Fattura Rossi", due: "2026-11-02" });
		expect(dated.due).toBe("2026-11-02");
		expect((await api("/api/board", { title: "Report", assignee: "ricerca", due: "2026-11-02", repeat: { every: "giorno", time: "9:00" } })).error).toMatch(/non ha una scadenza/);
		expect((await send("PUT", `/api/board/${dated.id}`, { due: "2026-13-01" })).error).toMatch(/formato 2026-10-26/);
		expect((await send("PUT", `/api/board/${dated.id}`, { due: 5 })).error).toMatch(/formato 2026-10-26/);
		expect((await send("PUT", `/api/board/${dated.id}`, { due: "2026-11-05" })).card.due).toBe("2026-11-05");
		expect((await send("PUT", `/api/board/${dated.id}`, { due: null })).card.due).toBeUndefined();
		// Lista di controllo (ADR 0075).
		const listed = (await api("/api/board", { title: "Trasloco", checklist: ["Scatoloni", "Furgone"] })).card;
		expect(listed.checklist).toHaveLength(2);
		expect((await send("PUT", `/api/board/${listed.id}`, { check: { item: "2", done: true } })).card.checklist[1].done).toBe(true);
		expect((await send("PUT", `/api/board/${listed.id}`, { check: { add: "Chiavi" } })).card.checklist).toHaveLength(3);
		expect((await send("PUT", `/api/board/${listed.id}`, { check: { item: "1" } })).error).toMatch(/check:/);
		expect((await send("PUT", `/api/board/${listed.id}`, { check: { item: "1", remove: true } })).card.checklist.map((i: { text: string }) => i.text)).toEqual(["Furgone", "Chiavi"]);
		// Its day comes (ADR 0074): the sweep tells it once.
		await send("PUT", `/api/board/${dated.id}`, { due: "2026-11-05" });
		await owni.scheduler.tick(new Date("2026-11-05T09:00:00Z"));
		expect((await api("/api/board")).cards.find((c: { id: string }) => c.id === dated.id).dueNoticed).toBe("2026-11-05");
		// Comes after another (ADR 0076): started, it waits; the other closed, it starts by itself.
		const next = (await api("/api/board", { title: "Dopo il trasloco", assignee: "ricerca", after: [String(listed.n)] })).card;
		expect(next).toMatchObject({ status: "da_fare", after: [listed.id], queued: { personId: expect.any(String) } });
		expect((await api("/api/board", { title: "x", after: ["#999"] })).error).toMatch(/#999 non c'è/);
		expect((await send("PUT", `/api/board/${listed.id}`, { after: [String(next.n)] })).error).toMatch(/si aspetterebbero/);
		expect((await send("PUT", `/api/board/${next.id}`, { after: "1" })).error).toMatch(/after:/);
		await send("PUT", `/api/board/${listed.id}`, { status: "fatto" });
		expect((await api("/api/board")).cards.find((c: { id: string }) => c.id === next.id)).toMatchObject({ status: "in_corso", work: { agent: "ricerca" } });
	}, 30_000);

	it("the board (ADR 0050): a scheda handed to an agente is worked in its conversation, reviewed and closed by a person", async () => {
		const { owni, base, telegram } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "ricerca", name: "Ricercatore", persona: { emoji: "🔎" } });
		await api("/api/instances", { id: "vendite", name: "Vendite" });
		const send = (method: string, path: string, body?: unknown, cookie = api.cookie) =>
			// biome-ignore lint: test
			fetch(`${base}${path}`, { method, headers: { "x-owni": "1", "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => ({ status: r.status, ...((await r.json()) as any) }));
		const board = await api("/api/board");
		expect(board.cards).toEqual([]);
		expect(board.agents.map((a: { id: string; canAssign: boolean }) => [a.id, a.canAssign])).toEqual([
			["owni", true],
			["ricerca", true],
			["vendite", true],
		]);
		expect((await api("/api/board", { title: "  " })).error).toMatch(/titolo/);

		const { card } = await api("/api/board", { title: "Fornitori carta", description: "Tre preventivi", assignee: "ricerca", priority: "alta" });
		expect(card).toMatchObject({ n: 1, status: "in_corso", priority: "alta", assignee: "ricerca" });
		const threadId = card.work.threadId as string;
		const entries = async () => (await api(`/api/instances/ricerca/threads/${threadId}`)).entries as { from: string; text?: string }[];
		// The brief is in Ricercatore's conversation with the owner, and Ricercatore answered it.
		await until(async () => (await entries()).some((e) => e.from === "owni"));
		expect((await entries())[0]?.text).toMatch(/^\[Scheda #1 dalla board\] Fornitori carta\n\nTre preventivi/);
		expect((await api("/api/instances/ricerca/threads")).threads.find((t: { id: string }) => t.id === threadId).title).toBe("#1 Fornitori carta");

		// Ricercatore finishes and moves it; it cannot close it.
		await api(`/api/instances/ricerca/threads/${threadId}/messages`, { text: '/tool board_update {"status":"da_rivedere","comment":"Tre preventivi nel file"}' });
		await until(async () => (await api("/api/board")).cards[0].status === "da_rivedere");
		// The owner hears it in the chat with the main agente too (ADR 0051).
		await until(async () => telegram.sent.some((m) => m.chat_id === "9" && m.text.startsWith("Scheda #1 da rivedere: Fornitori carta\nRicercatore l'ha finita: Tre preventivi nel file")));
		await api(`/api/instances/ricerca/threads/${threadId}/messages`, { text: '/tool board_update {"status":"fatto"}' });
		await until(async () => (await entries()).some((e) => e.text?.includes("must be equal to one of the allowed values")));
		expect((await api("/api/board")).cards[0].status).toBe("da_rivedere");
		// Sent back with a comment: it hears it there.
		expect((await send("PUT", `/api/board/${card.id}`, { status: "in_corso", comment: "Manca il trasporto" })).card.status).toBe("in_corso");
		await until(async () => (await entries()).some((e) => e.text?.startsWith("[Scheda #1] ") && e.text.includes("rimandata indietro: Manca il trasporto")));
		// Approved with a tap in the owner's chat (ADR 0079): only by an approver, only while in review.
		await api(`/api/instances/ricerca/threads/${threadId}/messages`, { text: '/tool board_update {"status":"da_rivedere","comment":"Aggiunto il trasporto"}' });
		await until(async () => telegram.sent.some((m) => m.chat_id === "9" && m.text.includes("Aggiunto il trasporto")));
		const notice = telegram.sent.findLast((m) => m.chat_id === "9" && m.text.includes("Aggiunto il trasporto"));
		const approve = notice?.reply_markup?.inline_keyboard[0]?.find((b) => b.text === "Approva")?.callback_data as string;
		expect(approve).toBe(`board:${card.id}:fatto`);
		telegram.updates.push([{ update_id: 31, callback_query: { id: "cqb1", from: { id: 7 }, message: { message_id: 6, chat: { id: 7 } }, data: approve } }]);
		telegram.updates.push([{ update_id: 32, callback_query: { id: "cqb2", from: { id: 9 }, message: { message_id: 6, chat: { id: 9 } }, data: approve } }]);
		await until(async () => telegram.sent.some((m) => m.chat_id === "9" && m.text === "Scheda #1 approvata e chiusa."));
		expect((await api("/api/board")).cards[0].status).toBe("fatto");
		expect(telegram.sent.some((m) => m.chat_id === "7")).toBe(false);
		telegram.updates.push([{ update_id: 33, callback_query: { id: "cqb3", from: { id: 9 }, message: { message_id: 6, chat: { id: 9 } }, data: approve } }]);
		await until(async () => telegram.sent.some((m) => m.chat_id === "9" && m.text.includes("non è più in «Da rivedere»")));

		expect((await send("PUT", `/api/board/${card.id}`, { status: "chiusa" })).status).toBe(400);

		// From a chat with Owni: a scheda for Ricercatore, waiting for a person to start it.
		const chat = (await api("/api/instances/owni/dm", {})).thread;
		await api(`/api/instances/owni/threads/${chat.id}/messages`, { text: '/tool board_create {"title":"Bozza newsletter","assignee":"Ricercatore"}' });
		await until(async () => (await api("/api/board")).cards.length === 2);
		const waiting = (await api("/api/board")).cards[1];
		expect(waiting).toMatchObject({ n: 2, status: "da_fare", createdBy: { kind: "agent", id: "owni" }, assignee: "ricerca" });
		const second = (await api(`/api/board/${waiting.id}/start`, {})).card;
		expect(second).toMatchObject({ status: "in_corso", work: { agent: "ricerca" } });
		expect((await api(`/api/board/${waiting.id}/start`, {})).error).toMatch(/non è più in «Da fare»/);
		// Monday morning the owner gets the week on the board (ADR 0081), once.
		await owni.scheduler.tick(new Date("2027-01-04T09:00:00Z"));
		await owni.scheduler.tick(new Date("2027-01-04T09:05:00Z"));
		await until(async () => telegram.sent.some((m) => m.chat_id === "9" && m.text.startsWith("La board, questa settimana.") && m.text.includes("Aperte: 0 da fare, 1 in corso, 0 da rivedere.")));
		expect(telegram.sent.filter((m) => m.text.startsWith("La board, questa settimana.")).map((m) => m.chat_id)).toEqual(["9"]);

		// A member sees only what concerns them, and hands nothing to an agente they cannot talk to.
		const { link, person } = await api("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		const theirs = await member("/api/board");
		expect(theirs.cards).toEqual([]);
		expect(theirs.agents.find((a: { id: string }) => a.id === "ricerca").canAssign).toBe(false);
		expect((await member("/api/board", { title: "x", assignee: "ricerca" })).error).toMatch(/Non puoi affidare schede a Ricercatore/);
		expect((await send("PUT", `/api/board/${card.id}`, { comment: "ciao" }, member.cookie)).status).toBe(404);
		await send("PUT", "/api/instances/ricerca/settings", { webPeople: [person.id] });
		expect((await member("/api/board")).cards.map((c: { n: number }) => c.n)).toEqual([1, 2]);
		expect((await send("DELETE", `/api/board/${card.id}`, undefined, member.cookie)).status).toBe(403);

		// Ricercatore deleted: its open scheda goes back to nobody.
		await send("DELETE", "/api/instances/ricerca", { confirm: "Ricercatore" });
		const after = (await api("/api/board")).cards;
		expect(after[1]).toMatchObject({ status: "da_fare" });
		expect(after[1].assignee).toBeUndefined();
		expect((await send("DELETE", `/api/board/${card.id}`)).status).toBe(200);
		const audit = await owni.runtime.audit("default").read();
		expect(audit.filter((e) => String(e.type).startsWith("board.")).map((e) => e.type)).toEqual(expect.arrayContaining(["board.card_created", "board.card_changed", "board.card_started", "board.card_deleted"]));
	});

	it("«Esegui da solo» (ADR 0061): the agente goes on after each reply, and stops in «Da rivedere»", async () => {
		const { owni, base, telegram } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "ricerca", name: "Ricercatore" });
		expect((await api("/api/board")).auto).toEqual({ replies: 10, hours: 2 });
		const { card } = await api("/api/board", { title: "Fornitori carta", assignee: "ricerca", auto: true });
		expect(card).toMatchObject({ status: "in_corso", auto: { rounds: 0 } });
		const entries = async () => (await api(`/api/instances/ricerca/threads/${card.work.threadId}`)).entries as { from: string; text?: string }[];
		// Nobody answers: after each reply it is told to go on, ten times, then it stops for review.
		await until(async () => (await api("/api/board")).cards[0].status === "da_rivedere", 20_000);
		const goOn = (await entries()).filter((e) => e.text?.startsWith("[Scheda #1] Vai avanti da solo"));
		expect(goOn).toHaveLength(10);
		const stopped = (await api("/api/board")).cards[0];
		expect(stopped.events.at(-1)).toMatchObject({ kind: "comment", by: { kind: "agent", id: "ricerca" }, text: expect.stringMatching(/dopo 10 risposte/) });
		await until(async () => telegram.sent.some((m) => m.chat_id === "9" && m.text.startsWith("Scheda #1 da rivedere: Fornitori carta")));
		// Nothing more is posted once it is in review.
		await new Promise((r) => setTimeout(r, 300));
		expect((await entries()).filter((e) => e.text?.startsWith("[Scheda #1] Vai avanti")).length).toBe(10);
		const audit = await owni.runtime.audit("default").read();
		expect(audit.some((e) => e.type === "board.card_created")).toBe(true);
	});

	it("sotto-schede (ADR 0066): an agente hands part of its scheda to another, and hears back when it is done", async () => {
		const { owni, base } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "ricerca", name: "Ricercatore" });
		await api("/api/instances", { id: "scrittore", name: "Scrittore" });
		const { card } = await api("/api/board", { title: "Newsletter", assignee: "ricerca" });
		const entries = async (agent: string, thread: string) => (await api(`/api/instances/${agent}/threads/${thread}`)).entries as { from: string; text?: string }[];
		await api(`/api/instances/ricerca/threads/${card.work.threadId}/messages`, { text: '/tool board_create {"title":"Testo","assignee":"scrittore","parent":"#1"}' });
		// The sotto-scheda is on the board as soon as it exists, and moves to «In corso» once its conversation opens.
		await until(async () => (await api("/api/board")).cards[1]?.status === "in_corso");
		const sub = (await api("/api/board")).cards[1];
		expect(sub).toMatchObject({ n: 2, parent: card.id, status: "in_corso", work: { agent: "scrittore" } });
		await until(async () => (await entries("scrittore", sub.work.threadId)).some((e) => e.text?.includes("Fa parte della scheda #1 «Newsletter»")));
		await api(`/api/instances/scrittore/threads/${sub.work.threadId}/messages`, { text: '/tool board_update {"status":"da_rivedere","comment":"Testo nel file"}' });
		await until(async () => (await entries("ricerca", card.work.threadId)).some((e) => e.text?.startsWith("[Scheda #1] Scrittore ha finito la sotto-scheda #2")));
		// From the console: a sotto-scheda of a scheda the person sees.
		const { card: mine } = await api("/api/board", { title: "Immagini", parent: card.id });
		expect(mine.parent).toBe(card.id);
		expect((await api("/api/board", { title: "x", parent: "c_nessuna" })).error).toMatch(/Scheda inesistente/);
	});

	it("a task programmato of an instance created from the console runs without a restart", async () => {
		const { owni, base } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "vendite", name: "Vendite" });
		const thread = (await api("/api/instances/vendite/dm", {})).thread;
		const at = new Date(Date.now() + 60_000).toISOString();
		await api("/api/instances/vendite/schedules", { instruction: "Controlla le offerte", at, threadId: thread.id });
		expect(await owni.scheduler.tick(new Date(Date.now() + 120_000))).toBe(1);
		await until(async () => ((await api(`/api/instances/vendite/threads/${thread.id}`)).entries as { from: string; text?: string }[]).some((e) => e.from === "owni" && e.text?.includes("Controlla le offerte")));
	});

	it("an events stream opened before the instance existed gets its replies live", async () => {
		const { owni, base } = await boot(tempDataDir());
		const token = (owni.ownerLink as string).split("#")[1] as string;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const abort = new AbortController();
		const stream = await fetch(`${base}/api/events`, { headers: { cookie }, signal: abort.signal });
		const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
		let received = "";
		const reading = (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					received += new TextDecoder().decode(value);
				}
			} catch {
				/* aborted */
			}
		})();
		const api = await client(base, owni.ownerLink as string);
		await api("/api/instances", { id: "vendite", name: "Vendite" });
		const thread = (await api("/api/instances/vendite/dm", {})).thread;
		await api(`/api/instances/vendite/threads/${thread.id}/messages`, { text: "ciao" });
		await until(async () => received.includes(`"threadId":"${thread.id}"`));
		abort.abort();
		await reading;
	});

	it("two owners creating the same id at once: one wins, the other gets a message", async () => {
		const { owni, base } = await boot(tempDataDir());
		const api = await client(base, owni.ownerLink as string);
		const results = await Promise.all([1, 2, 3].map(() => api("/api/instances", { id: "doppia", name: "Doppia" })));
		expect(results.filter((r) => r.instance !== undefined)).toHaveLength(1);
		for (const r of results.filter((r) => r.instance === undefined)) expect(r.error).toMatch(/esiste già/);
	});

	it("Telegram via webhook: the bot is registered, a pushed update with the right secret gets a reply, a wrong secret gets nothing", async () => {
		const telegram = fakeTelegram();
		const { base } = await boot(tempDataDir(), telegram, { OWNI_PUBLIC_URL: "https://owni.example", OWNI_TELEGRAM_WEBHOOK_SECRET: "hook_secret-123" });
		await until(async () => telegram.methods.includes("setWebhook"));
		expect(telegram.methods).not.toContain("getUpdates");
		const push = (secret: string, update: unknown) => fetch(`${base}/hooks/telegram/owni`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) });
		const update = { update_id: 1, message: { message_id: 3, chat: { id: 7 }, from: { id: 7 }, text: "ciao dal webhook" } };
		expect((await push("wrong", update)).status).toBe(401);
		expect((await fetch(`${base}/hooks/telegram/altra`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook_secret-123" }, body: "{}" })).status).toBe(404);
		expect((await push("hook_secret-123", update)).status).toBe(200);
		await waitFor(() => telegram.sent.some((m) => m.chat_id === "7" && m.text.includes("ciao dal webhook")));
		// The same update delivered again (Telegram retries) is answered once.
		expect((await push("hook_secret-123", update)).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(telegram.sent.filter((m) => m.chat_id === "7" && m.text.includes("ciao dal webhook"))).toHaveLength(1);
	});

	it("a cell: no owner link on disk, the control plane asks for one; the cell tells when it may sleep and when to wake it", async () => {
		const dataDir = tempDataDir();
		const { owni, base } = await boot(dataDir, fakeTelegram(), { OWNI_CELL_SECRET: "cell-secret-xyz-0001" });
		expect(owni.ownerLink).toBeUndefined();
		expect(existsSync(join(dataDir, "owner-login-link.txt"))).toBe(false);
		const { token: ownerToken } = (await (await fetch(`${base}/internal/owner-link`, { method: "POST", headers: { authorization: "Bearer cell-secret-xyz-0001" } })).json()) as { token: string };
		// Only through the control plane: without its header the cell knows nothing.
		expect((await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: ownerToken }) })).status).toBe(404);
		expect((await fetch(`${base}/`)).status).toBe(404);
		const api = await client(base, `${base}/login#${ownerToken}`, { "x-owni-proxy": proxyToken("cell-secret-xyz-0001") });
		expect((await api("/api/me")).person.role).toBe("owner");
		const state = (secret?: string) => fetch(`${base}/internal/cell`, { headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` } });
		expect((await state()).status).toBe(401);
		expect((await state("wrong")).status).toBe(401);
		expect(await (await state("cell-secret-xyz-0001")).json()).toEqual({ busy: false, nextWakeAt: null, usage: { day: romeDayKey(), todayUsd: 0, months: {} } });
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		await api("/api/instances/owni/schedules", { instruction: "Promemoria", at, threadId: thread.id });
		expect(await (await state("cell-secret-xyz-0001")).json()).toEqual({ busy: false, nextWakeAt: at, usage: { day: romeDayKey(), todayUsd: 0, months: {} } });
	});

	it("a cell gives the control plane a fresh owner link on request; the old link stops working", async () => {
		const { base } = await boot(tempDataDir(), fakeTelegram(), { OWNI_CELL_SECRET: "cell-secret-xyz-0001" });
		const ask = (secret: string) => fetch(`${base}/internal/owner-link`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
		expect((await ask("wrong-secret-000000")).status).toBe(401);
		const { token: ownerToken } = (await (await ask("cell-secret-xyz-0001")).json()) as { token: string };
		const { token } = (await (await ask("cell-secret-xyz-0001")).json()) as { token: string };
		expect(token).toMatch(/^[\w-]{40,}$/);
		const login = (t: string) => fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1", "x-owni-proxy": proxyToken("cell-secret-xyz-0001") }, body: JSON.stringify({ token: t }) });
		expect((await login(ownerToken)).status).toBe(401);
		expect((await login(token)).status).toBe(200);
	});

	it("without a cell secret there is no cell endpoint", async () => {
		const { base } = await boot(tempDataDir());
		expect((await fetch(`${base}/internal/cell`, { headers: { authorization: "Bearer x" } })).status).toBe(404);
	});

	it("the owner connects a Telegram bot to an instance from the console; it answers, survives a restart, and can be disconnected", async () => {
		const dataDir = tempDataDir();
		const telegram = fakeTelegram();
		const first = await boot(dataDir, telegram);
		const owner = await client(first.base, first.owni.ownerLink as string);
		await owner("/api/instances", { id: "vendite", name: "Vendite" });
		const put = (body: unknown) =>
			fetch(`${first.base}/api/instances/vendite/telegram`, { method: "PUT", headers: { "x-owni": "1", "content-type": "application/json", cookie: owner.cookie }, body: JSON.stringify(body) });
		expect((await put({ token: "bad", allowedUsers: ["8"] })).status).toBe(400);
		expect((await put({ token: "2:V", allowedUsers: ["8", "nope"] })).status).toBe(400);
		const connected = await put({ token: "2:V", allowedUsers: ["8"], approvers: ["8"] });
		expect(connected.status).toBe(200);
		const status = await owner("/api/instances/vendite/telegram");
		expect(status).toEqual({ telegram: { connected: true, username: "bot_2", mode: "polling", allowedUsers: ["8"], approvers: ["8"] } });
		expect(JSON.stringify(status)).not.toContain("2:V");
		telegram.queue("2:V").push([{ update_id: 1, message: { message_id: 4, chat: { id: 8 }, from: { id: 8 }, text: "ciao bot vendite" } }]);
		await waitFor(() => telegram.sent.some((m) => m.token === "2:V" && m.chat_id === "8" && m.text.includes("ciao bot vendite")));
		await first.owni.stop();
		running.splice(running.indexOf(first.owni), 1);

		const second = await boot(dataDir, telegram);
		const again = await client(second.base, first.owni.ownerLink as string);
		expect((await again("/api/instances/vendite/telegram")).telegram.connected).toBe(true);
		telegram.queue("2:V").push([{ update_id: 2, message: { message_id: 5, chat: { id: 8 }, from: { id: 8 }, text: "dopo il riavvio" } }]);
		await waitFor(() => telegram.sent.some((m) => m.token === "2:V" && m.text.includes("dopo il riavvio")));
		const off = await fetch(`${second.base}/api/instances/vendite/telegram`, { method: "DELETE", headers: { "x-owni": "1", cookie: again.cookie } });
		expect(off.status).toBe(200);
		expect((await again("/api/instances/vendite/telegram")).telegram.connected).toBe(false);
		const polls = telegram.calls.filter((c) => c.token === "2:V" && c.method === "getUpdates").length;
		await new Promise((r) => setTimeout(r, 200));
		expect(telegram.calls.filter((c) => c.token === "2:V" && c.method === "getUpdates").length).toBeLessThanOrEqual(polls + 1);
	});

	it("only the owner sees and changes an instance's Telegram bot", async () => {
		const { owni, base } = await boot(tempDataDir());
		const owner = await client(base, owni.ownerLink as string);
		const { link } = await owner("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await member("/api/instances/owni/telegram")).error).toBeDefined();
	});

	it("only the owner creates instances", async () => {
		const { owni, base } = await boot(tempDataDir());
		const owner = await client(base, owni.ownerLink as string);
		const { link } = await owner("/api/people", { name: "Anna", role: "member" });
		const member = await client(base, link);
		expect((await member("/api/instances", { id: "mia", name: "Mia" })).error).toBeDefined();
		expect((await owner("/api/instances")).instances.map((i: { id: string }) => i.id)).toEqual(["owni"]);
	});

	it("a data folder with the old registries still starts; their files are not read and not touched", async () => {
		const dataDir = tempDataDir();
		const first = await boot(dataDir);
		await first.owni.runtime.secrets("default").set("subjects.key", "chiave-vecchia");
		running.splice(running.indexOf(first.owni), 1);
		await first.owni.stop();
		const old = {
			[join(instanceDir(dataDir, toTenantId("default"), toInstanceId("owni")), "invoices.json")]: '{"company":{"vat":"IT00000010017"}}',
			[join(instanceDir(dataDir, toTenantId("default"), toInstanceId("owni")), "quotes.json")]: '{"quotes":[{"id":"2026-001"}]}',
			[join(instanceDir(dataDir, toTenantId("default"), toInstanceId("owni")), "agent-requests", "r1.json")]: '{"id":"r1","status":"pending"}',
			[join(tenantDir(dataDir, toTenantId("default")), "subjects.json")]: "cifrato-come-prima",
		};
		for (const [file, content] of Object.entries(old)) {
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, content);
		}
		const { base } = await boot(dataDir);
		const api = await client(base, first.owni.ownerLink as string);
		expect((await api("/api/instances")).instances.map((i: { id: string }) => i.id)).toEqual(["owni"]);
		const thread = (await api("/api/instances/owni/dm", {})).thread;
		await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: "ciao" });
		await until(async () => ((await api(`/api/instances/owni/threads/${thread.id}`)).entries as { from: string }[]).some((e) => e.from === "owni"));
		for (const [file, content] of Object.entries(old)) expect(readFileSync(file, "utf8"), file).toBe(content);
	});
});
