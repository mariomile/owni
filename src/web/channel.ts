import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChannelAdapter, ChannelRefused, type InboundMessage, type OutboundFile, type OutboundMessage, type OutboundReaction } from "../channels/types.ts";
import { type ArtifactRef, ArtifactStore } from "../core/artifacts.ts";
import { writeFileAtomic } from "../core/atomic-file.ts";

export type WebThread = {
	readonly id: string;
	readonly personId: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** The stanza this thread is the agente's seat in (ADR 0063): not in the person's chats, its replies go to the stanza. */
	readonly room?: string;
	/** The person's one direct conversation with this agente (ADR 0113). */
	readonly dm?: true;
	/** A thread under one message of a direct conversation (ADR 0113): shown in the side panel, not in lists. */
	readonly parent?: { readonly threadId: string; readonly entryId: string };
	/** When the person last had it on screen: anything later is unread. Missing on chats older than the marker: read. */
	readonly readAt?: string;
};

export type WebEntry = {
	readonly id: string;
	readonly at: string;
	readonly from: "person" | "owni";
	readonly text?: string;
	/** A workspace file the instance sent. */
	readonly file?: { readonly path: string; readonly caption?: string };
	/** An HTML page the instance made or changed in this thread (ADR 0112): the version shown. */
	readonly artifact?: ArtifactRef;
	/** Pictures the person sent with the message, by workspace path. */
	readonly images?: readonly string[];
	/** The model that wrote Owni's reply; `name` is added for the console, never stored. */
	readonly model?: { readonly provider: string; readonly modelId: string; readonly name?: string };
	/** The agente's reaction to this message (ADR 0132): folded in from the transcript, never stored on it. */
	readonly reaction?: string;
	/** In a stanza's seat: the stanza's message this one carries to the agente, the one its reaction lands on. */
	readonly about?: string;
};

/** A line of the transcript that is no message: the agente's emoji on an earlier one; the last one wins. */
type WebReaction = { readonly id: string; readonly at: string; readonly to: string; readonly emoji: string };

/** The transcript as shown: each reaction on the message it answers. */
function foldReactions(lines: readonly (WebEntry | WebReaction)[]): WebEntry[] {
	const reactions = new Map(lines.flatMap((l) => ("to" in l ? [[l.to, l.emoji] as const] : [])));
	return lines.flatMap((l) => ("to" in l ? [] : [reactions.has(l.id) ? { ...l, reaction: reactions.get(l.id) as string } : l]));
}

/** `reaction`: `entry` is an earlier message, shown again with the agente's reaction on it. */
export type WebEvent = { readonly instanceId: string; readonly threadId: string; readonly entry: WebEntry; readonly reaction?: true };
/** A reply in a seat of a stanza, emitted as "room" instead of to the person. */
export type WebRoomEvent = WebEvent & { readonly room: string };

/** The transcript line of what a key delivers: the same key, the same line. */
const lineId = (key: string) => `r_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

const THREAD_ID = /^p_[0-9a-f]{12}\.[0-9a-f]{12}$/;

/**
 * The web channel of one instance. A thread belongs to one person (its ID starts with the
 * person's ID); its transcript lives with the instance. Replies carry an idempotency key, so
 * a reply resent after a crash is shown once.
 */
/**
 * A thread's title from the message it answers. A command reads as words, without its JSON
 * arguments: «/chiusura-del-mese ottobre» is «Chiusura del mese ottobre».
 */
export function chatTitle(text: string): string {
	const said = text.trim().replace(/\s+/g, " ");
	const command = /^\/([\w-]+)\s*(.*)$/u.exec(said);
	if (command === null) return said.slice(0, 60);
	const [, name = "", rest = ""] = command;
	const words = [name.replace(/[-_]+/g, " ").trim(), rest.split(/[[{]/)[0]?.trim()].filter(Boolean).join(" ");
	return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 60) || said.slice(0, 60);
}

export class WebChannel implements ChannelAdapter {
	readonly name = "web";
	readonly surfacesRefusals = true;
	readonly events = new EventEmitter();
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private readonly dir: string;
	/** The thread's HTML pages (ADR 0112). */
	readonly artifacts: ArtifactStore;

	constructor(
		private readonly instance: { readonly tenantId: string; readonly instanceId: string },
		instanceDir: string,
	) {
		this.dir = join(instanceDir, "web");
		this.artifacts = new ArtifactStore(join(this.dir, "artifacts"));
		this.events.setMaxListeners(1000);
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	static ownerOf(threadId: string): string | undefined {
		return THREAD_ID.test(threadId) ? threadId.split(".")[0] : undefined;
	}

	async createThread(personId: string, title: string, kind: Pick<WebThread, "room" | "dm" | "parent"> = {}): Promise<WebThread> {
		const now = new Date().toISOString();
		const thread: WebThread = { id: `${personId}.${randomBytes(6).toString("hex")}`, personId, title: title.slice(0, 80), createdAt: now, updatedAt: now, readAt: now, ...kind };
		await this.saveThread(thread, true);
		return thread;
	}

	/** The person's direct conversation with this agente, if they ever wrote in it. */
	async dm(personId: string): Promise<WebThread | undefined> {
		return (await this.threads(personId)).find((t) => t.dm === true);
	}

	/** The person's direct conversation, made on first use: one per person, however many ask at once. */
	openDm(personId: string): Promise<WebThread> {
		return this.serial(`dm:${personId}`, async () => (await this.dm(personId)) ?? this.createThread(personId, "Messaggi diretti", { dm: true }));
	}

	/**
	 * The thread under one message of the person's direct conversation, made on first use. Undefined
	 * when the message is not there.
	 */
	openReplies(personId: string, entryId: string): Promise<WebThread | undefined> {
		return this.serial(`dm:${personId}`, async () => {
			const dm = await this.dm(personId);
			if (dm === undefined) return undefined;
			const root = await this.entry(dm.id, entryId);
			if (root === undefined) return undefined;
			const kept = (await this.threads(personId)).find((t) => t.parent?.threadId === dm.id && t.parent.entryId === entryId);
			return kept ?? this.createThread(personId, root.text !== undefined && root.text.trim() !== "" ? chatTitle(root.text) : "Thread", { parent: { threadId: dm.id, entryId } });
		});
	}

	/** The person has the thread on screen: everything in it so far is read. */
	markRead(threadId: string, personId: string): Promise<WebThread | undefined> {
		return this.serial(threadId, async () => {
			const thread = await this.thread(threadId);
			if (thread === undefined || thread.personId !== personId) return undefined;
			const read = { ...thread, readAt: new Date().toISOString() };
			await this.saveThread(read);
			return read;
		});
	}

	/** The person's chats; with `seats`, also the agente's seats in their canali. */
	async threads(personId: string, { seats = false }: { readonly seats?: boolean } = {}): Promise<WebThread[]> {
		let names: string[];
		try {
			names = await readdir(join(this.dir, "threads"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const out: WebThread[] = [];
		for (const name of names) {
			if (!name.endsWith(".json") || !name.startsWith(`${personId}.`)) continue;
			const thread = JSON.parse(await readFile(join(this.dir, "threads", name), "utf8")) as WebThread;
			if (seats || thread.room === undefined) out.push(thread);
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async thread(threadId: string): Promise<WebThread | undefined> {
		if (!THREAD_ID.test(threadId)) return undefined;
		try {
			return JSON.parse(await readFile(join(this.dir, "threads", `${threadId}.json`), "utf8")) as WebThread;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async transcript(threadId: string): Promise<WebEntry[]> {
		return foldReactions(await this.lines(threadId));
	}

	/** One message of the thread, after the thread's writes so far: the person's message an agente answers is there even while it is being written down. */
	async entry(threadId: string, entryId: string): Promise<WebEntry | undefined> {
		return (await this.serial(threadId, () => this.transcript(threadId))).find((e) => e.id === entryId);
	}

	private async lines(threadId: string): Promise<(WebEntry | WebReaction)[]> {
		if (!THREAD_ID.test(threadId)) return [];
		try {
			const text = await readFile(join(this.dir, "messages", `${threadId}.jsonl`), "utf8");
			return text
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l) as WebEntry | WebReaction);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	/**
	 * A person writes in their thread. Rejects if the core does not admit it. `command`: their own
	 * words, when `text` wraps them (a stanza's seat). `context`: told to the agente before the
	 * person's words and never written in the transcript (the message a thread answers). `about`: in a
	 * seat, the stanza's message this one carries.
	 */
	async post(threadId: string, personId: string, text: string, more: { readonly attachments?: InboundMessage["attachments"]; readonly images?: readonly { readonly path: string; readonly data: Uint8Array }[]; readonly command?: string; readonly context?: string; readonly origin?: InboundMessage["origin"]; readonly about?: string } = {}): Promise<WebEntry> {
		const { attachments, images = [], context, origin, about } = more;
		const command = more.command ?? (context === undefined ? undefined : text);
		const thread = await this.thread(threadId);
		if (thread === undefined || thread.personId !== personId) throw new Error("No such thread");
		if (this.handler === undefined) throw new Error("Web channel not connected");
		const handler = this.handler;
		const entry: WebEntry = { id: `m_${randomBytes(8).toString("hex")}`, at: new Date().toISOString(), from: "person", text, ...(images.length === 0 ? {} : { images: images.map((i) => i.path) }), ...(about === undefined ? {} : { about }) };
		// The instance is told where each picture is, so it can come back to it later (image_view).
		const said = [context, text, ...images.map((i) => `[Immagine nel workspace: ${i.path}]`)].filter(Boolean).join("\n\n");
		// Owni's answer can be ready before this message is written down: the thread's writes go
		// one at a time, so the answer always lands after the question.
		return this.serial(threadId, async () => {
			await handler({
			tenantId: this.instance.tenantId,
			instanceId: this.instance.instanceId,
			channel: this.name,
			threadId,
			userId: personId,
			text: said,
			// A console thread belongs to one person.
			privateThread: true,
			messageId: entry.id,
			...(attachments === undefined ? {} : { attachments }),
			...(images.length === 0 ? {} : { images }),
			...(command === undefined ? {} : { command }),
			...(origin === undefined ? {} : { origin }),
			});
			await this.append(threadId, entry);
			// The person's own words are read; what the board or the brief sends on its own is not theirs.
			await this.saveThread({ ...thread, updatedAt: entry.at, ...(origin === undefined ? { readAt: entry.at } : {}) });
			return entry;
		});
	}

	async send(message: OutboundMessage): Promise<void> {
		await this.deliver(message.threadId, message.idempotencyKey, { text: message.text, ...(message.model === undefined ? {} : { model: message.model }) });
	}

	async sendFile(file: OutboundFile): Promise<void> {
		// The bytes stay in the workspace; the transcript links to them.
		await this.deliver(file.threadId, file.idempotencyKey, { file: { path: file.path ?? file.name, ...(file.caption === undefined ? {} : { caption: file.caption }) } });
	}

	/** Show a saved version of an artifact in its thread, once per key. */
	async sendArtifact(threadId: string, artifact: ArtifactRef, key: string): Promise<void> {
		await this.deliver(threadId, key, { artifact: { id: artifact.id, version: artifact.version, title: artifact.title } });
	}

	/** The agente's emoji on a message of the thread (ADR 0132): it does not make the thread unread. */
	async react(reaction: OutboundReaction): Promise<void> {
		const { threadId, messageId, emoji } = reaction;
		if (!THREAD_ID.test(threadId)) throw new ChannelRefused(`Not a web thread: ${threadId}`);
		const id = lineId(reaction.idempotencyKey);
		const done = await this.serial(threadId, async () => {
			const lines = await this.lines(threadId);
			if (!lines.some((l) => !("to" in l) && l.id === messageId)) throw new ChannelRefused(`No message ${messageId} in this thread`);
			// Resent after a crash: written once, shown again (a later reaction still wins).
			if (!lines.some((l) => l.id === id)) {
				const line: WebReaction = { id, at: new Date().toISOString(), to: messageId, emoji };
				await this.append(threadId, line);
				lines.push(line);
			}
			return { entry: foldReactions(lines).find((e) => e.id === messageId) as WebEntry, room: (await this.thread(threadId))?.room };
		});
		this.publish({ instanceId: this.instance.instanceId, threadId, entry: done.entry, reaction: true }, done.room);
	}

	private async deliver(threadId: string, key: string, body: Pick<WebEntry, "text" | "file" | "model" | "artifact">): Promise<void> {
		if (!THREAD_ID.test(threadId)) throw new Error(`Not a web thread: ${threadId}`);
		const id = lineId(key);
		const done = await this.serial(threadId, async () => {
			const thread = await this.thread(threadId);
			// Resent after a crash: shown once. A seat's reply may not have reached its stanza yet, so it
			// goes there again (the stanza keeps each message once).
			const sent = (await this.transcript(threadId)).find((e) => e.id === id);
			if (sent !== undefined) return thread?.room === undefined ? undefined : { entry: sent, room: thread.room };
			// Always later than the thread's last write, even within the same millisecond: a reply after
			// the person last looked is unread.
			const at = new Date(Math.max(Date.now(), thread === undefined ? 0 : Date.parse(thread.updatedAt) + 1)).toISOString();
			const entry: WebEntry = { id, at, from: "owni", ...body };
			await this.append(threadId, entry);
			if (thread !== undefined) await this.saveThread({ ...thread, updatedAt: entry.at });
			return { entry, room: thread?.room };
		});
		if (done === undefined) return;
		this.publish({ instanceId: this.instance.instanceId, threadId, entry: done.entry }, done.room);
	}

	/** A seat's news goes to its stanza; the rest to the person the thread belongs to. */
	private publish(event: WebEvent, room: string | undefined): void {
		if (room !== undefined) this.events.emit("room", { ...event, room } satisfies WebRoomEvent);
		else this.events.emit(WebChannel.ownerOf(event.threadId) ?? "", event);
	}

	private readonly writing = new Map<string, Promise<unknown>>();

	/** Run `work` after the thread's earlier writes, in this process. */
	private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
		const next = (this.writing.get(threadId) ?? Promise.resolve()).catch(() => {}).then(work);
		const settled = next.catch(() => {});
		this.writing.set(threadId, settled);
		void settled.then(() => {
			if (this.writing.get(threadId) === settled) this.writing.delete(threadId);
		});
		return next;
	}

	private async append(threadId: string, entry: WebEntry | WebReaction): Promise<void> {
		await mkdir(join(this.dir, "messages"), { recursive: true });
		await appendFile(join(this.dir, "messages", `${threadId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}

	/** Only a new thread is fsynced: later saves change a time or a read marker, and the words are in the transcript. */
	private saveThread(thread: WebThread, durable = false): Promise<void> {
		return writeFileAtomic(join(this.dir, "threads", `${thread.id}.json`), `${JSON.stringify(thread)}\n`, { durable });
	}
}
