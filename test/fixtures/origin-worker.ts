/**
 * Child process for test/turn-origin.test.ts (ADR 0088).
 *
 *   origin-worker.ts start  <dataDir>   submit a notice that calls origin_probe; the probe never returns
 *   origin-worker.ts resume <dataDir>   reopen the same storage, resume, the probe returns, exit on the reply
 *
 * Lines on stdout: ORIGIN <origin>, RESUMED <pending>, REPLY <json>.
 */
import { piDurableEngine } from "../../src/core/adapters/pi-durable.ts";
import { type OwniTool, OwniRuntime } from "../../src/core/index.ts";

const [mode, dataDir] = process.argv.slice(2) as [string, string];

const probe: OwniTool = {
	name: "origin_probe",
	description: "Says where the turn comes from.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	// Run again after a crash, so the rerun reads the origin again.
	replaySafe: true,
	async execute(_args, ctx) {
		console.log(`ORIGIN ${ctx.origin ?? "none"}`);
		// The first process is killed here, mid-tool.
		if (mode === "start") await new Promise(() => {});
		return `origin ${ctx.origin ?? "none"}`;
	},
};

const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine, tools: [probe] });

runtime.onReply((reply) => {
	console.log(`REPLY ${JSON.stringify(reply)}`);
	void runtime.close().then(() => process.exit(0));
});

if (mode === "start") {
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	await runtime.registry.createInstance("acme", {
		id: "ops",
		name: "Ops",
		model: { provider: "faux", modelId: "owni-dev" },
		egress: { modelProviders: ["faux"], channels: ["test"] },
		allowedUsers: { test: ["u1"] },
	});
	await runtime.submitNotice("acme", "ops", { channel: "test", threadId: "t1", text: "/tool origin_probe {}", messageId: "n1", event: { kind: "test" } });
} else {
	const { pending } = await runtime.resume("acme", "ops");
	console.log(`RESUMED ${pending}`);
}

setInterval(() => {}, 1000);
