import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelAdapter, InboundMessage, OutboundFile, OutboundMessage } from "../channels/types.ts";
import { writeFileAtomic } from "../core/atomic-file.ts";

export type WebThread = {
	readonly id: string;
	readonly personId: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** The stanza this thread is the agente's seat in (ADR 0063): not in the person's chats, its replies go to the stanza. */
	readonly room?: string;
};

export type WebEntry = {
	readonly id: string;
	readonly at: string;
	readonly from: "person" | "owni";
	readonly text?: string;
	/** A workspace file the instance sent. */
	readonly file?: { readonly path: string; readonly caption?: string };
	/** Pictures the person sent with the message, by workspace path. */
	readonly images?: readonly string[];
	/** The model that wrote Owni's reply; `name` is added for the console, never stored. */
	readonly model?: { readonly provider: string; readonly modelId: string; readonly name?: string };
};

export type WebEvent = { readonly instanceId: string; readonly threadId: string; readonly entry: WebEntry };
/** A reply in a seat of a stanza, emitted as "room" instead of to the person. */
export type WebRoomEvent = WebEvent & { readonly room: string };

const THREAD_ID = /^p_[0-9a-f]{12}\.[0-9a-f]{12}$/;

/**
 * The web channel of one instance. A thread belongs to one person (its ID starts with the
 * person's ID); its transcript lives with the instance. Replies carry an idempotency key, so
 * a reply resent after a crash is shown once.
 */
/**
 * A new chat's title from its first message. A command reads as words, without its JSON
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

	constructor(
		private readonly instance: { readonly tenantId: string; readonly instanceId: string },
		instanceDir: string,
	) {
		this.dir = join(instanceDir, "web");
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

	async createThread(personId: string, title = "Nuova chat", room?: string): Promise<WebThread> {
		const now = new Date().toISOString();
		const thread: WebThread = { id: `${personId}.${randomBytes(6).toString("hex")}`, personId, title: title.slice(0, 80), createdAt: now, updatedAt: now, ...(room === undefined ? {} : { room }) };
		await this.saveThread(thread);
		return thread;
	}

	async threads(personId: string): Promise<WebThread[]> {
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
			if (thread.room === undefined) out.push(thread);
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
		if (!THREAD_ID.test(threadId)) return [];
		try {
			const text = await readFile(join(this.dir, "messages", `${threadId}.jsonl`), "utf8");
			return text
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l) as WebEntry);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	/**
	 * A person writes in their thread. Rejects if the core does not admit it. `command`: their own
	 * words, when `text` wraps them (a stanza's seat).
	 */
	async post(threadId: string, personId: string, text: string, more: { readonly attachments?: InboundMessage["attachments"]; readonly images?: readonly { readonly path: string; readonly data: Uint8Array }[]; readonly command?: string; readonly origin?: InboundMessage["origin"] } = {}): Promise<WebEntry> {
		const { attachments, images = [], command, origin } = more;
		const thread = await this.thread(threadId);
		if (thread === undefined || thread.personId !== personId) throw new Error("No such thread");
		if (this.handler === undefined) throw new Error("Web channel not connected");
		const handler = this.handler;
		const entry: WebEntry = { id: `m_${randomBytes(8).toString("hex")}`, at: new Date().toISOString(), from: "person", text, ...(images.length === 0 ? {} : { images: images.map((i) => i.path) }) };
		// The instance is told where each picture is, so it can come back to it later (image_view).
		const said = [text, ...images.map((i) => `[Immagine nel workspace: ${i.path}]`)].filter(Boolean).join("\n\n");
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
			const title = thread.title === "Nuova chat" ? (text.trim() !== "" ? chatTitle(text) : images.length > 0 ? "Foto" : thread.title) : thread.title;
			await this.saveThread({ ...thread, title, updatedAt: entry.at });
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

	private async deliver(threadId: string, key: string, body: Pick<WebEntry, "text" | "file" | "model">): Promise<void> {
		if (!THREAD_ID.test(threadId)) throw new Error(`Not a web thread: ${threadId}`);
		const id = `r_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
		const done = await this.serial(threadId, async () => {
			const thread = await this.thread(threadId);
			// Resent after a crash: shown once. A seat's reply may not have reached its stanza yet, so it
			// goes there again (the stanza keeps each message once).
			const sent = (await this.transcript(threadId)).find((e) => e.id === id);
			if (sent !== undefined) return thread?.room === undefined ? undefined : { entry: sent, room: thread.room };
			const entry: WebEntry = { id, at: new Date().toISOString(), from: "owni", ...body };
			await this.append(threadId, entry);
			if (thread !== undefined) await this.saveThread({ ...thread, updatedAt: entry.at });
			return { entry, room: thread?.room };
		});
		if (done === undefined) return;
		const event: WebEvent = { instanceId: this.instance.instanceId, threadId, entry: done.entry };
		if (done.room !== undefined) this.events.emit("room", { ...event, room: done.room } satisfies WebRoomEvent);
		else this.events.emit(WebChannel.ownerOf(threadId) ?? "", event);
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

	private async append(threadId: string, entry: WebEntry): Promise<void> {
		await mkdir(join(this.dir, "messages"), { recursive: true });
		await appendFile(join(this.dir, "messages", `${threadId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}

	private saveThread(thread: WebThread): Promise<void> {
		return writeFileAtomic(join(this.dir, "threads", `${thread.id}.json`), `${JSON.stringify(thread)}\n`);
	}
}
