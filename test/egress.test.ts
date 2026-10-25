import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, EgressDenied, modelApiKeySecret, type Reply } from "../src/core/index.ts";
import { FAUX_MODEL, runtimeWithInstance, tempDataDir, waitFor } from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("egress policy", () => {
	it("denies everything by default: an instance created without a policy cannot reach any model", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "Acme" });
		const instance = await runtime.registry.createInstance("acme", { id: "ops", name: "Ops", model: FAUX_MODEL });
		expect(instance.egress).toEqual({ modelProviders: [], channels: [] });

		await expect(runtime.openInstance("acme", "ops")).rejects.toThrow(EgressDenied);
		await expect(runtime.openInstance("acme", "ops")).rejects.toMatchObject({ kind: "model_provider", target: "faux" });
		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "egress.denied", kind: "model_provider", target: "faux" }));
	});

	it("denies a model provider that is not the one explicitly allowed", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "Acme" });
		await runtime.registry.createInstance("acme", {
			id: "ops",
			name: "Ops",
			model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
			egress: { modelProviders: ["faux"], channels: ["telegram"] },
		});
		await expect(runtime.openInstance("acme", "ops")).rejects.toMatchObject({ kind: "model_provider", target: "anthropic" });
	});

	it("denies channels that are not explicitly allowed, before anything reaches the engine", async () => {
		const { runtime, replies } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: [] } });
		const message = { tenantId: "acme", instanceId: "ops", channel: "telegram", threadId: "1", userId: "u", text: "ciao" };
		await expect(runtime.submit(message)).rejects.toMatchObject({ name: "EgressDenied", kind: "channel", target: "telegram" });

		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "egress.denied", kind: "channel", target: "telegram" }));
		expect(audit.some((e) => e.type === "message.received")).toBe(false);
		expect(replies).toEqual([]);
		await runtime.close();
	});

	it("allowed traffic makes no network calls when the allowed model is local", async () => {
		const fetchSpy = vi.fn(async () => {
			throw new Error("network is not allowed in this test");
		});
		vi.stubGlobal("fetch", fetchSpy);
		const { runtime, replies } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["test"] } });
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "1", userId: "u", text: "ciao" });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ status: "answered" });
		expect(fetchSpy).not.toHaveBeenCalled();
		await runtime.close();
	});
});

describe("model credentials", () => {
	it("never uses ambient Anthropic credentials (API key or workload federation) when the tenant has no key", async () => {
		const dir = tempDataDir();
		const tokenFile = join(dir, "identity-token");
		writeFileSync(tokenFile, "host-identity-token");
		vi.stubEnv("ANTHROPIC_API_KEY", "host-api-key");
		vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_host");
		vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "org_host");
		vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", tokenFile);
		// A non-retryable error: the request is observed, then the run fails fast.
		const requests: { url: string; apiKey: string | null }[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push({ url: request.url, apiKey: request.headers.get("x-api-key") });
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "blocked in test" } }, { status: 400 });
		}));

		const runtime = new OwniRuntime({ dataDir: dir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "Acme" });
		await runtime.registry.createInstance("acme", {
			id: "ops",
			name: "Ops",
			model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
			egress: { modelProviders: ["anthropic"], channels: ["test"] },
			allowedUsers: { test: ["u"] },
		});
		const replies: Reply[] = [];
		runtime.onReply((reply) => replies.push(reply));

		// No tenant key: nothing leaves, whatever the host environment holds.
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "1", userId: "u", text: "ciao" });
		await waitFor(() => replies.length === 1, 20_000);
		expect(replies[0]).toMatchObject({ status: "unanswered" });
		expect(requests).toEqual([]);

		// With a tenant key, the request goes out with that key and nothing else.
		await runtime.secrets("acme").set(modelApiKeySecret("anthropic"), "tenant-api-key");
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "2", userId: "u", text: "ciao" });
		await waitFor(() => replies.length === 2, 20_000);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((r) => r.url.startsWith("https://api.anthropic.com/") && r.apiKey === "tenant-api-key")).toBe(true);
		await runtime.close();
	});
});

describe("egress policy changed while the instance is open", () => {
	it("a reply goes out on a channel allowed after the instance opened, and not on one taken away", async () => {
		const { runtime, replies } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"], other: ["u"] } });
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text: "uno", messageId: "1" });
		await waitFor(() => replies.length === 1);
		// Opened: now the policy changes on disk, as the console does, without a reopen.
		await runtime.registry.setEgress("acme", "ops", { modelProviders: ["faux"], channels: ["test", "other"] });
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "other", threadId: "t2", userId: "u", text: "due", messageId: "2" });
		await waitFor(() => replies.some((r) => r.channel === "other"));
		await runtime.registry.setEgress("acme", "ops", { modelProviders: ["faux"], channels: ["other"] });
		await expect(runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text: "tre", messageId: "3" })).rejects.toThrow(EgressDenied);
		await runtime.close();
	});
});

