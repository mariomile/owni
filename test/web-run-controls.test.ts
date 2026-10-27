import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime } from "../src/core/runtime.ts";
import { createSlowCounter } from "../src/core/tools/slow-counter.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { connectChannel, REPLY_CANCELLED, REPLY_CAPPED } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { createWebApp } from "../src/web/server.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function setup() {
	const dataDir = tempDataDir();
	const dir = join(dataDir, "tenants", "acme");
	const steps: number[] = [];
	const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine, tools: [createSlowCounter({ stepMs: 100, onStep: (step) => { steps.push(step); } })] });
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	const people = new PeopleStore(dir);
	const sessions = new SessionStore(dir);
	const owner = await people.add("Mario", "owner");
	const anna = await people.add("Anna", "member");
	const luca = await people.add("Luca", "member");
	await runtime.registry.createInstance("acme", { id: "ops", name: "Ops", model: FAUX_MODEL, allowedUsers: { web: [anna.person.id, luca.person.id] }, egress: { modelProviders: ["faux"], channels: ["web"] } });
	const instanceDir = join(dir, "instances", "ops");
	const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, instanceDir);
	connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
	const server = createWebApp({ runtime, tenantId: "acme", people, sessions, channels: new Map([["ops", channel]]), connectors: () => new ConnectorStore(instanceDir), connectorStatus: () => [], usage: new UsageLedger(dir), uiDir: join(import.meta.dirname, "../src/web/ui"), secureCookies: false, defaultTimeZone: "Europe/Rome" });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await runtime.close(); });
	const client = async (personId: string) => {
		const session = await sessions.create(personId);
		const headers = { cookie: `owni_session=${session}`, "x-owni": "1" };
		const api = async (path: string, body?: unknown): Promise<{ status: number; [key: string]: any }> => {
			const result = await fetch(`${base}${path}`, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			return { status: result.status, ...await result.json() as Record<string, any> };
		};
		return { api, headers, session };
	};
	return { runtime, channel, owner, anna, luca, client, steps, sessions, base };
}

it("persists visible outcomes and source metadata without exposing another person's conversations to the owner", async () => {
	const s = await setup();
	const a = await s.client(s.anna.person.id);
	const l = await s.client(s.luca.person.id);
	const owner = await s.client(s.owner.person.id);
	const first = await s.channel.createThread(s.anna.person.id, "Anna");
	const other = await s.channel.createThread(s.luca.person.id, "Luca");
	await s.channel.post(first.id, s.anna.person.id, "Ciao");
	await s.channel.post(other.id, s.luca.person.id, "Private");
	await s.runtime.submitScheduled("acme", "ops", { channel: "web", threadId: first.id, text: "Brief", messageId: "brief-once", scheduleId: "schedule-1", onBehalfOf: { channel: "web", userId: s.anna.person.id }, kind: "brief" });
	await (await s.runtime.openInstance("acme", "ops")).idle();
	await expect.poll(async () => (await s.runtime.listRuns("acme", "ops", { channel: "web", threadId: first.id })).find((run) => run.source === "brief")?.delivery).toBe("delivered");
	const history = await a.api("/api/instances/ops/runs");
	expect(history.status).toBe(200);
	expect(history.runs).toHaveLength(2);
	expect(history.runs).toEqual(expect.arrayContaining([expect.objectContaining({ source: "brief", sourceId: "schedule-1", status: "succeeded", delivery: "delivered" })]));
	expect(history.runs.every((run: any) => run.threadId === first.id)).toBe(true);
	expect(history.runs[0]).not.toHaveProperty("userId");
	expect(history.runs[0]).not.toHaveProperty("submissionId");
	expect((await a.api("/api/instances/ops/runs?sources=brief")).runs).toHaveLength(1);
	expect((await a.api("/api/instances/ops/runs?sources=invalid")).status).toBe(400);
	expect((await l.api(`/api/instances/ops/threads/${first.id}/runs`)).status).toBe(404);
	expect((await owner.api(`/api/instances/ops/threads/${first.id}/runs`)).status).toBe(404);
	expect((await owner.api("/api/instances/ops/runs")).runs).toEqual([]);
	await s.runtime.reopen("acme", "ops");
	expect((await a.api("/api/instances/ops/runs")).runs).toHaveLength(2);
});

it("does not count a Stop or spending-cap notice as the first successful conversation", async () => {
	const s = await setup();
	const owner = await s.client(s.owner.person.id);
	const thread = await s.channel.createThread(s.owner.person.id, "Chat");
	await s.channel.send({ tenantId: "acme", instanceId: "ops", channel: "web", threadId: thread.id, text: REPLY_CANCELLED, idempotencyKey: "stop-notice" });
	await s.channel.send({ tenantId: "acme", instanceId: "ops", channel: "web", threadId: thread.id, text: REPLY_CAPPED, idempotencyKey: "cap-notice" });
	expect((await owner.api("/api/instances/ops/setup")).setup.tried).toBe(false);
	await s.channel.send({ tenantId: "acme", instanceId: "ops", channel: "web", threadId: thread.id, text: "La risposta richiesta", idempotencyKey: "answer" });
	expect((await owner.api("/api/instances/ops/setup")).setup.tried).toBe(true);
});

it("reports tool progress before completion and stops only the selected conversation", async () => {
	const s = await setup();
	const a = await s.client(s.anna.person.id);
	const l = await s.client(s.luca.person.id);
	const first = await s.channel.createThread(s.anna.person.id, "Chat");
	const other = await s.channel.createThread(s.luca.person.id, "Chat");
	await s.channel.post(first.id, s.anna.person.id, "conta fino a 100");
	await waitFor(() => s.steps.length >= 1);
	const during = await a.api(`/api/instances/ops/threads/${first.id}/runs`);
	expect(during.runs[0].status).toBe("running");
	expect(during.runs[0].progress.length).toBeGreaterThan(0);
	expect((await l.api(`/api/instances/ops/threads/${first.id}/stop`, {})).status).toBe(404);
	await s.channel.post(other.id, s.luca.person.id, "Ciao");
	const stopped = await a.api(`/api/instances/ops/threads/${first.id}/stop`, {});
	expect(stopped.status).toBe(200);
	expect(stopped.cancelled).toBe(1);
	const steps = s.steps.length;
	await (await s.runtime.openInstance("acme", "ops")).idle();
	expect(s.steps).toHaveLength(steps);
	await expect.poll(async () => (await s.channel.transcript(first.id)).find((entry) => entry.from === "owni")?.text).toBe("Lavoro interrotto su tua richiesta. Le azioni già completate restano.");
	expect((await a.api(`/api/instances/ops/threads/${first.id}/runs`)).runs[0].status).toBe("cancelled");
	expect((await l.api(`/api/instances/ops/threads/${other.id}/runs`)).runs[0].status).toBe("succeeded");
	await s.runtime.reopen("acme", "ops");
	await (await s.runtime.openInstance("acme", "ops")).idle();
	expect(s.steps).toHaveLength(steps);
});

it("delivers live run events only to the owning session and closes them after session revocation", async () => {
	const s = await setup();
	const a = await s.client(s.anna.person.id);
	const first = await s.channel.createThread(s.anna.person.id, "Chat");
	const other = await s.channel.createThread(s.luca.person.id, "Chat");
	const abort = new AbortController();
	closers.push(async () => { abort.abort(); });
	const response = await fetch(`${s.base}/api/events`, { headers: a.headers, signal: abort.signal });
	let output = "";
	let ended = false;
	const consume = (async () => {
		for await (const chunk of response.body!) output += new TextDecoder().decode(chunk);
		ended = true;
	})().catch(() => { ended = true; });
	await s.channel.post(other.id, s.luca.person.id, "Ciao");
	await s.channel.post(first.id, s.anna.person.id, "conta fino a 100");
	await waitFor(() => output.includes("event: run"));
	expect(output).toContain(first.id);
	expect(output).not.toContain(other.id);
	await s.sessions.end(a.session);
	await waitFor(() => ended);
	await consume;
	await s.runtime.stopConversation("acme", "ops", { channel: "web", threadId: first.id });
});
