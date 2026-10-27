import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardStore } from "../src/core/board.ts";
import { BoardWork } from "../src/core/board-work.ts";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { instanceDir } from "../src/core/paths.ts";
import { OwniRuntime } from "../src/core/runtime.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { connectChannel } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { Rooms, RoomStore } from "../src/web/rooms.ts";
import { createWebApp } from "../src/web/server.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of closers.splice(0).reverse()) await close(); });

async function setup(options: { ttlMs?: number; fakeInterval?: boolean } = {}) {
	const dataDir = tempDataDir();
	const tenantDir = join(dataDir, "tenants", "acme");
	const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	const people = new PeopleStore(tenantDir);
	const sessions = new SessionStore(tenantDir, options.ttlMs);
	const owner = await people.add("Mario", "owner");
	const anna = await people.add("Anna", "member");
	await runtime.registry.createInstance("acme", { id: "ops", name: "Ops", model: FAUX_MODEL, allowedUsers: { web: [anna.person.id] }, egress: { modelProviders: ["faux"], channels: ["web"] } });
	await runtime.registry.createInstance("acme", { id: "sales", name: "Vendite", model: FAUX_MODEL, allowedUsers: { web: [anna.person.id] }, egress: { modelProviders: ["faux"], channels: ["web"] } });
	const channels = new Map<string, WebChannel>();
	for (const id of ["ops", "sales"]) {
		const own = new WebChannel({ tenantId: "acme", instanceId: id }, instanceDir(dataDir, tenantId("acme"), instanceId(id)));
		connectChannel(runtime, own, { tenantId: "acme", instanceId: id });
		channels.set(id, own);
	}
	const channel = channels.get("ops") as WebChannel;
	const rooms = new Rooms(new RoomStore(join(tenantDir, "rooms")), {
		channel: (id) => channels.get(id),
		reachable: async (personId, id) => {
			const record = await runtime.registry.getInstance("acme", id);
			return (record.allowedUsers.web ?? []).includes(personId) ? record.name : undefined;
		},
		place: () => "",
	});
	for (const own of channels.values()) rooms.attach(own);
	const store = new BoardStore(tenantDir);
	const work = new BoardWork({ store, agentName: async () => "Ops", canChat: async () => true, isOwner: async (id) => id === owner.person.id, owners: async () => [owner.person.id], personName: async (id) => (await people.get(id))?.name, openThread: async () => "unused", post: async () => {} });
	const server = createWebApp({
		runtime, tenantId: "acme", people, sessions, channels, rooms, board: { store, work },
		connectors: (id) => new ConnectorStore(instanceDir(dataDir, tenantId("acme"), instanceId(id))), connectorStatus: () => [],
		usage: new UsageLedger(tenantDir), uiDir: join(import.meta.dirname, "../src/web/ui"), secureCookies: false, defaultTimeZone: "Europe/Rome",
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await runtime.close(); });
	// Only the keep-alive interval: the server and the stream need the real clock for everything else.
	if (options.fakeInterval) vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const session = await sessions.create(anna.person.id);
	const abort = new AbortController();
	closers.push(async () => { abort.abort(); });
	const response = await fetch(`${base}/api/events`, { headers: { cookie: `owni_session=${session}`, "x-owni": "1" }, signal: abort.signal });
	const stream = { output: "", ended: false };
	void (async () => {
		for await (const chunk of response.body!) stream.output += new TextDecoder().decode(chunk);
		stream.ended = true;
	})().catch(() => { stream.ended = true; });
	await waitFor(() => stream.output.includes(": connected"));
	const thread = await channel.createThread(anna.person.id, "Chat");
	const room = await rooms.create(anna.person.id, "Vendite", ["ops", "sales"]);
	const entry = (text: string) => ({ id: `e-${text}`, at: new Date().toISOString(), from: "owni" as const, text });
	const emit = {
		entry: (text: string) => channel.events.emit(anna.person.id, { instanceId: "ops", threadId: thread.id, entry: entry(text) }),
		room: (text: string, roomId = room.id) => rooms.events.emit(anna.person.id, { roomId, entry: entry(text) }),
		board: (text: string) => work.events.emit("review", { card: { id: "c1", n: 1, title: text, status: "da_rivedere", events: [] } as never, people: [anna.person.id] }),
	};
	return { runtime, anna, people, sessions, session, stream, emit, base };
}

const FAMILIES = ["entry", "room", "board"] as const;

describe("the live stream asks again before every event, not only the run ones", () => {
	it.each(FAMILIES)("delivers a %s event to a live session", async (family) => {
		const s = await setup();
		s.emit[family]("VISIBLE");
		await waitFor(() => s.stream.output.includes("VISIBLE"));
	});

	it.each(FAMILIES)("after the session is revoked, a %s event is not written and the stream closes (no run event needed)", async (family) => {
		const s = await setup();
		await s.sessions.end(s.session);
		s.emit[family]("SECRET-AFTER-REVOKE");
		await waitFor(() => s.stream.ended);
		expect(s.stream.output).not.toContain("SECRET-AFTER-REVOKE");
	});

	it.each(FAMILIES)("after every session of the person ends, a %s event is not written and the stream closes", async (family) => {
		const s = await setup();
		await s.sessions.endAllOf(s.anna.person.id);
		s.emit[family]("SECRET-AFTER-END-ALL");
		await waitFor(() => s.stream.ended);
		expect(s.stream.output).not.toContain("SECRET-AFTER-END-ALL");
	});

	it("an entry of an agent the person can no longer open is not written, and the stream stays for the rest", async () => {
		const s = await setup();
		await s.runtime.registry.setAllowedUsers("acme", "ops", "web", []);
		s.emit.entry("SECRET-REVOKED-AGENT");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(s.stream.output).not.toContain("SECRET-REVOKED-AGENT");
		expect(s.stream.ended).toBe(false);
	});

	it("a stanza event for a room the person no longer has is not written", async () => {
		const s = await setup();
		s.emit.room("SECRET-OTHER-ROOM", "r_gone");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(s.stream.output).not.toContain("SECRET-OTHER-ROOM");
		expect(s.stream.ended).toBe(false);
	});

	it("a healthy client survives a synchronous burst of board news, and gets all of it", async () => {
		const s = await setup();
		for (let n = 0; n < 300; n++) s.emit.board(`news-${n}`);
		await waitFor(() => s.stream.output.includes("news-299"));
		expect(s.stream.output).toContain("news-0");
		expect(s.stream.ended).toBe(false);
	});

	it("a client that really stalls is cut off instead of queueing without limit", async () => {
		const s = await setup();
		// A second stream that opens and then never reads: the socket fills, then the server's own buffer.
		const stalled = { ended: false };
		await new Promise<void>((resolve) => {
			const req = request(`${s.base}/api/events`, { headers: { cookie: `owni_session=${s.session}`, "x-owni": "1" } }, (res) => {
				res.pause();
				closers.push(async () => { req.destroy(); });
				setTimeout(() => {
					res.on("end", () => { stalled.ended = true; });
					res.on("error", () => { stalled.ended = true; });
					res.resume();
				}, 3000);
				resolve();
			});
			req.end();
		});
		const big = "x".repeat(100_000);
		for (let n = 0; n < 300; n++) s.emit.entry(big);
		await waitFor(() => stalled.ended, 15_000);
		expect(s.stream.ended).toBe(false);
	}, 30_000);

	it("a person removed from the people list loses the stream, session or not", async () => {
		const s = await setup();
		await s.people.remove(s.anna.person.id);
		s.emit.entry("SECRET-REMOVED-PERSON");
		await waitFor(() => s.stream.ended);
		expect(s.stream.output).not.toContain("SECRET-REMOVED-PERSON");
	});

	it("an idle stream closes on the next keep-alive once its session is revoked", async () => {
		const s = await setup({ fakeInterval: true });
		await s.sessions.end(s.session);
		await vi.advanceTimersByTimeAsync(25_000);
		await waitFor(() => s.stream.ended);
		expect(s.stream.output).not.toContain(": ping");
	});

	it("a session that expires closes the stream, and the event is not written", async () => {
		const s = await setup({ ttlMs: 1500 });
		await new Promise((resolve) => setTimeout(resolve, 1700));
		s.emit.entry("SECRET-AFTER-EXPIRY");
		await waitFor(() => s.stream.ended);
		expect(s.stream.output).not.toContain("SECRET-AFTER-EXPIRY");
	});
});
