import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime } from "../src/core/index.ts";
import { instanceDir } from "../src/core/paths.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { connectChannel } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { RoomStore, Rooms } from "../src/web/rooms.ts";
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
	const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
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
		return async (path: string, body?: unknown) => {
			const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, "x-owni": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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

describe("direct conversations and threads (ADR 0112)", () => {
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
		expect(timeline.entries).toEqual([expect.objectContaining({ id: sent.id, text: "una domanda di prima", at: old.createdAt, thread: expect.objectContaining({ id: old.id, count: 1, unread: false }) })]);
		expect((await anna("/api/conversations")).body.direct[0].unread).toBe(false);
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
});
