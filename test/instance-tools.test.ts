import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, createSlowCounter, type InstanceRecord, type ToolSet } from "../src/core/index.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const ask = (instanceId: string, messageId: string) => ({ tenantId: "acme", instanceId, channel: "test", threadId: "t", userId: "u", text: "conta fino a 2", messageId });

async function setup(tools: (record: InstanceRecord) => Promise<ToolSet>) {
	const runtime = new OwniRuntime({ dataDir: tempDataDir(), engine: piDurableEngine, tools });
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	for (const id of ["a", "b"]) {
		await runtime.registry.createInstance("acme", { id, name: id, model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
	}
	const replies: Record<string, string[]> = { a: [], b: [] };
	runtime.onReply((r) => replies[r.instanceId]?.push(r.status === "answered" ? r.text : r.status === "unanswered" ? r.reason : r.status === "file" ? r.path : r.emoji));
	return { runtime, replies };
}

describe("tools per instance", () => {
	it("each instance gets the tools computed from its own record", async () => {
		const { runtime, replies } = await setup(async (record) => (record.id === "a" ? [createSlowCounter({ stepMs: 1 })] : []));
		await runtime.submit(ask("a", "1"));
		await runtime.submit(ask("b", "1"));
		await waitFor(() => replies.a!.length === 1 && replies.b!.length === 1);
		expect(replies.a![0]).toBe("Fatto. Ho contato fino a 2.");
		expect(replies.b![0]).not.toContain("Ho contato");
		await runtime.close();
	});

	it("messages submitted during a reopen wait for the new instance; two reopens queue", async () => {
		const { runtime, replies } = await setup(async () => [createSlowCounter({ stepMs: 1 })]);
		await runtime.openInstance("acme", "a");
		const [first, second, submitted] = await Promise.allSettled([runtime.reopen("acme", "a"), runtime.reopen("acme", "a"), runtime.submit(ask("a", "during"))]);
		expect([first.status, second.status, submitted.status]).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
		await waitFor(() => replies.a!.includes("Fatto. Ho contato fino a 2."));
		await runtime.close();
	});

	it("what a tool set holds open is released when its instance closes or reopens", async () => {
		const closed: string[] = [];
		const { runtime } = await setup(async (record) => ({ tools: [], close: async () => void closed.push(record.id) }));
		await runtime.openInstance("acme", "a");
		await runtime.reopen("acme", "a");
		expect(closed).toEqual(["a"]);
		await runtime.close();
		expect(closed).toEqual(["a", "a"]);
	});

	it("reopen applies a changed tool list; the instance keeps its conversations", async () => {
		let enabled = false;
		const { runtime, replies } = await setup(async () => (enabled ? [createSlowCounter({ stepMs: 1 })] : []));
		await runtime.submit(ask("b", "1"));
		await waitFor(() => replies.b!.length === 1);
		expect(replies.b![0]).not.toContain("Ho contato");
		enabled = true;
		// No channel confirmed the first reply: reopen hands it out again, like a restart would.
		expect(await runtime.reopen("acme", "b")).toMatchObject({ undelivered: 1 });
		await runtime.submit(ask("b", "2"));
		await waitFor(() => replies.b!.includes("Fatto. Ho contato fino a 2."));
		await runtime.close();
	});
});
