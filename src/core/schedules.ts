import { randomBytes } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";
import { assertTimeZone, nextDistinctRun, nextRun, parseCron } from "./cron.ts";

/** A task programmato: an instruction the instance runs by itself, delivered to a thread. */
export type Schedule = {
	readonly id: string;
	readonly instruction: string;
	readonly channel: string;
	readonly threadId: string;
	readonly when: { readonly at: string } | { readonly cron: string; readonly timeZone: string };
	/** Next time it fires; null once a one-off has run. */
	readonly nextRunAt: string | null;
	readonly lastRunAt?: string;
	/** Why it stopped firing by itself (its person is no longer allowed). */
	readonly disabledReason?: string;
	readonly createdBy: { readonly kind: "person"; readonly channel: string; readonly userId: string } | { readonly kind: "instance" };
	readonly createdAt: string;
	/** A brief del mattino: one per person and instance, turned on and off from the console. */
	readonly kind?: "brief";
};

export type NewSchedule = {
	readonly instruction: string;
	readonly channel: string;
	readonly threadId: string;
	readonly when: Schedule["when"];
	readonly createdBy: Schedule["createdBy"];
	readonly kind?: "brief";
};

/** Limits that keep a runaway instance from flooding itself. The cap counts the tasks still to run: one ended or stopped is kept to be seen, not counted. */
export const SCHEDULE_LIMITS = { maxPerInstance: 50, minIntervalMinutes: 5, maxInstructionChars: 2000 } as const;

export class ScheduleError extends Error {
	override readonly name = "ScheduleError";
}

/** The schedules of one instance: one JSON file each, written atomically. */
export class ScheduleStore {
	constructor(private readonly dir: string) {}

	async create(input: NewSchedule, now = new Date()): Promise<Schedule> {
		if (input.instruction.trim() === "") throw new ScheduleError("Empty instruction");
		if (input.instruction.length > SCHEDULE_LIMITS.maxInstructionChars) throw new ScheduleError(`Instruction over ${SCHEDULE_LIMITS.maxInstructionChars} characters`);
		const all = await this.list();
		if (all.filter((s) => s.nextRunAt !== null).length >= SCHEDULE_LIMITS.maxPerInstance) throw new ScheduleError(`At most ${SCHEDULE_LIMITS.maxPerInstance} schedules per instance`);
		const nextRunAt = firstRun(input.when, now);
		const schedule: Schedule = { ...input, id: randomBytes(6).toString("hex"), nextRunAt, createdAt: now.toISOString() };
		await this.save(schedule);
		return schedule;
	}

	async get(id: string): Promise<Schedule | undefined> {
		try {
			return JSON.parse(await readFile(this.file(id), "utf8")) as Schedule;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async list(): Promise<Schedule[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const all = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => this.get(n.slice(0, -5))));
		return all.filter((s): s is Schedule => s !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async remove(id: string): Promise<boolean> {
		if (!/^[0-9a-f]{12}$/.test(id)) return false;
		try {
			await unlink(this.file(id));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/** Due at `now`: nextRunAt reached. */
	async due(now: Date): Promise<Schedule[]> {
		return (await this.list()).filter((s) => s.nextRunAt !== null && Date.parse(s.nextRunAt) <= now.getTime());
	}

	/**
	 * Record that the run planned for `ranFor` happened. A one-off ends; a recurring one moves
	 * to its first run after `now`, so a long downtime gives one catch-up run, not many.
	 */
	async advance(schedule: Schedule, ranFor: string, now: Date): Promise<Schedule> {
		const next = "at" in schedule.when ? null : nextDistinctRun(parseCron(schedule.when.cron), now, schedule.when.timeZone, new Date(ranFor)).toISOString();
		const updated: Schedule = { ...schedule, nextRunAt: next, lastRunAt: ranFor };
		await this.update(updated);
		return updated;
	}

	/** Stop it for good, keeping it visible with the reason. */
	async disable(schedule: Schedule, reason: string): Promise<Schedule> {
		const updated: Schedule = { ...schedule, nextRunAt: null, disabledReason: reason };
		await this.update(updated);
		return updated;
	}

	private save(schedule: Schedule): Promise<void> {
		return writeFileAtomic(this.file(schedule.id), `${JSON.stringify(schedule, null, 2)}\n`);
	}

	/** A schedule deleted meanwhile (or its agente, ADR 0046) is not written back. */
	private async update(schedule: Schedule): Promise<void> {
		if ((await this.get(schedule.id)) !== undefined) await this.save(schedule);
	}

	private file(id: string): string {
		return join(this.dir, `${id}.json`);
	}
}

/**
 * The person a schedule acts for: its creator, or else the person whose conversation it
 * writes to (a Telegram private chat, a WhatsApp chat, a web thread). Undefined: nobody to answer for it.
 */
export function schedulePerson(schedule: Schedule): { channel: string; userId: string } | undefined {
	return threadPerson(schedule);
}

/** The same rule for anything that writes to a conversation by itself (a schedule, a sentinella). */
export function threadPerson(item: { readonly createdBy: Schedule["createdBy"]; readonly channel: string; readonly threadId: string }): { channel: string; userId: string } | undefined {
	if (item.createdBy.kind === "person") return { channel: item.createdBy.channel, userId: item.createdBy.userId };
	if (item.channel === "telegram" && /^\d+$/.test(item.threadId)) return { channel: "telegram", userId: item.threadId };
	// A WhatsApp chat is one person, whose number is the thread.
	if (item.channel === "whatsapp" && /^\d+$/.test(item.threadId)) return { channel: "whatsapp", userId: item.threadId };
	// A phone conversation is the caller's number.
	if (item.channel === "phone" && /^\+\d{7,15}$/.test(item.threadId)) return { channel: "phone", userId: item.threadId };
	const owner = item.threadId.split(".")[0] ?? "";
	if (item.channel === "web" && /^p_[0-9a-f]{12}$/.test(owner)) return { channel: "web", userId: owner };
	return undefined;
}

function firstRun(when: Schedule["when"], now: Date): string {
	if ("at" in when) {
		const at = Date.parse(when.at);
		if (Number.isNaN(at)) throw new ScheduleError(`Not a date: ${when.at}`);
		if (at < now.getTime() - 60_000) throw new ScheduleError(`In the past: ${when.at}`);
		return new Date(at).toISOString();
	}
	try {
		assertTimeZone(when.timeZone);
	} catch {
		throw new ScheduleError(`Unknown time zone: ${when.timeZone}`);
	}
	let cron;
	try {
		cron = parseCron(when.cron);
	} catch (error) {
		throw new ScheduleError(error instanceof Error ? error.message : String(error));
	}
	let first: Date;
	try {
		first = nextRun(cron, now, when.timeZone);
	} catch (error) {
		throw new ScheduleError(error instanceof Error ? error.message : String(error));
	}
	// Every gap over a week, not just the first: "0,59 0,23 * * *" runs at 23:59 and 00:00.
	const minGap = SCHEDULE_LIMITS.minIntervalMinutes * 60_000;
	const horizon = first.getTime() + 7 * 24 * 60 * 60_000;
	let previous = first;
	for (let i = 0; i < 3000 && previous.getTime() < horizon; i++) {
		const next = nextDistinctRun(cron, previous, when.timeZone, previous);
		if (next.getTime() - previous.getTime() < minGap) throw new ScheduleError(`Runs more often than every ${SCHEDULE_LIMITS.minIntervalMinutes} minutes`);
		previous = next;
	}
	return first.toISOString();
}
