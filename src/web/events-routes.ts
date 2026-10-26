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
		let drainingRuns = false;
		const pendingRuns = new Map<string, RunRecord>();
		const drainRuns = async () => {
			if (drainingRuns || disconnected) return;
			drainingRuns = true;
			try {
				while (pendingRuns.size > 0 && !disconnected) {
					const [id, run] = pendingRuns.entries().next().value as [string, RunRecord];
					pendingRuns.delete(id);
					// Recheck session, membership and thread ownership on each delivered event.
					if (await options.sessions.personOf(sessionOf(req)) !== p.id) { res.end(); break; }
					const currentPerson = await options.people.get(p.id);
					if (currentPerson === undefined) { res.end(); break; }
					try { await ownThread(currentPerson, run.instanceId, run.threadId); }
					catch { continue; }
					if (disconnected || res.writableEnded) break;
					res.write(`event: run\ndata: ${JSON.stringify({ run: publicRun(run) })}\n\n`);
					// A slow client reconnects and reads persisted state instead of retaining unbounded output.
					if (res.writableLength > 512 * 1024) { res.end(); break; }
				}
			} catch { res.end(); }
			finally { drainingRuns = false; }
		};
		const offRuns = runtime.onRunEvent(({ run }) => {
			if (run.tenantId !== tenantId || run.channel !== "web" || WebChannel.ownerOf(run.threadId) !== p.id || disconnected) return;
			pendingRuns.set(run.id, run);
			if (pendingRuns.size > 200) { res.end(); return; }
			void drainRuns();
		});
		req.once("close", () => { disconnected = true; pendingRuns.clear(); offRuns(); });
		const listeners: [WebChannel, (e: WebEvent) => void][] = [];
		const attach = (channel: WebChannel) => {
			const listener = (event: WebEvent) => res.write(`event: entry\ndata: ${JSON.stringify({ ...event, entry: shown(event.entry) })}\n\n`);
			channel.events.on(p.id, listener);
			listeners.push([channel, listener]);
		};
		for (const channel of options.channels.values()) attach(channel);
		streamAttachers.add(attach);
		// A scheda of this person an agente finished (ADR 0051): the console tells them.
		const review = ({ card, people }: BoardReview) => {
			if (people.includes(p.id)) res.write(`event: board\ndata: ${JSON.stringify({ kind: "review", id: card.id, n: card.n, title: card.title })}\n\n`);
		};
		options.board?.work.events.on("review", review);
		// A scheda of this person due today or late (ADR 0074).
		const due = ({ card, people }: BoardReview) => {
			if (people.includes(p.id) && card.due !== undefined) res.write(`event: board\ndata: ${JSON.stringify({ kind: "due", id: card.id, n: card.n, title: card.title, text: dueText(card.due) })}\n\n`);
		};
		options.board?.work.events.on("due", due);
		// A scheda of this person that started by itself (ADR 0076).
		const started = ({ card, people }: BoardReview) => {
			if (people.includes(p.id)) res.write(`event: board\ndata: ${JSON.stringify({ kind: "started", id: card.id, n: card.n, title: card.title })}\n\n`);
		};
		options.board?.work.events.on("started", started);
		const roomEntry = (event: RoomEvent) => res.write(`event: room\ndata: ${JSON.stringify({ roomId: event.roomId, entry: shown(event.entry), ...(event.parent === undefined ? {} : { parent: event.parent }) })}\n\n`);
		options.rooms?.events.on(p.id, roomEntry);
		const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
		await new Promise<void>((resolve) => req.on("close", resolve));
		clearInterval(ping);
		streamAttachers.delete(attach);
		for (const [channel, listener] of listeners) channel.events.off(p.id, listener);
		options.board?.work.events.off("review", review);
		options.board?.work.events.off("due", due);
		options.board?.work.events.off("started", started);
		options.rooms?.events.off(p.id, roomEntry);
		return STREAMED;
	});
}
