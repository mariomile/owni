import { BOARD_LIMITS, BoardError, type BoardStore, CARD_PRIORITIES, CARD_STATUSES, type CardChange, type CardPriority, type CardStatus, type CheckChange } from "../core/board.ts";
import { describeWhen, nextTime, type Routine, routineWhen, type RoutineStore } from "../core/board-routines.ts";
import type { BoardWork } from "../core/board-work.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { Person, PeopleStore } from "./auth.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";

export type BoardRoutesDeps = {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly people: PeopleStore;
	readonly board: { readonly store: BoardStore; readonly work: BoardWork; readonly routines?: RoutineStore } | undefined;
	/** Segreterie take no schede. */
	readonly segreterie: ReadonlyMap<string, unknown> | undefined;
};

/**
 * The board in the console (ADR 0050). The owner sees every scheda; a member those they created
 * or work on, and those of the agenti they can talk to.
 */
export function boardRoutes(route: AddRoute, { runtime, tenantId, people, board, segreterie }: BoardRoutesDeps): void {
	const boardOf = () => {
		if (board === undefined) throw new HttpError(501, "La board non è disponibile su questo server");
		return board;
	};
	const boardAgents = async () => (await runtime.registry.listInstances(tenantId)).filter((r) => !(segreterie?.has(r.id) ?? false));
	/** The scheda, if this person sees it. */
	const visibleCard = async (ref: string, p: Person) => {
		const { store, work } = boardOf();
		const card = store.get(ref);
		if (card === undefined || !(await work.visibleTo(card, p.id))) throw new HttpError(404, "Scheda inesistente");
		return card;
	};
	const boardError = (error: unknown): never => {
		if (error instanceof BoardError) throw new HttpError(400, error.message);
		throw error;
	};
	const cardBody = (body: Record<string, unknown>) => {
		if (body.priority !== undefined && !(CARD_PRIORITIES as readonly unknown[]).includes(body.priority)) throw new HttpError(400, `Priorità: ${CARD_PRIORITIES.join(", ")}`);
		if (body.status !== undefined && !(CARD_STATUSES as readonly unknown[]).includes(body.status)) throw new HttpError(400, `Colonna: ${CARD_STATUSES.join(", ")}`);
		const priority = body.priority as CardPriority | undefined;
		const status = body.status as CardStatus | undefined;
		const assignee = body.assignee === null || body.assignee === "" ? null : typeof body.assignee === "string" ? body.assignee : undefined;
		if (body.due !== undefined && body.due !== null && typeof body.due !== "string") throw new HttpError(400, "La scadenza è un giorno nel formato 2026-10-26");
		const due = body.due === null || body.due === "" ? null : (body.due as string | undefined);
		const c = body.check as Record<string, unknown> | undefined;
		let check: CheckChange | undefined;
		if (c !== undefined) {
			if (typeof c === "object" && c !== null && typeof c.add === "string") check = { add: c.add };
			else if (typeof c === "object" && c !== null && typeof c.item === "string" && c.remove === true) check = { item: c.item, remove: true };
			else if (typeof c === "object" && c !== null && typeof c.item === "string" && typeof c.done === "boolean") check = { item: c.item, done: c.done };
			else throw new HttpError(400, "check: { add } oppure { item, done } oppure { item, remove: true }");
		}
		if (body.after !== undefined && body.after !== null && !(Array.isArray(body.after) && body.after.every((x) => typeof x === "string"))) throw new HttpError(400, "after: i numeri delle schede, come «12»");
		const after = body.after === undefined ? undefined : body.after === null ? [] : (body.after as string[]).filter((x) => x.trim() !== "");
		return { priority, status, assignee, due, check, after };
	};
	/** What a scheda comes after (ADR 0076): only schede this person sees. */
	const afterOf = async (refs: readonly string[] | undefined, p: Person) => (refs === undefined ? undefined : Promise.all(refs.map(async (ref) => (await visibleCard(ref, p).catch(() => boardError(new BoardError(`La scheda ${ref} non c'è`)))).id)));
	/** A scheda that comes back (ADR 0069) is the business of who set it and of the owner. */
	const routinesOf = () => {
		const routines = boardOf().routines;
		if (routines === undefined) throw new HttpError(501, "Le schede che si ripetono non sono disponibili su questo server");
		return routines;
	};
	const ownRoutine = (id: string, p: Person): Routine => {
		const r = routinesOf().get(id);
		if (r === undefined || (p.role !== "owner" && r.personId !== p.id)) throw new HttpError(404, "Questa scheda non si ripete più");
		return r;
	};
	const routineView = (r: Routine) => ({ ...r, whenText: describeWhen(r.when) });
	route("GET", "/api/board", "person", async ({ person }) => {
		const { store, work, routines } = boardOf();
		const p = person as Person;
		const agents = await boardAgents();
		const all = store.list();
		const seen = await Promise.all(all.map((c) => work.visibleTo(c, p.id)));
		const cards = all.filter((_, i) => seen[i]);
		const names = new Map((await people.list()).map((x) => [x.id, x.name]));
		const shown = (routines?.list() ?? []).filter((r) => p.role === "owner" || r.personId === p.id);
		const involved = new Set([...cards.flatMap((c) => [c.createdBy, ...c.events.map((e) => e.by)].filter((a) => a.kind === "person").map((a) => a.id)), ...shown.map((r) => r.personId)]);
		return {
			cards,
			routines: shown.map(routineView),
			agents: agents.map((r) => ({ id: r.id, name: r.name, ...(r.persona?.emoji === undefined ? {} : { emoji: r.persona.emoji }), canAssign: r.egress.channels.includes("web") && (r.allowedUsers.web ?? []).includes(p.id) })),
			people: Object.fromEntries([...involved].map((id) => [id, names.get(id) ?? "una persona"])),
			auto: { replies: BOARD_LIMITS.autoRounds, hours: BOARD_LIMITS.autoMs / 3_600_000 },
		};
	});
	route("POST", "/api/board", "person", async ({ person, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const body = (await readJson(req)) as Record<string, unknown>;
		const { priority, assignee, due, after: afterRefs } = cardBody(body);
		const after = await afterOf(afterRefs, p);
		// «Si ripete»: no scheda now, one at each time, worked with this person.
		if (body.repeat !== undefined && body.repeat !== null) {
			if (!assignee) throw new HttpError(400, "Una scheda che si ripete va affidata a un agente");
			if (after !== undefined && after.length > 0) throw new HttpError(400, "Una scheda che si ripete non aspetta altre schede");
			if (due) throw new HttpError(400, "Una scheda che si ripete non ha una scadenza");
			const routines = routinesOf();
			let routine: Routine;
			try {
				await work.checkAgent(assignee, p.id);
				routine = routines.create({ title: typeof body.title === "string" ? body.title : "", ...(typeof body.description === "string" ? { description: body.description } : {}), ...(priority === undefined ? {} : { priority }), assignee, auto: body.auto === true, when: routineWhen(body.repeat), personId: p.id });
			} catch (error) {
				return boardError(error);
			}
			await runtime.audit(tenantId).append({ type: "board.routine_created", routineId: routine.id, personId: p.id, assignee, every: routine.when.every });
			return { routine: routineView(routine) };
		}
		const card = await work
			.create({ title: typeof body.title === "string" ? body.title : "", ...(typeof body.description === "string" ? { description: body.description } : {}), ...(priority === undefined ? {} : { priority }), ...(assignee ? { assignee } : {}), ...(due ? { due } : {}), ...(after !== undefined && after.length > 0 ? { after } : {}), ...(Array.isArray(body.checklist) ? { checklist: body.checklist.filter((x): x is string => typeof x === "string") } : {}), ...(body.auto === true ? { auto: true } : {}), ...(typeof body.parent === "string" && body.parent !== "" ? { parent: (await visibleCard(body.parent, p)).id } : {}) }, { kind: "person", id: p.id }, p.id)
			.catch(boardError);
		await runtime.audit(tenantId).append({ type: "board.card_created", cardId: card.id, personId: p.id, ...(card.assignee === undefined ? {} : { assignee: card.assignee }), ...(card.parent === undefined ? {} : { parent: card.parent }) });
		return { card };
	});
	route("PUT", "/api/board/:id", "person", async ({ person, params, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const card = await visibleCard(params[0] as string, p);
		const body = (await readJson(req)) as Record<string, unknown>;
		const { priority, status, assignee, due, check, after: afterRefs } = cardBody(body);
		const after = await afterOf(afterRefs, p);
		const change: CardChange = {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(priority === undefined ? {} : { priority }),
			...(due === undefined ? {} : { due }),
			...(check === undefined ? {} : { check }),
			...(after === undefined ? {} : { after }),
			...(status === undefined ? {} : { status }),
			...(assignee === undefined ? {} : { assignee }),
			...(typeof body.comment === "string" ? { comment: body.comment } : {}),
			// «Esegui da solo» on (counting from now) or off.
			...(typeof body.auto === "boolean" ? { auto: body.auto ? { rounds: 0, since: new Date().toISOString() } : null } : {}),
		};
		const changed = await work.change(card.id, change, { kind: "person", id: p.id }, p.id).catch(boardError);
		await runtime.audit(tenantId).append({ type: "board.card_changed", cardId: card.id, personId: p.id, fields: Object.keys(change).join(","), ...(status === undefined ? {} : { status }) });
		return { card: changed };
	});
	// Avvia: the work on a scheda waiting in «Da fare» starts, with whoever presses it.
	route("POST", "/api/board/:id/start", "person", async ({ person, params, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const card = await visibleCard(params[0] as string, p);
		const body = (await readJson(req)) as { auto?: unknown };
		const started = await work.startWaiting(card.id, p.id, { kind: "person", id: p.id }, body.auto === true).catch(boardError);
		await runtime.audit(tenantId).append({ type: "board.card_started", cardId: card.id, personId: p.id, assignee: started.assignee ?? "", auto: started.auto !== undefined });
		return { card: started };
	});
	route("PUT", "/api/board/routines/:id", "person", async ({ person, params, req }) => {
		const { work } = boardOf();
		const p = person as Person;
		const r = ownRoutine(params[0] as string, p);
		const body = (await readJson(req)) as { paused?: unknown };
		if (typeof body.paused !== "boolean") throw new HttpError(400, "paused: true o false");
		const pausing = body.paused;
		let changed: Routine;
		try {
			// Started again only if its person may still hand schede to its agente; it counts from now.
			if (!pausing) {
				if ((await people.get(r.personId)) === undefined) throw new BoardError("La persona che l'ha impostata non c'è più: creane una nuova");
				await work.checkAgent(r.assignee, r.personId);
			}
			changed = routinesOf().update(r.id, (x) => {
				const { paused: _p, problem: _q, ...rest } = x;
				return pausing ? { ...rest, paused: true as const } : { ...rest, next: nextTime(x.when, new Date()) };
			});
		} catch (error) {
			return boardError(error);
		}
		await runtime.audit(tenantId).append({ type: "board.routine_changed", routineId: r.id, personId: p.id, paused: pausing });
		return { routine: routineView(changed) };
	});
	route("DELETE", "/api/board/routines/:id", "person", async ({ person, params }) => {
		const p = person as Person;
		const r = ownRoutine(params[0] as string, p);
		try {
			routinesOf().remove(r.id);
		} catch (error) {
			boardError(error);
		}
		await runtime.audit(tenantId).append({ type: "board.routine_deleted", routineId: r.id, personId: p.id });
		return { ok: true };
	});
	route("DELETE", "/api/board/:id", "person", async ({ person, params }) => {
		const { store, work } = boardOf();
		const p = person as Person;
		const card = await visibleCard(params[0] as string, p);
		if (p.role !== "owner" && !(card.createdBy.kind === "person" && card.createdBy.id === p.id)) throw new HttpError(403, "Solo chi l'ha creata o l'owner la elimina");
		try {
			store.remove(card.id);
		} catch (error) {
			boardError(error);
		}
		await runtime.audit(tenantId).append({ type: "board.card_deleted", cardId: card.id, personId: p.id });
		// Who waited only for it starts now (ADR 0076).
		await work.release().catch(() => 0);
		return { ok: true };
	});
}
