import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { decideToolProposal, NotAnApprover, OWNER } from "../src/core/approvals.ts";
import { OwniRuntime, type Reply } from "../src/core/index.ts";
import type { ToolProposal } from "../src/core/proposals.ts";
import { createCustomTools } from "../src/core/tools/custom-tools.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

async function setup() {
	const proposed: ToolProposal[] = [];
	const runtime: OwniRuntime = new OwniRuntime({
		dataDir: tempDataDir(),
		engine: piDurableEngine,
		tools: async (r) =>
			createCustomTools({
				store: runtime.proposals(r.tenantId, r.id),
				toolsDir: runtime.customToolsDir(r.tenantId, r.id),
				policy: async () => (await runtime.registry.getInstance(r.tenantId, r.id)).egress,
				onProposed: async (p) => void proposed.push(p),
			}),
	});
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u", "boss"] }, approvers: { test: ["boss"] } });
	const replies: Reply[] = [];
	runtime.onReply((r) => replies.push(r));
	const say = (text: string, id: string) => runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id });
	return { runtime, replies, say, proposed };
}
const texts = (rs: Reply[]) => rs.map((r) => (r.status === "answered" ? r.text : ""));
const PROPOSAL = {
	name: "double",
	description: "Doubles a number",
	parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
	code: "export default async (args) => String(args.x * 2)",
	hosts: [],
};

describe("tools proposti", () => {
	it("a proposed tool is not callable until an approver approves it; then it runs in the sandbox", async () => {
		const h = await setup();
		await h.say(`/tool tool_propose ${JSON.stringify(PROPOSAL)}`, "1");
		await waitFor(() => h.replies.length === 1);
		expect(texts(h.replies)[0]).toMatch(/^Fatto\. Proposta [0-9a-f]{12} \(custom_double\) inviata agli approvatori/);
		expect(h.proposed).toHaveLength(1);
		const id = h.proposed[0]!.id;

		await h.say('/tool custom_double {"x":21}', "2");
		await waitFor(() => h.replies.length === 2);
		expect(texts(h.replies)[1]).toContain("Tool custom_double is not available");

		await expect(decideToolProposal(h.runtime, "acme", "ops", id, "approved", { channel: "test", userId: "u" })).rejects.toThrow(NotAnApprover);
		await decideToolProposal(h.runtime, "acme", "ops", id, "approved", { channel: "test", userId: "boss" });
		await waitFor(() => texts(h.replies).some((t) => t.includes("è stato approvato")));
		expect(h.replies.find((r) => r.status === "answered" && r.text.includes("approvato"))).toMatchObject({ channel: "test", threadId: "t" });

		await h.say('/tool custom_double {"x":21}', "3");
		await waitFor(() => texts(h.replies).includes("Fatto. 42"));
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "tool.approved", proposalId: id, by: "test:boss" }));
		expect(audit).toContainEqual(expect.objectContaining({ type: "user.denied", action: "tool.approved", userId: "u" }));
		await h.runtime.close();
	});

	it("approving a tool with hosts allows tool:<name> in the egress policy; a rejection stays a rejection", async () => {
		const h = await setup();
		const p = await h.runtime.proposals("acme", "ops").propose({ ...PROPOSAL, name: "meteo", hosts: ["api.open-meteo.com"] });
		await decideToolProposal(h.runtime, "acme", "ops", p.id, "approved", OWNER);
		expect((await h.runtime.registry.getInstance("acme", "ops")).egress.connectors).toEqual(["tool:meteo"]);
		const q = await h.runtime.proposals("acme", "ops").propose({ ...PROPOSAL, name: "other" });
		await decideToolProposal(h.runtime, "acme", "ops", q.id, "rejected", OWNER);
		const again = await decideToolProposal(h.runtime, "acme", "ops", q.id, "approved", OWNER);
		expect(again.status).toBe("rejected");
		await h.runtime.close();
	});

	it("the most recently approved version of a name is the one that runs", async () => {
		const h = await setup();
		const store = h.runtime.proposals("acme", "ops");
		const older = await store.propose({ ...PROPOSAL, code: "export default async () => 'old'" }, new Date("2026-10-15T08:00:00Z"));
		const newer = await store.propose({ ...PROPOSAL, code: "export default async () => 'new'" }, new Date("2026-10-15T09:00:00Z"));
		await store.decide(newer.id, "approved", OWNER, new Date("2026-10-15T10:00:00Z"));
		await store.decide(older.id, "approved", OWNER, new Date("2026-10-15T11:00:00Z"));
		expect((await store.approved()).map((p) => p.id)).toEqual([older.id]);
		const [a, b] = await Promise.all([store.decide((await store.propose({ ...PROPOSAL, name: "race" })).id, "approved", OWNER), Promise.resolve()]);
		expect(a.changed).toBe(true);
		void b;
		await h.runtime.close();
	});

	it("rejects proposals it cannot run safely", async () => {
		const h = await setup();
		const store = h.runtime.proposals("acme", "ops");
		await expect(store.propose({ ...PROPOSAL, name: "Bad-Name" })).rejects.toThrow("Name");
		await expect(store.propose({ ...PROPOSAL, hosts: ["https://api.example.com/x"] })).rejects.toThrow("Not host names");
		await expect(store.propose({ ...PROPOSAL, code: "module.exports = 1" })).rejects.toThrow("default export");
		await h.runtime.close();
	});
});
