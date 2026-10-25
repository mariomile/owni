import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime } from "../src/core/index.ts";
import { instanceDir } from "../src/core/paths.ts";
import { tenantId, instanceId } from "../src/core/ids.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { BoardStore } from "../src/core/board.ts";
import { BoardWork } from "../src/core/board-work.ts";
import { SubjectLedger } from "../src/core/subjects.ts";
import { connectChannel } from "../src/gateway.ts";
import { PeopleStore, SessionStore } from "../src/web/auth.ts";
import { WebChannel } from "../src/web/channel.ts";
import { createWebApp } from "../src/web/server.ts";
import { totp } from "../src/web/totp.ts";
import { FAUX_MODEL, PNG, tempDataDir, waitFor } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function setup(withBoard = false) {
	const dataDir = tempDataDir();
	const runtime = new OwniRuntime({ dataDir, engine: piDurableEngine });
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	const tenantDir = join(dataDir, "tenants", "acme");
	const people = new PeopleStore(tenantDir);
	const owner = await people.add("Mario", "owner");
	const anna = await people.add("Anna", "member");
	const luca = await people.add("Luca", "member");
	const board = new BoardStore(tenantDir);
	const work = new BoardWork({
		store: board,
		agentName: async () => "Ops",
		canChat: async (_agent, id) => id === anna.person.id || id === luca.person.id,
		isOwner: async (id) => id === owner.person.id,
		owners: async () => [owner.person.id],
		personName: async (id) => (await people.get(id))?.name,
		openThread: async () => "unused",
		post: async () => {},
	});
	await runtime.registry.createInstance("acme", {
		id: "ops",
		name: "Ops",
		model: FAUX_MODEL,
		egress: { modelProviders: ["faux"], channels: ["web"] },
		allowedUsers: { web: [anna.person.id, luca.person.id] },
		approvers: { web: [anna.person.id] },
	});
	await runtime.registry.createInstance("acme", { id: "secret", name: "Secret", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["web"] } });
	const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, instanceDir(dataDir, tenantId("acme"), instanceId("ops")));
	connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" });
	const server = createWebApp({
		runtime,
		tenantId: "acme",
		people,
		sessions: new SessionStore(tenantDir),
		channels: new Map([["ops", channel]]),
		connectors: (id) => new ConnectorStore(instanceDir(dataDir, tenantId("acme"), instanceId(id))),
		connectorStatus: () => [],
		usage: new UsageLedger(tenantDir),
		uiDir: join(import.meta.dirname, "..", "src", "web", "ui"),
		secureCookies: false,
		defaultTimeZone: "Europe/Rome",
		...(withBoard ? { board: { store: board, work, subjects: { ledger: new SubjectLedger(tenantDir, "test-key"), agentName: async (id: string) => id } } } : {}),
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
		await runtime.close();
	});
	/** A logged-in client. */
	const as = async (token: string) => {
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1", "content-type": "application/json" }, body: JSON.stringify({ token }) });
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return async (path: string, init: RequestInit = {}) => {
			const res = await fetch(`${base}${path}`, { ...init, headers: { cookie, "x-owni": "1", "content-type": "application/json", ...(init.headers ?? {}) } });
			const type = res.headers.get("content-type") ?? "";
			const body: any = type.includes("json") ? await res.json() : await res.text();
			return { status: res.status, body, headers: res.headers };
		};
	};
	return { runtime, base, people, owner, anna, luca, as, channel, dataDir, board };
}

describe("web console", () => {
	it("counts board reviews for the person who worked with the agent, and unassigned reviews for the owner", async () => {
		const h = await setup(true);
		const by = { kind: "person" as const, id: h.owner.person.id };
		for (const person of [h.anna.person, h.luca.person]) {
			const card = h.board.create({ title: `Review for ${person.name}`, assignee: "ops" }, by);
			h.board.update(card.id, { status: "da_rivedere", work: { agent: "ops", personId: person.id, threadId: "unused" } }, by);
		}
		const unassigned = h.board.create({ title: "Unassigned review" }, by);
		h.board.update(unassigned.id, { status: "da_rivedere" }, by);
		for (const person of [h.anna, h.luca, h.owner]) {
			const client = await h.as(person.token);
			expect((await client("/api/console-summary")).body.boardReview).toBe(1);
		}
	});

	it("summarizes only the current person's pending decisions without returning private contents", async () => {
		const h = await setup();
		for (const id of ["ops", "secret"]) {
			await h.runtime.proposals("acme", id).propose({ name: "private_tool", description: "Private proposal", parameters: { type: "object" }, code: "export default () => 'private code'", hosts: [] });
			for (const person of [h.anna.person, h.luca.person]) {
				await h.runtime.webActions("acme", id).propose({ pageUrl: "https://example.test", form: 0, action: "https://example.test/send", values: { secret: "private form" }, button: 0, shown: [], fingerprint: "form", reason: "Private reason", requester: `web:${person.id}` });
				await h.runtime.connectorActions("acme", id).propose({ connectorId: "crm", connectorName: "CRM", server: "https://example.test", tool: "write", toolTitle: "Write", args: { secret: "private args" }, reason: "Private reason", destructive: false, requester: `web:${person.id}` });
				await h.runtime.googleActions("acme", id).propose({ kind: "mail.send", personId: person.id, account: "private@example.test", reason: "Private reason", mail: { to: ["other@example.test"], cc: [], subject: "Private subject", body: "Private body" } });
			}
		}
		expect((await fetch(`${h.base}/api/console-summary`)).status).toBe(401);
		const anna = await h.as(h.anna.token);
		const luca = await h.as(h.luca.token);
		const owner = await h.as(h.owner.token);
		// Anna approves all web/connector requests in ops, but only her own Google writes.
		const summary = await anna("/api/console-summary");
		expect(summary.status).toBe(200);
		expect(summary.body).toEqual({ usage: (await anna("/api/usage")).body.usage, pendingApprovals: 6, boardReview: 0 });
		expect((await luca("/api/console-summary")).body.pendingApprovals).toBe(3);
		// Owners see both instances, but never count other people's Google requests.
		expect((await owner("/api/console-summary")).body.pendingApprovals).toBe(10);
		expect(JSON.stringify(summary.body)).not.toMatch(/private|example\.test|personId|requester/i);
		await h.runtime.registry.setAllowedUsers("acme", "ops", "web", [h.anna.person.id]);
		expect((await luca("/api/console-summary")).body.pendingApprovals).toBe(0);
	});

	it("does not count rejected or expired requests in the console summary", async () => {
		const h = await setup();
		const store = h.runtime.googleActions("acme", "ops");
		const input = { kind: "mail.send" as const, personId: h.anna.person.id, account: "anna@example.test", reason: "Reply" };
		await store.propose(input, new Date(Date.now() - 25 * 3600_000));
		const rejected = await store.propose(input);
		await store.decide(rejected.id, "rejected", h.anna.person.id, async () => ({ done: "must not run" }));
		await store.propose(input);
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/console-summary")).body.pendingApprovals).toBe(1);
	});

	it("needs a valid link to log in, and a session for everything else", async () => {
		const h = await setup();
		expect((await fetch(`${h.base}/api/me`)).status).toBe(401);
		const bad = await fetch(`${h.base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: "x".repeat(43) }) });
		expect(bad.status).toBe(401);
		const login = await fetch(`${h.base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: h.anna.token }) });
		expect(login.headers.get("set-cookie")).toMatch(/^owni_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\//);
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/me")).body.person).toMatchObject({ name: "Anna", role: "member" });
		expect(JSON.stringify((await anna("/api/me")).body)).not.toContain("tokenHash");
	});

	it("a link revoked from another process ends its sessions at once; a person removed from the allowlist is refused", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const thread = (await anna("/api/instances/ops/dm", { method: "POST", body: "{}" })).body.thread;
		await h.runtime.registry.setAllowedUsers("acme", "ops", "web", [h.luca.person.id]);
		const refused = await anna(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ciao" }) });
		// No longer a member: the instance is invisible to her, and nothing reached the transcript.
		expect(refused.status).toBe(404);
		expect(await h.channel.transcript(thread.id)).toEqual([]);
		// The CLI, in another process, rotates Anna's link.
		const { PeopleStore: People, SessionStore: Sessions } = await import("../src/web/auth.ts");
		const dir = join(h.dataDir, "tenants", "acme");
		await new People(dir).rotate(h.anna.person.id);
		await new Sessions(dir).endAllOf(h.anna.person.id);
		expect((await anna("/api/me")).status).toBe(401);
	});

	it("refuses changes without the X-Owni header (cross-site requests)", async () => {
		const h = await setup();
		const res = await fetch(`${h.base}/api/login`, { method: "POST", body: JSON.stringify({ token: h.anna.token }) });
		expect(res.status).toBe(403);
	});

	it("a member chats with the instance; replies land in their thread, which others cannot see", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const thread = (await anna("/api/instances/ops/dm", { method: "POST", body: "{}" })).body.thread;
		expect((await anna(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ciao owni" }) })).status).toBe(200);
		let entries: any[] = [];
		await waitFor(() => entries.length === 2 || (void anna(`/api/instances/ops/threads/${thread.id}`).then((r) => (entries = r.body.entries ?? [])), false));
		expect(entries.map((e) => [e.from, e.text])).toEqual([
			["person", "ciao owni"],
			["owni", "Owni (modello locale di sviluppo): hai scritto «ciao owni»"],
		]);
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/instances/ops/threads/${thread.id}`)).status).toBe(404);
		expect((await luca(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: "intruso" }) })).status).toBe(400);
	});

	it("members see only their instances and no owner pages; the owner sees everything", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/instances")).body.instances.map((i: any) => [i.id, i.canChat, i.isApprover])).toEqual([["ops", true, true]]);
		expect((await anna("/api/instances/secret/files")).status).toBe(404);
		expect((await anna("/api/audit")).status).toBe(403);
		expect((await anna("/api/people")).status).toBe(403);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances")).body.instances.map((i: any) => i.id).sort()).toEqual(["ops", "secret"]);
		expect((await owner("/api/people")).body.people).toHaveLength(3);
		const created = (await owner("/api/people", { method: "POST", body: JSON.stringify({ name: "Sara" }) })).body;
		expect(created.link).toMatch(/^\/login#[\w-]{40,}$/);
		expect((await owner("/api/audit?limit=5")).body.events.length).toBeGreaterThan(0);
	});

	it("uploads and downloads workspace files, never outside the workspace", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const up = await anna("/api/instances/ops/files/raw?name=../../listino.csv", { method: "PUT", body: "a,b\n1,2\n", headers: { "content-type": "application/octet-stream" } });
		// Slashes and leading dots are neutralised: it stays in uploads/.
		expect(up.body.file.path).toBe("uploads/_.._listino.csv");
		const files = (await anna("/api/instances/ops/files")).body.files;
		expect(files).toHaveLength(1);
		const down = await anna(`/api/instances/ops/files/raw?path=${encodeURIComponent(files[0].path)}`);
		expect(down.body).toBe("a,b\n1,2\n");
		expect(down.headers.get("content-disposition")).toMatch(/^attachment;/);
		expect((await anna("/api/instances/ops/files/raw?path=../../people.json")).status).toBe(400);
		expect(up.body.document).toBeUndefined();
		const docx = readFileSync(new URL("./fixtures/docs/preventivo.docx", import.meta.url));
		const doc = await anna("/api/instances/ops/files/raw?name=preventivo.docx", { method: "PUT", body: docx, headers: { "content-type": "application/octet-stream" } });
		expect(doc.body).toMatchObject({ file: { path: "uploads/preventivo.docx" }, document: "Word" });
		// The note the console puts in the message: the same words as on Telegram and WhatsApp.
		expect(up.body.note).toBe("[File caricato nel workspace: uploads/_.._listino.csv]");
		expect(doc.body.note).toBe("[Documento Word nel workspace: uploads/preventivo.docx. Leggilo con file_read]");
		const m4a = readFileSync(new URL("./fixtures/audio/riunione.m4a", import.meta.url));
		const recording = await anna("/api/instances/ops/files/raw?name=riunione.m4a", { method: "PUT", body: m4a, headers: { "content-type": "application/octet-stream" } });
		expect(recording.body.note).toBe("[Registrazione M4A, 00:30 nel workspace: uploads/riunione.m4a]");
	});

	it("a member sends photos with a message: the model sees them, the transcript shows them, and only real images are served inline", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const raw = (name: string, body: Uint8Array | string) => anna(`/api/instances/ops/files/raw?name=${name}`, { method: "PUT", body, headers: { "content-type": "application/octet-stream" } });
		const photo = (await raw("scontrino.png", PNG)).body.file.path;
		const svg = (await raw("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")).body.file.path;
		const thread = (await anna("/api/instances/ops/dm", { method: "POST", body: "{}" })).body.thread;
		const post = (body: unknown) => anna(`/api/instances/ops/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify(body) });
		// Only uploads/, at most four, never an empty message without them.
		expect((await post({ text: "", images: ["../people.json"] })).status).toBe(400);
		expect((await post({ text: "x", images: ["memoria/note.md"] })).status).toBe(400);
		expect((await post({ text: "x", images: Array(5).fill(photo) })).status).toBe(400);
		expect((await post({ text: "" })).status).toBe(400);
		expect((await post({ text: "", images: [photo] })).status).toBe(200);
		let entries: any[] = [];
		await waitFor(() => entries.length === 2 || (void anna(`/api/instances/ops/threads/${thread.id}`).then((r) => (entries = r.body.entries ?? [])), false));
		expect(entries[0]).toMatchObject({ from: "person", text: "", images: [photo] });
		expect(entries[1].text).toBe(`Owni (modello locale di sviluppo): hai scritto «[Immagine nel workspace: ${photo}]» e mandato 1 immagine (image/png, 20 byte)`);
		const inline = await anna(`/api/instances/ops/files/raw?path=${encodeURIComponent(photo)}&inline=1`);
		expect(inline.headers.get("content-type")).toBe("image/png");
		expect(inline.headers.get("content-disposition")).toBe("inline");
		expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
		// An SVG can carry script: always a download, never shown by the page.
		const asked = await anna(`/api/instances/ops/files/raw?path=${encodeURIComponent(svg)}&inline=1`);
		expect(asked.headers.get("content-disposition")).toMatch(/^attachment;/);
		expect(asked.headers.get("content-type")).not.toContain("svg");
		// What the page sends must be a picture: anything else is refused before it reaches anyone.
		const refused = await post({ text: "e questo?", images: [svg] });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toContain("non è un'immagine");
		// Two uploads with the same name never overwrite each other: messages point at their photos by path.
		const again = (await raw("scontrino.png", PNG)).body.file.path;
		expect(again).toMatch(/^uploads\/scontrino-[0-9a-f]{8}\.png$/);
	});

	it("a member sees and deletes only the tasks that act for them", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const luca = await h.as(h.luca.token);
		const thread = (await anna("/api/instances/ops/dm", { method: "POST", body: "{}" })).body.thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const task = (await anna("/api/instances/ops/schedules", { method: "POST", body: JSON.stringify({ instruction: "Privato di Anna", at, threadId: thread.id }) })).body.schedule;
		expect((await luca("/api/instances/ops/schedules")).body.schedules).toEqual([]);
		expect((await luca(`/api/instances/ops/schedules/${task.id}`, { method: "DELETE" })).status).toBe(404);
		expect((await anna("/api/instances/ops/schedules")).body.schedules.map((s: { id: string }) => s.id)).toEqual([task.id]);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/schedules")).body.schedules).toHaveLength(1);
	});

	it("only approvers decide on tools proposti", async () => {
		const h = await setup();
		const p = await h.runtime.proposals("acme", "ops").propose({ name: "double", description: "x2", parameters: { type: "object" }, code: "export default async () => 1", hosts: [] });
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/instances/ops/proposals/${p.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) })).status).toBe(403);
		const anna = await h.as(h.anna.token);
		const ok = await anna(`/api/instances/ops/proposals/${p.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approved" }) });
		expect(ok.body.proposal.status).toBe("approved");
	});

	it("serves the page with a strict content security policy", async () => {
		const h = await setup();
		const page = await fetch(`${h.base}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect((await fetch(`${h.base}/../package.json`)).status).toBe(404);
	});
});

describe("web console: two-factor login", () => {
	const login = (base: string, body: unknown) => fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1", "content-type": "application/json" }, body: JSON.stringify(body) });

	it("a person turns on 2FA; from then on the link alone does not log in", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		expect((await anna("/api/me")).body.person.twoFactor).toBe(false);
		const setupRes = await anna("/api/me/2fa/setup", { method: "POST", body: "{}" });
		const { secret, uri } = setupRes.body;
		expect(secret).toMatch(/^[A-Z2-7]{32}$/);
		expect(uri).toContain(`secret=${secret}`);
		// A wrong code does not turn it on.
		expect((await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(400);
		expect((await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now()) }) })).status).toBe(200);
		expect((await anna("/api/me")).body.person.twoFactor).toBe(true);
		// The secret is never sent back, and is not in the people list either.
		expect(JSON.stringify((await (await h.as(h.owner.token))("/api/people")).body)).not.toContain(secret);

		const linkOnly = await login(h.base, { token: h.anna.token });
		expect(linkOnly.status).toBe(401);
		expect(await linkOnly.json()).toEqual({ error: "Serve il codice dell'app di autenticazione", twoFactor: true });
		expect(linkOnly.headers.get("set-cookie")).toBeNull();
		expect((await login(h.base, { token: h.anna.token, code: "123456" })).status).toBe(401);
		const ok = await login(h.base, { token: h.anna.token, code: totp(secret, Date.now() + 30_000) });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("set-cookie")).toMatch(/^owni_session=/);
		// The same code does not work twice.
		expect((await login(h.base, { token: h.anna.token, code: totp(secret, Date.now() + 30_000) })).status).toBe(401);
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "web.2fa_enabled", personId: h.anna.person.id }));
		expect(audit).toContainEqual(expect.objectContaining({ type: "web.login_denied", personId: h.anna.person.id, reason: "2fa" }));
	});

	it("after five wrong codes the login is blocked for a while, even with the right one", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const { secret } = (await anna("/api/me/2fa/setup", { method: "POST", body: "{}" })).body;
		await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now()) }) });
		for (let i = 0; i < 5; i++) expect((await login(h.base, { token: h.anna.token, code: "000000" })).status).toBe(401);
		const blocked = await login(h.base, { token: h.anna.token, code: totp(secret, Date.now() + 30_000) });
		expect(blocked.status).toBe(429);
	});

	it("parallel wrong codes still count: the sixth try is blocked", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const { secret } = (await anna("/api/me/2fa/setup", { method: "POST", body: "{}" })).body;
		await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now()) }) });
		const burst = await Promise.all(Array.from({ length: 20 }, () => login(h.base, { token: h.anna.token, code: "000000" })));
		expect(burst.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
		expect((await login(h.base, { token: h.anna.token, code: totp(secret, Date.now() + 30_000) })).status).toBe(429);
	});

	it("turning it off is limited the same way: no guessing codes from an open session", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const { secret } = (await anna("/api/me/2fa/setup", { method: "POST", body: "{}" })).body;
		await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now()) }) });
		const tries = await Promise.all(Array.from({ length: 10 }, () => anna("/api/me/2fa/disable", { method: "POST", body: JSON.stringify({ code: "000000" }) })));
		expect(tries.filter((r) => r.status === 400).length).toBeLessThanOrEqual(5);
		expect((await anna("/api/me/2fa/disable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now() + 30_000) }) })).status).toBe(429);
		expect((await anna("/api/me")).body.person.twoFactor).toBe(true);
	});

	it("turning 2FA on ends the person's other sessions; an owner reset ends them all", async () => {
		const h = await setup();
		const thief = await h.as(h.anna.token);
		const anna = await h.as(h.anna.token);
		const { secret } = (await anna("/api/me/2fa/setup", { method: "POST", body: "{}" })).body;
		await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now()) }) });
		expect((await thief("/api/me")).status).toBe(401);
		expect((await anna("/api/me")).status).toBe(200);
		const owner = await h.as(h.owner.token);
		await owner(`/api/people/${h.anna.person.id}/2fa/reset`, { method: "POST", body: "{}" });
		expect((await anna("/api/me")).status).toBe(401);
	});

	it("people written from two processes at once are all kept", async () => {
		const h = await setup();
		const tenantDir = join(h.dataDir, "tenants", "acme");
		const a = new PeopleStore(tenantDir);
		const b = new PeopleStore(tenantDir);
		await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).add(`P${i}`, "member")));
		expect((await h.people.list()).filter((p) => p.name.startsWith("P"))).toHaveLength(10);
	});

	it("turning it off needs a code; the owner can reset it for someone who lost the phone", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const { secret } = (await anna("/api/me/2fa/setup", { method: "POST", body: "{}" })).body;
		await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now() - 30_000) }) });
		expect((await anna("/api/me/2fa/disable", { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(400);
		expect((await anna("/api/me/2fa/disable", { method: "POST", body: JSON.stringify({ code: totp(secret, Date.now()) }) })).status).toBe(200);
		expect((await login(h.base, { token: h.anna.token })).status).toBe(200);

		const again = (await anna("/api/me/2fa/setup", { method: "POST", body: "{}" })).body.secret;
		await anna("/api/me/2fa/enable", { method: "POST", body: JSON.stringify({ code: totp(again, Date.now()) }) });
		const luca = await h.as(h.luca.token);
		expect((await luca(`/api/people/${h.anna.person.id}/2fa/reset`, { method: "POST", body: "{}" })).status).toBe(403);
		const owner = await h.as(h.owner.token);
		expect((await owner(`/api/people/${h.anna.person.id}/2fa/reset`, { method: "POST", body: "{}" })).status).toBe(200);
		expect((await login(h.base, { token: h.anna.token })).status).toBe(200);
		expect(await h.runtime.audit("acme").read()).toContainEqual(expect.objectContaining({ type: "web.2fa_reset", personId: h.anna.person.id }));
	});
});

describe("web console: memoria", () => {
	it("each person sees and edits what Owni remembers about them; shared facts are the owner's to edit", async () => {
		const h = await setup();
		const store = h.runtime.memory("acme", "ops");
		store.add({ about: `web:${h.anna.person.id}`, text: "Anna preferisce il tu", source: "owni" });
		store.add({ about: `web:${h.luca.person.id}`, text: "Luca segue i clienti di Milano", source: "owni" });
		store.add({ about: "*", text: "Lo studio chiude ad agosto", source: "owni" });
		const anna = await h.as(h.anna.token);
		const mine = (await anna("/api/instances/ops/memory")).body;
		expect(mine.mine.map((m: { text: string }) => m.text)).toEqual(["Anna preferisce il tu"]);
		expect(mine.shared.map((m: { text: string }) => m.text)).toEqual(["Lo studio chiude ad agosto"]);
		expect(JSON.stringify(mine)).not.toContain("Milano");
		const added = await anna("/api/instances/ops/memory", { method: "POST", body: JSON.stringify({ text: "Rispondimi in italiano" }) });
		expect(added.status).toBe(200);
		expect((await anna("/api/instances/ops/memory", { method: "POST", body: JSON.stringify({ text: "per tutti", shared: true }) })).status).toBe(403);
		const lucaMemory = store.list().find((m) => m.text.includes("Milano"));
		expect((await anna(`/api/instances/ops/memory/${lucaMemory?.id}`, { method: "DELETE" })).status).toBe(404);
		const own = store.list().find((m) => m.text === "Anna preferisce il tu");
		expect((await anna(`/api/instances/ops/memory/${own?.id}`, { method: "DELETE" })).status).toBe(200);
		expect(store.list().some((m) => m.text === "Anna preferisce il tu")).toBe(false);
		// A person without access to the instance sees nothing.
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/memory", { method: "POST", body: JSON.stringify({ text: "Fatturazione il 5 del mese", shared: true }) })).status).toBe(200);
		expect(store.list().some((m) => m.about === "*" && m.text.startsWith("Fatturazione"))).toBe(true);
		expect(JSON.stringify(await h.runtime.audit("acme").read())).not.toContain("preferisce");
	});
});


describe("web console: automazioni", () => {
	it("a person makes one for a chat of theirs, gets the token once, and a call answers in that chat", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const luca = await h.as(h.luca.token);
		const thread = await h.channel.createThread(h.anna.person.id, "Chat");
		expect((await luca("/api/instances/ops/automations", { method: "POST", body: JSON.stringify({ name: "x", instruction: "y", threadId: thread.id }) })).status).toBe(400);
		const made = await anna("/api/instances/ops/automations", { method: "POST", body: JSON.stringify({ name: "Moduli dal sito", instruction: "Rispondi al contatto", threadId: thread.id }) });
		expect(made.status).toBe(200);
		const { token, automation } = made.body;
		expect(automation.path).toBe(`/hooks/automazione/ops/${automation.id}`);
		expect(JSON.stringify((await anna("/api/instances/ops/automations")).body)).not.toMatch(/tokenHash|token/);
		expect((await luca("/api/instances/ops/automations")).body.automations).toEqual([]);
		// The other service: no session, no X-Owni header, the token as a bearer.
		const hook = (auth: string, body = "nome=Anna&messaggio=Vorrei+un+preventivo") => fetch(`${h.base}${automation.path}`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body });
		expect((await hook("Bearer sbagliato")).status).toBe(404);
		const header = await fetch(`${h.base}${automation.path}`, { method: "POST", headers: { "x-owni-token": token, "idempotency-key": "evt_9" }, body: "{}" });
		expect(header.status).toBe(202);
		expect((await hook(`Bearer ${token}`)).status).toBe(202);
		const query = await fetch(`${h.base}${automation.path}?token=${token}`, { method: "POST", body: "{}" });
		expect(query.status).toBe(202);
		const big = await fetch(`${h.base}${automation.path}?token=${token}`, { method: "POST", body: "x".repeat(70 * 1024) });
		expect(big.status).toBe(413);
		expect(await h.runtime.audit("acme").read()).toContainEqual(expect.objectContaining({ type: "automation.fired", automationId: automation.id, threadId: thread.id }));
		expect((await luca(`/api/instances/ops/automations/${automation.id}`, { method: "DELETE" })).status).toBe(404);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/automations")).body.automations).toEqual([expect.objectContaining({ person: { channel: "web", userId: h.anna.person.id }, runs: 3 })]);
		expect((await owner(`/api/instances/ops/automations/${automation.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await hook(`Bearer ${token}`)).status).toBe(404);
	});
});

describe("web console: skill", () => {
	it("everyone with access sees an agente's skills; each saves and deletes their own, the owner every one", async () => {
		const h = await setup();
		const anna = await h.as(h.anna.token);
		const luca = await h.as(h.luca.token);
		const saved = await anna("/api/instances/ops/skills", { method: "PUT", body: JSON.stringify({ name: "Chiusura del mese", description: "Quando chiedono di chiudere il mese", body: "1. Elenca le fatture scadute" }) });
		expect(saved.status).toBe(200);
		expect(saved.body.skill.name).toBe("chiusura-del-mese");
		const listed = (await luca("/api/instances/ops/skills")).body.skills;
		expect(listed).toEqual([expect.objectContaining({ name: "chiusura-del-mese", mine: false, canEdit: false })]);
		expect(listed[0].skillMd).toContain("name: chiusura-del-mese");
		// Another person cannot overwrite or delete it.
		expect((await luca("/api/instances/ops/skills", { method: "PUT", body: JSON.stringify({ name: "chiusura-del-mese", description: "x", body: "y" }) })).status).toBe(409);
		expect(listed[0].createdBy).toBeUndefined();
		expect((await luca("/api/instances/ops/skills/chiusura-del-mese", { method: "DELETE" })).status).toBe(404);
		// A SKILL.md comes in as it is.
		const imported = await luca("/api/instances/ops/skills", { method: "PUT", body: JSON.stringify({ skillMd: "---\nname: reclamo\ndescription: Risposta a un reclamo\n---\nScusati e proponi una soluzione." }) });
		expect(imported.body.skill).toEqual(expect.objectContaining({ name: "reclamo", body: "Scusati e proponi una soluzione." }));
		expect((await luca("/api/instances/ops/skills", { method: "PUT", body: JSON.stringify({ skillMd: "senza intestazione" }) })).status).toBe(400);
		const owner = await h.as(h.owner.token);
		expect((await owner("/api/instances/ops/skills")).body.skills[0].createdBy).toBe(`web:${h.anna.person.id}`);
		// The owner may replace anyone's.
		expect((await owner("/api/instances/ops/skills", { method: "PUT", body: JSON.stringify({ name: "chiusura-del-mese", description: "Nuova", body: "z" }) })).body.replaced).toBe(true);
		expect((await luca("/api/instances/ops/skills/100%25", { method: "DELETE" })).status).toBe(404);
		expect((await owner("/api/instances/ops/skills/chiusura-del-mese", { method: "DELETE" })).status).toBe(200);
		expect(h.runtime.skills("acme", "ops").list().map((s) => s.name)).toEqual(["reclamo"]);
		expect(await h.runtime.audit("acme").read()).toContainEqual(expect.objectContaining({ type: "skill.deleted", skill: "chiusura-del-mese", personId: h.owner.person.id }));
		expect(JSON.stringify(await h.runtime.audit("acme").read())).not.toContain("Scusati");
	});
});
