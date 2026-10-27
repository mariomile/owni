import { EgressDenied } from "../core/errors.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { WebChannel, WebThread } from "./channel.ts";
import type { Rooms } from "./rooms.ts";

/**
 * The thread under one message of the person's direct conversation (ADR 0113), made on first use and
 * answering with the model the person chose for the conversation. Undefined when the message is not there.
 */
export async function openReplies(runtime: OwniRuntime, channel: WebChannel, at: { readonly tenantId: string; readonly instanceId: string; readonly personId: string; readonly entryId: string }): Promise<WebThread | undefined> {
	const thread = await channel.openReplies(at.personId, at.entryId);
	if (thread?.parent === undefined) return undefined;
	const chosen = await runtime.chatModel(at.tenantId, at.instanceId, "web", thread.parent.threadId).catch(() => undefined);
	if (chosen !== undefined && (await runtime.chatModel(at.tenantId, at.instanceId, "web", thread.id).catch(() => undefined)) === undefined) {
		// Its provider gone since: the thread answers with the agente's model.
		await runtime.setChatModel(at.tenantId, at.instanceId, { channel: "web", threadId: thread.id }, chosen, at.personId).catch((error: unknown) => {
			if (!(error instanceof EgressDenied)) throw error;
		});
	}
	return thread;
}

/**
 * Where an agente answers in a thread (ADR 0133) the person's message `messageId` of its conversation
 * `threadId`: the thread under it in the direct conversation, or the agente's seat in the thread under
 * the canale's message its seat carried. Made on first use; undefined for a thread already, or an old chat.
 */
export async function threadUnder(
	web: { readonly runtime: OwniRuntime; readonly channel: WebChannel; readonly rooms: Rooms; readonly tenantId: string; readonly instanceId: string },
	at: { readonly threadId: string; readonly messageId: string },
): Promise<string | undefined> {
	const thread = await web.channel.thread(at.threadId);
	if (thread?.dm === true) return (await openReplies(web.runtime, web.channel, { tenantId: web.tenantId, instanceId: web.instanceId, personId: thread.personId, entryId: at.messageId }))?.id;
	if (thread?.room === undefined) return undefined;
	const about = (await web.channel.entry(thread.id, at.messageId))?.about;
	return about === undefined ? undefined : web.rooms.seatInThread(thread.personId, thread.room, about, web.instanceId);
}
