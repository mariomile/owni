import type { Static, TSchema } from "typebox";
import type { ModelSelection } from "./registry.ts";
import type { TurnOrigin } from "./turn-origin.ts";
import type { LocalProviders } from "./local-providers.ts";

/**
 * The durable execution engine behind an instance. Owni code depends on this
 * interface only; the Pi Durable implementation lives in src/core/adapters/.
 */
export interface DurableEngine {
	open(options: EngineOpenOptions): Promise<EngineSession>;
}

export type EngineOpenOptions = {
	/** Directory owned exclusively by this instance. One process at a time. */
	readonly storageDir: string;
	readonly model: ModelSelection;
	/**
	 * The only source of model credentials. The engine must not read ambient
	 * credentials (process env, ~/.aws, ...) so that each tenant uses its own keys.
	 */
	readonly apiKey: (provider: string) => Promise<string | undefined>;
	readonly tools: readonly OwniTool[];
	/**
	 * A function is read again on each message: what it returns now is what a conversation runs
	 * with from that message on (the skills of the agente, ADR 0059).
	 */
	readonly instructions?: string | (() => string | undefined);
	/**
	 * Read before every request to the model (ADR 0097): what the turn should know now, the time
	 * and what the agente remembers of whom it is talking with in the thread. It goes after the
	 * newest message of the person for that request only; the history keeps their words.
	 */
	readonly turnContext?: (threadKey: string) => string;
	/**
	 * Whether a chat's own model may answer now (ADR 0036): its provider allowed, with a key. When
	 * not, the instance's model answers, also for work resumed after a restart. Missing: always.
	 */
	readonly modelUsable?: (provider: string) => Promise<boolean>;
	/** Explicit local, tenant-scoped CLI subscription capability. Never inferred from the host. */
	readonly localProviders?: LocalProviders;
	/** Durable Stop intents restored before any recovered provider or tool work may start. */
	readonly stoppedThreads?: readonly string[];
	/**
	 * Asked before each new request to a model (a generation, a summary for compaction), whatever
	 * started the turn: a person, a scheduled task, a notice, a resumed run. `unbilledUsd`: what the
	 * conversation's turn under way has spent so far. Rejecting with ModelRequestRefused sends no
	 * request and ends the turn unanswered with `refused`; any other rejection is retried.
	 */
	readonly authorizeRequest?: (request: { readonly threadKey: string | undefined; readonly unbilledUsd: number }) => Promise<void>;
};

/** A model request authorizeRequest does not allow (the day's spending cap reached). */
export class ModelRequestRefused extends Error {
	constructor(message = "Model request refused") {
		super(message);
		this.name = "ModelRequestRefused";
	}
}

export interface EngineSession {
	/**
	 * Durably admit `text`, and the pictures that came with it, into the conversation identified
	 * by `threadKey` (created on first use). Resolves once admitted; the answer arrives through
	 * `onReply`. The same `requestId` on the same thread is admitted once, also across restarts.
	 * `origin`: where the turn comes from (turn-origin.ts), stored with it so a rerun or a recovery
	 * keeps it, and given to its tools as `ctx.origin`; not given, it is not a person's.
	 */
	submit(threadKey: string, text: string, requestId?: string, images?: readonly EngineImage[], origin?: TurnOrigin): Promise<{ submissionId: string }>;
	/** Continue whatever a previous process left unfinished; replies arrive through `onReply`. */
	resume(): Promise<{ pending: number }>;
	/**
	 * Deliver through `onReply` the outcome of a submission this storage admitted earlier,
	 * also when it has already settled. At most once per session. false: unknown submission.
	 */
	reattach(submissionId: string, threadKey: string): Promise<boolean>;
	/**
	 * The model one conversation answers with instead of the instance's (ADR 0036), from its next
	 * message on and after a restart. undefined: back to the instance's model.
	 */
	setThreadModel(threadKey: string, model: ModelSelection | undefined): Promise<void>;
	/** The conversation's own model as stored, when it has one (usable or not). */
	threadModel(threadKey: string): Promise<ModelSelection | undefined>;
	onReply(listener: (reply: EngineReply) => void): () => void;
	/** Optional for alternate engines. Reads do not start the scheduler. */
	lookupRun?(threadKey: string, requestId: string): Promise<EngineRunState | undefined>;
	/** Abort this conversation's running AND queued inputs; resolves after durable settlement. */
	stop?(threadKey: string): Promise<void>;
	/** Metadata only: never prompt text, tool arguments, results, or thinking. */
	onRunEvent?(listener: (event: EngineRunEvent) => void): () => void;
	/** Resolves when no work is running or pending. */
	idle(): Promise<void>;
	close(): Promise<void>;
}

export type EngineReply =
	| {
			readonly status: "answered";
			readonly threadKey: string;
			readonly submissionId: string;
			readonly text: string;
			/** The model that wrote the answer: the chat's, or the instance's when the chat's could not answer. */
			readonly model?: ModelSelection;
			/** What the turn took, when the engine can tell (ADR 0098). */
			readonly usage?: TurnUsage;
	  }
	| {
			readonly status: "unanswered";
			readonly threadKey: string;
			readonly submissionId: string;
			readonly reason: string;
			readonly cancelled?: boolean;
			/** No request was sent: authorizeRequest refused it. */
			readonly refused?: boolean;
			/** What the turn took before it ended, when the engine can tell (ADR 0098). */
			readonly usage?: TurnUsage;
	  };

export type EngineRunState = {
	readonly threadKey: string;
	readonly submissionId: string;
	readonly requestId?: string;
	readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
};
export type EngineRunEvent = EngineRunState & {
	readonly progress?: { readonly kind: "model" | "tool_start" | "tool_progress" | "tool_end" | "retry"; readonly toolName?: string };
};

/**
 * Every model call of one answered turn, from the inputs to the answer (ADR 0098): tokens, the
 * cost as the provider's list prices give it, and the tools called, in order, by name.
 */
export type TurnUsage = {
	readonly modelCalls: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly costUsd: number;
	readonly tools: readonly string[];
};

/** A picture for the model, already checked (src/core/images.ts). */
export type EngineImage = { readonly mimeType: string; readonly data: Uint8Array };

/** What a tool gives the model: text, or text with pictures (image_view). */
export type ToolResult = string | { readonly text: string; readonly images: readonly EngineImage[] };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * An engine-agnostic tool. `parameters` is a TypeBox schema (a JSON Schema object): the engine
 * checks the model's arguments against it before `execute`, which receives them typed.
 */
export type OwniTool<S extends TSchema = TSchema> = {
	readonly name: string;
	readonly description: string;
	readonly parameters: S;
	/**
	 * true: after a crash mid-call the tool runs again, and finished `step()`s return their
	 * stored result instead of running again. false: the model gets an "interrupted" result.
	 */
	readonly replaySafe: boolean;
	/** true: not offered to the model until it loads it with tool_search (ADR 0122). */
	readonly deferred?: true;
	execute(args: Static<S>, ctx: ToolContext): Promise<ToolResult>;
};

/** Writes a tool so `execute` gets the arguments typed by `parameters`; the result fits any list of tools. */
export function defineOwniTool<S extends TSchema>(tool: OwniTool<S>): OwniTool {
	return tool;
}

export type ToolContext = {
	/**
	 * Run `work` at most once per call and key, durably: if the process dies after the
	 * step's result is stored, a rerun gets the stored result without running `work`.
	 * A crash between `work` finishing and the result being stored reruns it (at-least-once).
	 */
	step<T extends JsonValue>(key: string, work: () => Promise<T>): Promise<T>;
	/** Running output, visible to watchers while the tool runs. */
	progress(text: string): void;
	readonly signal: AbortSignal;
	/** The conversation the call belongs to, when the engine knows it. */
	readonly thread?: { readonly channel: string; readonly threadId: string };
	/** Stable across reruns of the same call: a key for idempotent side effects. */
	readonly callId: string;
	/**
	 * Where the turn this call belongs to comes from (turn-origin.ts): set by the engine on every
	 * call, the same on a rerun. Undefined only in a context built by hand.
	 */
	readonly origin?: TurnOrigin;
	/**
	 * The messages the turn answers, by request id ("channel:messageId"), oldest first: read only
	 * by who needs them (the approval card shows the words of the agente that asked, ADR 0108).
	 */
	readonly inputs?: () => Promise<readonly string[]>;
};
