import type { InboundMessage } from "./channels/types.ts";
import { ChatModelRefused, type ChatModels } from "./core/chat-models.ts";
import { EgressDenied } from "./core/errors.ts";
import type { InstanceRecord } from "./core/registry.ts";
import type { OwniRuntime } from "./core/runtime.ts";
import { subjectOf } from "./core/memory.ts";

/** The command in a channel's menu (Telegram's, next to the message box). */
export const MODEL_COMMAND = { command: "modello", description: "Scegli il modello di questa chat" } as const;

/** Words that take a chat back to the instance's model. */
const BACK = new Set(["istanza", "predefinito", "default", "reset"]);
/** How many matches a reply lists before asking to narrow the search. */
const LISTED = 8;

/**
 * The argument of a model command, "" when it has none; undefined when the text is not one.
 * "/modello", "/model" and, in a Telegram group, "/modello@NomeBot".
 */
export function modelCommandArgument(text: string): string | undefined {
	const match = /^\/(?:modello|model)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return match === null ? undefined : (match[1] ?? "").trim();
}

/**
 * The model command of a text channel (ADR 0037), for a person the instance talks to: shows a
 * chat's model, gives it another one or takes it back to the instance's. Chooses as a member
 * does on the web: among the providers the instance may use, never widening them. Returns the reply.
 */
export async function answerModelCommand(
	runtime: OwniRuntime,
	chats: ChatModels,
	record: InstanceRecord,
	message: Pick<InboundMessage, "channel" | "threadId" | "userId">,
	argument: string,
): Promise<string> {
	const chat = { channel: message.channel, threadId: message.threadId };
	const instanceModel = chats.named(record.model).name;
	if (argument === "") return status(runtime, chats, record, chat, instanceModel);
	if (BACK.has(argument.toLowerCase())) {
		await chats.give(record, chat, undefined, subjectOf(message.channel, message.userId));
		return `Fatto: questa chat torna al modello dell'istanza, ${instanceModel}.`;
	}
	const found = await find(chats, record, argument);
	if (found.kind === "none") return `Non trovo un modello «${argument}» fra quelli che questa chat può usare. Scrivi /modello per vedere i provider.`;
	if (found.kind === "many") {
		const lines = found.options.slice(0, LISTED).map((o) => `• ${o.name}, di ${o.label}: /modello ${o.provider} ${o.modelId}`);
		const more = found.options.length > LISTED ? `\n…e altri ${found.options.length - LISTED}: scrivi qualcosa di più preciso.` : "";
		return `Ho trovato più modelli. Scrivi quello che vuoi:\n${lines.join("\n")}${more}`;
	}
	try {
		const choice = await chats.choice(record, false, found.model);
		const given = await chats.give(record, chat, choice, subjectOf(message.channel, message.userId));
		return `Fatto: da ora questa chat usa ${given?.name ?? found.model.modelId}, di ${found.label}. Con /modello istanza torna a ${instanceModel}.`;
	} catch (error) {
		if (error instanceof ChatModelRefused) return error.message;
		// Disallowed, or its key removed, between the check and the choice.
		if (error instanceof EgressDenied) return "Questo provider non è più disponibile per le chat.";
		throw error;
	}
}

async function status(runtime: OwniRuntime, chats: ChatModels, record: InstanceRecord, chat: { channel: string; threadId: string }, instanceModel: string): Promise<string> {
	const own = await runtime.chatModel(record.tenantId, record.id, chat.channel, chat.threadId);
	const providers = await chats.providers(record, false);
	const current = own === undefined ? `Questa chat usa il modello dell'istanza, ${instanceModel}.` : `Questa chat usa ${chats.named(own).name}. Con /modello istanza torna a ${instanceModel}.`;
	if (providers.length === 0) return `${current}\nPer ora non ci sono altri modelli: l'owner li sceglie dalla console.`;
	const lines = providers.map((p) => `• ${p.label}: /modello ${p.id}`);
	return `${current}\nPer cambiarlo scrivi /modello e il provider o il nome del modello:\n${lines.join("\n")}`;
}

type Option = { readonly provider: string; readonly modelId: string; readonly name: string; readonly label: string };
type Found = { kind: "one"; model: { provider: string; modelId: string }; label: string } | { kind: "many"; options: readonly Option[] } | { kind: "none" };

/**
 * What a person typed, among the models this chat may use: "<provider> <model id>" or a model
 * id exactly; a provider alone (its id or the first word of its name) gives its suggested model;
 * anything else matches when every word is in the provider's or the model's name or id.
 */
async function find(chats: ChatModels, record: InstanceRecord, argument: string): Promise<Found> {
	const query = argument.toLowerCase();
	const providers = await chats.providers(record, false);
	const options: Option[] = [];
	for (const p of providers) {
		const models = chats.models(p.id);
		// The provider's suggested model first, so it leads any list.
		const ordered = [...models.filter((m) => m.id === p.defaultModel), ...models.filter((m) => m.id !== p.defaultModel)];
		for (const m of ordered) options.push({ provider: p.id, modelId: m.id, name: m.name, label: p.label });
	}
	const one = (o: Option): Found => ({ kind: "one", model: { provider: o.provider, modelId: o.modelId }, label: o.label });
	const pick = (matches: readonly Option[]): Found => (matches.length === 1 ? one(matches[0] as Option) : matches.length === 0 ? { kind: "none" } : { kind: "many", options: matches });

	const exact = options.filter((o) => `${o.provider} ${o.modelId}`.toLowerCase() === query || o.modelId.toLowerCase() === query);
	if (exact.length > 0) return pick(exact);
	const provider = providers.find((p) => p.id === query || p.label.toLowerCase().split(/[\s(]+/)[0] === query);
	if (provider !== undefined) {
		const suggested = options.find((o) => o.provider === provider.id && o.modelId === provider.defaultModel);
		return suggested === undefined ? pick(options.filter((o) => o.provider === provider.id)) : one(suggested);
	}
	const words = query.split(/\s+/);
	const matches = options.filter((o) => {
		const text = `${o.provider} ${o.label} ${o.modelId} ${o.name}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
	const named = matches.filter((o) => o.name.toLowerCase() === query);
	return pick(named.length === 1 ? named : matches);
}
