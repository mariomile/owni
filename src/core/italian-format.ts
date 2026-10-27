/**
 * Dates as they are read in Italy, for the board and the partita IVA check: days and months in
 * Italian, dd/mm/yyyy.
 */
import { localMinute } from "./cron.ts";

const DAY = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** 2026-10-17 → sabato 17 ottobre; the first of the month is 1º. */
export function italianDay(date: string): string {
	return DAY.format(new Date(`${date}T00:00:00Z`)).replace(/ 1 /, " 1º ");
}

/** 2026-10-17 → 17/10/2026. */
function italianDate(date: string): string {
	return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/** An instant as 17/10/2026 22:10 in `timeZone`, with cron's cached formatter. */
export function italianDateTime(at: number, timeZone: string): string {
	const minute = localMinute(new Date(at), timeZone);
	return `${italianDate(minute.slice(0, 10))} ${minute.slice(-5)}`;
}

/** 1 → 01: days and months as dates write them. */
export function twoDigits(n: number): string {
	return String(n).padStart(2, "0");
}

/** The first letter in capitals: a sentence that starts with a name or a weekday. */
export function capitalized(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
