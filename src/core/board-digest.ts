import { type Card, dueIn, dueText } from "./board.ts";
import { todayIn } from "./italian-calendar.ts";

/** The hour (Rome) on Monday from which the week's summary goes (ADR 0081). */
export const DIGEST_HOUR = 9;

/**
 * The week of the board summary (ADR 0081): the Monday it is sent on, in Rome, when it is Monday
 * from 9 on; undefined at any other time. Missed on Monday (Owni off), it waits for the next one.
 */
export function digestWeek(now: Date): string | undefined {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
	const weekday = parts.find((p) => p.type === "weekday")?.value;
	const hour = Number(parts.find((p) => p.type === "hour")?.value);
	return weekday === "Mon" && hour >= DIGEST_HOUR ? todayIn("Europe/Rome", now) : undefined;
}

/**
 * The week on the board in a few lines, for the owner's chat: what was closed in the last 7 days,
 * what is open by column, what is late and what waits for a review. Undefined when the board had
 * nothing in the week (no open schede, none closed).
 */
export function digestText(cards: readonly Card[], now: Date, agentName: (id: string) => string | undefined): string | undefined {
	const since = now.getTime() - 7 * 86_400_000;
	const closed = cards.filter((c) => c.status === "fatto" && c.events.some((e) => e.kind === "status" && e.status === "fatto" && Date.parse(e.at) >= since));
	const open = cards.filter((c) => c.status !== "fatto");
	if (closed.length === 0 && open.length === 0) return undefined;
	const count = (status: Card["status"]) => open.filter((c) => c.status === status).length;
	const late = open.filter((c) => c.due !== undefined && dueIn(c.due, now) < 0).sort((a, b) => (a.due as string).localeCompare(b.due as string));
	const review = open.filter((c) => c.status === "da_rivedere");
	const who = (c: Card) => (c.assignee === undefined ? "" : ` (${agentName(c.assignee) ?? "agente eliminato"})`);
	const list = (xs: readonly Card[], line: (c: Card) => string) => [...xs.slice(0, 5).map((c) => `- ${line(c)}`), ...(xs.length > 5 ? [`- e altre ${xs.length - 5}`] : [])];
	return [
		"La board, questa settimana.",
		closed.length === 0 ? "Nessun incarico chiuso negli ultimi 7 giorni." : `${closed.length === 1 ? "Un incarico chiuso" : `${closed.length} incarichi chiusi`} negli ultimi 7 giorni.`,
		open.length === 0 ? "Nessun incarico aperto." : `Aperti: ${count("da_fare")} da fare, ${count("in_corso")} in corso, ${count("da_rivedere")} da rivedere.`,
		...(late.length === 0 ? [] : ["In ritardo:", ...list(late, (c) => `#${c.n} ${c.title}${who(c)}, ${dueText(c.due as string, now)}`)]),
		...(review.length === 0 ? [] : ["Da rivedere:", ...list(review, (c) => `#${c.n} ${c.title}${who(c)}`)]),
	].join("\n");
}
