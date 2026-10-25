import { OwniRuntime } from "../../src/core/runtime.ts";
import { piDurableEngine } from "../../src/core/adapters/pi-durable.ts";
import type { DurableEngine } from "../../src/core/engine.ts";
const dataDir = process.argv[2]!;
const mode = process.argv[3] ?? "stop";
let began!: () => void;
const started = new Promise<void>((resolve) => { began = resolve; });
const engine: DurableEngine = { async open(options) {
	const session = await piDurableEngine.open(options);
	return new Proxy(session, { get(target, key) {
		// Runtime has persisted Stop intent, but Pi has not received abort when the parent kills us.
		if (key === "submit" && mode === "admission") return async (...args: Parameters<typeof session.submit>) => { await session.submit(...args); await new Promise(() => {}); };
		if (key === "stop") return async () => { console.log("STOP_INTENT"); await new Promise(() => {}); };
		const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
	} });
} };
const runtime = new OwniRuntime({ dataDir, engine, tools: [{ name: "slow", description: "held", replaySafe: true, parameters: { type: "object", properties: {} }, async execute(_args, ctx) { began(); await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })); return "stopped"; } }] });
await runtime.registry.createTenant({ id: "acme", name: "Acme" });
await runtime.registry.createInstance("acme", { id: "ops", name: "Ops", model: { provider: "faux", modelId: "owni-dev" }, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
setInterval(() => {}, 1_000);
if (mode === "admission") runtime.onRunEvent((event) => { if (event.run.status === "succeeded") console.log("ADMITTED_OUTCOME"); });
await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "one", userId: "u", text: mode === "admission" ? "hello" : "/tool slow {}", messageId: "first" });
await started;
await runtime.stopConversation("acme", "ops", { channel: "test", threadId: "one" });
