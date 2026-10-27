import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StripeBilling } from "../src/cloud/billing.ts";
import { type ControlPlane, startControlPlane } from "../src/cloud/control-plane.ts";
import { LocalCellProvider } from "../src/cloud/local-provider.ts";
import { MemoryMailer } from "../src/cloud/mailer.ts";
import { tempDataDir } from "./helpers.ts";

const DOMAIN = "owni.test";
const running: ControlPlane[] = [];
afterEach(async () => {
	for (const cp of running.splice(0)) await cp.stop();
});

function cloud(options: { idleMs?: number; billing?: StripeBilling } = {}) {
	return cloudAt(tempDataDir(), options);
}

async function cloudAt(dataDir: string, options: { idleMs?: number; cellEnv?: Record<string, string>; billing?: StripeBilling } = {}) {
	const mailer = new MemoryMailer();
	const provider = new LocalCellProvider({ root: join(dataDir, "cells"), repoRoot: join(import.meta.dirname, "..") });
	const cp = await startControlPlane({
		dataDir,
		domain: DOMAIN,
		publicScheme: "http",
		provider,
		mailer,
		cellEnv: { OWNI_MODEL_PROVIDER: "faux", ...options.cellEnv },
		idleMs: options.idleMs ?? 60_000,
		web: { host: "127.0.0.1", port: 0 },
		tickMs: 0,
		...(options.billing === undefined ? {} : { billing: options.billing }),
		log: () => {},
	});
	running.push(cp);
	const port = (cp.server.address() as AddressInfo).port;
	/** A request to the control plane as the browser would send it, by host name. */
	const at = (host: string) => (path: string, init: { method?: string; body?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
		new Promise<{ status: number; headers: Headers; body: any }>((resolve, reject) => {
			// fetch() cannot set Host; the control plane routes by it, as behind a real domain.
			const req = request(
				{ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host, "x-owni": "1", "content-type": "application/json", ...(init.cookie === undefined ? {} : { cookie: init.cookie }), ...init.headers } },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						const headers = new Headers();
						for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
						resolve({ status: res.statusCode ?? 0, headers, body: (res.headers["content-type"] ?? "").includes("json") ? JSON.parse(text) : text });
					});
				},
			);
			req.on("error", reject);
			req.end(init.body);
		});
	return { cp, mailer, provider, at, port, root: dataDir };
}

/** Sign up through the control plane and land, logged in, in the new cell. */
async function signUp(c: Awaited<ReturnType<typeof cloudAt>>, email: string) {
	const home = c.at(DOMAIN);
	expect((await home("/api/signup", { method: "POST", body: JSON.stringify({ email }) })).status).toBe(200);
	const mail = c.mailer.sent.findLast((m) => m.to === email.toLowerCase());
	const token = /#([\w-]+)/.exec(mail?.text ?? "")?.[1] as string;
	const verified = await home("/api/verify", { method: "POST", body: JSON.stringify({ token }) });
	expect(verified.status).toBe(200);
	const url = new URL(verified.body.loginUrl as string);
	const cell = c.at(url.host);
	const login = await cell("/api/login", { method: "POST", body: JSON.stringify({ token: url.hash.slice(1) }) });
	expect(login.status).toBe(200);
	const setCookie = login.headers.get("set-cookie") ?? "";
	const session = /owni_session=[^;]+/.exec(setCookie)?.[0] as string;
	const wake = /owni_wake=[^;]+/.exec(setCookie)?.[0] as string;
	expect(wake).toBeDefined();
	const cookie = `${session}; ${wake}`;
	const api = (path: string, body?: unknown) => cell(path, { method: body === undefined ? "GET" : "POST", cookie, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { url, host: url.host, api, cell, token, session, wake };
}

async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe("Owni Cloud control plane (cells as local processes)", () => {
	it("sign up by email, land in your own cell, get an answer", async () => {
		const c = await cloud();
		const started = Date.now();
		const anna = await signUp(c, "anna@studio.example");
		expect(anna.url.host).toMatch(new RegExp(`^[a-z0-9-]+\\.${DOMAIN.replace(".", "\\.")}$`));
		// The address does not show the person's name.
		expect(anna.url.host).not.toContain("anna");
		const thread = (await anna.api("/api/instances/owni/dm", {})).body.thread;
		await anna.api(`/api/instances/owni/threads/${thread.id}/messages`, { text: "ciao dal cloud" });
		await until(async () => ((await anna.api(`/api/instances/owni/threads/${thread.id}`)).body.entries as { from: string }[]).some((e) => e.from === "owni"));
		// The measure of Fase 1: from signup to first answer.
		expect(Date.now() - started).toBeLessThan(120_000);
	}, 180_000);

	it("each person gets their own cell; signing in again does not make a second one", async () => {
		const c = await cloud();
		const anna = await signUp(c, "anna@studio.example");
		const luca = await signUp(c, "luca@altro.example");
		expect(anna.host).not.toBe(luca.host);
		const again = await signUp(c, "Anna@Studio.example");
		expect(again.host).toBe(anna.host);
		expect(await c.provider.list()).toHaveLength(2);
		// Anna's session does not open Luca's cell.
		expect((await luca.cell("/api/me", { cookie: "owni_session=nothing" })).status).toBe(401);
	}, 180_000);

	it("a login link from the email works once, and not after it expires", async () => {
		const c = await cloud();
		const home = c.at(DOMAIN);
		await home("/api/signup", { method: "POST", body: JSON.stringify({ email: "anna@studio.example" }) });
		const token = /#([\w-]+)/.exec(c.mailer.sent[0]?.text ?? "")?.[1] as string;
		expect((await home("/api/verify", { method: "POST", body: JSON.stringify({ token }) })).status).toBe(200);
		expect((await home("/api/verify", { method: "POST", body: JSON.stringify({ token }) })).status).toBe(400);
		expect((await home("/api/signup", { method: "POST", body: JSON.stringify({ email: "non è una mail" }) })).status).toBe(400);
		// A tenant that does not exist answers like a sleeping one: hosts reveal nothing.
		const nobody = await c.at(`nessuno.${DOMAIN}`)("/api/me");
		const sleeping = await c.at(`nessuno2.${DOMAIN}`)("/login");
		expect([nobody.status, sleeping.status]).toEqual([503, 503]);
		expect(nobody.body).toEqual(sleeping.body);
	}, 180_000);

	it("nothing reaches a cell's /internal/ endpoints through the control plane, however the path is written", async () => {
		const c = await cloud();
		const anna = await signUp(c, "anna@studio.example");
		const raw = (target: string) =>
			new Promise<number>((resolve, reject) => {
				const req = request({ host: "127.0.0.1", port: c.port, path: target, method: "GET", headers: { host: anna.host, authorization: "Bearer guess" } }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				});
				req.on("error", reject);
				req.end();
			});
		for (const target of ["/internal/cell", "//x/internal/cell", "/./internal/cell", "/a/../internal/cell", "/%2e/internal/cell", "/internal\\cell", "http://x/internal/cell", "/INTERNAL/cell"]) {
			expect([target, await raw(target)]).toEqual([target, 404]);
		}
	}, 180_000);

	it("a stopped cell is not woken by anonymous requests, only by its people or its webhooks", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		await anna.api("/api/me");
		const cell = (await c.provider.list())[0] as string;
		await c.cp.tick(new Date());
		expect(await c.provider.status(cell)).toBe("stopped");
		expect((await anna.cell("/api/me")).status).toBe(503);
		expect((await anna.cell("/login")).status).toBe(503);
		expect(await c.provider.status(cell)).toBe("stopped");
		expect((await anna.api("/api/me")).status).toBe(200);
		expect(await c.provider.status(cell)).toBe("running");
	}, 180_000);

	it("a stopped cell is not woken by a forged cookie or a made-up hook; the real credential and a real hook path wake it", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const luca = await signUp(c, "luca@altro.example");
		const cell = (await c.provider.list()).find((id) => anna.host.startsWith(id)) as string;
		const asleep = async () => {
			await c.cp.tick(new Date());
			expect(await c.provider.status(cell)).toBe("stopped");
		};
		await asleep();
		// A 32-character cookie of the right shape, and a path under /hooks/ that nobody serves.
		expect((await anna.cell("/api/me", { cookie: `owni_session=${"a".repeat(32)}` })).status).toBe(503);
		expect((await anna.cell("/api/me", { cookie: `${anna.session}; owni_wake=${"1".repeat(13)}.${"a".repeat(64)}` })).status).toBe(503);
		expect((await anna.cell("/hooks/not-a-real-hook", { method: "POST", body: "{}" })).status).toBe(503);
		expect((await anna.cell("/hooks/telegram/a/b", { method: "POST", body: "{}" })).status).toBe(503);
		// Luca's credential is signed for his cell, not Anna's.
		expect((await anna.cell("/api/me", { cookie: `${anna.session}; ${luca.wake}` })).status).toBe(503);
		expect(await c.provider.status(cell)).toBe("stopped");
		// A real hook path wakes the cell; the cell turns the unsigned call away.
		expect((await anna.cell("/hooks/telegram/owni", { method: "POST", body: "{}" })).status).toBeGreaterThanOrEqual(400);
		expect(await c.provider.status(cell)).toBe("running");
		await asleep();
		// The credential the control plane signed wakes it.
		expect((await anna.api("/api/me")).status).toBe(200);
		expect(await c.provider.status(cell)).toBe("running");
	}, 180_000);

	it("a request the cell turns away does not keep it awake; one it serves does", async () => {
		const c = await cloud({ idleMs: 2_000 });
		const anna = await signUp(c, "anna@studio.example");
		const cell = (await c.provider.list())[0] as string;
		await new Promise((r) => setTimeout(r, 2_100));
		await c.cp.tick(new Date());
		expect(await c.provider.status(cell)).toBe("stopped");
		expect((await anna.cell("/hooks/telegram/owni", { method: "POST", body: "{}" })).status).toBeGreaterThanOrEqual(400);
		expect(await c.provider.status(cell)).toBe("running");
		await c.cp.tick(new Date());
		expect(await c.provider.status(cell)).toBe("stopped");
		expect((await anna.api("/api/me")).status).toBe(200);
		await c.cp.tick(new Date());
		expect(await c.provider.status(cell)).toBe("running");
	}, 180_000);

	it("wake attempts are limited per tenant", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const statuses: number[] = [];
		for (let i = 0; i < 8; i++) {
			await c.cp.tick(new Date());
			statuses.push((await anna.cell("/hooks/telegram/owni", { method: "POST", body: "{}" })).status);
		}
		expect(statuses.slice(0, 6).every((s) => s !== 429 && s !== 503)).toBe(true);
		expect(statuses.slice(6)).toEqual([429, 429]);
	}, 180_000);

	it("the same machine cannot send sign-in links to everyone", async () => {
		const c = await cloud();
		const home = c.at(DOMAIN);
		const statuses: number[] = [];
		for (let i = 0; i < 25; i++) statuses.push((await home("/api/signup", { method: "POST", body: JSON.stringify({ email: `p${i}@x.example` }) })).status);
		expect(statuses.filter((s) => s === 200)).toHaveLength(20);
		expect(statuses.at(-1)).toBe(429);
	}, 60_000);

	it("behind the proxy, the limit is per client: one asker cannot block everyone's sign-in", async () => {
		const c = await cloud();
		const home = c.at(DOMAIN);
		// The proxy appends the address it saw last; whatever the client put before it does not count.
		const ask = (i: number, from: string) => home("/api/signup", { method: "POST", body: JSON.stringify({ email: `q${i}@x.example` }), headers: { "x-forwarded-for": from } });
		const statuses: number[] = [];
		for (let i = 0; i < 21; i++) statuses.push((await ask(i, `10.9.9.${i}, 203.0.113.7`)).status);
		expect(statuses.at(-1)).toBe(429);
		expect((await ask(99, "203.0.113.8")).status).toBe(200);
	}, 60_000);

	it("a sleeping cell's next task survives a restart of the control plane", async () => {
		const dataDir = tempDataDir();
		const first = await cloudAt(dataDir);
		const anna = await signUp(first, "anna@studio.example");
		const thread = (await anna.api("/api/instances/owni/dm", {})).body.thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		await anna.api("/api/instances/owni/schedules", { instruction: "Promemoria", at, threadId: thread.id });
		await first.cp.stop();
		running.splice(running.indexOf(first.cp), 1);
		const second = await cloudAt(dataDir);
		const cell = (await second.provider.list())[0] as string;
		expect(await second.provider.status(cell)).toBe("stopped");
		await second.cp.tick(new Date(Date.parse(at) + 1000));
		expect(await second.provider.status(cell)).toBe("running");
	}, 180_000);

	it("an idle cell is stopped, and the next request wakes it with everything still there", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const thread = (await anna.api("/api/instances/owni/dm", {})).body.thread;
		await anna.api(`/api/instances/owni/threads/${thread.id}/messages`, { text: "ricordati di me" });
		await until(async () => ((await anna.api(`/api/instances/owni/threads/${thread.id}`)).body.entries as { from: string }[]).some((e) => e.from === "owni"));
		await c.cp.tick(new Date());
		expect(await c.provider.status((await c.provider.list())[0] as string)).toBe("stopped");
		const entries = (await anna.api(`/api/instances/owni/threads/${thread.id}`)).body.entries as { from: string }[];
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect(await c.provider.status((await c.provider.list())[0] as string)).toBe("running");
	}, 180_000);

	it("the operator sees each tenant's cell and spend, also after the cell went to sleep", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const tenant = anna.host.split(".")[0] as string;
		// What the cell's ledger holds: today, last month (closed, still to bill), and an old month.
		const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
		const previous = new Date(`${today.slice(0, 7)}-15T12:00:00Z`);
		previous.setUTCMonth(previous.getUTCMonth() - 1);
		const tenantDir = join(c.root, "cells", tenant, "data", "tenants", tenant);
		mkdirSync(tenantDir, { recursive: true });
		writeFileSync(join(tenantDir, "usage-totals.json"), JSON.stringify({ [today]: 1.25, [`${previous.toISOString().slice(0, 7)}-10`]: 4, "2020-01-15": 9 }));
		const awake = await c.cp.status();
		expect(awake).toEqual([expect.objectContaining({ tenant, email: "anna@studio.example", cell: "running", spend: expect.objectContaining({ todayUsd: 1.25, monthUsd: 1.25, lastMonthUsd: 4 }) })]);
		await c.cp.tick(new Date());
		const asleep = await c.cp.status();
		expect(asleep[0]).toMatchObject({ cell: "stopped", spend: { todayUsd: 1.25, monthUsd: 1.25, lastMonthUsd: 4 } });
		// The control plane kept the reading, every month of it, for billing.
		const kept = JSON.parse(readFileSync(join(c.root, "control-plane.json"), "utf8")).cells[0].usage;
		expect(kept.months["2020-01"]).toBe(9);
		// Asking did not wake it.
		expect(await c.provider.status(tenant)).toBe("stopped");
	}, 180_000);

	it("Google sends everyone back to the control plane, which passes the person on to their own cell", async () => {
		const c = await cloudAt(tempDataDir(), { cellEnv: { OWNI_GOOGLE_CLIENT_ID: "client-1", OWNI_GOOGLE_CLIENT_SECRET: "secret-1" } });
		const anna = await signUp(c, "anna@example.com");
		const tenant = anna.host.split(".")[0] as string;
		const consent = new URL((await anna.api("/api/google/start", {})).body.url as string);
		expect(consent.searchParams.get("redirect_uri")).toBe(`http://${DOMAIN}/oauth/google/callback`);
		const state = consent.searchParams.get("state") as string;
		expect(state.startsWith(`${tenant}~`)).toBe(true);
		const home = c.at(DOMAIN);
		const back = await home(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}&scope=x`);
		expect(back.status).toBe(302);
		const location = back.headers.get("location") ?? "";
		expect(location.startsWith(`http://${anna.host}/#/google?`)).toBe(true);
		expect(Object.fromEntries(new URLSearchParams(location.split("#/google?")[1]))).toEqual({ code: "abc", state });
		expect((await home("/oauth/google/callback?code=abc&state=anobody00000~x")).status).toBe(404);
		expect((await home("/oauth/google/callback?code=abc")).status).toBe(404);
	});

	it("a sleeping cell is woken for its next task programmato", async () => {
		const c = await cloud({ idleMs: 0 });
		const anna = await signUp(c, "anna@studio.example");
		const thread = (await anna.api("/api/instances/owni/dm", {})).body.thread;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		await anna.api("/api/instances/owni/schedules", { instruction: "Promemoria", at, threadId: thread.id });
		const cell = (await c.provider.list())[0] as string;
		await c.cp.tick(new Date());
		expect(await c.provider.status(cell)).toBe("stopped");
		await c.cp.tick(new Date(Date.now() + 1_800_000));
		expect(await c.provider.status(cell)).toBe("stopped");
		await c.cp.tick(new Date(Date.parse(at) + 1000));
		expect(await c.provider.status(cell)).toBe("running");
	}, 180_000);
});

/** A Stripe that answers like the real one for what Owni asks, and records each call. */
async function fakeStripe() {
	const calls: { method: string; path: string; form: Record<string, string>; auth: string }[] = [];
	/** Subscriptions as Stripe has them: tests change them, then send the event. */
	const subscriptions = new Map<string, { id: string; customer: string; status: string; metadata: Record<string, string> }>();
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const path = req.url ?? "";
			calls.push({ method: req.method ?? "", path, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))), auth: String(req.headers.authorization ?? "") });
			const sub = /^\/v1\/subscriptions\/([\w]+)$/.exec(path);
			const body =
				path === "/v1/checkout/sessions"
					? { id: `cs_${calls.length}`, url: `https://checkout.stripe.test/c/${calls.length}` }
					: path === "/v1/billing_portal/sessions"
						? { url: `https://billing.stripe.test/p/${calls.length}` }
						: sub !== null
							? subscriptions.get(sub[1] as string)
							: { object: "ok" };
			res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
			res.end(JSON.stringify(body ?? { error: { message: "No such subscription" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	stripes.push(server);
	return { calls, subscriptions, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const stripes: Server[] = [];
afterEach(async () => {
	for (const s of stripes.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

const WEBHOOK_SECRET = "whsec_test_owni";
/** A delivery signed as Stripe signs it. */
function signed(event: { type: string; created: number; object: Record<string, unknown> }) {
	const body = JSON.stringify({ id: `evt_${event.created}`, type: event.type, created: event.created, data: { object: event.object } });
	const t = Math.floor(Date.now() / 1000);
	const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
	return { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${v1}` } };
}

/** Sign-in by email link, returning what the control plane answers (no login into the cell). */
async function verifyFor(c: Awaited<ReturnType<typeof cloudAt>>, email: string, purpose?: "billing") {
	const home = c.at(DOMAIN);
	await home("/api/signup", { method: "POST", body: JSON.stringify({ email, ...(purpose === undefined ? {} : { purpose }) }) });
	const mail = c.mailer.sent.findLast((m) => m.to === email) as { text: string };
	const token = /#([\w-]+)/.exec(mail.text)?.[1] as string;
	return { mail, answer: await home("/api/verify", { method: "POST", body: JSON.stringify({ token, ...(purpose === undefined ? {} : { purpose }) }) }) };
}

describe("Owni Cloud subscriptions (Stripe, faked)", () => {
	it("after the trial the cell stays asleep and the person is sent to subscribe; what Stripe says, asked again, opens it", async () => {
		const stripe = await fakeStripe();
		const billing = new StripeBilling({ secretKey: "sk_test_owni", webhookSecret: WEBHOOK_SECRET, price: "price_flat", trialDays: 0, apiBase: stripe.base });
		const c = await cloud({ billing });
		const home = c.at(DOMAIN);
		expect((await home("/api/info")).body).toEqual({ billing: true, trialDays: 0 });
		const { answer } = await verifyFor(c, "anna@studio.example");
		expect(answer.status).toBe(200);
		expect(answer.body.loginUrl).toBeUndefined();
		expect(answer.body.billing).toMatchObject({ state: "ended", checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//) });
		const checkout = stripe.calls.find((call) => call.path === "/v1/checkout/sessions") as (typeof stripe.calls)[number];
		const tenant = checkout.form.client_reference_id as string;
		expect(checkout.auth).toBe("Bearer sk_test_owni");
		expect(checkout.form).toMatchObject({ mode: "subscription", "line_items[0][price]": "price_flat", customer_email: "anna@studio.example", "subscription_data[metadata][tenant]": tenant });
		// The trial is over: Stripe is not asked to give days that are not there.
		expect(checkout.form["subscription_data[trial_end]"]).toBeUndefined();
		// Nothing reaches or wakes the cell: a page goes to the subscription, an API call is refused.
		expect(await c.provider.status(tenant)).not.toBe("running");
		const cell = c.at(`${tenant}.${DOMAIN}`);
		const page = await cell("/", { headers: { accept: "text/html" } });
		expect(page.status).toBe(302);
		expect(page.headers.get("location")).toBe(`http://${DOMAIN}/?sospesa=1`);
		expect((await cell("/hooks/telegram/x", { method: "POST", body: "{}" })).status).toBe(402);
		// A forged or unsigned delivery changes nothing.
		stripe.subscriptions.set("sub_1", { id: "sub_1", customer: "cus_1", status: "active", metadata: { tenant } });
		const done = signed({ type: "checkout.session.completed", created: 100, object: { client_reference_id: tenant, customer: "cus_1", subscription: "sub_1" } });
		const signature = done.headers["stripe-signature"];
		const flipped = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
		expect((await home("/stripe/webhook", { ...done, headers: { "stripe-signature": flipped } })).status).toBe(400);
		expect((await home("/stripe/webhook", { method: "POST", body: done.body })).status).toBe(400);
		expect((await verifyFor(c, "anna@studio.example")).answer.body.loginUrl).toBeUndefined();
		// Stripe says the checkout is done; asked, it confirms the subscription: Anna is in, and can reach the portal.
		expect((await home("/stripe/webhook", done)).status).toBe(200);
		expect(stripe.calls.some((call) => call.method === "GET" && call.path === "/v1/subscriptions/sub_1")).toBe(true);
		const back = (await verifyFor(c, "anna@studio.example")).answer.body;
		expect(back.loginUrl).toMatch(new RegExp(`^http://${tenant}\\.`));
		expect(back.billing).toEqual({ state: "active", trialEndsAt: expect.any(String) });
		const manage = await verifyFor(c, "anna@studio.example", "billing");
		expect(manage.mail.text).toContain("/verify?per=abbonamento#");
		expect(manage.answer.body.billing).toMatchObject({ state: "active", portalUrl: expect.stringMatching(/^https:\/\/billing\.stripe\.test\//) });
		expect(manage.answer.body.billing.checkoutUrl).toBeUndefined();
		expect(manage.answer.body.loginUrl).toBeUndefined();
		expect(stripe.calls.findLast((call) => call.path === "/v1/billing_portal/sessions")?.form.customer).toBe("cus_1");
		// A second subscription (a second Checkout page paid) never overrides the live one.
		stripe.subscriptions.set("sub_2", { id: "sub_2", customer: "cus_2", status: "canceled", metadata: { tenant } });
		await home("/stripe/webhook", signed({ type: "customer.subscription.deleted", created: 150, object: { id: "sub_2" } }));
		expect((await c.cp.status())[0]?.billing).toMatchObject({ state: "active", subscription: "active" });
		// The event says what changed; Stripe says how it stands: a late payment keeps Owni on, cancellation ends it.
		stripe.subscriptions.set("sub_1", { id: "sub_1", customer: "cus_1", status: "past_due", metadata: { tenant } });
		await home("/stripe/webhook", signed({ type: "customer.subscription.updated", created: 300, object: { id: "sub_1", status: "active" } }));
		expect((await c.cp.status())[0]?.billing).toMatchObject({ state: "past_due", subscription: "past_due" });
		stripe.subscriptions.set("sub_1", { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { tenant } });
		await home("/stripe/webhook", signed({ type: "customer.subscription.deleted", created: 400, object: { id: "sub_1" } }));
		expect((await c.cp.status())[0]?.billing).toMatchObject({ state: "ended", subscription: "canceled" });
		expect((await cell("/api/me")).status).toBe(402);
		// Subscribing again: the same customer, and the previous Checkout page made to expire.
		await verifyFor(c, "anna@studio.example", "billing");
		expect(stripe.calls.findLast((call) => call.path === "/v1/checkout/sessions")?.form).toMatchObject({ customer: "cus_1", "customer_update[address]": "auto" });
		expect(stripe.calls.some((call) => /^\/v1\/checkout\/sessions\/cs_\d+\/expire$/.test(call.path))).toBe(true);
		// The control plane keeps ids and status only.
		expect(readFileSync(join(c.root, "control-plane.json"), "utf8")).not.toMatch(/card|iban|sk_test/i);
	}, 180_000);

	it("sends Stripe the model cost after the trial only, once, whatever order Stripe's events come in", async () => {
		const stripe = await fakeStripe();
		const billing = new StripeBilling({ secretKey: "sk_test_owni", webhookSecret: WEBHOOK_SECRET, price: "price_flat", usage: { price: "price_cost", meterEvent: "owni_model_cost" }, trialDays: 14, apiBase: stripe.base });
		const c = await cloud({ idleMs: 0, billing });
		const anna = await signUp(c, "anna@studio.example");
		const tenant = anna.host.split(".")[0] as string;
		const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
		const tenantDir = join(c.root, "cells", tenant, "data", "tenants", tenant);
		mkdirSync(tenantDir, { recursive: true });
		const spent = (usd: number) => writeFileSync(join(tenantDir, "usage-totals.json"), JSON.stringify({ [today]: usd }));
		// During the trial: read when the cell goes to sleep, sent nowhere.
		spent(1.25);
		await c.cp.tick(new Date());
		expect(await c.provider.status(tenant)).toBe("stopped");
		// Subscribing during the trial keeps its days, with the metered price; the cell is not woken for it.
		const manage = await verifyFor(c, "anna@studio.example", "billing");
		expect(manage.answer.body.billing.state).toBe("trial");
		const checkout = stripe.calls.findLast((call) => call.path === "/v1/checkout/sessions")?.form ?? {};
		expect(checkout["line_items[1][price]"]).toBe("price_cost");
		expect(checkout["line_items[1][quantity]"]).toBeUndefined();
		expect(Number(checkout["subscription_data[trial_end]"])).toBe(Math.floor(Date.parse(manage.answer.body.billing.trialEndsAt) / 1000));
		expect(await c.provider.status(tenant)).toBe("stopped");
		// Stripe sends the subscription's own event before the checkout's.
		stripe.subscriptions.set("sub_9", { id: "sub_9", customer: "cus_9", status: "trialing", metadata: { tenant } });
		const home = c.at(DOMAIN);
		expect((await home("/stripe/webhook", signed({ type: "customer.subscription.created", created: 100, object: { id: "sub_9" } }))).status).toBe(200);
		expect((await home("/stripe/webhook", signed({ type: "checkout.session.completed", created: 101, object: { client_reference_id: tenant, subscription: "sub_9" } }))).status).toBe(200);
		// After subscribing: 75 more cents, sent as 75 units for this customer.
		await signUp(c, "anna@studio.example");
		spent(2);
		await c.cp.tick(new Date());
		await until(async () => stripe.calls.some((call) => call.path === "/v1/billing/meter_events"));
		const meters = () => stripe.calls.filter((call) => call.path === "/v1/billing/meter_events");
		expect(meters()).toHaveLength(1);
		expect(meters()[0]?.form).toEqual({ event_name: "owni_model_cost", "payload[stripe_customer_id]": "cus_9", "payload[value]": "75", identifier: `${tenant}-${today.slice(0, 7)}-200` });
		// Nothing new: nothing more sent.
		await signUp(c, "anna@studio.example");
		await c.cp.tick(new Date());
		await new Promise((r) => setTimeout(r, 200));
		expect(meters()).toHaveLength(1);
	}, 180_000);

	it("a cell still running when the trial ends is stopped at the next round, not after the idle time", async () => {
		const stripe = await fakeStripe();
		const dataDir = tempDataDir();
		const first = await cloudAt(dataDir, { billing: new StripeBilling({ secretKey: "sk_test_owni", webhookSecret: WEBHOOK_SECRET, price: "price_flat", trialDays: 1, apiBase: stripe.base }) });
		const anna = await signUp(first, "anna@studio.example");
		const tenant = anna.host.split(".")[0] as string;
		await first.cp.stop();
		running.splice(running.indexOf(first.cp), 1);
		// Billing switched off: the start of the trials is forgotten; switched on again with no trial left.
		const off = await cloudAt(dataDir);
		await off.cp.stop();
		running.splice(running.indexOf(off.cp), 1);
		expect(JSON.parse(readFileSync(join(dataDir, "control-plane.json"), "utf8")).billingSince).toBeUndefined();
		const again = await cloudAt(dataDir, { idleMs: 3_600_000, billing: new StripeBilling({ secretKey: "sk_test_owni", webhookSecret: WEBHOOK_SECRET, price: "price_flat", trialDays: 0, apiBase: stripe.base }) });
		await again.provider.start(tenant);
		await again.cp.tick(new Date());
		expect(await again.provider.status(tenant)).toBe("stopped");
		expect((await again.cp.status())[0]?.billing).toMatchObject({ state: "ended", subscription: null });
	}, 180_000);
});
