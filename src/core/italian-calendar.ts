/**
 * The calendar primitives the board and the tax-id check need: today's date in a time zone and the
 * length of a month. Dates are YYYY-MM-DD strings.
 */
import { localMinute } from "./cron.ts";

function leapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 1 to 12 → 28 to 31. */
export function daysInMonth(year: number, month: number): number {
	return month === 2 ? (leapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Today's date in `timeZone`, YYYY-MM-DD, with cron's cached formatter. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	return localMinute(now, timeZone).slice(0, 10);
}
