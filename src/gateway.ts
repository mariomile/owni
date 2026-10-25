import { randomUUID } from "node:crypto";
import { type ChannelAdapter, ChannelRefused, type InboundAction, type InboundMessage } from "./channels/types.ts";
import { type InstanceVoice, spokenNote } from "./channels/speech.ts";
import { attachmentNote } from "./core/attachment-note.ts";
import { imageType } from "./core/images.ts";
import type { ChatModels } from "./core/chat-models.ts";
import type { OwniRuntime, InstanceRecord } from "./core/index.ts";
import { answerModelCommand, modelCommandArgument } from "./model-command.ts";

/** What a person reads when the model gave no answer; «Primi passi» does not count it as a reply. */
export const REPLY_FAILED = "Non sono riuscita a rispondere. Riprova tra poco.";
export const REPLY_CANCELLED = "Lavoro interrotto su tua richiesta. Le azioni già completate restano.";

/**
 * Connects a channel adapter, bound to one instance, to the core: inbound messages become
 * submissions; replies of that instance on that channel go back out through it, and only
 * through it, and are confirmed to the core's outbox once the channel accepts them.
 * The only module that knows both sides.
 */
export function connectChannel(
	runtime: OwniRuntime,
	adapter: ChannelAdapter,
	instance: { readonly tenantId: string; readonly instanceId: string },
	log: (message: string) => void = console.error,
	extras: {
		/** Button taps on this channel (approval cards). Must be idempotent: taps can be redelivered. */
		readonly onAction?: (action: InboundAction) => Promise<void>;
		/**
		 * Replies as voice notes (ADR 0020), for channels that send them: decided per message, in a
		 * private chat, from the person's choice and whether they spoke; the reply to that message only.
		 */
		readonly voice?: InstanceVoice;
		/** The /modello command (ADR 0037), for channels without a model picker of their own. */
		readonly models?: ChatModels;
	} = {},
): () => void {
	const { onAction, voice, models } = extras;
	/** Submissions whose reply goes back as a voice note. In memory: after a restart it goes as text. */
	const spoken = new Set<string>();
	const speaks = voice !== undefined && adapter.sendVoice !== undefined;
	if (onAction !== undefined) {
		if (adapter.onAction === undefined) throw new Error(`Channel ${adapter.name} has no buttons`);
		adapter.onAction(onAction);
	}
	adapter.onInbound(async (message) => {
		try {
			const command = models === undefined ? undefined : modelCommandArgument(message.command ?? message.text);
			// A stranger's command goes on to the core, which refuses it and writes that down.
			if (command !== undefined && models !== undefined) {
				const record = await runtime.registry.getInstance(message.tenantId, message.instanceId);
				if (talksTo(record, message)) {
					const text = await answerModelCommand(runtime, models, record, message, command);
					await runtime.sendMessage(message.tenantId, message.instanceId, { channel: message.channel, threadId: message.threadId, text, key: `model:${message.channel}:${message.messageId ?? randomUUID()}` });
					return;
				}
			}
			const aloud = speaks && message.privateThread === true && (await voice.wanted(`${message.channel}:${message.threadId}`, message.voice === true).catch(() => false));
			// The model is told, so it writes something that sounds right read aloud.
			const said = aloud ? { ...message, text: `${message.text}\n\n${spokenNote(voice.maxChars)}` } : message;
			const { submissionId } = await runtime.submit(await withAttachments(runtime, said));
			if (aloud) {
				spoken.add(submissionId);
				if (spoken.size > 500) spoken.delete(spoken.values().next().value as string);
			}
		} catch (error) {
			log(`${adapter.name}: message not submitted: ${errorMessage(error)}`);
			if (adapter.surfacesRefusals === true) throw error;
		}
	});
	return runtime.onReply((reply) => {
		if (reply.channel !== adapter.name || reply.tenantId !== instance.tenantId || reply.instanceId !== instance.instanceId) return;
		const base = { tenantId: reply.tenantId, instanceId: reply.instanceId, channel: reply.channel, threadId: reply.threadId, idempotencyKey: reply.deliveryId, possibleDuplicate: reply.possibleDuplicate };
		const sending = async (): Promise<void> => {
			if (reply.status === "file") {
				// A file gone from the workspace will not come back by retrying.
				const data = await runtime
					.workspace(reply.tenantId, reply.instanceId)
					.read(reply.path)
					.catch((error: unknown) => {
						throw new ChannelRefused(`file not readable: ${errorMessage(error)}`);
					});
				const name = reply.path.split("/").at(-1) ?? reply.path;
				if (adapter.sendFile === undefined) return adapter.send({ ...base, text: `File pronto nel workspace: ${reply.path}${reply.caption ? `\n${reply.caption}` : ""}` });
				return adapter.sendFile({ ...base, name, data, path: reply.path, ...(reply.caption === undefined ? {} : { caption: reply.caption }) });
			}
			if (reply.status === "unanswered") log(`${adapter.name}: unanswered in thread ${reply.threadId}: ${reply.reason}`);
			const text = reply.status === "answered" ? reply.text : reply.cancelled === true ? REPLY_CANCELLED : REPLY_FAILED;
			// Only the reply to the message that asked for it, and only the first time: a retry sends the text alone.
			if (reply.status === "answered" && speaks && reply.attempt === 1 && spoken.delete(reply.submissionId)) {
				void adapter.recording?.(reply.threadId);
				// A voice note that cannot be made (the service down, the day's quota) leaves the text, never nothing.
				const audio = await voice.speak(text).catch((error: unknown) => {
					log(`${adapter.name}: reply not spoken, sent as text: ${errorMessage(error)}`);
					return undefined;
				});
				if (audio !== undefined) return adapter.sendVoice?.({ ...base, text, audio });
			}
			return adapter.send({ ...base, text, ...(reply.status === "answered" && reply.model !== undefined ? { model: reply.model } : {}) });
		};
		sending()
			.then(
				// Not confirmed: the reply stays in the outbox. A failure is retried in this process
				// with backoff; a refusal, and anything left at shutdown, goes out on the next resume.
				() => runtime.markDelivered(reply),
				(error: unknown) => {
					log(`${adapter.name}: send failed, kept in the outbox: ${errorMessage(error)}`);
					return runtime.deliveryFailed(reply, { refused: error instanceof ChannelRefused && !error.retryable, reason: errorMessage(error) });
				},
			)
			.catch((error: unknown) => log(`${adapter.name}: sent, but not confirmed in the outbox: ${errorMessage(error)}`));
	});
}

/**
 * Store the files of an inbound message in the instance's workspace, under uploads/, and
 * tell the instance where they are; pictures also go to the model with the message (the core
 * checks them). Only for allowed users: the core decides that on submit, so files of a
 * stranger are dropped here, before they touch the disk.
 */
async function withAttachments(runtime: OwniRuntime, message: InboundMessage): Promise<InboundMessage> {
	if (message.attachments === undefined || message.attachments.length === 0) return message;
	const record = await runtime.registry.getInstance(message.tenantId, message.instanceId);
	const allowed = (record.allowedUsers[message.channel] ?? []).includes(message.userId);
	if (!allowed) return { ...message, attachments: [] };
	const workspace = runtime.workspace(message.tenantId, message.instanceId);
	const notes: string[] = [];
	const images: { path: string; data: Uint8Array }[] = [];
	for (const file of message.attachments) {
		const safe = file.name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
		const path = `uploads/${message.messageId?.replace(/[^\w-]/g, "_") ?? Date.now()}-${safe}`;
		await workspace.write(path, file.data);
		if (imageType(file.data) !== undefined) images.push({ path, data: file.data });
		notes.push(attachmentNote(path, file.data));
	}
	const note = notes.join("\n");
	const { attachments: _files, ...rest } = message;
	return { ...rest, text: message.text === "" ? note : `${message.text}\n\n${note}`, ...(images.length === 0 ? {} : { images: [...(message.images ?? []), ...images] }) };
}

/** The instance talks to this person on this channel: the core's own checks, without its audit. */
function talksTo(record: InstanceRecord, message: InboundMessage): boolean {
	return record.egress.channels.includes(message.channel) && (record.allowedUsers[message.channel] ?? []).includes(message.userId);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
