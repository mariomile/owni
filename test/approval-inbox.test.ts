import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { ConnectorActionStore } from "../src/core/connector-actions.ts";
import { GoogleActionStore } from "../src/core/google-actions.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { instanceDir } from "../src/core/paths.ts";
import { ProposalStore } from "../src/core/proposals.ts";
import { OwniRuntime } from "../src/core/runtime.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { WebActionStore } from "../src/core/web-actions.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { createWebApp } from "../src/web/server.ts";
import { FAUX_MODEL, tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of closers.splice(0)) await close();
});

async function setup() {
	const dataDir = tempDataDir();
	const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
	await runtime.registry.createTenant({ id: "acme", name: "Acme" });
	const tenantDir = join(dataDir, "tenants", "acme");
	const people = new PeopleStore(tenantDir);
	const owner = await people.add("Owner", "owner");
	const anna = await people.add("Anna", "member");
	const luca = await people.add("Luca", "member");
	const outsider = await people.add("Outsider", "member");
	const dir = (id: string) => instanceDir(dataDir, tenantId("acme"), instanceId(id));
	const channels = new Map<string, WebChannel>();
	for (const id of ["ops", "sales", "hidden"]) {
		await runtime.registry.createInstance("acme", {
			id, name: id.toUpperCase(), model: FAUX_MODEL,
			egress: { modelProviders: ["faux"], channels: ["web"] },
			allowedUsers: { web: id === "hidden" ? [] : [anna.person.id, luca.person.id] },
			// An approver entry alone must never make an otherwise hidden instance visible.
			approvers: { web: [anna.person.id, outsider.person.id] },
		});
		channels.set(id, new WebChannel({ tenantId: "acme", instanceId: id }, dir(id)));
	}
	const server = createWebApp({
		runtime, tenantId: "acme", people, sessions: new SessionStore(tenantDir), channels,
		connectors: (id) => new ConnectorStore(dir(id)), connectorStatus: () => [],
		usage: new UsageLedger(tenantDir), uiDir: join(import.meta.dirname, "..", "src", "web", "ui"),
		secureCookies: false, defaultTimeZone: "Europe/Rome",
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await runtime.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	const as = async (token: string) => {
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token }) });
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return async (path: string, init: RequestInit = {}) => {
			const response = await fetch(`${base}${path}`, { ...init, headers: { cookie, "x-owni": "1", ...(init.headers ?? {}) } });
			return { status: response.status, body: await response.json() as any };
		};
	};
	const seed = async (id: string, personId = anna.person.id) => {
		const proposals = await runtime.proposals("acme", id).propose({ name: "quote_tool", description: "Prepare quote", code: "export default () => 'quote'", parameters: { type: "object" }, hosts: [] });
		const webActions = await runtime.webActions("acme", id).propose({ pageUrl: "https://example.test", form: 0, action: "https://example.test/send", values: { text: "Quote" }, button: 0, shown: [["text", "Quote"]], fingerprint: "form", reason: "Send quote", requester: `web:${personId}` });
		const connectorActions = await runtime.connectorActions("acme", id).propose({ connectorId: "crm", connectorName: "CRM", server: "https://example.test", tool: "write", toolTitle: "Write", args: { text: "Quote" }, reason: "Save quote", destructive: false, requester: `web:${personId}` });
		const googleActions = await runtime.googleActions("acme", id).propose({ kind: "mail.send", personId, account: `${personId}@example.test`, reason: "Send quote", mail: { to: ["customer@example.test"], cc: [], subject: "Quote", body: "Draft" } });
		return { proposals, webActions, connectorActions, googleActions };
	};
	return { runtime, owner, anna, luca, outsider, dir, channels, base, as, seed };
}

const actionSources = ["proposals", "webActions", "connectorActions", "googleActions"] as const;
type Inbox = { groups: { instance: { id: string; name: string; isApprover: boolean } }[]; pendingApprovals: number };
const pendingKeys = (inbox: Inbox) => inbox.groups.flatMap((group) => [
	...actionSources.flatMap((source) => (group as any)[source].filter((item: any) => item.status === "pending").map((item: any) => `${group.instance.id}/${source}/${item.id}`)),
]);

describe("personal approval inbox", () => {
	it("requires person authentication and excludes every instance the person cannot see", async () => {
		const h = await setup();
		await h.seed("hidden", h.outsider.person.id);
		expect((await fetch(`${h.base}/api/approvals`)).status).toBe(401);
		const outsider = await h.as(h.outsider.token);
		expect((await outsider("/api/approvals")).body).toEqual({ groups: [], pendingApprovals: 0 });
		expect((await outsider("/api/console-summary")).body.pendingApprovals).toBe(0);
	});

	it("returns all four source shapes across two agents, with exactly the summary's pending membership regardless of selected agent", async () => {
		const h = await setup();
		await h.seed("ops");
		await h.seed("sales");
		await h.seed("hidden");
		const anna = await h.as(h.anna.token);
		const response = await anna("/api/approvals");
		expect(response.status).toBe(200);
		expect(Object.keys(response.body).sort()).toEqual(["groups", "pendingApprovals"]);
		expect(response.body.groups.map((g: any) => g.instance.id).sort()).toEqual(["ops", "sales"]);
		const expected = [];
		for (const group of response.body.groups) {
			expect(Object.keys(group).sort()).toEqual(["instance", ...actionSources].sort());
			expect(group.instance).toEqual({ id: group.instance.id, name: group.instance.id.toUpperCase(), isApprover: true });
			for (const [source, route, key] of [
				["proposals", "proposals", "proposals"], ["webActions", "web-actions", "actions"],
				["connectorActions", "connector-actions", "actions"],
				["googleActions", "google-actions", "actions"],
			] as const) {
				const direct = (await anna(`/api/instances/${group.instance.id}/${route}`)).body[key];
				expect(group[source]).toEqual(direct);
				expected.push(...direct.map((item: any) => `${group.instance.id}/${source}/${item.id}`));
			}
		}
		expect(pendingKeys(response.body).sort()).toEqual(expected.sort());
		expect(response.body.pendingApprovals).toBe(8);
		expect((await anna("/api/console-summary")).body.pendingApprovals).toBe(pendingKeys(response.body).length);
		for (const selected of ["ops", "sales", "hidden", "missing"]) {
			expect((await anna(`/api/approvals?instance=${selected}`)).body).toEqual(response.body);
		}
	});

	it("limits nonapprovers to their own web/MCP and Google requests, preserving visible decided history", async () => {
		const h = await setup();
		for (const id of ["ops", "sales", "hidden"]) {
			await h.seed(id);
			await h.runtime.webActions("acme", id).propose({ pageUrl: "https://example.test", form: 0, action: "https://example.test/send", values: {}, button: 0, shown: [], fingerprint: "form", reason: "Luca request", requester: `web:${h.luca.person.id}` });
			await h.runtime.connectorActions("acme", id).propose({ connectorId: "crm", connectorName: "CRM", server: "https://example.test", tool: "write", toolTitle: "Write", args: {}, reason: "Luca request", destructive: false, requester: `web:${h.luca.person.id}` });
			await h.runtime.googleActions("acme", id).propose({ kind: "mail.send", personId: h.luca.person.id, account: "luca@example.test", reason: "Luca mail" });
		}
		const rejected = await h.runtime.webActions("acme", "ops").propose({ pageUrl: "https://example.test", form: 0, action: "https://example.test/send", values: {}, button: 0, shown: [], fingerprint: "form", reason: "Old request", requester: `web:${h.luca.person.id}` });
		await h.runtime.webActions("acme", "ops").decide(rejected.id, "rejected", { channel: "web", userId: h.luca.person.id }, async () => { throw new Error("Must not send"); });
		const luca = await h.as(h.luca.token);
		const inbox = (await luca("/api/approvals")).body;
		expect(inbox.groups.map((g: any) => g.instance.id).sort()).toEqual(["ops", "sales"]);
		for (const group of inbox.groups) {
			expect(group.instance.isApprover).toBe(false);
			expect(group.proposals).toEqual([]);
			expect([...group.webActions, ...group.connectorActions].every((a: any) => a.requester === `web:${h.luca.person.id}`)).toBe(true);
			expect(group.googleActions.every((a: any) => a.personId === h.luca.person.id)).toBe(true);
		}
		expect(inbox.groups.find((g: any) => g.instance.id === "ops").webActions).toContainEqual(expect.objectContaining({ id: rejected.id, status: "rejected" }));
		expect(inbox.pendingApprovals).toBe(6);
		expect((await luca("/api/console-summary")).body.pendingApprovals).toBe(pendingKeys(inbox).length);
		await h.runtime.registry.setAllowedUsers("acme", "sales", "web", []);
		const revoked = (await luca("/api/approvals")).body;
		expect(revoked.groups.map((g: any) => g.instance.id)).toEqual(["ops"]);
		expect(revoked.pendingApprovals).toBe(3);
		expect((await luca("/api/console-summary")).body.pendingApprovals).toBe(3);
	});

	it("lets owners approve without canChat while keeping other people's Google actions and private chats inaccessible", async () => {
		const h = await setup();
		for (const id of ["ops", "sales", "hidden"]) await h.seed(id);
		await h.runtime.googleActions("acme", "sales").propose({ kind: "mail.send", personId: h.owner.person.id, account: "owner@example.test", reason: "Owner mail" });
		const thread = await h.channels.get("ops")!.createThread(h.anna.person.id, "Private conversation");
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances")).body.instances.every((i: any) => i.canChat === false && i.isApprover)).toBe(true);
		const inbox = (await owner("/api/approvals")).body;
		expect(inbox.groups.map((g: any) => g.instance.id).sort()).toEqual(["hidden", "ops", "sales"]);
		expect(inbox.groups.flatMap((g: any) => g.googleActions).map((a: any) => a.personId)).toEqual([h.owner.person.id]);
		expect(inbox.pendingApprovals).toBe(10);
		expect((await owner("/api/console-summary")).body.pendingApprovals).toBe(pendingKeys(inbox).length);
		expect((await owner(`/api/instances/ops/threads/${thread.id}`)).status).toBe(404);
		expect((await owner("/api/instances/ops/threads")).body.threads).toEqual([]);
		expect((await owner("/api/instances/ops/dm", { method: "POST", body: "{}" })).status).toBe(403);
	});

	it("keeps identical IDs separate across sources and agents", async () => {
		const h = await setup();
		const sharedId = "012345abcdef";
		for (const id of ["ops", "sales"]) {
			const seeded = await h.seed(id);
			for (const [source, folder] of [["proposals", "proposals"], ["webActions", "web-actions"], ["connectorActions", "connector-actions"], ["googleActions", "google-actions"]] as const) {
				const item = { ...seeded[source], id: sharedId };
				await writeFile(join(h.dir(id), folder, `${item.id}.json`), JSON.stringify(item));
				await rm(join(h.dir(id), folder, `${seeded[source].id}.json`));
			}
		}
		const anna = await h.as(h.anna.token);
		const inbox = (await anna("/api/approvals")).body;
		expect(pendingKeys(inbox)).toHaveLength(8);
		expect(new Set(pendingKeys(inbox)).size).toBe(8);
		for (const group of inbox.groups) for (const source of actionSources) expect(group[source][0].id).toBe(sharedId);
		expect((await anna("/api/console-summary")).body.pendingApprovals).toBe(8);
	});

	it("retains expired and rejected history without counting it", async () => {
		const h = await setup();
		const seeded = await h.seed("ops");
		await h.runtime.proposals("acme", "ops").decide(seeded.proposals.id, "rejected", { channel: "web", userId: h.anna.person.id });
		const old = new Date(Date.now() - 25 * 3600_000);
		await h.runtime.googleActions("acme", "ops").propose({ kind: "mail.send", personId: h.anna.person.id, account: "anna@example.test", reason: "Expired mail" }, old);
		const anna = await h.as(h.anna.token);
		const inbox = (await anna("/api/approvals")).body;
		const ops = inbox.groups.find((g: any) => g.instance.id === "ops");
		expect(ops.proposals[0].status).toBe("rejected");
		expect(ops.googleActions.map((a: any) => a.status).sort()).toEqual(["expired", "pending"]);
		expect(inbox.pendingApprovals).toBe(3);
		expect((await anna("/api/console-summary")).body.pendingApprovals).toBe(pendingKeys(inbox).length);
	});

	for (const [source, store] of [["proposals", ProposalStore], ["web", WebActionStore], ["MCP", ConnectorActionStore], ["Google", GoogleActionStore]] as const) {
		it(`fails the whole inbox and summary explicitly when ${source} cannot load`, async () => {
			const h = await setup();
			await h.seed("ops");
			const anna = await h.as(h.anna.token);
			vi.spyOn(store.prototype, "list").mockRejectedValue(new Error("Storage unavailable"));
			for (const path of ["/api/approvals", "/api/console-summary"]) {
				const result = await anna(path);
				expect(result.status).toBe(500);
				expect(result.body).toEqual({ error: "Errore interno" });
			}
		});
	}

	it("does not inspect an inaccessible instance's broken stores", async () => {
		const h = await setup();
		await h.seed("ops");
		await mkdir(join(h.dir("hidden"), "google-actions"), { recursive: true });
		await writeFile(join(h.dir("hidden"), "google-actions", "012345abcdef.json"), "invalid JSON");
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/approvals")).body.pendingApprovals).toBe(4);
		expect((await anna("/api/console-summary")).body.pendingApprovals).toBe(4);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/approvals")).status).toBe(500);
		await rename(join(h.dir("hidden"), "google-actions", "012345abcdef.json"), join(h.dir("hidden"), "google-actions", ".ignored"));
		expect((await owner("/api/approvals")).status).toBe(200);
	});
});
