import { createModels } from "@earendil-works/pi-ai/models";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { afterEach, describe, expect, it } from "vitest";
import { localCliProvider } from "../src/core/adapters/pi-durable-local-cli.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import type { EngineReply, EngineSession } from "../src/core/engine.ts";
import { type CliResult, type CliRunner, LocalProviderError, LocalProviders } from "../src/core/local-providers.ts";
import { tempDataDir } from "./helpers.ts";

const secret = "private-token-do-not-expose";
const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: "" });
const event = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
const success = (provider: string, text = "Done") => ok(provider === "codex"
	? `${event(JSON.stringify({ text, toolCalls: [] }))}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 3 } })}`
	: JSON.stringify({ type: "result", subtype: "success", structured_output: { text, toolCalls: [] }, usage: { input_tokens: 11, output_tokens: 3 } }));
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function capability(runner: CliRunner) {
	const local = new LocalProviders("test", tempDataDir(), async (request) => request.args.includes("status")
		? ok(request.provider === "codex" ? "Logged in using ChatGPT" : '{"loggedIn":true,"authMethod":"claude.ai"}')
		: runner(request));
	closers.push(() => local.close());
	await local.detect();
	return local;
}
async function complete(provider: string, runner: CliRunner, signal?: AbortSignal) {
	const local = await capability(runner);
	const models = createModels({ credentials: { read: async () => ({ type: "api_key", key: "owni-local-subscription" }), list: async () => [], modify: async () => undefined, delete: async () => {} }, authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(localCliProvider(provider, local));
	return models.complete(models.getModels(provider)[0]!, { messages: [{ role: "user", content: "Calculate", timestamp: 0 }] }, { signal });
}
async function engine(provider: string, runner: CliRunner) {
	const localProviders = await capability(runner);
	const session = await piDurableEngine.open({ storageDir: tempDataDir(), model: { provider, modelId: provider === "codex" ? "default" : "sonnet" }, apiKey: async () => "owni-local-subscription", localProviders, tools: [] });
	closers.push(() => session.close());
	return session;
}
async function submit(session: EngineSession, text = "Calculate") {
	let detach: (() => void) | undefined;
	const reply = new Promise<EngineReply>((resolve) => { detach = session.onReply(resolve); });
	await session.submit("test:recovery", text);
	try { return await reply; } finally { detach?.(); }
}

describe("local CLI final response", () => {
	it.each([false, true])("validates the final Codex candidate after commentary=%s", async (commentary) => {
		const result = await complete("codex", async () => ok(`${commentary ? `${event("I will check the calculation.")}\n` : ""}${success("codex", "7").stdout}`));
		expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "7" }], usage: { input: 11, output: 3 } });
	});
	it.each([
		["invalid final", event(`invalid ${secret}`)],
		["explicit error", JSON.stringify({ type: "error", message: `invalid request ${secret}` })],
		["failed turn", JSON.stringify({ type: "turn.failed", error: { message: `invalid request ${secret}` } })],
		["forbidden tool", JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: secret } })],
	])("rejects %s even after a valid candidate", async (_name, tail) => {
		const result = await complete("codex", async () => ok(`${success("codex").stdout}\n${tail}`));
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(result.errorMessage).not.toContain(secret);
	});
});

describe("local CLI error classification", () => {
	it("retries Codex transport cancellation through the real engine with a live caller signal", async () => {
		let calls = 0;
		const session = await engine("codex", async ({ signal }) => {
			expect(signal?.aborted).toBe(false);
			return ++calls === 1 ? ok(JSON.stringify({ type: "turn.failed", error: { message: `pending stream has been canceled ${secret}` } })) : success("codex");
		});
		expect(await submit(session)).toMatchObject({ status: "answered", text: "Done" });
		expect(calls).toBe(2);
	});
	it.each([0, 1])("retries Claude overload with input_tokens=403 and exit code %s through the real engine", async (code) => {
		let calls = 0;
		const session = await engine("claude-code", async () => ++calls === 1
			? { code, stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded_error"], usage: { input_tokens: 403 }, session_id: secret }), stderr: "" }
			: success("claude-code"));
		expect(await submit(session)).toMatchObject({ status: "answered", text: "Done" });
		expect(calls).toBe(2);
	});
	it.each([401, 402, 403, 429, 503])("ignores usage and unrelated metadata when classifying Claude errors (%s)", async (tokens) => {
		const result = await complete("claude-code", async () => ok(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded_error"], usage: { input_tokens: tokens, status: 401 }, metadata: { error: "authentication_error" }, session_id: secret })));
		expect(result.stopReason).toBe("error");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(result.errorMessage).not.toMatch(/HTTP|private-token/);
	});
	it.each(["attempt 401: overloaded_error", "request 403: overloaded_error", "request 503 failed", "request 15003 failed"])("requires HTTP context for textual status numbers: %s", async (message) => {
		const result = await complete("codex", async () => ok(JSON.stringify({ type: "turn.failed", error: { message: `${message} ${secret}` } })));
		expect(result.stopReason).toBe("error");
		expect(isRetryableAssistantError(result)).toBe(message.includes("overloaded_error"));
		expect(result.errorMessage).not.toMatch(/HTTP|private-token/);
	});
	it.each([
		[{ message: "Failed", status: 503 }, true],
		[{ message: "Failed", status_code: "503" }, true],
		[{ message: "overloaded_error", statusCode: 401 }, false],
		[{ type: "authentication_error", message: "HTTP 503" }, false],
		[{ type: "insufficient_quota", http_status_code: 429 }, false],
		[{ message: "HTTP/2 503" }, true],
		[{ message: "unexpected status code: 503" }, true],
	])("preserves actual error fields and structured HTTP statuses: %j", async (error, retryable) => {
		const result = await complete("codex", async () => ok(JSON.stringify({ type: "turn.failed", error, usage: { input_tokens: 403 } })));
		expect(result.stopReason).toBe("error");
		expect(isRetryableAssistantError(result)).toBe(retryable);
		if (retryable) expect(result.errorMessage).toContain("HTTP 503");
	});
	it("caller cancellation still wins over transport cancellation wording", async () => {
		const abort = new AbortController();
		const result = await complete("codex", async () => {
			abort.abort();
			return ok(JSON.stringify({ type: "turn.failed", error: { message: "pending stream has been canceled" } }));
		}, abort.signal);
		expect(result.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(result)).toBe(false);
	});
	it.each(["Operation cancelled", "Request canceled by user", "AbortError: explicit abort"])("keeps explicit cancellation terminal: %s", async (message) => {
		const result = await complete("codex", async () => ok(JSON.stringify({ type: "turn.failed", error: { message: `${message}; HTTP 503 ${secret}` } })));
		expect(result.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.errorMessage).not.toContain(secret);
	});
	it.each(["claude-code", "codex"])("%s retries HTTP 503 through the real durable engine", async (provider) => {
		let calls = 0;
		const session = await engine(provider, async () => ++calls === 1 ? { code: 1, stdout: "", stderr: `HTTP 503 Service Unavailable ${secret}` } : success(provider));
		expect(await submit(session)).toMatchObject({ status: "answered", text: "Done" });
		expect(calls).toBe(2);
	});
	it.each(["", "; resets in 60 seconds."])("retries rate throttles through the real engine with reset suffix %j", async (suffix) => {
		let calls = 0;
		const session = await engine("codex", async () => ++calls === 1
			? { code: 1, stdout: "", stderr: `HTTP 429 Too many requests. Rate limit exceeded.${suffix}` }
			: success("codex"));
		const reply = await submit(session);
		expect({ reply, calls }).toMatchObject({ reply: { status: "answered", text: "Done" }, calls: 2 });
	});
	it.each([
		["codex", { type: "turn.failed", error: { message: `HTTP 503 ${secret}` } }],
		["claude-code", { type: "result", subtype: "error_during_execution", is_error: true, errors: [`overloaded_error ${secret}`] }],
	])("%s retains transient classification in explicit CLI failure events", async (provider, failure) => {
		const result = await complete(provider, async () => ok(JSON.stringify(failure)));
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(result.errorMessage).not.toContain(secret);
	});
	it.each([
		"HTTP 401 authentication_error (last retry was HTTP 503)",
		"HTTP 403 permission denied",
		"HTTP 429 insufficient_quota",
		"HTTP 429 usage_limit_reached",
		"HTTP 429 You've hit your usage limit. Try again later",
		"HTTP 429 quota exceeded",
		"HTTP 429 quota exceeded; resets in 60 seconds.",
		"HTTP 429 subscription_sharing_usage_limit_exceeded; resets tomorrow.",
		"HTTP 503 Operation aborted",
	])("does not retry terminal failure: %s", async (failure) => {
		let calls = 0;
		const session = await engine("codex", async () => { calls++; return { code: 1, stdout: "", stderr: `${failure} ${secret}` }; });
		expect(await submit(session)).toMatchObject({ status: "unanswered" });
		expect(calls).toBe(1);
	});
	it.each(["HTTP 429 Too many requests", "connection reset", "Il provider non ha risposto in tempo. Riprova."])("normalizes transient runner errors: %s", async (failure) => {
		const result = await complete("codex", async () => { throw new LocalProviderError(`${failure} ${secret}`); });
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(result.errorMessage).not.toContain(secret);
	});
	it("preserves cancellation from the runner even without an aborted caller signal", async () => {
		const result = await complete("codex", async () => { throw new LocalProviderError(`Operazione annullata ${secret}`); });
		expect(result.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.errorMessage).not.toContain(secret);
	});
	it("an aborted caller wins over a late transient result", async () => {
		const abort = new AbortController();
		const result = await complete("codex", async () => { abort.abort(); return { code: 1, stdout: "", stderr: `HTTP 503 ${secret}` }; }, abort.signal);
		expect(result.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.errorMessage).not.toContain(secret);
	});
	it.each(["prompt is too long", "context_length_exceeded", "request_too_large"])("retains overflow signal: %s", async (failure) => {
		const result = await complete("codex", async () => ok(JSON.stringify({ type: "turn.failed", error: { message: `${failure} ${secret}` } })));
		expect(isContextOverflow(result)).toBe(true);
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.errorMessage).not.toContain(secret);
	});
	it("compacts overflow and resumes through the real durable engine", async () => {
		let calls = 0;
		const prompts: string[] = [];
		const session = await engine("codex", async ({ input }) => {
			calls++; prompts.push(input ?? "");
			return calls === 3 ? ok(JSON.stringify({ type: "turn.failed", error: { message: `context_length_exceeded ${secret}` } })) : success("codex", calls === 4 ? "Earlier context summary" : "Done");
		});
		expect(await submit(session, "Earlier context")).toMatchObject({ status: "answered" });
		expect(await submit(session, "synthetic context ".repeat(6000))).toMatchObject({ status: "answered" });
		expect(await submit(session, "Continue")).toMatchObject({ status: "answered", text: "Done" });
		expect(calls).toBe(5);
		expect(prompts[3]).toContain("context summarization assistant");
		expect(prompts[4]).toContain("Earlier context summary");
	});
});
