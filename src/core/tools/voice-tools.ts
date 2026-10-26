import { Type } from "typebox";
import { StringEnum } from "../tool-schema.ts";
import { defineOwniTool, type OwniTool } from "../engine.ts";

type VoiceMode = "auto" | "always" | "never";

/**
 * How the person you talk to gets replies on Telegram and WhatsApp (ADR 0020): a voice note back
 * when they send one, always, or never. Only in a private chat, only for that person.
 */
export function createVoiceTools(options: {
	/** The person's choice, by `channel:threadId` of their private chat. */
	readonly get: (key: string) => Promise<VoiceMode>;
	readonly set: (key: string, mode: VoiceMode) => Promise<void>;
	/** The person of a private conversation; undefined in a group. */
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	/** The owner turned spoken replies on for this instance. */
	readonly on: () => Promise<boolean>;
}): OwniTool[] {
	const said: Record<VoiceMode, string> = {
		auto: "rispondo a voce quando mi manda un vocale, per iscritto quando scrive",
		always: "rispondo sempre anche con un vocale, oltre al testo",
		never: "rispondo solo per iscritto, anche ai vocali",
	};
	return [
		defineOwniTool({
			name: "voice_replies",
			description:
				"Set how the person you are talking to gets your replies on Telegram and WhatsApp. auto: a voice note back when they send a voice note (the default); always: a voice note with every reply; never: text only. " +
				"Use it when they ask 'rispondimi a voce', 'mandami sempre vocali', 'basta vocali', 'scrivimi e basta'. Without mode, tells the current choice. Never promise voice notes without it.",
			parameters: Type.Object({ mode: Type.Optional(StringEnum(["auto", "always", "never"] as const)) }, { additionalProperties: false }),
			replaySafe: true,
			async execute(args, ctx) {
				const thread = ctx.thread;
				if (thread === undefined || (thread.channel !== "telegram" && thread.channel !== "whatsapp")) return "Errore: le risposte a voce sono solo su Telegram e WhatsApp. Nella console ogni risposta ha il pulsante «Ascolta».";
				if (options.whoIs(thread) === undefined) return "Errore: si sceglie in una chat privata con la persona, non in un gruppo.";
				const key = `${thread.channel}:${thread.threadId}`;
				const off = (await options.on()) ? "" : " Però le risposte a voce non sono attive per questa istanza: le accende l'owner in Impostazioni → Risposte a voce. Diglielo.";
				if (args.mode === undefined) return `Adesso con questa persona ${said[await options.get(key)]}.${off}`;
				await options.set(key, args.mode);
				return `Fatto: con questa persona ${said[args.mode]}.${off}`;
			},
		}),
	];
}
