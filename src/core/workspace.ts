import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

export class WorkspaceError extends Error {
	override readonly name = "WorkspaceError";
}

export type WorkspaceFile = { readonly path: string; readonly size: number; readonly modifiedAt: string };

export type WorkspaceLimits = {
	/** Largest single file. */
	readonly maxFileBytes?: number;
	/** All files together. */
	readonly maxTotalBytes?: number;
};

const DEFAULT_LIMITS = { maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 };

/**
 * The files of one instance, under one folder it never leaves: paths are relative, with
 * no `..`, and symlinks are neither followed nor listed. Writes are atomic.
 */
export class Workspace {
	private readonly limits: Required<WorkspaceLimits>;

	constructor(
		readonly root: string,
		limits: WorkspaceLimits = {},
	) {
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	async write(path: string, data: string | Uint8Array): Promise<WorkspaceFile> {
		const file = this.resolve(path);
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		if (bytes.length > this.limits.maxFileBytes) throw new WorkspaceError(`File too large: over ${this.limits.maxFileBytes} bytes`);
		const existing = await this.statFile(file);
		const total = (await this.list()).reduce((n, f) => n + f.size, 0) - (existing?.size ?? 0) + bytes.length;
		if (total > this.limits.maxTotalBytes) throw new WorkspaceError(`Workspace full: over ${this.limits.maxTotalBytes} bytes`);
		await this.assertInside(dirname(file));
		await writeFileAtomic(file, bytes);
		return { path: this.normalize(path), size: bytes.length, modifiedAt: new Date().toISOString() };
	}

	async read(path: string): Promise<Buffer> {
		const file = this.resolve(path);
		const stat = await this.statFile(file);
		if (stat === undefined) throw new WorkspaceError(`File not found: ${this.normalize(path)}`);
		return readFile(file);
	}

	/**
	 * A whole file read through one handle opened without following a symlink (O_NOFOLLOW) nor
	 * waiting on a pipe: what is read is the regular file the handle's own stat describes, never a
	 * link swapped in after a check. `maxBytes`: larger files are refused before reading.
	 */
	async readExact(path: string, maxBytes = this.limits.maxFileBytes): Promise<{ readonly path: string; readonly data: Buffer }> {
		const file = this.resolve(path);
		await this.assertInside(dirname(file));
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") throw new WorkspaceError(`File not found: ${this.normalize(path)}`);
			if (code === "ELOOP" || code === "EMLINK") throw new WorkspaceError("Symbolic links are not allowed");
			throw error;
		}
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new WorkspaceError("Not a file");
			// A hard link shares the file with a name outside the workspace's rules: refused.
			if (stat.nlink > 1) throw new WorkspaceError("Hard links are not allowed");
			await this.assertHandleInside(handle.fd);
			if (stat.size > maxBytes) throw new WorkspaceError(`File too large: over ${maxBytes} bytes`);
			const data = Buffer.alloc(stat.size);
			let at = 0;
			while (at < data.length) {
				const { bytesRead } = await handle.read(data, at, data.length - at, at);
				if (bytesRead === 0) break;
				at += bytesRead;
			}
			if (at !== stat.size) throw new WorkspaceError("File changed while reading");
			return { path: this.normalize(path), data };
		} finally {
			await handle.close();
		}
	}

	/** The first `bytes` bytes of a file (fewer when it is shorter): enough to tell what it is without reading all of it. */
	async readStart(path: string, bytes: number): Promise<Buffer> {
		const file = this.resolve(path);
		const stat = await this.statFile(file);
		if (stat === undefined) throw new WorkspaceError(`File not found: ${this.normalize(path)}`);
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.alloc(Math.min(bytes, stat.size));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	}

	async stat(path: string): Promise<WorkspaceFile | undefined> {
		const file = this.resolve(path);
		const stat = await this.statFile(file);
		return stat === undefined ? undefined : { path: this.normalize(path), size: stat.size, modifiedAt: stat.mtime.toISOString() };
	}

	async remove(path: string): Promise<void> {
		const file = this.resolve(path);
		if ((await this.statFile(file)) === undefined) throw new WorkspaceError(`File not found: ${this.normalize(path)}`);
		await rm(file);
	}

	/** Regular files, sorted by path; `prefix` limits to a folder. */
	async list(prefix = ""): Promise<WorkspaceFile[]> {
		const start = prefix === "" ? this.root : this.resolve(prefix);
		const out: WorkspaceFile[] = [];
		const walk = async (dir: string): Promise<void> => {
			let names: string[];
			try {
				names = await readdir(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return;
				throw error;
			}
			await Promise.all(
				names
					.filter((name) => !name.startsWith(".")) // temp files of atomic writes
					.map(async (name) => {
						const full = join(dir, name);
						const stat = await lstat(full);
						if (stat.isDirectory()) await walk(full);
						else if (stat.isFile()) out.push({ path: relative(this.root, full).split(sep).join("/"), size: stat.size, modifiedAt: stat.mtime.toISOString() });
					}),
			);
		};
		await walk(start);
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	private normalize(path: string): string {
		return path.split(/[\\/]+/).filter(Boolean).join("/");
	}

	private resolve(path: string): string {
		if (typeof path !== "string" || path.includes("\0")) throw new WorkspaceError("Invalid path");
		if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) throw new WorkspaceError(`Absolute paths are not allowed: ${path}`);
		const parts = path.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
		if (parts.length === 0) throw new WorkspaceError("Empty path");
		if (parts.some((p) => p === "..")) throw new WorkspaceError(`Paths cannot go up with "..": ${path}`);
		if (parts.some((p) => p.startsWith("."))) throw new WorkspaceError(`Hidden names are not allowed: ${path}`);
		return join(this.root, ...parts);
	}

	/** A regular file (not a symlink, not a folder) or undefined. */
	private async statFile(file: string) {
		try {
			const stat = await lstat(file);
			if (stat.isSymbolicLink()) throw new WorkspaceError("Symbolic links are not allowed");
			if (!stat.isFile()) throw new WorkspaceError("Not a file");
			await this.assertInside(dirname(file));
			return stat;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	/** Where an open handle really is, where the system says it (/proc on Linux): inside the root, or refused. Elsewhere, nothing more to check. */
	private async assertHandleInside(fd: number): Promise<void> {
		let real: string;
		try {
			real = await readlink(`/proc/self/fd/${fd}`);
		} catch {
			return;
		}
		const root = await realpath(this.root);
		if (!real.startsWith(root + sep)) throw new WorkspaceError("Path leaves the workspace");
	}

	/** A folder on the way may be a symlink planted from outside: check where it really is. */
	private async assertInside(dir: string): Promise<void> {
		await mkdir(this.root, { recursive: true });
		const root = await realpath(this.root);
		let real: string;
		try {
			real = await realpath(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // created by the write, inside the root
			throw error;
		}
		if (real !== root && !real.startsWith(root + sep)) throw new WorkspaceError("Path leaves the workspace");
	}
}

/** `stem.ext`, or `stem-2.ext` and on when it is taken: a new file never replaces one already there. */
export async function freePath(workspace: Workspace, stem: string, ext: string): Promise<string> {
	for (let i = 1; i <= 99; i++) {
		const path = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
		if ((await workspace.stat(path)) === undefined) return path;
	}
	return `${stem}-${Date.now().toString(36)}${ext}`;
}
