import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ActionQueue, type QueuedStatus } from "./action-queue.ts";
import { AGENT_CHANNEL, AGENT_LIMITS, fencedAgentRequest, type Origin, parseAgentThread } from "./agent-messages.ts";
import type { AuditEvent } from "./audit.ts";
import { shownArgs } from "./connector-actions.ts";
import type { OwniTool, PersonCall, ToolContext } from "./engine.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";
import { oneLine } from "./plain-text.ts";

/**
 * A step another agente asked for that needs a person's yes (ADR 0108). Agente A writes to B
 * (agent_message, ADR 0042); B's tool reaches a step that requirePersonFor keeps for a person.
 * Instead of a dead end the exact call waits here for one of B's approvers: approved, it runs
 * once with those arguments; the outcome goes to A's conversation as a notice. A's words never
 * count as the yes, and A's people cannot give it.
 */
export type AgentRequest = {
	readonly id: string;
	/** B's tool, by name, and the arguments it was called with: what runs if approved, as it is. */
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
	/** The arguments as the approver reads them. */
	readonly shown: readonly (readonly [string, string])[];
	/** The step, in B's first person («cambio la numerazione delle fatture»), from the tool's own gate. */
	readonly what: string;
	/** What it will write, as the tool previews it for a person (an invoice's lines and totals): read by the approver. */
	readonly preview?: string;
	/** The call of the same tool that takes back what the request left (a draft), run when it is rejected or expires. */
	readonly undo?: Readonly<Record<string, unknown>>;
	/** The agente that asked, and what it wrote (data, never instructions). */
	readonly askedBy: AskedBy;
	/** B's conversation with A (channel agente). */
	readonly thread: { readonly channel: string; readonly threadId: string };
	/** A's conversation the request came from: the outcome goes there. */
	readonly origin: Origin;
	readonly status: QueuedStatus;
	readonly proposedAt: string;
	readonly expiryTold?: true;
	/** The asking agente was told the outcome of a decision: one not told is told again at start. */
	readonly outcomeTold?: true;
	readonly decidedBy?: { readonly channel: string; readonly userId: string };
	readonly decidedAt?: string;
	readonly result?: AgentRequestResult;
	/** Chats that have the card. */
	readonly notified?: readonly string[];
};

/** The agente that asked, as the system recorded it when it wrote: its name and its words. */
export type AskedBy = { readonly id: string; readonly name: string; readonly request?: string };

/** What the tool answered; or why it did not run; or that it is not known whether it did. */
export type AgentRequestResult = { readonly text: string } | { readonly error: string; readonly uncertain?: true };

export class AgentRequestError extends Error {
	override readonly name = "AgentRequestError";
}

/** The tool may have done it: never "not done", never done again. */
export class AgentRequestUncertain extends Error {
	override readonly name = "AgentRequestUncertain";
}

export const AGENT_REQUEST_LIMITS = {
	maxPending: 20,
	ttlMs: 24 * 3600_000,
	keepMs: 30 * 24 * 3600_000,
	maxArgsChars: 20_000,
	/** Every value is shown whole to the approver: longer ones are refused, never cut. */
	maxValueChars: 5_000,
	/** The preview is shown whole too: a longer one is refused, never cut. */
	maxPreviewChars: 8_000,
	/** A chat card longer than this is approved in the console. */
	maxCardChars: 1_500,
	maxResultChars: 8_000,
	/** Messages of other agenti kept, per agente, to show on a card the words that asked. */
	maxAsks: 200,
} as const;

export class AgentRequestStore {
	private readonly queue: ActionQueue<AgentRequest>;

	constructor(dir: string) {
		this.queue = new ActionQueue<AgentRequest>(dir, AGENT_REQUEST_LIMITS, (error) => error instanceof AgentRequestUncertain, () => new AgentRequestError(`troppe richieste in attesa (${AGENT_REQUEST_LIMITS.maxPending}): chi approva deve prima decidere quelle che aspettano`));
	}

	/** `key` (the tool call's) makes a rerun return the same request instead of a second one. */
	async propose(input: Pick<AgentRequest, "tool" | "args" | "what" | "preview" | "undo" | "askedBy" | "thread" | "origin">, now = new Date(), key?: string): Promise<AgentRequest> {
		const id = this.queue.idFor(key, "agent:");
		if (key !== undefined) {
			const existing = await this.get(id, now);
			if (existing !== undefined) return existing;
		}
		const L = AGENT_REQUEST_LIMITS;
		if (JSON.stringify(input.args).length > L.maxArgsChars) throw new AgentRequestError(`i dati dell'azione superano ${L.maxArgsChars} caratteri`);
		const shown = shownArgs(input.args);
		if (shown.some(([k, v]) => v.length > L.maxValueChars || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(k))) throw new AgentRequestError(`un dato è troppo lungo o ha caratteri di controllo nel nome`);
		if (input.preview !== undefined && input.preview.length > L.maxPreviewChars) throw new AgentRequestError(`l'anteprima di quello che scriverei supera ${L.maxPreviewChars} caratteri`);
		const request = input.askedBy.request === undefined ? undefined : input.askedBy.request.slice(0, AGENT_LIMITS.maxChars);
		const askedBy = { id: input.askedBy.id, name: oneLine(input.askedBy.name, 80), ...(request === undefined ? {} : { request }) };
		return this.queue.add({ ...input, askedBy, shown, id, status: "pending", proposedAt: now.toISOString() }, now);
	}

	get(id: string, now = new Date()): Promise<AgentRequest | undefined> {
		return this.queue.get(id, now);
	}

	list(now = new Date()): Promise<AgentRequest[]> {
		return this.queue.list(now);
	}

	/** One decision at a time per request, the first one wins. Approving runs it once with `run`. */
	async decide(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, run: (request: AgentRequest) => Promise<AgentRequestResult>, now = new Date()): Promise<{ action: AgentRequest; changed: boolean }> {
		const decided = await this.queue.decide(id, decision, () => {}, { decidedBy: by }, run, now);
		if (decided.missing) throw new AgentRequestError(`nessuna richiesta ${id}`);
		return decided;
	}

	expiredUntold(now = new Date()): Promise<AgentRequest[]> {
		return this.queue.expiredUntold(now);
	}

	claimExpired(id: string, now = new Date()): Promise<AgentRequest | undefined> {
		return this.queue.claimExpired(id, now);
	}

	/** At start: a step left running by a dead process may or may not have happened. */
	settleInterrupted(): Promise<AgentRequest[]> {
		return this.queue.settleInterrupted((a) => ({ ...a, status: "uncertain", result: { error: "Owni si è riavviata mentre la faceva", uncertain: true } }));
	}

	/** Decided, and the asking agente not told yet (the notice failed, or Owni stopped first): within a day. */
	async outcomeUntold(now = new Date()): Promise<AgentRequest[]> {
		return (await this.list(now)).filter((r) => (r.status === "done" || r.status === "failed" || r.status === "uncertain" || r.status === "rejected") && r.outcomeTold !== true && now.getTime() - Date.parse(r.decidedAt ?? r.proposedAt) <= AGENT_REQUEST_LIMITS.ttlMs);
	}

	markOutcomeTold(id: string): Promise<void> {
		return this.queue.update(id, (current) => ({ ...current, outcomeTold: true }));
	}

	markNotified(id: string, chat: string): Promise<void> {
		return this.queue.update(id, (current) => ({ ...current, notified: [...new Set([...(current.notified ?? []), chat])] }));
	}
}

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
				.slice(0, AGENT_REQUEST_LIMITS.maxAsks - 1);
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

export type AgentRequestDeps = {
	readonly store: AgentRequestStore;
	readonly asks: AgentAsks;
	/** Whether at least one of this agente's approvers can be reached (console or chat). */
	readonly reachable: () => Promise<boolean>;
	/** Send the card to the approvers. */
	readonly proposed: (request: AgentRequest) => Promise<void>;
	readonly record: (event: AuditEvent) => Promise<void>;
};

/**
 * The tools of agente B, with another agente's step that needs a yes sent to B's approvers: a
 * call in a conversation on the channel agente whose tool refused it through requirePersonFor,
 * handing over the confirmed call and its preview (requirePersonFor's `call`), becomes a request
 * waiting for one of them. Opt-in: a tool that hands over no call keeps its refusal. Elsewhere (a
 * stanza, a person's turn) nothing changes.
 */
export function withAgentRequests(tools: readonly OwniTool[], deps: AgentRequestDeps): OwniTool[] {
	return tools.map((tool) => ({
		...tool,
		execute: async (args, ctx) => {
			const thread = ctx.thread;
			const asked = ctx.origin === "agent" && thread?.channel === AGENT_CHANNEL ? parseAgentThread(thread.threadId) : undefined;
			if (asked === undefined || thread === undefined) return tool.execute(args, ctx);
			let needed: { what: string; call?: PersonCall } | undefined;
			const out = await tool.execute(args, {
				...ctx,
				needsPerson: (what, call) => {
					needed ??= { what, ...(call === undefined ? {} : { call }) };
				},
			});
			// Only a tool that hands over its confirmed call goes to the approvers: the others refuse, as for any agente.
			if (needed?.call === undefined) return out;
			const { what, call } = needed;
			return ctx.step("agent-request", () => escalate(tool.name, what, call, asked, thread, ctx, deps));
		},
	}));
}

async function escalate(tool: string, what: string, call: PersonCall, asked: { from: string; origin: Origin }, thread: { channel: string; threadId: string }, ctx: ToolContext, deps: AgentRequestDeps): Promise<string> {
	const askedBy = (await askedByIn(deps.asks, thread, ctx.inputs)) ?? { id: asked.from, name: asked.from };
	if (!(await deps.reachable())) {
		await deps.record({ type: "agent_request.unreachable", tool, from: asked.from });
		return `Errore: per questo («${what}») serve il sì di una persona che approva per te, e non ne hai nessuna raggiungibile. Non l'hai fatto. Rispondi a «${askedBy.name}» che non puoi farlo senza l'approvazione di una persona e che nessuno può darla ora; non riprovarlo.`;
	}
	let request: AgentRequest;
	try {
		request = await deps.store.propose({ tool, args: call.args, what, preview: call.preview, ...(call.undo === undefined ? {} : { undo: call.undo }), askedBy, thread, origin: asked.origin }, new Date(), ctx.callId);
	} catch (error) {
		if (error instanceof AgentRequestError) return `Errore: ${error.message}. Non l'hai fatto: dillo a «${askedBy.name}».`;
		throw error;
	}
	if (request.status !== "pending") return `Richiesta ${request.id} già decisa (${request.status}): non rifarla da sola.`;
	await deps.record({ type: "agent_request.proposed", requestId: request.id, tool, from: asked.from });
	await deps.proposed(request);
	return `Richiesta ${request.id} pronta: per questo («${what}») serve il sì di una persona che approva per te, e l'hai chiesto a loro (console web, in Approvazioni, e le loro chat). Rispondi ora a «${askedBy.name}» in una frase: aspetta l'approvazione di una persona, e l'esito gli arriva direttamente quando viene decisa o se scade fra 24 ore. Non dire che è fatta e non richiamare lo strumento per la stessa azione.`;
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

/** Whether a card in a chat can show it all: long values, or many, are approved in the console. */
export function agentRequestFitsInChat(request: Pick<AgentRequest, "shown" | "preview">): boolean {
	const size = request.shown.reduce((n, [k, v]) => n + k.length + v.length + 3, request.preview?.length ?? 0);
	return request.shown.every(([, v]) => v.length <= 300) && size <= AGENT_REQUEST_LIMITS.maxCardChars;
}

/** The chat card: who asked and in which words, what would run, with exactly which data. */
export function agentRequestCard(request: AgentRequest, self: string, fits: boolean): string {
	const values = request.shown.map(([k, v]) => `${k}: ${v.length > 300 ? `${v.slice(0, 300)}[...]` : v}`);
	const listed = fits ? values : values.slice(0, 10).concat(values.length > 10 ? [`(e altri ${values.length - 10} dati)`] : []);
	const expires = new Date(Date.parse(request.proposedAt) + AGENT_REQUEST_LIMITS.ttlMs).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
	const long = fits ? "" : "\n\nÈ lunga: si legge intera e si approva solo dalla console web (Approvazioni). Da qui puoi rifiutarla.";
	const preview = request.preview === undefined || !fits ? "" : `\n\nCosa scriverei:\n${request.preview}`;
	return `${self}: richiesta di un altro agente da approvare · ${request.id}${askedByLines(request.askedBy)}\n\nAzione: ${request.what} (${request.tool})\n\n${listed.length > 0 ? listed.join("\n") : "(nessun dato)"}${preview}${long}\n\nScade il ${expires}.`;
}

/** What A is told: the outcome only, in fixed words (what B's tool answered, or why it failed, stays with B's approvers), A's words fenced as data. */
export function agentRequestReport(request: AgentRequest, self: { readonly id: string; readonly name: string }): string {
	const head = `[Esito della tua richiesta all'agente «${self.name}» (${self.id})] Azione: ${request.what}.`;
	const yours = request.askedBy.request === undefined ? "" : `\nLa tua richiesta era:\n${fencedAgentRequest(request.askedBy.id, request.askedBy.request)}`;
	const result = request.result;
	const tell = "Dillo a chi te l'aveva chiesto, in questa conversazione, con parole tue.";
	if (request.status === "expired") return `${head} Nessuna delle persone che approvano per «${self.name}» l'ha decisa entro 24 ore: è scaduta e non è stata fatta. ${tell} Non richiederla da solo.${yours}`;
	if (request.status === "rejected") return `${head} Una persona che approva per «${self.name}» l'ha rifiutata: non è stata fatta. ${tell} Non richiederla, a meno che non te lo chiedano.${yours}`;
	if (result !== undefined && "error" in result && result.uncertain) return `${head} Approvata da una persona che approva per «${self.name}», ma non si sa se è stata fatta. ${tell} Il motivo lo vede chi approva per «${self.name}»: suggerisci di chiederlo a loro prima di chiederla di nuovo.${yours}`;
	if (result === undefined || "error" in result) return `${head} Approvata da una persona che approva per «${self.name}», ma non è riuscita: chi approva per «${self.name}» vede il motivo. ${tell} Non richiederla da solo.${yours}`;
	return `${head} Approvata da una persona che approva per «${self.name}» e fatta. ${tell}${yours}`;
}

/**
 * Runs an approved request's tool, once, as the approver's own act: a person's yes for exactly
 * these arguments. Outside B's conversation with A (no thread), so no tool takes it for A's turn.
 */
export async function runAgentRequest(tools: readonly OwniTool[] | undefined, request: AgentRequest, signal: AbortSignal = new AbortController().signal): Promise<AgentRequestResult> {
	const tool = tools?.find((t) => t.name === request.tool);
	if (tool === undefined) throw new AgentRequestError(`lo strumento ${request.tool} non c'è più`);
	let out: Awaited<ReturnType<OwniTool["execute"]>>;
	try {
		const by = request.decidedBy === undefined ? {} : { approvedBy: `${request.decidedBy.channel}:${request.decidedBy.userId}` };
		out = await tool.execute({ ...request.args }, { callId: `agent-request:${request.id}`, origin: "person", signal, progress: () => {}, step: (_key, work) => work(), ...by });
	} catch (error) {
		throw new AgentRequestUncertain(error instanceof Error ? error.message : String(error));
	}
	const text = (typeof out === "string" ? out : out.text).slice(0, AGENT_REQUEST_LIMITS.maxResultChars);
	if (/^Errore\b/.test(text)) throw new AgentRequestError(text);
	return { text };
}

/**
 * Takes back what a request rejected or expired left (its `undo`: a draft made for it), as a
 * person's act of this agente, once: an error is the caller's to log, the decision stands.
 */
export async function undoAgentRequest(tools: readonly OwniTool[] | undefined, request: AgentRequest, signal: AbortSignal = new AbortController().signal): Promise<void> {
	if (request.undo === undefined) return;
	const tool = tools?.find((t) => t.name === request.tool);
	if (tool === undefined) throw new AgentRequestError(`lo strumento ${request.tool} non c'è più`);
	const out = await tool.execute({ ...request.undo }, { callId: `agent-request-undo:${request.id}`, origin: "person", signal, progress: () => {}, step: (_key, work) => work() });
	const text = typeof out === "string" ? out : out.text;
	if (/^Errore\b/.test(text)) throw new AgentRequestError(text.slice(0, 300));
}
