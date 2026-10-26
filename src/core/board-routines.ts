import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AuditEvent } from "./audit.ts";
import { BOARD_LIMITS, BoardError, type BoardStore, type CardPriority } from "./board.ts";
import type { BoardWork } from "./board-work.ts";
import { nextDistinctRun, parseCron } from "./cron.ts";
import { readJsonFile, updateJsonFile } from "./locked-json.ts";

/**
 * Schede ricorrenti (ADR 0069): work that comes back («ogni lunedì alle 9 il report vendite»). Each
 * time a new scheda is made from the routine and handed to its agente with the person who set
 * it, as if that person had pressed Avvia; alone if they asked. Only people set them: an agente
 * that could start work by itself every week is what Avvia is there to prevent.
 */
export const ROUTINE_EVERY = ["giorno", "feriali", "settimana", "mese"] as const;
export type RoutineEvery = (typeof ROUTINE_EVERY)[number];

/** When it comes back, in Rome's time: a day of the week (1 Monday … 7 Sunday) or of the month (1…28). */
export type RoutineWhen = { readonly every: RoutineEvery; readonly time: string; readonly day?: number };

export type Routine = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly priority: CardPriority;
	readonly assignee: string;
	/** Each scheda works alone (ADR 0061). */
	readonly auto: boolean;
	readonly when: RoutineWhen;
	/** The person who set it: each scheda is worked with them. */
	readonly personId: string;
	/** The next time it makes a scheda. */
	readonly next: string;
	readonly createdAt: string;
	readonly paused?: true;
	/** The last scheda it made: while that one is open, no new one. */
	readonly last?: string;
	/** Why the last time made nothing, for the board. */
	readonly problem?: string;
};

export const ROUTINE_LIMITS = { routines: 50 } as const;
export const ROUTINE_ZONE = "Europe/Rome";

const DAYS = ["", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];

/** Checked and normalized, or a BoardError saying what is wrong. */
export function routineWhen(input: unknown): RoutineWhen {
	const w = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const every = ROUTINE_EVERY.find((e) => e === w.every);
	if (every === undefined) throw new BoardError("Scegli ogni quanto si ripete: ogni giorno, nei giorni feriali, ogni settimana o ogni mese");
	const time = typeof w.time === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(w.time.trim()) : null;
	if (time === null) throw new BoardError("L'ora è nel formato 9:00");
	const hhmm = `${(time[1] as string).padStart(2, "0")}:${time[2] as string}`;
	if (every === "settimana" || every === "mese") {
		const day = Number(w.day);
		const max = every === "settimana" ? 7 : 28;
		if (!Number.isInteger(day) || day < 1 || day > max) throw new BoardError(every === "settimana" ? "Scegli il giorno della settimana" : "Il giorno del mese va dall'1 al 28");
		return { every, time: hhmm, day };
	}
	return { every, time: hhmm };
}

export function routineCron(when: RoutineWhen): string {
	const [h, m] = when.time.split(":").map(Number) as [number, number];
	const day = when.day ?? 1;
	return { giorno: `${m} ${h} * * *`, feriali: `${m} ${h} * * 1-5`, settimana: `${m} ${h} * * ${day % 7}`, mese: `${m} ${h} ${day} * *` }[when.every];
}

/** «ogni lunedì alle 9:00». */
export function describeWhen(when: RoutineWhen): string {
	const at = `alle ${when.time.replace(/^0(\d)/, "$1")}`;
	if (when.every === "giorno") return `ogni giorno ${at}`;
	if (when.every === "feriali") return `dal lunedì al venerdì ${at}`;
	if (when.every === "settimana") return `ogni ${DAYS[when.day ?? 1]} ${at}`;
	return `ogni mese il ${when.day} ${at}`;
}

/** The first time after `from`, not the same minute as `previous`. */
export function nextTime(when: RoutineWhen, from: Date, previous?: Date): string {
	return nextDistinctRun(parseCron(routineCron(when)), from, ROUTINE_ZONE, previous).toISOString();
}

type RoutineFile = { readonly routines: readonly Routine[] };

export class RoutineStore {
	private readonly file: string;

	constructor(tenantDir: string) {
		this.file = join(tenantDir, "board-routines.json");
	}

	list(): Routine[] {
		return [...readJsonFile<RoutineFile>(this.file, { routines: [] }).routines];
	}

	get(id: string): Routine | undefined {
		return this.list().find((r) => r.id === id);
	}

	create(input: { title: string; description?: string; priority?: CardPriority; assignee: string; auto?: boolean; when: RoutineWhen; personId: string }, now = new Date()): Routine {
		const title = input.title.replace(/\s+/g, " ").trim();
		if (title === "") throw new BoardError("Serve un titolo");
		if (title.length > BOARD_LIMITS.title) throw new BoardError(`Testo troppo lungo per il titolo: al massimo ${BOARD_LIMITS.title} caratteri`);
		const description = (input.description ?? "").replace(/\r\n?/g, "\n").trim();
		if (description.length > BOARD_LIMITS.description) throw new BoardError(`Testo troppo lungo per la descrizione: al massimo ${BOARD_LIMITS.description} caratteri`);
		const made: Routine = {
			id: `r_${randomBytes(6).toString("hex")}`,
			title,
			description,
			priority: input.priority ?? "normale",
			assignee: input.assignee,
			auto: input.auto === true,
			when: input.when,
			personId: input.personId,
			next: nextTime(input.when, now),
			createdAt: now.toISOString(),
		};
		updateJsonFile<RoutineFile>(this.file, { routines: [] }, (f) => {
			if (f.routines.length >= ROUTINE_LIMITS.routines) throw new BoardError(`Ci sono già ${ROUTINE_LIMITS.routines} incarichi che si ripetono: togline qualcuno`);
			return { routines: [...f.routines, made] };
		});
		return made;
	}

	/** Change one, under the lock: `change` gets it as it is now. */
	update(id: string, change: (r: Routine) => Routine): Routine {
		let changed: Routine | undefined;
		updateJsonFile<RoutineFile>(this.file, { routines: [] }, (f) => {
			const r = f.routines.find((x) => x.id === id);
			if (r === undefined) throw new BoardError("Questo incarico non si ripete più");
			changed = change(r);
			return { routines: f.routines.map((x) => (x.id === id ? (changed as Routine) : x)) };
		});
		return changed as Routine;
	}

	remove(id: string): void {
		updateJsonFile<RoutineFile>(this.file, { routines: [] }, (f) => {
			if (!f.routines.some((r) => r.id === id)) throw new BoardError("Questo incarico non si ripete più");
			return { routines: f.routines.filter((r) => r.id !== id) };
		});
	}

	/** An agente deleted (ADR 0046): what came back to it stops, and says why. */
	pauseAgent(agent: string): void {
		this.pauseWhere((r) => r.assignee === agent, "l'agente è stato eliminato");
	}

	/** A person removed: what they set stops, and says why. */
	pausePerson(personId: string): void {
		this.pauseWhere((r) => r.personId === personId, "la persona che l'ha impostata non c'è più");
	}

	private pauseWhere(match: (r: Routine) => boolean, problem: string): void {
		updateJsonFile<RoutineFile>(this.file, { routines: [] }, (f) => (f.routines.some(match) ? { routines: f.routines.map((r) => (match(r) ? { ...r, paused: true as const, problem } : r)) } : f));
	}
}

export type RoutineRunDeps = {
	readonly routines: RoutineStore;
	readonly work: BoardWork;
	readonly board: BoardStore;
	/** Whether the person who set a routine is still one of the tenant's people. */
	readonly personExists: (personId: string) => Promise<boolean>;
	readonly audit: (event: AuditEvent) => Promise<void>;
	readonly log: (message: string) => void;
};

/**
 * Make the schede that are due: each routine at most once per tick, its next time set before the
 * scheda is made and the scheda recorded as its last before it starts, so neither a crash nor an
 * agente out of reach makes two. A time missed while Owni was off makes one scheda, not one per
 * time missed. While the last scheda is still open, no new one: a comment on it says so. A routine
 * whose person is gone, or can no longer hand schede to its agente, pauses with why.
 */
export async function runRoutines(d: RoutineRunDeps, now = new Date()): Promise<number> {
	const { routines, work, board } = d;
	/** A change that finds the routine removed meanwhile does nothing. */
	const change = (id: string, f: (r: Routine) => Routine): Routine | undefined => {
		try {
			return routines.update(id, f);
		} catch (error) {
			if (error instanceof BoardError) return undefined;
			throw error;
		}
	};
	const withProblem = (problem: string | undefined, pause = false) => (x: Routine): Routine => {
		const { problem: _old, ...rest } = x;
		return { ...rest, ...(problem === undefined ? {} : { problem }), ...(pause ? { paused: true as const } : {}) };
	};
	let made = 0;
	for (const r of routines.list()) {
		if (r.paused === true || Date.parse(r.next) > now.getTime()) continue;
		const planned = r.next;
		let claimed = false;
		// Paused or moved meanwhile (a person pressed Pausa during this tick): left alone.
		change(r.id, (x) => {
			if (x.next !== planned || x.paused === true) return x;
			claimed = true;
			return { ...x, next: nextTime(x.when, now, new Date(planned)) };
		});
		if (!claimed) continue;
		try {
			if (!(await d.personExists(r.personId))) {
				change(r.id, withProblem("la persona che l'ha impostata non c'è più", true));
				continue;
			}
			const last = r.last === undefined ? undefined : board.get(r.last);
			if (last !== undefined && last.status !== "fatto") {
				const when = new Intl.DateTimeFormat("it-IT", { timeZone: ROUTINE_ZONE, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(planned));
				// Said by the routine's agente, as when an agente is deleted: nobody wrote it.
				board.update(last.id, { comment: `Doveva ripartire ${when}, ma questo incarico non è ancora chiuso: riparte la volta dopo.` }, { kind: "agent", id: r.assignee });
				change(r.id, withProblem(`l'incarico #${last.n} non era ancora chiuso`));
				continue;
			}
			const by = { kind: "person", id: r.personId } as const;
			try {
				await work.checkAgent(r.assignee, r.personId);
			} catch (error) {
				if (!(error instanceof BoardError)) throw error;
				// As a task programmato whose person lost access: it stops until someone looks.
				change(r.id, withProblem(error.message, true));
				continue;
			}
			const card = board.create({ title: r.title, description: r.description, priority: r.priority, assignee: r.assignee }, by);
			change(r.id, (x) => ({ ...withProblem(undefined)(x), last: card.id }));
			await d.audit({ type: "board.card_created", cardId: card.id, personId: r.personId, assignee: r.assignee, routineId: r.id });
			made++;
			try {
				await work.startWaiting(card.id, r.personId, by, r.auto);
				await d.audit({ type: "board.card_started", cardId: card.id, personId: r.personId, assignee: r.assignee, auto: r.auto, routineId: r.id });
			} catch (error) {
				// It waits in «Da fare», with why: the next time comments on it instead of making another.
				if (!(error instanceof BoardError)) throw error;
				board.update(card.id, { comment: `Non è partito: ${error.message}. Avvialo da Incarichi.` }, { kind: "agent", id: r.assignee });
				change(r.id, withProblem(`l'incarico #${card.n} non è partito`));
			}
		} catch (error) {
			d.log(`board: routine ${r.id}: ${error instanceof Error ? error.message : String(error)}`);
			change(r.id, withProblem("errore interno"));
		}
	}
	return made;
}
