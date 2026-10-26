import { EgressDenied, UserNotAllowed } from "../core/errors.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person } from "./auth.ts";
import type { WebChannel, WebEntry } from "./channel.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import { handles, type Room, type RoomEntry, RoomError } from "./rooms.ts";
import type { WebAppOptions } from "./server.ts";

export type RoomsRoutesDeps = Pick<WebAppOptions, "rooms" | "main"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly canChatWith: (record: InstanceRecord, person: Person) => boolean;
	readonly channelOf: (instanceId: string) => WebChannel;
	/** An entry with the name of the model that wrote it. */
	readonly shown: <E extends WebEntry | RoomEntry>(entry: E) => E;
};

/** A person's stanze and canali (ADR 0063, 0113), and the console's rail of conversations. */
export function roomsRoutes(route: AddRoute, options: RoomsRoutesDeps): void {
	const { runtime, tenantId, canChatWith, channelOf, shown } = options;
	const roomsOf = () => {
		if (options.rooms === undefined) throw new HttpError(501, "Le stanze non sono disponibili su questo server");
		return options.rooms;
	};
	/** `records`: the tenant's instances when the caller already read them, so each seat is not read again. */
	const roomView = async (room: Room, p: Person, records?: ReadonlyMap<string, InstanceRecord>) => {
		const agents = await Promise.all(
			room.seats.map(async (s) => {
				const record = records === undefined ? await runtime.registry.getInstance(tenantId, s.instanceId).catch(() => undefined) : records.get(s.instanceId);
				return { instanceId: s.instanceId, name: record?.name ?? s.instanceId, ...(record?.persona?.emoji === undefined ? {} : { emoji: record.persona.emoji }), present: record !== undefined && canChatWith(record, p) };
			}),
		);
		// The @nome the console offers is one the stanza reads as that agente.
		const short = handles(agents.filter((a) => a.present));
		return { id: room.id, title: room.title, updatedAt: room.updatedAt, ...(room.parent === undefined ? {} : { parent: room.parent }), agents: agents.map((a) => ({ ...a, handle: short.get(a.instanceId) ?? a.instanceId })) };
	};
	/** How a thread under a message of a canale reads there: how many replies, the last one, who wrote them. */
	const roomReplies = (thread: Room, said: readonly RoomEntry[]) => {
		const talk = said.filter((e) => e.from !== "note");
		return { id: thread.id, count: talk.length, ...(talk.length === 0 ? {} : { lastAt: (talk.at(-1) as RoomEntry).at }), who: [...new Set(talk.map((e) => (e.from === "person" ? "person" : (e.instanceId as string))))], unread: unread(thread) };
	};
	route("GET", "/api/rooms", "person", async ({ person: p }) => {
		return {
			rooms: await Promise.all(
				(await roomsOf().list(p.id)).map(async (r) => {
					const view = await roomView(r, p);
					// The last thing said, for the list: who and the start of it.
					const last = (await roomsOf().open(p.id, r.id))?.entries.findLast((e) => e.from !== "note");
					const who = last?.from === "person" ? "Tu" : view.agents.find((a) => a.instanceId === last?.instanceId)?.name;
					const said = last?.text ?? (last?.file !== undefined ? `file ${last.file.path}` : last?.artifact !== undefined ? `artifact ${last.artifact.title}` : undefined);
					return { ...view, ...(last === undefined || said === undefined ? {} : { last: { who: who ?? "?", text: said.replace(/\s+/g, " ").slice(0, 140) } }) };
				}),
			),
		};
	});
	route("POST", "/api/rooms", "person", async ({ person: p, req }) => {
		const body = (await readJson(req)) as { title?: unknown; agents?: unknown };
		const agents = Array.isArray(body.agents) ? body.agents.filter((a): a is string => typeof a === "string") : [];
		try {
			const room = await roomsOf().create(p.id, String(body.title ?? ""), agents);
			await runtime.audit(tenantId).append({ type: "room.created", personId: p.id, roomId: room.id, agents: room.seats.length });
			return { room: await roomView(room, p) };
		} catch (error) {
			return roomError(error);
		}
	});
	route("GET", "/api/rooms/:room", "person", async ({ person: p, params }) => {
		const opened = await roomsOf().open(p.id, params[0]);
		if (opened === undefined) throw new HttpError(404, "Canale non trovato");
		// Each message of a canale with the thread under it (ADR 0113).
		const under = new Map((await roomsOf().children(p.id, opened.room.id)).map((t) => [t.parent?.entryId, t] as const));
		const entries = await Promise.all(
			opened.entries.map(async (e) => {
				const thread = under.get(e.id);
				return thread === undefined ? shown(e) : { ...shown(e), thread: roomReplies(thread, (await roomsOf().open(p.id, thread.id))?.entries ?? []) };
			}),
		);
		return { room: await roomView(opened.room, p), entries };
	});
	route("PATCH", "/api/rooms/:room", "person", async ({ person: p, params, req }) => {
		const body = (await readJson(req)) as { title?: unknown; agents?: unknown };
		try {
			const room = await roomsOf().update(p.id, params[0], {
				...(typeof body.title === "string" ? { title: body.title } : {}),
				...(Array.isArray(body.agents) ? { instanceIds: body.agents.filter((a): a is string => typeof a === "string") } : {}),
			});
			if (room === undefined) throw new HttpError(404, "Canale non trovato");
			await runtime.audit(tenantId).append({ type: "room.updated", personId: p.id, roomId: room.id, agents: room.seats.length });
			return { room: await roomView(room, p) };
		} catch (error) {
			return roomError(error);
		}
	});
	// The thread under a message of a canale, made on first use (ADR 0113).
	route("POST", "/api/rooms/:room/threads", "person", async ({ person: p, params, req }) => {
		const body = (await readJson(req)) as { parent?: unknown };
		if (typeof body.parent !== "string") throw new HttpError(400, "Serve il messaggio a cui risponde il thread");
		try {
			const thread = await roomsOf().thread(p.id, params[0], body.parent);
			if (thread === undefined) throw new HttpError(404, "Messaggio non trovato");
			return { room: await roomView(thread, p) };
		} catch (error) {
			return roomError(error);
		}
	});
	route("POST", "/api/rooms/:room/messages", "person", async ({ person: p, params, req }) => {
		const body = (await readJson(req)) as { text?: unknown };
		try {
			return { entry: await roomsOf().post(p.id, params[0], String(body.text ?? "")) };
		} catch (error) {
			return roomError(error);
		}
	});
	route("POST", "/api/rooms/:room/read", "person", async ({ person, params }) => {
		if (!(await roomsOf().markRead(person.id, params[0]))) throw new HttpError(404, "Canale non trovato");
		return { ok: true };
	});
	// The console's rail (ADR 0113): a direct conversation for each agente the person can write to, the general one first, and their canali.
	route("GET", "/api/conversations", "person", async ({ person: p }) => {
		const instances = await runtime.registry.listInstances(tenantId);
		const agents = instances.filter((r) => canChatWith(r, p));
		agents.sort((a, b) => Number(b.id === options.main) - Number(a.id === options.main));
		const direct = await Promise.all(
			agents.map(async (r) => {
				const threads = await channelOf(r.id).threads(p.id);
				const dm = threads.find((t) => t.dm === true);
				const updatedAt = threads.map((t) => t.updatedAt).sort().at(-1);
				return { instanceId: r.id, ...(dm === undefined ? {} : { threadId: dm.id }), ...(updatedAt === undefined ? {} : { updatedAt }), unread: threads.some(unread) };
			}),
		);
		const rooms = options.rooms === undefined ? [] : await options.rooms.listWithThreads(p.id);
		const records = new Map(instances.map((r) => [String(r.id), r]));
		// A canale is unread when it or a thread under it is.
		const channels = await Promise.all(rooms.map(async ({ room, threads }) => ({ ...(await roomView(room, p, records)), unread: unread(room) || threads.some(unread) })));
		return { direct, channels: channels.sort((a, b) => a.title.localeCompare(b.title, "it")) };
	});
	route("DELETE", "/api/rooms/:room", "person", async ({ person: p, params }) => {
		if (!(await roomsOf().remove(p.id, params[0]))) throw new HttpError(404, "Canale non trovato");
		await runtime.audit(tenantId).append({ type: "room.deleted", personId: p.id, roomId: params[0] });
		return { ok: true };
	});
}

/** A conversation is unread when something came after the person last read it. */
export const unread = (c: { readonly updatedAt: string; readonly readAt?: string }) => c.updatedAt > (c.readAt ?? c.updatedAt);

/** What a stanza refuses, as the HTTP answer. */
export const roomError = (error: unknown): never => {
	if (error instanceof RoomError) throw new HttpError(400, error.message);
	if (error instanceof UserNotAllowed) throw new HttpError(403, "Non sei tra le persone che possono scrivere a uno di questi agenti");
	if (error instanceof EgressDenied) throw new HttpError(403, "Uno di questi agenti non accetta messaggi dal web");
	throw error;
};
