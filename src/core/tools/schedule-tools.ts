import { AGENT_CHANNEL } from "../agent-messages.ts";
import { Type } from "@earendil-works/pi-ai";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { ScheduleError, type ScheduleStore } from "../schedules.ts";

type ScheduleToolsOptions = { readonly store: ScheduleStore; readonly defaultTimeZone: string; readonly now?: () => Date };

/** Why nothing can be scheduled in a conversation: none, another agente's request, a phone call. */
export type ScheduleRefusal = "no_thread" | "agent" | "phone";

/**
 * Whether a task programmato can be made here. Owni never calls first, so a task set on a call
 * would only be heard at the next one; a colleague's question gets an answer, not a task: nobody
 * in that conversation could receive it.
 */
export function scheduleRefusal(thread: { readonly channel: string } | undefined): ScheduleRefusal | undefined {
	if (thread === undefined) return "no_thread";
	if (thread.channel === AGENT_CHANNEL) return "agent";
	if (thread.channel === "phone") return "phone";
	return undefined;
}

/**
 * Tools to create, list and delete tasks programmati. A task created in a conversation
 * delivers its results to that same conversation.
 */
export function createScheduleTools(options: ScheduleToolsOptions): OwniTool[] {
	const { store } = options;
	const now = options.now ?? (() => new Date());
	const tools: OwniTool[] = [
		defineOwniTool({
			name: "schedule_create",
			description:
				"Schedule an instruction for yourself to run later, once (at) or repeatedly (cron), with the result sent to this conversation. " +
				"Use it for reminders and recurring reports; to be told when a page or a price changes, use watch_create instead; cron has 5 fields in the given time zone, e.g. '30 8 * * 1-5' = weekdays at 8:30.",
			parameters: Type.Object(
				{
					instruction: Type.String({ description: "What to do when it fires, written as a request to yourself", minLength: 1, maxLength: 2000 }),
					at: Type.Optional(Type.String({ description: "ISO 8601 date-time for a one-off run, with offset, e.g. 2026-10-20T09:00:00+02:00" })),
					cron: Type.Optional(Type.String({ description: "5-field cron for a recurring run" })),
					timeZone: Type.Optional(Type.String({ description: `IANA time zone for cron (default ${options.defaultTimeZone})` })),
				},
				{ additionalProperties: false },
			),
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
								instruction: args.instruction,
								channel: thread.channel,
								threadId: thread.threadId,
								when: args.at !== undefined ? { at: args.at } : { cron: String(args.cron), timeZone: args.timeZone ?? options.defaultTimeZone },
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
		}),
		defineOwniTool({
			name: "schedule_list",
			description: "List your tasks programmati with their next run.",
			parameters: Type.Object({}, { additionalProperties: false }),
			replaySafe: true,
			async execute() {
				const all = await store.list();
				if (all.length === 0) return "Nessun task programmato.";
				return all
					.map((s) => `${s.id}\t${"at" in s.when ? `una volta ${s.when.at}` : `cron ${s.when.cron} (${s.when.timeZone})`}\tprossima: ${s.nextRunAt ?? "finito"}\t${s.instruction.slice(0, 120)}`)
					.join("\n");
			},
		}),
		defineOwniTool({
			name: "schedule_delete",
			description: "Delete a task programmato by its ID.",
			parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
			replaySafe: true,
			async execute(args) {
				return (await store.remove(args.id)) ? `Eliminato il task ${args.id}.` : `Nessun task con ID ${args.id}.`;
			},
		}),
	];
	return tools;
}
