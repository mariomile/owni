import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, type DurableEngine, type EngineOpenOptions, modelApiKeySecret, type Reply, tenantId } from "../src/core/index.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

/** Records what the core hands to the engine, without running anything. */
function recordingEngine(opened: EngineOpenOptions[]): DurableEngine {
	return {
		async open(options) {
			opened.push(options);
			return {
				submit: async () => ({ submissionId: "0" }),
				resume: async () => ({ pending: 0 }),
				reattach: async () => false,
				setThreadModel: async () => {},
				threadModel: async () => undefined,
				onReply: () => () => {},
				idle: async () => {},
				close: async () => {},
			};
		},
	};
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((name) => join(dir, name))
		.filter((path) => statSync(path).isFile());
}

describe("tenant isolation", () => {
	it("keeps storage, secrets and audit of two tenants apart", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		for (const tenant of ["acme", "globex"]) {
			await runtime.registry.createTenant({ id: tenant, name: tenant });
			await runtime.registry.createInstance(tenant, { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		}
		await runtime.secrets("acme").set(modelApiKeySecret("anthropic"), "acme-secret-key");
		await runtime.secrets("globex").set(modelApiKeySecret("anthropic"), "globex-secret-key");

		const replies: Reply[] = [];
		runtime.onReply((reply) => replies.push(reply));
		// Same instance ID and same thread ID in both tenants.
		await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "1", userId: "u", text: "acme-confidential-marker" });
		await runtime.submit({ tenantId: "globex", instanceId: "ops", channel: "test", threadId: "1", userId: "u", text: "globex-confidential-marker" });
		await waitFor(() => replies.length === 2);
		await runtime.close();

		// Replies stay in their tenant.
		const byTenant = Object.fromEntries(replies.map((r) => [r.tenantId, r]));
		expect(byTenant.acme).toMatchObject({ status: "answered", text: expect.stringContaining("acme-confidential-marker") });
		expect(byTenant.globex).toMatchObject({ status: "answered", text: expect.stringContaining("globex-confidential-marker") });
		expect(JSON.stringify(byTenant.acme)).not.toContain("globex");

		// Storage: each tenant's directory holds only its own data, its engine storage included.
		const acmeFiles = filesUnder(join(dataDir, "tenants", "acme"));
		const globexFiles = filesUnder(join(dataDir, "tenants", "globex"));
		expect(acmeFiles.some((f) => f.includes(join("instances", "ops", "engine")))).toBe(true);
		const acmeBytes = acmeFiles.map((f) => readFileSync(f).toString("latin1")).join("");
		const globexBytes = globexFiles.map((f) => readFileSync(f).toString("latin1")).join("");
		expect(acmeBytes).toContain("acme-confidential-marker");
		expect(acmeBytes).not.toContain("globex");
		expect(globexBytes).toContain("globex-confidential-marker");
		expect(globexBytes).not.toContain("acme");

		// Secrets: a tenant's store sees only its own.
		expect(await runtime.secrets("acme").get(modelApiKeySecret("anthropic"))).toBe("acme-secret-key");
		expect(await runtime.secrets("globex").get(modelApiKeySecret("anthropic"))).toBe("globex-secret-key");
		expect(await runtime.secrets("acme").names()).toEqual([modelApiKeySecret("anthropic")]);
		expect(statSync(join(dataDir, "tenants", "acme", "secrets.json")).mode & 0o777).toBe(0o600);

		// Audit: each log holds only its tenant's events, and never message text.
		const acmeAudit = await runtime.audit("acme").read();
		const globexAudit = await runtime.audit("globex").read();
		expect(acmeAudit.length).toBeGreaterThan(0);
		expect(acmeAudit.every((e) => e.tenantId === "acme")).toBe(true);
		expect(globexAudit.every((e) => e.tenantId === "globex")).toBe(true);
		expect(JSON.stringify(acmeAudit)).not.toContain("confidential-marker");
	});

	it("hands an instance only its own tenant's model key, and only for allowed providers", async () => {
		const dataDir = tempDataDir();
		const opened: EngineOpenOptions[] = [];
		const runtime = new OwniRuntime({ dataDir, engine: recordingEngine(opened) });
		for (const tenant of ["acme", "globex"]) {
			await runtime.registry.createTenant({ id: tenant, name: tenant });
			await runtime.registry.createInstance(tenant, {
				id: "ops",
				name: "ops",
				model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
				egress: { modelProviders: ["anthropic"], channels: [] },
			});
			await runtime.secrets(tenant).set(modelApiKeySecret("anthropic"), `${tenant}-anthropic-key`);
			await runtime.secrets(tenant).set(modelApiKeySecret("openai"), `${tenant}-openai-key`);
		}
		await runtime.openInstance("acme", "ops");
		await runtime.openInstance("globex", "ops");

		const [acme, globex] = opened as [EngineOpenOptions, EngineOpenOptions];
		expect(await acme.apiKey("anthropic")).toBe("acme-anthropic-key");
		expect(await globex.apiKey("anthropic")).toBe("globex-anthropic-key");
		// A stored key for a provider the policy does not allow is never handed out.
		expect(await acme.apiKey("openai")).toBeUndefined();
		expect(acme.storageDir).not.toBe(globex.storageDir);
		expect(acme.storageDir).toContain(join("tenants", "acme"));
	});

	it("rejects IDs that could escape the tenant directory", () => {
		for (const bad of ["../globex", "acme/../globex", "", ".", "ACME", "a b"]) {
			expect(() => tenantId(bad)).toThrow(/Invalid tenantId/);
		}
	});
});
