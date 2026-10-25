import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { type AllowedUsers, type OwniTool, OwniRuntime, type EgressPolicy, type Reply } from "../src/core/index.ts";

export function tempDataDir(): string {
	return mkdtempSync(join(tmpdir(), "owni-test-"));
}

export const FAUX_MODEL = { provider: "faux", modelId: "owni-dev" } as const;

/** A runtime with one tenant and one instance on the local deterministic model. */
export async function runtimeWithInstance(options: {
	dataDir?: string;
	tenant?: string;
	instance?: string;
	egress?: EgressPolicy;
	allowedUsers?: AllowedUsers;
	tools?: OwniTool[];
	/** Tools that need the runtime itself (its stores), built when the instance opens. */
	toolsFor?: (runtime: OwniRuntime) => OwniTool[];
}): Promise<{ runtime: OwniRuntime; dataDir: string; replies: Reply[] }> {
	const dataDir = options.dataDir ?? tempDataDir();
	const toolsFor = options.toolsFor;
	const runtime: OwniRuntime = new OwniRuntime({ dataDir, engine: piDurableEngine, tools: toolsFor === undefined ? (options.tools ?? []) : async () => toolsFor(runtime) });
	const tenant = options.tenant ?? "acme";
	const instance = options.instance ?? "ops";
	await runtime.registry.createTenant({ id: tenant, name: tenant });
	await runtime.registry.createInstance(tenant, {
		id: instance,
		name: instance,
		model: FAUX_MODEL,
		egress: options.egress ?? { modelProviders: ["faux"], channels: ["test"] },
		// The users the tests send as: "u" on the test channel, Telegram user 7 (see textUpdate).
		allowedUsers: options.allowedUsers ?? { test: ["u"], telegram: ["7"] },
	});
	const replies: Reply[] = [];
	runtime.onReply((reply) => replies.push(reply));
	return { runtime, dataDir, replies };
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Pictures as far as their first bytes go: nobody decodes them on the way to the model. */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

/** The registers are deferred (ADR 0100): load them first, as the model does. */
export async function loadTools(reply: (text: string) => Promise<string>, ...names: string[]): Promise<string> {
	return reply(`/tool tool_search ${JSON.stringify({ query: names.join(" ") })}`);
}
