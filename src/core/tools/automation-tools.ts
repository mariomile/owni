import { type Automation, AutomationError, AUTOMATION_LIMITS, type AutomationStore } from "../automations.ts";
import { AGENT_CHANNEL } from "../agent-messages.ts";
import type { OwniTool } from "../engine.ts";

type Thread = { readonly channel: string; readonly threadId: string };

/**
 * Tools for the automazioni of an agente (ADR 0060): make one for the person in this
 * conversation, list theirs, delete one. Only in a conversation with one person, who is the one
 * it acts for. The address with its token goes to the person in a message of its own, never to
 * the model: what the agente reads cannot leak it.
 */
export function createAutomationTools(options: {
	readonly store: AutomationStore;
	/** The person a private conversation is with, "<channel>:<userId>"; undefined in a group or unknown thread. */
	readonly whoIs: (thread: Thread) => string | undefined;
	/** Where the server answers from outside (OWNI_PUBLIC_URL); without it the address is a path. */
	readonly baseUrl?: string;
	/** Send the address to the person, through the outbox; the same key is sent once. */
	readonly tell: (thread: Thread, text: string, key: string) => Promise<void>;
	readonly record?: (event: { type: "automation.created" | "automation.deleted"; automationId: string; channel: string; userId: string }) => Promise<void>;
	readonly instance: string;
}): OwniTool[] {
	const { store } = options;
	const person = (thread: Thread | undefined) => {
		const subject = thread === undefined ? undefined : options.whoIs(thread);
		const at = subject?.indexOf(":") ?? -1;
		return subject === undefined || at < 1 ? undefined : { channel: subject.slice(0, at), userId: subject.slice(at + 1) };
	};
	const notPrivate = "Errore: le automazioni si creano e si cancellano solo in una conversazione con una persona sola.";
	const theirs = (a: Automation, p: { channel: string; userId: string }) => a.person.channel === p.channel && a.person.userId === p.userId;
	const address = (a: Automation) => `${options.baseUrl ?? ""}/hooks/automazione/${options.instance}/${a.id}`;
	return [
		{
			name: "automation_create",
			description:
				"Create an automazione for the person you are talking to: a secret web address another service (a form on their site, Stripe, Zapier, Make, a shop) calls with a POST, " +
				"and every call makes you run `instruction` with the data it sends, answering in this conversation. Use it when they want something to happen whenever an event occurs elsewhere " +
				"(«quando arriva un ordine...», «ogni volta che qualcuno compila il modulo...»); for something at a time of day use schedule_create. " +
				`The address goes to the person in a separate message, not to you. At most ${AUTOMATION_LIMITS.perHour} calls an hour each.`,
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.name, description: "Short name: «Nuovi ordini dal sito»" },
					instruction: { type: "string", minLength: 1, maxLength: AUTOMATION_LIMITS.instruction, description: "What to do with each call's data, as the person said it" },
				},
				required: ["name", "instruction"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				const p = person(ctx.thread);
				const thread = ctx.thread;
				if (p === undefined || thread === undefined) return notPrivate;
				// The answers and the token must be readable later: not in a call, not to another agente.
				if (thread.channel === "phone" || thread.channel === AGENT_CHANNEL) return "Errore: un'automazione si crea in una chat scritta (console, Telegram, WhatsApp), dove arrivano l'indirizzo e le risposte; non durante una chiamata.";
				return ctx.step("create", async () => {
					try {
						const { automation, token } = store.create({ name: String(args.name), instruction: String(args.instruction), channel: thread.channel, threadId: thread.threadId, person: p });
						await options.record?.({ type: "automation.created", automationId: automation.id, ...p });
						const url = address(automation);
						try {
							await options.tell(
								thread,
								`Automazione «${automation.name}» pronta. A ogni chiamata farò: ${automation.instruction}\n\nIl servizio deve chiamare con una POST:\n${url}\ncon l'intestazione\nAuthorization: Bearer ${token}\n(se il servizio non permette intestazioni, aggiungi ?token=${token} all'indirizzo). Tieni il token per te: chi lo ha può far lavorare l'agente. Se non è quello che volevi, chiedimi di cancellarla.${options.baseUrl === undefined ? "\nL'indirizzo va preceduto da quello pubblico del server." : ""}`,
								`automation:${automation.id}`,
							);
						} catch (error) {
							// A token nobody received is an automazione nobody can use.
							store.remove(automation.id, () => true);
							throw error;
						}
						return `Creata l'automazione «${automation.name}» (id ${automation.id}). Ho mandato alla persona, in un messaggio a parte, l'indirizzo e il token da dare al servizio: dille di guardarlo lì. Tu non li vedi.`;
					} catch (error) {
						if (error instanceof AutomationError) return `Errore: ${error.message}`;
						throw error;
					}
				});
			},
		},
		{
			name: "automation_list",
			description: "List the automazioni of the person you are talking to: name, id, what they do, how many calls, the last one.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			replaySafe: true,
			async execute(_args, ctx) {
				const p = person(ctx.thread);
				if (p === undefined) return notPrivate;
				const mine = store.list().filter((a) => theirs(a, p));
				if (mine.length === 0) return "Nessuna automazione.";
				return mine.map((a) => `${a.id} «${a.name}»: ${a.instruction} (chiamate: ${a.runs}${a.lastRunAt === undefined ? "" : `, l'ultima ${a.lastRunAt}`})`).join("\n");
			},
		},
		{
			name: "automation_delete",
			description: "Delete an automazione of the person you are talking to, by id: its address stops working at once. Also the way to get a new token: delete and create again.",
			parameters: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
			replaySafe: true,
			async execute(args, ctx) {
				const p = person(ctx.thread);
				if (p === undefined) return notPrivate;
				return ctx.step("delete", async () => {
					const removed = store.remove(String(args.id), (a) => theirs(a, p));
					if (removed === undefined) return `Non trovo una tua automazione ${String(args.id)}.`;
					await options.record?.({ type: "automation.deleted", automationId: removed.id, ...p });
					return `Cancellata l'automazione «${removed.name}»: il suo indirizzo non funziona più.`;
				});
			},
		},
	];
}
