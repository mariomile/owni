import { createHmac } from "node:crypto";
import { audioSeconds } from "../core/audio.ts";
import { imageType, isPhoto } from "../core/images.ts";
import { audioName, isRecording, RECORDING_TOO_LARGE, TRANSCRIBED, type Transcribe, voiceText } from "./voice.ts";
import { sameSecret } from "../web/compare.ts";
import { DUPLICATE_NOTICE, splitText, tailOf } from "./text.ts";
import { type ActionButton, type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage, type OutboundFile, type OutboundMessage, type OutboundReaction, type OutboundVoice } from "./types.ts";

/** Largest image WhatsApp shows as a picture. */
const WHATSAPP_MAX_IMAGE = 5 * 1024 * 1024;

/**
 * WhatsApp through Meta's Cloud API: a business phone number, messages pushed to a webhook
 * (there is no polling), replies with plain fetch. Every chat is one person and the business,
 * so every thread is private. WhatsApp allows free-form replies only within 24 hours of the
 * person's last message: outside that window Meta refuses, and the refusal says so.
 */
export type WhatsAppCredentials = {
	/** A system user's access token with whatsapp_business_messaging. */
	readonly accessToken: string;
	/** The id of the business phone number (not the number itself). */
	readonly phoneNumberId: string;
	/** The Meta app's secret: Meta signs each webhook delivery with it. */
	readonly appSecret: string;
	/** What the webhook answers Meta's verification with; ours, random. */
	readonly verifyToken: string;
	/** The template for messages outside the 24-hour window, saved with the rest. */
	readonly template?: WhatsAppTemplate;
};

/** A message waiting for its person to open the 24-hour window again. */
export type ParkedMessage = {
	/** The outbound message's idempotency key: parking it twice keeps one. */
	readonly key: string;
	readonly text: string;
	readonly buttons?: readonly ActionButton[];
	/** A delivery of it failed partway: it goes again with the possible-duplicate notice. */
	readonly resend?: boolean;
};

/**
 * What the adapter remembers per number, kept by the app across restarts: when the person last
 * wrote (so Owni knows whether WhatsApp lets her write freely), what waits for them, and whether
 * they were already told something waits since they last wrote.
 */
export type WhatsAppWindow = {
	lastInbound(number: string): Promise<number | undefined>;
	/** The person wrote at `at`: the window opens and they may be told again. */
	seen(number: string, at: number): Promise<void>;
	/** Kept (once per key). `notify`: no notice sent since they last wrote, and now one is due; `dropped`: oldest let go over the cap. */
	park(number: string, message: ParkedMessage): Promise<{ notify: boolean; dropped: number }>;
	waiting(number: string): Promise<ParkedMessage[]>;
	/** Sent: out of the store. */
	delivered(number: string, key: string): Promise<void>;
	/** Sending failed partway: stays, marked to go again with the notice. */
	failed(number: string, key: string): Promise<void>;
};

/** What is kept per number. */
export type WindowState = Record<string, { last?: number; notified?: boolean; parked?: ParkedMessage[] }>;

/** Most messages kept for one person; numbers remembered in all (the oldest with nothing waiting go first). */
const MAX_PARKED = 20;
const MAX_NUMBERS = 2000;

/** The rules of the store, over whatever keeps the state (a locked JSON file in the app, memory in tests). */
export function windowStore(io: { read(): WindowState; update(change: (state: WindowState) => WindowState): void }): WhatsAppWindow {
	const edit = (number: string, change: (entry: NonNullable<WindowState[string]>) => NonNullable<WindowState[string]>) =>
		io.update((state) => {
			const next: WindowState = { ...state, [number]: change(state[number] ?? {}) };
			const numbers = Object.keys(next);
			if (numbers.length > MAX_NUMBERS) {
				const idle = numbers.filter((n) => n !== number && (next[n]?.parked ?? []).length === 0).sort((a, b) => (next[a]?.last ?? 0) - (next[b]?.last ?? 0));
				for (const n of idle.slice(0, numbers.length - MAX_NUMBERS)) delete next[n];
			}
			return next;
		});
	return {
		lastInbound: async (number) => io.read()[number]?.last,
		seen: async (number, at) => edit(number, (e) => ({ ...e, last: Math.max(e.last ?? 0, at), notified: false })),
		park: async (number, message) => {
			let result = { notify: false, dropped: 0 };
			edit(number, (e) => {
				const parked = e.parked ?? [];
				if (parked.some((p) => p.key === message.key)) return e;
				const all = [...parked, message];
				result = { notify: e.notified !== true, dropped: Math.max(0, all.length - MAX_PARKED) };
				return { ...e, parked: all.slice(-MAX_PARKED), notified: true };
			});
			return result;
		},
		waiting: async (number) => io.read()[number]?.parked ?? [],
		delivered: async (number, key) => edit(number, (e) => ({ ...e, parked: (e.parked ?? []).filter((p) => p.key !== key) })),
		failed: async (number, key) => edit(number, (e) => ({ ...e, parked: (e.parked ?? []).map((p) => (p.key === key ? { ...p, resend: true } : p)) })),
	};
}

/** A template the owner had Meta approve, with one body variable for an excerpt of the message. */
export type WhatsAppTemplate = { readonly name: string; readonly language: string };

export type WhatsAppAdapterOptions = WhatsAppCredentials & {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly fetch?: typeof fetch;
	/** Graph API base with version; tests point it to a fake. */
	readonly apiBase?: string;
	readonly log?: (message: string) => void;
	/** May this person's files be downloaded? Files of strangers should not. */
	readonly mayDownload?: (userId: string) => Promise<boolean>;
	/** Voice messages to text; without it Owni is told transcription is off. */
	readonly transcribe?: Transcribe;
	/** Without it every message is sent as is, and outside the window Meta drops it (logged). */
	readonly window?: WhatsAppWindow;
	/** Sent instead of a message outside the window, to tell the person something waits for them. */
	readonly template?: WhatsAppTemplate;
};

export const WHATSAPP_GRAPH = "https://graph.facebook.com/v26.0";
/** WhatsApp's limit for one text message. */
const MAX_TEXT = 4096;
/** Reply buttons: at most three, titles up to 20 characters, ids up to 256. */
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTON_ID = 256;
const MAX_CAPTION = 1024;
const MAX_INTERACTIVE_BODY = 1024;
/** Largest file Owni downloads from a chat. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;
/** Free-form messages are allowed this long after the person's last one; a little less, to be safe. */
const WINDOW_MS = 24 * 3_600_000 - 10 * 60_000;
/** Longest excerpt in a template variable (no line breaks allowed there); with the template's own text it must stay under Meta's 1024. */
const MAX_EXCERPT = 600;
/** Meta's error code for a free-form message outside the 24-hour window. */
const OUTSIDE_WINDOW = 131047;
/** Meta's codes for "not now": rate limits (4, 80007, 130429, 131048, 131056) and its own temporary errors (1, 2, 131000, 131016, 133004). */
const RETRYABLE = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
/** A message whose handling fails this many times is let go (logged), so Meta stops delivering it. */
const MAX_MESSAGE_FAILURES = 3;
/** Document types WhatsApp accepts, by extension; text-like files go as plain text. */
const MIME: Record<string, string> = {
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	txt: "text/plain",
	csv: "text/plain",
	md: "text/plain",
	json: "text/plain",
	png: "image/png",
	webp: "image/webp",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
};

/** A template's name as Meta writes it, and its language code (it, en_US). */
export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
export const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** Connecting WhatsApp the first time needs all three values from Meta. */
export class MissingWhatsAppField extends Error {
	override readonly name = "MissingWhatsAppField";
}

/** Credentials as saved in the secret store; undefined if what is there is not them. */
export function parseCredentials(saved: string): WhatsAppCredentials | undefined {
	try {
		const value = JSON.parse(saved) as Partial<WhatsAppCredentials>;
		const fields = [value.accessToken, value.phoneNumberId, value.appSecret, value.verifyToken];
		if (!fields.every((f) => typeof f === "string" && f !== "")) return undefined;
		const { template, ...credentials } = value as WhatsAppCredentials;
		const valid = template !== undefined && TEMPLATE_NAME.test(String(template?.name)) && TEMPLATE_LANGUAGE.test(String(template?.language));
		return { ...credentials, ...(valid ? { template: { name: template.name, language: template.language } } : {}) };
	} catch {
		return undefined;
	}
}

type WhatsAppMessage = {
	from: string;
	id: string;
	/** When the person wrote it, Unix seconds. */
	timestamp?: string;
	type: string;
	text?: { body?: string };
	interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
	document?: { id?: string; filename?: string; mime_type?: string; caption?: string };
	image?: { id?: string; mime_type?: string; caption?: string };
	sticker?: { id?: string; mime_type?: string; animated?: boolean };
	audio?: { id?: string; mime_type?: string; voice?: boolean };
	video?: { id?: string; mime_type?: string; caption?: string };
};
/** What Meta says later about a message we sent: a failure outside the 24-hour window arrives here, not as an error on the send. */
type WhatsAppStatus = { id?: string; status?: string; recipient_id?: string; errors?: { code?: number; title?: string }[] };
export type WhatsAppWebhook = { object?: string; entry?: { changes?: { field?: string; value?: { metadata?: { phone_number_id?: string }; messages?: WhatsAppMessage[]; statuses?: WhatsAppStatus[] } }[] }[] };

export class WhatsAppAdapter implements ChannelAdapter {
	readonly name = "whatsapp";
	private handler: ((message: InboundMessage) => Promise<void>) | undefined;
	private actionHandler: ((action: InboundAction) => Promise<void>) | undefined;
	private readonly fetch: typeof fetch;
	private readonly apiBase: string;
	private readonly failures = new Map<string, number>();

	constructor(private readonly options: WhatsAppAdapterOptions) {
		this.fetch = options.fetch ?? fetch;
		this.apiBase = options.apiBase ?? WHATSAPP_GRAPH;
	}

	onInbound(handler: (message: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	onAction(handler: (action: InboundAction) => Promise<void>): void {
		this.actionHandler = handler;
	}

	/** Messages arrive on the webhook; there is nothing to start or stop. */
	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	/** The business number as Meta shows it: checks token and phone number id together. */
	async me(): Promise<{ number: string | undefined; name: string | undefined }> {
		const found = await this.call<{ display_phone_number?: string; verified_name?: string }>("GET", `/${this.options.phoneNumberId}?fields=display_phone_number,verified_name`);
		return { number: found.display_phone_number, name: found.verified_name };
	}

	/** Meta's verification of the webhook: the challenge back, only with our token. */
	verify(query: URLSearchParams): string | undefined {
		if (query.get("hub.mode") !== "subscribe") return undefined;
		return sameSecret(query.get("hub.verify_token") ?? "", this.options.verifyToken) ? (query.get("hub.challenge") ?? undefined) : undefined;
	}

	/** Whether Meta signed this delivery: `sha256=` and the HMAC of the raw body with the app secret. */
	signed(rawBody: Buffer, header: string | undefined): boolean {
		const given = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
		if (given === undefined) return false;
		return sameSecret(given, createHmac("sha256", this.options.appSecret).update(rawBody).digest("hex"));
	}

	/**
	 * One webhook delivery: every message in it, in order. Throws while one fails, so Meta delivers
	 * again (the core dedupes by id); after the third failure that message is let go, logged, and
	 * the rest of the delivery goes on. Whatever is not the expected shape is skipped.
	 */
	async handleWebhook(payload: WhatsAppWebhook): Promise<void> {
		for (const entry of list(payload?.entry)) {
			for (const change of list(entry?.changes)) {
				// Deliveries for another number of the same app are not ours.
				if (change?.field !== "messages" || change.value?.metadata?.phone_number_id !== this.options.phoneNumberId) continue;
				for (const status of list(change.value.statuses)) {
					if (status?.status !== "failed") continue;
					const reason = list(status.errors).map((e) => (e?.code === OUTSIDE_WINDOW ? "outside the 24-hour window, the person must write to Owni first" : `${e?.code ?? "?"} ${e?.title ?? ""}`.trim())).join("; ");
					this.options.log?.(`whatsapp: message ${status.id ?? "?"} to ${status.recipient_id ?? "?"} not delivered: ${reason || "no reason given"}`);
				}
				for (const message of list(change.value.messages)) {
					if (typeof message?.id !== "string" || typeof message.from !== "string") continue;
					try {
						await this.dispatch(message);
						this.failures.delete(message.id);
					} catch (error) {
						const failures = (this.failures.get(message.id) ?? 0) + 1;
						if (failures < MAX_MESSAGE_FAILURES) {
							this.failures.set(message.id, failures);
							throw error;
						}
						this.failures.delete(message.id);
						this.options.log?.(`whatsapp: message ${message.id} dropped after ${failures} failed attempts: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
		}
	}

	async send(message: OutboundMessage): Promise<void> {
		const text = message.possibleDuplicate === true ? `${DUPLICATE_NOTICE}\n\n${message.text}` : message.text;
		const buttons = message.buttons === undefined || message.buttons.length === 0 ? {} : { buttons: message.buttons };
		const window = this.options.window;
		if (window !== undefined && (await this.windowClosed(message.threadId))) return this.park(window, message.threadId, { key: message.idempotencyKey, text, ...buttons });
		await this.sendNow(message.threadId, { text, ...buttons });
	}

	/** Whether WhatsApp would refuse a free-form message now: only known for numbers that wrote since we started keeping track. */
	private async windowClosed(number: string): Promise<boolean> {
		const last = await this.options.window?.lastInbound(number);
		return last !== undefined && Date.now() - last > WINDOW_MS;
	}

	/**
	 * Kept for the person's next message; parking is the hand-off, so this resolves even if the
	 * notice cannot go. The approved template, if any, goes once per closed window: one paid
	 * message, not one per reminder.
	 */
	private async park(window: WhatsAppWindow, number: string, message: ParkedMessage): Promise<void> {
		const { notify, dropped } = await window.park(number, message);
		if (dropped > 0) this.options.log?.(`whatsapp: ${dropped} older message(s) waiting for ${number} let go (over the limit)`);
		const template = this.options.template;
		if (template === undefined) return void this.options.log?.(`whatsapp: outside the 24-hour window with ${number}: message kept until they write (no template set)`);
		if (!notify) return;
		const flat = message.text.replace(/\s+/g, " ").trim();
		const excerpt = flat.length > MAX_EXCERPT ? `${splitText(flat, MAX_EXCERPT)[0]}…` : flat || "…";
		try {
			await this.call("POST", `/${this.options.phoneNumberId}/messages`, {
				messaging_product: "whatsapp",
				recipient_type: "individual",
				to: number,
				type: "template",
				template: { name: template.name, language: { code: template.language }, components: [{ type: "body", parameters: [{ type: "text", text: excerpt }] }] },
			});
		} catch (error) {
			this.options.log?.(`whatsapp: notice to ${number} not sent (template ${template.name}): ${error instanceof Error ? error.message : String(error)}; the message waits for them anyway`);
		}
	}

	private async sendNow(number: string, message: Omit<ParkedMessage, "key">): Promise<void> {
		const text = message.resend === true ? `${DUPLICATE_NOTICE}\n\n${message.text}` : message.text;
		const buttons = message.buttons ?? [];
		// A message with buttons holds at most 1024 characters: the text before goes as plain messages.
		const tail = buttons.length === 0 ? "" : tailOf(text, MAX_INTERACTIVE_BODY);
		const head = text.slice(0, text.length - tail.length);
		const to = { messaging_product: "whatsapp", recipient_type: "individual", to: number };
		if (head !== "" || buttons.length === 0) {
			for (const chunk of splitText(head, MAX_TEXT)) await this.call("POST", `/${this.options.phoneNumberId}/messages`, { ...to, type: "text", text: { body: chunk, preview_url: false } });
		}
		if (buttons.length > 0) await this.call("POST", `/${this.options.phoneNumberId}/messages`, { ...to, type: "interactive", interactive: replyButtons(tail || "…", buttons) });
	}

	/** A reaction replaces Owni's earlier one on the message. Outside the 24-hour window it would be refused, and is old news: dropped. */
	async react(reaction: OutboundReaction): Promise<void> {
		if (await this.windowClosed(reaction.threadId)) return void this.options.log?.(`whatsapp: reaction to ${reaction.threadId} dropped, outside the 24-hour window`);
		await this.call("POST", `/${this.options.phoneNumberId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: reaction.threadId, type: "reaction", reaction: { message_id: reaction.messageId, emoji: reaction.emoji } });
	}

	/** Upload, then send as a picture or a document. A file cannot wait for the window: outside it, it is refused. */
	async sendFile(file: OutboundFile): Promise<void> {
		if (await this.windowClosed(file.threadId)) throw new ChannelRefused("WhatsApp: outside the 24-hour window, the person must write to Owni first");
		const form = new FormData();
		form.set("messaging_product", "whatsapp");
		// A JPEG or PNG up to 5 MB shows in the chat as a picture; anything else is a document.
		const photo = isPhoto(file.data, WHATSAPP_MAX_IMAGE);
		const type = photo ? imageType(file.data) : MIME[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
		if (type === undefined) throw new ChannelRefused(`WhatsApp does not take this kind of file as a document: ${file.name}`);
		form.set("file", new Blob([Uint8Array.from(file.data)], { type }), file.name);
		form.set("type", type);
		const uploaded = await this.call<{ id?: string }>("POST", `/${this.options.phoneNumberId}/media`, form);
		if (uploaded.id === undefined) throw new Error("WhatsApp media upload returned no id");
		const caption = [file.possibleDuplicate === true ? DUPLICATE_NOTICE : undefined, file.caption].filter(Boolean).join("\n\n");
		const captioned = caption === "" ? {} : { caption: caption.slice(0, MAX_CAPTION) };
		const to = { messaging_product: "whatsapp", recipient_type: "individual", to: file.threadId };
		const asDocument = { ...to, type: "document", document: { id: uploaded.id, filename: file.name, ...captioned } };
		if (!photo) {
			await this.call("POST", `/${this.options.phoneNumberId}/messages`, asDocument);
			return;
		}
		try {
			await this.call("POST", `/${this.options.phoneNumberId}/messages`, { ...to, type: "image", image: { id: uploaded.id, ...captioned } });
		} catch (error) {
			// A picture WhatsApp will not show still goes, as a document.
			if (!(error instanceof ChannelRefused) || error.retryable) throw error;
			await this.call("POST", `/${this.options.phoneNumberId}/messages`, asDocument);
		}
	}

	/**
	 * The voice note, then the text as a message (an audio message has no caption). Outside the
	 * 24-hour window only the text goes, kept like any other message until the person writes.
	 */
	async sendVoice(voice: OutboundVoice): Promise<void> {
		const { audio, ...message } = voice;
		if (!(await this.windowClosed(voice.threadId))) {
			try {
				const form = new FormData();
				form.set("messaging_product", "whatsapp");
				form.set("file", new Blob([Uint8Array.from(audio)], { type: "audio/ogg" }), "risposta.ogg");
				form.set("type", "audio/ogg");
				const uploaded = await this.call<{ id?: string }>("POST", `/${this.options.phoneNumberId}/media`, form);
				if (uploaded.id === undefined) throw new ChannelRefused("WhatsApp media upload returned no id");
				await this.call("POST", `/${this.options.phoneNumberId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: voice.threadId, type: "audio", audio: { id: uploaded.id } });
			} catch (error) {
				// Refused for good (Meta does not take this audio): the text still goes.
				if (!(error instanceof ChannelRefused) || error.retryable) throw error;
				this.options.log?.(`whatsapp: voice note refused, text only: ${error.message}`);
			}
		}
		await this.send(message);
	}

	private async dispatch(message: WhatsAppMessage): Promise<void> {
		await this.opened(message);
		if (message.type === "interactive" && message.interactive?.type === "button_reply") {
			const data = message.interactive.button_reply?.id;
			if (this.actionHandler === undefined || data === undefined) return;
			return this.actionHandler({ tenantId: this.options.tenantId, instanceId: this.options.instanceId, channel: this.name, threadId: message.from, userId: message.from, data, actionId: message.id });
		}
		if (this.handler === undefined) return;
		if (message.type === "audio") return this.handler === undefined ? undefined : this.voice(message, this.handler);
		// A still sticker is a small WebP picture: the model sees it like a photo.
		const still = message.type === "sticker" && message.sticker?.animated !== true;
		const text = message.type === "text" ? (message.text?.body ?? "") : message.type === "document" ? (message.document?.caption ?? "") : message.type === "image" ? (message.image?.caption ?? "") : message.type === "video" ? (message.video?.caption ?? "") : still ? "" : undefined;
		// Animated stickers, locations, contacts: not understood yet, so not passed on as empty messages.
		if (text === undefined) return;
		let attachments: { name: string; data: Uint8Array }[] = [];
		let note = "";
		// A video goes in the workspace like a document: its sound is a recording (ADR 0033).
		const media = message.type === "document" ? { id: message.document?.id, name: message.document?.filename } : message.type === "image" ? { id: message.image?.id, name: undefined } : message.type === "video" ? { id: message.video?.id, name: `video-${message.id.replace(/[^\w-]/g, "_").slice(-12)}.mp4` } : still ? { id: message.sticker?.id, name: undefined } : undefined;
		if (typeof media?.id === "string" && ((await this.options.mayDownload?.(message.from)) ?? true)) {
			try {
				const file = await this.download(media.id, media.name);
				// A photo is named by what its bytes are.
				const type = message.type === "image" || still ? imageType(file.data) : undefined;
				attachments = [type === undefined ? file : { ...file, name: `${still ? "sticker" : "foto"}.${type.slice("image/".length).replace("jpeg", "jpg")}` }];
			} catch (error) {
				// A file that cannot be had (too large, gone): the message still arrives, saying so. Meta busy: delivered again.
				if (!(error instanceof ChannelRefused) || error.retryable) throw error;
				this.options.log?.(`whatsapp: file of ${message.id} not downloaded: ${error.message}`);
				note = message.type === "video" ? RECORDING_TOO_LARGE : "[Un file allegato non è stato scaricato: troppo grande o non disponibile.]";
			}
		}
		await this.handler({
			tenantId: this.options.tenantId,
			instanceId: this.options.instanceId,
			channel: this.name,
			threadId: message.from,
			userId: message.from,
			text: [text, note].filter(Boolean).join("\n\n"),
			privateThread: true,
			messageId: message.id,
			...(attachments.length === 0 ? {} : { attachments }),
		});
	}

	/**
	 * A person who may write wrote: the window opens from when they wrote (a message Meta delivers
	 * again days later opens nothing), and what waited for them goes now, before the answer to
	 * this. Strangers are not recorded.
	 */
	private async opened(message: WhatsAppMessage): Promise<void> {
		const window = this.options.window;
		if (window === undefined || !((await this.options.mayDownload?.(message.from)) ?? true)) return;
		const written = Number(message.timestamp) * 1000;
		const at = Number.isFinite(written) && written > 0 ? Math.min(written, Date.now()) : Date.now();
		await window.seen(message.from, at);
		if (Date.now() - at > WINDOW_MS) return;
		for (const parked of await window.waiting(message.from)) {
			try {
				await this.sendNow(message.from, parked);
			} catch (error) {
				// Not lost: it stays, and goes again with the notice at the next message.
				await window.failed(message.from, parked.key);
				this.options.log?.(`whatsapp: messages kept for ${message.from} not sent yet: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			await window.delivered(message.from, parked.key);
		}
	}

	/** A voice note or audio file: downloaded and transcribed only for people who may write; a stranger's is never fetched. */
	private async voice(message: WhatsAppMessage, handler: (message: InboundMessage) => Promise<void>): Promise<void> {
		const id = message.audio?.id;
		let text = "[Messaggio vocale]";
		if (typeof id === "string" && ((await this.options.mayDownload?.(message.from)) ?? true)) {
			// WhatsApp does not say how long it is: the 20 MB of the download is the limit.
			const mimeType = (message.audio?.mime_type ?? "audio/ogg").split(";")[0]?.trim() || "audio/ogg";
			try {
				const file = await this.download(id, audioName(mimeType));
				// A meeting or a call: kept as a recording in the workspace, for audio_transcribe (ADR 0033).
				if (isRecording(audioSeconds(file.data), this.options.transcribe)) {
					return handler({ tenantId: this.options.tenantId, instanceId: this.options.instanceId, channel: this.name, threadId: message.from, userId: message.from, text: "", privateThread: true, messageId: message.id, attachments: [{ name: audioName(mimeType, undefined, message.audio?.voice === true ? "vocale-lungo" : "registrazione"), data: file.data }] });
				}
				text = await voiceText({ data: file.data, name: file.name, mimeType }, this.options.transcribe, this.options.log);
			} catch (error) {
				// Meta busy now: an error, so Meta delivers again. Anything else is said, not dropped.
				if (!(error instanceof ChannelRefused) || error.retryable) throw error;
				this.options.log?.(`whatsapp: voice of ${message.id} not downloaded: ${error.message}`);
				// Over 20 MB is a recording, not a voice note: said with what to do when Owni could transcribe it.
				text = this.options.transcribe === undefined ? "[Messaggio vocale troppo grande o non disponibile.]" : RECORDING_TOO_LARGE;
			}
		}
		await handler({ tenantId: this.options.tenantId, instanceId: this.options.instanceId, channel: this.name, threadId: message.from, userId: message.from, text, privateThread: true, messageId: message.id, ...(text.startsWith(TRANSCRIBED) ? { voice: true } : {}) });
	}

	/** The media's address from the Graph API, then the file itself, with the token. */
	private async download(mediaId: string, filename: string | undefined): Promise<{ name: string; data: Uint8Array }> {
		const media = await this.call<{ url?: string; file_size?: number }>("GET", `/${encodeURIComponent(mediaId)}`);
		if (typeof media.url !== "string" || !URL.canParse(media.url)) throw new ChannelRefused("WhatsApp media without a valid url");
		// The token goes only to Meta's own hosts over https, whatever address the answer holds (tests: the fake's own host).
		const url = new URL(media.url);
		const ours = url.host === new URL(this.apiBase).host;
		if (!ours && !(url.protocol === "https:" && /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net)$/.test(url.hostname))) throw new ChannelRefused(`WhatsApp media on an unexpected address: ${url.hostname}`);
		if ((media.file_size ?? 0) > MAX_DOWNLOAD) throw new ChannelRefused(`WhatsApp file too large to download: ${media.file_size} bytes`);
		const response = await this.fetch(media.url, { headers: { authorization: `Bearer ${this.options.accessToken}` }, signal: AbortSignal.timeout(60_000) });
		if (!response.ok) throw new Error(`WhatsApp media download failed: ${response.status}`);
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += (chunk as Uint8Array).length;
			if (size > MAX_DOWNLOAD) {
				await response.body?.cancel().catch(() => {});
				throw new ChannelRefused(`WhatsApp file too large to download: over ${MAX_DOWNLOAD} bytes`);
			}
			chunks.push(chunk as Uint8Array);
		}
		return { name: filename ?? `documento-${mediaId}`, data: new Uint8Array(Buffer.concat(chunks)) };
	}

	private async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown> | FormData): Promise<T> {
		const multipart = body instanceof FormData;
		const response = await this.fetch(`${this.apiBase}${path}`, {
			method,
			headers: { authorization: `Bearer ${this.options.accessToken}`, ...(body === undefined || multipart ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
			signal: AbortSignal.timeout(30_000),
		});
		const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
		if (!response.ok || payload.error !== undefined) {
			const code = payload.error?.code ?? response.status;
			// Meta's words, never the request: the token stays out of logs.
			const detail = String(payload.error?.message ?? "").slice(0, 200);
			if (code === OUTSIDE_WINDOW) throw new ChannelRefused("WhatsApp: outside the 24-hour window, the person must write to Owni first");
			// Rate limits and Meta's own outages are a "not now"; the rest is a no.
			throw new ChannelRefused(`WhatsApp ${method} ${path.split("?")[0]}: ${code} ${detail}`.trim(), RETRYABLE.has(code) || response.status === 429 || response.status >= 500);
		}
		return payload;
	}
}

function replyButtons(body: string, buttons: readonly ActionButton[]) {
	if (buttons.length > MAX_BUTTONS) throw new Error(`WhatsApp allows at most ${MAX_BUTTONS} reply buttons`);
	for (const button of buttons) if (button.data.length > MAX_BUTTON_ID) throw new Error(`WhatsApp button "${button.label}": id over ${MAX_BUTTON_ID} characters`);
	return {
		type: "button",
		body: { text: body },
		action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.data, title: b.label.slice(0, MAX_BUTTON_TITLE) } })) },
	};
}

/** An array from a payload field, or nothing: a signed but unexpected delivery never throws. */
function list<T>(value: T[] | undefined): T[] {
	return Array.isArray(value) ? value : [];
}
