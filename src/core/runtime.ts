import { mkdir } from "node:fs/promises";
import { AuditLog } from "./audit.ts";
import { recordTurn, UsageLedger } from "./usage.ts";
import { SerialQueue } from "./serial-queue.ts";
import { AgentAsks } from "./agent-asks.ts";
import { ConnectorActionStore } from "./connector-actions.ts";
import type { OwniTool, DurableEngine, EngineImage, EngineReply, EngineSession, EngineRunEvent, EngineRunState } from "./engine.ts";
import { RunStore, isActiveRun, runId, runRequestId, type RunRecord, type RunEvent, type RunFilter } from "./run-store.ts";
export type { RunRecord, RunEvent, RunFilter, RunStatus } from "./run-store.ts";
import type { TurnOrigin } from "./turn-origin.ts";
import { IMAGE_LIMITS, imageProblem, imageType } from "./images.ts";
import { EgressDenied, NotFound, UserNotAllowed } from "./errors.ts";
import { type InstanceId, instanceId, type TenantId, tenantId } from "./ids.ts";
import { InstanceLock } from "./lock.ts";
import { Outbox, type OutboxEntry } from "./outbox.ts";
import { MemoryStore, memoryNote, Participants, SHARED, subjectOf } from "./memory.ts";
import { nowLine } from "./turn-context.ts";
import { agentAsksFile, connectorActionsDir, customToolsDir, engineDir, googleActionsDir, instanceDir, lockFile, outboxDir, proposalsDir, schedulesDir, tenantDir, watchesDir, webActionsDir, workspaceDir } from "./paths.ts";
import { GoogleActionStore } from "./google-actions.ts";
import { WebActionStore } from "./web-actions.ts";
import { ProposalStore } from "./proposals.ts";
import { ScheduleStore } from "./schedules.ts";
import { AutomationStore } from "./automations.ts";
import { WatchStore } from "./watches.ts";
import { Workspace } from "./workspace.ts";
import { assertChannelAllowed, assertModelProviderAllowed, assertUserAllowed, CHANNEL_PATTERN } from "./policy.ts";
import { DEV_PROVIDER } from "./model-providers.ts";
import { subscriptionProvider } from "./model-providers.ts";
import type { LocalProviders } from "./local-providers.ts";
import { AGENT_CHANNEL } from "./agent-messages.ts";
import { OrgStore, orgNote } from "./org.ts";
import { withPersona } from "./persona.ts";
import { activateCommand, SkillError, SkillStore, skillCatalog, skillCommand, withSkill } from "./skills.ts";
import { type InstanceRecord, type ModelSelection, TenantRegistry } from "./registry.ts";
import { modelApiKeySecret, TenantSecrets } from "./secrets.ts";

/** A normalized inbound message as the core sees it. Channels translate to this shape. */
export type SubmitRequest = {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly channel: string;
	readonly threadId: string;
	readonly userId: string;
	readonly text: string;
	/** The thread is with this person alone; in a group nobody's memoria applies. */
	readonly privateThread?: boolean;
	/** Channel-native message ID; makes a redelivered message idempotent. */
	readonly messageId?: string;
	/** Pictures that came with the message, already in the workspace at `path`: the model sees them. */
	readonly images?: readonly { readonly path: string; readonly data: Uint8Array }[];
	/** The person's own words when `text` wraps them in more (a stanza, ADR 0063): skill commands are read from these. */
	readonly command?: string;
	/**
	 * Not a person's turn although it comes in through a person's chat (ADR 0088): an agente that
	 * called this one in a stanza (`agent`), the board's own work (`scheduled`). Without it, a
	 * person's; on the agenti's channel always `agent`.
	 */
	readonly origin?: Exclude<TurnOrigin, "person">;
};

export type Reply = {
	readonly tenantId: TenantId;
	readonly instanceId: InstanceId;
	readonly channel: string;
	readonly threadId: string;
	/**
	 * Idempotency key of this reply, stable across restarts. Pass it to `markDelivered` once
	 * the channel has accepted the reply; until then it is sent again after a restart.
	 */
	readonly deliveryId: string;
	/**
	 * An earlier hand-off of this reply was never confirmed: the user may already have it.
	 * Same rule as `possibleDuplicate` in the audit (attempts > 1), so it also fires when the
	 * earlier try died before reaching the channel.
	 */
	readonly possibleDuplicate: boolean;
	/** Which hand-off of this reply this is (1 the first time). A failure report names it. */
	readonly attempt: number;
	/** The submission this reply answers; messages Owni sends by herself carry "message" or "file". */
	readonly submissionId: string;
} & (
	/** `model`: the one that wrote the answer, when the engine says. */
	| { readonly status: "answered"; readonly text: string; readonly model?: ModelSelection }
	| { readonly status: "unanswered"; readonly reason: string; readonly cancelled?: true }
	/** A file of the instance's workspace to send to the thread. */
	| { readonly status: "file"; readonly path: string; readonly caption?: string }
);

/** Tools of an instance, with what to release when it closes (connector connections). */
export type ToolSet = readonly OwniTool[] | { readonly tools: readonly OwniTool[]; readonly close: () => Promise<void> };

export type RuntimeOptions = {
	readonly dataDir: string;
	readonly engine: DurableEngine;
	readonly localProviders?: LocalProviders;
	/**
	 * Tools of an instance: the same list for all, or computed from the instance's record
	 * when it is opened (connectors, approved tools). A changed list applies on `reopen`.
	 */
	readonly tools?: readonly OwniTool[] | ((record: InstanceRecord) => Promise<ToolSet>);
	/**
	 * Waits before sending again a reply whose channel failed (network, timeout), one per
	 * attempt; the last repeats. A reply the channel refused is not retried in the process.
	 */
	readonly retryDelaysMs?: readonly number[];
	/** Retries in one process before the reply waits for the next resume. */
	readonly maxRetries?: number;
};

/** What happened to a send the channel did not confirm. */
export type DeliveryFailure = { readonly refused: boolean; readonly reason: string };

/** How long a delivered reply stays in the outbox. */
const OUTBOX_RETENTION_MS = 30 * 86_400_000;

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];
/** About two hours of tries with the default delays. */
export const DEFAULT_MAX_RETRIES = 14;

/**
 * Owni's core. Knows tenants, instances, secrets, audit and egress policy; runs each
 * instance on its own durable engine session and storage. Knows nothing about channels
 * beyond their names.
 */
export class OwniRuntime {
	readonly registry: TenantRegistry;
	private readonly instances = new Map<string, Promise<OwniInstance>>();
	private readonly listeners = new Set<(reply: Reply) => void>();
	private readonly runListeners = new Set<(event: RunEvent) => void>();
	private readonly participantStores = new Map<string, Participants>();
	/** Instances being deleted: nothing opens them meanwhile. */
	private readonly removing = new Set<string>();

	constructor(private readonly options: RuntimeOptions) {
		this.registry = new TenantRegistry(options.dataDir);
	}

	/** Only the configured local tenant may reach the machine owner's subscriptions. */
	localProviders(tenant: string): LocalProviders | undefined {
		return this.options.localProviders?.tenantId === tenant ? this.options.localProviders : undefined;
	}

	secrets(tenant: string): TenantSecrets {
		return new TenantSecrets(this.options.dataDir, tenantId(tenant));
	}

	/** The forms an instance asked to send (web_submit). */
	webActions(tenant: string, instance: string): WebActionStore {
		return new WebActionStore(webActionsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Writes to people's Google accounts waiting for (or past) their decision (ADR 0021). */
	googleActions(tenant: string, instance: string): GoogleActionStore {
		return new GoogleActionStore(googleActionsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Calls of connector tools that change something, waiting for (or past) a decision (ADR 0025). */
	connectorActions(tenant: string, instance: string): ConnectorActionStore {
		return new ConnectorActionStore(connectorActionsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** What other agenti last asked this instance, per conversation (ADR 0108). */
	agentAsks(tenant: string, instance: string): AgentAsks {
		return new AgentAsks(agentAsksFile(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The tools proposti of an instance. */
	proposals(tenant: string, instance: string): ProposalStore {
		return new ProposalStore(proposalsDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Folder of an instance's approved tools (one subfolder each) and of the sandbox runner. */
	customToolsDir(tenant: string, instance: string): string {
		return customToolsDir(this.options.dataDir, tenantId(tenant), instanceId(instance));
	}

	/**
	 * A message from the instance to a thread that is not a reply (a decision, a notice),
	 * through the outbox like a reply. The same `key` is sent once.
	 */
	async sendMessage(tenant: string, instance: string, message: { channel: string; threadId: string; text: string; key: string; secret?: boolean }): Promise<void> {
		await (await this.openInstance(tenant, instance)).sendMessage(message);
	}

	/** The organigramma of a tenant (ADR 0117): squadre, roles and who answers to whom. */
	org(tenant: string): OrgStore {
		return new OrgStore(tenantDir(this.options.dataDir, tenantId(tenant)));
	}

	/** The memoria of an instance: what it remembers about each person, and shared facts. */
	memory(tenant: string, instance: string): MemoryStore {
		return new MemoryStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The automazioni of an instance (ADR 0060): addresses other services call to make it work. */
	automations(tenant: string, instance: string): AutomationStore {
		return new AutomationStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The skills of an instance (ADR 0059): procedures its people saved, shared by all of them. */
	skills(tenant: string, instance: string): SkillStore {
		return new SkillStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** Whom a private thread is with, as "<channel>:<userId>"; undefined for a group or unknown thread. */
	participant(tenant: string, instance: string, thread: { channel: string; threadId: string }): string | undefined {
		return this.participants(tenant, instance).get(threadKey(thread.channel, thread.threadId));
	}

	private participants(tenant: string, instance: string): Participants {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		let store = this.participantStores.get(key);
		if (store === undefined) {
			store = new Participants(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
			this.participantStores.set(key, store);
		}
		return store;
	}

	/** The tasks programmati of an instance. */
	schedules(tenant: string, instance: string): ScheduleStore {
		return new ScheduleStore(schedulesDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The sentinelle of an instance: pages it checks by itself (ADR 0018). */
	watches(tenant: string, instance: string): WatchStore {
		return new WatchStore(watchesDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/** The files of an instance. Reading them needs no open instance. */
	workspace(tenant: string, instance: string): Workspace {
		return new Workspace(workspaceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)));
	}

	/**
	 * Send a workspace file to a thread, through the outbox like a reply: at least once,
	 * the same `key` at most once per process and never again after the channel accepted it.
	 */
	async sendFile(tenant: string, instance: string, file: { channel: string; threadId: string; path: string; caption?: string; key: string }): Promise<void> {
		const opened = await this.openInstance(tenant, instance);
		if ((await this.workspace(tenant, instance).stat(file.path)) === undefined) throw new Error(`File not found in the workspace: ${file.path}`);
		await opened.sendFile(file);
	}

	audit(tenant: string): AuditLog {
		return new AuditLog(this.options.dataDir, tenantId(tenant));
	}

	/** Open an instance's engine session once per process; later calls share it. */
	openInstance(tenant: string, instance: string): Promise<OwniInstance> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		if (this.removing.has(key)) return Promise.reject(new NotFound(`Instance "${instanceId(instance)}" is being deleted`));
		let opening = this.instances.get(key);
		if (opening === undefined) {
			opening = this.open(tenant, instance);
			opening.catch(() => this.instances.delete(key));
			this.instances.set(key, opening);
		}
		return opening;
	}

	async submit(request: SubmitRequest): Promise<{ submissionId: string; runId: string }> {
		return (await this.openInstance(request.tenantId, request.instanceId)).submit(request);
	}

	/** Read persisted history without starting an engine. Scope filters precede the limit. */
	async listRuns(tenant: string, instance: string, filter: RunFilter = {}): Promise<RunRecord[]> {
		await this.registry.getInstance(tenant, instance);
		return this.runStore(tenant, instance).list(filter);
	}

	currentRuns(tenant: string, instance: string, thread: { channel: string; threadId: string }): Promise<RunRecord[]> {
		return this.listRuns(tenant, instance, { ...thread, statuses: ["queued", "running"], limit: 200 });
	}

	async idle(tenant: string, instance: string): Promise<void> {
		await (await this.openInstance(tenant, instance)).idle();
	}

	/** Caller must authorize the exact conversation, as for reading its messages. */
	async stopConversation(tenant: string, instance: string, thread: { channel: string; threadId: string }): Promise<{ cancelled: number; runs: RunRecord[] }> {
		return (await this.openInstance(tenant, instance)).stopConversation(thread);
	}

	onRunEvent(listener: (event: RunEvent) => void): () => void {
		this.runListeners.add(listener);
		return () => this.runListeners.delete(listener);
	}

	private runStore(tenant: string, instance: string): RunStore {
		return new RunStore(instanceDir(this.options.dataDir, tenantId(tenant), instanceId(instance)), (event) => {
			for (const listener of this.runListeners) {
				try { listener(event); } catch (error) { console.error(`owni: run listener failed: ${String(error)}`); }
			}
		});
	}

	async chatModel(tenant: string, instance: string, channel: string, threadId: string): Promise<ModelSelection | undefined> {
		return (await this.openInstance(tenant, instance)).chatModel(channel, threadId);
	}

	async setChatModel(tenant: string, instance: string, chat: { channel: string; threadId: string }, model: ModelSelection | undefined, by: string): Promise<void> {
		await (await this.openInstance(tenant, instance)).setChatModel(chat.channel, chat.threadId, model, by);
	}

	async submitScheduled(
		tenant: string,
		instance: string,
		request: { channel: string; threadId: string; text: string; messageId: string; scheduleId: string; onBehalfOf: { channel: string; userId: string } | undefined; kind?: "brief" | "watch" | "automation" },
	): Promise<{ submissionId: string; runId: string }> {
		return (await this.openInstance(tenant, instance)).submitScheduled(request);
	}

	/** Something that happened for a conversation (the outcome of an approved action), for the instance to report there. */
	/** `origin`: a notice from the instance's own work (default), or another agente's answer (`agent`). */
	async submitNotice(tenant: string, instance: string, request: { channel: string; threadId: string; text: string; messageId: string; event: Record<string, string | number | boolean>; origin?: "notice" | "agent" }): Promise<{ submissionId: string; runId: string }> {
		return (await this.openInstance(tenant, instance)).submitNotice(request);
	}

	/**
	 * Resume one instance: hand undelivered replies of earlier processes to the channels
	 * again, then continue unfinished engine work. Connect channels before calling it.
	 */
	async resume(tenant: string, instance: string): Promise<{ pending: number; undelivered: number; reattached: number }> {
		return (await this.openInstance(tenant, instance)).resume();
	}

	/**
	 * The channel accepted `reply`: record it in the outbox so it is never sent again. Never
	 * opens the instance: after close() the reply stays in the outbox for the next process.
	 */
	async markDelivered(reply: Pick<Reply, "tenantId" | "instanceId" | "deliveryId">): Promise<void> {
		const opening = this.instances.get(`${reply.tenantId}/${reply.instanceId}`);
		if (opening === undefined) throw new Error(`Instance ${reply.tenantId}/${reply.instanceId} is not open; the reply stays in the outbox`);
		await (await opening).markDelivered(reply.deliveryId);
	}

	/**
	 * The channel did not take `reply`. A failure is sent again later in this process, with
	 * backoff; a refusal (the channel said no) waits for the next resume. Never opens the instance.
	 */
	async deliveryFailed(reply: Pick<Reply, "tenantId" | "instanceId" | "deliveryId" | "attempt">, failure: DeliveryFailure): Promise<void> {
		const opening = this.instances.get(`${reply.tenantId}/${reply.instanceId}`);
		if (opening === undefined) return;
		await (await opening).deliveryFailed(reply.deliveryId, reply.attempt, failure);
	}

	/**
	 * Close an open instance and open it again, so a changed record or tool list applies.
	 * Work in flight resumes as after a restart: unsent replies go out from the outbox.
	 */
	async reopen(tenant: string, instance: string): Promise<{ pending: number; undelivered: number; reattached: number }> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		if (this.removing.has(key)) throw new NotFound(`Instance "${instanceId(instance)}" is being deleted`);
		const previous = this.instances.get(key);
		// The map holds the reopening at once: a submit meanwhile waits for the new instance
		// instead of hitting the old one's lock, and a second reopen queues behind this one.
		const next = (async () => {
			await (await previous?.catch(() => undefined))?.close();
			if (this.removing.has(key)) throw new NotFound(`Instance "${instanceId(instance)}" is being deleted`);
			return this.open(tenant, instance);
		})();
		next.catch(() => {
			if (this.instances.get(key) === next) this.instances.delete(key);
		});
		this.instances.set(key, next);
		await next;
		// A later reopen may already have replaced this one: resume the current instance.
		return this.resume(tenant, instance);
	}

	/**
	 * Delete an instance (ADR 0046): close it if open, without resuming it, and remove its record
	 * and everything it kept. Work in flight is dropped with it. Channels, bots and the rest that
	 * live outside the core are the caller's to stop first.
	 */
	async removeInstance(tenant: string, instance: string): Promise<void> {
		const key = `${tenantId(tenant)}/${instanceId(instance)}`;
		if (this.removing.has(key)) throw new NotFound(`Instance "${instanceId(instance)}" is being deleted`);
		this.removing.add(key);
		try {
			const record = await this.registry.getInstance(tenant, instance);
			const open = this.instances.get(key);
			this.instances.delete(key);
			await (await open?.catch(() => undefined))?.close();
			this.participantStores.delete(key);
			// Another process with the instance open (the CLI, a bot run on its own) stops the deletion here.
			const lock = InstanceLock.acquire(lockFile(this.options.dataDir, record.tenantId, record.id), `${record.tenantId}/${record.id}`);
			try {
				await this.registry.deleteInstance(tenant, instance);
			} finally {
				lock.release();
			}
		} finally {
			this.removing.delete(key);
		}
	}

	/**
	 * Work under way in a tenant's open instances: submissions still waiting for their reply,
	 * and replies with a retry pending. A process that may be stopped (a cell) waits for zero.
	 * Replies that only wait for a restart do not count: the next resume sends them.
	 */
	async activity(tenant: string): Promise<{ working: number; retrying: number }> {
		const prefix = `${tenantId(tenant)}/`;
		let working = 0;
		let retrying = 0;
		for (const [key, opening] of this.instances) {
			if (!key.startsWith(prefix)) continue;
			const instance = await opening.catch(() => undefined);
			if (instance === undefined) continue;
			const a = await instance.activity();
			working += a.working;
			retrying += a.retrying;
		}
		return { working, retrying };
	}

	onReply(listener: (reply: Reply) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		const opened = await Promise.allSettled(this.instances.values());
		this.instances.clear();
		const closed = await Promise.allSettled(opened.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)));
		const failed = closed.find((result) => result.status === "rejected");
		if (failed !== undefined) throw failed.reason;
	}

	private async open(tenant: string, instance: string): Promise<OwniInstance> {
		const record = await this.registry.getInstance(tenant, instance);
		const audit = this.audit(record.tenantId);
		try {
			assertModelProviderAllowed(record.egress, record.model.provider);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await audit.append({ type: "egress.denied", instanceId: record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		const secrets = this.secrets(record.tenantId);
		const fresh = () => this.registry.getInstance(record.tenantId, record.id);
		// A model can answer: its provider allowed by the policy now, and a key for it (none for the local one).
		const reachable = async (provider: string) => {
			try {
				return (await fresh()).egress.modelProviders.includes(provider) && (provider === DEV_PROVIDER || (subscriptionProvider(provider) !== undefined ? this.localProviders(record.tenantId)?.connected(provider) === true : (await secrets.get(modelApiKeySecret(provider))) !== undefined));
			} catch {
				return false;
			}
		};
		const storageDir = engineDir(this.options.dataDir, record.tenantId, record.id);
		await mkdir(storageDir, { recursive: true });
		// Before anything touches the instance's storage: one process per instance.
		const lock = InstanceLock.acquire(lockFile(this.options.dataDir, record.tenantId, record.id), `${record.tenantId}/${record.id}`);
		let session: EngineSession;
		let toolSet: ToolSet = [];
		const runs = this.runStore(record.tenantId, record.id);
		// Its own instructions, then who it is (ADR 0041), its place in the company (ADR 0117), then its skills as they are now (ADR 0059).
		const own = withPersona(record.instructions, record.name, record.persona);
		const skills = this.skills(record.tenantId, record.id);
		const org = this.org(record.tenantId);
		const place = () => {
			try {
				return orgNote(org.read(), record.id, this.registry.instanceNamesSync(record.tenantId));
			} catch (error) {
				// An organigramma that cannot be read leaves the agente as it is, not without answers.
				console.error(`owni: organigramma unreadable: ${String(error)}`);
				return undefined;
			}
		};
		const instructions = () => [own, place(), skillCatalog(skills.list())].filter((part) => part !== undefined && part !== "").join("\n\n");
		const memory = this.memory(record.tenantId, record.id);
		const participants = this.participants(record.tenantId, record.id);
		try {
			toolSet = typeof this.options.tools === "function" ? await this.options.tools(record) : (this.options.tools ?? []);
			session = await this.options.engine.open({
				storageDir,
				stoppedThreads: (await runs.all()).filter((run) => isActiveRun(run) && run.cancelRequestedAt !== undefined).map((run) => threadKey(run.channel, run.threadId)),
				model: record.model,
				// Only this tenant's secrets, and only for providers the policy allows now.
				apiKey: async (provider) => {
					if (!(await fresh()).egress.modelProviders.includes(provider)) return undefined;
					if (subscriptionProvider(provider) !== undefined) return this.localProviders(record.tenantId)?.connected(provider) ? "owni-local-subscription" : undefined;
					return secrets.get(modelApiKeySecret(provider));
				},
				localProviders: this.localProviders(record.tenantId),
				modelUsable: reachable,
				tools: "tools" in toolSet ? toolSet.tools : toolSet,
				instructions,
				// The time, and the memories of whom the thread is with (only the shared ones in a group), as they are at each request.
				turnContext: (key) => {
					const subject = participants.get(key);
					const remembered = memory.contextFor(subject ?? SHARED);
					return `${nowLine(new Date())}${memoryNote(remembered.memories, remembered.archived)}`;
				},
			});
		} catch (error) {
			if ("close" in toolSet) await toolSet.close().catch(() => {});
			lock.release();
			throw error;
		}
		try {
			await audit.append({ type: "instance.opened", instanceId: record.id, modelProvider: record.model.provider });
		} catch (error) {
			await session
				.close()
				.then(() => ("close" in toolSet ? toolSet.close() : undefined))
				.finally(() => lock.release());
			throw error;
		}
		const outbox = new Outbox(outboxDir(this.options.dataDir, record.tenantId, record.id));
		const releaseTools = "close" in toolSet ? toolSet.close : async () => {};
		return new OwniInstance({
			record,
			runs,
			session,
			lock,
			outbox,
			audit,
			usage: new UsageLedger(tenantDir(this.options.dataDir, record.tenantId)),
			releaseTools,
			fresh,
			reachable,
			retry: { delaysMs: this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS, max: this.options.maxRetries ?? DEFAULT_MAX_RETRIES },
			memory: { store: memory, participants, skills },
			emit: (reply) => {
				for (const listener of this.listeners) {
					try {
						listener(reply);
					} catch (error) {
						console.error(`owni: reply listener failed: ${String(error)}`);
					}
				}
			},
		});
	}
}

/** Outbox keys of messages whose text goes once delivered. */
const SECRET_KEY = "secret:";

export interface OwniInstanceOptions {
	readonly record: InstanceRecord;
	readonly runs: RunStore;
	readonly session: EngineSession;
	readonly lock: InstanceLock;
	readonly outbox: Outbox;
	readonly audit: AuditLog;
	/** The tenant's spend (usage.ts): each answered turn adds what it cost. */
	readonly usage: UsageLedger;
	readonly releaseTools: () => Promise<void>;
	/** The record as stored now: allowlist and channel changes apply without a reopen. */
	readonly fresh: () => Promise<InstanceRecord>;
	/** The provider is allowed now and has a key: a chat's own model on it can answer. Never throws. */
	readonly reachable: (provider: string) => Promise<boolean>;
	readonly retry: { readonly delaysMs: readonly number[]; readonly max: number };
	readonly memory: { readonly store: MemoryStore; readonly participants: Participants; readonly skills: SkillStore };
	readonly emit: (reply: Reply) => void;
}

export class OwniInstance {
	/** Outbox keys this process has handed to the channels. Each at most once per process. */
	private readonly handedOff = new Set<string>();
	/** Outbox operations on the same key run one after the other. */
	private readonly chains = new SerialQueue();
	/** Pending in-process retries, cleared on close. */
	private readonly retries = new Map<string, NodeJS.Timeout>();
	private closed = false;
	private readonly submissions = new SerialQueue();
	private readonly events = new SerialQueue();
	private recovery: Promise<void> | undefined;
	/** Failed in-process Stop attempts; durable intent remains in runs.json for restart. */
	private readonly pendingStops = new Set<string>();
	/** A failed acknowledgement whose durable admission could not yet be read. */
	private readonly pendingAdmissions = new Set<string>();
	private readonly runs: RunStore;

	readonly record: InstanceRecord;
	private readonly session: EngineSession;
	private readonly lock: InstanceLock;
	private readonly outbox: Outbox;
	private readonly audit: AuditLog;
	private readonly usage: UsageLedger;
	private readonly releaseTools: () => Promise<void>;
	private readonly fresh: () => Promise<InstanceRecord>;
	private readonly reachable: (provider: string) => Promise<boolean>;
	private readonly retry: OwniInstanceOptions["retry"];
	private readonly memory: OwniInstanceOptions["memory"];
	private readonly emit: (reply: Reply) => void;

	constructor(options: OwniInstanceOptions) {
		const { record, session } = options;
		this.record = record;
		this.runs = options.runs;
		this.session = session;
		this.lock = options.lock;
		this.outbox = options.outbox;
		this.audit = options.audit;
		this.usage = options.usage;
		this.releaseTools = options.releaseTools;
		this.fresh = options.fresh;
		this.reachable = options.reachable;
		this.retry = options.retry;
		this.memory = options.memory;
		this.emit = options.emit;
		session.onRunEvent?.((event) => {
			if (this.closed) return;
			this.events.run("events", () => this.applyRunEvent(event)).catch((error: unknown) => console.error(`owni: recording run progress failed: ${String(error)}`));
		});
		session.onReply((engineReply) => {
			this.deliver(engineReply).catch((error: unknown) => {
				console.error(`owni: delivering a reply of ${record.tenantId}/${record.id} failed: ${String(error)}`);
			});
		});
	}

	async submit(request: Omit<SubmitRequest, "tenantId" | "instanceId">): Promise<{ submissionId: string; runId: string }> {
		if (!CHANNEL_PATTERN.test(request.channel)) throw new Error(`Invalid channel name "${request.channel}"`);
		const record = await this.fresh();
		try {
			assertChannelAllowed(record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		// Who may talk to the instance is decided here, in the core, for every channel: a
		// rejected message never reaches the engine or the model, and gets no reply.
		try {
			assertUserAllowed(record.allowedUsers, request);
		} catch (error) {
			if (error instanceof UserNotAllowed) {
				await this.audit.append({
					type: "user.denied",
					instanceId: this.record.id,
					channel: error.channel,
					userId: error.userId,
					threadId: error.threadId,
					reason: error.reason,
				});
			}
			throw error;
		}
		const { images, skipped } = checkedImages(request.images ?? []);
		await this.audit.append({
			type: "message.received",
			instanceId: this.record.id,
			channel: request.channel,
			threadId: request.threadId,
			userId: request.userId,
			chars: request.text.length,
			...(images.length === 0 ? {} : { images: images.length }),
		});
		// In a private thread the instance learns whom it is with, and each request gets what it
		// remembers about them; in a group, only the shared memories, so one person's never reach the others.
		const key = threadKey(request.channel, request.threadId);
		const { privateThread, images: _given, command: _command, ...message } = request;
		if (privateThread === true) this.memory.participants.set(key, subjectOf(request.channel, request.userId));
		else this.memory.participants.clear(key);
		const { origin: given, ...said } = message;
		// Another agente's words are never the person's, whatever the request says.
		const origin: TurnOrigin = request.channel === AGENT_CHANNEL ? "agent" : (given ?? "person");
		// Only a person's own words run a skill or turn a draft on (ADR 0059, 0088): never the board's, a stanza's agente's.
		const text = origin === "person" ? await this.withSkills(request, privateThread === true) : request.text;
		return this.admit({ ...said, text: `${text}${skipped}` }, origin, images);
	}

	/**
	 * The skills in a person's message (ADR 0059). «/nome» of one: its steps go with their words.
	 * «/attiva-skill nome»: the draft they had the agente write becomes a skill. Only here, from a
	 * message the person wrote in a chat with them alone; never from a scheduled run, a notice or
	 * another agente, so a page or a mail the agente read cannot turn a draft on.
	 */
	private async withSkills(request: Omit<SubmitRequest, "tenantId" | "instanceId">, alone: boolean): Promise<string> {
		const skills = this.memory.skills;
		// In a stanza the text carries the stanza around the person's words: only theirs can be a command.
		const said = request.command ?? request.text;
		const activating = activateCommand(said);
		if (activating !== undefined) {
			if (!alone || request.channel === AGENT_CHANNEL) return `${request.text}\n\n[Le skill si attivano solo in una conversazione con una persona sola: dillo in una riga.]`;
			const by = subjectOf(request.channel, request.userId);
			const mine = skills.drafts().filter((d) => d.createdBy === by);
			const name = activating === "" && mine.length === 1 ? (mine[0] as { name: string }).name : activating;
			if (name === "") return `${request.text}\n\n[Ha scritto il comando senza il nome. Le sue bozze: ${mine.map((d) => d.name).join(", ") || "nessuna"}. Diglielo in una riga.]`;
			let result: { skill: { name: string }; replaced: boolean } | undefined;
			try {
				result = skills.activate(name, by);
			} catch (error) {
				if (!(error instanceof SkillError)) throw error;
				return `${request.text}\n\n[La skill non si è attivata: ${error.message}. Diglielo in una riga.]`;
			}
			if (result === undefined) {
				const active = skills.get(name);
				return `${request.text}\n\n[${active !== undefined ? `La skill «${active.name}» è già attiva.` : `Non c'è una sua bozza «${name}» da attivare; le sue bozze: ${mine.map((d) => d.name).join(", ") || "nessuna"}.`} Diglielo in una riga.]`;
			}
			await this.audit.append({ type: "skill.activated", instanceId: this.record.id, channel: request.channel, threadId: request.threadId, userId: request.userId, skill: result.skill.name, replaced: result.replaced });
			return `${request.text}\n\n[La persona ha attivato la skill «${result.skill.name}»${result.replaced ? " (nuova versione)" : ""}: da ora la vedi fra le tue skill e si lancia con /${result.skill.name}. Confermalo in una riga.]`;
		}
		const command = skillCommand(said, skills.list());
		if (command === undefined) return request.text;
		await this.audit.append({ type: "skill.used", instanceId: this.record.id, channel: request.channel, threadId: request.threadId, skill: command.skill.name });
		return withSkill(request.text, command.skill, command.rest);
	}

	/**
	 * A task programmato firing: it comes from the instance's own schedule, not from a person,
	 * so the allowlist does not apply (only allowed users can create schedules). The channel
	 * must still be allowed. `messageId` makes a refire after a crash idempotent.
	 */
	async submitScheduled(request: {
		channel: string;
		threadId: string;
		text: string;
		messageId: string;
		scheduleId: string;
		/** The person it acts for: must still be allowed, or the run is refused. */
		onBehalfOf: { channel: string; userId: string } | undefined;
		/** brief: a brief del mattino; watch: a sentinella that saw a change, scheduleId is its ID; automation: an automazione called (ADR 0060), likewise. */
		kind?: "brief" | "watch" | "automation";
	}): Promise<{ submissionId: string; runId: string }> {
		if (!CHANNEL_PATTERN.test(request.channel)) throw new Error(`Invalid channel name "${request.channel}"`);
		const record = await this.fresh();
		const person = request.onBehalfOf;
		const allowed = person !== undefined && (record.allowedUsers[person.channel] ?? []).includes(person.userId);
		if (!allowed) {
			await this.audit.append({ type: "user.denied", instanceId: this.record.id, channel: person?.channel ?? request.channel, userId: person?.userId ?? "(none)", threadId: request.threadId, reason: "schedule_person_not_allowed", scheduleId: request.scheduleId });
			throw new UserNotAllowed(person?.channel ?? request.channel, person?.userId ?? "(none)", request.threadId, "user_not_in_allowlist");
		}
		try {
			assertChannelAllowed(record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		if (request.kind === "watch") await this.audit.append({ type: "watch.fired", instanceId: this.record.id, watchId: request.scheduleId, channel: request.channel, threadId: request.threadId });
		else if (request.kind === "automation") await this.audit.append({ type: "automation.fired", instanceId: this.record.id, automationId: request.scheduleId, channel: request.channel, threadId: request.threadId });
		else await this.audit.append({ type: "schedule.fired", instanceId: this.record.id, scheduleId: request.scheduleId, channel: request.channel, threadId: request.threadId, ...(request.kind === undefined ? {} : { kind: request.kind }) });
		// The person's own memories only in a thread with them alone: a console thread, or a
		// private chat (whose ID is the person's own on Telegram); a group gets the shared ones.
		const alone = person !== undefined && person.channel === request.channel && (request.channel === "web" || request.threadId === person.userId);
		const subject = alone ? subjectOf(person.channel, person.userId) : undefined;
		// So the tools know whom the thread is with even before the person writes in it (a brief's).
		// Not alone: the shared memories, never whom the thread was last with.
		if (subject !== undefined) this.memory.participants.set(threadKey(request.channel, request.threadId), subject);
		else this.memory.participants.clear(threadKey(request.channel, request.threadId));
		return this.admit(request, "scheduled");
	}

	/**
	 * A notice for a conversation from the instance's own work (the outcome of an action a person
	 * approved): not from a person, so no allowlist, but the channel must still be allowed.
	 * `messageId` makes it idempotent.
	 */
	async submitNotice(request: { channel: string; threadId: string; text: string; messageId: string; event: Record<string, string | number | boolean>; origin?: "notice" | "agent" }): Promise<{ submissionId: string; runId: string }> {
		if (!CHANNEL_PATTERN.test(request.channel)) throw new Error(`Invalid channel name "${request.channel}"`);
		const record = await this.fresh();
		try {
			assertChannelAllowed(record.egress, request.channel);
		} catch (error) {
			if (error instanceof EgressDenied) {
				await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: error.kind, target: error.target });
			}
			throw error;
		}
		await this.audit.append({ ...request.event, type: "notice.submitted", instanceId: this.record.id, channel: request.channel, threadId: request.threadId });
		const { origin = "notice", ...notice } = request;
		return this.admit(notice, origin);
	}

	/**
	 * The model a chat answers with instead of the instance's (ADR 0036), when it has one that can
	 * answer now: one whose provider was disallowed or lost its key leaves the instance's answering.
	 */
	async chatModel(channel: string, threadId: string): Promise<ModelSelection | undefined> {
		const own = await this.session.threadModel(threadKey(channel, threadId));
		return own !== undefined && (await this.reachable(own.provider)) ? own : undefined;
	}

	/** Give a chat its own model, from its next message; undefined: the instance's again. */
	async setChatModel(channel: string, threadId: string, model: ModelSelection | undefined, by: string): Promise<void> {
		if (model !== undefined && !(await this.reachable(model.provider))) throw new EgressDenied("model_provider", model.provider);
		await this.session.setThreadModel(threadKey(channel, threadId), model);
		await this.audit.append({ type: "chat.model.updated", instanceId: this.record.id, channel, threadId, by, ...(model === undefined ? {} : { modelProvider: model.provider, modelId: model.modelId }) });
	}

	/** Into the engine, with where the turn comes from (ADR 0088): its tools read it as ctx.origin, also after a restart. */
	private async admit(request: { channel: string; threadId: string; text: string; messageId?: string; userId?: string; onBehalfOf?: { channel: string; userId: string }; scheduleId?: string; kind?: "brief" | "watch" | "automation" }, origin: TurnOrigin, images: readonly EngineImage[] = []): Promise<{ submissionId: string; runId: string }> {
		await this.recoverRuns();
		const thread = threadKey(request.channel, request.threadId);
		return this.submissions.run(thread, async () => {
			if (this.closed) throw new Error("Instance is closed");
			// Retry only this conversation. A different thread can be mid-admission and must
			// not be mistaken for interrupted work by another whole-instance recovery pass.
			if (this.pendingStops.has(thread)) {
				const stopped = (await this.runs.all()).filter((run) => threadKey(run.channel, run.threadId) === thread && isActiveRun(run) && run.cancelRequestedAt !== undefined);
				await this.abortRuns(thread, stopped);
			}
			await this.retryAdmissions(thread);
			const id = runId(request.channel, request.threadId, request.messageId);
			const now = new Date().toISOString();
			const run = (await this.runs.change(id, (existing) => existing ?? {
				id, tenantId: this.record.tenantId, instanceId: this.record.id,
				channel: request.channel, threadId: request.threadId, messageId: request.messageId,
				userId: request.userId, onBehalfOf: request.onBehalfOf, origin,
				source: request.scheduleId !== undefined ? request.kind ?? "schedule" : origin === "scheduled" ? "schedule" : origin === "person" ? "message" : origin,
				sourceId: request.scheduleId, scheduleId: request.scheduleId,
				status: "queued", createdAt: now, updatedAt: now, progress: [], delivery: "pending",
			}))!;
			if (run.submissionId !== undefined) {
				if (run.delivery !== "delivered") {
					await this.rememberAdmission(run, run.submissionId);
					await this.session.reattach(run.submissionId, thread);
				}
				return { submissionId: run.submissionId, runId: id };
			}
			if (run.cancelRequestedAt !== undefined || run.status === "cancelled") throw new Error("Submission was cancelled before admission");
			if (run.status === "failed") await this.runs.change(id, (current) => current === undefined ? undefined : { ...current, status: "queued", error: undefined, finishedAt: undefined, updatedAt: now, delivery: "pending" }, true);
			let submissionId: string;
			try {
				({ submissionId } = await this.session.submit(thread, request.text, runRequestId(run), images, origin));
			} catch (error) {
				// A failed acknowledgement can still have committed. Keep the engine's actual result.
				try {
					const admitted = await this.reconcileRun(run);
					if (admitted !== undefined) await this.session.reattach(admitted.submissionId, thread);
				} catch (lookupError) {
					this.pendingAdmissions.add(id);
					await this.runs.change(id, (current) => current === undefined || !isActiveRun(current) ? current : { ...current, error: "Submission acknowledgement could not be verified; retry safely." });
					console.error(`owni: admission reconciliation failed: ${String(lookupError)}`);
				}
				throw error;
			}
			await this.rememberAdmission(run, submissionId);
			return { submissionId, runId: id };
		});
	}

	/** A retry also repairs an acknowledgement/outbox failure without admitting the input again. */
	private async rememberAdmission(run: RunRecord, submissionId: string): Promise<void> {
		await this.runs.change(run.id, (current) => current === undefined ? undefined : { ...current, submissionId, delivery: current.delivery === "not_applicable" ? "pending" : current.delivery });
		const key = this.replyKey(submissionId);
		await this.serial(key, async () => {
			const entry = await this.outbox.get(key);
			if (entry !== undefined) {
				if (entry.deliveredAt !== undefined) await this.updateDelivery(submissionId, "delivered");
				return;
			}
			await this.outbox.put({ key, submissionId, channel: run.channel, threadId: run.threadId, createdAt: run.createdAt, attempts: 0 });
		});
	}

	private async applyRunEvent(event: EngineRunEvent): Promise<void> {
		await this.runs.changeMatching((run) => threadKey(run.channel, run.threadId) === event.threadKey && (run.submissionId === event.submissionId || (event.requestId !== undefined && runRequestId(run) === event.requestId)), (current) => {
			if (current === undefined || !isActiveRun(current)) return current;
			// Watch snapshots can arrive late; queued never rolls running back.
			const outcome = event.status === "cancelled" || event.status === "failed"
				? current.cancelRequestedAt === undefined ? "failed" : "cancelled"
				: event.status;
			const status = current.status === "running" && outcome === "queued" ? "running" : outcome;
			const at = new Date().toISOString();
			const progress = event.progress;
			const toolName = progress?.toolName !== undefined && /^[a-zA-Z0-9_.-]{1,80}$/.test(progress.toolName) ? progress.toolName : undefined;
			const messages = { model: "Preparing a response", tool_start: "Tool started", tool_progress: "Tool progress updated", tool_end: "Tool finished", retry: "Retrying model request" };
			const last = current.progress.at(-1);
			const append = progress !== undefined && (last?.kind !== progress.kind || last.toolName !== toolName);
			if (status === current.status && current.submissionId === event.submissionId && !append) return current;
			return { ...current, submissionId: event.submissionId, status, updatedAt: at,
				...(status === "running" && current.startedAt === undefined ? { startedAt: at } : {}),
				...(!isActiveRun({ status }) ? { finishedAt: at } : {}),
				error: status === "failed" ? "The agent did not complete this run." : undefined,
				progress: append ? [...current.progress, { at, kind: progress.kind, message: messages[progress.kind], ...(toolName === undefined ? {} : { toolName }) }].slice(-32) : current.progress,
			};
		});
	}

	/** Restore Stop intents before any operation that starts Pi's scheduler. No prompts are journalled. */
	private recoverRuns(): Promise<void> {
		if (this.recovery !== undefined) return this.recovery;
		const recovery = (async () => {
			// A result can be durable before its reply reaches the outbox. Reconcile those
			// terminal rows too; otherwise a crash in that window would lose the delivery.
			const recoverable = (await this.runs.all()).filter((run) => isActiveRun(run) || (run.delivery !== "delivered" && run.delivery !== "not_applicable"));
			const stops = [...new Set(recoverable.filter((run) => isActiveRun(run) && run.cancelRequestedAt !== undefined).map((run) => threadKey(run.channel, run.threadId)))];
			if (stops.length > 0 && this.session.stop === undefined) throw new Error("This engine cannot restore pending Stop requests");
			await Promise.all(stops.map(async (key) => {
				this.pendingStops.add(key);
				try { await this.session.stop!(key); this.pendingStops.delete(key); }
				catch (error) {
					// The adapter retains its restored guard. Healthy conversations may resume;
					// this one retries the abort before accepting any new submission.
					console.error(`owni: restoring Stop failed: ${String(error)}`);
				}
			}));
			for (const run of recoverable) {
				try { await this.reconcileRun(run); }
				catch (error) { console.error(`owni: restoring admission failed: ${String(error)}`); }
			}
		})();
		this.recovery = recovery;
		recovery.catch(() => { if (this.recovery === recovery) this.recovery = undefined; });
		return recovery;
	}

	/** Only a successful lookup can establish that an admission did not commit. */
	private async reconcileRun(run: RunRecord): Promise<EngineRunState | undefined> {
		this.pendingAdmissions.add(run.id);
		const state = await this.session.lookupRun?.(threadKey(run.channel, run.threadId), runRequestId(run));
		if (state !== undefined) {
			await this.applyRunEvent(state);
			await this.rememberAdmission(run, state.submissionId);
		} else if (run.submissionId === undefined) {
			await this.runs.change(run.id, (current) => current === undefined || current.submissionId !== undefined ? current : {
				...current, delivery: "not_applicable",
				...(isActiveRun(current) ? { status: current.cancelRequestedAt === undefined ? "failed" as const : "cancelled" as const, finishedAt: new Date().toISOString(), error: current.cancelRequestedAt === undefined ? "Interrupted before durable admission; retry the submission." : undefined } : {}),
			});
		}
		this.pendingAdmissions.delete(run.id);
		return state;
	}

	/** A supplied thread is already serialized by admit; resume acquires each thread's queue. */
	private async retryAdmissions(thread?: string): Promise<void> {
		if (this.pendingAdmissions.size === 0) return;
		const uncertain = (await this.runs.all()).filter((run) => this.pendingAdmissions.has(run.id) && (thread === undefined || threadKey(run.channel, run.threadId) === thread));
		for (const run of uncertain) {
			if (thread !== undefined) await this.reconcileRun(run);
			else {
				try { await this.submissions.run(threadKey(run.channel, run.threadId), () => this.reconcileRun(run)); }
				catch (error) { console.error(`owni: admission reconciliation retry failed: ${String(error)}`); }
			}
		}
	}

	/** Called under the conversation's submission queue. Clear the retry marker only after reconciliation. */
	private async abortRuns(thread: string, runs: readonly RunRecord[]): Promise<void> {
		this.pendingStops.add(thread);
		await this.session.stop!(thread);
		for (const run of runs) await this.reconcileRun(run);
		await this.events.idle();
		this.pendingStops.delete(thread);
	}

	async stopConversation(thread: { channel: string; threadId: string }): Promise<{ cancelled: number; runs: RunRecord[] }> {
		if (!CHANNEL_PATTERN.test(thread.channel)) throw new Error("Invalid channel name");
		if (this.session.stop === undefined) throw new Error("This engine does not support stopping conversations");
		await this.recoverRuns();
		return this.submissions.run(threadKey(thread.channel, thread.threadId), async () => {
			const active = (await this.runs.all()).filter((run) => run.channel === thread.channel && run.threadId === thread.threadId && isActiveRun(run));
			for (const run of active) await this.runs.change(run.id, (current) => current === undefined || !isActiveRun(current) ? current : { ...current, cancelRequestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
			await this.abortRuns(threadKey(thread.channel, thread.threadId), active);
			const ids = new Set(active.map((run) => run.id));
			const runs = (await this.runs.all()).filter((run) => ids.has(run.id));
			return { cancelled: runs.filter((run) => run.status === "cancelled").length, runs };
		});
	}

	private async updateDelivery(submissionId: string, delivery: RunRecord["delivery"]): Promise<void> {
		await this.runs.changeMatching((run) => run.submissionId === submissionId, (current) => current === undefined || current.delivery === delivery ? current : { ...current, delivery });
	}

	/**
	 * Hand undelivered replies to the channels again, reattach admitted submissions that have
	 * no reply in the outbox yet, then continue unfinished engine work.
	 */
	async resume(): Promise<{ pending: number; undelivered: number; reattached: number }> {
		await this.recoverRuns();
		await this.retryAdmissions();
		// Delivered replies are kept a while (idempotency, audit by key), then dropped: each
		// resume reads the whole outbox.
		// Only replies to people: the keys of the instance's own messages (approval notices)
		// are what stops a notice from going out twice, so they stay.
		const removed = await this.outbox.prune(new Date(Date.now() - OUTBOX_RETENTION_MS), "reply:");
		if (removed > 0) await this.audit.append({ type: "outbox.pruned", instanceId: this.record.id, removed });
		let undelivered = 0;
		let reattached = 0;
		for (const entry of await this.outbox.list()) {
			if (entry.deliveredAt !== undefined) continue;
			if (entry.reply === undefined) {
				if (await this.session.reattach(entry.submissionId, threadKey(entry.channel, entry.threadId))) reattached++;
				continue;
			}
			undelivered++;
			await this.serial(entry.key, async () => {
				// Re-read under the key's chain: the snapshot above may be stale by now.
				const current = await this.outbox.get(entry.key);
				if (current?.reply !== undefined && current.deliveredAt === undefined) await this.handOff(current);
			});
		}
		const { pending } = await this.session.resume();
		await this.audit.append({ type: "instance.resumed", instanceId: this.record.id, pending, undelivered, reattached });
		return { pending, undelivered, reattached };
	}

	async markDelivered(deliveryId: string): Promise<void> {
		if (this.closed) throw new Error(`Instance ${this.record.tenantId}/${this.record.id} is closed; the reply stays in the outbox`);
		await this.serial(deliveryId, async () => {
			const entry = await this.outbox.get(deliveryId);
			if (entry === undefined) throw new NotFound(`No outbox entry "${deliveryId}" in ${this.record.tenantId}/${this.record.id}`);
			if (entry.deliveredAt !== undefined) return;
			// A message with a secret (an automazione's token) keeps its key, not its text, once delivered.
			const scrubbed = entry.key.includes(`/${SECRET_KEY}`) && entry.reply?.status === "answered" ? { reply: { status: "answered" as const, text: "[tolto dopo la consegna: conteneva un segreto]" } } : {};
			await this.outbox.put({ ...entry, ...scrubbed, deliveredAt: new Date().toISOString() });
			await this.updateDelivery(entry.submissionId, "delivered");
			await this.audit.append({
				type: "reply.delivered",
				instanceId: this.record.id,
				channel: entry.channel,
				threadId: entry.threadId,
				deliveryId,
				attempts: entry.attempts,
				possibleDuplicate: entry.attempts > 1,
			});
		});
	}

	/**
	 * The channel did not confirm hand-off number `attempt` of a reply. Ignored when a later
	 * hand-off already exists (a reopen sent it again) or a retry is already pending.
	 */
	async deliveryFailed(deliveryId: string, attempt: number, failure: DeliveryFailure): Promise<void> {
		await this.serial(deliveryId, async () => {
			if (this.closed || this.retries.has(deliveryId)) return;
			const entry = await this.outbox.get(deliveryId);
			if (entry === undefined || entry.deliveredAt !== undefined || entry.attempts !== attempt) return;
			await this.updateDelivery(entry.submissionId, "failed");
			const event = { instanceId: this.record.id, channel: entry.channel, threadId: entry.threadId, deliveryId, attempts: entry.attempts, reason: failure.reason.slice(0, 200) };
			if (failure.refused) return void (await this.audit.append({ type: "reply.refused", ...event }));
			if (entry.attempts - 1 >= this.retry.max) return void (await this.audit.append({ type: "reply.retries_exhausted", ...event }));
			const delays = this.retry.delaysMs;
			const delay = delays[Math.min(entry.attempts, delays.length) - 1] ?? DEFAULT_RETRY_DELAYS_MS[0];
			const timer = setTimeout(() => {
				this.serial(deliveryId, async () => {
					this.retries.delete(deliveryId);
					const current = await this.outbox.get(deliveryId);
					if (this.closed || current?.reply === undefined || current.deliveredAt !== undefined) return;
					this.handedOff.delete(deliveryId);
					await this.handOff(current);
				}).catch((error: unknown) => console.error(`owni: retrying a reply of ${this.record.tenantId}/${this.record.id} failed: ${String(error)}`));
			}, delay);
			timer.unref();
			this.retries.set(deliveryId, timer);
			await this.audit.append({ type: "reply.retry_scheduled", ...event, inMs: delay });
		});
	}

	/** `secret`: the text is dropped from the outbox once the channel has it (ADR 0060). */
	async sendMessage(message: { channel: string; threadId: string; text: string; key: string; secret?: boolean }): Promise<void> {
		assertChannelAllowed(this.record.egress, message.channel);
		const key = `msg:${this.record.tenantId}/${this.record.id}/${message.secret === true ? SECRET_KEY : ""}${message.key}`;
		await this.serial(key, async () => {
			const existing = await this.outbox.get(key);
			if (existing?.deliveredAt !== undefined) return;
			await this.handOff(
				existing ?? { key, submissionId: "message", channel: message.channel, threadId: message.threadId, reply: { status: "answered", text: message.text }, createdAt: new Date().toISOString(), attempts: 0 },
			);
		});
	}

	async sendFile(file: { channel: string; threadId: string; path: string; caption?: string; key: string }): Promise<void> {
		assertChannelAllowed(this.record.egress, file.channel);
		const key = `file:${this.record.tenantId}/${this.record.id}/${file.key}`;
		await this.serial(key, async () => {
			const existing = await this.outbox.get(key);
			if (existing?.deliveredAt !== undefined) return;
			await this.handOff(
				existing ?? {
					key,
					submissionId: "file",
					channel: file.channel,
					threadId: file.threadId,
					reply: { status: "file", path: file.path, ...(file.caption === undefined ? {} : { caption: file.caption }) },
					createdAt: new Date().toISOString(),
					attempts: 0,
				},
			);
		});
	}

	async activity(): Promise<{ working: number; retrying: number }> {
		const waiting = (await this.outbox.list()).filter((entry) => entry.reply === undefined && entry.deliveredAt === undefined);
		return { working: waiting.length, retrying: this.retries.size };
	}

	/** Replies not yet confirmed by their channel, oldest first. */
	async undelivered(): Promise<OutboxEntry[]> {
		return (await this.outbox.list()).filter((entry) => entry.reply !== undefined && entry.deliveredAt === undefined);
	}

	async idle(): Promise<void> {
		await this.recoverRuns();
		await this.session.idle();
		await this.events.idle();
		await this.chains.idle();
		await this.runs.idle();
	}

	async close(): Promise<void> {
		// Replies that settle from now on are left to the next process (resume() reattaches them).
		this.closed = true;
		for (const timer of this.retries.values()) clearTimeout(timer);
		this.retries.clear();
		try {
			await this.session.close();
			await this.events.idle();
			await this.chains.idle();
			await this.runs.idle();
			await this.releaseTools().catch((error: unknown) => console.error(`owni: releasing tools of ${this.record.tenantId}/${this.record.id} failed: ${String(error)}`));
		} finally {
			this.lock.release();
		}
	}

	private async deliver(engineReply: EngineReply): Promise<void> {
		if (this.closed) return;
		await this.applyRunEvent({ threadKey: engineReply.threadKey, submissionId: engineReply.submissionId, status: engineReply.status === "answered" ? "succeeded" : engineReply.cancelled === true ? "cancelled" : "failed" });
		// An engine/provider abort alone is not evidence that the person pressed Stop.
		const requestedStop = engineReply.status === "unanswered" && (await this.runs.all()).some((run) => run.submissionId === engineReply.submissionId && run.status === "cancelled" && run.cancelRequestedAt !== undefined);
		const { channel, threadId } = parseThreadKey(engineReply.threadKey);
		const key = this.replyKey(engineReply.submissionId);
		const reply: OutboxEntry["reply"] =
			engineReply.status === "answered"
				? { status: "answered", text: engineReply.text, ...(engineReply.model === undefined ? {} : { model: engineReply.model }) }
				: { status: "unanswered", reason: engineReply.reason, ...(requestedStop ? { cancelled: true } : {}) };
		await this.serial(key, async () => {
			const existing = await this.outbox.get(key);
			if (existing?.deliveredAt !== undefined) return;
			// Counted once: a reply the outbox already holds was counted when it first came.
			if (existing?.reply === undefined && engineReply.status === "answered" && engineReply.usage !== undefined) await recordTurn(this.usage, this.audit, { instanceId: this.record.id, threadId, submissionId: engineReply.submissionId, model: engineReply.model, usage: engineReply.usage }).catch((error: unknown) => console.error(`owni: usage of ${this.record.tenantId}/${this.record.id} not recorded: ${String(error)}`));
			await this.handOff(
				existing === undefined
					? { key, submissionId: engineReply.submissionId, channel, threadId, reply, createdAt: new Date().toISOString(), attempts: 0 }
					: { ...existing, reply: existing.reply ?? reply },
			);
		});
	}

	/**
	 * Write the entry to the outbox, durably, then give it to the channels. Call only inside
	 * `serial(entry.key)`, with an entry just read or built there.
	 */
	private async handOff(entry: OutboxEntry): Promise<void> {
		const reply = entry.reply;
		if (reply === undefined || this.handedOff.has(entry.key)) return;
		// Replies leave through a channel: check egress again, the policy as stored now is the last word.
		if (!(await this.fresh()).egress.channels.includes(entry.channel)) {
			await this.audit.append({ type: "egress.denied", instanceId: this.record.id, kind: "channel", target: entry.channel });
			return;
		}
		this.handedOff.add(entry.key);
		const attempts = entry.attempts + 1;
		try {
			await this.outbox.put({ ...entry, attempts });
		} catch (error) {
			this.handedOff.delete(entry.key);
			throw error;
		}
		const { channel, threadId } = entry;
		await this.audit.append({
			type: "reply.emitted",
			instanceId: this.record.id,
			channel,
			threadId,
			deliveryId: entry.key,
			attempts,
			status: reply.status,
			...(reply.status === "answered" ? { chars: reply.text.length } : reply.status === "unanswered" ? { reason: reply.reason } : {}),
		});
		const base = { tenantId: this.record.tenantId, instanceId: this.record.id, channel, threadId, deliveryId: entry.key, possibleDuplicate: attempts > 1, attempt: attempts, submissionId: entry.submissionId };
		this.emit({ ...base, ...reply });
	}

	/** Idempotency key of a submission's reply; unique across tenants and instances. */
	private replyKey(submissionId: string): string {
		return `reply:${this.record.tenantId}/${this.record.id}/${submissionId}`;
	}

	private serial(key: string, work: () => Promise<void>): Promise<void> {
		return this.chains.run(key, work);
	}
}

function threadKey(channel: string, threadId: string): string {
	return `${channel}:${threadId}`;
}

function parseThreadKey(key: string): { channel: string; threadId: string } {
	const at = key.indexOf(":");
	return { channel: key.slice(0, at), threadId: key.slice(at + 1) };
}

/**
 * The pictures of a message the model may see: real images within the size limit, at most
 * IMAGE_LIMITS.perMessage. The rest are named in a note, so the model can tell the person.
 */
function checkedImages(given: readonly { readonly path: string; readonly data: Uint8Array }[]): { images: EngineImage[]; skipped: string } {
	const images: EngineImage[] = [];
	const extra: string[] = [];
	const refused: string[] = [];
	for (const image of given) {
		const problem = imageProblem(image.data);
		if (problem !== undefined) refused.push(`${image.path} (${problem})`);
		else if (images.length >= IMAGE_LIMITS.perMessage) extra.push(image.path);
		else images.push({ mimeType: imageType(image.data) as string, data: image.data });
	}
	const parts = [...(extra.length === 0 ? [] : [`${extra.join(", ")} (al massimo ${IMAGE_LIMITS.perMessage} per messaggio)`]), ...refused];
	return { images, skipped: parts.length === 0 ? "" : `\n\n[Immagini non mostrate: ${parts.join("; ")}]` };
}
