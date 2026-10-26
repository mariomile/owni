import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { GOOGLE_SCOPE, GOOGLE_WRITE_SCOPE } from "../src/connectors/google.ts";
import { GoogleActionStore } from "../src/core/google-actions.ts";
import { mimeMessage } from "../src/core/mail-mime.ts";
import { instanceId, tenantId } from "../src/core/ids.ts";
import { workspaceDir } from "../src/core/paths.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

const running: RunningOwni[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
});

const READ = `openid email ${GOOGLE_SCOPE.gmail} ${GOOGLE_SCOPE.calendar}`;
const ALL = `${READ} ${GOOGLE_WRITE_SCOPE.gmail} ${GOOGLE_WRITE_SCOPE.calendar}`;

type Call = { method: string; url: URL; body: string };

/** Fake Google that also takes writes: every call recorded; `fail` makes the next write answer that status. */
function fakeGoogle() {
	const calls: Call[] = [];
	const state = { fail: 0, down: false, email: "anna@example.com", expiredOnce: false };
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = init?.body === undefined ? "" : String(init.body);
		calls.push({ method, url, body });
		if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
			const form = new URLSearchParams(body);
			if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "at", refresh_token: `rt-${form.get("code")}`, scope: form.get("code") === "readonly" ? READ : ALL, expires_in: 3600 });
			return Response.json({ access_token: `at-${form.get("refresh_token")}`, expires_in: 3600 });
		}
		if (url.hostname === "openidconnect.googleapis.com") return Response.json({ email: state.email });
		if (method !== "GET") {
			if (state.expiredOnce) {
				state.expiredOnce = false;
				return Response.json({ error: { message: "expired" } }, { status: 401 });
			}
			if (state.down) throw new TypeError("fetch failed");
			if (state.fail !== 0) {
				const status = state.fail;
				state.fail = 0;
				return Response.json({ error: { message: "nope" } }, { status });
			}
		}
		if (url.pathname === "/gmail/v1/users/me/messages/m1")
			return Response.json({
				id: "m1",
				threadId: "t1",
				snippet: "Ci mandate il preventivo?",
				payload: {
					headers: [
						{ name: "From", value: "Rossi <rossi@cliente.example>" },
						{ name: "To", value: "anna@example.com, Bianchi <bianchi@cliente.example>" },
						{ name: "Cc", value: "verdi@cliente.example" },
						{ name: "Subject", value: "Preventivo" },
						{ name: "Message-ID", value: "<abc@cliente.example>" },
						{ name: "Date", value: "Thu, 15 Oct 2026 09:00:00 +0200" },
					],
				},
			});
		if (url.pathname === "/gmail/v1/users/me/messages/send" && method === "POST") return Response.json({ id: "sent1", threadId: "t1" });
		if (url.pathname === "/gmail/v1/users/me/drafts" && method === "POST") return Response.json({ id: "d1" });
		if (url.pathname === "/upload/gmail/v1/users/me/messages/send" && method === "POST" && url.searchParams.get("uploadType") === "multipart") return Response.json({ id: "sent2", threadId: "t1" });
		if (url.pathname === "/calendar/v3/calendars/primary/events" && method === "POST") return Response.json({ id: "new1", htmlLink: "https://www.google.com/calendar/event?eid=new1" });
		if (url.pathname === "/calendar/v3/calendars/primary/events/e2_20261019") {
			if (method === "GET")
				return Response.json({ id: "e2_20261019", etag: '"etag-2"', recurringEventId: "e2", summary: "Ferie", start: { date: "2026-10-19" }, end: { date: "2026-10-21" }, attendees: [{ email: "luca@example.com" }, { email: "anna@example.com", self: true }] });
			if (method === "PATCH" || method === "DELETE") return method === "PATCH" ? Response.json({ id: "e2_20261019", htmlLink: "javascript:alert(1)" }) : new Response(null, { status: 204 });
		}
		if (url.pathname === "/calendar/v3/calendars/primary/events/e1") {
			if (method === "GET") return Response.json({ id: "e1", summary: "Call con Rossi", start: { dateTime: "2026-10-16T10:00:00+02:00" }, end: { dateTime: "2026-10-16T10:30:00+02:00" } });
			if (method === "PATCH") return Response.json({ id: "e1", htmlLink: "https://www.google.com/calendar/event?eid=e1" });
			if (method === "DELETE") return new Response(null, { status: 204 });
		}
		if (url.pathname === "/calendar/v3/calendars/primary/events") return Response.json({ items: [{ id: "e1", summary: "Call con Rossi", start: { dateTime: "2026-10-16T10:00:00+02:00" }, end: { dateTime: "2026-10-16T10:30:00+02:00" } }] });
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, calls, state, writes: () => calls.filter((c) => c.method !== "GET" && c.url.hostname !== "oauth2.googleapis.com") };
}

const ENV = { OWNI_GOOGLE_CLIENT_ID: "client-1", OWNI_GOOGLE_CLIENT_SECRET: "secret-1", OWNI_GOOGLE_WRITE: "1" };

async function boot(dataDir = tempDataDir(), google = fakeGoogle(), env: Record<string, string> = ENV) {
	const config = loadOwniConfig({ OWNI_DATA_DIR: dataDir, OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", ...env });
	const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { googleFetch: google.fetch, schedulerIntervalMs: 60_000, log: () => {} });
	running.push(owni);
	return { owni, base: `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`, google, dataDir };
}

async function client(base: string, link: string) {
	const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: link.split("#")[1] }) });
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
	return async (path: string, body?: unknown, method?: string) => {
		const res = await fetch(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, "x-owni": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		// biome-ignore lint: test
		return { status: res.status, ...((await res.json()) as any) };
	};
}
type Api = Awaited<ReturnType<typeof client>>;

async function connect(base: string, api: Api, code = "good") {
	const { url } = await api("/api/google/start", {});
	const state = new URL(url).searchParams.get("state") as string;
	return { url: new URL(url), done: await api("/api/google/finish", { state, code }) };
}

async function owniSays(api: Api, threadId: string, match: (text: string) => boolean): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < 10_000) {
		const entries = (await api(`/api/instances/owni/threads/${threadId}`)).entries as { from: string; text?: string }[];
		const found = entries.filter((e) => e.from === "owni" && match(e.text ?? "")).at(-1);
		if (found !== undefined) return found.text ?? "";
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error("no such reply");
}

async function reply(api: Api, threadId: string, text: string): Promise<string> {
	const before = ((await api(`/api/instances/owni/threads/${threadId}`)).entries as { from: string }[]).filter((e) => e.from === "owni").length;
	await api(`/api/instances/owni/threads/${threadId}/messages`, { text });
	const start = Date.now();
	while (Date.now() - start < 10_000) {
		const answers = ((await api(`/api/instances/owni/threads/${threadId}`)).entries as { from: string; text?: string }[]).filter((e) => e.from === "owni");
		if (answers.length > before) return answers.at(-1)?.text ?? "";
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error("no reply");
}

/** The owner, connected to Google with write access, on an instance that allows Google, in a new thread. */
async function ready(env: Record<string, string> = ENV) {
	const booted = await boot(tempDataDir(), fakeGoogle(), env);
	const owner = await client(booted.base, booted.owni.ownerLink as string);
	await connect(booted.base, owner);
	await owner("/api/instances/owni/google", { allowed: true }, "PUT");
	const thread = (await owner("/api/instances/owni/dm", {})).thread as { id: string };
	return { ...booted, owner, thread };
}

const tool = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;
const rawOf = (call: Call | undefined) => Buffer.from((JSON.parse(call?.body ?? "{}").raw ?? JSON.parse(call?.body ?? "{}").message?.raw) as string, "base64url").toString("utf8");

describe("Google: scrivere con approvazione", () => {
	it("with OWNI_GOOGLE_WRITE Owni asks to compose mail and edit events; an account granted only reading reads, and is asked to reconnect to write", async () => {
		const { owni, base } = await boot();
		const owner = await client(base, owni.ownerLink as string);
		const { url, done } = await connect(base, owner, "readonly");
		expect(url.searchParams.get("scope")).toBe(ALL);
		// Fewer permissions than asked: kept for reading, not refused (and not revoked).
		expect(done.status).toBe(200);
		expect(await owner("/api/google")).toMatchObject({ write: true, account: { canWrite: false } });
		await owner("/api/instances/owni/google", { allowed: true }, "PUT");
		const thread = (await owner("/api/instances/owni/dm", {})).thread as { id: string };
		expect(await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare" }))).toContain("solo in lettura");
		expect(await reply(owner, thread.id, tool("google_calendar_events", {}))).toContain("Call con Rossi");
		await connect(base, owner, "good");
		expect((await owner("/api/google")).account.canWrite).toBe(true);
		expect(() => loadOwniConfig({ OWNI_MODEL_PROVIDER: "faux", ...ENV, OWNI_GOOGLE_WRITE: "maybe" })).toThrow(/OWNI_GOOGLE_WRITE/);
	});

	it("a mail is sent only after the person approves it, once, with the exact text shown; the audit keeps no content", async () => {
		const { owner, thread, google, dataDir } = await ready();
		const asked = await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Riunione è confermata", body: "Ciao Luca,\nconfermo giovedì alle 10.\nAnna", reason: "Conferma della riunione a Luca" }));
		expect(asked).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		expect(google.writes()).toEqual([]);
		const { actions } = await owner("/api/instances/owni/google-actions");
		expect(actions).toHaveLength(1);
		const action = actions[0];
		expect(action).toMatchObject({ kind: "mail.send", status: "pending", account: "anna@example.com", thread: { channel: "web", threadId: thread.id }, mail: { to: ["luca@example.com"], cc: [], subject: "Riunione è confermata" } });
		const decided = await owner(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "approved" });
		expect(decided.action.status).toBe("done");
		const sends = google.writes();
		expect(sends.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /gmail/v1/users/me/messages/send"]);
		const raw = rawOf(sends[0]);
		expect(raw).toContain("To: luca@example.com\r\n");
		expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Riunione è confermata").toString("base64")}?=\r\n`);
		expect(Buffer.from(raw.split("\r\n\r\n")[1] as string, "base64").toString("utf8")).toBe("Ciao Luca,\nconfermo giovedì alle 10.\nAnna");
		// Twice is nothing more.
		expect((await owner(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		expect(google.writes()).toHaveLength(1);
		// The conversation hears how it went.
		expect(await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${action.id}`))).toContain("inviata");
		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit).toMatch(/google_action\.approved[\s\S]*google_action\.done/);
		for (const secret of ["luca@example.com", "Riunione", "giovedì", "anna@example.com"]) expect(audit).not.toContain(secret);
	});

	it("a reply goes to the sender, in the same Gmail thread", async () => {
		const { owner, thread, google } = await ready();
		await reply(owner, thread.id, tool("google_mail_send", { reply_to: "m1", body: "Ve lo mandiamo venerdì.", reason: "Risposta a Rossi" }));
		const [replyAction] = (await owner("/api/instances/owni/google-actions")).actions;
		expect(replyAction.mail).toMatchObject({ to: ["rossi@cliente.example"], subject: "Re: Preventivo" });
		await owner(`/api/instances/owni/google-actions/${replyAction.id}/decision`, { decision: "approved" });
		const sent = google.writes()[0];
		expect(JSON.parse(sent?.body ?? "{}").threadId).toBe("t1");
		expect(rawOf(sent)).toContain("In-Reply-To: <abc@cliente.example>\r\nReferences: <abc@cliente.example>\r\n");
		// The outcome notice lands in the thread on its own: wait for it, or the next reply() could take it for Owni's answer.
		await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${replyAction.id}`));
	});

	it("a draft is saved at once in Gmail, with no card; an event with no guests is created at once and tells nobody; with guests it waits; the audit keeps no content", async () => {
		const { owner, thread, google, dataDir } = await ready();
		const saved = await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Bozza", body: "Da rivedere", draft: true, reason: "Bozza per Luca" }));
		expect(saved).toContain("Nothing was sent; nobody was told.");
		expect(google.writes().map((w) => `${w.method} ${w.url.pathname}`)).toEqual(["POST /gmail/v1/users/me/drafts"]);
		expect(rawOf(google.writes()[0])).toContain("To: luca@example.com");
		expect((await owner("/api/instances/owni/google-actions")).actions).toEqual([]);
		// Even if the model says to notify, nobody is on the event to be told.
		const created = await reply(owner, thread.id, tool("google_calendar_create", { summary: "Studio", start: "2026-10-21T09:00", end: "2026-10-21T10:00", notify: true, reason: "Blocco il tempo" }));
		expect(created).toContain("https://www.google.com/calendar/event?eid=new1");
		const [, post] = google.writes();
		expect(`${post?.method} ${post?.url.pathname}`).toBe("POST /calendar/v3/calendars/primary/events");
		expect(post?.url.searchParams.get("sendUpdates")).toBe("none");
		expect(JSON.parse(post?.body ?? "{}")).not.toHaveProperty("attendees");
		expect((await owner("/api/instances/owni/google-actions")).actions).toEqual([]);
		// With guests it is a card, and nothing reaches Google until it is approved.
		expect(await reply(owner, thread.id, tool("google_calendar_create", { summary: "Pranzo", start: "2026-10-22T13:00", end: "2026-10-22T14:00", attendees: ["luca@example.com"], reason: "Pranzo con Luca" }))).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		expect(google.writes()).toHaveLength(2);
		expect((await owner("/api/instances/owni/google-actions")).actions).toHaveLength(1);
		// Sending is still a card: draft is the only way to a draft.
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Invio", body: "Ciao", reason: "Invio a Luca" }))).toMatch(/Richiesta [0-9a-f]{12} pronta/);
		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit).toMatch(/"type":"google_action.direct"[^\n]*"kind":"mail.draft"/);
		expect(audit).toMatch(/"type":"google_action.direct"[^\n]*"kind":"calendar.create"/);
		for (const secret of ["luca@example.com", "Bozza", "Da rivedere", "Studio", "anna@example.com"]) expect(audit).not.toContain(secret);
	});

	it("Google not answering a draft is said as an unknown outcome and recorded; Google refusing it is an error", async () => {
		const { owner, thread, google, dataDir } = await ready();
		google.state.fail = 400;
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Uno", body: "1", draft: true, reason: "Prova" }))).toContain("Errore");
		google.state.fail = 503;
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "Due", body: "2", draft: true, reason: "Prova" }))).toContain("Google did not answer");
		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit.match(/"type":"google_action.direct"/g)).toHaveLength(1);
	});

	it("calendar: create with invitations, change and delete an event, each approved, showing the event as it is", async () => {
		const { owner, thread, google } = await ready();
		expect(await reply(owner, thread.id, tool("google_calendar_events", {}))).toContain("id e1");
		await reply(owner, thread.id, tool("google_calendar_create", { summary: "Pranzo con Luca", start: "2026-10-20T13:00", end: "2026-10-20T14:00", attendees: ["luca@example.com"], notify: true, reason: "Pranzo" }));
		await reply(owner, thread.id, tool("google_calendar_update", { event_id: "e1", start: "2026-10-16T11:00:00+02:00", end: "2026-10-16T11:30:00+02:00", reason: "Spostare la call" }));
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare la call" }));
		const { actions } = await owner("/api/instances/owni/google-actions");
		const [create, update, remove] = actions;
		expect(create).toMatchObject({ kind: "calendar.create", event: { summary: "Pranzo con Luca", attendees: ["luca@example.com"] }, notify: true });
		expect(update).toMatchObject({ kind: "calendar.update", current: { summary: "Call con Rossi", start: "2026-10-16T10:00:00+02:00" } });
		expect(remove).toMatchObject({ kind: "calendar.delete", current: { summary: "Call con Rossi" } });
		for (const a of actions) expect((await owner(`/api/instances/owni/google-actions/${a.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		const [post, patch, del] = google.writes();
		expect(post?.url.searchParams.get("sendUpdates")).toBe("all");
		expect(JSON.parse(post?.body ?? "{}")).toEqual({ summary: "Pranzo con Luca", start: { dateTime: "2026-10-20T13:00:00", timeZone: "Europe/Rome" }, end: { dateTime: "2026-10-20T14:00:00", timeZone: "Europe/Rome" }, attendees: [{ email: "luca@example.com" }] });
		expect(patch?.method).toBe("PATCH");
		expect(patch?.url.searchParams.get("sendUpdates")).toBe("none");
		// A time with an offset is shown and sent in the person's zone.
		expect(JSON.parse(patch?.body ?? "{}")).toEqual({ start: { dateTime: "2026-10-16T11:00:00", timeZone: "Europe/Rome" }, end: { dateTime: "2026-10-16T11:30:00", timeZone: "Europe/Rome" } });
		expect(`${del?.method} ${del?.url.pathname}`).toBe("DELETE /calendar/v3/calendars/primary/events/e1");
		expect(await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${create.id}`))).toContain("https://www.google.com/calendar/event?eid=new1");
	});

	it("rejected: nothing reaches Google; only the person whose account it is sees and decides", async () => {
		const { owner, thread, google, base, owni } = await ready();
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare" }));
		const [action] = (await owner("/api/instances/owni/google-actions")).actions;
		// An approver of the instance is not the owner of the calendar.
		const { link, person } = await owner("/api/people", { name: "Luca" });
		const settings = (await owner("/api/instances/owni/settings")).settings;
		await owner("/api/instances/owni/settings", { name: settings.name, instructions: settings.instructions, webPeople: [...settings.allowedUsers.web, person.id], webApprovers: [...(settings.approvers.web ?? []), person.id] }, "PUT");
		const luca = await client(base, link);
		expect((await luca("/api/instances/owni/google-actions")).actions).toEqual([]);
		expect((await luca(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "approved" })).status).toBe(404);
		expect((await owner(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "rejected" })).action.status).toBe("rejected");
		expect(google.writes()).toEqual([]);
		// Owni hears it, so she does not keep waiting for it.
		expect(await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${action.id}`))).toContain("rifiutata");
		expect(owni.runtime.googleActions("default", "owni")).toBeDefined();
	});

	it("refuses what cannot be sent safely: bad addresses, headers broken across lines, threads outside the console", async () => {
		const { owner, thread, google } = await ready();
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["non-un-indirizzo"], subject: "x", body: "y", reason: "prova" }))).toContain("indirizzo non valido");
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "x\r\nBcc: spia@evil.example", body: "y", reason: "prova" }))).toContain("Errore");
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example>, spia@evil.example"], subject: "x", body: "y", reason: "prova" }))).toContain("indirizzo non valido");
		expect(await reply(owner, thread.id, tool("google_calendar_create", { summary: "x", start: "2026-10-20T14:00", end: "2026-10-20T13:00", reason: "prova" }))).toContain("Errore");
		expect((await owner("/api/instances/owni/google-actions")).actions).toEqual([]);
		expect(google.writes()).toEqual([]);
	});

	it("Google refusing is a failure; Google not answering is an unknown outcome, never sent again", async () => {
		const { owner, thread, google } = await ready();
		await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "Uno", body: "1", reason: "prova" }));
		await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "Due", body: "2", reason: "prova" }));
		await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "Tre", body: "3", reason: "prova" }));
		const [one, two, three] = (await owner("/api/instances/owni/google-actions")).actions;
		google.state.fail = 400;
		expect((await owner(`/api/instances/owni/google-actions/${one.id}/decision`, { decision: "approved" })).action.status).toBe("failed");
		google.state.fail = 503;
		expect((await owner(`/api/instances/owni/google-actions/${two.id}/decision`, { decision: "approved" })).action.status).toBe("uncertain");
		google.state.down = true;
		expect((await owner(`/api/instances/owni/google-actions/${three.id}/decision`, { decision: "approved" })).action.status).toBe("uncertain");
		expect(await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${two.id}`))).toContain("non si sa");
	});

	it("without OWNI_GOOGLE_WRITE there is nothing to write with", async () => {
		const { owner, thread } = await ready({ OWNI_GOOGLE_CLIENT_ID: "client-1", OWNI_GOOGLE_CLIENT_SECRET: "secret-1" });
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Annullare" }));
		expect((await owner("/api/instances/owni/google-actions")).actions).toEqual([]);
		expect((await owner("/api/google")).write).toBe(false);
	});

	it("replies keep the subject, go to Reply-To or to everyone with reply_all, never to oneself", async () => {
		const { owner, thread } = await ready();
		await reply(owner, thread.id, tool("google_mail_send", { reply_to: "m1", subject: "Altro oggetto", reply_all: true, body: "Ok per tutti.", reason: "Risposta a tutti" }));
		const [action] = (await owner("/api/instances/owni/google-actions")).actions;
		expect(action.mail).toMatchObject({ to: ["rossi@cliente.example"], cc: ["bianchi@cliente.example", "verdi@cliente.example"], subject: "Re: Preventivo", inReplyTo: { from: "Rossi <rossi@cliente.example>", subject: "Preventivo" } });
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], body: "senza oggetto", reason: "prova" }))).toContain("oggetto");
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "x", body: "   ", reason: "prova" }))).toContain("vuoto");
	});

	it("calendar: all-day days are inclusive, a move keeps the length, guests are added and removed, deleting tells them, and the event must be unchanged", async () => {
		const { owner, thread, google } = await ready();
		expect(await reply(owner, thread.id, tool("google_calendar_events", {}))).toMatch(/id e1/);
		// No guests: created at once, still with the days inclusive.
		await reply(owner, thread.id, tool("google_calendar_create", { summary: "Fiera", start: "2026-10-20", end: "2026-10-20", reason: "Fiera" }));
		expect(JSON.parse(google.writes()[0]?.body ?? "{}")).toMatchObject({ summary: "Fiera", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } });
		await reply(owner, thread.id, tool("google_calendar_update", { event_id: "e1", start: "2026-10-16T15:00", reason: "Spostare la call" }));
		await reply(owner, thread.id, tool("google_calendar_update", { event_id: "e2_20261019", add_attendees: ["marco@example.com"], remove_attendees: ["luca@example.com"], reason: "Marco al posto di Luca" }));
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e2_20261019", reason: "Niente ferie" }));
		// A path instead of an id is refused before anything is asked.
		expect(await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "..", reason: "xyz" }))).toMatch(/Errore|Validation/);
		const actions = (await owner("/api/instances/owni/google-actions")).actions;
		expect(actions).toHaveLength(3);
		const [move, guests, remove] = actions;
		expect(move.event).toMatchObject({ start: { dateTime: "2026-10-16T15:00:00" }, end: { dateTime: "2026-10-16T15:30:00" } });
		expect(guests).toMatchObject({ notify: true, current: { occurrence: true, etag: '"etag-2"', attendees: ["luca@example.com", "anna@example.com"] }, event: { attendees: ["anna@example.com", "marco@example.com"] } });
		expect(remove.notify).toBe(true);
		for (const a of actions) await owner(`/api/instances/owni/google-actions/${a.id}/decision`, { decision: "approved" });
		const writes = google.writes();
		expect(writes.filter((w) => w.url.pathname.endsWith("e2_20261019")).map((w) => w.url.searchParams.get("sendUpdates"))).toEqual(["all", "all"]);
		expect(google.calls.filter((c) => c.method !== "GET" && c.url.pathname.endsWith("e2_20261019")).length).toBe(2);
		// Google's link is kept only when it is Google Calendar's.
		expect((await owner("/api/instances/owni/google-actions")).actions[1].result).toEqual({ done: "Modificare l'evento «Ferie»" });
	});

	it("is done with the account the card named, while the instance allows Google; a token expired on the way is renewed once", async () => {
		const { owner, thread, google, base } = await ready();
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Uno" }));
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Due" }));
		await reply(owner, thread.id, tool("google_calendar_delete", { event_id: "e1", reason: "Tre" }));
		const [one, two, three] = (await owner("/api/instances/owni/google-actions")).actions;
		await owner("/api/instances/owni/google", { allowed: false }, "PUT");
		const off = (await owner(`/api/instances/owni/google-actions/${one.id}/decision`, { decision: "approved" })).action;
		expect(off).toMatchObject({ status: "failed", result: { error: expect.stringContaining("Impostazioni") } });
		await owner("/api/instances/owni/google", { allowed: true }, "PUT");
		google.state.email = "altro@example.com";
		await connect(base, owner, "other");
		expect((await owner(`/api/instances/owni/google-actions/${two.id}/decision`, { decision: "approved" })).action).toMatchObject({ status: "failed", result: { error: expect.stringContaining("anna@example.com") } });
		expect(google.writes()).toEqual([]);
		google.state.email = "anna@example.com";
		await connect(base, owner, "good");
		google.state.expiredOnce = true;
		// Two taps at once: one write.
		const both = await Promise.all([owner(`/api/instances/owni/google-actions/${three.id}/decision`, { decision: "approved" }), owner(`/api/instances/owni/google-actions/${three.id}/decision`, { decision: "approved" })]);
		expect(both.map((b) => b.action.status)).toEqual(["done", "done"]);
		expect(google.writes().map((w) => w.method)).toEqual(["DELETE", "DELETE"]);
		expect(google.calls.filter((c) => c.url.pathname === "/token").length).toBeGreaterThan(1);
	});

	it("mail headers: long non-ASCII subjects are folded in short encoded words; references keep well-formed ids only", () => {
		const raw = mimeMessage({ to: ["a@b.example"], cc: [], subject: "è".repeat(200), body: "x", inReplyTo: { id: "m", threadId: "t", messageId: "<id@x>", references: `<a@x> bad <b@x>${" <c@x>".repeat(20)} <ü@x>`, from: "", subject: "", date: "" } }).toString("latin1");
		const head = raw.split("\r\n\r\n")[0] as string;
		expect(head.split("\r\n").every((l) => l.length <= 78)).toBe(true);
		expect(head).toContain("In-Reply-To: <id@x>");
		expect(head).not.toContain("ü");
		expect(head.match(/<[^>]+>/g)?.length).toBeLessThanOrEqual(11);
		expect(() => mimeMessage({ to: ["a\u0000b@x.example"], cc: [], subject: "x", body: "y" })).toThrow(/indirizzo/);
	});

	it("store: an action left running by a dead process becomes uncertain; old ones expire", async () => {
		const store = new GoogleActionStore(join(tempDataDir(), "ga"));
		const a = await store.propose({ kind: "calendar.delete", personId: "p1", account: "x@y.example", reason: "r", event: { id: "e1" } }, new Date("2026-10-17T10:00:00Z"));
		expect((await store.get(a.id, new Date("2026-10-18T11:00:00Z")))?.status).toBe("expired");
		const b = await store.propose({ kind: "calendar.delete", personId: "p1", account: "x@y.example", reason: "r", event: { id: "e1" } });
		await store.decide(b.id, "approved", "p1", async () => {
			const settled = await new GoogleActionStore(join(store.dir)).settleInterrupted();
			expect(settled.map((s) => s.id)).toEqual([b.id]);
			return { done: "x" };
		});
		expect(mimeMessage({ to: ["a@b.example"], cc: [], subject: "Ciao", body: "x" }).toString("latin1")).toContain("Content-Type: text/plain; charset=UTF-8");
	});

	it("attachments: the card names them, the approval sends exactly those bytes; a file changed or gone since is not sent; the audit only counts them", async () => {
		const { owner, thread, google, dataDir } = await ready();
		const root = workspaceDir(dataDir, tenantId("default"), instanceId("owni"));
		const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5000, 7)]);
		mkdirSync(join(root, "contratti"), { recursive: true });
		writeFileSync(join(root, "contratti", "Contratto Rossi è firmato.pdf"), pdf);
		writeFileSync(join(root, "contratti", "b.pdf"), pdf);
		writeFileSync(join(root, "contratti", "c.pdf"), pdf);
		const asked = await reply(owner, thread.id, tool("google_mail_send", { reply_to: "m1", body: "Ecco il contratto.", attachments: ["contratti/Contratto Rossi è firmato.pdf"], reason: "Contratto a Rossi" }));
		expect(asked).toMatch(/Richiesta [0-9a-f]{12} pronta: rispondere a rossi@cliente.example, con 1 allegato/);
		const [action] = (await owner("/api/instances/owni/google-actions")).actions;
		expect(action.reason).toBe("Contratto a Rossi");
		expect(action.mail.attachments).toEqual([{ path: "contratti/Contratto Rossi è firmato.pdf", name: "Contratto Rossi è firmato.pdf", size: pdf.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), contentType: "application/pdf" }]);
		const decided = await owner(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "approved" });
		expect(decided.action).toMatchObject({ status: "done", mail: { attachments: [expect.objectContaining({ path: "contratti/Contratto Rossi è firmato.pdf" })] } });
		const raw = rawOf(google.writes()[0]);
		expect(JSON.parse(google.writes()[0]?.body ?? "{}").threadId).toBe("t1");
		const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] as string;
		const [, text, file] = raw.split(`--${boundary}`);
		expect(Buffer.from((text as string).split("\r\n\r\n")[1] as string, "base64").toString("utf8")).toBe("Ecco il contratto.");
		expect(file).toContain("filename*=UTF-8''Contratto%20Rossi%20%C3%A8%20firmato.pdf");
		expect(Buffer.from((file as string).split("\r\n\r\n")[1] as string, "base64").equals(pdf)).toBe(true);
		await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${action.id}`));
		// Changed after the request, or gone: the approval fails and says why.
		await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "B", body: "b", attachments: ["contratti/b.pdf"], reason: "Uno" }));
		await reply(owner, thread.id, tool("google_mail_send", { to: ["luca@example.com"], subject: "C", body: "c", attachments: ["contratti/c.pdf"], reason: "Due" }));
		const [, changed, gone] = (await owner("/api/instances/owni/google-actions")).actions;
		writeFileSync(join(root, "contratti", "b.pdf"), Buffer.concat([pdf.subarray(0, 100), Buffer.alloc(pdf.length - 100, 8)]));
		writeFileSync(join(root, "contratti", "c.pdf"), "");
		for (const a of [changed, gone]) {
			const out = (await owner(`/api/instances/owni/google-actions/${a.id}/decision`, { decision: "approved" })).action;
			expect(out).toMatchObject({ status: "failed", result: { error: expect.stringMatching(/^Non inviata: il file [bc]\.pdf è cambiato dopo la richiesta\. Chiedi a Owni di prepararla di nuovo\.$/) } });
		}
		expect(google.writes()).toHaveLength(1);
		for (const a of [changed, gone]) await owniSays(owner, thread.id, (t) => t.includes(`Esito della richiesta ${a.id}`));
		// What cannot be attached is refused before anything is asked.
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "x", body: "y", attachments: ["../secret.pdf"], reason: "prova" }))).toContain("Errore: non posso allegare");
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["a@b.example"], subject: "x", body: "y", attachments: ["run.sh"], reason: "prova" }))).toContain("Errore: non allego «run.sh»");
		expect((await owner("/api/instances/owni/google-actions")).actions).toHaveLength(3);
		const audit = readFileSync(join(dataDir, "tenants", "default", "audit.jsonl"), "utf8");
		expect(audit).toMatch(/"type":"google_action.approved"[^\n]*"attachments":1/);
		for (const secret of ["Contratto", "contratti", "rossi@cliente.example"]) expect(audit).not.toContain(secret);
	});

	it("a large attachment goes through Gmail's upload endpoint, with the thread in the metadata", async () => {
		const { owner, thread, google, dataDir } = await ready();
		const root = workspaceDir(dataDir, tenantId("default"), instanceId("owni"));
		mkdirSync(root, { recursive: true });
		const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5 * 1024 * 1024, 1)]);
		writeFileSync(join(root, "grande.pdf"), big);
		await reply(owner, thread.id, tool("google_mail_send", { reply_to: "m1", body: "Il file grande.", attachments: ["grande.pdf"], reason: "File grande" }));
		const [action] = (await owner("/api/instances/owni/google-actions")).actions;
		expect((await owner(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "approved" })).action.status).toBe("done");
		const [sent] = google.writes();
		expect(`${sent?.url.pathname}?${sent?.url.searchParams}`).toBe("/upload/gmail/v1/users/me/messages/send?uploadType=multipart");
		const outer = /^--(owni_upload_[0-9a-f]+)\r\n/.exec(sent?.body ?? "")?.[1] as string;
		const [, meta, message] = (sent?.body ?? "").split(`--${outer}`);
		expect(JSON.parse((meta as string).split("\r\n\r\n")[1] as string)).toEqual({ threadId: "t1" });
		expect(message).toContain("Content-Type: message/rfc822\r\n\r\nTo: rossi@cliente.example\r\n");
		const inner = /boundary="([^"]+)"/.exec(message as string)?.[1] as string;
		const file = (message as string).split(`--${inner}`)[2] as string;
		expect(Buffer.from(file.split("\r\n\r\n")[1] as string, "base64").equals(big)).toBe(true);
	});

	it("«mandami per mail»: to me is the person's own account, shown on the card", async () => {
		const { owner, thread, google } = await ready();
		expect(await reply(owner, thread.id, tool("google_mail_send", { to: ["me"], subject: "Report", body: "Il report.", reason: "Il report a me" }))).toContain("inviare una mail a anna@example.com");
		const [action] = (await owner("/api/instances/owni/google-actions")).actions;
		expect(action.mail.to).toEqual(["anna@example.com"]);
		await owner(`/api/instances/owni/google-actions/${action.id}/decision`, { decision: "approved" });
		expect(rawOf(google.writes()[0])).toContain("To: anna@example.com\r\n");
	});
});
