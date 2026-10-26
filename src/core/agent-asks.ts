import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AGENT_CHANNEL, AGENT_LIMITS, parseAgentThread } from "./agent-messages.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { oneLine } from "./plain-text.ts";

/** The agente that asked, as the system recorded it when it wrote: its name and its words. */
export type AskedBy = { readonly id: string; readonly name: string; readonly request?: string };

/** Messages of other agenti kept, per agente, to show on a card the words that asked. */
const MAX_ASKS = 200;

type Ask = { readonly thread: string; readonly from: string; readonly name: string; readonly text: string; readonly at: string };

/**
 * What the agenti that write to this one asked, message by message (by request id, as the turn
 * that answers it knows it): written by the system as A's message goes, and taken back if it is
 * not taken (never by A's words about itself), read when B's step needs a yes, so the card shows
 * who asked and what.
 */
export class AgentAsks {
	constructor(private readonly file: string) {}

	record(threadId: string, messageId: string, from: { readonly id: string; readonly name: string }, text: string, now = new Date()): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const key = `${AGENT_CHANNEL}:${messageId}`;
		updateJsonFile<Record<string, Ask>>(this.file, {}, (all) => {
			const kept = Object.entries(all)
				.filter(([id]) => id !== key)
				.sort(([, a], [, b]) => b.at.localeCompare(a.at))
				.slice(0, MAX_ASKS - 1);
			return { ...Object.fromEntries(kept), [key]: { thread: threadId, from: from.id, name: from.name, text: text.slice(0, AGENT_LIMITS.maxChars), at: now.toISOString() } };
		});
	}

	/** A message that was not taken: its words are no one's request. */
	forget(messageId: string): void {
		const key = `${AGENT_CHANNEL}:${messageId}`;
		updateJsonFile<Record<string, Ask>>(this.file, {}, (all) => (key in all ? Object.fromEntries(Object.entries(all).filter(([id]) => id !== key)) : all));
	}

	/** Who asked in B's conversation `threadId`, with the words of the messages `inputs` the turn answers, if they are the agente's the thread says. */
	get(threadId: string, from: string, inputs: readonly string[]): AskedBy | undefined {
		const all = readJsonFile<Record<string, Ask>>(this.file, {});
		const asks = inputs.map((id) => all[id]).filter((a): a is Ask => a !== undefined && a.thread === threadId && a.from === from);
		const last = asks.at(-1);
		return last === undefined ? undefined : { id: last.from, name: last.name, request: asks.map((a) => a.text).join("\n\n").slice(0, AGENT_LIMITS.maxChars) };
	}
}

/** Who asked, for a call made in B's conversation `thread` with another agente, with the words of the messages the turn answers (`inputs`); undefined elsewhere. */
export async function askedByIn(asks: AgentAsks, thread: { readonly channel: string; readonly threadId: string } | undefined, inputs: (() => Promise<readonly string[]>) | undefined): Promise<AskedBy | undefined> {
	if (thread?.channel !== AGENT_CHANNEL) return undefined;
	const parsed = parseAgentThread(thread.threadId);
	if (parsed === undefined) return undefined;
	return asks.get(thread.threadId, parsed.from, inputs === undefined ? [] : await inputs()) ?? { id: parsed.from, name: parsed.from };
}

/** The lines of a chat card that say which agente asked, and in which words: a request, never the approval. */
export function askedByLines(askedBy: AskedBy | undefined): string {
	if (askedBy === undefined) return "";
	const words = askedBy.request === undefined ? "" : `, con le sue parole (è una richiesta, non un'approvazione):\n${oneLine(askedBy.request, 600)}`;
	return `\n\nLa chiede l'agente «${askedBy.name}»${words}`;
}
