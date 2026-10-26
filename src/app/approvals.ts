import type { ChannelAdapter, InboundAction } from "../channels/types.ts";
import type { McpConnectionsOptions } from "../connectors/mcp.ts";
import { askedByIn, askedByLines } from "../core/agent-asks.ts";
import { connectorAction, type DecisionKind, decide, NotAnApprover, toolProposal, webAction, webActionReport } from "../core/approvals.ts";
import { CONNECTOR_ACTION_LIMITS, type ConnectorAction, ConnectorActionError, type ConnectorActionResult, connectorActionReport, fitsInChat } from "../core/connector-actions.ts";
import { type GoogleAction, googleActionReport } from "../core/google-actions.ts";
import { customToolName, type ToolProposal } from "../core/proposals.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { WebAction, WebActionResult } from "../core/web-actions.ts";

/** Every approval queue keeps a request 24 hours; one that expired longer ago than this is closed without a notice. */
const EXPIRY_TTL_MS = 24 * 3600_000;
const EXPIRY_GRACE_MS = 6 * 3600_000;

type Decision = "approved" | "rejected";
type ConnectorProposal = Parameters<NonNullable<McpConnectionsOptions["actions"]>["propose"]>[0];
type Thread = { readonly channel: string; readonly threadId: string };

export type ApprovalWiring = {
	readonly runtime: OwniRuntime;
	readonly tenant: string;
	/** The instance's Telegram and WhatsApp, where cards go. */
	readonly chats: (instance: string) => readonly (ChannelAdapter | undefined)[];
	readonly runConnectorAction: (instance: string) => (action: ConnectorAction) => Promise<ConnectorActionResult>;
	readonly sendWebAction: (instance: string) => (action: WebAction) => Promise<WebActionResult>;
	/** «Approva» under a scheda (board:...). */
	readonly onBoardTap: (instance: string, adapter: ChannelAdapter, action: InboundAction) => Promise<void>;
	readonly log: (message: string) => void;
};

type Card = { readonly id: string; readonly status: string; readonly notified?: readonly string[]; readonly decidedBy?: { readonly channel: string; readonly userId: string } };

/** A request decided from a card with buttons in Telegram or WhatsApp. */
type ChatKind<T extends Card> = {
	/** Callback data: `${prefix}:<id>:approved|rejected`. */
	readonly prefix: "tool" | "web" | "mcp";
	/** Idempotency key of a card: `${key}:<id>:<chat>`. */
	readonly key: string;
	/** For the log when a card is not sent. */
	readonly name: string;
	readonly store: (runtime: OwniRuntime, tenant: string, instance: string) => { get(id: string): Promise<T | undefined>; list(): Promise<T[]>; markNotified(id: string, chat: string): Promise<void> };
	/** The chats of `channel` that get the card. */
	readonly chats: (record: InstanceRecord, channel: string, item: T) => Iterable<string>;
	readonly text: (item: T) => string;
	/** Short enough to approve from the chat; otherwise the card can only reject. */
	readonly fits: (item: T) => boolean;
	readonly approve: string;
	/** Whether a tap goes on to the decision (approving what is too long to read is only from the console). */
	readonly tappable: (item: T | undefined, decision: Decision) => boolean;
	readonly decision: (w: ApprovalWiring, instance: string) => DecisionKind<T>;
	/** The answer to the tap; `mine`: this tap decided it. */
	readonly reply: (item: T, mine: boolean) => string;
};

/** Values as the approver reads them on a card: each cut at 300 characters. */
const shownValues = (shown: readonly (readonly [string, string])[]) => shown.map(([k, v]) => `${k}: ${v.length > 300 ? `${v.slice(0, 300)}[...]` : v}`);

/** The approvers, and the person whose chat asked for it. */
function approversAndRequester(record: InstanceRecord, channel: string, item: { thread?: Thread; requester?: string }): Set<string> {
	const chats = new Set(record.approvers?.[channel] ?? []);
	if (item.thread?.channel === channel && item.requester !== undefined) chats.add(item.thread.threadId);
	return chats;
}

const queuedReply = (words: Record<string, string>) => (item: { id: string; status: string }, mine: boolean) => `Richiesta ${item.id}: ${words[item.status] ?? item.status}${mine || item.status === "expired" ? "" : " (decisa in precedenza)"}.`;

export const toolCard: ChatKind<ToolProposal> = {
	prefix: "tool",
	key: "proposal",
	name: "approval card",
	store: (runtime, tenant, instance) => runtime.proposals(tenant, instance),
	// Only the approvers: a tool is not the asker's to decide.
	chats: (record, channel) => record.approvers?.[channel] ?? [],
	text: (proposal) => {
		// An approver approves what they read: with the code cut, no button, only the console.
		const truncated = proposal.code.length > 1500;
		const code = truncated ? `${proposal.code.slice(0, 1500)}\n[...]` : proposal.code;
		return `Nuovo tool da approvare · ${customToolName(proposal.name)}\n\n${proposal.description}\n\nHost raggiungibili: ${proposal.hosts.length > 0 ? proposal.hosts.join(", ") : "nessuno"}\n\nCodice:\n${code}${truncated ? `\n\nIl codice è lungo ${proposal.code.length} caratteri: leggilo tutto e decidi nella console web (Approvazioni).` : ""}`;
	},
	fits: (proposal) => proposal.code.length <= 1500,
	approve: "Approva",
	// A proposal missing here still goes to the decision, which says so.
	tappable: (proposal, decision) => decision === "rejected" || (proposal?.code.length ?? 0) <= 1500,
	decision: () => toolProposal,
	reply: (proposal, mine) => `${customToolName(proposal.name)}: ${proposal.status === "approved" ? "approvato" : "rifiutato"}${mine ? "" : " (deciso in precedenza)"}.`,
};

export const webCard: ChatKind<WebAction> = {
	prefix: "web",
	key: "web-action",
	name: "web action card",
	store: (runtime, tenant, instance) => runtime.webActions(tenant, instance),
	chats: approversAndRequester,
	text: (action) => {
		// Everything that leaves except hidden fields: page defaults and the button pressed too.
		const values = shownValues(action.shown);
		return `Azione sul web da approvare · richiesta ${action.id}${askedByLines(action.askedBy)}\n\n${action.reason}\n\nPagina: ${action.pageUrl}\nInvio a: ${action.action}\n\n${values.length > 0 ? values.join("\n") : "(nessun campo compilato)"}${webCard.fits(action) ? "" : "\n\nAlcuni valori sono lunghi: leggili interi e decidi nella console web (Approvazioni)."}\n\nScade fra 24 ore.`;
	},
	fits: (action) => !action.shown.some(([, v]) => v.length > 300),
	approve: "Invia",
	tappable: (action, decision) => action !== undefined && (decision === "rejected" || webCard.fits(action)),
	decision: (w, instance) => webAction(w.sendWebAction(instance)),
	reply: queuedReply({ rejected: "rifiutata", expired: "scaduta", done: "approvata e inviata", failed: "approvata, ma il modulo non è partito", uncertain: "approvata, esito incerto" }),
};

export const connectorCard: ChatKind<ConnectorAction> = {
	prefix: "mcp",
	key: "connector-action",
	name: "connector action card",
	store: (runtime, tenant, instance) => runtime.connectorActions(tenant, instance),
	chats: approversAndRequester,
	text: (action) => {
		const fits = fitsInChat(action);
		const values = shownValues(action.shown);
		const expires = new Date(Date.parse(action.proposedAt) + CONNECTOR_ACTION_LIMITS.ttlMs).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
		const long = "\n\nÈ lunga: si legge intera e si approva solo dalla console web (Approvazioni), da chi l'ha chiesta o da un approvatore. Da qui puoi rifiutarla.";
		const shown = fits ? values : values.slice(0, 10).concat(values.length > 10 ? [`(e altri ${values.length - 10} dati)`] : []);
		return `${action.connectorName}: azione da approvare · richiesta ${action.id}${askedByLines(action.askedBy)}\n\n${action.reason}\n\nAzione: ${action.toolTitle} (${action.tool})${action.destructive ? ", può cancellare o sovrascrivere" : ""}\n\n${shown.length > 0 ? shown.join("\n") : "(nessun dato)"}${fits ? "" : long}\n\nScade il ${expires}.`;
	},
	fits: fitsInChat,
	approve: "Approva",
	tappable: (action, decision) => action !== undefined && (decision === "rejected" || fitsInChat(action)),
	decision: (w, instance) => connectorAction(w.runConnectorAction(instance), w.log),
	reply: queuedReply({ rejected: "rifiutata", expired: "scaduta", done: "approvata e fatta", failed: "approvata, ma non è riuscita", uncertain: "approvata, esito incerto" }),
};

type Queued = { readonly id: string; readonly proposedAt: string; readonly thread?: Thread };

/** A queue of requests that expire undecided and may be left half done by a restart. */
type QueueKind<A extends Queued> = {
	readonly type: "web_action" | "connector_action" | "google_action";
	readonly store: (
		runtime: OwniRuntime,
		tenant: string,
		instance: string,
	) => { settleInterrupted(): Promise<A[]>; expiredUntold(now: Date): Promise<A[]>; claimExpired(id: string, now: Date): Promise<A | undefined> };
	readonly report: (action: A) => string;
	/** Audits and tells a request a restart left without an outcome. */
	readonly interrupted: (runtime: OwniRuntime, tenant: string, instance: string, action: A) => Promise<void>;
};

const webQueue: QueueKind<WebAction> = {
	type: "web_action",
	store: (runtime, tenant, instance) => runtime.webActions(tenant, instance),
	report: webActionReport,
	// A form left half-sent by the previous process is never sent again: the conversation is told.
	interrupted: async (runtime, tenant, instance, action) => {
		await runtime.audit(tenant).append({ type: "web_action.uncertain", instanceId: instance, actionId: action.id });
		if (action.thread !== undefined) await runtime.sendMessage(tenant, instance, { ...action.thread, text: `Richiesta ${action.id}: Owni si è riavviata mentre inviava il modulo a ${new URL(action.action).host}. Non so se è arrivato: controlla sul sito prima di chiederlo di nuovo.`, key: `web-action:${action.id}:uncertain` }).catch(() => {});
	},
};

const googleQueue: QueueKind<GoogleAction> = {
	type: "google_action",
	store: (runtime, tenant, instance) => runtime.googleActions(tenant, instance),
	report: googleActionReport,
	interrupted: async (runtime, tenant, instance, action) => {
		await runtime.audit(tenant).append({ type: "google_action.uncertain", instanceId: instance, actionId: action.id, kind: action.kind, personId: action.personId });
		if (action.thread !== undefined) await runtime.submitNotice(tenant, instance, { ...action.thread, messageId: `google-action:${action.id}`, text: googleActionReport(action), event: { source: "google_action", actionId: action.id } }).catch(() => {});
	},
};

const connectorQueue: QueueKind<ConnectorAction> = {
	type: "connector_action",
	store: (runtime, tenant, instance) => runtime.connectorActions(tenant, instance),
	report: connectorActionReport,
	interrupted: async (runtime, tenant, instance, action) => {
		await runtime.audit(tenant).append({ type: "connector_action.uncertain", instanceId: instance, actionId: action.id, connector: action.connectorId, tool: action.tool });
		if (action.thread !== undefined) await runtime.submitNotice(tenant, instance, { ...action.thread, messageId: `connector-action:${action.id}`, text: connectorActionReport(action), event: { source: "connector_action", actionId: action.id } }).catch(() => {});
	},
};

export type Approvals = {
	/** Sends the card to each chat that should have it and does not yet. */
	notify<T extends Card>(kind: ChatKind<T>, instance: string, item: T): Promise<void>;
	/** A connector call that changes something, waiting for a person: stored, then its card sent. What the model is told. */
	proposeConnectorAction(instance: string, input: ConnectorProposal): Promise<string>;
	/** A button tapped under a card (tool:, web:, mcp:, board:). */
	onTap(instance: string, adapter: ChannelAdapter, action: InboundAction): Promise<void>;
	/** After a restart: requests left half done are settled and told; pending ones get their cards again. */
	start(instances: readonly InstanceRecord[], conversational: (instance: string) => boolean): Promise<void>;
	/** Requests nobody decided in 24 hours: the conversation that asked is told once. */
	tellExpired(instances: readonly InstanceRecord[], now: Date): Promise<void>;
};

/** Approval cards in the chats, the taps under them, and the queues across restarts and expiry. */
export function startApprovals(w: ApprovalWiring): Approvals {
	const { runtime, tenant, log } = w;

	async function notify<T extends Card>(kind: ChatKind<T>, instance: string, item: T): Promise<void> {
		const record = await runtime.registry.getInstance(tenant, instance);
		const text = kind.text(item);
		const reject = { label: "Rifiuta", data: `${kind.prefix}:${item.id}:rejected` };
		const buttons = kind.fits(item) ? [{ label: kind.approve, data: `${kind.prefix}:${item.id}:approved` }, reject] : [reject];
		for (const adapter of w.chats(instance)) {
			if (adapter === undefined) continue;
			for (const chat of kind.chats(record, adapter.name, item)) {
				if ((item.notified ?? []).includes(`${adapter.name}:${chat}`)) continue;
				try {
					await adapter.send({ tenantId: tenant, instanceId: instance, channel: adapter.name, threadId: chat, idempotencyKey: `${kind.key}:${item.id}:${chat}`, text, buttons });
					await kind.store(runtime, tenant, instance).markNotified(item.id, `${adapter.name}:${chat}`);
				} catch (error) {
					log(`owni: ${kind.name} for ${item.id} to ${adapter.name} ${chat} not sent: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	/** A connector call that changes something, waiting for a person (ADR 0025): stored, then its card sent. */
	async function proposeConnectorAction(instance: string, input: ConnectorProposal): Promise<string> {
		try {
			const requester = input.thread === undefined ? undefined : runtime.participant(tenant, instance, input.thread);
			const askedBy = await askedByIn(runtime.agentAsks(tenant, instance), input.thread, input.inputs);
			const action = await runtime.connectorActions(tenant, instance).propose(
				{
					connectorId: input.connector.id,
					connectorName: input.connector.name,
					server: input.server,
					tool: input.tool,
					toolTitle: input.toolTitle,
					args: input.args,
					reason: input.reason,
					destructive: input.destructive,
					...(input.thread === undefined ? {} : { thread: input.thread }),
					...(requester === undefined ? {} : { requester }),
					...(askedBy === undefined ? {} : { askedBy }),
				},
				new Date(),
				input.callId,
			);
			// A rerun finds the request it made: it is told where that stands, nobody is asked twice.
			if (action.status !== "pending") return `Richiesta ${action.id} già decisa (${action.status}): non rifarla da sola.`;
			await notify(connectorCard, instance, action);
			const inChat = action.thread !== undefined && action.requester !== undefined && (action.thread.channel === "telegram" || action.thread.channel === "whatsapp");
			const where = inChat ? "la card con i pulsanti è in questa chat" : action.thread?.channel === "web" ? "la card con i pulsanti è sopra la chat e in Approvazioni" : "si decide nella console web, in Approvazioni";
			return `Richiesta ${action.id} pronta (${action.toolTitle} su ${action.connectorName}): aspetta l'approvazione di chi l'ha chiesta o di un approvatore; ${where}. Se nessuno la decide entro 24 ore scade e non viene fatta. Non richiamare lo strumento per la stessa azione e non dire che è stata fatta finché non lo sai${action.thread === undefined ? "" : "; l'esito ti arriva in questa conversazione quando viene decisa o scade"}.`;
		} catch (error) {
			if (error instanceof ConnectorActionError) return `Errore: ${error.message}.`;
			throw error;
		}
	}

	async function onCardTap<T extends Card>(kind: ChatKind<T>, instance: string, adapter: ChannelAdapter, action: InboundAction, id: string, decision: Decision): Promise<void> {
		if (!kind.tappable(await kind.store(runtime, tenant, instance).get(id), decision)) return;
		try {
			const decided = await decide(kind.decision(w, instance), runtime, tenant, instance, id, decision, { channel: adapter.name, userId: action.userId });
			const mine = decided.decidedBy?.channel === adapter.name && decided.decidedBy.userId === action.userId;
			await adapter.send({ tenantId: tenant, instanceId: instance, channel: adapter.name, threadId: action.threadId, idempotencyKey: `decision:${action.actionId}`, text: kind.reply(decided, mine) });
		} catch (error) {
			// Not allowed to decide: silence (audited in decide).
			if (!(error instanceof NotAnApprover)) throw error;
		}
	}

	type Tap = (instance: string, adapter: ChannelAdapter, action: InboundAction, id: string, decision: Decision) => Promise<void>;
	const taps: Record<"mcp" | "web" | "tool", Tap> = {
		mcp: (...tap) => onCardTap(connectorCard, ...tap),
		web: (...tap) => onCardTap(webCard, ...tap),
		tool: (...tap) => onCardTap(toolCard, ...tap),
	};

	async function onTap(instance: string, adapter: ChannelAdapter, action: InboundAction): Promise<void> {
		if (action.data.startsWith("board:")) return w.onBoardTap(instance, adapter, action);
		const m = /^(mcp|web|tool):([0-9a-f]{12}):(approved|rejected)$/.exec(action.data);
		if (m === null) return;
		return taps[m[1] as keyof typeof taps](instance, adapter, action, m[2] as string, m[3] as Decision);
	}

	async function pending<T extends Card>(kind: ChatKind<T>, instance: string): Promise<void> {
		for (const item of await kind.store(runtime, tenant, instance).list()) if (item.status === "pending") await notify(kind, instance, item);
	}

	async function settle<A extends Queued>(kind: QueueKind<A>, instance: string): Promise<void> {
		for (const action of await kind.store(runtime, tenant, instance).settleInterrupted()) await kind.interrupted(runtime, tenant, instance, action);
	}

	async function start(instances: readonly InstanceRecord[], conversational: (instance: string) => boolean): Promise<void> {
		await Promise.all(
			instances.map(async (record) => {
				await settle(webQueue, record.id);
				await settle(googleQueue, record.id);
				await settle(connectorQueue, record.id);
				if (!conversational(record.id)) return;
				await pending(toolCard, record.id);
				await pending(connectorCard, record.id);
				await pending(webCard, record.id);
			}),
		);
	}

	/** At most every few minutes; requests that expired long ago (before this existed, or while Owni was off) are closed without a notice. */
	let lastSweep = 0;
	async function tellExpired(instances: readonly InstanceRecord[], now: Date): Promise<void> {
		if (now.getTime() - lastSweep < 5 * 60_000) return;
		lastSweep = now.getTime();
		for (const record of instances) {
			await tellExpiredIn(record.id, connectorQueue, now);
			await tellExpiredIn(record.id, webQueue, now);
			await tellExpiredIn(record.id, googleQueue, now);
		}
	}

	async function tellExpiredIn<A extends Queued>(instance: string, kind: QueueKind<A>, now: Date): Promise<void> {
		const store = kind.store(runtime, tenant, instance);
		let expired: A[];
		try {
			expired = await store.expiredUntold(now);
		} catch (error) {
			// One unreadable file must not stop the other queues.
			log(`owni: ${kind.type} queue of ${instance} not read: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		for (const candidate of expired) {
			const action = await store.claimExpired(candidate.id, now).catch(() => undefined);
			if (action === undefined) continue;
			const stale = now.getTime() - Date.parse(action.proposedAt) > EXPIRY_TTL_MS + EXPIRY_GRACE_MS;
			let told = false;
			let reason: string | undefined = stale ? "stale" : action.thread === undefined ? "no_conversation" : undefined;
			if (reason === undefined && action.thread !== undefined) {
				try {
					await runtime.submitNotice(tenant, instance, { ...action.thread, messageId: `${kind.type.replace("_", "-")}:${action.id}:expired`, text: kind.report(action), event: { source: kind.type, actionId: action.id } });
					told = true;
				} catch (error) {
					reason = error instanceof Error ? error.name : "error";
					log(`owni: expiry of ${action.id} not passed on: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			await runtime.audit(tenant).append({ type: `${kind.type}.expired`, instanceId: instance, actionId: action.id, told, ...(reason === undefined ? {} : { reason }) }).catch(() => {});
		}
	}

	return { notify, proposeConnectorAction, onTap, start, tellExpired };
}
