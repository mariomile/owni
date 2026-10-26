import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { codexInferenceCatalog, localCliProvider } from "../src/core/adapters/pi-durable-local-cli.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { createPiCompletionClient } from "../src/core/adapters/pi-durable-completion.ts";
import type { EngineReply } from "../src/core/engine.ts";
import { OwniRuntime, type Reply } from "../src/core/runtime.ts";
import { type CliResult, type CliRunner, LocalProviderError, LocalProviders, localCliExecutable, runLocalCli } from "../src/core/local-providers.ts";
import { ConfigError, loadOwniConfig } from "../src/main/config.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const ok = (stdout: string, stderr = ""): CliResult => ({ code: 0, stdout, stderr });
const auth = (provider: string) => provider === "claude-code" ? ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "private@example.invalid", accessToken: "never-show-this" })) : ok("", "Logged in using ChatGPT\n");
const isStatus = (args: readonly string[]) => args.includes("status");
const completed = (provider: string, text: string, toolCalls: { name: string; arguments: string }[] = []) => provider === "claude-code" ? ok(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { text, toolCalls }, usage: { input_tokens: 11, output_tokens: 3 } })) : ok(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ text, toolCalls }) } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 13, output_tokens: 5 } })}\n`);
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function local(runner: CliRunner = async ({ provider }) => auth(provider), dir = tempDataDir()) {
	const providers = new LocalProviders("default", dir, runner);
	closers.push(() => providers.close());
	await providers.detect();
	return providers;
}

describe("subscription capability", () => {
	it("requires explicit local opt-in, loopback, and no public or cloud endpoint", () => {
		expect(loadOwniConfig({ OWNI_LOCAL_PROVIDERS: "1" })).toMatchObject({ modelProvider: "faux", localProviders: true });
		expect(() => loadOwniConfig({ OWNI_MODEL_PROVIDER: "codex" })).toThrow(ConfigError);
		for (const env of [{ OWNI_WEB_HOST: "0.0.0.0" }, { OWNI_PUBLIC_URL: "https://example.invalid" }, { OWNI_CELL_SECRET: "1234567890123456" }]) expect(() => loadOwniConfig({ OWNI_LOCAL_PROVIDERS: "1", ...env })).toThrow(/loopback/);
		expect(loadOwniConfig({ OWNI_LOCAL_PROVIDERS: "1", OWNI_MODEL_PROVIDER: "claude-code" }).modelId).toBe("sonnet");
	});
	it("finds standard local CLI installs when Finder has only system binaries on PATH", () => {
		const home = tempDataDir();
		const bin = join(home, ".local", "bin"); mkdirSync(bin, { recursive: true });
		const cli = join(bin, "claude"); writeFileSync(cli, "#!/bin/sh\nexit 0\n"); chmodSync(cli, 0o700);
		expect(localCliExecutable("claude-code", "/usr/bin:/bin", home)).toBe(cli);
		expect(() => localCliExecutable("bash", "/usr/bin:/bin", home)).toThrow(/sconosciuto/);
	});
	it("never lets inherited API keys or nested-session flags override subscription auth", async () => {
		const bin = tempDataDir();
		const executable = join(bin, "claude");
		writeFileSync(executable, '#!/bin/sh\nprintf "%s|%s|%s" "$ANTHROPIC_API_KEY" "$OPENAI_API_KEY" "$CLAUDECODE"\n'); chmodSync(executable, 0o700);
		vi.stubEnv("PATH", bin); vi.stubEnv("ANTHROPIC_API_KEY", "do-not-inherit"); vi.stubEnv("OPENAI_API_KEY", "do-not-inherit-either"); vi.stubEnv("CLAUDECODE", "nested-session");
		try { expect((await runLocalCli({ provider: "claude-code", args: ["auth", "status"], cwd: bin })).stdout).toBe("||"); }
		finally { vi.unstubAllEnvs(); }
	});
	it("preserves UTF-8 characters split across CLI output chunks", async () => {
		const bin = tempDataDir();
		const executable = join(bin, "claude");
		writeFileSync(executable, `#!${process.execPath}\nconst text=Buffer.from(JSON.stringify({toolCalls:[{name:'save',arguments:'fatturà-€-📁.pdf'}]}));let i=0;const next=()=>{if(i===text.length)return;process.stdout.write(text.subarray(i,i+1));i++;setTimeout(next,1)};next();\n`); chmodSync(executable, 0o700);
		vi.stubEnv("PATH", bin);
		try { const result = await runLocalCli({ provider: "claude-code", args: [], cwd: bin }); expect(JSON.parse(result.stdout)).toEqual({ toolCalls: [{ name: "save", arguments: "fatturà-€-📁.pdf" }] }); }
		finally { vi.unstubAllEnvs(); }
	});
	it("auto-connects existing subscriptions without retaining account details or tokens", async () => {
		const providers = await local();
		expect(providers.list().map((p) => [p.id, p.key, p.status])).toEqual([["claude-code", "local", "connected"], ["codex", "local", "connected"]]);
		expect(JSON.stringify(providers.list())).not.toMatch(/private@example|never-show/);
	});
	it("refuses API-key accounts as subscription authentication", async () => {
		const providers = await local(async ({ provider }) => provider === "claude-code" ? ok('{"loggedIn":true,"authMethod":"api_key"}') : ok("Logged in using an API key"));
		expect(providers.list().every((p) => p.authenticated === false && p.connected === false)).toBe(true);
	});
	it("keeps explicit disconnect and the one-time initial model across process restarts", async () => {
		const dir = tempDataDir();
		const first = await local(undefined, dir);
		expect(first.initialModel()).toEqual({ provider: "claude-code", modelId: "sonnet" });
		first.disconnect("claude-code");
		await first.detect();
		expect(first.connected("claude-code")).toBe(false);
		const second = await local(undefined, dir);
		expect(second.connected("claude-code")).toBe(false);
		expect(second.initialModel()).toBeUndefined();
		await second.connect("claude-code");
		expect(second.connected("claude-code")).toBe(true);
		expect(second.initialModel()).toBeUndefined();
		expect(readFileSync(join(dir, "connections.json"), "utf8")).not.toMatch(/token|private@example/);
	});
	it("keeps bootstrap eligible when the first login probe finds no subscription", async () => {
		let authenticated = false;
		const dir = tempDataDir();
		const runner: CliRunner = async ({ provider }) => authenticated ? auth(provider) : ok(provider === "claude-code" ? '{"loggedIn":false}' : "Not logged in");
		const first = await local(runner, dir);
		expect(first.initialModel()).toBeUndefined();
		authenticated = true;
		const second = await local(runner, dir);
		expect(second.initialModel()).toEqual({ provider: "claude-code", modelId: "sonnet" });
		expect(second.initialModel()).toBeUndefined();
	});
	it("starts one browser login, reports progress, and connects after the official CLI completes", async () => {
		let loggedIn = false;
		let finish: (() => void) | undefined;
		let logins = 0;
		const providers = await local(async ({ provider, args, timeoutMs }) => {
			if (isStatus(args)) return loggedIn ? auth(provider) : ok(provider === "claude-code" ? '{"loggedIn":false}' : "Not logged in");
			logins++; expect(args).toEqual(["auth", "login", "--claudeai"]); expect(timeoutMs).toBe(300_000);
			return new Promise((resolve) => { finish = () => { loggedIn = true; resolve(ok("secret-login-output")); }; });
		});
		const [a, b] = await Promise.all([providers.connect("claude-code"), providers.connect("claude-code")]);
		expect([a.status, b.status]).toEqual(["connecting", "connecting"]); expect(logins).toBe(1);
		finish?.(); await waitFor(() => providers.connected("claude-code"));
		expect(JSON.stringify(providers.list())).not.toContain("secret-login-output");
	});
	it("cancels an in-flight login on disconnect and never reconnects after its late completion", async () => {
		let loginSignal: AbortSignal | undefined;
		let finish: (() => void) | undefined;
		let loggedIn = false;
		const providers = await local(async ({ provider, args, signal }) => {
			if (isStatus(args)) return loggedIn ? auth(provider) : ok(provider === "claude-code" ? '{"loggedIn":false}' : "Not logged in");
			loginSignal = signal;
			return new Promise((resolve) => { finish = () => { loggedIn = true; resolve(ok("")); }; });
		});
		await providers.connect("codex"); providers.disconnect("codex");
		expect(loginSignal?.aborted).toBe(true);
		finish?.(); await providers.detect();
		expect(providers.connected("codex")).toBe(false);
	});
	it.each(["corrupted", "unreadable"] as const)("falls back from a chat subscription when saved connections are %s", async (failure) => {
		const dir = tempDataDir();
		const file = join(dir, "connections.json");
		const connected = JSON.stringify({ providers: { codex: true } });
		writeFileSync(file, connected);
		let inferenceCalls = 0;
		const providers = await local(async ({ provider, args }) => {
			if (isStatus(args)) return auth(provider);
			inferenceCalls++;
			return completed(provider, "must not infer through a disconnected subscription");
		}, dir);
		const runtime = new OwniRuntime({ dataDir: tempDataDir(), engine: piDurableEngine, localProviders: providers });
		closers.push(() => runtime.close());
		await runtime.registry.createTenant({ id: "default", name: "Default" });
		await runtime.registry.createInstance("default", { id: "agent", name: "Agent", model: FAUX_MODEL, egress: { modelProviders: [FAUX_MODEL.provider, "codex"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		const chat = { channel: "test", threadId: "t" };
		const subscription = { provider: "codex", modelId: "default" };
		await runtime.setChatModel("default", "agent", chat, subscription, "u");
		expect(await runtime.chatModel("default", "agent", chat.channel, chat.threadId)).toEqual(subscription);
		if (failure === "corrupted") writeFileSync(file, "{ not json");
		else {
			// A directory at the file path produces a read error reliably, including
			// privileged test runners where chmod(000) would still permit reads.
			rmSync(file);
			mkdirSync(file);
		}
		expect(await runtime.chatModel("default", "agent", chat.channel, chat.threadId)).toBeUndefined();
		await expect(runtime.setChatModel("default", "agent", chat, subscription, "u")).rejects.toThrow(/model_provider|codex/);
		const reply = new Promise<Reply>((resolve) => runtime.onReply(resolve));
		await runtime.submit({ tenantId: "default", instanceId: "agent", ...chat, userId: "u", text: "hello", messageId: "fallback" });
		expect(await reply).toMatchObject({ status: "answered", model: FAUX_MODEL });
		expect(inferenceCalls).toBe(0);
		rmSync(file, { recursive: true, force: true });
		writeFileSync(file, connected);
		expect(await runtime.chatModel("default", "agent", chat.channel, chat.threadId)).toEqual(subscription);
	});

	it("scopes host access to the configured tenant", async () => {
		const providers = await local();
		const runtime = new OwniRuntime({ dataDir: tempDataDir(), engine: piDurableEngine, localProviders: providers });
		expect(runtime.localProviders("default")).toBe(providers);
		expect(runtime.localProviders("another-tenant")).toBeUndefined();
	});
});

describe("official CLI inference bridge", () => {
	it("rechecks instance egress before tool continuation through OwniRuntime", async () => {
		let calls = 0;
		const providers = await local(async ({ provider, args }) => {
			if (isStatus(args)) return auth(provider);
			calls++;
			return completed(provider, calls === 1 ? "" : "This must not execute", calls === 1 ? [{ name: "revoke", arguments: "{}" }] : []);
		});
		const runtime: OwniRuntime = new OwniRuntime({ dataDir: tempDataDir(), engine: piDurableEngine, localProviders: providers, tools: [{ name: "revoke", description: "Revoke this provider", parameters: { type: "object", properties: {}, additionalProperties: false }, replaySafe: true, execute: async () => { await runtime.registry.setEgress("default", "agent", () => ({ modelProviders: [], channels: ["test"] })); return "Revoked"; } }] });
		closers.push(() => runtime.close());
		await runtime.registry.createTenant({ id: "default", name: "Default" });
		await runtime.registry.createInstance("default", { id: "agent", name: "Agent", model: { provider: "claude-code", modelId: "sonnet" }, egress: { modelProviders: ["claude-code"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		const reply = new Promise<{ status: string }>((resolve) => runtime.onReply(resolve));
		await runtime.submit({ tenantId: "default", instanceId: "agent", channel: "test", threadId: "t", userId: "u", text: "Revoca il provider" });
		expect((await reply).status).toBe("unanswered"); expect(calls).toBe(1);
	});
	it.each(["claude-code", "codex"])("%s keeps the durable transcript and Owni tool continuation", async (provider) => {
		let calls = 0; let executed = 0; const prompts: string[] = [];
		const providers = await local(async (request) => {
			if (isStatus(request.args)) return auth(request.provider);
			prompts.push(request.input ?? ""); calls++;
			return completed(provider, calls === 1 ? "" : "Il risultato è 7", calls === 1 ? [{ name: "add", arguments: '{"n":7}' }] : []);
		});
		const session = await piDurableEngine.open({ storageDir: tempDataDir(), model: { provider, modelId: provider === "codex" ? "default" : "sonnet" }, apiKey: async () => "owni-local-subscription", localProviders: providers, instructions: "Rispondi in italiano", tools: [{ name: "add", description: "Return a number", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, replaySafe: true, execute: async ({ n }) => { executed++; return `risultato ${n}`; } }] });
		closers.push(() => session.close());
		const reply = new Promise<EngineReply>((resolve) => session.onReply(resolve));
		await session.submit("web:test", "somma sette", "idempotent-1");
		expect(await reply).toMatchObject({ status: "answered", text: "Il risultato è 7" });
		expect(calls).toBe(2); expect(executed).toBe(1);
		expect(prompts[1]).toContain("somma sette"); expect(prompts[1]).toContain("toolResult"); expect(prompts[1]).toContain("risultato 7"); expect(prompts[0]).toContain("Rispondi in italiano");
		await session.submit("web:test", "somma sette", "idempotent-1"); await session.idle(); expect(executed).toBe(1); expect(calls).toBe(2);
	});
	it("runs an Owni tool Claude called natively instead of letting it give up", async () => {
		let calls = 0; const seen: unknown[] = [];
		const native = (name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input }] } });
		const providers = await local(async (request) => {
			if (isStatus(request.args)) return auth(request.provider);
			calls++;
			if (calls > 1) return completed("claude-code", "Media: 7");
			const refused = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "<tool_use_error>Error: No such tool available: sum</tool_use_error>" }] } });
			return ok([native("sum", { files: '["a.csv"]', n: 7 }), refused, native("exec", { cmd: "ls" }), refused, completed("claude-code", "Strumenti non disponibili").stdout].join("\n"));
		});
		const session = await piDurableEngine.open({ storageDir: tempDataDir(), model: { provider: "claude-code", modelId: "sonnet" }, apiKey: async () => "owni-local-subscription", localProviders: providers, instructions: "", tools: [{ name: "sum", description: "Sum", parameters: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, n: { type: "number" } }, required: ["files"], additionalProperties: false }, replaySafe: true, execute: async (args) => { seen.push(args); return "7"; } }] });
		closers.push(() => session.close());
		const reply = new Promise<EngineReply>((resolve) => session.onReply(resolve));
		await session.submit("web:test", "media", "native-1");
		expect(await reply).toMatchObject({ status: "answered", text: "Media: 7" });
		expect(seen).toEqual([{ files: ["a.csv"], n: 7 }]); expect(calls).toBe(2);
	});
	it("one-shot calls use the same scoped subscription capability without API keys", async () => {
		const providers = await local(async ({ provider, args }) => isStatus(args) ? auth(provider) : completed(provider, "Sintesi"));
		const client = createPiCompletionClient({ apiKey: async () => undefined, localProviders: providers, assertAllowed: async () => {} });
		expect(await client.complete({ model: { provider: "codex", modelId: "default" }, system: "Sintetizza", user: "Un testo", maxTokens: 100 })).toEqual({ text: "Sintesi", inputTokens: 13, outputTokens: 5 });
	});
	it("passes images to Claude and Codex, disables native tools, and cleans temporary files", async () => {
		const dirs: string[] = [];
		const providers = await local(async (request) => {
			if (isStatus(request.args)) return auth(request.provider);
			dirs.push(request.cwd);
			if (request.provider === "claude-code") {
				expect(request.args[request.args.indexOf("--output-format") + 1]).toBe("stream-json"); expect(request.args).toContain("--verbose"); expect(request.args[request.args.indexOf("--tools") + 1]).toBe(""); expect(request.args).toContain("--strict-mcp-config");
				const input = JSON.parse(request.input ?? "") as { message: { content: { type: string }[] } };
				expect(input.message.content[1]?.type).toBe("image");
			} else {
				expect(request.args).toContain("features.shell_tool=false"); expect(request.args).toContain("--ignore-user-config"); expect(request.args[request.args.indexOf("--sandbox") + 1]).toBe("read-only");
				expect(await readFile(request.args[request.args.indexOf("--image") + 1] as string)).toEqual(Buffer.from("image"));
				const catalog = JSON.parse(await readFile(join(request.cwd, "models.json"), "utf8")) as { models: Record<string, unknown>[] };
				expect(catalog.models[0]).toMatchObject({ shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, tool_mode: "direct" });
			}
			return completed(request.provider, "Vedo un'immagine");
		});
		for (const id of ["claude-code", "codex"]) {
			const models = createModels({ credentials: { read: async () => ({ type: "api_key", key: "owni-local-subscription" }), list: async () => [], modify: async () => undefined, delete: async () => {} }, authContext: { env: async () => undefined, fileExists: async () => false } }); models.setProvider(localCliProvider(id, providers));
			const result = await models.complete(models.getModels(id)[0]!, { messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Cosa vedi?" }, { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") }] }] });
			expect(result.stopReason).toBe("stop");
		}
		for (const dir of dirs) await expect(access(dir)).rejects.toThrow();
	});
	it("catalog hardening drops account identity and removes all executable model capabilities", () => {
		const selected = codexInferenceCatalog("default", { identity: { token: "not-catalog-data" }, models: [{ slug: "gpt-future", priority: 1, shell_type: "unified_exec", apply_patch_tool_type: "freeform", experimental_supported_tools: ["clock"], tool_mode: "code_mode_only" }] });
		expect(selected).toMatchObject({ slug: "gpt-future", shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, tool_mode: "direct" });
		expect(JSON.stringify(selected)).not.toContain("not-catalog-data");
	});
	it("rejects malformed structured replies and tool names not offered by Owni without exposing raw output", async () => {
		const providers = await local(async ({ provider, args }) => isStatus(args) ? auth(provider) : completed(provider, "", [{ name: "exec", arguments: '{"key":"never-show-this"}' }]));
		const client = createPiCompletionClient({ apiKey: async () => undefined, localProviders: providers, assertAllowed: async () => {} });
		await expect(client.complete({ model: { provider: "claude-code", modelId: "sonnet" }, system: "", user: "Ciao", maxTokens: 10 })).rejects.toThrow(/non valida/);
	});
	it("has no ambient auth when constructed without the local capability", async () => {
		const client = createPiCompletionClient({ apiKey: async () => "owni-local-subscription", assertAllowed: async () => {} });
		await expect(client.complete({ model: { provider: "claude-code", modelId: "sonnet" }, system: "", user: "Ciao", maxTokens: 10 })).rejects.toThrow();
	});
	it("cancels inference and terminates it on local provider shutdown", async () => {
		let started = false; let signal: AbortSignal | undefined;
		const providers = await local(async (request) => {
			if (isStatus(request.args)) return auth(request.provider);
			started = true; signal = request.signal;
			return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new LocalProviderError("Operazione annullata")), { once: true }));
		});
		const client = createPiCompletionClient({ apiKey: async () => undefined, localProviders: providers, assertAllowed: async () => {} });
		const done = client.complete({ model: { provider: "codex", modelId: "default" }, system: "", user: "Ciao", maxTokens: 10 }).catch((e: unknown) => e);
		await waitFor(() => started); await providers.close(); expect(signal?.aborted).toBe(true); expect(await done).toBeInstanceOf(Error);
	});
});

async function boot(localEnabled: boolean, dataDir = tempDataDir(), runner?: CliRunner) {
	const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", ...(localEnabled ? { OWNI_LOCAL_PROVIDERS: "1" } : {}) });
	let probes = 0;
	const owni: RunningOwni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { localProviderRunner: async (request) => { probes++; return runner === undefined ? isStatus(request.args) ? auth(request.provider) : completed(request.provider, "Ciao") : runner(request); }, schedulerIntervalMs: 3_600_000, log: () => {} });
	closers.push(() => owni.stop());
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: owni.ownerLink?.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	const api = async (path: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: res.status, body: await res.json() as Record<string, unknown> };
	};
	return { owni, api, dataDir, probes: () => probes };
}

describe("subscription settings", () => {
	it.each(["detect", "connect", "browser-login"])("activates the pending first model after same-session %s without replacing later manual choices", async (method) => {
		const authenticated = new Set<string>();
		let finishLogin: (() => void) | undefined;
		const { owni, api } = await boot(true, tempDataDir(), async ({ provider, args }) => {
			if (isStatus(args)) return authenticated.has(provider) ? auth(provider) : ok(provider === "claude-code" ? '{"loggedIn":false}' : "Not logged in");
			if (args.includes("login")) return new Promise((resolve) => { finishLogin = () => { authenticated.add(provider); resolve(ok("")); }; });
			return completed(provider, "Ciao");
		});
		expect((await owni.runtime.registry.getInstance("default", "owni")).model.provider).toBe("faux");
		if (method !== "browser-login") authenticated.add("claude-code");
		expect((await api(method === "detect" ? "/api/providers/detect" : "/api/providers/claude-code/connect", "POST")).status).toBe(200);
		if (method === "browser-login") {
			expect(owni.runtime.localProviders("default")?.list().find((p) => p.id === "claude-code")?.status).toBe("connecting");
			finishLogin?.();
			await waitFor(() => owni.runtime.localProviders("default")?.list().find((p) => p.id === "claude-code")?.status === "connected");
		}
		expect((await owni.runtime.registry.getInstance("default", "owni")).model).toEqual({ provider: "claude-code", modelId: "sonnet" });
		expect((await api("/api/instances/owni/model", "PUT", { provider: "openai", modelId: "gpt-5.5", apiKey: "saved-api-key" })).status).toBe(200);
		authenticated.add("codex");
		expect((await api("/api/providers/codex/connect", "POST")).status).toBe(200);
		await api("/api/providers/detect", "POST");
		expect((await owni.runtime.registry.getInstance("default", "owni")).model).toEqual({ provider: "openai", modelId: "gpt-5.5" });
	});
	it("remote/default deployments never inspect or expose the machine owner's accounts", async () => {
		const { api, probes } = await boot(false);
		const list = await api("/api/providers"); expect(list.body.localEnabled).toBe(false); expect(JSON.stringify(list.body)).not.toContain("claude-code"); expect(probes()).toBe(0);
		expect((await api("/api/providers/codex/connect", "POST")).status).toBe(404);
		expect((await api("/api/models/codex")).status).toBe(404);
	});
	it("detects immediately, selects once, changes the default, and persists disconnect", async () => {
		const { owni, api } = await boot(true);
		expect((await owni.runtime.registry.getInstance("default", "owni")).model).toEqual({ provider: "claude-code", modelId: "sonnet" });
		const listed = await api("/api/providers"); expect(listed.body.localEnabled).toBe(true); expect(JSON.stringify(listed.body)).not.toMatch(/private@example|never-show-this/);
		expect((await api("/api/instances/owni/model", "PUT", { provider: "codex", modelId: "default" })).status).toBe(200);
		expect((await api("/api/providers/claude-code", "DELETE")).status).toBe(200);
		await api("/api/providers/detect", "POST"); expect(owni.runtime.localProviders("default")?.connected("claude-code")).toBe(false);
		expect((await api("/api/providers/codex", "DELETE")).status).toBe(409);
		expect((await api("/api/instances/owni/model", "PUT", { provider: "claude-code", modelId: "sonnet" })).status).toBe(409);
		expect((await api("/api/providers/claude-code/connect", "POST")).status).toBe(200);
		expect((await api("/api/instances/owni/model", "PUT", { provider: "claude-code", modelId: "opus", apiKey: "never-save-this" })).status).toBe(400);
	});
});
