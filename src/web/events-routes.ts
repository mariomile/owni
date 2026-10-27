import type { IncomingMessage } from "node:http";
import { dueText } from "../core/board.ts";
import type { BoardReview } from "../core/board-work.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person } from "./auth.ts";
import { WebChannel, type WebEntry, type WebEvent } from "./channel.ts";
import { type AddRoute, STREAMED } from "./http.ts";
import { publicRun } from "./run-routes.ts";
import type { RunRecord } from "../core/run-store.ts";
import type { RoomEntry, RoomEvent } from "./rooms.ts";
import type { WebAppOptions } from "./server.ts";

export type EventsRoutesDeps = Pick<WebAppOptions, "sessions" | "people" | "channels" | "board" | "rooms"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	/** The session a request carries, from its cookie. */
	readonly sessionOf: (req: IncomingMessage) => string | undefined;
	readonly ownThread: (person: Person, instanceId: string, threadId: string) => Promise<InstanceRecord>;
	/** An entry with the name of the model that wrote it. */
	readonly shown: <E extends WebEntry | RoomEntry>(entry: E) => E;
	/** Each open stream's way to listen to an agente made after it opened. */
	readonly streamAttachers: Set<(channel: WebChannel) => void>;
};

/** The console's live stream: runs, chat and stanza entries, the board's news for this person. */
export function eventsRoutes(route: AddRoute, options: EventsRoutesDeps): void {
	const { runtime, tenantId, sessionOf, ownThread, shown, streamAttachers } = options;
	route("GET", "/api/events", "person", async ({ person: p, req, res }) => {
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		res.write(": connected\n\n");
		let disconnected = false;
		let draining = false;
		// Everything this stream is about to write, in order. A run keeps its place and its latest state.
		type Pending = { readonly allowed: (person: Person) => Promise<unknown>; readonly frame: string };
		const pending = new Map<string, Pending>();
		let counter = 0;
		/** The person this session belongs to now, or nothing: revoked, expired, or removed. */
		const current = async (): Promise<Person | undefined> => {
			if (await options.sessions.personOf(sessionOf(req)) !== p.id) return undefined;
			return options.people.get(p.id);
		};
		const drain = async () => {
			if (draining || disconnected) return;
			draining = true;
			try {
				while (pending.size > 0 && !disconnected) {
					// One check per pass, before any event of any kind: the identity captured at open proves nothing later.
					const batch = [...pending.values()];
					pending.clear();
					const person = await current();
					if (person === undefined) { res.end(); break; }
					for (const item of batch) {
						try { await item.allowed(person); }
						catch { continue; }
						if (disconnected || res.writableEnded) return;
						res.write(item.frame);
						// Only a client that really stalls is cut: it reconnects and reads persisted state.
						if (res.writableLength > 512 * 1024) { res.end(); return; }
					}
				}
			} catch { res.end(); }
			finally { draining = false; }
		};
		const enqueue = (key: string, item: Pending) => {
			if (disconnected) return;
			pending.set(key, item);
			void drain();
		};
		const always = async () => {};
		const offRuns = runtime.onRunEvent(({ run }) => {
			if (run.tenantId !== tenantId || run.channel !== "web" || WebChannel.ownerOf(run.threadId) !== p.id) return;
			enqueue(run.id, { allowed: (person) => ownThread(person, run.instanceId, run.threadId), frame: `event: run\ndata: ${JSON.stringify({ run: publicRun(run) })}\n\n` });
		});
		req.once("close", () => { disconnected = true; pending.clear(); offRuns(); });
		const listeners: [WebChannel, (e: WebEvent) => void][] = [];
		const attach = (channel: WebChannel) => {
			const listener = (event: WebEvent) => enqueue(`entry:${++counter}`, { allowed: (person) => ownThread(person, event.instanceId, event.threadId), frame: `event: entry\ndata: ${JSON.stringify({ ...event, entry: shown(event.entry) })}\n\n` });
			channel.events.on(p.id, listener);
			listeners.push([channel, listener]);
		};
		for (const channel of options.channels.values()) attach(channel);
		streamAttachers.add(attach);
		/** News of a scheda of this person; with `text`, only when it has something to say. */
		const boardEvent = (kind: string, text?: (card: BoardReview["card"]) => string | undefined) => ({ card, people }: BoardReview) => {
			const said = text?.(card);
			if (!people.includes(p.id) || (text !== undefined && said === undefined)) return;
			enqueue(`board:${++counter}`, { allowed: always, frame: `event: board\ndata: ${JSON.stringify({ kind, id: card.id, n: card.n, title: card.title, ...(said === undefined ? {} : { text: said }) })}\n\n` });
		};
		const board = [
			// One an agente finished (ADR 0051): the console tells them.
			["review", boardEvent("review")],
			// One due today or late (ADR 0074).
			["due", boardEvent("due", (card) => (card.due === undefined ? undefined : dueText(card.due)))],
			// One that started by itself (ADR 0076).
			["started", boardEvent("started")],
		] as const;
		for (const [name, listener] of board) options.board?.work.events.on(name, listener);
		// A stanza the person still has.
		const roomEntry = (event: RoomEvent) => enqueue(`room:${++counter}`, {
			allowed: async (person) => { if (await options.rooms?.get(person.id, event.roomId) === undefined) throw new Error("No such room"); },
			frame: `event: room\ndata: ${JSON.stringify({ roomId: event.roomId, entry: shown(event.entry), ...(event.parent === undefined ? {} : { parent: event.parent }), ...(event.reaction === undefined ? {} : { reaction: true }) })}\n\n`,
		});
		options.rooms?.events.on(p.id, roomEntry);
		// A quiet stream still ends with its session: the ping is checked like any event.
		const ping = setInterval(() => enqueue("ping", { allowed: always, frame: ": ping\n\n" }), 25_000);
		await new Promise<void>((resolve) => req.on("close", resolve));
		clearInterval(ping);
		streamAttachers.delete(attach);
		for (const [channel, listener] of listeners) channel.events.off(p.id, listener);
		for (const [name, listener] of board) options.board?.work.events.off(name, listener);
		options.rooms?.events.off(p.id, roomEntry);
		return STREAMED;
	});
}
