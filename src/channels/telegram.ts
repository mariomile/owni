import { IMAGE_LIMITS, imageType, isPhoto } from "../core/images.ts";
import { audioName, isRecording, RECORDING_TOO_LARGE, TRANSCRIBED, type Transcribe, voiceText } from "./voice.ts";
import { DUPLICATE_NOTICE, splitText as splitPieces } from "./text.ts";
import { type ActionButton, type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage, type OutboundFile, type OutboundMessage, type OutboundReaction, type OutboundVoice } from "./types.ts";

/** Largest photo the Bot API takes; larger pictures go as documents. */
const TELEGRAM_MAX_PHOTO = 10 * 1024 * 1024;

export type TelegramAdapterOptions = {
	readonly token: string;
	/** The instance this bot belongs to. */
	readonly tenantId: string;
	readonly instanceId: string;
	/** Injected for tests; defaults to the global fetch. */
	readonly fetch?: typeof fetch;
	readonly apiBase?: string;
	/** Long-polling timeout in seconds. */
	readonly pollTimeoutSec?: number;
	/** How long the first photo of an album waits for the others (webhook). Default 1.5 s. */
	readonly albumWaitMs?: number;
	/** Wait after a failed poll before the next one. */
	readonly retryDelayMs?: number;
	readonly log?: (message: string) => void;
	/** May this user's files be downloaded? Default: yes. Files of strangers should not. */
	readonly mayDownload?: (userId: string) => Promise<boolean>;
	/**
	 * Receive updates by webhook instead of long polling: Telegram pushes each update to
	 * `url`, with `secretToken` in a header. A process that can sleep (a cell) needs this.
	 */
	readonly webhook?: { readonly url: string; readonly secretToken: string };
	/** The bot's commands, for the menu Telegram shows next to the message box. Set on start. */
	readonly commands?: readonly TelegramCommand[];
	/** Voice messages to text; without it Owni is told transcription is off. */
	readonly transcribe?: Transcribe;
};

/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX_TEXT = 4096;

/** A handler that fails this many times on the same update gives it up. */
const MAX_UPDATE_FAILURES = 3;
const ALBUM_WAIT_MS = 1_500;

/** Largest file a bot can download. */
const TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024;

/** Telegram's limit for a document caption. */
const TELEGRAM_MAX_CAPTION = 1024;

/** Telegram's limit for a button's callback_data, in bytes. */
export const TELEGRAM_MAX_CALLBACK_DATA = 64;

/** First line of a reply resent after a crash: sendMessage has no idempotency key. */
export { DUPLICATE_NOTICE };

export type TelegramUpdate = {
	update_id: number;
	message?: {
		message_id: number;
		chat: { id: number; type?: string };
		from?: { id: number };
		text?: string;
		caption?: string;
		/** Set on each photo of an album: the parts arrive as separate updates. */
		media_group_id?: string;
		document?: { file_id: string; file_name?: string; file_size?: number };
		/** The same photo in several sizes, smallest first. */
		photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
		voice?: TelegramSound;
		audio?: TelegramSound;
		/** A video, or a round video message: kept as a file, whose sound audio_transcribe can transcribe. */
		video?: TelegramSound;
		video_note?: TelegramSound;
	};
	callback_query?: {
		id: string;
		from: { id: number };
		message?: { message_id: number; chat: { id: number } };
		data?: string;
	};
};

/** A voice note, an audio file or a video, as Telegram describes it. */
type TelegramSound = { file_id: string; duration?: number; mime_type?: string; file_size?: number; file_name?: string };

/** A command in the bot's menu: `command` without the slash, lowercase letters, digits and _. */
export type TelegramCommand = { readonly command: string; readonly description: string };

type TelegramResponse<T> = { ok: true; result: T } | { ok: false; description?: string; error_code?: number };

/** Telegram Bot API over long polling (getUpdates) or a webhook, with plain fetch. */
export class TelegramAdapter implements ChannelAdapter {
	readonly name = "telegram";
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private actionHandler: ((action: InboundAction) => Promise<void>) | undefined;
	private readonly failures = new Map<number, number>();
	private readonly albums = new Map<string, { updates: TelegramUpdate[]; done: Promise<void> }>();
	private abort: AbortController | undefined;
	private loop: Promise<void> | undefined;
	private offset: number | undefined;
	private readonly fetch: typeof fetch;
	private readonly apiBase: string;

	constructor(private readonly options: TelegramAdapterOptions) {
		this.fetch = options.fetch ?? fetch;
		this.apiBase = options.apiBase ?? "https://api.telegram.org";
	}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	onAction(handler: (action: InboundAction) => Promise<void>): void {
		this.actionHandler = handler;
	}

	async start(): Promise<void> {
		if (this.loop !== undefined) return;
		// Only the menu: the commands work without it, so a failure is no reason not to start.
		if (this.options.commands !== undefined) {
			await this.call("setMyCommands", { commands: this.options.commands }).catch((error: unknown) => this.options.log?.(`telegram: setMyCommands failed: ${error instanceof Error ? error.message : String(error)}`));
		}
		const webhook = this.options.webhook;
		if (webhook !== undefined) {
			// Updates come to handleUpdate from now on. Telegram keeps them up to a day if we are down.
			await this.call("setWebhook", { url: webhook.url, secret_token: webhook.secretToken, allowed_updates: this.allowedUpdates() });
			this.loop = Promise.resolve();
			return;
		}
		// A webhook left from an earlier run makes getUpdates fail forever: polling removes it.
		await this.call("deleteWebhook", {}).catch((error: unknown) => this.options.log?.(`telegram: deleteWebhook failed: ${error instanceof Error ? error.message : String(error)}`));
		this.abort = new AbortController();
		this.loop = this.poll(this.abort.signal);
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		await this.loop;
		this.loop = undefined;
	}

	/** Tell Telegram to stop pushing updates here (the bot's agente is gone). Best effort. */
	async unhook(): Promise<void> {
		await this.call("deleteWebhook", {}).catch((error: unknown) => this.options.log?.(`telegram: deleteWebhook failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	/** The bot's own account: checks the token. */
	async me(): Promise<{ username: string | undefined }> {
		const me = await this.call<{ username?: string }>("getMe", {});
		return { username: me.username };
	}

	async send(message: OutboundMessage): Promise<void> {
		const text = message.possibleDuplicate === true ? `${DUPLICATE_NOTICE}\n\n${message.text}` : message.text;
		const markup = message.buttons === undefined || message.buttons.length === 0 ? undefined : inlineKeyboard(message.buttons);
		const chunks = splitText(text);
		for (const [i, chunk] of chunks.entries()) {
			const last = i === chunks.length - 1;
			await this.call("sendMessage", { chat_id: message.threadId, text: chunk, ...(last && markup !== undefined ? { reply_markup: markup } : {}) });
		}
	}

	/** sendDocument, multipart. Telegram bots can send files up to 50 MB. */
	async sendFile(file: OutboundFile): Promise<void> {
		const form = new FormData();
		form.set("chat_id", file.threadId);
		const caption = [file.possibleDuplicate === true ? DUPLICATE_NOTICE : undefined, file.caption].filter(Boolean).join("\n\n");
		if (caption !== "") form.set("caption", caption.slice(0, TELEGRAM_MAX_CAPTION));
		// A JPEG or PNG Telegram takes as a photo shows in the chat; anything else is a document.
		const photo = isPhoto(file.data, TELEGRAM_MAX_PHOTO);
		form.set(photo ? "photo" : "document", new Blob([Uint8Array.from(file.data)], photo ? { type: imageType(file.data) as string } : {}), file.name);
		try {
			await this.call(photo ? "sendPhoto" : "sendDocument", form);
		} catch (error) {
			// A picture Telegram will not take as a photo (too long, too thin) still goes, as a document.
			if (!photo || !(error instanceof ChannelRefused) || error.retryable) throw error;
			form.delete("photo");
			form.set("document", new Blob([Uint8Array.from(file.data)]), file.name);
			await this.call("sendDocument", form);
		}
	}

	/** sendVoice, multipart, with the text as caption where it fits; a longer text follows as a message. */
	async sendVoice(voice: OutboundVoice): Promise<void> {
		const text = voice.possibleDuplicate === true ? `${DUPLICATE_NOTICE}\n\n${voice.text}` : voice.text;
		const fits = text.length <= TELEGRAM_MAX_CAPTION;
		const form = new FormData();
		form.set("chat_id", voice.threadId);
		form.set("voice", new Blob([Uint8Array.from(voice.audio)], { type: "audio/ogg" }), "risposta.ogg");
		if (fits && text !== "") form.set("caption", text);
		try {
			await this.call("sendVoice", form);
			if (fits) return;
		} catch (error) {
			// Refused for good (the person does not take voice messages): the text still goes.
			if (!(error instanceof ChannelRefused) || error.retryable) throw error;
			this.options.log?.(`telegram: voice note refused, text only: ${error.message}`);
		}
		for (const chunk of splitText(text)) await this.call("sendMessage", { chat_id: voice.threadId, text: chunk });
	}

	/** setMessageReaction: the bot's reaction replaces its earlier one on the message. */
	async react(reaction: OutboundReaction): Promise<void> {
		// Inbound ids are "<chat>:<message>" (the chat can be negative).
		const id = Number(reaction.messageId.slice(reaction.messageId.lastIndexOf(":") + 1));
		if (!Number.isSafeInteger(id) || id <= 0) throw new ChannelRefused(`Not a Telegram message: ${reaction.messageId}`);
		// Telegram's emoji have no variation selector: ❤, not ❤️.
		await this.call("setMessageReaction", { chat_id: reaction.threadId, message_id: id, reaction: [{ type: "emoji", emoji: reaction.emoji.replace(/\uFE0F/g, "") }] });
	}

	async recording(threadId: string): Promise<void> {
		await this.call("sendChatAction", { chat_id: threadId, action: "record_voice" }).catch(() => {});
	}

	/** One getUpdates round; exposed for tests. Returns the number of updates handled. */
	async pollOnce(signal?: AbortSignal): Promise<number> {
		const updates = await this.call<TelegramUpdate[]>(
			"getUpdates",
			{
				timeout: this.options.pollTimeoutSec ?? 30,
				allowed_updates: this.allowedUpdates(),
				...(this.offset === undefined ? {} : { offset: this.offset }),
			},
			signal,
		);
		for (const group of albums(updates)) {
			// Confirmed on the next getUpdates. A redelivery after a crash carries the same
			// message ID, which the core turns into an idempotent request.
			this.offset = (group.at(-1) as TelegramUpdate).update_id + 1;
			try {
				await this.handleUpdates(group);
			} catch (error) {
				// Not confirmed: Telegram delivers these updates again on the next poll.
				this.offset = (group[0] as TelegramUpdate).update_id;
				throw error;
			}
		}
		return updates.length;
	}

	/**
	 * Handle one update, polled or pushed by the webhook. Throws while it fails, so Telegram
	 * delivers it again; after the third failure it is let go (logged), not retried forever.
	 */
	async handleUpdate(update: TelegramUpdate): Promise<void> {
		const album = update.message?.media_group_id;
		if (album === undefined) return this.handleUpdates([update]);
		// An album comes as one update per photo, each its own webhook call: the first waits a
		// moment for the others, and they go to the instance as one message.
		const key = `${update.message?.chat.id}:${album}`;
		const open = this.albums.get(key);
		if (open !== undefined) {
			open.updates.push(update);
			return open.done;
		}
		const updates = [update];
		const done = new Promise<void>((resolve) => setTimeout(resolve, this.options.albumWaitMs ?? ALBUM_WAIT_MS)).then(() => {
			this.albums.delete(key);
			return this.handleUpdates(updates);
		});
		this.albums.set(key, { updates, done });
		return done;
	}

	/** One message, or the photos of one album; failures count on the first update. */
	private async handleUpdates(updates: readonly TelegramUpdate[]): Promise<void> {
		const first = (updates[0] as TelegramUpdate).update_id;
		try {
			await this.dispatch(updates);
		} catch (error) {
			const failures = (this.failures.get(first) ?? 0) + 1;
			if (failures >= MAX_UPDATE_FAILURES) {
				this.failures.delete(first);
				this.options.log?.(`telegram: update ${first} dropped after ${failures} failed attempts: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			this.failures.set(first, failures);
			throw error;
		}
		this.failures.delete(first);
	}

	// Taps are requested only when someone handles them: otherwise they would be dropped.
	private allowedUpdates(): string[] {
		return this.actionHandler === undefined ? ["message"] : ["message", "callback_query"];
	}

	private async dispatch(updates: readonly TelegramUpdate[]): Promise<void> {
		const update = updates[0] as TelegramUpdate;
		if (update.callback_query !== undefined) return this.handleTap(update.callback_query);
		const message = update.message;
		if (message === undefined || this.handler === undefined) return;
		// The rest of an album: more photos and documents for the same message.
		const parts = updates.flatMap((u) => (u.message === undefined ? [] : [u.message]));
		const sound = message.voice ?? message.audio;
		const photos = parts.flatMap((part) => {
			const photo = largest(part.photo);
			return photo === undefined ? [] : [photo];
		});
		const documents = parts.flatMap((part) => {
			const video = part.video ?? part.video_note;
			// A video goes in the workspace like a document: its sound is a recording (ADR 0033).
			const asFile = video === undefined ? undefined : { file_id: video.file_id, file_name: video.file_name ?? `video-${part.message_id}.mp4`, ...(video.file_size === undefined ? {} : { file_size: video.file_size }) };
			return [...(part.document === undefined ? [] : [part.document]), ...(asFile === undefined ? [] : [asFile])];
		});
		if (message.text === undefined && documents.length === 0 && sound === undefined && photos.length === 0) return;
		const userId = String(message.from?.id ?? message.chat.id);
		const mayDownload = (await this.options.mayDownload?.(userId)) ?? true;
		let text = message.text ?? parts.find((part) => part.caption !== undefined)?.caption ?? "";
		const attachments: { name: string; data: Uint8Array }[] = [];
		if (sound !== undefined) {
			// A stranger's voice is never downloaded, let alone sent to be transcribed.
			if (!mayDownload) text = ["[Messaggio vocale]", text].filter(Boolean).join("\n\n");
			// A meeting or a call: kept as a recording in the workspace, for audio_transcribe (ADR 0033).
			else if (isRecording(sound.duration, this.options.transcribe)) {
				const recording = await this.recordingFile(sound, message.voice !== undefined ? "voice" : "audio");
				if (typeof recording === "string") text = [text, recording].filter(Boolean).join("\n\n");
				else attachments.push(recording);
			} else text = [await this.voice(sound), text].filter(Boolean).join("\n\n");
		}
		// A file that cannot be downloaded is said, not dropped with the message.
		const fetchFile = async (document: { file_id: string; file_name?: string; file_size?: number }, what: string) => {
			try {
				return await this.download(document);
			} catch (error) {
				if (!(error instanceof ChannelRefused) || error.retryable) throw error;
				this.options.log?.(`telegram: ${what} not downloaded: ${error.message}`);
				// A recording or a video is said with what to do: they are the files that pass 20 MB.
				const note = what === "photo" ? "[Foto troppo grande o non disponibile.]" : isMedia(document.file_name) ? RECORDING_TOO_LARGE : "[File troppo grande o non disponibile.]";
				text = [text, note].filter(Boolean).join("\n\n");
				return undefined;
			}
		};
		for (const document of mayDownload ? documents : []) {
			const file = await fetchFile(document, "file");
			if (file !== undefined) attachments.push(file);
		}
		for (const [i, photo] of (mayDownload ? photos : []).entries()) {
			const file = await fetchFile({ file_id: photo.file_id, ...(photo.file_size === undefined ? {} : { file_size: photo.file_size }) }, "photo");
			// Named by what it is: Telegram sends photos as JPEG, but the bytes decide.
			const ext = (imageType(file?.data ?? new Uint8Array()) ?? "image/jpeg").slice("image/".length).replace("jpeg", "jpg");
			if (file !== undefined) attachments.push({ name: photos.length === 1 ? `foto.${ext}` : `foto-${i + 1}.${ext}`, data: file.data });
		}
		await this.handler({
			tenantId: this.options.tenantId,
			instanceId: this.options.instanceId,
			channel: this.name,
			threadId: String(message.chat.id),
			userId: String(message.from?.id ?? message.chat.id),
			text,
			privateThread: message.chat.type === "private",
			messageId: `${message.chat.id}:${message.message_id}`,
			...(attachments.length === 0 ? {} : { attachments }),
			// The person spoke, and Owni understood: a song sent as audio, or a voice not transcribed, is not a question to answer aloud.
			...(message.voice !== undefined && text.startsWith(TRANSCRIBED) ? { voice: true } : {}),
		});
	}

	/** A long voice note or audio file as a file for the workspace; a note when it cannot be had. */
	private async recordingFile(sound: TelegramSound, message: "voice" | "audio"): Promise<{ name: string; data: Uint8Array } | string> {
		const mimeType = sound.mime_type ?? "audio/ogg";
		try {
			const file = await this.download({ file_id: sound.file_id, ...(sound.file_size === undefined ? {} : { file_size: sound.file_size }) });
			return { name: audioName(mimeType, sound.file_name, message === "voice" ? "vocale-lungo" : "registrazione"), data: file.data };
		} catch (error) {
			if (!(error instanceof ChannelRefused) || error.retryable) throw error;
			this.options.log?.(`telegram: recording not downloaded: ${error.message}`);
			return RECORDING_TOO_LARGE;
		}
	}

	/** The words of a voice or audio message; a note when there are none to give. */
	private async voice(sound: TelegramSound): Promise<string> {
		const transcribe = this.options.transcribe;
		const mimeType = sound.mime_type ?? "audio/ogg";
		let file: { name: string; data: Uint8Array };
		try {
			file = await this.download({ file_id: sound.file_id, file_name: audioName(mimeType, sound.file_name), ...(sound.file_size === undefined ? {} : { file_size: sound.file_size }) });
		} catch (error) {
			// Over the 20 MB a bot may download: said, not dropped.
			if (!(error instanceof ChannelRefused) || error.retryable) throw error;
			this.options.log?.(`telegram: voice not downloaded: ${error.message}`);
			return "[Messaggio vocale troppo grande o non disponibile.]";
		}
		return voiceText({ data: file.data, name: audioName(mimeType, file.name), mimeType, ...(sound.duration === undefined ? {} : { seconds: sound.duration }) }, transcribe, this.options.log);
	}

	/** getFile, then the file itself. Bots can download files up to 20 MB. */
	private async download(document: { file_id: string; file_name?: string; file_size?: number }): Promise<{ name: string; data: Uint8Array }> {
		if ((document.file_size ?? 0) > TELEGRAM_MAX_DOWNLOAD) throw new ChannelRefused(`Telegram file too large to download: ${document.file_size} bytes`);
		const file = await this.call<{ file_path?: string }>("getFile", { file_id: document.file_id });
		if (file.file_path === undefined) throw new ChannelRefused("Telegram getFile returned no file_path");
		const response = await this.fetch(`${this.apiBase}/file/bot${this.options.token}/${file.file_path}`);
		// Never include the URL in errors: it contains the bot token.
		if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
		// file_size can be missing: count while reading.
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += (chunk as Uint8Array).length;
			if (size > TELEGRAM_MAX_DOWNLOAD) {
				await response.body?.cancel().catch(() => {});
				throw new ChannelRefused(`Telegram file too large to download: over ${TELEGRAM_MAX_DOWNLOAD} bytes`);
			}
			chunks.push(chunk as Uint8Array);
		}
		return { name: document.file_name ?? file.file_path.split("/").at(-1) ?? "file", data: new Uint8Array(Buffer.concat(chunks)) };
	}

	private async handleTap(tap: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
		// Answer first, so the button stops spinning even if the handler takes a while. A tap
		// redelivered after a crash is often too old to answer: log it and handle it anyway.
		await this.call("answerCallbackQuery", { callback_query_id: tap.id }).catch((error: unknown) => {
			this.options.log?.(`telegram: answerCallbackQuery failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (this.actionHandler === undefined || tap.data === undefined || tap.message === undefined) return;
		await this.actionHandler({
			tenantId: this.options.tenantId,
			instanceId: this.options.instanceId,
			channel: this.name,
			threadId: String(tap.message.chat.id),
			userId: String(tap.from.id),
			data: tap.data,
			actionId: tap.id,
		});
	}

	private async poll(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.pollOnce(signal);
			} catch (error) {
				if (signal.aborted) return;
				this.options.log?.(`telegram: poll failed: ${error instanceof Error ? error.message : String(error)}`);
				await delay(this.options.retryDelayMs ?? 1000, signal);
			}
		}
	}

	private async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
		const multipart = body instanceof FormData;
		const response = await this.fetch(`${this.apiBase}/bot${this.options.token}/${method}`, {
			method: "POST",
			...(multipart ? {} : { headers: { "content-type": "application/json" } }),
			body: multipart ? body : JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
		const payload = (await response.json()) as TelegramResponse<T>;
		// Never include the URL in errors: it contains the bot token.
		if (!payload.ok) {
			const code = payload.error_code ?? response.status;
			const message = `Telegram ${method} failed: ${code} ${payload.description ?? ""}`.trim();
			// Too many requests and Telegram's own errors are a "not now"; other 4xx are a no.
			throw new ChannelRefused(message, code === 429 || code >= 500);
		}
		return payload.result;
	}
}

export function splitText(text: string, max = TELEGRAM_MAX_TEXT): string[] {
	return splitPieces(text, max);
}

function inlineKeyboard(buttons: readonly ActionButton[]): { inline_keyboard: { text: string; callback_data: string }[][] } {
	for (const button of buttons) {
		if (Buffer.byteLength(button.data, "utf8") > TELEGRAM_MAX_CALLBACK_DATA) {
			throw new Error(`Telegram button "${button.label}": callback data over ${TELEGRAM_MAX_CALLBACK_DATA} bytes`);
		}
	}
	return { inline_keyboard: [buttons.map((button) => ({ text: button.label, callback_data: button.data }))] };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

/** Consecutive updates of one album, together; every other update alone. */
function albums(updates: readonly TelegramUpdate[]): TelegramUpdate[][] {
	const groups: TelegramUpdate[][] = [];
	for (const update of updates) {
		const last = groups.at(-1)?.[0]?.message;
		const album = update.message?.media_group_id;
		if (album !== undefined && last?.media_group_id === album && last.chat.id === update.message?.chat.id) (groups.at(-1) as TelegramUpdate[]).push(update);
		else groups.push([update]);
	}
	return groups;
}

/** The biggest size of a photo the model takes, by pixels; the smallest if none fits. */
function largest(sizes: readonly { file_id: string; file_size?: number; width?: number; height?: number }[] | undefined) {
	if (sizes === undefined || sizes.length === 0) return undefined;
	const pixels = (size: { width?: number; height?: number }) => (size.width ?? 0) * (size.height ?? 0);
	const fitting = sizes.filter((size) => (size.file_size ?? 0) <= IMAGE_LIMITS.maxBytes);
	const pool = fitting.length > 0 ? fitting : sizes;
	return pool.reduce((best, size) => (fitting.length > 0 ? pixels(size) >= pixels(best) : pixels(size) < pixels(best)) ? size : best);
}

/** An audio or video file by its name: when too large, the person is told how to send it. */
function isMedia(name: string | undefined): boolean {
	return /\.(mp3|m4a|mp4|mov|wav|ogg|oga|opus|flac|webm|amr|aac|3gp|mkv)$/i.test(name ?? "");
}
