import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type ClientRequest, createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join } from "node:path";
import { googleReturnQuery } from "../connectors/google.ts";
import { COMPUTER_LIMITS, ComputerError, type ComputerProvider, type ComputerRun, computerKey, workPath } from "../core/computer.ts";
import { computerToken, proxyToken, sameSecret } from "../web/compare.ts";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import { RollingLimit } from "../core/rolling-limit.ts";
import { IDLE_ANSWER } from "../web/hooks.ts";
import { HttpError, pathPattern, readBody, readJson as readJsonBody, send } from "../web/http.ts";
import type { CellState } from "../web/server.ts";
import { type Access, type AccountBilling, accessOf, BillingRefused, live, mayCheckout, mayUse, type StripeBilling, type StripeEvent, type Subscription } from "./billing.ts";
import type { Mailer } from "./mailer.ts";
import { romeDayKey } from "../core/usage.ts";
import type { CellProvider } from "./provider.ts";
import { WAKE_WINDOW_MS, wakeBudget, wakeCookies, wakeKind } from "./wake.ts";

/**
 * The control plane of Owni Cloud (ADR 0007): sign-up by email link, one cell per tenant,
 * requests routed by host name (`<tenant>.<domain>`) to the tenant's cell, idle cells stopped
 * and woken for their next task. It forwards requests without keeping them; conversations,
 * files and secrets of a tenant live only in its cell.
 */

export type ControlPlaneOptions = {
	readonly dataDir: string;
	/** Owni Cloud's domain: the sign-up page lives here, each tenant at `<tenant>.<domain>`. */
	readonly domain: string;
	readonly publicScheme: "http" | "https";
	/** Port in public links, when it is not the scheme's default (local development). */
	readonly publicPort?: number;
	readonly provider: CellProvider;
	readonly mailer: Mailer;
	/** What every cell gets: model provider and key, time zone. */
	readonly cellEnv: Readonly<Record<string, string>>;
	/** A cell with no request for this long, and nothing under way, is stopped. */
	readonly idleMs: number;
	readonly web: { readonly host: string; readonly port: number };
	/** How often to check idle and due cells; 0: only when `tick` is called. */
	readonly tickMs: number;
	/** Subscriptions through Stripe (ADR 0010); without it Owni Cloud is free to use. */
	readonly billing?: StripeBilling;
	/** The instances' computers on micro-VMs (ADR 0015), which cells reach through here; none without it. */
	readonly computer?: ComputerProvider;
	readonly log?: (message: string) => void;
};

export type ControlPlane = {
	/** The tenants, their cells and their spend: for the operator (pnpm cloud status). */
	status(): Promise<TenantStatus[]>;
	readonly server: Server;
	/** Stop idle cells, wake the ones whose next task is due. */
	tick(now: Date): Promise<void>;
	stop(): Promise<void>;
};

type Account = { readonly email: string; readonly tenant: string; readonly createdAt: string; readonly billing?: AccountBilling };
type Cell = {
	readonly tenant: string;
	readonly secret: string;
	readonly nextWakeAt: string | null;
	/** What the cell said it spent when it was last asked (a sleeping cell is not woken to ask). */
	readonly usage?: SeenUsage;
};

type SeenUsage = NonNullable<CellState["usage"]> & { readonly at: string };

/** One tenant as the operator sees it: no conversation, no file, only who, state and spend. */
export type TenantStatus = {
	readonly tenant: string;
	readonly email: string;
	readonly createdAt: string;
	readonly cell: "running" | "stopped" | "missing";
	readonly nextWakeAt: string | null;
	/** Estimated model spend (list prices), as of `readAt`; null if never read. */
	readonly spend: { readonly todayUsd: number; readonly monthUsd: number; readonly lastMonthUsd: number; readonly readAt: string } | null;
	/** Trial or subscription; null when Owni Cloud runs without billing. */
	readonly billing: (Access & { readonly subscription: string | null }) | null;
};

/**
 * A new reading of a cell's spend, kept with what was known: the later reading wins for today,
 * and each month keeps its highest total (a month only grows), so a reading taken just before
 * a newer one never undoes it.
 */
function keepUsage(cells: readonly Cell[], tenant: string, usage: NonNullable<CellState["usage"]>): Cell[] {
	const seen: SeenUsage = { ...usage, at: new Date().toISOString() };
	return cells.map((c) => {
		if (c.tenant !== tenant) return c;
		const old = c.usage;
		const months = { ...old?.months };
		for (const [month, usd] of Object.entries(usage.months)) months[month] = Math.max(months[month] ?? 0, usd);
		const latest = old === undefined || usage.day > old.day ? seen : usage.day < old.day ? old : { ...seen, todayUsd: Math.max(old.todayUsd, usage.todayUsd) };
		return { ...c, usage: { ...latest, months, at: old !== undefined && old.at > seen.at ? old.at : seen.at } };
	});
}

/** Today's and this month's figures from a reading, in Europe/Rome; stale figures count as zero. */
function spendNow(usage: SeenUsage | undefined): TenantStatus["spend"] {
	if (usage === undefined) return null;
	const today = romeDayKey();
	const month = today.slice(0, 7);
	const previous = new Date(`${month}-15T12:00:00Z`);
	previous.setUTCMonth(previous.getUTCMonth() - 1);
	return {
		todayUsd: usage.day === today ? usage.todayUsd : 0,
		monthUsd: usage.months[month] ?? 0,
		lastMonthUsd: usage.months[previous.toISOString().slice(0, 7)] ?? 0,
		readAt: usage.at,
	};
}
/** What a sign-in link gives: the way into the cell, and with billing where the tenant stands and Stripe's pages. */
type VerifyResult = { readonly loginUrl?: string; readonly billing?: Access & { readonly checkoutUrl?: string; readonly portalUrl?: string } };
type PendingLink = { readonly hash: string; readonly email: string; readonly expiresAt: number; readonly usedAt?: number };
type State = {
	accounts: Account[];
	cells: Cell[];
	links: PendingLink[];
	/** Since when billing has been on: tenants from before get their trial from then. Cleared when it is switched off. */
	billingSince?: string;
	/** The trial's length while billing is on, for `pnpm cloud status`. */
	trialDays?: number;
	/** The computers each tenant has used (ADR 0015): capped, and what `pnpm cloud computers` lists and deletes. */
	computers?: TenantComputer[];
};

/** A computer of a tenant: the cell's key for it, and the key the provider knows it by. */
export type TenantComputer = { readonly tenant: string; readonly key: string; readonly createdAt: string };

const EMPTY: State = { accounts: [], cells: [], links: [] };
const LINK_TTL_MS = 30 * 60 * 1000;
const LINKS_PER_IP_HOUR = 20;

/**
 * Who is asking. The control plane listens on 127.0.0.1 behind its https proxy (runbook 6c), so a
 * loopback socket is that proxy, and the address it appended last to X-Forwarded-For is the client's.
 * Earlier entries come from the client itself and are never trusted.
 */
function clientAddress(req: IncomingMessage): string {
	const socket = req.socket.remoteAddress ?? "";
	if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket)) return socket;
	const forwarded = req.headers["x-forwarded-for"];
	const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").at(-1)?.trim();
	return last === undefined || last === "" ? socket : last;
}
const SLEEPING = { error: "Owni dorme: entra dal link di accesso per svegliarla" };
const CELL_TIMEOUT_MS = 5_000;
const LINKS_PER_HOUR = 5;
const MAX_BODY = 64 * 1024;
const MAX_WEBHOOK_BODY = 512 * 1024;
const COMPUTER_RUNS_PER_TENANT = 2;
const COMPUTERS_PER_TENANT = 10;
/** A command nobody asked about for this long is ended; its result, dropped. */
const COMPUTER_JOB_ORPHAN_MS = 90_000;
const COMPUTER_BYTES_IN_FLIGHT = 256 * 1024 * 1024;

type ComputerJob = {
	readonly tenant: string;
	readonly abort: AbortController;
	seenAt: number;
	result?: { readonly run?: ComputerRun; readonly error?: string; readonly internal?: boolean };
	readonly waiters: (() => void)[];
};
/** A running cell is asked for its spend at least this often, so a cell that never sleeps is billed too. */
const USAGE_EVERY_MS = 60 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UI: Record<string, string> = { "/": "index.html", "/verify": "index.html", "/cloud.js": "cloud.js" };
const SHARED_UI: Record<string, string> = { "/app.css": "app.css", "/icon.svg": "icon.svg" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlane> {
	const file = join(options.dataDir, "control-plane.json");
	const log = options.log ?? ((message: string) => console.error(message));
	const read = () => readJsonFile<State>(file, EMPTY);
	const update = (change: (state: State) => State) => updateJsonFile<State>(file, EMPTY, change);
	/** When each cell last saw a request, and how many requests (event streams too) are open. */
	const lastSeen = new Map<string, number>();
	const open = new Map<string, number>();
	const creating = new Map<string, Promise<Account>>();
	const stoppings = new Map<string, Promise<void>>();
	/** Sign-in links asked per address of the asker, in this process. */
	const linksByIp = new RollingLimit(LINKS_PER_IP_HOUR, 3_600_000);
	const port = options.publicPort === undefined ? "" : `:${options.publicPort}`;
	const publicUrl = (host: string) => `${options.publicScheme}://${host}${port}`;
	const billing = options.billing;
	update(({ billingSince, trialDays, ...s }) => (billing === undefined ? s : { ...s, billingSince: billingSince ?? new Date().toISOString(), trialDays: billing.trialDays }));
	const accountOf = (tenant: string) => read().accounts.find((a) => a.tenant === tenant);
	/** Where a tenant stands with its subscription; undefined when there is no billing. */
	const accessFor = (tenant: string): Access | undefined => {
		const state = read();
		const account = state.accounts.find((a) => a.tenant === tenant);
		return billing === undefined || account === undefined ? undefined : accessOf(account, state.billingSince ?? account.createdAt, billing.trialDays);
	};
	const suspended = (tenant: string) => {
		const access = accessFor(tenant);
		return access !== undefined && !mayUse(access);
	};

	// --- sign-up and sign-in ---
	async function signup(body: { email?: unknown; purpose?: unknown }, ip: string): Promise<void> {
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		if (!EMAIL.test(email)) throw new HttpError(400, "Indirizzo email non valido");
		const now = Date.now();
		if (!linksByIp.take(ip, now)) throw new HttpError(429, "Troppi link chiesti da qui: riprova tra un'ora");
		if (read().links.filter((l) => l.email === email && l.expiresAt - LINK_TTL_MS > now - 3_600_000).length >= LINKS_PER_HOUR) throw new HttpError(429, "Troppi link chiesti: riprova tra un'ora");
		const token = randomBytes(32).toString("base64url");
		update((s) => ({ ...s, links: [...s.links.filter((l) => l.expiresAt > now - 3_600_000), { hash: hash(token), email, expiresAt: now + LINK_TTL_MS }] }));
		const forBilling = body.purpose === "billing" && billing !== undefined;
		await options.mailer.send({
			to: email,
			subject: forBilling ? "Il tuo abbonamento a Owni" : "Entra in Owni",
			text: `Per ${forBilling ? "gestire l'abbonamento a Owni" : "entrare in Owni"} apri questo link entro 30 minuti:\n\n${publicUrl(options.domain)}/verify${forBilling ? "?per=abbonamento" : ""}#${token}\n\nSe non l'hai chiesto tu, ignora questa mail.`,
		});
	}

	async function verify(body: { token?: unknown; purpose?: unknown }): Promise<VerifyResult> {
		const token = typeof body.token === "string" ? body.token : "";
		const now = Date.now();
		let email: string | undefined;
		// Used up under the lock: the same link cannot sign in twice.
		update((s) => {
			const link = s.links.find((l) => l.usedAt === undefined && l.expiresAt > now && sameSecret(l.hash, hash(token)));
			if (link === undefined) return s;
			email = link.email;
			return { ...s, links: s.links.map((l) => (l === link ? { ...l, usedAt: now } : l)) };
		});
		if (email === undefined) throw new HttpError(400, "Link non valido o scaduto: chiedine uno nuovo");
		const signedIn = email;
		try {
			const account = read().accounts.find((a) => a.email === signedIn) ?? (await createAccount(signedIn));
			const access = accessFor(account.tenant);
			if (access === undefined) return { loginUrl: await signInLink(account.tenant) };
			// Managing the subscription needs no cell; a tenant whose trial ended gets the way to subscribe, and its cell stays asleep.
			if (body.purpose === "billing" || !mayUse(access)) return { billing: { ...access, ...(await billingLinks(account.tenant, access)) } };
			return { loginUrl: await signInLink(account.tenant), billing: access };
		} catch (error) {
			// Our failure, not the person's: the link works again for a retry.
			update((s) => ({ ...s, links: s.links.map((l) => (sameSecret(l.hash, hash(token)) ? { hash: l.hash, email: l.email, expiresAt: l.expiresAt } : l)) }));
			throw error;
		}
	}

	async function signInLink(tenant: string): Promise<string> {
		await ensureRunning(tenant);
		lastSeen.set(tenant, Date.now());
		return `${publicUrl(`${tenant}.${options.domain}`)}/login#${await ownerLink(tenant)}`;
	}

	/**
	 * Stripe's pages for this tenant: Checkout while it has no subscription (or one that is over),
	 * the portal once it has a customer (where an unpaid invoice is settled too).
	 */
	async function billingLinks(tenant: string, access: Access): Promise<{ checkoutUrl?: string; portalUrl?: string }> {
		if (billing === undefined) return {};
		const { email, billing: current } = accountOf(tenant) as Account;
		const homeUrl = publicUrl(options.domain);
		const customerId = current?.customerId;
		let checkoutUrl: string | undefined;
		if (mayCheckout(current?.status)) {
			const page = await billing.checkout({
				tenant,
				email,
				homeUrl,
				...(customerId === undefined ? {} : { customerId }),
				...(access.state === "trial" ? { trialEndsAt: access.trialEndsAt } : {}),
				...(current?.checkoutId === undefined ? {} : { previous: current.checkoutId }),
			});
			updateBilling(tenant, (b) => ({ ...b, checkoutId: page.id }));
			checkoutUrl = page.url;
		}
		return { ...(checkoutUrl === undefined ? {} : { checkoutUrl }), ...(customerId === undefined ? {} : { portalUrl: await billing.portal(customerId, homeUrl) }) };
	}

	function createAccount(email: string): Promise<Account> {
		const pending = creating.get(email);
		if (pending !== undefined) return pending;
		const work = (async () => {
			const tenant = tenantFor(email);
			const secret = randomBytes(32).toString("base64url");
			await options.provider.create(tenant, {
				...options.cellEnv,
				OWNI_TENANT_ID: tenant,
				OWNI_PUBLIC_URL: publicUrl(`${tenant}.${options.domain}`),
				OWNI_CELL_SECRET: secret,
				// Google sends everyone back to one address, the control plane's, which passes the person on to their cell.
				...(options.cellEnv.OWNI_GOOGLE_CLIENT_ID === undefined ? {} : { OWNI_GOOGLE_REDIRECT_URL: `${publicUrl(options.domain)}/oauth/google/callback` }),
			});
			const account: Account = { email, tenant, createdAt: new Date().toISOString() };
			update((s) => ({ ...s, accounts: [...s.accounts, account], cells: [...s.cells, { tenant, secret, nextWakeAt: null }] }));
			log(`cloud: new tenant ${tenant}`);
			return account;
		})().finally(() => creating.delete(email));
		creating.set(email, work);
		return work;
	}

	async function ownerLink(tenant: string): Promise<string> {
		const response = await toCell(tenant, "/internal/owner-link", "POST");
		if (!response.ok) throw new Error(`Cell ${tenant} gave no owner link (${response.status})`);
		return ((await response.json()) as { token: string }).token;
	}

	// --- cells ---
	const cellOf = (tenant: string) => read().cells.find((c) => c.tenant === tenant);

	/** One start at a time per tenant: requests that arrive during it wait for it, and start nothing. */
	const starting = new Map<string, Promise<void>>();
	function ensureRunning(tenant: string): Promise<void> {
		const inFlight = starting.get(tenant);
		if (inFlight !== undefined) return inFlight;
		const start = (async () => {
			await stoppings.get(tenant)?.catch(() => {});
			if ((await options.provider.status(tenant)) !== "running") {
				await options.provider.start(tenant);
				log(`cloud: cell ${tenant} started`);
			}
		})().finally(() => starting.delete(tenant));
		starting.set(tenant, start);
		return start;
	}

	async function toCell(tenant: string, path: string, method: "GET" | "POST"): Promise<Response> {
		const cell = cellOf(tenant);
		if (cell === undefined) throw new Error(`No cell ${tenant}`);
		return fetch(`${await options.provider.baseUrl(tenant)}${path}`, { method, headers: { authorization: `Bearer ${cell.secret}` }, signal: AbortSignal.timeout(CELL_TIMEOUT_MS) });
	}

	let ticking: Promise<void> | undefined;
	/** One round at a time; cells in parallel, so a cell that hangs does not hold up the others. */
	function tick(now: Date): Promise<void> {
		if (ticking !== undefined) return ticking;
		ticking = Promise.allSettled(read().cells.map((cell) => tickCell(cell, now).then(() => retryUsage(cell.tenant, now))))
			.then((results) => {
				for (const r of results) if (r.status === "rejected") log(`cloud: tick: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
			})
			.finally(() => {
				ticking = undefined;
			});
		return ticking;
	}

	async function tickCell(cell: Cell, now: Date): Promise<void> {
		const status = await options.provider.status(cell.tenant);
		if (status === "running") {
			if (billing?.meters && now.getTime() - Date.parse(cell.usage?.at ?? "1970-01-01") >= USAGE_EVERY_MS) {
				const reading = await cellState(cell.tenant);
				if (reading?.usage !== undefined) keepReading(cell.tenant, reading.usage);
			}
			// A tenant whose trial ended is let go of at once, not after the idle time.
			const cut = suspended(cell.tenant);
			const quiet = () => cut || ((open.get(cell.tenant) ?? 0) === 0 && now.getTime() - (lastSeen.get(cell.tenant) ?? 0) >= options.idleMs);
			if (!quiet()) return;
			const seen = lastSeen.get(cell.tenant);
			const state = await cellState(cell.tenant);
			// A request that came in while we asked keeps the cell up.
			if (state === undefined || state.busy || !quiet() || lastSeen.get(cell.tenant) !== seen) return;
			await stopCell(cell.tenant, state);
		} else if (status === "stopped" && cell.nextWakeAt !== null && Date.parse(cell.nextWakeAt) <= now.getTime() && !suspended(cell.tenant)) {
			await ensureRunning(cell.tenant);
			setNextWake(cell.tenant, null);
			lastSeen.set(cell.tenant, now.getTime());
		}
	}

	async function cellState(tenant: string): Promise<CellState | undefined> {
		return (await toCell(tenant, "/internal/cell", "GET")
			.then((r) => (r.ok ? r.json() : undefined))
			.catch(() => undefined)) as CellState | undefined;
	}

	/** Save when to wake it, then stop it; requests arriving meanwhile wait and wake it again. */
	function stopCell(tenant: string, state: CellState): Promise<void> {
		const stopping = (async () => {
			setNextWake(tenant, state.nextWakeAt, state.usage);
			await options.provider.stop(tenant);
			log(`cloud: cell ${tenant} stopped${state.nextWakeAt === null ? "" : `, wakes at ${state.nextWakeAt}`}`);
		})().finally(() => stoppings.delete(tenant));
		stoppings.set(tenant, stopping);
		return stopping;
	}

	function setNextWake(tenant: string, nextWakeAt: string | null, usage?: CellState["usage"]): void {
		update((s) => {
			const cells = s.cells.map((c) => (c.tenant === tenant ? { ...c, nextWakeAt } : c));
			return { ...s, cells: usage === undefined ? cells : keepUsage(cells, tenant, usage) };
		});
		if (usage !== undefined) void reportUsage(tenant);
	}

	function keepReading(tenant: string, usage: NonNullable<CellState["usage"]>): void {
		update((s) => ({ ...s, cells: keepUsage(s.cells, tenant, usage) }));
		void reportUsage(tenant);
	}

	// --- billing ---
	const reporting = new Map<string, Promise<void>>();
	/** When sending a tenant's cost last failed: tried again from the tick, not at every round. */
	const failedAt = new Map<string, number>();
	/** Sends Stripe the model cost not sent yet, month by month; one tenant at a time, and a retry counts once. */
	function reportUsage(tenant: string): Promise<void> {
		if (!billing?.meters) return Promise.resolve();
		const run = (reporting.get(tenant) ?? Promise.resolve())
			.then(async () => {
				const state = read();
				const account = state.accounts.find((a) => a.tenant === tenant);
				const months = state.cells.find((c) => c.tenant === tenant)?.usage?.months ?? {};
				const customerId = account?.billing?.customerId;
				const sent = account?.billing?.reportedCents;
				if (customerId === undefined || sent === undefined || !live(account?.billing?.status)) return;
				for (const month of Object.keys(months).sort()) {
					const cents = Math.round((months[month] ?? 0) * 100);
					if (cents <= (sent[month] ?? 0)) continue;
					await billing.meterEvent({ customerId, cents: cents - (sent[month] ?? 0), identifier: `${tenant}-${month}-${cents}` });
					updateBilling(tenant, (b) => ({ ...b, reportedCents: { ...b.reportedCents, [month]: Math.max(b.reportedCents?.[month] ?? 0, cents) } }));
				}
				failedAt.delete(tenant);
			})
			.catch((error: unknown) => {
				failedAt.set(tenant, Date.now());
				log(`cloud: usage for ${tenant} not sent: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				if (reporting.get(tenant) === run) reporting.delete(tenant);
			});
		reporting.set(tenant, run);
		return run;
	}

	function retryUsage(tenant: string, now: Date): Promise<void> {
		const failed = failedAt.get(tenant);
		return failed !== undefined && now.getTime() - failed >= 5 * 60_000 ? reportUsage(tenant) : Promise.resolve();
	}

	function updateBilling(tenant: string, change: (billing: AccountBilling) => AccountBilling): void {
		update((s) => ({ ...s, accounts: s.accounts.map((a) => (a.tenant === tenant ? { ...a, billing: change(a.billing ?? {}) } : a)) }));
	}

	/**
	 * A Stripe event says which subscription changed; what it is now we ask Stripe, so events that
	 * arrive late or out of order cannot leave a wrong status. Only Owni's own subscription counts:
	 * a second one (two Checkout pages paid) is reported, never allowed to override a live one.
	 */
	async function applyEvent(event: StripeEvent): Promise<void> {
		if (billing === undefined) return;
		const object = event.data.object;
		const id = event.type === "checkout.session.completed" ? object.subscription : event.type.startsWith("customer.subscription.") ? object.id : undefined;
		if (typeof id !== "string") return;
		const subscription = await billing.subscription(id);
		const accounts = read().accounts;
		const tenant = [typeof object.client_reference_id === "string" ? object.client_reference_id : undefined, subscription.tenant, accounts.find((a) => a.billing?.customerId === subscription.customerId)?.tenant].find(
			(t) => t !== undefined && accounts.some((a) => a.tenant === t),
		);
		if (tenant !== undefined) adopt(tenant, subscription);
	}

	function adopt(tenant: string, subscription: Subscription): void {
		const months = read().cells.find((c) => c.tenant === tenant)?.usage?.months ?? {};
		let ignored = false;
		updateBilling(tenant, (b) => {
			if (b.subscriptionId !== undefined && b.subscriptionId !== subscription.id && live(b.status)) {
				ignored = true;
				return b;
			}
			return {
				...b,
				customerId: subscription.customerId,
				subscriptionId: subscription.id,
				status: subscription.status,
				// The first customer marks the months read so far as sent: they were the trial's.
				reportedCents: b.reportedCents ?? Object.fromEntries(Object.entries(months).map(([m, usd]) => [m, Math.round(usd * 100)])),
			};
		});
		if (ignored) log(`cloud: ${tenant} has another subscription (${subscription.id}, ${subscription.status}) besides its live one: check it on Stripe`);
		else log(`cloud: ${tenant} subscription ${subscription.status}`);
	}

	async function stripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (billing === undefined) return send(res, 404, { error: "Not found" });
		let body: Buffer;
		try {
			body = await readBody(req, MAX_WEBHOOK_BODY);
		} catch (error) {
			if (error instanceof HttpError) return send(res, 413, { error: "Too large" });
			throw error;
		}
		let event: StripeEvent;
		try {
			event = billing.event(body, req.headers["stripe-signature"] as string | undefined);
		} catch (error) {
			if (error instanceof BillingRefused || error instanceof SyntaxError) return send(res, 400, { error: "Firma o evento non valido" });
			throw error;
		}
		// If Stripe cannot be asked now, a 500 makes it deliver the event again later.
		await applyEvent(event);
		send(res, 200, { received: true });
	}

	// --- HTTP ---
	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
		const url = new URL(req.url ?? "/", "http://cloud.local");
		// Cells reach their computers here, at whatever address the operator gave them for the control plane.
		if (url.pathname.startsWith("/internal/computer/") && !host.endsWith(`.${options.domain}`)) return computerApi(req, res, url);
		if (host === options.domain) return home(req, res, url);
		if (host.endsWith(`.${options.domain}`)) {
			const tenant = host.slice(0, -(options.domain.length + 1));
			// An unknown tenant answers like a sleeping one: host names reveal nothing.
			const cell = cellOf(tenant);
			if (cell === undefined) return send(res, 503, SLEEPING);
			return proxy(cell, req, res);
		}
		send(res, 404, { error: "Not found" });
	}

	/** One answer of the sign-up host. `api`: a change only the sign-up page makes (POST with X-Owni), answered with 500 on a failure. */
	type Route = { readonly method: string; readonly pattern: RegExp; readonly api: boolean; readonly handler: (req: IncomingMessage, res: ServerResponse, url: URL) => unknown };
	const routes: Route[] = [];
	const route = (method: string, path: string | RegExp, handler: Route["handler"], api = false) => routes.push({ method, pattern: typeof path === "string" ? pathPattern(path) : path, api, handler });
	const here = (...parts: string[]) => join(import.meta.dirname, ...parts);
	for (const [path, file] of Object.entries(UI)) route("GET", path, (_req, res) => serve(res, here("ui", file)));
	for (const [path, file] of Object.entries(SHARED_UI)) route("GET", path, (_req, res) => serve(res, here("..", "web", "ui", file)));
	route("GET", /^\/fonts\/[a-z0-9-]+\.woff2$/, (_req, res, url) => serve(res, here("..", "web", "ui", url.pathname)));
	route("GET", "/healthz", (_req, res) => send(res, 200, { ok: true }));
	route("GET", "/api/info", (_req, res) => send(res, 200, { billing: billing !== undefined, ...(billing === undefined ? {} : { trialDays: billing.trialDays }) }));
	route("GET", "/oauth/google/callback", (_req, res, url) => googleCallback(res, url));
	// Stripe signs its deliveries; that signature, not our header, is the check here.
	route("POST", "/stripe/webhook", (req, res) => stripeWebhook(req, res));
	route(
		"POST",
		"/api/signup",
		async (req, res) => {
			await signup(await readJson(req), clientAddress(req));
			send(res, 200, { ok: true });
		},
		true,
	);
	route("POST", "/api/verify", async (req, res) => send(res, 200, await verify(await readJson(req))), true);

	async function home(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		securityHeaders(res);
		const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
		if (match === undefined || (match.api && req.headers["x-owni"] !== "1")) return send(res, 404, { error: "Not found" });
		if (!match.api) return void (await match.handler(req, res, url));
		try {
			await match.handler(req, res, url);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			log(`cloud: ${error instanceof Error ? error.message : String(error)}`);
			send(res, 500, { error: "Qualcosa non va: riprova tra poco" });
		}
	}

	/** Commands under way, by id: started by one request and waited for by others, so no request stays open for minutes. */
	const computerJobs = new Map<string, ComputerJob>();
	/** Copies in or out under way per tenant, and bytes being copied on this server. */
	const computerFiles = new Map<string, number>();
	let computerBytes = 0;
	let computerCheck: { at: number; problem: string | undefined } | undefined;
	const running = (tenant: string) => [...computerJobs.values()].filter((j) => j.tenant === tenant && j.result === undefined).length;
	const jobSweeper = setInterval(() => {
		const now = Date.now();
		for (const [id, job] of computerJobs) {
			// A cell that stopped asking (gone, restarted) ends its command; a result nobody fetched is dropped.
			if (job.result === undefined && now - job.seenAt > COMPUTER_JOB_ORPHAN_MS) job.abort.abort();
			if (job.result !== undefined && now - job.seenAt > COMPUTER_JOB_ORPHAN_MS) computerJobs.delete(id);
		}
	}, 10_000);
	jobSweeper.unref();

	/**
	 * The computers of Owni Cloud (ADR 0015): a cell asks for its own tenant, with a token derived
	 * from its secret; its keys are named again under the tenant, so no cell reaches another
	 * tenant's computer. The provider's token stays here. A suspended tenant runs nothing. A
	 * command starts with one request and is waited for with others of at most 25 seconds, so a
	 * reverse proxy's timeouts never cut a 5-minute command.
	 */
	async function computerApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const computer = options.computer;
		const tenant = String(req.headers["x-owni-tenant"] ?? "");
		const cell = cellOf(tenant);
		const given = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (cell === undefined || !sameSecret(given, computerToken(cell.secret))) return send(res, 404, { error: "Not found" });
		const op = url.pathname.slice("/internal/computer/".length);
		// A cell still set up for computers after they were switched off here: it is told, not left guessing.
		if (computer === undefined) return op === "check" ? send(res, 200, { problem: "Owni Cloud non offre il computer" }) : send(res, 404, { error: "Not found" });
		if (suspended(tenant)) return send(res, 402, { error: "il periodo di prova è finito: il computer riparte con l'abbonamento" });
		try {
			if (op === "check" && req.method === "GET") {
				// Asked at each look at the settings: Fly is asked at most once a minute, and the cell gets no operator detail.
				if (computerCheck === undefined || Date.now() - computerCheck.at > 60_000) {
					const problem = await computer.check();
					if (problem !== undefined) log(`cloud: computers not ready: ${problem}`);
					computerCheck = { at: Date.now(), problem: problem === undefined ? undefined : "il computer di Owni Cloud non è disponibile ora" };
				}
				return send(res, 200, { problem: computerCheck.problem });
			}
			if (op === "reset" && req.method === "POST") {
				const value = (await readJson(req)).key;
				const key = await keyOf(tenant, value, false);
				if (key !== undefined) await computer.reset(key);
				// Its place under the cap is free again.
				await update((s) => ({ ...s, computers: (s.computers ?? []).filter((c) => !(c.tenant === tenant && c.key === value)) }));
				return send(res, 200, { ok: true });
			}
			if (op === "run" && req.method === "POST") {
				const body = await readJson(req);
				const command = body.command;
				const timeoutS = Number(body.timeoutS);
				if (typeof command !== "string" || command.length === 0 || command.length > 8000) throw new HttpError(400, "comando non valido");
				if (!(timeoutS >= 1 && timeoutS <= COMPUTER_LIMITS.maxTimeoutS)) throw new HttpError(400, "tempo non valido");
				const key = (await keyOf(tenant, body.key, true)) as string;
				if (running(tenant) >= COMPUTER_RUNS_PER_TENANT) return send(res, 429, { error: "ci sono già altri comandi in corso: riprova quando finiscono" });
				const id = randomBytes(16).toString("hex");
				const job: ComputerJob = { tenant, abort: new AbortController(), seenAt: Date.now(), waiters: [] };
				computerJobs.set(id, job);
				void computer
					.run(key, command, { timeoutS, signal: job.abort.signal })
					.then((run): ComputerJob["result"] => ({ run }))
					.catch((error: unknown): ComputerJob["result"] => {
						if (error instanceof ComputerError) return { error: error.message };
						log(`cloud: computer of ${tenant}: ${error instanceof Error ? error.message : String(error)}`);
						return { error: "il computer non risponde", internal: true };
					})
					.then((result) => {
						job.result = result;
						job.seenAt = Date.now();
						for (const wake of job.waiters.splice(0)) wake();
					});
				return send(res, 200, { job: id });
			}
			if ((op === "result" || op === "cancel") && (req.method === "GET" || req.method === "POST")) {
				const id = url.searchParams.get("job") ?? "";
				const job = computerJobs.get(id);
				if (job === undefined || job.tenant !== tenant) return send(res, 404, { error: "comando sconosciuto" });
				job.seenAt = Date.now();
				if (op === "cancel") {
					job.abort.abort();
					return send(res, 200, { ok: true });
				}
				// A cell that gave up on this request (cancelled mid-wait) asks again: the result waits for that one.
				let gone = false;
				res.once("close", () => (gone = !res.writableFinished));
				if (job.result === undefined) {
					const waitS = Math.max(0, Math.min(25, Number(url.searchParams.get("wait") ?? "0") || 0));
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, waitS * 1000);
						job.waiters.push(() => {
							clearTimeout(timer);
							resolve();
						});
					});
				}
				const result = job.result;
				if (result === undefined) return send(res, 200, { done: false });
				if (gone) return;
				computerJobs.delete(id);
				if (result.run !== undefined) return send(res, 200, { done: true, run: result.run });
				return send(res, result.internal === true ? 502 : 422, { error: result.error });
			}
			if (op === "file") {
				const path = workPath(url.searchParams.get("path") ?? "");
				if (path === undefined) throw new HttpError(422, "percorso non valido");
				const max = req.method === "PUT" ? COMPUTER_LIMITS.maxCopyInBytes : Number(url.searchParams.get("max"));
				if (req.method !== "PUT" && req.method !== "GET") return send(res, 404, { error: "Not found" });
				if (!Number.isInteger(max) || max < 1 || max > (req.method === "PUT" ? COMPUTER_LIMITS.maxCopyInBytes : COMPUTER_LIMITS.maxFileBytes)) throw new HttpError(400, "dimensione non valida");
				const size = req.method === "PUT" ? Number(req.headers["content-length"]) : max;
				if (req.method === "PUT" && !(Number.isInteger(size) && size >= 0 && size <= max)) throw new HttpError(413, "file troppo grande per il computer");
				// One copy at a time per tenant, and a ceiling on what the server holds at once.
				if ((computerFiles.get(tenant) ?? 0) >= 1 || computerBytes + size > COMPUTER_BYTES_IN_FLIGHT) return send(res, 429, { error: "il computer sta già copiando altri file: riprova tra poco" });
				const key = (await keyOf(tenant, url.searchParams.get("key"), true)) as string;
				computerFiles.set(tenant, 1);
				computerBytes += size;
				try {
					if (req.method === "PUT") {
						await computer.put(key, [{ path, data: await readBody(req, size, "file troppo grande") }]);
						return send(res, 200, { ok: true });
					}
					const data = await computer.get(key, path, max);
					res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length, "cache-control": "no-store" });
					return void res.end(data);
				} finally {
					computerFiles.delete(tenant);
					computerBytes -= size;
				}
			}
			send(res, 404, { error: "Not found" });
		} catch (error) {
			if (error instanceof ComputerError) return send(res, 422, { error: error.message });
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			log(`cloud: computer of ${tenant}: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) send(res, 502, { error: "il computer non risponde" });
		}
	}

	/**
	 * The provider's key for a cell's computer: named under the tenant. A new one is recorded,
	 * up to COMPUTERS_PER_TENANT; `create` false gives undefined for one never used.
	 */
	async function keyOf(tenant: string, value: unknown, create: boolean): Promise<string | undefined> {
		if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new HttpError(400, "chiave non valida");
		const key = computerKey(tenant, value);
		const known = (read().computers ?? []).some((c) => c.tenant === tenant && c.key === value);
		if (known) return key;
		if (!create) return undefined;
		let refused = false;
		await update((s) => {
			const mine = (s.computers ?? []).filter((c) => c.tenant === tenant);
			if (mine.some((c) => c.key === value)) return s;
			if (mine.length >= COMPUTERS_PER_TENANT) {
				refused = true;
				return s;
			}
			return { ...s, computers: [...(s.computers ?? []), { tenant, key: value, createdAt: new Date().toISOString() }] };
		});
		if (refused) throw new ComputerError(`questo account ha già ${COMPUTERS_PER_TENANT} computer: azzerane uno da un'altra istanza`);
		return key;
	}

	/**
	 * Google's way back for every cell: the state starts with the tenant, set by its cell. The
	 * person goes straight to their console, which finishes the connection with its session
	 * (the same step a cell's own callback does), so a sleeping cell needs no waking for this.
	 */
	function googleCallback(res: ServerResponse, url: URL): void {
		const tenant = /^([a-z0-9]{1,63})~/.exec(url.searchParams.get("state") ?? "")?.[1];
		if (tenant === undefined || !read().accounts.some((a) => a.tenant === tenant)) return send(res, 404, { error: "Collegamento non valido: riprova dalla tua Owni" });
		res.writeHead(302, { location: `${publicUrl(`${tenant}.${options.domain}`)}/#/google?${googleReturnQuery(url)}`, "cache-control": "no-store" });
		res.end();
	}

	async function proxy(cell: Cell, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const { tenant, secret } = cell;
		const path = cellPath(req.url ?? "");
		// The cell's endpoints for the control plane are never reachable from outside, however
		// the path is spelled; anything but a plain "/path" target is refused too.
		if (path === undefined || /^\/internal(\/|$)/i.test(path.pathname)) return send(res, 404, { error: "Not found" });
		if (suspended(tenant)) {
			// The person is sent where they can subscribe; nothing reaches or wakes the cell.
			if (req.method === "GET" && String(req.headers.accept ?? "").includes("text/html")) {
				res.writeHead(302, { location: `${publicUrl(options.domain)}/?sospesa=1`, "cache-control": "no-store" });
				return void res.end();
			}
			return send(res, 402, { error: `Il periodo di prova è finito: attiva l'abbonamento da ${publicUrl(options.domain)}` });
		}
		const awake = (await options.provider.status(tenant)) === "running" && !stoppings.has(tenant);
		const wake = awake ? undefined : wakeKind(String(req.headers.cookie ?? ""), req.method ?? "", path.pathname, tenant, secret, Date.now());
		if (!awake && wake === undefined) return send(res, 503, SLEEPING);
		// Only a webhook-path wake is limited: anyone can send one, so it must not use up the owner's way in. A start already under way is not a new wake.
		if (wake === "webhook" && !starting.has(tenant) && !wakes.take(tenant)) {
			res.setHeader("retry-after", String(Math.ceil(WAKE_WINDOW_MS / 1000)));
			return send(res, 429, { error: "Troppi tentativi di risveglio: riprova tra qualche minuto" });
		}
		// Counted open before the start, so a tick meanwhile does not stop the cell under it; closed on every
		// way out, a person who leaves while the cell starts included, or the cell would never sleep.
		// Only an answer the cell accepted is activity: what it turns away (no session, bad signature, no
		// such hook) or marks idle (a call to a disconnected line), a start that failed or a person who left
		// first neither keeps it awake nor counts as use.
		open.set(tenant, (open.get(tenant) ?? 0) + 1);
		let accepted = false;
		let upstream: ClientRequest | undefined;
		res.once("close", () => {
			upstream?.destroy();
			open.set(tenant, Math.max(0, (open.get(tenant) ?? 1) - 1));
			if (accepted) lastSeen.set(tenant, Date.now());
		});
		let target: URL;
		try {
			await ensureRunning(tenant);
			target = new URL(await options.provider.baseUrl(tenant));
		} catch (error) {
			log(`cloud: cell ${tenant} did not start: ${error instanceof Error ? error.message : String(error)}`);
			return send(res, 503, { error: "Owni si sta svegliando: riprova tra qualche secondo" });
		}
		if (res.writableEnded || res.destroyed) return;
		// A cell on this host speaks http; one on a platform (Railway) is reached over https.
		const call = target.protocol === "https:" ? httpsRequest : request;
		upstream = call({ host: target.hostname, port: target.port, method: req.method, path: `${path.pathname}${path.search}`, headers: forwardHeaders(req, tenant, secret, target.host) }, (answer) => {
			const status = answer.statusCode ?? 502;
			const { [IDLE_ANSWER]: idle, ...headers } = answer.headers;
			accepted = status < 400 && idle === undefined;
			const set = headers["set-cookie"] ?? [];
			const cookies = wakeCookies(set, { accepted, pathname: path.pathname, tenant, secret, secure: options.publicScheme === "https", now: Date.now() });
			res.writeHead(status, withoutHopByHop(cookies === set ? headers : { ...headers, "set-cookie": [...cookies] }));
			answer.pipe(res);
		});
		upstream.on("error", () => {
			if (!res.headersSent) send(res, 502, { error: "Owni non risponde: riprova tra poco" });
			else res.destroy();
		});
		req.pipe(upstream);
	}

	/** Wakes of a stopped cell by webhook paths, per tenant. */
	const wakes = wakeBudget();

	/** Headers for the cell: no credentials meant for the control plane, no hop-by-hop, our own forwarding facts. */
	function forwardHeaders(req: IncomingMessage, tenant: string, secret: string, cellHost: string): Record<string, string | string[]> {
		const headers = withoutHopByHop(req.headers);
		for (const name of Object.keys(headers)) if (name === "authorization" || name.startsWith("x-forwarded-")) delete headers[name];
		// Host is the cell's own address (a platform routes by it); the public one goes in X-Forwarded-Host.
		// The cell answers only requests that came through here: proof that the gate (sleep, subscription) was passed.
		return { ...headers, host: cellHost, "x-forwarded-host": `${tenant}.${options.domain}`, "x-forwarded-proto": options.publicScheme, "x-forwarded-for": clientAddress(req), "x-owni-proxy": proxyToken(secret) };
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			log(`cloud: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) send(res, 500, { error: "Errore interno" });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.web.port, options.web.host, () => resolve());
	});
	const timer = options.tickMs > 0 ? setInterval(() => void tick(new Date()).catch((error: unknown) => log(`cloud: tick: ${String(error)}`)), options.tickMs) : undefined;

	return {
		server,
		tick,
		status: () => cloudStatus(options),
		async stop() {
			if (timer !== undefined) clearInterval(timer);
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			clearInterval(jobSweeper);
			for (const job of computerJobs.values()) job.abort.abort();
			await options.computer?.close().catch((error: unknown) => log(`cloud: computers not stopped: ${error instanceof Error ? error.message : String(error)}`));
			// Each running cell tells when to wake it before going down, so its tasks survive a restart.
			for (const id of await options.provider.list()) {
				if ((await options.provider.status(id)) !== "running") continue;
				const state = await cellState(id);
				if (state !== undefined) setNextWake(id, state.nextWakeAt, state.usage);
				await options.provider.stop(id);
			}
		},
	};
}

/**
 * Every tenant, its cell and its spend, for the operator. A running cell is asked (and what it
 * says is kept); a sleeping one shows what it said last, without being woken. Works beside a
 * running control plane: it only reads the state file and asks cells.
 */
export async function cloudStatus(options: { readonly dataDir: string; readonly provider: CellProvider }): Promise<TenantStatus[]> {
	const file = join(options.dataDir, "control-plane.json");
	const state = readJsonFile<State>(file, EMPTY);
	const within = <T>(work: Promise<T>, fallback: T): Promise<T> =>
		Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CELL_TIMEOUT_MS))]);
	return Promise.all(
		state.accounts.map(async (account) => {
			const cell = state.cells.find((c) => c.tenant === account.tenant);
			const now = await within<TenantStatus["cell"]>(options.provider.status(account.tenant), "missing");
			let usage = cell?.usage;
			if (now === "running" && cell !== undefined) {
				// A cell stopped meanwhile, or one that hangs, keeps its last reading.
				const fresh = await within(
					(async () => {
						const answer = await fetch(`${await options.provider.baseUrl(account.tenant)}/internal/cell`, { headers: { authorization: `Bearer ${cell.secret}` }, signal: AbortSignal.timeout(CELL_TIMEOUT_MS) });
						return answer.ok ? ((await answer.json()) as CellState) : undefined;
					})(),
					undefined,
				);
				if (fresh?.usage !== undefined) {
					const kept = updateJsonFile<State>(file, EMPTY, (s) => ({ ...s, cells: keepUsage(s.cells, account.tenant, fresh.usage as NonNullable<CellState["usage"]>) }));
					usage = kept.cells.find((c) => c.tenant === account.tenant)?.usage;
				}
			}
			// What the running control plane wrote: the shell asking needs no Stripe settings.
			const billing = state.billingSince === undefined || state.trialDays === undefined ? null : { ...accessOf(account, state.billingSince, state.trialDays), subscription: account.billing?.status ?? null };
			return { tenant: account.tenant, email: account.email, createdAt: account.createdAt, cell: now, nextWakeAt: cell?.nextWakeAt ?? null, spend: spendNow(usage), billing };
		}),
	);
}

/** A tenant id that is also a DNS label, random: the address of a cell does not show who it is. */
function tenantFor(_email: string): string {
	const letters = "abcdefghijkmnpqrstuvwxyz23456789";
	return `a${[...randomBytes(11)].map((b) => letters[b % letters.length]).join("")}`;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");


function securityHeaders(res: ServerResponse): void {
	res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
}

async function serve(res: ServerResponse, path: string): Promise<void> {
	const data = await readFile(path);
	res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(data);
}

const readJson = (req: IncomingMessage) => readJsonBody(req, MAX_BODY, "Richiesta troppo grande");

/** The normalized path of an origin-form request target ("/a/b?c"), or undefined for any other form. */
function cellPath(target: string): { pathname: string; search: string } | undefined {
	if (!target.startsWith("/") || target.startsWith("//")) return undefined;
	try {
		const url = new URL(target, "http://cell.invalid");
		return { pathname: url.pathname, search: url.search };
	} catch {
		return undefined;
	}
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function withoutHopByHop(headers: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
	return out;
}

/** The computers each tenant has used, oldest first, for `pnpm cloud computers` (ADR 0015). */
export function cloudComputers(options: { readonly dataDir: string }): TenantComputer[] {
	return [...(readJsonFile<State>(join(options.dataDir, "control-plane.json"), EMPTY).computers ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Deletes a tenant's computers, machines and files with them, and forgets them: for an account
 * that leaves. One that fails stays recorded, so it can be asked again. The number deleted.
 */
export async function deleteTenantComputers(options: { readonly dataDir: string; readonly tenant: string; readonly computer: ComputerProvider }): Promise<number> {
	const file = join(options.dataDir, "control-plane.json");
	let deleted = 0;
	for (const c of cloudComputers(options).filter((c) => c.tenant === options.tenant)) {
		await options.computer.reset(computerKey(c.tenant, c.key));
		updateJsonFile<State>(file, EMPTY, (s) => ({ ...s, computers: (s.computers ?? []).filter((x) => !(x.tenant === c.tenant && x.key === c.key)) }));
		deleted++;
	}
	return deleted;
}
