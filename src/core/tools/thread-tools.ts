import { Type } from "typebox";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { answeredMessage } from "./reaction-tools.ts";

/**
 * thread_reply (ADR 0133): the agente answers the person's message in the thread under it, as a person
 * would in a chat, when the answer deserves its own place. The answer goes through the outbox like any
 * message, into the thread's conversation; the turn may then end without words.
 */
export function createThreadTools(options: {
	/** The web conversation of the thread under `messageId` of `threadId`, made on first use; undefined when there is none to open. */
	readonly open: (at: { readonly threadId: string; readonly messageId: string }) => Promise<string | undefined>;
	/** Hand the answer to the outbox; `key` makes a repeat of the same call a no-op. */
	readonly send: (message: { readonly channel: string; readonly threadId: string; readonly text: string; readonly key: string }) => Promise<void>;
}): OwniTool[] {
	return [
		defineOwniTool({
			name: "thread_reply",
			description:
				"Answer the person's message in a thread under it instead of in the conversation, as a person would in a chat. " +
				"Use it when the answer deserves its own place: a long piece of work, a separate topic, something to discuss on its own without filling the conversation. " +
				"A short or conversational message gets its answer right here, without a thread. " +
				"After it, end your turn without writing anything, or with one short line for the conversation (for example that the details are in the thread).",
			parameters: Type.Object({ text: Type.String({ minLength: 1, description: "The answer, as you would write it in the conversation" }) }, { additionalProperties: false }),
			replaySafe: true,
			async execute(args, ctx) {
				const thread = ctx.thread;
				if (thread?.channel !== "web") return "Errore: qui non ci sono thread: rispondi nella conversazione.";
				// A colleague's answer, a task programmato or a notice is Owni's own note, with nothing to answer under.
				if (ctx.origin !== "person") return "Errore: non c'è un messaggio della persona sotto cui aprire un thread: rispondi nella conversazione.";
				const messageId = await answeredMessage(ctx, thread.channel);
				const under = messageId === undefined ? undefined : await options.open({ threadId: thread.threadId, messageId });
				if (under === undefined) return "Errore: qui non si apre un thread (sei già in un thread, o in una chat che non ne ha): rispondi nella conversazione.";
				await options.send({ channel: "web", threadId: under, text: args.text, key: ctx.callId });
				return "Risposta scritta nel thread. Termina senza scrivere niente, o con una riga breve per la conversazione.";
			},
		}),
	];
}
