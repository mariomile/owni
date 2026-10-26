import { Type } from "@earendil-works/pi-ai";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { threadPerson } from "../schedules.ts";
import { untrusted } from "../untrusted.ts";
import { firstLook, formatNumber, type Watch, WatchError, WATCH_LIMITS, type WatchStore, watchUrl } from "../watches.ts";

export type WatchToolsOptions = {
	readonly store: WatchStore;
	/** Read a page under the instance's policy (readPage with its guard). */
	readonly read: (url: string) => Promise<{ title: string; text: string }>;
	/** One line in the audit per sentinella created or deleted: its ID and site, never the page. */
	readonly record?: (event: { type: "watch.created" | "watch.deleted"; watchId: string; host: string }) => Promise<void>;
	readonly now?: () => Date;
};

/**
 * Tools to create, list and delete sentinelle (ADR 0018): pages the instance checks by itself and
 * reports on in this conversation when they change, or when a price crosses a threshold. Each
 * conversation sees and deletes only the sentinelle of its own person.
 */
export function createWatchTools(options: WatchToolsOptions): OwniTool[] {
	const { store } = options;
	const now = options.now ?? (() => new Date());
	const record = options.record ?? (async () => {});
	/** The person of a conversation, and the sentinelle that write to them. */
	const theirs = async (thread: { channel: string; threadId: string } | undefined) => {
		const person = thread === undefined ? undefined : threadPerson({ createdBy: { kind: "instance" }, ...thread });
		if (person === undefined) return [];
		return (await store.list()).filter((w) => {
			const who = threadPerson(w);
			return who?.channel === person.channel && who.userId === person.userId;
		});
	};
	return [
		defineOwniTool({
			name: "watch_create",
			description:
				"Watch a web page and write to this conversation by yourself when it changes. Use it, not schedule_create, whenever someone asks to be told when something changes: " +
				"'avvisami quando cambia', 'quando scende sotto 50 €', 'quando torna disponibile', 'quando escono i risultati'. " +
				"what: the phrase right before what to watch (product name, 'Prezzo', 'Disponibilità'); set it whenever you can, since a whole page changes for banners and counters too. " +
				"below/above: write only when the price right after `what` goes under/over this number (needs what). " +
				`everyMinutes: how often to check, ${WATCH_LIMITS.minEveryMinutes} to ${WATCH_LIMITS.maxEveryMinutes} (default ${WATCH_LIMITS.defaultEveryMinutes}). Only sites the owner allowed. ` +
				"Tell the person what you read now, so they can check it is the right thing.",
			parameters: Type.Object(
				{
					url: Type.String({ minLength: 8, maxLength: 2000 }),
					what: Type.Optional(Type.String({ maxLength: WATCH_LIMITS.maxWhatChars })),
					below: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
					above: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
					everyMinutes: Type.Optional(Type.Integer({ minimum: WATCH_LIMITS.minEveryMinutes, maximum: WATCH_LIMITS.maxEveryMinutes })),
				},
				{ additionalProperties: false },
			),
			replaySafe: true,
			async execute(args, ctx) {
				if (ctx.thread === undefined) return "Errore: una sentinella va creata in una conversazione.";
				const thread = ctx.thread;
				// Owni never calls first: what a sentinella sees would only be heard at the next call.
				if (thread.channel === "phone") return "Errore: al telefono non posso creare sentinelle, perché non chiamo per prima. Chiedi alla persona di farlo su Telegram, WhatsApp o nella console.";
				// It writes by itself for someone: in a group there is nobody it acts for, so it would never write.
				if (threadPerson({ createdBy: { kind: "instance" }, ...thread }) === undefined) return "Errore: le sentinelle si creano in una chat privata con la persona da avvisare (o nella console), non in un gruppo.";
				const input = defined({
					what: args.what !== undefined && args.what.trim() !== "" ? args.what.replace(/\s+/g, " ").trim() : undefined,
					below: args.below,
					above: args.above,
				});
				if ((input.below !== undefined || input.above !== undefined) && input.what === undefined) return "Errore: per un avviso sul prezzo indica in what la frase che sta subito prima del prezzo, per esempio «Prezzo» o il nome del prodotto.";
				// Once per call, also when the call reruns after a crash.
				return ctx.step("create", async () => {
					try {
						const url = watchUrl(args.url);
						const at = now();
						// The first look now: the person learns at once whether the page and the price are readable.
						const first = await firstLook(options.read, url, input, at);
						const w = await store.create({ url, ...input, ...(args.everyMinutes === undefined ? {} : { everyMinutes: args.everyMinutes }), channel: thread.channel, threadId: thread.threadId, createdBy: { kind: "instance" }, last: first }, at);
						await record({ type: "watch.created", watchId: w.id, host: new URL(w.url).host });
						return describeNew(w, first);
					} catch (error) {
						if (error instanceof WatchError) return `Errore: ${error.message}.`;
						throw error;
					}
				});
			},
		}),
		defineOwniTool({
			name: "watch_list",
			description: "List the sentinelle (watched pages) of the person you are talking to, with what they watch and their last check.",
			parameters: Type.Object({}, { additionalProperties: false }),
			replaySafe: true,
			async execute(_args, ctx) {
				const all = await theirs(ctx.thread);
				if (all.length === 0) return "Nessuna sentinella per questa persona.";
				// The last error may name a site the page redirected to: it is data, inside the fence.
				return all.map((w) => `${w.id}\t${w.url}\t${condition(w)}\togni ${w.everyMinutes} min\t${state(w)}`).join("\n");
			},
		}),
		defineOwniTool({
			name: "watch_delete",
			description: "Delete a sentinella of the person you are talking to, by its ID.",
			parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
			replaySafe: true,
			async execute(args, ctx) {
				const watch = (await theirs(ctx.thread)).find((w) => w.id === args.id);
				if (watch === undefined || !(await store.remove(watch.id))) return `Nessuna sentinella con ID ${args.id}.`;
				await record({ type: "watch.deleted", watchId: watch.id, host: new URL(watch.url).host });
				return `Eliminata la sentinella ${watch.id}.`;
			},
		}),
	];
}

function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** What it tells about, in words. */
export function condition(w: Pick<Watch, "what" | "below" | "above">): string {
	const near = w.what === undefined ? "" : ` dopo «${w.what}»`;
	if (w.below !== undefined && w.above !== undefined) return `prezzo${near} sotto ${formatNumber(w.below)} o sopra ${formatNumber(w.above)}`;
	if (w.below !== undefined) return `prezzo${near} sotto ${formatNumber(w.below)}`;
	if (w.above !== undefined) return `prezzo${near} sopra ${formatNumber(w.above)}`;
	return w.what === undefined ? "qualsiasi cambiamento della pagina" : `cambiamenti vicino a «${w.what}»`;
}

function state(w: Watch): string {
	if (w.disabledReason !== undefined) return `ferma: ${w.disabledReason}`;
	const last = w.lastCheckAt === undefined ? "mai controllata" : `ultimo controllo ${w.lastCheckAt}`;
	const price = w.last?.side === "missing" ? ", prezzo non visibile" : w.last?.price === undefined ? "" : `, prezzo ${formatNumber(w.last.price)}`;
	return `${last}${price}${w.lastError === undefined ? "" : `, ultimo errore: ${w.lastError}`}`;
}

function describeNew(w: Watch, first: { price?: number; side?: string; excerpt: string }): string {
	const head = `Sentinella ${w.id} attiva su ${new URL(w.url).host}: ${condition(w)}, controllo ogni ${w.everyMinutes} minuti. Scrivo qui quando c'è qualcosa.`;
	const whatsapp = w.channel === "whatsapp" ? "\nSu WhatsApp un avviso arriva subito solo entro 24 ore dall'ultimo messaggio della persona: dopo, può restare in attesa finché non scrive. Diglielo." : "";
	const price = first.price === undefined ? "" : `\nPrezzo letto adesso: ${formatNumber(first.price)}.${first.side === "below" || first.side === "above" ? " La condizione è già vera adesso: dillo alla persona." : ""}`;
	const seen = first.excerpt === "" ? "" : `\n${untrusted(`Quello che guardo adesso: ${first.excerpt}`)}`;
	return `${head}${price}${seen}${whatsapp}`;
}
