import { AGENT_CHANNEL } from "../agent-messages.ts";
import { nextRun, parseCron } from "../cron.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import { addDays, todayIn } from "../italian-calendar.ts";
import { ScheduleError, type ScheduleStore, schedulePerson, threadPerson } from "../schedules.ts";

/** `whoIs`: the person a conversation is with («telegram:123»), so a reminder acts for them (memory.ts Participants). */
type ScheduleToolsOptions = { readonly store: ScheduleStore; readonly defaultTimeZone: string; readonly now?: () => Date; readonly whoIs?: (thread: { channel: string; threadId: string }) => string | undefined };

/** Why nothing can be scheduled in a conversation: none, another agente's request, a phone call. */
export type ScheduleRefusal = "no_thread" | "agent" | "phone";

/**
 * Whether a task programmato can be made here, one rule for schedule_create and the reminders of
 * other tools. Owni never calls first, so a reminder set on a call would only be heard at the next
 * one; a colleague's question gets an answer, not a task: nobody in that conversation could receive it.
 */
export function scheduleRefusal(thread: { readonly channel: string } | undefined): ScheduleRefusal | undefined {
	if (thread === undefined) return "no_thread";
	if (thread.channel === AGENT_CHANNEL) return "agent";
	if (thread.channel === "phone") return "phone";
	return undefined;
}

/** A reminder another tool makes for the person: on `day` (ISO) at `hour` where the instance is, in the call's conversation. */
export type ReminderInput = { readonly day: string; readonly hour: number; readonly instruction: string };

/** A reminder made: its task's id, when it fires, and the call key it was made with (what `cancel` checks). */
export type Reminder = { readonly id: string; readonly at: string; readonly call: string };

/** What `cancel` did: removed it, it was gone already (fired, or deleted), or the task with that id is not this reminder. */
export type Cancelled = "removed" | "gone" | "not_ours";

/** The key of a ricontatto's reminder: «follow_up:FU-0001», one per ricontatto, so a call run again never finds a reminder naming another one. What `cancel` accepts. */
export function reminderKey(followUp: string): string {
	return `follow_up:${followUp}`;
}
const REMINDER_CALL = /:follow_up:FU-\d{4,6}$/;

/**
 * The tasks programmati for another tool (a client's ricontatto): the same store as
 * schedule_create, with their own cap, and the same refusals (scheduleRefusal). `remind` makes a
 * one-off task for the person of the conversation, keyed by the calling tool's callId and `key`,
 * so a call run again finds the one it made instead of making another; refused when the
 * conversation has no single person (a group, someone unknown). `cancel` removes one only when it
 * is the reminder made with `call`. `briefActive`: whether the person of this conversation has a brief del mattino on.
 */
export type ReminderSeam = {
	readonly remind: (input: ReminderInput, key: string, ctx: ToolContext) => Promise<Reminder | { readonly problem: string }>;
	readonly cancel: (id: string, call: string) => Promise<Cancelled>;
	readonly briefActive: (ctx: ToolContext) => Promise<boolean>;
};

/**
 * Tools to create, list and delete tasks programmati. A task created in a conversation
 * delivers its results to that same conversation.
 */
export function createScheduleTools(options: ScheduleToolsOptions): OwniTool[] {
	return schedulesOf(options).tools;
}

const REMINDER_REFUSED: Readonly<Record<ScheduleRefusal, string>> = {
	no_thread: "un promemoria va creato in una conversazione",
	agent: "in una richiesta di un altro agente non programmo promemoria",
	phone: "al telefono non programmo promemoria, perché non chiamo per prima",
};

/** The schedule tools, and the same schedules' reminders for another tool. */
export function schedulesOf(options: ScheduleToolsOptions): { readonly tools: OwniTool[]; readonly reminders: ReminderSeam } {
	const { store } = options;
	const now = options.now ?? (() => new Date());
	const timeZone = options.defaultTimeZone;
	/** The one person a conversation is with: whom it was learned to be with, else whom its id names. */
	const personOf = (thread: { channel: string; threadId: string }): { channel: string; userId: string } | undefined => {
		const subject = options.whoIs?.(thread);
		const colon = subject === undefined ? -1 : subject.indexOf(":");
		if (subject !== undefined && colon > 0 && colon < subject.length - 1) return { channel: subject.slice(0, colon), userId: subject.slice(colon + 1) };
		return threadPerson({ createdBy: { kind: "instance" }, channel: thread.channel, threadId: thread.threadId });
	};
	const reminders: ReminderSeam = {
		async remind(input, key, ctx) {
			const refused = scheduleRefusal(ctx.thread);
			if (refused !== undefined || ctx.thread === undefined) return { problem: REMINDER_REFUSED[refused ?? "no_thread"] };
			const thread = ctx.thread;
			const person = personOf(thread);
			if (person === undefined) return { problem: "questa conversazione non è con una sola persona, e un promemoria va a qualcuno" };
			// Once per call and key: the task made carries them, so a call run again finds it.
			const call = `${ctx.callId}:${key}`;
			const made = (await store.list()).find((s) => s.callId === call);
			if (made !== undefined) return { id: made.id, at: made.nextRunAt ?? ("at" in made.when ? made.when.at : ""), call };
			const at = reminderTime(input, now(), timeZone);
			if (at === undefined) return { problem: "il giorno del promemoria è già passato" };
			try {
				const s = await store.create({ instruction: input.instruction, channel: thread.channel, threadId: thread.threadId, when: { at: at.toISOString() }, createdBy: { kind: "person", channel: person.channel, userId: person.userId }, callId: call }, now());
				return { id: s.id, at: s.nextRunAt ?? at.toISOString(), call };
			} catch (error) {
				if (error instanceof ScheduleError) return { problem: "non ho potuto programmare il promemoria: ce ne sono già troppi, o la data non va" };
				throw error;
			}
		},
		async cancel(id, call) {
			const s = await store.get(id).catch(() => undefined);
			if (s === undefined) return "gone";
			// Only a reminder of this seam, and only the one made with that call: never a task of the person's.
			if (!REMINDER_CALL.test(call) || s.callId !== call) return "not_ours";
			return (await store.remove(id)) ? "removed" : "gone";
		},
		async briefActive(ctx) {
			const person = ctx.thread === undefined ? undefined : personOf(ctx.thread);
			if (person === undefined) return false;
			return (await store.list()).some((s) => {
				const owner = s.kind === "brief" && s.nextRunAt !== null ? schedulePerson(s) : undefined;
				return owner !== undefined && owner.channel === person.channel && owner.userId === person.userId;
			});
		},
	};
	const tools: OwniTool[] = [
		{
			name: "schedule_create",
			description:
				"Schedule an instruction for yourself to run later, once (at) or repeatedly (cron), with the result sent to this conversation. " +
				"Use it for reminders and recurring reports; to be told when a page or a price changes, use watch_create instead; for an invoice that repeats to a customer, use recurring_invoices, not this. Not for these, which have their own tool: ricontattare un cliente (clients follow_up), i promemoria ai clienti per gli appuntamenti di domani (appointments reminders), un rinnovo o un abbonamento che scade (renewals). cron has 5 fields in the given time zone, e.g. '30 8 * * 1-5' = weekdays at 8:30.",
			parameters: {
				type: "object",
				properties: {
					instruction: { type: "string", description: "What to do when it fires, written as a request to yourself", minLength: 1, maxLength: 2000 },
					at: { type: "string", description: "ISO 8601 date-time for a one-off run, with offset, e.g. 2026-10-20T09:00:00+02:00" },
					cron: { type: "string", description: "5-field cron for a recurring run" },
					timeZone: { type: "string", description: `IANA time zone for cron (default ${options.defaultTimeZone})` },
				},
				required: ["instruction"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const refused = scheduleRefusal(ctx.thread);
				if (refused === "no_thread" || ctx.thread === undefined) return "Errore: un task programmato va creato in una conversazione.";
				const thread = ctx.thread;
				if (refused === "agent") return "Errore: in una richiesta di un altro agente non posso programmare task. Rispondi a quello che chiede; il task lo crea chi te l'ha chiesto, nella sua conversazione.";
				if (refused === "phone") return "Errore: al telefono non posso programmare task, perché non chiamo per prima. Chiedi alla persona di farlo su Telegram, WhatsApp o nella console.";
				if ((args.at === undefined) === (args.cron === undefined)) return "Errore: indica at (una volta) oppure cron (ripetuto), non entrambi.";
				// Once per call, also when the call reruns after a crash.
				const result = await ctx.step("create", async () => {
					try {
						const s = await store.create(
							{
								instruction: String(args.instruction),
								channel: thread.channel,
								threadId: thread.threadId,
								when: args.at !== undefined ? { at: String(args.at) } : { cron: String(args.cron), timeZone: typeof args.timeZone === "string" ? args.timeZone : options.defaultTimeZone },
								createdBy: { kind: "instance" },
							},
							now(),
						);
						return `Creato il task ${s.id}: prossima esecuzione ${s.nextRunAt}.`;
					} catch (error) {
						if (error instanceof ScheduleError) return `Errore: ${error.message}`;
						throw error;
					}
				});
				return result;
			},
		},
		{
			name: "schedule_list",
			description: "List your tasks programmati with their next run.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute() {
				const all = await store.list();
				if (all.length === 0) return "Nessun task programmato.";
				return all
					.map((s) => `${s.id}\t${"at" in s.when ? `una volta ${s.when.at}` : `cron ${s.when.cron} (${s.when.timeZone})`}\tprossima: ${s.nextRunAt ?? "finito"}\t${s.instruction.slice(0, 120)}`)
					.join("\n");
			},
		},
		{
			name: "schedule_delete",
			description: "Delete a task programmato by its ID.",
			parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
			replaySafe: true,
			async execute(args) {
				return (await store.remove(String(args.id))) ? `Eliminato il task ${String(args.id)}.` : `Nessun task con ID ${String(args.id)}.`;
			},
		},
	];
	return { tools, reminders };
}

/** The instant of `hour` on `day` where the instance is; for today past that hour, in two minutes; undefined for a day gone. */
function reminderTime(input: ReminderInput, now: Date, timeZone: string): Date | undefined {
	const today = todayIn(timeZone, now);
	if (input.day < today) return undefined;
	const [, month, day] = input.day.split("-").map(Number);
	// From the day before (never before now), so a day next year is not taken for this year's.
	const from = new Date(Math.max(now.getTime(), Date.parse(`${addDays(input.day, -1)}T12:00:00Z`)));
	const next = nextRun(parseCron(`0 ${input.hour} ${day} ${month} *`), from, timeZone);
	if (todayIn(timeZone, next) === input.day) return next;
	return input.day === today ? new Date(now.getTime() + 2 * 60_000) : undefined;
}
