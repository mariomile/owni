import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { BRIEF_INSTRUCTION } from "../src/core/brief.ts";
import { OwniRuntime, type Reply } from "../src/core/index.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import { ScheduleError, ScheduleStore } from "../src/core/schedules.ts";
import { createScheduleTools } from "../src/core/tools/schedule-tools.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

async function setup(dataDir = tempDataDir(), clock = { now: new Date("2026-10-15T08:00:00Z") }) {
	const runtime: OwniRuntime = new OwniRuntime({
		dataDir,
		engine: piDurableEngine,
		tools: async (r) => createScheduleTools({ store: runtime.schedules(r.tenantId, r.id), defaultTimeZone: "Europe/Rome", now: () => clock.now }),
	});
	try {
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["u"] } });
	} catch {
		// Second process on the same data dir.
	}
	const replies: Reply[] = [];
	runtime.onReply((r) => replies.push(r));
	const store = runtime.schedules("acme", "ops");
	const scheduler = new Scheduler(async () => [{ tenantId: "acme", instanceId: "ops", store, submit: (req) => runtime.submitScheduled("acme", "ops", req) }], () => {});
	return { runtime, replies, store, scheduler, clock, dataDir };
}
const text = (r: Reply) => (r.status === "answered" ? r.text : "");

describe("tasks programmati", () => {
	it("a one-off fires once at its time, into its thread, and then ends", async () => {
		const h = await setup();
		const s = await h.store.create({ instruction: "Ricordami la riunione", channel: "test", threadId: "t1", when: { at: "2026-10-15T09:00:00Z" }, createdBy: { kind: "person", channel: "test", userId: "u" } }, h.clock.now);
		expect(await h.scheduler.tick(new Date("2026-10-15T08:59:00Z"))).toBe(0);
		expect(await h.scheduler.tick(new Date("2026-10-15T09:00:10Z"))).toBe(1);
		await waitFor(() => h.replies.length === 1);
		expect(h.replies[0]).toMatchObject({ channel: "test", threadId: "t1" });
		expect(text(h.replies[0]!)).toBe(`Owni (modello locale di sviluppo): hai scritto «[Task programmato ${s.id}] Ricordami la riunione»`);
		expect(await h.scheduler.tick(new Date("2026-10-15T10:00:00Z"))).toBe(0);
		expect((await h.store.get(s.id))?.nextRunAt).toBeNull();
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "schedule.fired", scheduleId: s.id }));
		await h.runtime.close();
	});

	it("a saved brief always sends the current brief instruction, not the text it was saved with", async () => {
		const h = await setup();
		const s = await h.store.create({ instruction: "Brief vecchio con le righe dei registri", kind: "brief", channel: "test", threadId: "t1", when: { at: "2026-10-15T09:00:00Z" }, createdBy: { kind: "person", channel: "test", userId: "u" } }, h.clock.now);
		expect(await h.scheduler.tick(new Date("2026-10-15T09:00:10Z"))).toBe(1);
		await waitFor(() => h.replies.length === 1);
		expect(text(h.replies[0]!)).toContain(`[Task programmato ${s.id}] ${BRIEF_INSTRUCTION}`);
		expect(text(h.replies[0]!)).not.toContain("registri");
		await h.runtime.close();
	});

	it("a recurring task after three days down runs once, then moves to its next time", async () => {
		const h = await setup();
		const s = await h.store.create({ instruction: "Report", channel: "test", threadId: "t1", when: { cron: "0 9 * * *", timeZone: "Europe/Rome" }, createdBy: { kind: "person", channel: "test", userId: "u" } }, h.clock.now);
		expect(s.nextRunAt).toBe("2026-10-16T07:00:00.000Z"); // 08:00Z is 10:00 in Rome: 9:00 has passed
		expect(await h.scheduler.tick(new Date("2026-10-18T12:00:00Z"))).toBe(1);
		expect((await h.store.get(s.id))?.nextRunAt).toBe("2026-10-19T07:00:00.000Z");
		expect(await h.scheduler.tick(new Date("2026-10-18T12:01:00Z"))).toBe(0);
		await h.runtime.close();
	});

	it("a crash after the run was admitted and before it was recorded does not run it twice", async () => {
		const h = await setup();
		const s = await h.store.create({ instruction: "Una volta sola", channel: "test", threadId: "t1", when: { at: "2026-10-15T09:00:00Z" }, createdBy: { kind: "person", channel: "test", userId: "u" } }, h.clock.now);
		// Admit, as the scheduler would, then "crash" before advance().
		await h.runtime.submitScheduled("acme", "ops", { channel: "test", threadId: "t1", text: `[Task programmato ${s.id}] Una volta sola`, messageId: `schedule:${s.id}:${s.nextRunAt}`, scheduleId: s.id, onBehalfOf: { channel: "test", userId: "u" } });
		await waitFor(() => h.replies.length === 1);
		expect(await h.scheduler.tick(new Date("2026-10-15T09:01:00Z"))).toBe(1);
		await new Promise((r) => setTimeout(r, 200));
		expect(h.replies).toHaveLength(1);
		await h.runtime.close();
	});

	it("the instance creates, lists and deletes tasks from a conversation, which then gets the results", async () => {
		const h = await setup();
		const say = (t: string, id: string) => h.runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t9", userId: "u", text: t, messageId: id });
		await say('/tool schedule_create {"instruction":"Controlla la posta","cron":"0 8 * * 1-5"}', "1");
		await waitFor(() => h.replies.length === 1);
		expect(text(h.replies[0]!)).toMatch(/^Fatto\. Creato il task [0-9a-f]{12}: prossima esecuzione 2026-10-16T06:00:00\.000Z\.$/);
		const [created] = await h.store.list();
		expect(created).toMatchObject({ channel: "test", threadId: "t9", when: { cron: "0 8 * * 1-5", timeZone: "Europe/Rome" } });
		await say('/tool schedule_create {"instruction":"Spam","cron":"* * * * *"}', "2");
		await waitFor(() => h.replies.length === 2);
		expect(text(h.replies[1]!)).toBe("Fatto. Errore: Runs more often than every 5 minutes");
		await say(`/tool schedule_delete {"id":"${created!.id}"}`, "3");
		await waitFor(() => h.replies.length === 3);
		expect(await h.store.list()).toEqual([]);
		await h.runtime.close();
	});

	it("a task whose person lost access is disabled instead of messaging them", async () => {
		const h = await setup();
		const s = await h.store.create({ instruction: "Report riservato", channel: "test", threadId: "t1", when: { cron: "0 9 * * *", timeZone: "Europe/Rome" }, createdBy: { kind: "person", channel: "test", userId: "u" } }, h.clock.now);
		await h.runtime.registry.setAllowedUsers("acme", "ops", "test", []);
		expect(await h.scheduler.tick(new Date("2026-10-16T08:00:00Z"))).toBe(0);
		await new Promise((r) => setTimeout(r, 150));
		expect(h.replies).toEqual([]);
		expect(await h.store.get(s.id)).toMatchObject({ nextRunAt: null, disabledReason: "the person it acts for is no longer allowed" });
		expect(await h.runtime.audit("acme").read()).toContainEqual(expect.objectContaining({ type: "user.denied", reason: "schedule_person_not_allowed", scheduleId: s.id }));
		await h.runtime.close();
	});

	it("validates what it stores", async () => {
		const store = new ScheduleStore(tempDataDir());
		const base = { instruction: "x", channel: "test", threadId: "t", createdBy: { kind: "instance" } as const };
		const now = new Date("2026-10-15T08:00:00Z");
		await expect(store.create({ ...base, when: { at: "2026-10-14T08:00:00Z" } }, now)).rejects.toThrow("In the past");
		await expect(store.create({ ...base, when: { cron: "0 9 * * *", timeZone: "Mars/Olympus" } }, now)).rejects.toThrow("Unknown time zone");
		await expect(store.create({ ...base, instruction: " ", when: { at: "2026-10-16T08:00:00Z" } }, now)).rejects.toThrow("Empty");
		await expect(store.create({ ...base, when: { cron: "0 0 31 2 *", timeZone: "UTC" } }, now)).rejects.toThrow(ScheduleError);
		await expect(store.create({ ...base, when: { cron: "0,59 0,23 * * *", timeZone: "UTC" } }, now)).rejects.toThrow("more often than every 5 minutes");
	});

	it("a daily 02:30 runs once on the night the clocks go back", async () => {
		const store = new ScheduleStore(tempDataDir());
		const now = new Date("2026-10-24T12:00:00Z");
		let s = await store.create({ instruction: "x", channel: "test", threadId: "t", createdBy: { kind: "instance" }, when: { cron: "30 2 * * *", timeZone: "Europe/Rome" } }, now);
		expect(s.nextRunAt).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST
		s = await store.advance(s, s.nextRunAt as string, new Date("2026-10-25T00:30:05Z"));
		// Not 01:30Z (02:30 again, CET): the next day.
		expect(s.nextRunAt).toBe("2026-10-26T01:30:00.000Z");
	});
});
