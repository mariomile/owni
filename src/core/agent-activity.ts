import type { Card } from "./board.ts";
import type { RunRecord } from "./run-store.ts";

/**
 * What an agente is doing now (ADR 0109). `doing` is one short line, or empty. `busy`: a run is
 * queued or running; `running`: one is running now; `open`: an incarico «In corso» is assigned to it.
 */
export type Activity = { readonly busy: boolean; readonly busyFor?: number; readonly running: boolean; readonly open: boolean; readonly doing: string };

/** The one status of an agente, the same on every page that shows it (ADR 0125). */
export const AGENT_STATUS = { al_lavoro: "Al lavoro", aspetta_te: "Aspetta te", in_coda: "In coda", libero: "Libero" } as const;
export type AgentStatus = keyof typeof AGENT_STATUS;

/**
 * Running now wins; then what waits for the person (`waiting`: a decision or a review of theirs);
 * then work handed to it and not running (a queued run, an incarico «In corso»); else free.
 */
export function agentStatus(activity: Activity, waiting: boolean): AgentStatus {
	if (activity.running) return "al_lavoro";
	if (waiting) return "aspetta_te";
	if (activity.busy || activity.open) return "in_coda";
	return "libero";
}

/** Who asks: a console person, or an agente working (for a person, when its conversation is with one). */
export type Viewer = { readonly person?: string; readonly agent?: string };

export type ActivityDeps = {
	/** The agente's queued and running runs, on any channel. */
	readonly active: (agent: string) => Promise<readonly RunRecord[]>;
	readonly cards: () => readonly Card[];
	/** The board's rule for a person (BoardWork.visibleTo). */
	readonly cardVisibleTo: (card: Card, person: string) => Promise<boolean>;
	/** A console conversation of the agente: its title and the person it belongs to. */
	readonly thread: (agent: string, threadId: string) => Promise<{ readonly title: string; readonly personId: string } | undefined>;
};

const LINE_MAX = 100;
const oneLine = (text: string) => {
	// One line, and no «» or control characters to close the quotes the line goes in.
	const line = text.replace(/[\p{Cc}«»]/gu, " ").replace(/\s+/g, " ").trim();
	return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
};

/**
 * Busy if any run of the agente is queued or running, for as long as the oldest one. The line is
 * the title of its «In corso» scheda, else the title of the conversation it is running in, and
 * only what the viewer already sees: the board's rule for schede, and for conversations the
 * person's own (the owner's too: a private chat stays private). Never a description or a comment.
 */
export function activityReader(deps: ActivityDeps): (agent: string, viewer: Viewer, now?: Date) => Promise<Activity> {
	return async (agent, viewer, now = new Date()) => {
		const runs = [...(await deps.active(agent))].filter((r) => r.status === "queued" || r.status === "running");
		const since = runs
			.map((r) => Date.parse(r.startedAt ?? r.createdAt))
			.filter(Number.isFinite)
			.sort((a, b) => a - b)[0];
		const busy = runs.length > 0;
		const mine = (c: Card) => viewer.agent !== undefined && (c.assignee === viewer.agent || (c.createdBy.kind === "agent" && c.createdBy.id === viewer.agent));
		const seen = async (c: Card) => mine(c) || (viewer.person !== undefined && (await deps.cardVisibleTo(c, viewer.person)));
		let doing = "";
		const open = deps.cards().filter((c) => c.status === "in_corso" && c.assignee === agent).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		for (const card of open) {
			if (await seen(card)) {
				doing = oneLine(`#${card.n} ${card.title}`);
				break;
			}
		}
		if (doing === "" && viewer.person !== undefined) {
			// Running before queued, the newest first.
			const order = runs.filter((r) => r.channel === "web").sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.createdAt.localeCompare(a.createdAt));
			for (const run of order) {
				const thread = await deps.thread(agent, run.threadId);
				if (thread !== undefined && thread.personId === viewer.person && thread.title.trim() !== "") {
					doing = oneLine(thread.title);
					break;
				}
			}
		}
		return { busy, ...(busy && since !== undefined ? { busyFor: Math.max(0, Math.round((now.getTime() - since) / 1000)) } : {}), running: runs.some((r) => r.status === "running"), open: open.length > 0, doing };
	};
}

/** The reader over the real stores: the runs on disk, the board, the console conversations. */
export function runtimeActivity(options: {
	readonly runtime: { listRuns(tenant: string, instance: string, filter: { statuses: readonly ("queued" | "running")[]; limit: number }): Promise<RunRecord[]> };
	readonly tenant: string;
	readonly board?: { readonly store: { list(): Card[] }; readonly work: { visibleTo(card: Card, personId: string): Promise<boolean> } };
	readonly channel: (agent: string) => { thread(threadId: string): Promise<{ title: string; personId: string } | undefined> } | undefined;
}): (agent: string, viewer: Viewer) => Promise<Activity> {
	const read = activityReader({
		active: (agent) => options.runtime.listRuns(options.tenant, agent, { statuses: ["queued", "running"], limit: 200 }),
		cards: () => options.board?.store.list() ?? [],
		cardVisibleTo: async (card, person) => (await options.board?.work.visibleTo(card, person)) === true,
		thread: async (agent, threadId) => options.channel(agent)?.thread(threadId),
	});
	// One agente deleted or with an unreadable runs.json must not break the list of the others.
	return (agent, viewer) => read(agent, viewer).catch(() => ({ busy: false, running: false, open: false, doing: "" }));
}

/**
 * Who an agente asks for, from the conversation it works in: the console person of a console chat
 * (`personOf`), nobody in any other (Telegram, another agente), so it sees only its own schede.
 */
export function viewerOf(self: string, thread: { readonly channel: string; readonly threadId: string } | undefined, personOf: (threadId: string) => string | undefined): Viewer {
	const person = thread?.channel === "web" ? personOf(thread.threadId) : undefined;
	return { agent: self, ...(person === undefined ? {} : { person }) };
}
