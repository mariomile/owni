/**
 * Channel adapters connect Owni to the places people talk to it. The core never imports
 * this module: the gateway (src/gateway.ts) passes normalized messages between the two.
 *
 * Implemented: telegram, whatsapp (Meta Cloud API), phone (Twilio, calls one turn at a time),
 * web (src/web/channel.ts).
 * Planned (interface only, see docs/architettura.md): desktop app, HTTP API / webhook,
 * mobile app. Each one is another ChannelAdapter with its own `name`, which an
 * instance's egress policy must list in `channels` before it can be used.
 */

/** A message received from a channel, normalized. */
export type InboundMessage = {
	readonly tenantId: string;
	readonly instanceId: string;
	/** Adapter name, e.g. "telegram". */
	readonly channel: string;
	/** The channel's conversation: a Telegram chat, a web session, an API thread. */
	readonly threadId: string;
	readonly userId: string;
	readonly text: string;
	/** The thread is with this person alone (a private chat): only then does their memoria apply. */
	readonly privateThread?: boolean;
	/** Channel-native message ID, used to drop redeliveries. */
	readonly messageId?: string;
	/** Files that came with the message; the gateway stores them in the workspace. */
	readonly attachments?: readonly { readonly name: string; readonly data: Uint8Array }[];
	/** Pictures already in the workspace that the model sees with the message (the core checks them). */
	readonly images?: readonly { readonly path: string; readonly data: Uint8Array }[];
	/** The person spoke (a voice note, transcribed): the reply can go back as a voice note too. */
	readonly voice?: boolean;
	/** The person's own words when `text` wraps them in more (a stanza): commands (/skill, /modello) are read from these alone. */
	readonly command?: string;
	/** Not the person's turn although it comes through their chat (ADR 0088): an agente in a stanza, the board's own work. */
	readonly origin?: "agent" | "scheduled";
	/** On the agenti's channel: the person the asking agente writes for (ADR 0134); the core admits it if that person may write here. */
	readonly forPerson?: { readonly channel: string; readonly userId: string };
};

/** A tap on a button of an earlier outbound message (Telegram: a callback query). */
export type InboundAction = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly userId: string;
	/** The `data` of the button that was tapped. */
	readonly data: string;
	/** Channel-native ID of the tap; a redelivery after a crash carries the same one. */
	readonly actionId: string;
};

/** A button under an outbound message. `data` comes back in the InboundAction when tapped. */
export type ActionButton = { readonly label: string; readonly data: string };

/** A message to deliver through a channel. */
export type OutboundMessage = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly text: string;
	/**
	 * Same value every time this reply is sent, also after a restart. Channels whose
	 * remote end deduplicates (an HTTP API with an Idempotency-Key) should pass it on;
	 * Telegram cannot, so a resend there can show the reply twice.
	 */
	readonly idempotencyKey: string;
	/**
	 * This message may already have reached the user (resent after a crash). Channels that
	 * cannot deduplicate should tell the user; the others can ignore it.
	 */
	readonly possibleDuplicate?: boolean;
	/** Buttons, in one row, under the message (under its last piece if it is split). */
	readonly buttons?: readonly ActionButton[];
	/** The model that wrote this reply (provider and model ID), for channels that show it. */
	readonly model?: { readonly provider: string; readonly modelId: string };
};

/** A file to deliver through a channel. */
export type OutboundFile = Omit<OutboundMessage, "text" | "buttons"> & {
	readonly name: string;
	readonly data: Uint8Array;
	readonly caption?: string;
	/** Where the file is in the instance's workspace, for channels that link instead of uploading. */
	readonly path?: string;
};

/** A reply as a voice note, with its full text: the adapter sends both, the text as caption where it fits. */
export type OutboundVoice = Omit<OutboundMessage, "buttons"> & {
	/** OGG with Opus inside. */
	readonly audio: Uint8Array;
};

/** An emoji on a message of the thread (ADR 0132): `messageId` is the channel's own id of it, as inbound. */
export type OutboundReaction = Omit<OutboundMessage, "text" | "buttons" | "model"> & {
	readonly messageId: string;
	readonly emoji: string;
};

export interface ChannelAdapter {
	readonly name: string;
	/** Start receiving. Resolves once the adapter is running. */
	start(): Promise<void>;
	/** Stop receiving and release resources. */
	stop(): Promise<void>;
	/** Register the handler for inbound messages. One handler per adapter. */
	onInbound(handler: (message: InboundMessage) => Promise<void>): void;
	/**
	 * Register the handler for button taps. Optional: channels without buttons omit it.
	 * Taps can be redelivered after a crash, so the handler must be idempotent.
	 */
	onAction?(handler: (action: InboundAction) => Promise<void>): void;
	/**
	 * true: the gateway passes a refused message's error back to the adapter (the web, which
	 * answers the person directly). Otherwise it is only logged (Telegram: silence to strangers).
	 */
	readonly surfacesRefusals?: boolean;
	/** Resolves once the channel has accepted the whole message; rejects otherwise. */
	send(message: OutboundMessage): Promise<void>;
	/** Resolves once the channel has accepted the file. Optional: channels without files omit it. */
	sendFile?(file: OutboundFile): Promise<void>;
	/**
	 * Resolves once the channel has accepted the text; the voice note before it is best effort (a
	 * channel that refuses it still gets the text). Optional: channels without voice notes omit it.
	 */
	sendVoice?(voice: OutboundVoice): Promise<void>;
	/**
	 * Resolves once the channel shows the reaction on the message; the agente's earlier one there is
	 * replaced. Optional: on a channel without reactions, a reaction is nothing to deliver.
	 */
	react?(reaction: OutboundReaction): Promise<void>;
	/** Show that a voice note is being recorded in this thread; best effort, never throws. */
	recording?(threadId: string): Promise<void>;
}

/**
 * The channel answered and refused the message: it did not reach anyone. Any other error
 * from `send` (network, timeout) leaves open whether it arrived. `retryable`: the refusal
 * is about now (rate limit, the channel's own outage), not about this message or person.
 */
export class ChannelRefused extends Error {
	override readonly name = "ChannelRefused";
	constructor(
		message: string,
		readonly retryable = false,
	) {
		super(message);
	}
}
