import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime } from "../src/core/index.ts";
import { createThreadTools } from "../src/core/tools/thread-tools.ts";
import { instanceDir } from "../src/core/paths.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { connectChannel } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { RoomStore, Rooms } from "../src/web/rooms.ts";
import { threadUnder } from "../src/web/thread-replies.ts";
import { createWebApp } from "../src/web/server.ts";
import { FAUX_MODEL, tempDataDir } from "./helpers.ts";

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/** Two agenti, Ops (the general one) and Vendite; Anna writes to both, Luca to Ops; Mario owns the instance. */
async function setup() {
	const dataDir = tempDataDir();
	// thread_reply as the app wires it (ADR 0133): the rest of an agente's tools are not needed here.
	const runtime: OwniRuntime = new OwniRuntime({
		dataDir,
		engine: piDurableEngine,
		tools: async (record) => createThreadTools({ open: (at) => threadUnder({ runtime, channel: channels.get(record.id) as WebChannel, rooms, tenantId: "acme", instanceId: record.id }, at), send: (m) => runtime.sendMessage("acme", record.id, m) }),
	});
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	const tenantDir = join(dataDir, "tenants", "acme");
	const people = new PeopleStore(tenantDir);
	const owner = await people.add("Mario", "owner");
	const anna = await people.add("Anna", "member");
	const luca = await people.add("Luca", "member");
	const agents = { ops: { name: "Ops", users: [anna.person.id, luca.person.id] }, sales: { name: "Vendite", users: [anna.person.id] } };
	const channels = new Map<string, WebChannel>();
	for (const [id, a] of Object.entries(agents)) {
		await runtime.registry.createInstance("acme", { id, name: a.name, model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["web"] }, allowedUsers: { web: a.users } });
		const channel = new WebChannel({ tenantId: "acme", instanceId: id }, instanceDir(dataDir, tenantId("acme"), instanceId(id)));
		connectChannel(runtime, channel, { tenantId: "acme", instanceId: id });
		channels.set(id, channel);
	}
	const rooms = new Rooms(new RoomStore(join(tenantDir, "rooms")), {
		channel: (id) => channels.get(id),
		reachable: async (personId, id) => {
			const record = await runtime.registry.getInstance("acme", id);
			return (record.allowedUsers.web ?? []).includes(personId) ? record.name : undefined;
		},
		place: () => "",
	});
	for (const c of channels.values()) rooms.attach(c);
	const server = createWebApp({
		runtime,
		tenantId: "acme",
		people,
		sessions: new SessionStore(tenantDir),
		channels,
		rooms,
		main: "ops",
		connectors: (id) => new ConnectorStore(instanceDir(dataDir, tenantId("acme"), instanceId(id))),
		connectorStatus: () => [],
		usage: new UsageLedger(tenantDir),
		uiDir: join(import.meta.dirname, "..", "src", "web", "ui"),
		secureCookies: false,
		defaultTimeZone: "Europe/Rome",
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
		await runtime.close();
	});
	const as = async (token: string) => {
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1", "content-type": "application/json" }, body: JSON.stringify({ token }) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
			const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: res.status, body: (await res.json()) as any };
		};
	};
	return { runtime, channels, dataDir, owner, anna, luca, as };
}

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["as"]>>;

/** Write in a thread and wait for the agente's answer to it. */
async function say(client: Client, agent: string, threadId: string, text: string) {
	const sent = (await client(`/api/instances/${agent}/threads/${threadId}/messages`, { text })).body.entry;
	let answer: any;
	await until(async () => {
		const { thread, entries } = (await client(`/api/instances/${agent}/threads/${threadId}`)).body as { thread: { updatedAt: string }; entries: any[] };
		answer = entries.find((e) => e.from === "owni" && e.at >= sent.at && e.text.includes(text));
		// The thread is read before its transcript: written down once it is as late as the answer.
		return answer !== undefined && thread.updatedAt >= answer.at;
	});
	return { sent, answer };
}

/** Write in a canale or a thread of one and wait for an agente's answer that repeats `text`. */
async function sayInRoom(client: Client, roomId: string, text: string) {
	const sent = (await client(`/api/rooms/${roomId}/messages`, { text })).body.entry;
	let answer: any;
	await until(async () => {
		answer = ((await client(`/api/rooms/${roomId}`)).body.entries as any[]).find((e) => e.from === "agent" && e.at >= sent.at && e.text.includes(text));
		return answer !== undefined;
	});
	return { sent, answer };
}

/**
 * Wait for the agenti of a canale to be done. The test model repeats what it is told, @nomi included,
 * so they call each other until the chain stops with its note.
 */
async function settled(client: Client, roomId: string, notes: number) {
	await until(async () => ((await client(`/api/rooms/${roomId}`)).body.entries as any[]).filter((e) => e.from === "note").length >= notes);
}

describe("direct conversations and threads (ADR 0113)", () => {
	it("one direct conversation per person and agente, however many open it at once", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const opened = await Promise.all([1, 2, 3].map(() => anna("/api/instances/ops/dm", {})));
		const ids = new Set(opened.map((r) => r.body.thread.id));
		expect(ids.size).toBe(1);
		const [id] = [...ids] as [string];
		expect((await anna("/api/instances/ops/dm")).body.thread).toMatchObject({ id, dm: true });
		expect((await anna("/api/instances/ops/threads")).body.threads.map((t: any) => t.id)).toEqual([id]);
		// Another agente, another person: each its own.
		expect((await anna("/api/instances/sales/dm", {})).body.thread.id).not.toBe(id);
		const luca = await h.as(h.luca.token);
		expect((await luca("/api/instances/ops/dm")).body.thread).toBeUndefined();
		expect((await luca("/api/instances/ops/dm", {})).body.thread.id).not.toBe(id);
		// Who may not write to the agente opens none.
		expect((await luca("/api/instances/sales/dm", {})).status).toBe(404);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/dm", {})).status).toBe(403);
		expect((await anna("/api/instances")).body.instances.map((i: any) => [i.id, i.main ?? false])).toEqual([["ops", true], ["sales", false]]);
	});

	it("the agente answers in the thread under the person's message, and the thread's first turn knows what it wrote there (ADR 0133)", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const dm = (await anna("/api/instances/ops/dm", {})).body.thread;
		const chosen = { provider: "faux", modelId: "owni-dev" };
		await h.runtime.setChatModel("acme", "ops", { channel: "web", threadId: dm.id }, chosen, h.anna.person.id);
		const sent = (await anna(`/api/instances/ops/threads/${dm.id}/messages`, { text: '/tool thread_reply {"text":"Il report, voce per voce"}' })).body.entry;
		let timeline: any[] = [];
		await until(async () => {
			timeline = (await anna("/api/instances/ops/dm")).body.entries;
			return timeline.some((e) => e.from === "owni") && timeline[0]?.thread !== undefined;
		});
		// In the conversation: the person's message with the thread under it, and the turn's short end.
		expect(timeline.map((e) => [e.id === sent.id, e.from])).toEqual([[true, "person"], [false, "owni"]]);
		expect(timeline[1].text).toContain("Risposta scritta nel thread");
		expect(timeline[0].thread).toMatchObject({ count: 1, who: ["owni"] });
		const thread = timeline[0].thread.id as string;
		// The thread the agente opened answers with the model the person chose, as one the person opens.
		expect(await h.runtime.chatModel("acme", "ops", "web", thread)).toEqual(chosen);
		expect((await anna(`/api/instances/ops/threads/${thread}`)).body.entries.map((e: any) => [e.from, e.text])).toEqual([["owni", "Il report, voce per voce"]]);
		// The thread's first turn is told the message it answers and what the agente already wrote there.
		const first = await say(anna, "ops", thread, "più corto");
		expect(first.answer.text).toContain("dati del thread");
		expect(first.answer.text).toContain("Nel thread hai già risposto tu (Ops)");
		expect(first.answer.text).toContain("Il report, voce per voce");
		expect((await say(anna, "ops", thread, "grazie")).answer.text).not.toContain("hai già risposto");
		// Inside the thread no other thread opens.
		await anna(`/api/instances/ops/threads/${thread}/messages`, { text: '/tool thread_reply {"text":"ancora"}' });
		await until(async () => ((await anna(`/api/instances/ops/threads/${thread}`)).body.entries as any[]).some((e) => e.text?.includes("qui non si apre un thread")));
	});

	it("a thread under a message: the same one each time, out of the lists, its first turn told what it answers", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const dm = (await anna("/api/instances/ops/dm", {})).body.thread;
		const { sent, answer } = await say(anna, "ops", dm.id, "prepara il report di ottobre");
		const made = await Promise.all([1, 2].map(() => anna("/api/instances/ops/threads", { parent: sent.id })));
		expect(made.map((r) => r.status)).toEqual([200, 200]);
		const thread = made[0]?.body.thread;
		expect(made[1]?.body.thread.id).toBe(thread.id);
		expect(thread.parent).toEqual({ threadId: dm.id, entryId: sent.id });
		expect((await anna("/api/instances/ops/threads", { parent: "m_nessuno" })).status).toBe(404);
		expect((await anna("/api/instances/ops/threads", {})).status).toBe(400);
		// Not a chat of its own in any list.
		expect((await anna("/api/instances/ops/threads")).body.threads.map((t: any) => t.id)).toEqual([dm.id]);
		const first = await say(anna, "ops", thread.id, "più corto");
		expect(first.answer.text).toContain("dati del thread");
		expect(first.answer.text).toContain("prepara il report di ottobre");
		expect(first.answer.text).toContain("scritto da lei");
		// The transcript keeps the person's words alone; the next turn is not told again.
		expect(first.sent.text).toBe("più corto");
		const second = await say(anna, "ops", thread.id, "grazie");
		expect(second.answer.text).not.toContain("dati del thread");
		const timeline = (await anna("/api/instances/ops/dm")).body.entries as any[];
		expect(timeline.map((e) => e.id)).toEqual([sent.id, answer.id]);
		expect(timeline[0].thread).toMatchObject({ id: thread.id, count: 4, lastAt: second.answer.at, who: ["person", "owni"] });
		expect(timeline[1].thread).toBeUndefined();
		// Under the agente's answer: the thread is told the agente wrote it.
		const under = (await anna("/api/instances/ops/threads", { parent: answer.id })).body.thread;
		expect((await say(anna, "ops", under.id, "spiega")).answer.text).toContain("scritto da te (Ops)");
	});

	it("nobody else reads a member's direct conversation or threads, not even the owner", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const dm = (await anna("/api/instances/ops/dm", {})).body.thread;
		const { sent } = await say(anna, "ops", dm.id, "dato riservato");
		const thread = (await anna("/api/instances/ops/threads", { parent: sent.id })).body.thread;
		for (const token of [h.luca.token, h.owner.token]) {
			const other = await h.as(token);
			expect((await other("/api/instances/ops/dm")).body).toEqual({ entries: [] });
			for (const id of [dm.id, thread.id]) {
				expect((await other(`/api/instances/ops/threads/${id}`)).status).toBe(404);
				expect((await other(`/api/instances/ops/threads/${id}/messages`, { text: "intruso" })).status).toBe(400);
				expect((await other(`/api/instances/ops/threads/${id}/read`, {})).status).toBe(404);
			}
			expect((await other("/api/instances/ops/threads", { parent: sent.id })).status).not.toBe(200);
			expect(JSON.stringify((await other("/api/conversations")).body)).not.toContain(dm.id);
		}
	});

	it("unread until seen: direct conversations and canali, in the rail with the general agente first", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const empty = (await anna("/api/conversations")).body;
		expect(empty).toEqual({ direct: [{ instanceId: "ops", unread: false }, { instanceId: "sales", unread: false }], channels: [] });
		const dm = (await anna("/api/instances/sales/dm", {})).body.thread;
		await say(anna, "sales", dm.id, "ciao");
		// The agente answered after the person last looked.
		const rail = (await anna("/api/conversations")).body;
		expect(rail.direct[1]).toMatchObject({ instanceId: "sales", threadId: dm.id, unread: true });
		expect((await anna(`/api/instances/sales/threads/${dm.id}/read`, {})).status).toBe(200);
		expect((await anna("/api/conversations")).body.direct[1].unread).toBe(false);
		// A thread's answer counts for its conversation.
		const { sent } = await say(anna, "sales", dm.id, "altro");
		await anna(`/api/instances/sales/threads/${dm.id}/read`, {});
		const thread = (await anna("/api/instances/sales/threads", { parent: sent.id })).body.thread;
		await say(anna, "sales", thread.id, "dimmi");
		expect((await anna("/api/conversations")).body.direct[1].unread).toBe(true);
		await anna(`/api/instances/sales/threads/${thread.id}/read`, {});
		expect((await anna("/api/conversations")).body.direct[1].unread).toBe(false);
		// A canale.
		const room = (await anna("/api/rooms", { title: "Lancio", agents: ["ops", "sales"] })).body.room;
		expect((await anna("/api/conversations")).body.channels).toEqual([expect.objectContaining({ id: room.id, title: "Lancio", unread: false })]);
		await anna(`/api/rooms/${room.id}/messages`, { text: "@ops ci sei?" });
		await until(async () => (await anna("/api/conversations")).body.channels[0].unread === true);
		expect((await anna(`/api/rooms/${room.id}/read`, {})).status).toBe(200);
		expect((await anna("/api/conversations")).body.channels[0].unread).toBe(false);
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/rooms/${room.id}/read`, {})).status).toBe(404);
		expect((await luca("/api/conversations")).body).toEqual({ direct: [{ instanceId: "ops", unread: false }], channels: [] });
	});

	it("chats from before show in the direct conversation as messages with their replies, read until they change", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const channel = h.channels.get("ops") as WebChannel;
		const old = await channel.createThread(h.anna.person.id, "Chat");
		const { sent } = await say(anna, "ops", old.id, "una domanda di prima");
		// Made before the read marker: read.
		const file = join(instanceDir(h.dataDir, tenantId("acme"), instanceId("ops")), "web", "threads", `${old.id}.json`);
		const { readAt: _, ...stored } = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify(stored));
		await channel.createThread(h.anna.person.id, "Chat"); // never written in: not shown
		const timeline = (await anna("/api/instances/ops/dm")).body;
		expect(timeline.thread).toBeUndefined();
		expect(timeline.entries).toEqual([expect.objectContaining({ id: sent.id, text: "una domanda di prima", at: sent.at, threadId: old.id, thread: expect.objectContaining({ id: old.id, count: 1, unread: false }) })]);
		expect((await anna("/api/conversations")).body.direct[0].unread).toBe(false);
	});

	it("a chat that goes on answering shows where it last spoke, and what the agente is sent on its own leaves it unread", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const channel = h.channels.get("ops") as WebChannel;
		const brief = await channel.createThread(h.anna.person.id, "Brief");
		const first = await say(anna, "ops", brief.id, "il brief di ieri");
		const dm = (await anna("/api/instances/ops/dm", {})).body.thread;
		const { sent } = await say(anna, "ops", dm.id, "nel mezzo");
		const before = (await channel.thread(brief.id))?.readAt;
		await channel.post(brief.id, h.anna.person.id, "il brief di oggi", { origin: "scheduled" });
		// Not the person's words: what they had not read yet stays unread.
		expect((await channel.thread(brief.id))?.readAt).toBe(before);
		await until(async () => (await channel.transcript(brief.id)).some((e) => e.from === "owni" && e.text?.includes("il brief di oggi")));
		const { entries } = (await anna("/api/instances/ops/dm")).body as { entries: any[] };
		expect(entries.map((e) => e.id)).toEqual([sent.id, expect.any(String), first.sent.id]);
		expect(entries.at(-1)).toEqual(expect.objectContaining({ threadId: brief.id, thread: expect.objectContaining({ id: brief.id, count: 3, unread: true }) }));
	});

	it("a thread answers with the model the person chose for the conversation", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const dm = (await anna("/api/instances/ops/dm", {})).body.thread;
		const { sent } = await say(anna, "ops", dm.id, "ciao");
		const chosen = { provider: "faux", modelId: "owni-dev" };
		await h.runtime.setChatModel("acme", "ops", { channel: "web", threadId: dm.id }, chosen, h.anna.person.id);
		const thread = (await anna("/api/instances/ops/threads", { parent: sent.id })).body.thread;
		expect(await h.runtime.chatModel("acme", "ops", "web", thread.id)).toEqual(chosen);
	});

	it("a thread under a message of a canale: its agenti, out of the lists, told what it answers, the canale unread for it", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const room = (await anna("/api/rooms", { title: "Lancio", agents: ["ops", "sales"] })).body.room;
		const { sent } = await sayInRoom(anna, room.id, "@ops prepara il piano di lancio");
		await settled(anna, room.id, 1);
		await anna(`/api/rooms/${room.id}/read`, {});
		const made = await Promise.all([1, 2].map(() => anna(`/api/rooms/${room.id}/threads`, { parent: sent.id })));
		expect(made.map((r) => r.status)).toEqual([200, 200]);
		const thread = made[0]?.body.room;
		expect(made[1]?.body.room.id).toBe(thread.id);
		expect(thread).toMatchObject({ title: "Lancio", parent: { roomId: room.id, entryId: sent.id } });
		expect(thread.agents.map((a: any) => a.instanceId)).toEqual(["ops", "sales"]);
		expect((await anna(`/api/rooms/${room.id}/threads`, { parent: "m_nessuno" })).status).toBe(404);
		expect((await anna(`/api/rooms/${thread.id}/threads`, { parent: sent.id })).status).toBe(404);
		// Not a canale of its own in any list.
		expect((await anna("/api/rooms")).body.rooms.map((r: any) => r.id)).toEqual([room.id]);
		expect((await anna("/api/conversations")).body.channels.map((c: any) => c.id)).toEqual([room.id]);
		// The first call of each agente in the thread is told the message it answers; @nome works as in the canale.
		const first = await sayInRoom(anna, thread.id, "@vendite più corto");
		expect(first.answer).toMatchObject({ instanceId: "sales" });
		expect(first.answer.text).toContain("Thread nel canale «Lancio»");
		expect(first.answer.text).toContain("dati del thread");
		expect(first.answer.text).toContain("prepara il piano di lancio");
		expect(first.answer.text).toContain("scritto dalla persona");
		// Ops, called by Vendite's answer, is told too: its first call in the thread.
		await settled(anna, thread.id, 1);
		const said = (await anna(`/api/rooms/${thread.id}`)).body.entries as any[];
		const byOps = said.find((e) => e.instanceId === "ops");
		expect(byOps.text).toContain("dati del thread");
		expect(byOps.text).toContain("scritto dalla persona");
		// Under the message in the canale: how many replies, the last, who wrote them.
		const talk = said.filter((e) => e.from !== "note");
		const shown = ((await anna(`/api/rooms/${room.id}`)).body.entries as any[]).find((e) => e.id === sent.id);
		expect(shown.thread).toMatchObject({ id: thread.id, count: talk.length, lastAt: talk.at(-1).at, who: ["person", "sales", "ops"], unread: true });
		expect((await anna("/api/conversations")).body.channels[0].unread).toBe(true);
		await anna(`/api/rooms/${thread.id}/read`, {});
		expect((await anna("/api/conversations")).body.channels[0].unread).toBe(false);
		// Nobody else opens it, the owner neither.
		for (const token of [h.luca.token, h.owner.token]) {
			const other = await h.as(token);
			expect((await other(`/api/rooms/${thread.id}`)).status).toBe(404);
			expect((await other(`/api/rooms/${room.id}/threads`, { parent: sent.id })).status).toBe(404);
			expect((await other(`/api/rooms/${thread.id}/messages`, { text: "intruso" })).status).toBe(400);
			expect((await other(`/api/rooms/${thread.id}/read`, {})).status).toBe(404);
		}
		// Deleting the canale deletes its threads.
		expect((await anna(`/api/rooms/${room.id}`, undefined, "DELETE")).status).toBe(200);
		expect((await anna(`/api/rooms/${thread.id}`)).status).toBe(404);
	});

	it("a canale changes name and agenti, and its threads follow", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const room = (await anna("/api/rooms", { title: "Lancio", agents: ["ops", "sales"] })).body.room;
		const { sent } = await sayInRoom(anna, room.id, "@ops ciao");
		await settled(anna, room.id, 1);
		const thread = (await anna(`/api/rooms/${room.id}/threads`, { parent: sent.id })).body.room;
		expect((await anna(`/api/rooms/${room.id}`, { agents: ["ops"] }, "PATCH")).status).toBe(400);
		// No name: the agenti's, as when it was made.
		expect((await anna(`/api/rooms/${room.id}`, { title: "  " }, "PATCH")).body.room).toMatchObject({ title: "Ops, Vendite" });
		expect((await anna(`/api/rooms/${thread.id}`, { title: "Altro" }, "PATCH")).status).toBe(404);
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/rooms/${room.id}`, { title: "Mio" }, "PATCH")).status).toBe(404);
		const renamed = await anna(`/api/rooms/${room.id}`, { title: "Lancio autunno" }, "PATCH");
		expect(renamed.body.room).toMatchObject({ id: room.id, title: "Lancio autunno" });
		expect((await anna(`/api/rooms/${thread.id}`)).body.room.title).toBe("Lancio autunno");
		// Out and back in: the thread follows the canale's agenti.
		expect((await anna(`/api/rooms/${room.id}`, { agents: ["sales", "ops"] }, "PATCH")).status).toBe(200);
		expect((await anna(`/api/rooms/${thread.id}`)).body.room.agents.map((a: any) => a.instanceId)).toEqual(["ops", "sales"]);
		// Luca cannot write to Vendite: no canale of his has it.
		expect((await luca("/api/rooms", { title: "Suo", agents: ["ops", "sales"] })).status).toBe(400);
	});
});
