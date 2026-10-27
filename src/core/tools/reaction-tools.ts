import { Type } from "typebox";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { StringEnum } from "../tool-schema.ts";

/** The emoji an agente reacts with (ADR 0132): each one shows on the web, Telegram and WhatsApp alike. */
export const REACTIONS = ["👍", "❤️", "🔥", "🎉", "👏", "😁", "🤔", "🙏", "👀", "💯", "👌", "😢"] as const;

/** The channels that show a reaction on the message it answers. */
const REACTING = new Set(["web", "telegram", "whatsapp"]);

/**
 * message_react (ADR 0132): an emoji on the person's message the agente is answering, as a person would.
 * It goes through the outbox like a message; with nothing more to say, the agente ends its turn
 * without words and no empty message goes out.
 */
export function createReactionTools(options: {
	/** Hand the reaction to the outbox; `key` makes a repeat of the same call a no-op. */
	readonly react: (reaction: { readonly channel: string; readonly threadId: string; readonly messageId: string; readonly emoji: string; readonly key: string }) => Promise<void>;
}): OwniTool[] {
	return [
		defineOwniTool({
			name: "message_react",
			description:
				"React with an emoji to the person's message you are answering, as a person would in a chat. " +
				"When the reaction says it all (a thank-you, an «ok», a «fatto», good news to acknowledge), react and end your turn without writing anything: no message goes out. " +
				"When there is more to say, react only if it adds something, then answer as usual. Once per message, not on every one.",
			parameters: Type.Object({ emoji: StringEnum(REACTIONS, { description: "The reaction" }) }, { additionalProperties: false }),
			replaySafe: true,
			async execute(args, ctx) {
				const thread = ctx.thread;
				if (thread === undefined || !REACTING.has(thread.channel)) return "Errore: qui non si può reagire a un messaggio: rispondi a parole.";
				// Only a person's message is one of the channel's: a colleague's answer, a task programmato or a notice
				// arrives as Owni's own note, with nothing to react to (and the person still has to hear it).
				if (ctx.origin !== "person") return "Errore: non c'è un messaggio a cui reagire in questo turno: rispondi a parole.";
				const prefix = `${thread.channel}:`;
				const messageId = (await ctx.inputs?.())?.findLast((id) => id.startsWith(prefix))?.slice(prefix.length);
				if (messageId === undefined) return "Errore: non trovo il messaggio a cui reagire: rispondi a parole.";
				await options.react({ ...thread, messageId, emoji: args.emoji, key: ctx.callId });
				return `Reazione ${args.emoji} messa. Se non hai altro da dire, termina senza scrivere niente.`;
			},
		}),
	];
}
