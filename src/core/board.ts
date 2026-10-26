import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { todayIn } from "./italian-calendar.ts";
import { italianDay } from "./italian-format.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";

/**
 * The board (ADR 0050): the tenant's schede, in four columns, each assignable to an agente.
 * One board per tenant, because a scheda moves between agenti. A scheda assigned to an agente is
 * worked in a console conversation of that agente with the person who handed it over; the
 * agente moves it to «Da rivedere» and a person moves it to «Fatto».
 */
export const CARD_STATUSES = ["da_fare", "in_corso", "da_rivedere", "fatto"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const STATUS_LABEL: Record<CardStatus, string> = { da_fare: "Da fare", in_corso: "In corso", da_rivedere: "Da rivedere", fatto: "Fatto" };

export const CARD_PRIORITIES = ["bassa", "normale", "alta"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

/** Who did something: a person of the console or an agente, by ID. */
export type CardActor = { readonly kind: "person" | "agent"; readonly id: string };

export type CardEvent = {
	readonly at: string;
	readonly by: CardActor;
	readonly kind: "created" | "status" | "assigned" | "comment" | "edited" | "check";
	readonly status?: CardStatus;
	/** The agente assigned; null: nobody. */
	readonly assignee?: string | null;
	/** A «check» (ADR 0075): the item ticked (true) or unticked (false); with neither, added, or removed when `removed`. */
	readonly done?: boolean;
	readonly removed?: true;
	/** An «edited» that moved the scadenza (ADR 0073): the new day; null: taken off. */
	readonly due?: string | null;
	/** An «edited» that changed what it comes after (ADR 0076): their numbers; empty: nothing. */
	readonly after?: readonly number[];
	readonly text?: string;
};

export type Card = {
	readonly id: string;
	/** Shown as #n: short to say in chat. */
	readonly n: number;
	readonly title: string;
	readonly description: string;
	readonly status: CardStatus;
	readonly priority: CardPriority;
	/** The agente it is assigned to. */
	readonly assignee?: string;
	/** The conversation of the assignee where it is worked, and the person it is with. */
	readonly work?: { readonly agent: string; readonly threadId: string; readonly personId: string };
	/** «Esegui da solo» (ADR 0061): the agente is told to go on after each reply, `rounds` times so far since `since`. */
	readonly auto?: {
		/** Replies of the agente since it started alone (or was sent back). */
		readonly rounds: number;
		readonly since: string;
		/** The last reply counted: one handed over again after a restart is not counted twice. */
		readonly last?: string;
	};
	/** The scheda this one is part of (ADR 0066): one level only, so a sotto-scheda has none of its own. */
	readonly parent?: string;
	/** By when it should be done (ADR 0073): a day in Rome, YYYY-MM-DD. */
	readonly due?: string;
	/** What to do, in steps (ADR 0075): ticked by a person or by the agente working on it. */
	readonly checklist?: readonly CheckItem[];
	/** The scadenza already told about (ADR 0074): a moved scadenza is told again. */
	readonly dueNoticed?: string;
	/** The schede that must be «Fatto» before this one starts (ADR 0076), by ID. */
	readonly after?: readonly string[];
	/** Started while those were open (ADR 0076): it starts by itself with this person when they are all «Fatto». */
	readonly queued?: { readonly personId: string; readonly by: CardActor; readonly auto?: true };
	readonly createdBy: CardActor;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Newest last, the latest BOARD_LIMITS.events. */
	readonly events: readonly CardEvent[];
};

export type CheckItem = { readonly id: string; readonly text: string; readonly done: boolean };

/** One change to the checklist: an item added, ticked, unticked or removed (by its id, or its number from 1). */
export type CheckChange = { readonly add: string } | { readonly item: string; readonly done: boolean } | { readonly item: string; readonly remove: true };

type BoardFile = {
	readonly next: number;
	readonly cards: readonly Card[];
	/** The week (Rome, «2026-10-19», its Monday) whose summary was sent (ADR 0081). */
	readonly digest?: string;
};

export const BOARD_LIMITS = {
	/** Schede not yet «Fatto». */
	open: 300,
	/** «Fatto» schede kept, the most recent. */
	done: 200,
	title: 120,
	description: 4000,
	comment: 2000,
	events: 100,
	/** «Esegui da solo»: at most this many «go on» per start, and for at most this long. */
	autoRounds: 10,
	autoMs: 2 * 60 * 60 * 1000,
	/** Sotto-schede not yet «Fatto» under one scheda. */
	children: 10,
	/** Items of a checklist, and the length of each. */
	checklist: 30,
	checkItem: 200,
	/** Schede one comes after. */
	after: 5,
} as const;

export class BoardError extends Error {
	override readonly name = "BoardError";
}

export type CardChange = {
	readonly title?: string;
	readonly description?: string;
	readonly priority?: CardPriority;
	/** A day, YYYY-MM-DD; null: no scadenza. */
	readonly due?: string | null;
	readonly status?: CardStatus;
	/** null: nobody. */
	readonly assignee?: string | null;
	readonly work?: Card["work"] | null;
	readonly auto?: Card["auto"] | null;
	/** Recorded without an event in the history. */
	readonly dueNoticed?: string;
	/** The schede it comes after, by ID or number; null or empty: none. */
	readonly after?: readonly string[] | null;
	/** Recorded without an event in the history. */
	readonly queued?: Card["queued"] | null;
	readonly check?: CheckChange;
	readonly comment?: string;
	/** Refused unless the scheda is still in this column: two starts at once start it once. */
	readonly from?: CardStatus;
};

export class BoardStore {
	private readonly file: string;

	constructor(tenantDir: string) {
		this.file = join(tenantDir, "board.json");
	}

	list(): Card[] {
		return [...readJsonFile<BoardFile>(this.file, { next: 1, cards: [] }).cards];
	}

	/** By ID, or by number («12», «#12»). */
	get(ref: string): Card | undefined {
		const n = /^#?(\d{1,6})$/.exec(ref.trim())?.[1];
		return this.list().find((c) => c.id === ref || (n !== undefined && c.n === Number(n)));
	}

	create(input: { title: string; description?: string; priority?: CardPriority; assignee?: string; parent?: string; due?: string; checklist?: readonly string[]; after?: readonly string[] }, by: CardActor, now = new Date()): Card {
		const title = clean(input.title, BOARD_LIMITS.title, "il titolo");
		if (title === "") throw new BoardError("Serve un titolo");
		const due = input.due === undefined ? undefined : dueDay(input.due);
		const items = (input.checklist ?? []).map((t) => clean(t, BOARD_LIMITS.checkItem, "una voce della lista")).filter((t) => t !== "");
		if (items.length > BOARD_LIMITS.checklist) throw new BoardError(`Al massimo ${BOARD_LIMITS.checklist} voci nella lista`);
		const description = clean(input.description ?? "", BOARD_LIMITS.description, "la descrizione", true);
		const at = now.toISOString();
		let made: Card | undefined;
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (board.cards.filter((c) => c.status !== "fatto").length >= BOARD_LIMITS.open) throw new BoardError(`Ci sono già ${BOARD_LIMITS.open} incarichi aperti: chiudine qualcuno`);
			if (input.parent !== undefined) {
				const parent = board.cards.find((c) => c.id === input.parent);
				if (parent === undefined) throw new BoardError("L'incarico di cui fa parte non c'è più");
				if (parent.parent !== undefined) throw new BoardError(`L'incarico #${parent.n} fa già parte di un altro: un incarico dentro un altro non ne ha di suoi`);
				if (parent.status === "fatto") throw new BoardError(`L'incarico #${parent.n} è chiuso`);
				if (board.cards.filter((c) => c.parent === parent.id && c.status !== "fatto").length >= BOARD_LIMITS.children) throw new BoardError(`L'incarico #${parent.n} ha già ${BOARD_LIMITS.children} incarichi aperti dentro`);
			}
			const after = afterIds(board.cards, undefined, input.after ?? []);
			made = {
				id: `c_${randomBytes(6).toString("hex")}`,
				n: board.next,
				title,
				description,
				status: "da_fare",
				priority: input.priority ?? "normale",
				...(input.assignee === undefined ? {} : { assignee: input.assignee }),
				...(input.parent === undefined ? {} : { parent: input.parent }),
				...(due === undefined ? {} : { due }),
				...(items.length === 0 ? {} : { checklist: items.map((text) => ({ id: `k_${randomBytes(4).toString("hex")}`, text, done: false })) }),
				...(after.length === 0 ? {} : { after }),
				createdBy: by,
				createdAt: at,
				updatedAt: at,
				events: [{ at, by, kind: "created", ...(input.assignee === undefined ? {} : { assignee: input.assignee }) }],
			};
			return { ...board, next: board.next + 1, cards: [...board.cards, made] };
		});
		return made as Card;
	}

	/** Apply a change and record it; an agente never moves a scheda to «Fatto». */
	update(id: string, change: CardChange, by: CardActor, now = new Date()): Card {
		if (by.kind === "agent" && change.status === "fatto") throw new BoardError("Solo una persona sposta un incarico in «Fatto», dopo averlo rivisto");
		const at = now.toISOString();
		let changed: Card | undefined;
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			const card = board.cards.find((c) => c.id === id);
			if (card === undefined) throw new BoardError("Incarico inesistente");
			if (change.from !== undefined && card.status !== change.from) throw new BoardError(`L'incarico #${card.n} non è più in «${STATUS_LABEL[change.from]}»`);
			if (by.kind === "agent" && card.status === "fatto" && change.status !== undefined) throw new BoardError(`L'incarico #${card.n} è chiuso: lo riapre una persona`);
			const events: CardEvent[] = [];
			let next: Card = card;
			const due = change.due === undefined || change.due === null ? change.due : dueDay(change.due);
			const dueMoved = due !== undefined && (due ?? undefined) !== card.due;
			if (change.title !== undefined || change.description !== undefined || (change.priority !== undefined && change.priority !== card.priority) || dueMoved) {
				const title = change.title === undefined ? card.title : clean(change.title, BOARD_LIMITS.title, "il titolo");
				if (title === "") throw new BoardError("Serve un titolo");
				const description = change.description === undefined ? card.description : clean(change.description, BOARD_LIMITS.description, "la descrizione", true);
				const { due: _due, ...rest } = next;
				const kept = dueMoved ? (due === null ? undefined : due) : card.due;
				next = { ...rest, title, description, priority: change.priority ?? card.priority, ...(kept === undefined ? {} : { due: kept }) };
				events.push({ at, by, kind: "edited", ...(dueMoved ? { due } : {}) });
			}
			if (change.assignee !== undefined && (change.assignee ?? undefined) !== card.assignee) {
				const { assignee: _old, work: _work, ...rest } = next;
				next = change.assignee === null ? rest : { ...rest, assignee: change.assignee };
				events.push({ at, by, kind: "assigned", assignee: change.assignee });
			}
			if (change.work !== undefined) {
				const { work: _work, ...rest } = next;
				next = change.work === null ? rest : { ...rest, work: change.work };
			}
			if (change.auto !== undefined) {
				const { auto: _auto, ...rest } = next;
				next = change.auto === null ? rest : { ...rest, auto: change.auto };
			}
			if (change.dueNoticed !== undefined && change.dueNoticed !== card.dueNoticed) next = { ...next, dueNoticed: change.dueNoticed };
			if (change.after !== undefined) {
				const after = afterIds(board.cards, card.id, change.after ?? []);
				if (after.join() !== (card.after ?? []).join()) {
					const { after: _a, ...rest } = next;
					next = after.length === 0 ? rest : { ...rest, after };
					events.push({ at, by, kind: "edited", after: after.map((id) => board.cards.find((c) => c.id === id)?.n as number) });
				}
			}
			if (change.check !== undefined) {
				const done = checked(next, change.check);
				if (done !== undefined) {
					next = done.card;
					events.push({ at, by, ...done.event });
				}
			}
			if (change.status !== undefined && change.status !== card.status) {
				next = { ...next, status: change.status };
				events.push({ at, by, kind: "status", status: change.status });
			}
			// Waiting to start only while still in «Da fare» with the same agente.
			if (change.queued !== undefined || (next.queued !== undefined && (next.status !== "da_fare" || next.assignee !== card.assignee))) {
				const { queued: _q, ...rest } = next;
				next = change.queued == null || next.status !== "da_fare" || next.assignee !== card.assignee ? rest : { ...rest, queued: change.queued };
			}
			if (change.comment !== undefined) {
				const text = clean(change.comment, BOARD_LIMITS.comment, "il commento", true);
				if (text !== "") events.push({ at, by, kind: "comment", text });
			}
			if (events.length === 0 && next === card) {
				changed = card;
				return board;
			}
			changed = { ...next, updatedAt: at, events: [...card.events, ...events].slice(-BOARD_LIMITS.events) };
			const cards = board.cards.map((c) => (c.id === id ? (changed as Card) : c));
			return { ...board, cards: keepDone(cards) };
		});
		return changed as Card;
	}

	/** Takes the week's summary (ADR 0081): true once per `week`, so two sweeps send it once. */
	claimDigest(week: string): boolean {
		let claimed = false;
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (board.digest === week) return board;
			claimed = true;
			return { ...board, digest: week };
		});
		return claimed;
	}

	remove(id: string): void {
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (!board.cards.some((c) => c.id === id)) throw new BoardError("Incarico inesistente");
			// Its sotto-schede stay, on their own; who came after it no longer waits for it.
			return {
				...board,
				cards: board.cards
					.filter((c) => c.id !== id)
					.map((c) => {
						let kept = c;
						if (kept.parent === id) {
							const { parent: _p, ...rest } = kept;
							kept = rest;
						}
						if (kept.after?.includes(id) === true) {
							const { after: _a, ...rest } = kept;
							const after = (c.after ?? []).filter((x) => x !== id);
							kept = after.length === 0 ? rest : { ...rest, after };
						}
						return kept;
					}),
			};
		});
	}

	/** An agente deleted (ADR 0046): its schede go back to nobody, «Da fare» if they were being worked. */
	unassignAgent(agent: string, now = new Date()): void {
		const at = now.toISOString();
		updateJsonFile<BoardFile>(this.file, { next: 1, cards: [] }, (board) => {
			if (!board.cards.some((c) => c.assignee === agent || c.work?.agent === agent)) return board;
			const by: CardActor = { kind: "agent", id: agent };
			return {
				...board,
				cards: board.cards.map((c) => {
					if (c.assignee !== agent && c.work?.agent !== agent) return c;
					const { assignee: _a, work: _w, ...rest } = c;
					const back = c.status === "in_corso" ? "da_fare" : c.status;
					const events: CardEvent[] = [{ at, by, kind: "assigned", assignee: null, text: "agente eliminato" }, ...(back === c.status ? [] : [{ at, by, kind: "status" as const, status: back }])];
					return { ...rest, status: back, updatedAt: at, events: [...c.events, ...events].slice(-BOARD_LIMITS.events) };
				}),
			};
		});
	}
}

/** The schede not yet «Fatto» this one comes after (ADR 0076): while there are any, it does not start. */
export function waitingFor(card: Card, cards: readonly Card[]): Card[] {
	return (card.after ?? []).map((id) => cards.find((c) => c.id === id)).filter((c): c is Card => c !== undefined && c.status !== "fatto");
}

/** The IDs of the schede `refs` names, for scheda `self` (undefined: a new one) to come after: no loops. */
function afterIds(cards: readonly Card[], self: string | undefined, refs: readonly string[]): string[] {
	const ids: string[] = [];
	for (const ref of refs) {
		const n = /^#?(\d{1,6})$/.exec(ref.trim())?.[1];
		const card = cards.find((c) => c.id === ref || (n !== undefined && c.n === Number(n)));
		if (card === undefined) throw new BoardError(`L'incarico ${n === undefined ? ref : `#${n}`} non c'è`);
		if (card.id === self) throw new BoardError("Un incarico non può venire dopo sé stesso");
		if (!ids.includes(card.id)) ids.push(card.id);
	}
	if (ids.length > BOARD_LIMITS.after) throw new BoardError(`Un incarico viene dopo al massimo ${BOARD_LIMITS.after} incarichi`);
	if (self === undefined) return ids;
	// Following what each comes after must never lead back here.
	const seen = new Set<string>();
	const queue = [...ids];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		const card = cards.find((c) => c.id === id);
		if (card?.after?.includes(self) === true) throw new BoardError(`L'incarico #${card.n} viene già dopo questo: si aspetterebbero a vicenda`);
		queue.push(...(card?.after ?? []));
	}
	return ids;
}

/** A real day, YYYY-MM-DD, or a BoardError. */
export function dueDay(input: unknown): string {
	if (typeof input !== "string") throw new BoardError("La scadenza è un giorno nel formato 2026-10-26");
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
	const day = m === null ? undefined : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	if (m === null || day === undefined || day.toISOString().slice(0, 10) !== input.trim() || Number(m[1]) < 2000 || Number(m[1]) > 2100) throw new BoardError("La scadenza è un giorno nel formato 2026-10-26");
	return input.trim();
}

/** «lunedì 26 ottobre». */
export function dueLabel(due: string): string {
	return italianDay(due);
}

/** Days from today (Rome) to the scadenza: negative when late. */
export function dueIn(due: string, now = new Date()): number {
	return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${todayIn("Europe/Rome", now)}T00:00:00Z`)) / 86_400_000);
}

/** «scade oggi», «in ritardo di 3 giorni», «scade fra 5 giorni»: for an open scheda, next to its day. */
export function dueText(due: string, now = new Date()): string {
	const days = dueIn(due, now);
	if (days < 0) return days === -1 ? "in ritardo di un giorno" : `in ritardo di ${-days} giorni`;
	if (days === 0) return "scade oggi";
	if (days === 1) return "scade domani";
	return `scade fra ${days} giorni`;
}

/** The checklist after `change`, with what to record; undefined when nothing changes. */
function checked(card: Card, change: CheckChange): { card: Card; event: { kind: "check"; text: string; done?: boolean; removed?: true } } | undefined {
	const list = card.checklist ?? [];
	if ("add" in change) {
		const text = clean(change.add, BOARD_LIMITS.checkItem, "una voce della lista");
		if (text === "") throw new BoardError("Scrivi cosa c'è da fare");
		if (list.length >= BOARD_LIMITS.checklist) throw new BoardError(`La lista ha già ${BOARD_LIMITS.checklist} voci`);
		return { card: { ...card, checklist: [...list, { id: `k_${randomBytes(4).toString("hex")}`, text, done: false }] }, event: { kind: "check", text } };
	}
	const ref = change.item.trim();
	const index = /^\d{1,2}$/.test(ref) ? Number(ref) - 1 : list.findIndex((i) => i.id === ref);
	const item = list[index];
	if (item === undefined) throw new BoardError(`L'incarico #${card.n} non ha la voce ${ref} nella lista`);
	if ("remove" in change) {
		const rest = list.filter((i) => i.id !== item.id);
		const { checklist: _c, ...without } = card;
		return { card: rest.length === 0 ? without : { ...card, checklist: rest }, event: { kind: "check", text: item.text, removed: true } };
	}
	if (item.done === change.done) return undefined;
	return { card: { ...card, checklist: list.map((i) => (i.id === item.id ? { ...i, done: change.done } : i)) }, event: { kind: "check", text: item.text, done: change.done } };
}

/** The most recent «Fatto» schede stay, the older ones go. */
function keepDone(cards: readonly Card[]): Card[] {
	const done = cards.filter((c) => c.status === "fatto").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const dropped = new Set(done.slice(BOARD_LIMITS.done).map((c) => c.id));
	return cards.filter((c) => !dropped.has(c.id));
}

function clean(text: string, max: number, what: string, multiline = false): string {
	const t = multiline ? text.replace(/\r\n?/g, "\n").trim() : text.replace(/\s+/g, " ").trim();
	if (t.length > max) throw new BoardError(`Testo troppo lungo per ${what}: al massimo ${max} caratteri`);
	return t;
}
