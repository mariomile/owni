import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Read a JSON file, change it, write it back, under a lock every process shares (the CLI
 * writes while Owni runs). The lock is an exclusive SQLite transaction on `<file>.lock`, a
 * kernel advisory lock released even if the process dies, as for instances. Read and write
 * are synchronous inside it, so no other code of this process runs while it is held.
 */
export function updateJsonFile<T>(file: string, empty: T, change: (current: T) => T): T {
	const db = new DatabaseSync(`${file}.lock`, { timeout: 5_000 });
	try {
		db.exec("BEGIN EXCLUSIVE");
		const current = readJsonFile(file, empty);
		const next = change(current);
		// Nothing changed: no write, so the file keeps its time and nobody waits on a rename.
		if (next === current) return next;
		const temp = `${file}.${process.pid}.tmp`;
		const fd = openSync(temp, "w", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, file);
		// The rename lives in the directory entry: fsync it, as writeFileAtomic does.
		const dirFd = openSync(dirname(file), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		return next;
	} finally {
		db.close();
	}
}

export function readJsonFile<T>(file: string, empty: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
		throw error;
	}
}
