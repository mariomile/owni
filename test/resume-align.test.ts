import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, type ConversationId, createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { ModelRequestRefused, type OwniTool, type EngineOpenOptions, type EngineReply } from "../src/core/engine.ts";
import { tenantId } from "../src/core/ids.ts";
import { TenantRegistry } from "../src/core/registry.ts";
import { modelApiKeySecret, TenantSecrets } from "../src/core/secrets.ts";
import { tempDataDir, waitFor } from "./helpers.ts";

const DEV = { provider: "faux", modelId: "owni-dev" };
const GROK = { provider: "xai", modelId: "grok-4.7" };

const providers = vi.hoisted(() => new Map<string, Provider>());
vi.mock("../src/core/adapters/pi-durable-models.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/adapters/pi-durable-models.ts")>();
	return { ...actual, createProvider: (...args: Parameters<typeof actual.createProvider>) => providers.get(args[0]) ?? actual.createProvider(...args) };
});
afterEach(() => { providers.clear(); vi.restoreAllMocks(); });

function shownInstructions(messages: readonly Message[]): string | null | undefined {
	let instructions: string | null | undefined;
	for (const message of messages) if (message.role === "system" && message.sections?.instructions !== undefined) instructions = message.sections.instructions;
	return instructions;
}

/** A tool that holds the turn until the session closes, or answers at once. */
function hold(blocking: boolean, started: () => void = () => {}): OwniTool {
	return {
		name: "hold",
		description: "Wait",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		execute: async (_args, { signal }) => {
			if (!blocking) return "ok";
			started();
			return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		},
	};
}

/**
 * Two chats left mid-turn on the local model; meanwhile t2 got its own model, which has no
 * key here: on it t2 cannot answer, on the old one it would.
 */
async function leftMidTurn(): Promise<{ storageDir: string; s1: string; s2: string }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const { submissionId: s1 } = await first.submit("web:t1", "/tool hold {}");
	const { submissionId: s2 } = await first.submit("web:t2", "/tool hold {}");
	await waitFor(() => holding === 2);
	await first.setThreadModel("web:t2", GROK);
	await first.close();
	return { storageDir, s1, s2 };
}

/**
 * Chats left mid-turn on their own model, the local one, while the instance runs on a model
 * with no key here: back on the instance model, a chat cannot answer.
 */
async function leftOnOwnModel(threadKeys: readonly string[] = ["web:t1"]): Promise<{ storageDir: string; ids: string[] }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: GROK, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const ids: string[] = [];
	for (const threadKey of threadKeys) {
		await first.setThreadModel(threadKey, DEV);
		ids.push((await first.submit(threadKey, "/tool hold {}")).submissionId);
	}
	await waitFor(() => holding === threadKeys.length);
	await first.close();
	return { storageDir, ids };
}

/**
 * Chats left mid-turn on the local model, each then given its own model, xAI's: whether they
 * answer after the restart depends on xAI being usable while they are aligned.
 */
async function leftForGrok(threadKeys: readonly string[]): Promise<{ storageDir: string; ids: string[] }> {
	const storageDir = tempDataDir();
	let holding = 0;
	const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(true, () => holding++)] });
	const ids: string[] = [];
	for (const threadKey of threadKeys) ids.push((await first.submit(threadKey, "/tool hold {}")).submissionId);
	await waitFor(() => holding === threadKeys.length);
	for (const threadKey of threadKeys) await first.setThreadModel(threadKey, GROK);
	await first.close();
	return { storageDir, ids };
}

/** The instructions each chat's conversation holds, read from a closed session's storage. */
async function storedInstructions(storageDir: string): Promise<Record<string, string | undefined>> {
	const ThreadsDoc = defineDoc<{ threads: Record<string, number> }>({ kind: "owni.threads", version: 1, scope: "session", initial: () => ({ threads: {} }) });
	const models = createModels({
		credentials: { read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {} },
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const storage = await openNodeSqliteStorage(join(storageDir, "pi-durable.sqlite"));
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const threads = (await harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT))?.threads ?? {};
	const result: Record<string, string | undefined> = {};
	for (const [threadKey, id] of Object.entries(threads)) result[threadKey] = (await harness.snapshot(AgentDoc, id as ConversationId, BACKGROUND_CONTEXT))?.instructions;
	await harness.close(BACKGROUND_CONTEXT);
	return result;
}

const reopenOnGrok = (storageDir: string, modelUsable?: EngineOpenOptions["modelUsable"]) =>
	piDurableEngine.open({ storageDir, model: GROK, apiKey: async () => undefined, tools: [hold(false)], ...(modelUsable === undefined ? {} : { modelUsable }) });

const reopen = (storageDir: string, modelUsable?: EngineOpenOptions["modelUsable"]) =>
	piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [hold(false)], ...(modelUsable === undefined ? {} : { modelUsable }) });

describe("restart after the configuration changed", () => {
	it("round 6: a chat model cleared during the final verification cannot start stale", async () => {
		const { storageDir } = await leftOnOwnModel(["web:t1", "web:t2"]);
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const session = await reopenOnGrok(storageDir, async () => {
			if (++checks === 4) await held;
			return true;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			const resumed = session.resume();
			await waitFor(() => checks === 4);
			await session.setThreadModel("web:t1", undefined);
			release();
			await resumed;
			await waitFor(() => replies.length === 2);
			expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "unanswered" });
			expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		} finally {
			release();
			await session.close();
		}
	});

	it("round 6: an interrupted request takes the current model and instructions on recovery", async () => {
		const storageDir = tempDataDir();
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(DEV.provider, faux.provider);
		providers.set(GROK.provider, grok.provider);
		const sent: { provider: string; instructions: string | null | undefined }[] = [];
		faux.setResponses([async ({ messages }, options) => {
			sent.push({ provider: DEV.provider, instructions: shownInstructions(messages) });
			await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("interrupted", { stopReason: "aborted" });
		}, ({ messages }) => {
			sent.push({ provider: DEV.provider, instructions: shownInstructions(messages) });
			return fauxAssistantMessage("stale");
		}]);
		grok.setResponses([({ messages }) => {
			sent.push({ provider: GROK.provider, instructions: shownInstructions(messages) });
			return fauxAssistantMessage("current");
		}]);
		const first = await piDurableEngine.open({ storageDir, model: DEV, instructions: "OLD", apiKey: async () => undefined, tools: [] });
		await first.submit("web:t1", "hello");
		await waitFor(() => sent.length === 1);
		await first.setThreadModel("web:t1", GROK);
		await first.close();
		const session = await piDurableEngine.open({ storageDir, model: DEV, instructions: "NEW", apiKey: async () => undefined, tools: [] });
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			expect(await session.resume()).toEqual({ pending: 1 });
			await waitFor(() => replies.length === 1);
			expect(sent).toEqual([{ provider: "faux", instructions: "<instructions>\nOLD\n</instructions>" }, { provider: "xai", instructions: "<instructions>\nNEW\n</instructions>" }]);
			expect(replies[0]).toMatchObject({ status: "answered", text: "current", model: GROK });
		} finally {
			await session.close();
		}
	});

	it("a fresh request rereads a choice changed during its own outgoing usability check", async () => {
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(DEV.provider, faux.provider);
		providers.set(GROK.provider, grok.provider);
		const sent: (string | null | undefined)[] = [];
		grok.setResponses([({ messages }) => { sent.push(shownInstructions(messages)); return fauxAssistantMessage("current"); }]);
		let instructions = "OLD";
		let atRequest = false;
		let checking = false;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const session = await piDurableEngine.open({
			storageDir: tempDataDir(), model: GROK, apiKey: async () => undefined, tools: [],
			instructions: () => instructions,
			turnContext: () => { atRequest = true; return "context"; },
			modelUsable: async () => {
				if (atRequest) { checking = true; await held; }
				return true;
			},
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.setThreadModel("web:t1", DEV);
			await session.submit("web:t1", "hello");
			await waitFor(() => checking);
			await session.setThreadModel("web:t1", undefined);
			instructions = "NEW";
			release();
			await waitFor(() => replies.length === 1);
			expect(replies[0]).toMatchObject({ status: "answered", model: GROK });
			expect(sent).toEqual(["<instructions>\nNEW\n</instructions>"]);
			expect(faux.state.callCount).toBe(0);
		} finally { release(); await session.close(); }
	});

	it("an outgoing alignment failure retries without sending a stale request", async () => {
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		providers.set(DEV.provider, faux.provider);
		faux.setResponses([fauxAssistantMessage("ok")]);
		let injectFailure = true;
		let fail = false;
		let failures = 0;
		const session = await piDurableEngine.open({
			storageDir: tempDataDir(), model: DEV, apiKey: async () => undefined, tools: [],
			turnContext: () => { if (injectFailure) { injectFailure = false; fail = true; } return "context"; },
			modelUsable: async () => { if (fail) { fail = false; failures++; throw new Error("temporary provider lookup failure"); } return true; },
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.setThreadModel("web:t1", DEV);
			await session.submit("web:t1", "hello");
			await waitFor(() => failures === 1);
			expect(faux.state.callCount).toBe(0);
			await waitFor(() => replies.length === 1);
			expect(replies[0]).toMatchObject({ status: "answered", text: "ok" });
			expect(faux.state.callCount).toBe(1);
		} finally { await session.close(); }
	});

	it("dispatch does not hold a usable-provider result across a queued document read", async () => {
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(DEV.provider, faux.provider);
		providers.set(GROK.provider, grok.provider);
		faux.setResponses([fauxAssistantMessage("started before revocation")]);
		grok.setResponses([fauxAssistantMessage("fallback after revocation"), fauxAssistantMessage("still on fallback")]);
		const secrets = new TenantSecrets(tempDataDir(), tenantId("acme"));
		await secrets.set(modelApiKeySecret("faux"), "test-only-key");
		let harness: Harness;
		const open = Harness.open;
		vi.spyOn(Harness, "open").mockImplementation(async (...args) => { harness = await open(...args); return harness; });
		let outgoing = false;
		let blockOnce = true;
		let entered = () => {};
		const blocked = new Promise<void>((resolve) => (entered = resolve));
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let transaction: Promise<void> | undefined;
		const session = await piDurableEngine.open({
			storageDir: tempDataDir(), model: GROK, apiKey: async () => undefined, tools: [],
			turnContext: () => { outgoing = true; return "context"; },
			modelUsable: async (provider) => {
				const usable = await secrets.get(modelApiKeySecret(provider)) !== undefined;
				if (outgoing && blockOnce) {
					blockOnce = false;
					transaction = harness.commit(async () => { entered(); await held; }, BACKGROUND_CONTEXT);
					await blocked;
				}
				return usable;
			},
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.setThreadModel("web:t1", DEV);
			await session.submit("web:t1", "first");
			await blocked;
			// A snapshot queued after the usability result would now block dispatch. The live document
			// value lets the request start before the subsequent credential publication instead.
			await waitFor(() => faux.state.callCount === 1, 500).catch(() => {});
			const startedBeforePublication = faux.state.callCount === 1;
			await secrets.delete(modelApiKeySecret("faux"));
			release();
			await transaction;
			await waitFor(() => replies.length === 1);
			await session.submit("web:t1", "second");
			await waitFor(() => replies.length === 2);
			// If a late read held the request, the completed revocation must force the fallback.
			// Only a request demonstrably dispatched BEFORE publication may retain the old model.
			expect(replies[0]).toMatchObject({ status: "answered", model: startedBeforePublication ? DEV : GROK });
			expect(replies[1]).toMatchObject({ status: "answered", model: GROK });
		} finally { release(); await transaction; await session.close(); }
	});

	it("fails closed when credentials are revoked after the outgoing gate, and uses fallback on the next submission", async () => {
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		// Faux transport with a real credential requirement: missing auth must prevent
		// provider dispatch, independently of what the preceding usability check saw.
		const keyed = new Proxy(grok.provider, { get: (target, property, receiver) => property === "auth"
			? { apiKey: { name: "xAI", resolve: async ({ credential }: { credential?: { type: string; key?: string } }) => credential?.type === "api_key" && credential.key ? { auth: { apiKey: credential.key } } : undefined } }
			: Reflect.get(target, property, receiver) });
		providers.set(DEV.provider, faux.provider);
		providers.set(GROK.provider, keyed);
		faux.setResponses([fauxAssistantMessage("next submission on fallback")]);
		grok.setResponses([fauxAssistantMessage("must not dispatch")]);
		const secrets = new TenantSecrets(tempDataDir(), tenantId("acme"));
		await secrets.set(modelApiKeySecret(GROK.provider), "test-only-key");
		let outgoing = false;
		let revokeOnce = true;
		const credentialReads: (string | undefined)[] = [];
		const session = await piDurableEngine.open({
			storageDir: tempDataDir(), model: DEV, tools: [],
			apiKey: async (provider) => {
				if (provider === DEV.provider) return undefined;
				const credential = await secrets.get(modelApiKeySecret(provider));
				credentialReads.push(credential);
				return credential;
			},
			turnContext: () => { outgoing = true; return "context"; },
			modelUsable: async (provider) => {
				const usable = provider === DEV.provider || (await secrets.get(modelApiKeySecret(provider))) !== undefined;
				if (outgoing && provider === GROK.provider && revokeOnce) {
					revokeOnce = false;
					await secrets.delete(modelApiKeySecret(GROK.provider));
				}
				return usable;
			},
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.setThreadModel("web:t1", GROK);
			await session.submit("web:t1", "first", "first");
			await waitFor(() => replies.length === 1);
			expect(revokeOnce).toBe(false);
			// This narrow gate/auth boundary is deliberately fail-closed, not a promise
			// to transparently retarget an already-prepared request or cache revoked keys.
			expect(replies[0]).toMatchObject({ status: "unanswered", reason: "model_error" });
			expect(credentialReads).toContain(undefined);
			expect(grok.state.callCount).toBe(0);
			expect(faux.state.callCount).toBe(0);
			await session.submit("web:t1", "next", "next");
			await waitFor(() => replies.length === 2);
			expect(replies[1]).toMatchObject({ status: "answered", text: "next submission on fallback", model: DEV });
			expect(grok.state.callCount).toBe(0);
			expect(faux.state.callCount).toBe(1);
		} finally { await session.close(); }
	});

	it("an interrupted compaction uses the current model while retaining Pi's summary prompt and range", async () => {
		const storageDir = tempDataDir();
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(DEV.provider, faux.provider);
		providers.set(GROK.provider, grok.provider);
		const sent: { provider: string; content: Message["content"][] }[] = [];
		faux.setResponses([fauxAssistantMessage("old answer"), async ({ messages }, options) => {
			sent.push({ provider: "faux", content: messages.map((m) => m.content) });
			await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("interrupted", { stopReason: "aborted" });
		}, fauxAssistantMessage("stale summary")]);
		grok.setResponses([({ messages }) => { sent.push({ provider: "xai", content: messages.map((m) => m.content) }); return fauxAssistantMessage("current summary"); }]);
		const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [] });
		await first.submit("web:t1", "summarize this history");
		await first.idle();
		await first.close();
		const models = createModels({ credentials: { read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {} }, authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(faux.provider);
		const storage = await openNodeSqliteStorage(join(storageDir, "pi-durable.sqlite"));
		const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { compaction: { keepRecentTokens: 1 } } }, BACKGROUND_CONTEXT);
		const threads = defineDoc<{ threads: Record<string, number> }>({ kind: "owni.threads", version: 1, scope: "session", initial: () => ({ threads: {} }) });
		const choices = defineDoc<{ models: Record<string, typeof DEV> }>({ kind: "owni.thread-models", version: 1, scope: "session", initial: () => ({ models: {} }) });
		const id = (await harness.snapshot(threads, BACKGROUND_CONTEXT))!.threads["web:t1"] as ConversationId;
		await (await harness.conversation(id, BACKGROUND_CONTEXT))!.compact(undefined, BACKGROUND_CONTEXT);
		await waitFor(() => sent.length === 1);
		await harness.commit(async (tx) => { (await tx.doc(choices)).models["web:t1"] = GROK; }, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		const session = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [] });
		try {
			await session.resume();
			await session.idle();
			expect(sent.map((s) => s.provider)).toEqual(["faux", "xai"]);
			expect(sent[1]!.content).toEqual(sent[0]!.content);
			expect(faux.state.callCount).toBe(2);
		} finally { await session.close(); }
	});

	it("a compaction's summary is refused by the spending cap like any other request: nothing is sent", async () => {
		const storageDir = tempDataDir();
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }] });
		providers.set(DEV.provider, faux.provider);
		const sent: number[] = [];
		faux.setResponses([fauxAssistantMessage("old answer"), async (_context, options) => {
			sent.push(sent.length);
			await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("interrupted", { stopReason: "aborted" });
		}, fauxAssistantMessage("summary sent anyway")]);
		const first = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [] });
		await first.submit("web:t1", "summarize this history");
		await first.idle();
		await first.close();
		const models = createModels({ credentials: { read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {} }, authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(faux.provider);
		const storage = await openNodeSqliteStorage(join(storageDir, "pi-durable.sqlite"));
		const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { compaction: { keepRecentTokens: 1 } } }, BACKGROUND_CONTEXT);
		const threads = defineDoc<{ threads: Record<string, number> }>({ kind: "owni.threads", version: 1, scope: "session", initial: () => ({ threads: {} }) });
		const id = (await harness.snapshot(threads, BACKGROUND_CONTEXT))!.threads["web:t1"] as ConversationId;
		await (await harness.conversation(id, BACKGROUND_CONTEXT))!.compact(undefined, BACKGROUND_CONTEXT);
		await waitFor(() => sent.length === 1);
		await harness.close(BACKGROUND_CONTEXT);
		const asked: (string | undefined)[] = [];
		const session = await piDurableEngine.open({ storageDir, model: DEV, apiKey: async () => undefined, tools: [], authorizeRequest: async ({ threadKey }) => { asked.push(threadKey); throw new ModelRequestRefused("capped"); } });
		try {
			await session.resume();
			await session.idle();
			expect(asked).toContain("web:t1");
			// The old answer and the summary interrupted before the restart: the summary is not sent again.
			expect(faux.state.callCount).toBe(2);
		} finally { await session.close(); }
	});

	it("queued inputs use the new choice without repeating the tool already completed", async () => {
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(GROK.provider, grok.provider);
		grok.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		let calls = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const session = await piDurableEngine.open({
			storageDir: tempDataDir(), model: DEV, apiKey: async () => undefined,
			tools: [{ ...hold(false), execute: async () => { calls++; await held; return "ok"; } }],
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.submit("web:t1", "/tool hold {}");
			await waitFor(() => calls === 1);
			await session.submit("web:t1", "next input");
			await session.setThreadModel("web:t1", GROK);
			release();
			await waitFor(() => replies.length === 2);
			expect(replies.every((reply) => reply.status === "answered" && reply.model?.provider === "xai")).toBe(true);
			expect(calls).toBe(1);
		} finally { release(); await session.close(); }
	});

	it.each(["unchanged", "lookup fails", "model changed", "instructions changed", "instructions cleared", "provider revoked"] as const)("a deferred poll on recovery: %s", async (change) => {
		const storageDir = tempDataDir();
		const faux = fauxProvider({ provider: DEV.provider, models: [{ id: DEV.modelId }], deferred: { pendingFetches: 1, pollAfterMs: 150 } });
		const grok = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(DEV.provider, { ...faux.provider, streamSimple: (model, transcript, options) => faux.provider.streamSimple(model, transcript, { ...options, deferred: true }) });
		providers.set(GROK.provider, grok.provider);
		const staleTool = vi.fn(async () => "must not run");
		const tools = [{ ...hold(false), name: "stale_tool", replaySafe: false, execute: staleTool }];
		const sent: (string | null | undefined)[] = [];
		const answer = ({ messages }: { messages: Message[] }) => { sent.push(shownInstructions(messages)); return fauxAssistantMessage("current"); };
		const unchanged = change === "unchanged" || change === "lookup fails";
		faux.setResponses([unchanged ? answer : fauxAssistantMessage(fauxToolCall("stale_tool", {}), { stopReason: "toolUse" }), answer]);
		grok.setResponses([answer]);
		const first = await piDurableEngine.open({ storageDir, model: GROK, instructions: "OLD", apiKey: async () => undefined, tools });
		await first.setThreadModel("web:t1", DEV);
		await first.submit("web:t1", "hello");
		// The first deferred fetch reports pending: the request is durably in the poll phase.
		// The waits in this test end on a condition, not a clock: the budget is only how long a loaded machine may take (the test has 60 s).
		await waitFor(() => faux.state.deferredFetchCount === 1, 45_000);
		if (change === "model changed") await first.setThreadModel("web:t1", GROK);
		await first.close();
		const instructions = change === "instructions cleared" ? undefined : unchanged ? "OLD" : "NEW";
		let checks = 0;
		const session = await piDurableEngine.open({ storageDir, model: GROK, instructions, apiKey: async () => undefined, tools, modelUsable: async (provider) => {
			if (++checks === 3 && change === "lookup fails") throw new Error("temporary poll alignment failure");
			return change !== "provider revoked" || provider !== "faux";
		} });
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			expect(await session.resume()).toEqual({ pending: 1 });
			await waitFor(() => replies.length === 1, 45_000);
			expect(replies[0]).toMatchObject({ status: "answered", text: "current", model: change === "model changed" || change === "provider revoked" ? GROK : DEV });
			expect(staleTool).not.toHaveBeenCalled();
			expect(sent).toEqual([instructions === undefined ? null : `<instructions>\n${instructions}\n</instructions>`]);
			expect(faux.state.cancelledDeferred).toHaveLength(unchanged || change === "provider revoked" ? 0 : 1);
			if (unchanged) expect(faux.state.callCount).toBe(1);
			if (change === "model changed" || change === "provider revoked") expect(faux.state.deferredFetchCount).toBe(1);
		} finally { await session.close(); }
	});

	it("resume(): every pending conversation is aligned before any of them runs again", async () => {
		const { storageDir } = await leftMidTurn();
		const replies: EngineReply[] = [];
		let resuming = false;
		// Checking t2's model during resume() is held until t1 has answered (or a second, when
		// nothing runs yet): had the scheduler started before t2 was aligned, t2 would answer on
		// the old model meanwhile.
		const session = await reopen(storageDir, async () => {
			if (resuming) await waitFor(() => replies.length > 0, 1_000).catch(() => {});
			return true;
		});
		session.onReply((reply) => replies.push(reply));
		resuming = true;
		expect(await session.resume()).toEqual({ pending: 2 });
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		await session.close();
	});

	it("reattach() before resume(), the runtime's order: the work goes on with the configuration of now", async () => {
		const { storageDir, s1, s2 } = await leftMidTurn();
		const session = await reopen(storageDir);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		expect(await session.reattach(s1, "web:t1")).toBe(true);
		expect(await session.reattach(s2, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "unanswered" });
		expect(await session.resume()).toEqual({ pending: 0 });
		await session.close();
	});

	it("a chat model cleared after open() and before resume() still counts", async () => {
		const { storageDir } = await leftOnOwnModel();
		const session = await reopenOnGrok(storageDir);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		await session.setThreadModel("web:t1", undefined);
		expect(await session.resume()).toEqual({ pending: 1 });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadKey: "web:t1", status: "unanswered" });
		await session.close();
	});

	it("a chat model that stops being usable after open() and before reattach() still counts", async () => {
		const {
			storageDir,
			ids: [s1],
		} = await leftOnOwnModel();
		let usable = true;
		const session = await reopenOnGrok(storageDir, async () => usable);
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		usable = false;
		expect(await session.reattach(s1!, "web:t1")).toBe(true);
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadKey: "web:t1", status: "unanswered" });
		await session.close();
	});

	it("a preparation that fails is tried again by the next call, and the work goes on", async () => {
		const { storageDir, ids } = await leftOnOwnModel();
		let checks = 0;
		const session = await reopenOnGrok(storageDir, async () => {
			if (++checks <= 2) throw new Error("provider check down");
			return true;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		await expect(session.reattach(ids[0]!, "web:t1")).rejects.toThrow("provider check down");
		await expect(session.resume()).rejects.toThrow("provider check down");
		expect(await session.resume()).toEqual({ pending: 1 });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadKey: "web:t1", status: "answered" });
		// Failed preparation did not start the scheduler; later checks include the actual request.
		expect(checks).toBeGreaterThanOrEqual(4);
		await session.close();
	});

	it("a chat model cleared while the others are still being aligned counts too", async () => {
		const { storageDir, ids } = await leftOnOwnModel(["web:t1", "web:t2"]);
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// t1 is checked and aligned first; t2's check waits for the test.
		const session = await reopenOnGrok(storageDir, async () => {
			if (++checks === 2) await held;
			return true;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		await session.setThreadModel("web:t1", undefined);
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "unanswered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});

	it("a provider key removed while the others are still being aligned counts too", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const secrets = new TenantSecrets(tempDataDir(), tenantId("acme"));
		await secrets.set(modelApiKeySecret("xai"), "xai-key");
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// The runtime's check, on a real secret store; t2's first check waits for the test.
		const session = await reopen(storageDir, async (provider) => {
			if (++checks === 2) await held;
			return provider === "faux" || (await secrets.get(modelApiKeySecret(provider))) !== undefined;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		await secrets.delete(modelApiKeySecret("xai"));
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});

	it("a provider key removed during the fourth usability check makes both recovered chats use the fallback", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const revoked = fauxProvider({ provider: GROK.provider, models: [{ id: GROK.modelId }] });
		providers.set(GROK.provider, revoked.provider);
		revoked.setResponses([fauxAssistantMessage("must not dispatch")]);
		const secrets = new TenantSecrets(tempDataDir(), tenantId("acme"));
		await secrets.set(modelApiKeySecret(GROK.provider), "test-only-key");
		let armed = false;
		let checks = 0;
		let completedChecks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const session = await reopen(storageDir, async (provider) => {
			const check = armed ? ++checks : 0;
			if (check === 4) await held;
			const usable = provider === DEV.provider || (await secrets.get(modelApiKeySecret(provider))) !== undefined;
			if (armed) completedChecks++;
			return usable;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		try {
			await session.setThreadModel("web:t2", DEV);
			armed = true;
			const reattached = session.reattach(ids[0]!, "web:t1");
			// t1's second check still saw its key. Hold t2's fourth check while the
			// revocation is published; t1 must revalidate again at actual dispatch.
			await waitFor(() => checks === 4 && completedChecks === 3);
			expect(replies).toHaveLength(0);
			await secrets.delete(modelApiKeySecret(GROK.provider));
			release();
			expect(await reattached).toBe(true);
			expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
			await waitFor(() => replies.length === 2);
			for (const threadKey of ["web:t1", "web:t2"]) expect(replies.find((reply) => reply.threadKey === threadKey)).toMatchObject({ status: "answered", model: DEV });
			expect(revoked.state.callCount).toBe(0);
		} finally { release(); await session.close(); }
	});

	it("instructions changed while the others are still being aligned count too", async () => {
		const { storageDir, ids } = await leftOnOwnModel(["web:t1", "web:t2"]);
		let instructions = "Skills: none";
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// t1 is aligned first; t2's check waits for the test.
		const session = await piDurableEngine.open({
			storageDir,
			model: GROK,
			apiKey: async () => undefined,
			tools: [hold(false)],
			instructions: () => instructions,
			modelUsable: async () => {
				if (++checks === 2) await held;
				return true;
			},
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		instructions = "Skills: invoices";
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		await session.close();
		expect(await storedInstructions(storageDir)).toEqual({ "web:t1": "Skills: invoices", "web:t2": "Skills: invoices" });
	});

	it("an instance policy written while a check is pending counts, before its writer has even resumed", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const registry = new TenantRegistry(tempDataDir());
		await registry.createTenant({ id: "acme", name: "Acme" });
		await registry.createInstance("acme", { id: "ops", name: "Ops", model: DEV, egress: { modelProviders: ["faux", "xai"], channels: ["web"] } });
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// The runtime's policy check, on a real registry; t2's first check waits for the test.
		const session = await reopen(storageDir, async (provider) => {
			if (++checks === 2) await held;
			return (await registry.getInstance("acme", "ops")).egress.modelProviders.includes(provider);
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		// The write is synchronous under the file's lock: on disk before the call returns its promise.
		const written = registry.setEgress("acme", "ops", () => ({ modelProviders: ["faux"], channels: ["web"] }));
		release();
		expect(await reattached).toBe(true);
		await written;
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});

	it("a provider key removed by another process counts too", async () => {
		const { storageDir, ids } = await leftForGrok(["web:t1", "web:t2"]);
		const dataDir = tempDataDir();
		const secrets = new TenantSecrets(dataDir, tenantId("acme"));
		await secrets.set(modelApiKeySecret("xai"), "xai-key");
		let checks = 0;
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const session = await reopen(storageDir, async (provider) => {
			if (++checks === 2) await held;
			return provider === "faux" || (await secrets.get(modelApiKeySecret(provider))) !== undefined;
		});
		const replies: EngineReply[] = [];
		session.onReply((reply) => replies.push(reply));
		const reattached = session.reattach(ids[0]!, "web:t1");
		await waitFor(() => checks === 2);
		const url = (file: string) => pathToFileURL(join(process.cwd(), file)).href;
		const script = [
			`import { TenantSecrets, modelApiKeySecret } from ${JSON.stringify(url("src/core/secrets.ts"))};`,
			`import { tenantId } from ${JSON.stringify(url("src/core/ids.ts"))};`,
			`await new TenantSecrets(${JSON.stringify(dataDir)}, tenantId("acme")).delete(modelApiKeySecret("xai"));`,
		].join("\n");
		await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
		release();
		expect(await reattached).toBe(true);
		expect(await session.reattach(ids[1]!, "web:t2")).toBe(true);
		await waitFor(() => replies.length === 2);
		expect(replies.find((r) => r.threadKey === "web:t1")).toMatchObject({ status: "answered" });
		expect(replies.find((r) => r.threadKey === "web:t2")).toMatchObject({ status: "answered" });
		await session.close();
	});
});
