import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { relayAgentAnswer } from "../src/core/agent-messages.ts";
import { OwniRuntime, NotFound, type Reply } from "../src/core/index.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

describe("deleting an agente (ADR 0046)", () => {
	it("closes the open agente, removes everything it kept, and leaves the ID free", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		const create = () => runtime.registry.createInstance("acme", { id: "vendite", name: "Vendite", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		await create();
		await runtime.registry.createInstance("acme", { id: "altro", name: "Altro", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		const replies: Reply[] = [];
		runtime.onReply((reply) => replies.push(reply));
		await runtime.submit({ tenantId: "acme", instanceId: "vendite", channel: "test", threadId: "1", userId: "u", text: "ricordami il listino" });
		await waitFor(() => replies.length === 1);
		await runtime.workspace("acme", "vendite").write("listino.txt", new TextEncoder().encode("prezzi"));
		const dir = join(dataDir, "tenants", "acme", "instances", "vendite");
		expect(existsSync(join(dir, "engine"))).toBe(true);

		await runtime.removeInstance("acme", "vendite");

		expect(existsSync(dir)).toBe(false);
		// Nothing left aside either: the whole folder went.
		expect(readdirSync(join(dataDir, "tenants", "acme"))).not.toContain("removed");
		await expect(runtime.registry.getInstance("acme", "vendite")).rejects.toBeInstanceOf(NotFound);
		await expect(runtime.submit({ tenantId: "acme", instanceId: "vendite", channel: "test", threadId: "1", userId: "u", text: "ci sei?" })).rejects.toBeInstanceOf(NotFound);
		expect((await runtime.registry.listInstances("acme")).map((r) => r.id)).toEqual(["altro"]);
		const audit = await runtime.audit("acme").read();
		expect(audit.find((e) => e.type === "instance.deleted")).toMatchObject({ instanceId: "vendite", name: "Vendite" });
		await expect(runtime.removeInstance("acme", "vendite")).rejects.toBeInstanceOf(NotFound);

		// The same ID again is a new agente: nothing of the old one comes back.
		await create();
		expect(await runtime.workspace("acme", "vendite").stat("listino.txt")).toBeUndefined();
		await runtime.submit({ tenantId: "acme", instanceId: "vendite", channel: "test", threadId: "2", userId: "u", text: "nuovo" });
		await waitFor(() => replies.length === 2);
		await runtime.close();
	});

	it("late writers after the deletion do not break the list nor reach a new agente with the same ID", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		const create = (id: string) => runtime.registry.createInstance("acme", { id, name: id, model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		await create("vendite");
		await create("ricerca");
		const schedules = runtime.schedules("acme", "vendite");
		const task = await schedules.create({ instruction: "x", when: { at: new Date(Date.now() + 60_000).toISOString() }, thread: { channel: "test", threadId: "1" } } as never);
		await runtime.removeInstance("acme", "vendite");
		// A task that was running finishes: nothing is written back.
		await schedules.advance(task, task.nextRunAt as string, new Date());
		expect(existsSync(join(dataDir, "tenants", "acme", "instances", "vendite"))).toBe(false);
		// A colleague's answer with a file: refused before the file is written.
		const answer = { to: "vendite", origin: { channel: "test", threadId: "1" }, file: { name: "a.txt", data: new Uint8Array([1]) }, key: "k" };
		await expect(relayAgentAnswer(runtime, "acme", "ricerca", answer)).rejects.toBeInstanceOf(NotFound);
		expect(existsSync(join(dataDir, "tenants", "acme", "instances", "vendite"))).toBe(false);
		// Whatever else puts files back: not an agente, and not inherited.
		await runtime.workspace("acme", "vendite").write("rimasto.txt", "x");
		expect((await runtime.registry.listInstances("acme")).map((r) => r.id)).toEqual(["ricerca"]);
		await create("vendite");
		expect(await runtime.workspace("acme", "vendite").stat("rimasto.txt")).toBeUndefined();
		await runtime.close();
	});

	it("nothing reopens an agente while it is being deleted", async () => {
		const dataDir = tempDataDir();
		const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "vendite", name: "Vendite", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
		await runtime.openInstance("acme", "vendite");
		const removing = runtime.removeInstance("acme", "vendite");
		await expect(runtime.reopen("acme", "vendite")).rejects.toBeInstanceOf(NotFound);
		await expect(runtime.removeInstance("acme", "vendite")).rejects.toBeInstanceOf(NotFound);
		await removing;
		expect(existsSync(join(dataDir, "tenants", "acme", "instances", "vendite"))).toBe(false);
		await runtime.close();
	});
});
