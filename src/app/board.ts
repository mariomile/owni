import type { ChannelAdapter } from "../channels/types.ts";
import { BoardError, type BoardStore } from "../core/board.ts";
import { type BoardDigest, type BoardReview, BoardWork } from "../core/board-work.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { PeopleStore } from "../web/auth.ts";
import type { WebChannel } from "../web/channel.ts";

export type BoardWiring = {
	readonly runtime: OwniRuntime;
	readonly tenant: string;
	readonly store: BoardStore;
	readonly people: PeopleStore;
	/** The main agente: the owner hears of schede to review in their chat with it. */
	readonly main: string;
	/** The agente's name, or undefined when it is not one a scheda can go to (missing, a segreteria). */
	readonly agentName: (agent: string) => Promise<string | undefined>;
	/** Whether the person may talk to the agente from the console. */
	readonly canChat: (agent: string, personId: string) => Promise<boolean>;
	readonly webChannel: (agent: string) => WebChannel | undefined;
	/** The main agente's Telegram and WhatsApp, where its approvers are. */
	readonly ownerChats: () => readonly (ChannelAdapter | undefined)[];
	readonly log: (message: string) => void;
};

/**
 * The board of a tenant at work (ADR 0050, 0051, 0061): schede handed to agenti are worked in
 * a console conversation, an agente working alone is told to go on after each answer, and a
 * scheda to review reaches the owner's chat with the main agente too.
 */
export function startBoard(w: BoardWiring): BoardWork {
	const { runtime, tenant, people, log } = w;
	const consoleOf = (agent: string) => {
		const channel = w.webChannel(agent);
		if (channel === undefined) throw new Error(`agente ${agent} has no console`);
		return channel;
	};
	const work = new BoardWork({
		store: w.store,
		agentName: w.agentName,
		canChat: w.canChat,
		isOwner: async (personId) => (await people.get(personId))?.role === "owner",
		owners: async () => (await people.list()).filter((p) => p.role === "owner").map((p) => p.id),
		personName: async (personId) => (await people.get(personId))?.name,
		openThread: async (agent, personId, title, reuse) => {
			const channel = consoleOf(agent);
			if (reuse !== undefined && (await channel.thread(reuse)) !== undefined) return reuse;
			return (await channel.createThread(personId, title)).id;
		},
		post: async (agent, threadId, personId, text) => {
			await consoleOf(agent).post(threadId, personId, text, { origin: "scheduled" });
		},
	});
	// «Esegui da solo» (ADR 0061): each reply in the conversation of a scheda may be followed by «go on».
	runtime.onReply((reply) => {
		// Only answers to what was written in the conversation: not files or messages sent mid-turn.
		if (reply.tenantId !== tenant || reply.channel !== "web" || reply.status === "file" || reply.submissionId === "message") return;
		void work.afterReply(reply.instanceId, reply.threadId, reply.deliveryId, reply.status === "unanswered" ? reply.reason : undefined).catch((error: unknown) => log(`owni: board after reply in ${reply.threadId}: ${error instanceof Error ? error.message : String(error)}`));
	});
	// A scheda to review (ADR 0051): when it is the owner's, a line in the owner's chat with the main agente too.
	const noticeReview = async ({ card, people: to }: BoardReview): Promise<void> => {
		if (!(await Promise.all(to.map(async (id) => (await people.get(id))?.role === "owner"))).some(Boolean)) return;
		const record = await runtime.registry.getInstance(tenant, w.main);
		const agent = card.assignee === undefined ? undefined : (await runtime.registry.getInstance(tenant, card.assignee).catch(() => undefined))?.name;
		// The agente's words on this move, not an older round's.
		const moved = card.events.findLastIndex((e) => e.kind === "status" && e.status === "da_rivedere");
		const summary = card.events.slice(moved).find((e) => e.kind === "comment" && e.by.kind === "agent" && e.by.id === card.assignee)?.text;
		const text = `Scheda #${card.n} da rivedere: ${card.title}${agent === undefined ? "" : `\n${agent} l'ha finita`}${summary === undefined ? "." : `: ${summary.length > 300 ? `${summary.slice(0, 300)}[...]` : summary}`}\n\nApprovala da qui, o rimandala indietro con cosa cambiare dalla Board della console.`;
		// Approved with a tap (ADR 0079); sending it back needs words, so that stays on the board.
		const buttons = [{ label: "Approva", data: `${BOARD_TAP}${card.id}:fatto` }];
		for (const adapter of w.ownerChats()) {
			if (adapter === undefined) continue;
			for (const chat of record.approvers?.[adapter.name] ?? []) {
				await adapter
					.send({ tenantId: tenant, instanceId: w.main, channel: adapter.name, threadId: chat, idempotencyKey: `board-review:${card.id}:${card.updatedAt}:${chat}`, text, ...(adapter.onAction === undefined ? {} : { buttons }) })
					.catch((error: unknown) => log(`owni: notice for scheda #${card.n} to ${adapter.name} ${chat} not sent: ${error instanceof Error ? error.message : String(error)}`));
			}
		}
	};
	// The week's summary (ADR 0081): to the main agente's approvers, like the reviews.
	work.events.on("digest", ({ week, text }: BoardDigest) => {
		void (async () => {
			const record = await runtime.registry.getInstance(tenant, w.main);
			for (const adapter of w.ownerChats()) {
				if (adapter === undefined) continue;
				for (const chat of record.approvers?.[adapter.name] ?? []) {
					await adapter
						.send({ tenantId: tenant, instanceId: w.main, channel: adapter.name, threadId: chat, idempotencyKey: `board-digest:${week}:${chat}`, text })
						.catch((error: unknown) => log(`owni: board summary to ${adapter.name} ${chat} not sent: ${error instanceof Error ? error.message : String(error)}`));
				}
			}
		})().catch((error: unknown) => log(`owni: board summary not sent: ${error instanceof Error ? error.message : String(error)}`));
	});
	work.events.on("review", (review: BoardReview) => {
		void noticeReview(review).catch((error: unknown) => log(`owni: notice for scheda #${review.card.n} not sent: ${error instanceof Error ? error.message : String(error)}`));
	});
	return work;
}

const BOARD_TAP = "board:";

/**
 * «Approva» tapped under a scheda to review in the owner's chat with the main agente (ADR 0079):
 * the scheda goes to «Fatto», as if the owner pressed Approva on the board, only if it is still in
 * «Da rivedere». Returns what to answer in the chat, or undefined when the tap is not a board one.
 * The caller checks the tapper is an approver of the main agente.
 */
export async function approveFromChat(work: BoardWork, people: PeopleStore, data: string): Promise<string | undefined> {
	const m = /^board:(c_[0-9a-f]{12}):fatto$/.exec(data);
	if (m === null) return undefined;
	const owner = (await people.list()).find((p) => p.role === "owner");
	if (owner === undefined) return "Non c'è un owner nella console: approvala dalla Board.";
	try {
		const card = await work.change(m[1] as string, { status: "fatto", from: "da_rivedere" }, { kind: "person", id: owner.id }, owner.id);
		return `Scheda #${card.n} approvata e chiusa.`;
	} catch (error) {
		if (error instanceof BoardError) return `${error.message}.`;
		throw error;
	}
}
