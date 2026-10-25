/**
 * Child process for test/crash-resume.test.ts.
 *
 *   crash-worker.ts start  <dataDir> <effectsFile>   submit "conta fino a 6" and keep running
 *   crash-worker.ts resume <dataDir> <effectsFile>   reopen the same storage, resume, print the reply, exit
 *
 * Every executed step appends "<pid> <step>" to effectsFile: the tool's side effect.
 * Lines on stdout: CHECKPOINT <n>, RESUMED <pending>, REPLY <json>.
 */
import { appendFileSync } from "node:fs";
import { piDurableEngine } from "../../src/core/adapters/pi-durable.ts";
import { OwniRuntime, createSlowCounter, NotFound } from "../../src/core/index.ts";

const [mode, dataDir, effectsFile] = process.argv.slice(2) as [string, string, string];

const runtime = new OwniRuntime({
	dataDir,
	engine: piDurableEngine,
	tools: [
		createSlowCounter({
			stepMs: 300,
			onStep: (step) => appendFileSync(effectsFile, `${process.pid} ${step}\n`),
			onCheckpoint: (step) => console.log(`CHECKPOINT ${step}`),
		}),
	],
});

runtime.onReply((reply) => {
	console.log(`REPLY ${JSON.stringify(reply)}`);
	void runtime.close().then(() => process.exit(0));
});

if (mode === "start") {
	try {
		await runtime.registry.getInstance("acme", "ops");
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createTenant({ id: "acme", name: "Acme" });
		await runtime.registry.createInstance("acme", {
			id: "ops",
			name: "Ops",
			model: { provider: "faux", modelId: "owni-dev" },
			egress: { modelProviders: ["faux"], channels: ["test"] },
			allowedUsers: { test: ["u1"] },
		});
	}
	await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u1", text: "conta fino a 6", messageId: "m1" });
} else {
	const { pending } = await runtime.resume("acme", "ops");
	console.log(`RESUMED ${pending}`);
}

// Keep the process alive until the reply arrives or the parent kills it.
setInterval(() => {}, 1000);
