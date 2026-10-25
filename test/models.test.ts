import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { createProvider, providerModels } from "../src/core/adapters/pi-durable-models.ts";
import type { EngineReply, EngineSession } from "../src/core/engine.ts";
import { MODEL_PROVIDERS } from "../src/core/model-providers.ts";
import { modelApiKeySecret } from "../src/core/secrets.ts";
import { ConfigError, loadOwniConfig, loadTelegramConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

describe("model providers", () => {
	it("every provider Owni offers is built by the adapter and has its default model", () => {
		for (const p of MODEL_PROVIDERS) {
			expect(createProvider(p.id).id).toBe(p.id);
			expect(providerModels(p.id).map((m) => m.id)).toContain(p.defaultModel);
		}
		expect(new Set(MODEL_PROVIDERS.map((p) => p.id)).size).toBe(MODEL_PROVIDERS.length);
		expect(new Set(MODEL_PROVIDERS.map((p) => p.keyEnv)).size).toBe(MODEL_PROVIDERS.length);
	});

	it("lists a provider's models as plain data, and refuses a provider it does not offer", () => {
		const claude = providerModels("anthropic").find((m) => m.id === "claude-sonnet-5-5");
		expect(claude).toMatchObject({ name: expect.any(String), images: true, reasoning: expect.any(Boolean), contextWindow: expect.any(Number) });
		expect(claude?.inputUsd).toBeGreaterThan(0);
		expect(providerModels("faux").map((m) => m.id)).toEqual(["owni-dev"]);
		expect(() => providerModels("amazon-bedrock")).toThrow(/Unsupported model provider/);
		expect(() => createProvider("nope")).toThrow(/Unsupported model provider/);
	});
});

describe("an old thread after the model changes", () => {
	const reply = (session: EngineSession) => new Promise<EngineReply>((resolve) => session.onReply(resolve));
	it("answers with the instance's new model, not the one it was started with", async () => {
		const storageDir = tempDataDir();
		const open = (model: { provider: string; modelId: string }) => piDurableEngine.open({ storageDir, model, apiKey: async () => undefined, tools: [] });
		// Started on a provider without a key: it cannot answer.
		let session = await open({ provider: "xai", modelId: "grok-4.7" });
		let next = reply(session);
		await session.submit("web:t1", "ciao");
		expect(await next).toMatchObject({ status: "unanswered" });
		await session.close();
		session = await open({ provider: "faux", modelId: "owni-dev" });
		next = reply(session);
		await session.submit("web:t1", "ancora");
		expect(await next).toMatchObject({ status: "answered", text: expect.stringContaining("ancora") });
		await session.close();
	});
});

describe("model configuration", () => {
	const base = { OWNI_WEB_PORT: "1" };

	it("any offered provider runs Owni with its own key variable and default model", () => {
		expect(() => loadOwniConfig({ ...base, OWNI_MODEL_PROVIDER: "google" })).toThrow(/GEMINI_API_KEY/);
		const config = loadOwniConfig({ ...base, OWNI_MODEL_PROVIDER: "google", GEMINI_API_KEY: "g-key" });
		expect(config).toMatchObject({ modelProvider: "google", modelId: "gemini-3.5-flash" });
		expect(config.modelApiKeys).toEqual({ google: "g-key" });
		expect(loadOwniConfig({ ...base, OWNI_MODEL_PROVIDER: "xai", XAI_API_KEY: "x", OWNI_MODEL_ID: "grok-4.6" }).modelId).toBe("grok-4.6");
		expect(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "t", OWNI_MODEL_PROVIDER: "mistral", MISTRAL_API_KEY: "m" })).toMatchObject({ modelProvider: "mistral", modelId: "mistral-large-latest", modelApiKey: "m" });
	});

	it("collects the key of every provider the operator gave, so the owner can switch", () => {
		const config = loadOwniConfig({ ...base, ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", DEEPSEEK_API_KEY: " ", OWNI_MODEL_ID: "claude-opus-5-5" });
		expect(config.modelApiKeys).toEqual({ anthropic: "a", openrouter: "o" });
		expect(loadOwniConfig({ ...base, OWNI_MODEL_PROVIDER: "faux", XAI_API_KEY: "x" }).modelApiKeys).toEqual({ xai: "x" });
	});

	it("an unknown provider is refused, naming the ones offered", () => {
		expect(() => loadOwniConfig({ ...base, OWNI_MODEL_PROVIDER: "grokk" })).toThrow(ConfigError);
		expect(() => loadOwniConfig({ ...base, OWNI_MODEL_PROVIDER: "grokk" })).toThrow(/anthropic, openai, google, xai.*faux/);
	});
});

const running: RunningOwni[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

async function boot(env: Record<string, string> = {}) {
	const dataDir = tempDataDir();
	const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", ...env });
	const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
	running.push(owni);
	const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
	return { owni, dataDir, base, api: await client(base, owni.ownerLink as string) };
}

async function client(base: string, link: string) {
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	// biome-ignore lint: test
	return async (path: string, method = "GET", body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, { method, headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, ...((await res.json()) as object) };
	};
}

describe("choosing the model from the console", () => {
	it("lists every provider with where its key comes from, and each provider's models", async () => {
		const { api } = await boot({ GEMINI_API_KEY: "server-key" });
		const { model, providers } = await api("/api/instances/owni/model");
		expect(model).toEqual({ provider: "faux", modelId: "owni-dev" });
		for (const p of MODEL_PROVIDERS) expect(providers.map((x: { id: string }) => x.id)).toContain(p.id);
		expect(providers.find((p: { id: string }) => p.id === "google")).toEqual({ id: "google", label: "Google (Gemini)", keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-3.5-flash", key: "server" });
		expect(providers.find((p: { id: string }) => p.id === "xai").key).toBe("missing");
		const { models } = await api("/api/models/xai");
		expect(models.map((m: { id: string }) => m.id)).toContain("grok-4.7");
		expect((await api("/api/models/amazon-bedrock")).status).toBe(404);
	});

	it("switches the instance to another provider with the owner's key, allowed and audited without the key", async () => {
		const { owni, api } = await boot();
		const put = await api("/api/instances/owni/model", "PUT", { provider: "xai", modelId: "grok-4.7", apiKey: "  xai-secret-123  " });
		expect(put).toMatchObject({ status: 200, model: { provider: "xai", modelId: "grok-4.7" } });
		const record = await owni.runtime.registry.getInstance("default", "owni");
		expect(record.model).toEqual({ provider: "xai", modelId: "grok-4.7" });
		// Added to what the owner already allowed: other parts of Owni may use those.
		expect(record.egress.modelProviders).toEqual(["faux", "xai"]);
		expect(await owni.runtime.secrets("default").get(modelApiKeySecret("xai"))).toBe("xai-secret-123");
		const listed = await api("/api/instances/owni/model");
		expect(listed.providers.find((p: { id: string }) => p.id === "xai").key).toBe("saved");
		expect(JSON.stringify(listed)).not.toContain("xai-secret-123");
		const audit = JSON.stringify(await owni.runtime.audit("default").read());
		expect(audit).toContain("instance.model.updated");
		expect(audit).not.toContain("xai-secret-123");
		// A second change on the same provider needs no key again, and allows it once.
		expect((await api("/api/instances/owni/model", "PUT", { provider: "xai", modelId: "grok-4.6" })).status).toBe(200);
		expect((await owni.runtime.registry.getInstance("default", "owni")).egress.modelProviders).toEqual(["faux", "xai"]);
	});

	it("refuses a model the provider does not have, a provider without a key, and the server's own keys", async () => {
		const { owni, api } = await boot({ OPENAI_API_KEY: "server-openai" });
		expect((await api("/api/instances/owni/model", "PUT", { provider: "xai", modelId: "grok-99", apiKey: "k" })).status).toBe(400);
		expect((await api("/api/instances/owni/model", "PUT", { provider: "nope", modelId: "x", apiKey: "k" })).status).toBe(400);
		expect((await api("/api/instances/owni/model", "PUT", { provider: "faux", modelId: "owni-dev" })).status).toBe(400);
		const keyless = await api("/api/instances/owni/model", "PUT", { provider: "mistral", modelId: "mistral-large-latest" });
		expect(keyless).toMatchObject({ status: 400, error: expect.stringContaining("chiave") });
		expect((await api("/api/instances/owni/model", "PUT", { provider: "openai", modelId: "gpt-5.5", apiKey: "mine-0001" })).status).toBe(400);
		for (const apiKey of ["with space", "short", "x".repeat(501)]) expect((await api("/api/instances/owni/model", "PUT", { provider: "xai", modelId: "grok-4.7", apiKey })).status).toBe(400);
		expect((await api("/api/instances/nope/model", "PUT", { provider: "xai", modelId: "grok-4.7", apiKey: "xai-key-0001" })).status).toBe(404);
		expect((await owni.runtime.registry.getInstance("default", "owni")).model.provider).toBe("faux");
		// The server's key is enough on its own.
		expect((await api("/api/instances/owni/model", "PUT", { provider: "openai", modelId: "gpt-5.5" })).status).toBe(200);
		expect(await owni.runtime.secrets("default").get(modelApiKeySecret("openai"))).toBe("server-openai");
		// The server's key is the operator's to take away.
		expect((await api("/api/model-keys/openai", "DELETE")).status).toBe(409);
	});

	it("a key the operator takes out of the environment leaves the account at the next start", async () => {
		const dataDir = tempDataDir();
		const start = async (env: Record<string, string>) => {
			const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", ...env });
			const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 3_600_000, log: () => {} });
			running.push(owni);
			return owni;
		};
		let owni = await start({ OPENROUTER_API_KEY: "or-server-key" });
		await owni.runtime.secrets("default").set(modelApiKeySecret("xai"), "owner-own-key");
		await owni.stop();
		owni = await start({});
		expect(await owni.runtime.secrets("default").get(modelApiKeySecret("openrouter"))).toBeUndefined();
		// The owner's own key stays.
		expect(await owni.runtime.secrets("default").get(modelApiKeySecret("xai"))).toBe("owner-own-key");
	});

	it("removes a saved key only when no instance uses that provider", async () => {
		const { owni, api } = await boot();
		await api("/api/instances/owni/model", "PUT", { provider: "deepseek", modelId: "deepseek-v4-pro", apiKey: "ds-key-0001" });
		expect((await api("/api/model-keys/deepseek", "DELETE")).status).toBe(409);
		await api("/api/instances/owni/model", "PUT", { provider: "groq", modelId: "openai/gpt-oss-120b", apiKey: "gq-key-0001" });
		expect((await api("/api/model-keys/deepseek", "DELETE")).status).toBe(200);
		expect(await owni.runtime.secrets("default").get(modelApiKeySecret("deepseek"))).toBeUndefined();
		expect((await api("/api/model-keys/xai", "DELETE")).status).toBe(404);
	});

	it("is the owner's: a member can neither read nor change the model", async () => {
		const { base, api } = await boot();
		const added = await api("/api/people", "POST", { name: "Giulia" });
		const giulia = await client(base, added.link);
		expect((await giulia("/api/instances/owni/model")).status).toBe(403);
		expect((await giulia("/api/instances/owni/model", "PUT", { provider: "xai", modelId: "grok-4.7", apiKey: "k" })).status).toBe(403);
		expect((await giulia("/api/models/xai")).status).toBe(403);
	});
});
