/**
 * DurableEngine implemented on @earendil-works/pi-durable 1.3.0 (experimental API).
 * This file and pi-durable-models.ts are the only places that import Pi packages.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Message, retryDelayMs, Type } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	AssistantEntry,
	CompactionEntry,
	CompactionTask,
	UserEntry,
	UsageDoc,
	configure,
	type ConversationId,
	type Cursor,
	type DocumentReader,
	type DocumentState,
	createRegistry,
	type EntryId,
	type EntryRecord,
	type Page,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	defineTool,
	type GenerationCheckpoint,
	GenerationTask,
	Harness,
	hook,
	type RegistryReader,
	type Submission,
	type SubmissionId,
	type SettledSubmissionRecord,
	type ToolRegistration,
	type Tx,
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { OwniTool, DurableEngine, EngineImage, EngineOpenOptions, EngineReply, EngineSession, EngineRunEvent, EngineRunState, JsonValue, TurnUsage } from "../engine.ts";
import type { ModelSelection } from "../registry.ts";
import { isTurnOrigin, type TurnOrigin } from "../turn-origin.ts";
import { createProvider } from "./pi-durable-models.ts";

const context = BACKGROUND_CONTEXT;

/** Thread key (channel:threadId) → Pi conversation ID, stored in the same SQLite file. */
const ThreadsDoc = defineDoc<{ threads: Record<string, number> }>({
	kind: "owni.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: {} }),
});

/**
 * The entry a turn's input is placed as (ADR 0088): the person's words as the model sees them, with
 * where the turn comes from in its data, written in the same commit as the submission.
 */
const INPUT_KIND = "owni.input";

/**
 * How far this conversation is billed (ADR 0098): `answer` is the last answer billed, `spent` how
 * much of Pi's `pi.usage` had been spent at it. No `spent` until billing starts: when the
 * conversation is created, or for one created before, when this version first opens it.
 */
type Spent = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
const BilledDoc = defineDoc<{ answer?: number; spent?: Spent }>({
	kind: "owni.billed-to",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** What one answer was billed (ADR 0098), keyed by its entry: written once, given again whenever it is read again. */
type Bill = { modelCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; tools: string[] };
const BillDoc = defineDocFamily<{ bill?: Bill }, Bill | null>({
	kind: "owni.bill",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (bill) => (bill === null ? {} : { bill }),
});

/** Thread key → the model that conversation answers with instead of the instance's (ADR 0036). */
const ThreadModelsDoc = defineDoc<{ models: Record<string, ModelSelection> }>({
	kind: "owni.thread-models",
	version: 1,
	scope: "session",
	initial: () => ({ models: {} }),
});
type ThreadModelState = DocumentState<{ models: Record<string, ModelSelection> }>;
type OwnModel = (threadKey: string) => ModelSelection | undefined;

export const piDurableEngine: DurableEngine = {
	async open(options: EngineOpenOptions): Promise<EngineSession> {
		const stopped = new Set(options.stoppedThreads);
		const provider = createProvider(options.model.provider, options.localProviders);
		const models = createModels({
			credentials: {
				async read(providerId) {
					const key = await options.apiKey(providerId);
					return key === undefined ? undefined : { type: "api_key", key };
				},
				async list() {
					return [];
				},
				async modify() {
					throw new Error("Owni credentials are read-only; manage them in the tenant secret store");
				},
				async delete() {
					throw new Error("Owni credentials are read-only; manage them in the tenant secret store");
				},
			},
			// No ambient credentials: no env vars, no credential files.
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		// The instance's provider; a chat's own model adds its provider when it is first used.
		// Which of them can actually be reached is apiKey's call (the instance's policy).
		models.setProvider(provider);

		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "owni",
				tools: options.tools.map((tool) => toPiTool(tool, stopped)),
				hooks: [
					hook(GenerationTask, {
						beforeRequest: async ({ messages }, api, hookContext) => {
							// Old pictures leave the request, not the history: a long thread does not resend every photo.
							const recent = withRecentImages(messages, RECENT_IMAGE_MESSAGES);
							const turnContext = options.turnContext;
							if (turnContext === undefined) return { messages: recent };
							const threadKey = await threadKeyOf(api, api.conversationId, hookContext);
							return { messages: threadKey === undefined ? recent : withTurnContext(recent, turnContext(threadKey)) };
						},
					}),
				],
			}),
		);
		const storage = await openNodeSqliteStorage(join(options.storageDir, "pi-durable.sqlite"));
		let threadModels: ThreadModelState | undefined;
		const ownModel: OwnModel = (key) => threadModels?.value?.models[key];
		const harness = await Harness.open(storage, { models, registry: currentRequestRegistry(registry, models, options, ownModel, stopped) }, context);
		// The scheduler is still paused and nothing can start it yet (a reattachment's wait would):
		// a conversation created before billing existed starts it here, before any of its work moves.
		const threads = (await harness.snapshot(ThreadsDoc, context))?.threads ?? {};
		await harness.commit(async (tx) => {
			await tx.doc(ThreadModelsDoc);
			for (const id of Object.values(threads)) await startBilling(tx, id as ConversationId);
		}, context);
		threadModels = await harness.documentState(ThreadModelsDoc, context);
		return new PiDurableSession(harness, models, options, threadModels!, stopped);
	},
};

class PiDurableSession implements EngineSession {
	private readonly listeners = new Set<(reply: EngineReply) => void>();
	private readonly runListeners = new Set<(event: EngineRunEvent) => void>();
	private readonly watches = new Map<string, Promise<AgentEventStream>>();
	private readonly tracked = new Set<SubmissionId>();
	private readonly creating = new Map<string, Promise<ConversationId>>();
	private closing = false;
	private recovery: Promise<number> | undefined;
	/** What each pending conversation was last aligned to, before the first start: its model and instructions. */
	private readonly aligned = new Map<number, string>();
	private aligning: Promise<boolean> | undefined;
	private started = false;

	constructor(
		private readonly harness: Harness,
		private readonly models: MutableModels,
		private readonly options: EngineOpenOptions,
		private readonly threadModels: ThreadModelState,
		private readonly stopped: Set<string>,
	) {}

	async submit(threadKey: string, text: string, requestId?: string, images: readonly EngineImage[] = [], origin: TurnOrigin = "scheduled"): Promise<{ submissionId: string }> {
		// An earlier failed abort may already have started the scheduler. Clear its guard
		// only by successfully retrying Stop, before this conversation accepts new work.
		if (this.stopped.has(threadKey)) await this.stop(threadKey);
		// Submitting starts Pi's scheduler: reattach the previous process's open work first.
		await this.recover();
		const conversationId = await this.conversationFor(threadKey);
		await this.watch(threadKey, conversationId);
		// Each message: the owner may have changed the instance's model, or the person the chat's.
		await this.alignAgent(conversationId, threadKey);
		const conversation = await this.harness.conversation(conversationId, context);
		if (conversation === undefined) throw new Error(`Conversation ${conversationId} of ${threadKey} is missing`);
		if (requestId !== undefined) {
			// A redelivered message: already admitted, so it is answered (or being answered) once.
			const existing = await conversation.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
			if (existing !== undefined) {
				this.emitRun(runState(existing, threadKey));
				return { submissionId: String(existing.id) };
			}
		}
		const submission = await conversation.submit(
			{
				type: "input",
				content: images.length === 0 ? text : [{ type: "text", text }, ...(await Promise.all(images.map(toPiImage)))],
				entry: { kind: INPUT_KIND, data: { origin, ...(requestId === undefined ? {} : { requestId }) } },
				...(requestId === undefined ? {} : { requestId }),
			},
			context,
		);
		this.track(submission, threadKey);
		return { submissionId: String(submission.id) };
	}

	async resume(): Promise<{ pending: number }> {
		return { pending: await this.recover() };
	}

	async reattach(submissionId: string, threadKey: string): Promise<boolean> {
		const submission = await this.harness.submission(Number(submissionId) as SubmissionId, context);
		if (submission === undefined) return false;
		const id = (await this.threads())[threadKey];
		if (id === undefined || (await submission.status(context)).conversationId !== id) return false;
		await this.watch(threadKey, id as ConversationId);
		await this.activate(() => this.track(submission, threadKey));
		return true;
	}

	/**
	 * Once per session: attach a waiter to every unsettled submission, then start the
	 * scheduler. Starting first would let a fast run settle before it is tracked, and its
	 * reply would be lost. A failed attempt is forgotten, so the next call tries again.
	 */
	private recover(): Promise<number> {
		if (this.recovery === undefined) {
			const recovery = this.pendingSubmissions().then((pending) =>
				this.activate(() => {
					for (const { submission, threadKey } of pending) this.track(submission, threadKey);
					this.harness.resume();
					return pending.length;
				}),
			);
			this.recovery = recovery;
			recovery.catch(() => {
				if (this.recovery === recovery) this.recovery = undefined;
			});
		}
		return this.recovery;
	}

	private async pendingSubmissions(): Promise<{ submission: Submission; threadKey: string }[]> {
		const found: { submission: Submission; threadKey: string }[] = [];
		for (const { id, threadKey, conversationId } of await this.pendingInputs()) {
			await this.watch(threadKey, conversationId);
			const submission = await this.harness.submission(id, context);
			if (submission !== undefined) found.push({ submission, threadKey });
		}
		return found;
	}

	/**
	 * Every call that starts Pi's scheduler (reattach, resume, submit, idle) does it through
	 * here. Until the first start (Harness.open leaves it paused), work left half done is first
	 * aligned with the model and instructions of that moment. These reads are preparation,
	 * not an atomic snapshot: the generation adapter checks each actual request again. A failed
	 * preparation is not kept, so the next call tries again without starting pending work.
	 */
	private async activate<T>(start: () => T): Promise<T> {
		while (!this.started) {
			this.aligning ??= this.alignPending().finally(() => {
				this.aligning = undefined;
			});
			if (await this.aligning) break;
		}
		this.started = true;
		return start();
	}

	/** One pass over the pending conversations: true when every one already had what it should. */
	private async alignPending(): Promise<boolean> {
		const threadKeys = new Map<ConversationId, string>();
		for (const { conversationId, threadKey } of await this.pendingInputs()) threadKeys.set(conversationId, threadKey);
		// This batch cannot authorize requests: an earlier result may age while another awaits I/O.
		const targets = await Promise.all([...threadKeys].map(async ([id, threadKey]) => ({ id, model: await this.modelOf(threadKey) })));
		const instructions = this.instructionsNow();
		let unchanged = true;
		for (const { id, model } of targets) {
			const target = JSON.stringify([model.provider, model.modelId, instructions ?? null]);
			if (this.aligned.get(id) === target) continue;
			unchanged = false;
			await this.configureAgent(id, model, instructions);
			this.aligned.set(id, target);
		}
		return unchanged;
	}

	/** The unsettled inputs of the conversations Owni knows, with their thread key. */
	private async pendingInputs(): Promise<{ id: SubmissionId; conversationId: ConversationId; threadKey: string }[]> {
		const inspection = await this.harness.inspect(context);
		const byConversation = new Map<number, string>(Object.entries(await this.threads()).map(([key, id]) => [id, key]));
		const found: { id: SubmissionId; conversationId: ConversationId; threadKey: string }[] = [];
		for (const record of inspection.submissions) {
			if (record.type !== "input") continue;
			const threadKey = byConversation.get(record.conversationId);
			if (threadKey !== undefined) found.push({ id: record.id, conversationId: record.conversationId, threadKey });
		}
		return found;
	}

	async setThreadModel(threadKey: string, model: ModelSelection | undefined): Promise<void> {
		await this.harness.commit(async (tx) => {
			const { models } = await tx.doc(ThreadModelsDoc);
			if (model === undefined) delete models[threadKey];
			else models[threadKey] = { provider: model.provider, modelId: model.modelId };
		}, context);
	}

	async threadModel(threadKey: string): Promise<ModelSelection | undefined> {
		return (await this.harness.snapshot(ThreadModelsDoc, context))?.models[threadKey];
	}

	onReply(listener: (reply: EngineReply) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onRunEvent(listener: (event: EngineRunEvent) => void): () => void {
		this.runListeners.add(listener);
		return () => this.runListeners.delete(listener);
	}

	async lookupRun(threadKey: string, requestId: string): Promise<EngineRunState | undefined> {
		const id = (await this.threads())[threadKey];
		if (id === undefined) return undefined;
		const record = await this.harness.commit((tx) => tx.submissionByRequest(id as ConversationId, requestId), context);
		return record === undefined ? undefined : runState(record, threadKey);
	}

	async stop(threadKey: string): Promise<void> {
		this.stopped.add(threadKey);
		const id = (await this.threads())[threadKey];
		if (id !== undefined) {
			const conversation = await this.harness.conversation(id as ConversationId, context);
			// Pi starts its scheduler before the abort commit. A rejected abort must leave
			// this guard in place, including guards restored from persisted Stop intents.
			await conversation?.abort(context);
		}
		this.stopped.delete(threadKey);
		if (id !== undefined) {
			// Observation must never prevent the actual abort or report a successful abort as failed.
			try { await this.watch(threadKey, id as ConversationId); }
			catch (error) { console.error(`owni: Stop progress watch failed: ${String(error)}`); }
		}
	}

	private emitRun(event: EngineRunEvent): void {
		if (this.closing) return;
		for (const listener of this.runListeners) {
			try { listener(event); }
			catch (error) { console.error(`owni: engine run listener failed: ${String(error)}`); }
		}
	}

	private watch(threadKey: string, id: ConversationId): Promise<AgentEventStream> {
		let pending = this.watches.get(threadKey);
		if (pending !== undefined) return pending;
		pending = watchEvents(this.harness, id, context).then(async (stream) => {
			// A closed stream cannot observe future runs. The next access will attach a fresh watch.
			void stream.closed.then(() => { if (this.watches.get(threadKey) === pending) this.watches.delete(threadKey); });
			let inputs: readonly SubmissionId[] = [];
			const states = new Map<SubmissionId, EngineRunState>();
			const lastProgress = new Map<SubmissionId, string>();
			const process = async (events: readonly AgentEvent[]) => {
				for (const event of events) {
					try {
						if (event.type === "snapshot" || event.type === "run_start") {
							inputs = event.type === "snapshot" ? event.run?.inputs ?? [] : event.inputs;
							const ids = event.type === "snapshot" ? [...inputs, ...event.inbox.map((item) => item.id)] : inputs;
							for (const submissionId of ids) {
								const submission = await this.harness.submission(submissionId, context);
								if (submission === undefined) continue;
								const state = runState(await submission.status(context), threadKey);
								states.set(submissionId, state);
								this.emitRun(state);
							}
						} else if (event.type === "submission") {
							const state = runState(event.record, threadKey);
							if (state.status === "queued" || state.status === "running") states.set(event.record.id, state);
							else { states.delete(event.record.id); lastProgress.delete(event.record.id); }
							this.emitRun(state);
						} else if (event.type === "run_end") inputs = [];
						const kind = event.type === "tool_execution_start" ? "tool_start" : event.type === "tool_execution_update" ? "tool_progress" : event.type === "tool_execution_end" ? "tool_end" : event.type === "turn_start" ? "model" : event.type === "auto_retry_start" ? "retry" : undefined;
						if (kind !== undefined) {
							for (const submissionId of inputs) {
								const state = states.get(submissionId);
								if (state === undefined || (state.status !== "queued" && state.status !== "running")) continue;
								// Output chunks often repeat the same public metadata. Drop them before
								// the runtime reads its history; no arbitrary output is exposed anyway.
								const signature = JSON.stringify([kind, "toolName" in event ? event.toolName : null]);
								if (lastProgress.get(submissionId) === signature) continue;
								lastProgress.set(submissionId, signature);
								this.emitRun({ ...state, status: "running", progress: { kind, ...("toolName" in event ? { toolName: event.toolName } : {}) } });
							}
						}
					} catch (error) {
						// Pi closes watchers whose listener rejects. Keep later events observable after
						// a transient read error, including the remaining events in this batch.
						if (!this.closing) console.error(`owni: engine progress read failed: ${String(error)}`);
					}
				}
			};
			await process([stream.snapshot]);
			stream.start(process);
			return stream;
		});
		this.watches.set(threadKey, pending);
		pending.catch(() => { if (this.watches.get(threadKey) === pending) this.watches.delete(threadKey); });
		return pending;
	}

	async idle(): Promise<void> {
		return this.activate(() => this.harness.waitForIdle(context));
	}

	async close(): Promise<void> {
		this.closing = true;
		try {
			await Promise.allSettled([...this.watches.values()].map(async (watch) => (await watch).stop()));
			await this.harness.close(context);
		}
		finally { this.threadModels.dispose(); }
	}

	private async threads(): Promise<Readonly<Record<string, number>>> {
		return (await this.harness.snapshot(ThreadsDoc, context))?.threads ?? {};
	}

	private conversationFor(threadKey: string): Promise<ConversationId> {
		let pending = this.creating.get(threadKey);
		if (pending === undefined) {
			pending = this.findOrCreate(threadKey);
			this.creating.set(threadKey, pending);
			pending.catch(() => this.creating.delete(threadKey));
		}
		return pending;
	}

	private async findOrCreate(threadKey: string): Promise<ConversationId> {
		const existing = (await this.threads())[threadKey];
		if (existing !== undefined) return existing as ConversationId;
		const instructions = this.instructionsNow();
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: await this.modelOf(threadKey),
					...(instructions === undefined ? {} : { instructions }),
				},
				// Same commit as the conversation: the mapping can never point to nothing.
				init: async (tx, id) => {
					(await tx.doc(ThreadsDoc)).threads[threadKey] = id;
					(await tx.doc(BilledDoc, id)).spent = noSpend();
				},
			},
			context,
		);
		return conversation.id;
	}

	/**
	 * A conversation keeps the model and instructions it was created with. The ones that count
	 * are the instance's, or the chat's own model: after either changes, an old thread answers
	 * with the new ones (its history stays). Written only when they differ.
	 */
	private async alignAgent(id: ConversationId, threadKey: string): Promise<void> {
		await this.configureAgent(id, await this.modelOf(threadKey), this.instructionsNow());
	}

	private async configureAgent(id: ConversationId, model: ModelSelection, instructions: string | undefined): Promise<void> {
		const conversation = await this.harness.conversation(id, context);
		if (conversation === undefined) return;
		await conversation.commit(async (tx) => {
			const agent = await tx.doc(AgentDoc, id);
			const sameModel = agent.model?.provider === model.provider && agent.model?.modelId === model.modelId;
			const sameInstructions = agent.instructions === instructions;
			if (sameModel && sameInstructions) return;
			await configure(tx, id, { ...(sameModel ? {} : { model }), ...(sameInstructions ? {} : { instructions: instructions ?? null }) });
		}, context);
	}

	private instructionsNow(): string | undefined {
		const { instructions } = this.options;
		return typeof instructions === "function" ? instructions() : instructions;
	}

	/**
	 * The chat's own model while it can answer, otherwise the instance's; its provider registered.
	 * A provider this version no longer offers counts as one that cannot answer.
	 */
	private async modelOf(threadKey: string): Promise<ModelSelection> {
		try { return await modelFor(this.models, this.options, (key) => this.threadModels.value?.models[key], threadKey, (model) => model); }
		catch (error) { throw error instanceof AlignmentFailed ? error.cause : error; }
	}

	/** Each submission is tracked, and so replied to, at most once per session. */
	private track(submission: Submission, threadKey: string): void {
		if (this.tracked.has(submission.id)) return;
		this.tracked.add(submission.id);
		this.settle(submission, threadKey).catch((error: unknown) => {
			console.error(`owni: reply for submission ${submission.id} failed: ${String(error)}`);
		});
	}

	private async settle(submission: Submission, threadKey: string): Promise<void> {
		const submissionId = String(submission.id);
		let reply: EngineReply;
		try {
			const settled = await submission.wait(context);
			this.emitRun(runState(settled, threadKey));
			if (settled.status === "done" && settled.type === "input") {
				reply = { status: "answered", threadKey, submissionId, ...(await this.answer(settled)) };
			} else {
				reply = { status: "unanswered", threadKey, submissionId, reason: settled.reason ?? settled.status, cancelled: settled.reason === "aborted" };
			}
		} catch (error) {
			if (this.closing) return; // the next process resumes it
			reply = { status: "unanswered", threadKey, submissionId, reason: String(error) };
		}
		for (const listener of this.listeners) {
			try {
				listener(reply);
			} catch (error) {
				console.error(`owni: reply listener failed: ${String(error)}`);
			}
		}
	}

	private async answer(settled: SettledSubmissionRecord & { status: "done"; type: "input" }): Promise<{ text: string; model?: ModelSelection; usage?: TurnUsage }> {
		const conversation = await this.harness.conversation(settled.conversationId, context);
		// Writes only the bills of the answers read (BillDoc, BilledDoc), in the commit that reads them.
		const read = await conversation?.commit(async (tx) => ({ entry: await tx.entry(AssistantEntry, settled.answer), usage: await turnUsage(tx, settled.conversationId, settled.answer) }), context);
		const message = read?.entry?.model?.[0] as Message | undefined;
		if (message?.role !== "assistant") return { text: "" };
		return { text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""), model: { provider: message.provider, modelId: message.model }, ...(read?.usage === undefined ? {} : { usage: read.usage }) };
	}
}

function runState(record: SubmissionRecord, threadKey: string): EngineRunState {
	return { threadKey, submissionId: String(record.id), ...(record.requestId === undefined ? {} : { requestId: record.requestId }), status: record.status === "placed" ? "running" : record.status === "done" ? "succeeded" : record.status === "unanswered" ? record.reason === "aborted" ? "cancelled" : "failed" : "queued" };
}

type RequestTarget = { model: ModelSelection; instructions: string | undefined };
type GenerationRuntime = Parameters<typeof GenerationTask.definition.phases.request>[1];
type RequestCheckpoint = Extract<GenerationCheckpoint, { phase: "request" | "poll" }>;

/** A request that has not reached a provider yet must go back through Pi's prompt preparation. */
class PrepareRequest extends Error {
	constructor(readonly target: RequestTarget) { super("The request configuration changed"); }
}

class AlignmentFailed extends Error {
	constructor(cause: unknown) { super("Request alignment failed", { cause }); }
}

/** Unlike pi-ai's lazyStream, a failed gate must escape to the task, not become a model response. */
class GatedRequest extends AssistantMessageEventStream {
	private ready: Promise<AssistantMessageEventStream> | undefined;
	constructor(private readonly start: () => Promise<AssistantMessageEventStream>) { super(); }
	private open(): Promise<AssistantMessageEventStream> { return this.ready ??= this.start(); }
	override async *[Symbol.asyncIterator]() { yield* await this.open(); }
	override async result() { return (await this.open()).result(); }
}

/**
 * Pi 1.3's message hook cannot select a model (and its errors are skipped). Its request checkpoint
 * pins the model AND transcript cutoff. Decorate the exported task through the public registry
 * reader, without mutating Pi's singleton or replacing tool/retry/classification behavior.
 *
 * Check at streamSimple, after Pi's asynchronous transcript/hooks/session preparation, separately
 * for each outgoing request. A mismatch resets only this generation to prepare: completed tools,
 * their memos and billing stay intact. Polls check after their sleep; a
 * stale remote response is never applied to the conversation.
 */
function currentRequestRegistry(registry: RegistryReader, models: MutableModels, options: EngineOpenOptions, ownModel: OwnModel, stopped: ReadonlySet<string>): RegistryReader {
	const phases = GenerationTask.definition.phases;
	const useTarget = async <T>(runtime: DocumentReader & { conversationId: ConversationId }, ctx: OriginContext, use: (target: RequestTarget | undefined) => T): Promise<Awaited<T>> => {
		let key: string | undefined;
		try { key = await threadKeyOf(runtime, runtime.conversationId, ctx); }
		catch (error) { throw new AlignmentFailed(error); }
		if (key === undefined) return await use(undefined);
		if (stopped.has(key)) throw new Error("Conversation stopped");
		return modelFor(models, options, ownModel, key, (model) => {
			if (stopped.has(key)) throw new Error("Conversation stopped");
			let instructions: string | undefined;
			try { instructions = typeof options.instructions === "function" ? options.instructions() : options.instructions; }
			catch (error) { throw new AlignmentFailed(error); }
			return use({ model, instructions });
		});
	};
	const targetFor = (runtime: DocumentReader & { conversationId: ConversationId }, ctx: OriginContext) => useTarget(runtime, ctx, (target) => target);
	const check = <T>(runtime: GenerationRuntime, checkpoint: RequestCheckpoint, messages: readonly Message[], ctx: OriginContext, send: () => T): Promise<Awaited<T>> => useTarget(runtime, ctx, (target) => {
		if (target !== undefined) {
			let shown: string | null | undefined;
			for (const message of messages) if (message.role === "system" && message.sections?.instructions !== undefined) shown = message.sections.instructions;
			const desired = target.instructions === undefined ? undefined : `<instructions>\n${target.instructions}\n</instructions>`;
			if (!sameModel(checkpoint.model, target.model) || (shown ?? undefined) !== desired) throw new PrepareRequest(target);
		}
		runtime.signal.throwIfAborted();
		return send();
	});
	const recover = async (error: unknown, runtime: GenerationRuntime, checkpoint: Exclude<GenerationCheckpoint, { phase: "tools" }>, ctx: OriginContext) => {
		runtime.signal.throwIfAborted();
		if (error instanceof PrepareRequest) {
			await runtime.commit(async (tx) => {
				await configure(tx, runtime.conversationId, { model: error.target.model, instructions: error.target.instructions ?? null });
				return { status: "running", checkpoint: { phase: "prepare", attempt: checkpoint.attempt, ...(checkpoint.compacted === undefined ? {} : { compacted: checkpoint.compacted }) } };
			}, ctx);
		} else if (error instanceof AlignmentFailed) {
			const retry = runtime.settings.retry;
			if (!retry.enabled || checkpoint.attempt > retry.maxRetries) throw error.cause;
			runtime.report(error);
			// A lookup failure did not send a request. Retry this exact phase: in particular keep
			// deferred handles and prepare's compaction guards, which Pi's model retry discards.
			await runtime.sleep(runtime.now() + retryDelayMs(retry, checkpoint.attempt), ctx);
			await runtime.commit(() => ({ status: "running", checkpoint: { ...checkpoint, attempt: checkpoint.attempt + 1 } }), ctx);
		} else throw error;
	};
	const generation: typeof GenerationTask = defineTask({
		...GenerationTask.definition,
		phases: {
			...phases,
			prepare: async (task, runtime, ctx) => {
				try {
					const target = await targetFor(runtime, ctx);
					if (target !== undefined) await runtime.commit(async (tx) => { await configure(tx, runtime.conversationId, { model: target.model, instructions: target.instructions ?? null }); }, ctx);
					await phases.prepare(task, runtime, ctx);
				} catch (error) { await recover(error, runtime, task.state.checkpoint, ctx); }
			},
			request: async (task, runtime, ctx) => {
				const checkpoint = task.state.checkpoint;
				try {
					// A checkpoint can refer to a provider absent from this process's catalog. Registration
					// grants no credentials; the gate still chooses the currently usable model before sending.
					registerModelProvider(models, options, checkpoint.model.provider);
					if (models.getModel(checkpoint.model.provider, checkpoint.model.modelId) === undefined) {
						const target = await targetFor(runtime, ctx);
						if (target !== undefined && !sameModel(target.model, checkpoint.model)) throw new PrepareRequest(target);
					}
					const requestModels = Object.create(models) as MutableModels;
					requestModels.streamSimple = (model, transcript, streamOptions) => new GatedRequest(() => check(runtime, checkpoint, transcript.messages, ctx, () => models.streamSimple(model, transcript, streamOptions)));
					// Keep live getters (settings/registry), rather than freezing them with an object spread.
					await phases.request(task, Object.assign(Object.create(runtime), { models: requestModels }), ctx);
				} catch (error) { await recover(error, runtime, checkpoint, ctx); }
			},
			poll: async (task, runtime, ctx) => {
				const checkpoint = task.state.checkpoint;
				try {
					const view = await runtime.context(runtime.conversationId, ctx, { at: checkpoint.cutoff });
					registerModelProvider(models, options, checkpoint.model.provider);
					if (models.getModel(checkpoint.model.provider, checkpoint.model.modelId) === undefined) {
						const target = await targetFor(runtime, ctx);
						if (target !== undefined && !sameModel(target.model, checkpoint.model)) throw new PrepareRequest(target);
					}
					const requestModels = Object.create(models) as MutableModels;
					requestModels.fetchDeferred = (model, handle, fetchOptions) => check(runtime, checkpoint, view.messages, ctx, () => models.fetchDeferred(model, handle, fetchOptions));
					await phases.poll(task, Object.assign(Object.create(runtime), { models: requestModels }), ctx);
				} catch (error) {
					if (error instanceof PrepareRequest) {
						runtime.signal.throwIfAborted();
						try {
							// Revocation forbids even cancellation. The old provider may finish the remote job,
							// but its result cannot enter this conversation or start any of its tools.
							if (((await options.modelUsable?.(checkpoint.model.provider)) ?? true) && registerModelProvider(models, options, checkpoint.model.provider)) {
								const model = models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
								if (model !== undefined) await models.cancelDeferred(model, checkpoint.handle, { signal: runtime.signal });
							}
						} catch (cancelError) { runtime.report(cancelError); }
					}
					await recover(error, runtime, checkpoint, ctx);
				}
			},
		},
	});
	// Summaries have their own pinned model and dedicated prompt. Keep their range, prompt and
	// placement protocol; choose the current usable model at completeSimple just like generation.
	const compaction: typeof CompactionTask = defineTask({
		...CompactionTask.definition,
		phases: {
			...CompactionTask.definition.phases,
			summarize: async (task, runtime, ctx) => {
				const checkpoint = task.state.checkpoint;
				try {
					registerModelProvider(models, options, checkpoint.model.provider);
					if (models.getModel(checkpoint.model.provider, checkpoint.model.modelId) === undefined) {
						const target = await targetFor(runtime, ctx);
						if (target !== undefined && !sameModel(target.model, checkpoint.model)) {
							await runtime.commit(() => ({ status: "running", checkpoint: { ...checkpoint, model: target.model } }), ctx);
							return;
						}
					}
					const requestModels = Object.create(models) as MutableModels;
					requestModels.completeSimple = (model, transcript, streamOptions) => useTarget(runtime, ctx, (target) => {
						const selected = target === undefined ? model : models.getModel(target.model.provider, target.model.modelId);
						if (selected === undefined) throw new Error(`Model ${target!.model.provider}/${target!.model.modelId} is not available`);
						runtime.signal.throwIfAborted();
						return models.completeSimple(selected, transcript, { ...streamOptions, maxTokens: Math.min(streamOptions?.maxTokens ?? Infinity, selected.maxTokens > 0 ? selected.maxTokens : Infinity) });
					});
					await CompactionTask.definition.phases.summarize(task, Object.assign(Object.create(runtime), { models: requestModels }), ctx);
				} catch (error) {
					runtime.signal.throwIfAborted();
					const retry = runtime.settings.retry;
					if (!(error instanceof AlignmentFailed)) throw error;
					if (!retry.enabled || checkpoint.attempt > retry.maxRetries) throw error.cause;
					runtime.report(error);
					await runtime.sleep(runtime.now() + retryDelayMs(retry, checkpoint.attempt), ctx);
					await runtime.commit(() => ({ status: "running", checkpoint: { ...checkpoint, attempt: checkpoint.attempt + 1 } }), ctx);
				}
			},
		},
	});
	const tasks = new Map([generation, compaction].map((task) => [task.definition.name, task]));
	return {
		subscribe: (listener) => registry.subscribe(listener),
		snapshot: () => {
			const snapshot = registry.snapshot();
			return {
				installed: () => snapshot.installed(), extension: (name) => snapshot.extension(name),
				tools: () => snapshot.tools(), sections: () => snapshot.sections(),
				tasks: () => snapshot.tasks().map((task) => tasks.get(task.definition.name) ?? task),
				task: (name) => tasks.get(name) ?? snapshot.task(name),
			};
		},
	};
}

function sameModel(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
	return a?.provider === b?.provider && a?.modelId === b?.modelId;
}

function registerModelProvider(models: MutableModels, options: EngineOpenOptions, provider: string): boolean {
	if (models.getProvider(provider) !== undefined) return true;
	try { models.setProvider(createProvider(provider, options.localProviders)); return true; }
	catch { return false; }
}

async function modelFor<T>(models: MutableModels, options: EngineOpenOptions, ownModel: OwnModel, threadKey: string, use: (model: ModelSelection) => T): Promise<Awaited<T>> {
	for (;;) {
		const own = ownModel(threadKey);
		if (own !== undefined && registerModelProvider(models, options, own.provider)) {
			let usable: boolean;
			try { usable = (await options.modelUsable?.(own.provider)) ?? true; }
			catch (error) { throw new AlignmentFailed(error); }
			// Pi publishes this observed document synchronously with each committed choice. No queued
			// document read after the live provider check: consume it and dispatch in this continuation.
			if (!sameModel(own, ownModel(threadKey))) continue;
			if (usable) return await use(own);
		}
		registerModelProvider(models, options, options.model.provider);
		return await use(options.model);
	}
}

function toPiTool(tool: OwniTool, stopped: ReadonlySet<string>): ToolRegistration {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters as never),
		replay: tool.replaySafe ? "safe" : "unsafe",
		execute: async (args, api, callContext) => {
			const threadKey = await threadKeyOf(api, api.conversationId, callContext);
			const at = threadKey?.indexOf(":") ?? -1;
			const origin = await turnOrigin(api, callContext);
			const signal = callContext.abortSignal ?? new AbortController().signal;
			const check = () => { signal.throwIfAborted(); if (threadKey !== undefined && stopped.has(threadKey)) throw new Error("Conversation stopped"); };
			check();
			const result = await tool.execute(args, {
				callId: `${api.conversationId}/${api.callId}`,
				origin,
				inputs: () => turnInputs(api, callContext),
				...(threadKey === undefined || at < 0 ? {} : { thread: { channel: threadKey.slice(0, at), threadId: threadKey.slice(at + 1) } }),
				signal,
				progress: (chunk) => api.output(chunk),
				step: async <T extends JsonValue>(key: string, work: () => Promise<T>): Promise<T> => {
					check();
					const name = `step:${key}`;
					const stored = await api.memo<{ value: T }>(name, callContext);
					if (stored !== undefined) return stored.value;
					check();
					const value = await work();
					check();
					return (await api.memo<{ value: T }>(name, { value } as never, callContext)).value;
				},
			});
			if (typeof result === "string") return { output: [{ type: "text", text: result }] };
			return { output: [{ type: "text", text: result.text }, ...(await Promise.all(result.images.map(toPiImage)))] };
		},
	});
}

/** The thread a conversation belongs to, as the threads document maps it. */
async function threadKeyOf(reader: DocumentReader, conversationId: ConversationId, readContext: OriginContext): Promise<string | undefined> {
	const threads = (await reader.snapshot(ThreadsDoc, readContext))?.threads ?? {};
	return Object.entries(threads).find(([, id]) => id === Number(conversationId))?.[0];
}

type OriginApi = Pick<Parameters<ToolRegistration["execute"]>[1], "memo" | "commit" | "conversationId">;
type OriginContext = Parameters<ToolRegistration["execute"]>[2];

/**
 * Where the turn of a tool call comes from: kept in the call's memo the first time, so a rerun
 * after a crash gets the same one even if more messages arrived meanwhile.
 */
async function turnOrigin(api: OriginApi, callContext: OriginContext): Promise<TurnOrigin> {
	const stored = await api.memo<{ origin: string }>("owni:origin", callContext);
	if (stored !== undefined && isTurnOrigin(stored.origin)) return stored.origin;
	const found = await api.commit((tx) => inputsOrigin(tx, api.conversationId), callContext);
	const kept = await api.memo<{ origin: string }>("owni:origin", { origin: found }, callContext);
	return isTurnOrigin(kept.origin) ? kept.origin : "scheduled";
}

/** The request ids of the messages the turn of a tool call answers, kept in the call's memo like its origin. */
async function turnInputs(api: OriginApi, callContext: OriginContext): Promise<readonly string[]> {
	const stored = await api.memo<{ ids: string[] }>("owni:inputs", callContext);
	if (stored !== undefined) return stored.ids;
	const found = await api.commit((tx) => inputsRequests(tx, api.conversationId), callContext);
	return (await api.memo<{ ids: string[] }>("owni:inputs", { ids: found }, callContext)).ids;
}

/** The request ids of the run's inputs, oldest first ("channel:messageId", ADR 0108). */
export async function inputsRequests(tx: Pick<Tx, "scanEntries">, conversationId: ConversationId): Promise<string[]> {
	const { entries } = await runEntries(tx, conversationId);
	return entries
		.filter((entry) => entry.kind === INPUT_KIND)
		.map((entry) => (entry.data as { requestId?: unknown } | undefined)?.requestId)
		.filter((id): id is string => typeof id === "string")
		.reverse();
}

export async function inputsOrigin(tx: Pick<Tx, "scanEntries">, conversationId: ConversationId, warn: (message: string) => void = warnBoundOnce): Promise<TurnOrigin> {
	const { entries, bounded } = await runEntries(tx, conversationId);
	const found = entries
		.filter((entry) => entry.kind === INPUT_KIND || entry.kind === UserEntry.kind)
		.map((entry) => {
			const origin = (entry.data as { origin?: unknown } | undefined)?.origin;
			return entry.kind === INPUT_KIND && isTurnOrigin(origin) ? origin : undefined;
		});
	if (bounded) {
		warn(SCAN_BOUND);
		return worst([...found, undefined]);
	}
	return found.length === 0 ? "scheduled" : worst(found);
}

const SCAN_BOUND = "owni: the scan for a turn's run reached its bound before the start of the run; the turn is not taken for a person's";
let boundWarned = false;

/** Said once per process, with no value of the conversation: a run that long is rare, and the line is enough to look into it. */
function warnBoundOnce(message: string): void {
	if (boundWarned) return;
	boundWarned = true;
	console.error(message);
}

/**
 * The entries of the run that ends at the latest entry, newest first: back to, and not including,
 * the previous answer. A request that failed and was retried, overflowed
 * into a compaction, or was cut short is no answer: Pi writes it down and the run goes on. A run
 * that ended unanswered (a failure not retried, an abort) is taken in with the next one, so its
 * inputs count against that run's origin. `bounded` when the scan reached its cap (20 pages of 50)
 * before finding the start of the run.
 */
async function runEntries(tx: Pick<Tx, "scanEntries">, conversationId: ConversationId): Promise<{ entries: EntryRecord[]; bounded: boolean }> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	for (let page = 0; page < 20; page++) {
		const { items, next }: Page<EntryRecord, Cursor> = await tx.scanEntries({ conversationId, order: "descending" }, 50, cursor);
		for (const entry of items) {
			if (entries.length > 0 && answered(entry)) return { entries, bounded: false };
			entries.push(entry);
		}
		if (next === undefined) return { entries, bounded: false };
		cursor = next;
	}
	return { entries, bounded: true };
}

/** An answer: an assistant message that completed without calling a tool. Failed and cut-short requests are not. */
function answered(entry: EntryRecord): boolean {
	return ((entry.model ?? []) as Message[]).some((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && !m.content.some((c) => c.type === "toolCall"));
}

/** The assistant messages of `entries`: every model call Pi wrote down, answered, failed, retried or cut short. */
function assistants(entries: readonly EntryRecord[]): (Message & { role: "assistant" })[] {
	return entries.flatMap((entry) => ((entry.model ?? []) as Message[]).filter((m): m is Message & { role: "assistant" } => m.role === "assistant"));
}

function spentBy(messages: readonly (Message & { role: "assistant" })[]): Spent {
	const spent = noSpend();
	for (const m of messages) {
		spent.input += m.usage?.input ?? 0;
		spent.output += m.usage?.output ?? 0;
		spent.cacheRead += m.usage?.cacheRead ?? 0;
		spent.cacheWrite += m.usage?.cacheWrite ?? 0;
		spent.cost += m.usage?.cost?.total ?? 0;
	}
	return spent;
}

function noSpend(): Spent {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * What the run that ended with `answer` took (ADR 0098), billed once. The answers not billed yet,
 * up to the newest, are billed in order in this commit, each in its own document, and an answer
 * read again gets its own bill back. Token and cost are Pi's own ledger of the conversation
 * (`pi.usage`, every provider call, summaries of a compaction included): at each answer the ledger
 * stood at today's total less the assistant messages written after it, and the bill is the growth
 * since the answer billed before. A call that left no message (a summary) goes to the first answer
 * billed after it was made. The tools are those the run called, in order; the model calls, its
 * assistant messages and compactions. Undefined for an answer from before billing started, and for
 * one that is not there.
 */
export async function turnUsage(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId, answer: EntryId): Promise<TurnUsage | undefined> {
	const billed = await tx.doc(BilledDoc, conversationId);
	if (billed.spent === undefined) return undefined;
	if (billed.answer === undefined || billed.answer < answer) await billAnswers(tx, conversationId, billed as { answer?: number; spent: Spent });
	if (billed.answer === undefined || billed.answer < answer) return undefined;
	const { bill } = await tx.doc(BillDoc, conversationId, String(answer), null);
	return bill === undefined ? undefined : { ...bill, tools: [...bill.tools] };
}

/** Bill every answer after the last one billed, oldest first, from one complete scan of what came after it. */
async function billAnswers(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId, billed: { answer?: number; spent: Spent }): Promise<void> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page: Page<EntryRecord, Cursor> = await tx.scanEntries({ conversationId, order: "ascending", ...(billed.answer === undefined ? {} : { minEntryId: (billed.answer + 1) as EntryId }) }, 50, cursor);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	const now = await ledgerSpent(tx, conversationId);
	let later = spentBy(assistants(entries));
	let run: EntryRecord[] = [];
	for (const entry of entries) {
		run.push(entry);
		if (!answered(entry)) continue;
		const calls = assistants(run);
		later = since(later, spentBy(calls));
		const at = since(now, later);
		const spent = since(at, billed.spent);
		const tools = calls.flatMap((m) => (m.stopReason === "toolUse" ? m.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : [])) : []));
		const modelCalls = calls.length + run.filter((e) => e.kind === CompactionEntry.kind).length;
		// Never below zero: each difference is a sum of calls, only floating point can take it under.
		const bill: Bill = { modelCalls, inputTokens: Math.max(0, spent.input), outputTokens: Math.max(0, spent.output), cacheReadTokens: Math.max(0, spent.cacheRead), cacheWriteTokens: Math.max(0, spent.cacheWrite), costUsd: Math.max(0, spent.cost), tools };
		await tx.doc(BillDoc, conversationId, String(entry.id), bill);
		billed.answer = entry.id;
		billed.spent = at;
		run = [];
	}
}

/**
 * Billing starts for a conversation created before it existed: from its last answer, with the
 * ledger as it stood then (today's total less the assistant messages written after it).
 */
export async function startBilling(tx: Pick<Tx, "scanEntries" | "doc">, conversationId: ConversationId): Promise<void> {
	const billed = await tx.doc(BilledDoc, conversationId);
	if (billed.spent !== undefined) return;
	const after: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	scan: do {
		const page: Page<EntryRecord, Cursor> = await tx.scanEntries({ conversationId, order: "descending" }, 50, cursor);
		for (const entry of page.items) {
			if (answered(entry)) {
				billed.answer = entry.id;
				break scan;
			}
			after.push(entry);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	billed.spent = since(await ledgerSpent(tx, conversationId), spentBy(assistants(after)));
}

/** Every model call of the conversation in Pi's ledger, summed across models. */
async function ledgerSpent(tx: Pick<Tx, "doc">, conversationId: ConversationId): Promise<Spent> {
	const spent = noSpend();
	for (const usage of Object.values((await tx.doc(UsageDoc, conversationId)).models)) {
		spent.input += usage.input;
		spent.output += usage.output;
		spent.cacheRead += usage.cacheRead;
		spent.cacheWrite += usage.cacheWrite;
		spent.cost += usage.cost.total;
	}
	return spent;
}

function since(now: Spent, before: Spent): Spent {
	return { input: now.input - before.input, output: now.output - before.output, cacheRead: now.cacheRead - before.cacheRead, cacheWrite: now.cacheWrite - before.cacheWrite, cost: now.cost - before.cost };
}

/** The least trusted of the inputs: another agente, then a notice, then something scheduled (or not known). */
function worst(found: readonly (TurnOrigin | undefined)[]): TurnOrigin {
	if (found.every((o) => o === "person")) return "person";
	for (const o of ["agent", "notice"] as const) if (found.includes(o)) return o;
	return "scheduled";
}

/**
 * A picture as the model takes it: as it is when it fits, otherwise turned upright, scaled and
 * re-encoded until it does (Photon, in a worker thread, loaded on the first big photo). One
 * that cannot be made to fit becomes a line saying so.
 */
async function toPiImage(image: EngineImage): Promise<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> {
	if (Math.ceil(image.data.length / 3) * 4 <= DEFAULT_IMAGE_LIMITS.maxBytes) return { type: "image", data: Buffer.from(image.data).toString("base64"), mimeType: image.mimeType };
	photon ??= createNodePhotonImages();
	const prepared = await (await photon).prepare(image.data, image.mimeType, DEFAULT_IMAGE_LIMITS).catch(() => undefined);
	if (prepared === undefined) return { type: "text", text: "[Immagine troppo grande: non si è riusciti a ridurla]" };
	return { type: "image", data: prepared.data, mimeType: prepared.mimeType };
}

let photon: Promise<ImageProcessor> | undefined;

/** How many of the newest messages carrying pictures still show them to the model. */
export const RECENT_IMAGE_MESSAGES = 2;

/**
 * The messages with pictures only in the newest `keep` that carry any; older ones get a line
 * saying a picture was there, so the model can reopen it from the workspace with image_view.
 */
export function withRecentImages(messages: readonly Message[], keep: number): readonly Message[] {
	let seen = 0;
	const out = [...messages];
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i] as Message;
		if (message.role === "assistant" || typeof message.content === "string" || !message.content.some((c) => c.type === "image")) continue;
		seen += 1;
		if (seen <= keep) continue;
		const content = message.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[Immagine vista prima: non più allegata, riaprila con image_view se serve]" } : c));
		out[i] = { ...message, content } as Message;
	}
	return out;
}

/**
 * The messages of one request with `note` after the newest message of the person (ADR 0097): the
 * history is left as it is, and the older messages go as they were said.
 */
export function withTurnContext(messages: readonly Message[], note: string): readonly Message[] {
	if (note === "") return messages;
	const at = messages.findLastIndex((m) => m.role === "user");
	if (at < 0) return messages;
	const out = [...messages];
	const message = out[at] as Message & { role: "user" };
	const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	out[at] = { ...message, content: [...blocks, { type: "text", text: note }] };
	return out;
}
