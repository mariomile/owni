/**
 * An agente written to for the person (ADR 0134): outside the organigramma's links, the core lets in
 * a colleague's message only for a person who may talk to this agente themselves, and the answer
 * goes back without the agenti's channel among its egress.
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { UserNotAllowed } from "../src/core/errors.ts";
import type { OwniRuntime } from "../src/core/index.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const runtimes: OwniRuntime[] = [];
afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
	// Not linked to anyone: no agente may write to it, and the agenti's channel is not in its egress.
	const { runtime, dataDir, replies } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
	runtimes.push(runtime);
	dirs.push(dataDir);
	return { runtime, replies };
}

const ask = (forPerson?: { channel: string; userId: string }, messageId = "m1") => ({ tenantId: "acme", instanceId: "ops", channel: "agente", threadId: `owni:test:t${messageId}`, userId: "owni", text: "ciao", messageId, ...(forPerson === undefined ? {} : { forPerson }) });

describe("an agente asked for the person (ADR 0134)", () => {
	it("lets the message in for a person allowed here, and the answer goes back", async () => {
		const { runtime, replies } = await setup();
		await runtime.submit(ask({ channel: "test", userId: "u" }));
		await waitFor(() => replies.some((r) => r.channel === "agente" && r.status === "answered"));
		const audit = await runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "message.received", channel: "agente", userId: "owni", forPerson: "test:u" }));
	});

	it("refuses it without a person, for a stranger, or for a channel the agente does not talk on", async () => {
		const { runtime } = await setup();
		await expect(runtime.submit(ask(undefined, "m1"))).rejects.toBeInstanceOf(UserNotAllowed);
		await expect(runtime.submit(ask({ channel: "test", userId: "x" }, "m2"))).rejects.toBeInstanceOf(UserNotAllowed);
		await runtime.registry.setAllowedUsers("acme", "ops", "telegram", ["7"]);
		await expect(runtime.submit(ask({ channel: "telegram", userId: "7" }, "m3"))).rejects.toBeInstanceOf(UserNotAllowed);
	});

	it("is never a way in for a person on their own channel", async () => {
		const { runtime } = await setup();
		await expect(runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "p", userId: "x", text: "ciao", messageId: "m1", forPerson: { channel: "test", userId: "u" } })).rejects.toBeInstanceOf(UserNotAllowed);
	});
});
