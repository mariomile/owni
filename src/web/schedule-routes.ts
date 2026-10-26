import { describeCron } from "../core/cron.ts";
import { type Automation, AutomationError } from "../core/automations.ts";
import { webHostAllowed } from "../core/policy.ts";
import { BRIEF_INSTRUCTION, BRIEF_THREAD_TITLE, briefCron, briefWhen } from "../core/brief.ts";
import { GOOGLE_CONNECTOR } from "../connectors/google.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { type Schedule, ScheduleError, schedulePerson, threadPerson } from "../core/schedules.ts";
import { firstLook, parseAmount, type Watch, WatchError, watchUrl } from "../core/watches.ts";
import { checkedUrl } from "../core/web-fetch.ts";
import type { Person } from "./auth.ts";
import type { WebChannel } from "./channel.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type ScheduleRoutesDeps = Pick<WebAppOptions, "defaultTimeZone" | "google" | "watchRead"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly instanceAccess: (person: Person, instanceId: string) => Promise<{ readonly record: InstanceRecord; readonly member: boolean }>;
	readonly channelOf: (instanceId: string) => WebChannel;
};

/** What works by itself for a person: tasks programmati, automazioni, the brief del mattino, sentinelle. */
export function scheduleRoutes(route: AddRoute, options: ScheduleRoutesDeps): void {
	const { runtime, tenantId, instanceAccess, channelOf } = options;
	// --- tasks programmati ---
	route("GET", "/api/instances/:id/schedules", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const all = await runtime.schedules(tenantId, params[0]).list();
		// A member sees the tasks that act for them; the owner sees all.
		const words = (s: (typeof all)[number]) => ("cron" in s.when ? describeCron(s.when.cron) : undefined);
		return { schedules: (p.role === "owner" ? all : all.filter((s) => mine(s, p))).map((s) => ({ ...s, ...(words(s) === undefined ? {} : { whenText: words(s) }) })) };
	});
	route("POST", "/api/instances/:id/schedules", "person", async ({ person: p, params, req }) => {
		await instanceAccess(p, params[0]);
		const body = (await readJson(req)) as { instruction?: string; at?: string; cron?: string; timeZone?: string; threadId?: string };
		const thread = await channelOf(params[0]).thread(String(body.threadId ?? ""));
		if (thread === undefined || thread.personId !== p.id) throw new HttpError(400, "Scegli una tua chat dove ricevere i risultati");
		try {
			const schedule = await runtime.schedules(tenantId, params[0]).create({
				instruction: String(body.instruction ?? ""),
				channel: "web",
				threadId: thread.id,
				when: body.cron ? { cron: body.cron, timeZone: body.timeZone || options.defaultTimeZone } : { at: String(body.at ?? "") },
				createdBy: { kind: "person", channel: "web", userId: p.id },
			});
			return { schedule };
		} catch (error) {
			if (error instanceof ScheduleError) throw new HttpError(400, error.message);
			throw error;
		}
	});
	// --- automazioni (ADR 0060): each person makes their own, for a chat of theirs; the owner sees and deletes all ---
	const automationView = (instance: string, a: Automation, p: Person) => {
		const { tokenHash: _secret, person: who, ...rest } = a;
		const mineToo = who.channel === "web" && who.userId === p.id;
		return { ...rest, ...(p.role === "owner" ? { person: who } : {}), path: `/hooks/automazione/${instance}/${a.id}`, mine: mineToo, canEdit: mineToo || p.role === "owner" };
	};
	route("GET", "/api/instances/:id/automations", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const all = runtime.automations(tenantId, params[0]).list();
		return { automations: all.filter((a) => p.role === "owner" || (a.person.channel === "web" && a.person.userId === p.id)).map((a) => automationView(params[0], a, p)) };
	});
	route("POST", "/api/instances/:id/automations", "person", async ({ person: p, params, req }) => {
		await instanceAccess(p, params[0]);
		const body = (await readJson(req)) as { name?: unknown; instruction?: unknown; threadId?: unknown };
		const thread = await channelOf(params[0]).thread(String(body.threadId ?? ""));
		if (thread === undefined || thread.personId !== p.id) throw new HttpError(400, "Scegli una tua chat dove ricevere i risultati");
		try {
			const { automation, token } = runtime.automations(tenantId, params[0]).create({ name: String(body.name ?? ""), instruction: String(body.instruction ?? ""), channel: "web", threadId: thread.id, person: { channel: "web", userId: p.id } });
			await runtime.audit(tenantId).append({ type: "automation.created", instanceId: params[0], personId: p.id, automationId: automation.id });
			// The token only now: it is kept as a hash.
			return { automation: automationView(params[0], automation, p), token };
		} catch (error) {
			if (error instanceof AutomationError) throw new HttpError(400, error.message);
			throw error;
		}
	});
	route("DELETE", "/api/instances/:id/automations/:aid", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const removed = runtime.automations(tenantId, params[0]).remove(params[1], (a) => p.role === "owner" || (a.person.channel === "web" && a.person.userId === p.id));
		if (removed === undefined) throw new HttpError(404, "Automazione non trovata");
		await runtime.audit(tenantId).append({ type: "automation.deleted", instanceId: params[0], personId: p.id, automationId: removed.id });
		return { ok: true };
	});
	// --- brief del mattino: one per person and instance ---
	const briefOf = async (instanceId: string, p: Person) => (await runtime.schedules(tenantId, instanceId).list()).find((s) => s.kind === "brief" && mine(s, p));
	route("GET", "/api/instances/:id/brief", "person", async ({ person: p, params }) => {
		const { record } = await instanceAccess(p, params[0]);
		const brief = await briefOf(record.id, p);
		const when = brief !== undefined && "cron" in brief.when ? briefWhen(brief.when.cron) : undefined;
		return {
			brief: brief === undefined ? null : { scheduleId: brief.id, threadId: brief.threadId, nextRunAt: brief.nextRunAt, ...when },
			google: { available: options.google !== undefined, connected: options.google?.accounts.get(p.id) !== undefined, allowed: (record.egress.connectors ?? []).includes(GOOGLE_CONNECTOR) },
		};
	});
	// One change at a time per instance, so two tabs cannot leave a person with two briefs.
	const briefChanges = new Map<string, Promise<unknown>>();
	const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
		const next = (briefChanges.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
		briefChanges.set(key, next);
		return next;
	};
	route("PUT", "/api/instances/:id/brief", "person", async ({ person: p, params, req }) => {
		const { record, member } = await instanceAccess(p, params[0]);
		if (!member) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questo agente");
		const body = (await readJson(req)) as { time?: unknown; weekdaysOnly?: unknown };
		const cron = briefCron(String(body.time ?? ""), body.weekdaysOnly !== false);
		if (cron === undefined) throw new HttpError(400, "Ora nel formato HH:MM, per esempio 07:30");
		return oneAtATime(record.id, async () => {
			const store = runtime.schedules(tenantId, record.id);
			const channel = channelOf(record.id);
			const previous = await briefOf(record.id, p);
			const kept = previous === undefined ? undefined : await channel.thread(previous.threadId);
			const thread = kept !== undefined && kept.personId === p.id ? kept : await channel.createThread(p.id, BRIEF_THREAD_TITLE);
			const input = { instruction: BRIEF_INSTRUCTION, channel: "web", threadId: thread.id, when: { cron, timeZone: options.defaultTimeZone }, createdBy: { kind: "person" as const, channel: "web", userId: p.id }, kind: "brief" as const };
			let schedule;
			try {
				schedule = await store.create(input);
				if (previous !== undefined) await store.remove(previous.id);
			} catch (error) {
				if (!(error instanceof ScheduleError)) throw error;
				// At the limit of tasks, moving the brief frees its own place first.
				if (previous === undefined) throw new HttpError(400, error.message);
				await store.remove(previous.id);
				schedule = await store.create(input);
			}
			await runtime.audit(tenantId).append({ type: "brief.enabled", instanceId: record.id, personId: p.id, cron });
			return { brief: { scheduleId: schedule.id, threadId: thread.id, nextRunAt: schedule.nextRunAt, ...briefWhen(cron) } };
		});
	});
	route("DELETE", "/api/instances/:id/brief", "person", async ({ person: p, params }) => {
		const { record } = await instanceAccess(p, params[0]);
		return oneAtATime(record.id, async () => {
			const brief = await briefOf(record.id, p);
			if (brief === undefined) throw new HttpError(404, "Nessun brief attivo");
			await runtime.schedules(tenantId, record.id).remove(brief.id);
			await runtime.audit(tenantId).append({ type: "brief.disabled", instanceId: record.id, personId: p.id });
			return { ok: true };
		});
	});
	route("DELETE", "/api/instances/:id/schedules/:sid", "person", async ({ person: p, params }) => {
		await instanceAccess(p, params[0]);
		const store = runtime.schedules(tenantId, params[0]);
		const schedule = await store.get(params[1]);
		if (schedule === undefined || (p.role !== "owner" && !mine(schedule, p))) throw new HttpError(404, "No such task");
		return { removed: await store.remove(schedule.id) };
	});

	// --- sentinelle (ADR 0018) ---
	route("GET", "/api/instances/:id/watches", "person", async ({ person: p, params }) => {
		const { record } = await instanceAccess(p, params[0]);
		const all = await runtime.watches(tenantId, record.id).list();
		// Like tasks: a member sees the sentinelle that write to them; the owner sees all.
		return { watches: (p.role === "owner" ? all : all.filter((w) => mineWatch(w, p))).map(publicWatch) };
	});
	route("POST", "/api/instances/:id/watches", "person", async ({ person: p, params, req }) => {
		const { record, member } = await instanceAccess(p, params[0]);
		// It writes to the person by itself: only someone who may talk to the instance.
		if (!member) throw new HttpError(403, "Non sei tra le persone che possono scrivere a questo agente");
		const body = (await readJson(req)) as { url?: unknown; what?: unknown; below?: unknown; above?: unknown; everyMinutes?: unknown; threadId?: unknown };
		const thread = await channelOf(record.id).thread(String(body.threadId ?? ""));
		if (thread === undefined || thread.personId !== p.id) throw new HttpError(400, "Scegli una tua chat dove ricevere gli avvisi");
		const amount = (v: unknown, label: string) => {
			if (v === undefined || v === null || String(v).trim() === "") return undefined;
			const n = parseAmount(String(v));
			if (n === undefined) throw new HttpError(400, `${label}: scrivi un numero, per esempio 49,90`);
			return n;
		};
		const below = amount(body.below, "Sotto");
		const above = amount(body.above, "Sopra");
		const every = body.everyMinutes === undefined ? undefined : Number(body.everyMinutes);
		const what = typeof body.what === "string" && body.what.trim() !== "" ? body.what.replace(/\s+/g, " ").trim() : undefined;
		try {
			const url = watchUrl(String(body.url ?? ""));
			try {
				// The owner's list of sites; internal addresses are refused by the first look's read.
				checkedUrl(url, { hostAllowed: (host) => webHostAllowed(record.egress, host), addressAllowed: () => true });
			} catch {
				throw new HttpError(400, `${new URL(url).host} non è tra i siti che questo agente può leggere: aggiungilo in Impostazioni → Navigazione web`);
			}
			const watch = { ...(what === undefined ? {} : { what }), ...(below === undefined ? {} : { below }), ...(above === undefined ? {} : { above }) };
			if ((below !== undefined || above !== undefined) && what === undefined) throw new WatchError("Per un avviso sul prezzo scrivi in «Cosa guardare» la frase che sta subito prima del prezzo, per esempio «Prezzo»");
			const store = runtime.watches(tenantId, record.id);
			// The first look now: a page that does not open or a phrase that is not there is said at once.
			const read = options.watchRead;
			const first = read === undefined ? undefined : await firstLook((u) => read(record.id, u), url, watch, new Date());
			const created = await store.create({ url, ...watch, ...(every === undefined ? {} : { everyMinutes: every }), channel: "web", threadId: thread.id, createdBy: { kind: "person", channel: "web", userId: p.id }, ...(first === undefined ? {} : { last: first }) });
			await runtime.audit(tenantId).append({ type: "watch.created", instanceId: record.id, personId: p.id, watchId: created.id, host: new URL(url).host });
			return { watch: publicWatch(created) };
		} catch (error) {
			if (error instanceof WatchError) throw new HttpError(400, `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}`);
			throw error;
		}
	});
	// Again after it stopped: failures cleared, checked at the next pass.
	route("POST", "/api/instances/:id/watches/:wid/resume", "person", async ({ person: p, params }) => {
		const { record } = await instanceAccess(p, params[0]);
		const store = runtime.watches(tenantId, record.id);
		const watch = await store.get(params[1]);
		if (watch === undefined || (p.role !== "owner" && !mineWatch(watch, p))) throw new HttpError(404, "Nessuna sentinella così");
		const { disabledReason: _r, lastError: _e, pending: _p, candidate: _c, ...rest } = watch;
		await store.update({ ...rest, failures: 0, notifiedAt: [], nextCheckAt: new Date().toISOString() });
		return { watch: publicWatch((await store.get(watch.id)) ?? watch) };
	});
	route("DELETE", "/api/instances/:id/watches/:wid", "person", async ({ person: p, params }) => {
		const { record } = await instanceAccess(p, params[0]);
		const store = runtime.watches(tenantId, record.id);
		const watch = await store.get(params[1]);
		if (watch === undefined || (p.role !== "owner" && !mineWatch(watch, p))) throw new HttpError(404, "Nessuna sentinella così");
		const removed = await store.remove(watch.id);
		if (removed) await runtime.audit(tenantId).append({ type: "watch.deleted", instanceId: record.id, personId: p.id, watchId: watch.id, host: new URL(watch.url).host });
		return { removed };
	});
}

/** A task that acts for this person on the web (they created it, or it writes to their thread). */
export function mine(schedule: Schedule, person: Person): boolean {
	const who = schedulePerson(schedule);
	return who?.channel === "web" && who.userId === person.id;
}

/** A sentinella that writes to this person (the same rule as for tasks). */
export function mineWatch(watch: Watch, person: Person): boolean {
	const who = threadPerson(watch);
	return who?.channel === "web" && who.userId === person.id;
}

/** A sentinella for the console: without the page text it keeps to compare. */
function publicWatch(watch: Watch) {
	const { last, pending: _p, candidate: _c, ...rest } = watch;
	return { ...rest, ...(last === undefined ? {} : { last: { at: last.at, excerpt: last.excerpt, ...(last.price === undefined ? {} : { price: last.price }), ...(last.side === undefined ? {} : { side: last.side }) } }) };
}

