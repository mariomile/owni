/**
 * A small iCalendar writer (RFC 5545), pure: all-day events with an optional reminder, the text
 * escaped (backslash, semicolon, comma, newline: §3.3.11), every line folded at 75 octets without
 * splitting a character (§3.1), CRLF line ends, a UID stable per event (a hash of what identifies
 * it), a DTSTAMP the caller gives (so the same call writes the same file), with LAST-MODIFIED the
 * same instant and a SEQUENCE that grows with it (§3.8.7.4): a calendar that imports a newer file
 * takes the newer event over the older one with the same UID. Any calendar imports it: Owni writes
 * no calendar of anyone.
 */
import { createHash } from "node:crypto";

export type IcsEvent = {
	/** Stable: the same deadline the same UID, so a calendar that imports again updates it. */
	readonly uid: string;
	/** An all-day event on this day (YYYY-MM-DD). */
	readonly date: string;
	readonly summary: string;
	readonly description?: string;
	/** A reminder this many days before, at REMIND_HOUR of that day; undefined: none. */
	readonly remindDays?: number;
};

export type IcsCalendar = {
	/** «-//Owni//Agenda fiscale//IT». */
	readonly prodId: string;
	/** The calendar's name, for the calendars that read X-WR-CALNAME. */
	readonly name?: string;
	/** When it was made, UTC: 20261019T080000Z. */
	readonly stamp: string;
	readonly events: readonly IcsEvent[];
};

/** The hour of the day a reminder rings, the event's own day counted from its midnight (floating time). */
export const REMIND_HOUR = 9;
/** The longest line, in octets, before folding (RFC 5545 §3.1). */
export const LINE_OCTETS = 75;

/** TEXT escaped (RFC 5545 §3.3.11): a backslash, a semicolon and a comma behind a backslash, a newline as «\n»; other control characters go. */
export function icsText(text: string): string {
	// C0, DEL and the C1 controls (U+0080 to U+009F) go: no calendar shows them, some break on them.
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\n/g, "\\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** A content line folded (RFC 5545 §3.1): at most LINE_OCTETS octets per line, the next ones after CRLF and one space, never inside a character. */
export function foldLine(line: string): string {
	const out: string[] = [];
	let current = "";
	let octets = 0;
	for (const ch of line) {
		const size = Buffer.byteLength(ch, "utf8");
		// A continuation line starts with the space, which counts.
		const limit = out.length === 0 ? LINE_OCTETS : LINE_OCTETS - 1;
		if (octets + size > limit) {
			out.push(current);
			current = "";
			octets = 0;
		}
		current += ch;
		octets += size;
	}
	out.push(current);
	return out.join("\r\n ");
}

/** A UID from what identifies an event (its source, its key, its day): the same parts, the same UID. */
export function icsUid(parts: readonly string[], domain = "owni"): string {
	return `${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}@${domain}`;
}

const compact = (date: string) => date.replace(/-/g, "");

/** SEQUENCE counts from here: seconds since 2020-01-01T00:00:00Z fit an integer until 2088. */
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1);

/** The SEQUENCE of a file made at `stamp` (20261019T080000Z): the seconds since SEQUENCE_EPOCH, so a later file has a higher one; 0 before it or unreadable. */
export function icsSequence(stamp: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
	if (m === null) return 0;
	const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
	const at = Date.UTC(y, mo - 1, d, h, mi, se);
	return Number.isNaN(at) || at < SEQUENCE_EPOCH ? 0 : Math.floor((at - SEQUENCE_EPOCH) / 1000);
}

/** The day after `date` (YYYY-MM-DD): an all-day event ends the next day, not included. */
function nextDay(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/** The trigger of a reminder `days` before an all-day event, at REMIND_HOUR: «-PT63H» three days before at 9, «PT9H» on the day. */
export function remindTrigger(days: number): string {
	const hours = REMIND_HOUR - 24 * days;
	return hours < 0 ? `-PT${-hours}H` : `PT${hours}H`;
}

/** The calendar as a .ics file: CRLF line ends, folded lines, one VEVENT per event. */
export function icsFile(c: IcsCalendar): string {
	const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${c.prodId}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
	if (c.name !== undefined) lines.push(`X-WR-CALNAME:${icsText(c.name)}`);
	const sequence = icsSequence(c.stamp);
	for (const e of c.events) {
		lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${c.stamp}`, `LAST-MODIFIED:${c.stamp}`, `SEQUENCE:${sequence}`, `DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(nextDay(e.date))}`, `SUMMARY:${icsText(e.summary)}`);
		if (e.description !== undefined) lines.push(`DESCRIPTION:${icsText(e.description)}`);
		lines.push("TRANSP:TRANSPARENT");
		if (e.remindDays !== undefined) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(e.summary)}`, `TRIGGER:${remindTrigger(e.remindDays)}`, "END:VALARM");
		lines.push("END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** A UTC instant as DTSTAMP writes it: 20261019T080000Z. */
export function icsStamp(at: Date): string {
	return `${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}
