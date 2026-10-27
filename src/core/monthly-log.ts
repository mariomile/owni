import { appendFile, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Months of archives kept next to a live log (ADR 0129, 0130). */
export const RETENTION_MONTHS = 12;

/** A "YYYY-MM" month as a count of months, so two of them subtract. */
export function monthIndex(month: string): number {
	return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/**
 * A JSONL log kept by month in `dir`: `<stem>.jsonl` is live, `<stem>-YYYY-MM.jsonl` the archive of
 * a month that is over. Which month the live file belongs to, and when to roll it, is the caller's rule.
 */
export class MonthlyLog {
	readonly live: string;
	private readonly archive: RegExp;

	constructor(
		private readonly dir: string,
		private readonly stem: string,
	) {
		this.live = join(dir, `${stem}.jsonl`);
		this.archive = new RegExp(`^${stem}-(\\d{4}-\\d{2})\\.jsonl$`);
	}

	/** Archived months, oldest first. */
	async archives(): Promise<{ month: string; path: string }[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names
			.flatMap((name) => {
				const month = this.archive.exec(name)?.[1];
				return month === undefined ? [] : [{ month, path: join(this.dir, name) }];
			})
			.sort((a, b) => a.month.localeCompare(b.month));
	}

	/** Every file of the log, oldest first: the archives, then the live file. */
	async files(): Promise<string[]> {
		return [...(await this.archives()).map((a) => a.path), this.live];
	}

	/** Bytes the log takes on disk: the live file and its archives. */
	async size(): Promise<number> {
		let total = 0;
		for (const path of await this.files()) total += (await sizeOf(path)) ?? 0;
		return total;
	}

	/**
	 * Moves the live file to the archive of `lastMonth`, then deletes the archives more than
	 * RETENTION_MONTHS before `nowMonth`. An archive of that month already there (a clock that went
	 * back, a file restored by hand) is added to, never replaced. The archives it deleted.
	 */
	async roll(lastMonth: string, nowMonth: string): Promise<string[]> {
		const archive = join(this.dir, `${this.stem}-${lastMonth}.jsonl`);
		try {
			if ((await sizeOf(archive)) === undefined) await rename(this.live, archive);
			else {
				await appendFile(archive, await readFile(this.live), { mode: 0o600 });
				await unlink(this.live);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const deleted: string[] = [];
		for (const old of await this.archives()) {
			if (monthIndex(nowMonth) - monthIndex(old.month) <= RETENTION_MONTHS) continue;
			await unlink(old.path).catch(() => undefined);
			deleted.push(old.path);
		}
		return deleted;
	}
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
