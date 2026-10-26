import { createHash } from "node:crypto";
import { request } from "node:http";
import { COMPUTER_LIMITS, ComputerError, type ComputerProvider, type ComputerRun, tarFiles, untarFirstFile } from "../core/computer.ts";
import { PerKey, Slots } from "./queue.ts";

export type DockerComputerOptions = {
	/** The computer's image (docker/computer.Dockerfile). */
	readonly image: string;
	/** Docker Engine API socket. */
	readonly socketPath?: string;
	/** A sandboxed runtime such as runsc (gVisor); Docker's default otherwise. */
	readonly runtime?: string;
	readonly memoryMb?: number;
	readonly cpus?: number;
	/** Quota of /work: past it, new files stay tiny until some are deleted. */
	readonly diskMb?: number;
	/** A computer with no command for this long is stopped (its files stay). */
	readonly idleMs?: number;
	/** Computers running at once; the one unused the longest is stopped to start another. */
	readonly maxRunning?: number;
	/** Commands running at once, across all computers. */
	readonly maxConcurrent?: number;
	readonly log?: (message: string) => void;
};

/** Docker Engine API 1.41: Docker 20.10 and later. */
const API = "/v1.41";
const LABEL = "owni.computer";
/** A hash of how the container was created: a change of image, runtime or limits recreates it (the files stay). */
const SPEC_LABEL = "owni.computer.spec";
const API_TIMEOUT_MS = 30_000;
/** Kept of each of stdout (the start) and stderr (the end); the rest is read and dropped. */
const MAX_STREAM_BYTES = 64 * 1024;
/** Docker's frames are small; a bigger one means the stream is not what it should be. */
const MAX_FRAME_BYTES = 1024 * 1024;
/** No single file in the computer grows past this (RLIMIT_FSIZE). */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** `ulimit -f` while /work is over its quota: enough to write a note, not to fill anything. */
const FULL_FILE_BLOCKS = 2048;

type Exec = { stdout: string; stderr: string; truncated: boolean; cut: boolean; exitCode: number | null };

/**
 * A computer per instance as a container on this Docker host (ADR 0013, ADR 0124): on Docker's
 * default bridge, so it reaches the public internet and no published port reaches it, while its
 * first process (root with only NET_ADMIN) refuses everything private: the cloud's metadata
 * endpoint, the LAN, the host. No secrets in it, read-only root except /work (the instance's
 * volume) and /tmp, no capabilities for commands, no privilege escalation, memory, CPU, process
 * and file size limits, and optionally gVisor. Commands go in with `docker exec` as uid 1000; the
 * first process is another user, so after each command `kill -9 -1` ends everything the command
 * left behind. Files go in and out with Docker's archive API: nothing in the container listens.
 */
export class DockerComputerProvider implements ComputerProvider {
	private readonly locks = new PerKey();
	/** Computers this process started, least recently used first, with their idle timers. */
	private readonly running = new Map<string, NodeJS.Timeout>();
	private readonly full = new Set<string>();
	private readonly slots: Slots;

	constructor(private readonly options: DockerComputerOptions) {
		const memory = options.memoryMb ?? 1024;
		const cpus = options.cpus ?? 1;
		const disk = options.diskMb ?? 2048;
		if (!Number.isInteger(memory) || memory < 128) throw new Error("Computer: memory of at least 128 MB");
		if (!(cpus > 0)) throw new Error("Computer: a positive number of CPUs");
		if (!Number.isInteger(disk) || disk < 16) throw new Error("Computer: disk quota of at least 16 MB");
		if (options.runtime !== undefined && !/^[\w.-]{1,40}$/.test(options.runtime)) throw new Error("Computer: invalid runtime");
		this.slots = new Slots(options.maxConcurrent ?? 4);
	}

	run(key: string, command: string, options: { readonly timeoutS: number; readonly signal?: AbortSignal }): Promise<ComputerRun> {
		return this.exclusive(key, () =>
			this.slot(async () => {
				await this.launch(key);
				const timeoutS = Math.max(1, Math.min(COMPUTER_LIMITS.maxTimeoutS, Math.round(options.timeoutS)));
				// timeout(1) kills the command when its time is up; then everything it left running goes too.
				const limit = this.full.has(key) ? `ulimit -f ${FULL_FILE_BLOCKS}; ` : "";
				const cmd = ["sh", "-c", `${limit}timeout -s KILL ${timeoutS} sh -c "$1"; s=$?; kill -9 -1 2>/dev/null; exit $s`, "owni", command];
				const waitMs = (timeoutS + 15) * 1000;
				const started = Date.now();
				const out = await this.exec(key, cmd, waitMs, options.signal).catch(async (error: unknown) => {
					// A computer stopped or removed behind our back (a restart of Docker) is started again, once.
					if (!/HTTP (404|409)/.test(message(error))) throw error;
					this.forget(key);
					await this.launch(key);
					return this.exec(key, cmd, waitMs, options.signal);
				});
				const ms = Date.now() - started;
				// Cut short (aborted, or no end in sight): whatever is still running is ended here.
				if (out.cut) await this.exec(key, ["sh", "-c", "kill -9 -1"], API_TIMEOUT_MS).catch((error: unknown) => this.options.log?.(`computer: sweep failed: ${message(error)}`));
				const diskFull = await this.checkDisk(key);
				this.touch(key);
				const timedOut = out.cut || (out.exitCode === 137 && ms >= timeoutS * 1000 - 250);
				return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, timedOut, killed: !timedOut && out.exitCode === 137, truncated: out.truncated, ms, diskFull };
			}),
		);
	}

	put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		if (files.length === 0) return Promise.resolve();
		return this.exclusive(key, async () => {
			if (this.full.has(key)) throw new ComputerError(`il disco del computer è pieno (${this.diskMb()} MB): prima vanno cancellati dei file in /work`);
			await this.launch(key);
			await this.api("PUT", `/containers/${name(key)}/archive?path=${encodeURIComponent("/work")}`, tarFiles(files), [200]);
			this.touch(key);
		});
	}

	get(key: string, path: string, maxBytes: number): Promise<Uint8Array> {
		return this.exclusive(key, async () => {
			await this.launch(key);
			this.touch(key);
			const where = `/containers/${name(key)}/archive?path=${encodeURIComponent(`/work/${path}`)}`;
			// The size first, from the stat Docker sends with HEAD: a big file is never read.
			const stat = await this.statOf(where);
			if (stat === undefined) throw new ComputerError(`nel computer non c'è /work/${path}`);
			if ((stat.mode & 0x80000000) !== 0) throw new ComputerError(`/work/${path} è una cartella: indica i file uno per uno`);
			if ((stat.mode & 0x08000000) !== 0) throw new ComputerError(`/work/${path} è un collegamento, non un file`);
			if (stat.size > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
			const archive = (await this.api("GET", where, undefined, [200], true)) as Buffer;
			const file = untarFirstFile(archive);
			if (file === undefined) throw new ComputerError(`/work/${path} non è un file`);
			if (file.length > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
			return file;
		});
	}

	reset(key: string): Promise<void> {
		return this.exclusive(key, async () => {
			this.forget(key);
			this.full.delete(key);
			await this.api("DELETE", `/containers/${name(key)}?force=true`, undefined, [204, 404]);
			await this.api("DELETE", `/volumes/${name(key)}`, undefined, [204, 404]);
		});
	}

	async check(): Promise<string | undefined> {
		try {
			await this.api("GET", "/_ping", undefined, [200], true);
			const image = await this.api("GET", `/images/${encodeURIComponent(this.options.image)}/json`, undefined, [200, 404]);
			if (image === undefined) return `l'immagine ${this.options.image} non c'è: si costruisce con docker build -f docker/computer.Dockerfile -t ${this.options.image} docker`;
			return undefined;
		} catch (error) {
			return `Docker non risponde su ${this.socket()} (${message(error).slice(0, 120)})`;
		}
	}

	/**
	 * At boot: computers left running by a previous run of Owni (a crash, a kill) are stopped;
	 * they start again, with their files, at their next command. One Owni per Docker host.
	 */
	async stopLeftovers(): Promise<number> {
		const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
		const list = ((await this.api("GET", `/containers/json?filters=${filters}`, undefined, [200])) ?? []) as { Labels?: Record<string, string> }[];
		let stopped = 0;
		for (const container of list) {
			const key = container.Labels?.[LABEL];
			if (key === undefined || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(key) || this.running.has(key)) continue;
			await this.exclusive(key, () => this.stop(key));
			stopped += 1;
		}
		return stopped;
	}

	async close(): Promise<void> {
		await Promise.all([...this.running.keys()].map((key) => this.exclusive(key, () => this.stop(key))));
	}

	private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
		return this.locks.run(key, work);
	}

	private slot<T>(work: () => Promise<T>): Promise<T> {
		return this.slots.run(work);
	}

	private async stop(key: string): Promise<void> {
		this.forget(key);
		await this.api("POST", `/containers/${name(key)}/stop?t=2`, undefined, [204, 304, 404]).catch((error: unknown) => this.options.log?.(`computer: ${key} not stopped: ${message(error)}`));
	}

	private forget(key: string): void {
		clearTimeout(this.running.get(key));
		this.running.delete(key);
	}

	/** Stopped after a while with no commands; most recently used last. */
	private touch(key: string): void {
		this.forget(key);
		const timer = setTimeout(() => void this.exclusive(key, () => this.stop(key)), this.options.idleMs ?? 10 * 60_000);
		timer.unref();
		this.running.set(key, timer);
	}

	/** Created on first use, recreated when its spec changed, started when stopped. Called under the computer's lock. */
	private async launch(key: string): Promise<void> {
		if (this.running.has(key)) return;
		// Room for one more: the computer unused the longest stops (not awaited: it waits for its own lock).
		for (const other of [...this.running.keys()]) {
			if (this.running.size < (this.options.maxRunning ?? 8)) break;
			if (this.locks.has(other)) continue;
			this.forget(other);
			void this.exclusive(other, () => this.stop(other));
		}
		const spec = this.spec(key);
		const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
		let info = (await this.api("GET", `/containers/${name(key)}/json`, undefined, [200, 404])) as { State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> } } | undefined;
		if (info !== undefined && info.Config?.Labels?.[LABEL] !== key) throw new Error(`computer: container ${name(key)} exists and is not this computer`);
		if (info !== undefined && info.Config?.Labels?.[SPEC_LABEL] !== hash) {
			this.options.log?.(`computer: ${key} recreated with the new image or limits (its files stay)`);
			await this.api("DELETE", `/containers/${name(key)}?force=true`, undefined, [204, 404]);
			info = undefined;
		}
		if (info === undefined) {
			await this.api("POST", "/volumes/create", { Name: name(key), Labels: { [LABEL]: key } }, [201]);
			try {
				await this.api("POST", `/containers/create?name=${name(key)}`, { ...spec, Labels: { [LABEL]: key, [SPEC_LABEL]: hash } }, [201]);
			} catch (error) {
				if (/No such image/i.test(message(error))) throw new ComputerError(`l'immagine del computer ${this.options.image} non c'è su questo server: l'operatore la costruisce con docker build -f docker/computer.Dockerfile`);
				throw error;
			}
		}
		if (info?.State?.Running !== true) await this.api("POST", `/containers/${name(key)}/start`, undefined, [204, 304]);
		await this.ready(key);
		this.touch(key);
	}

	/**
	 * No command before the egress rules are in place: the first process applies them, and an
	 * exec as root (which has NET_ADMIN, unlike uid 1000) reads them back. A first process that
	 * could not apply them ends, and the container with it.
	 */
	private async ready(key: string): Promise<void> {
		const check = ["/usr/local/bin/owni-run", "egress", "check"];
		for (let i = 0; i < 50; i++) {
			const out = await this.exec(key, check, API_TIMEOUT_MS, undefined, "0:0").catch((error: unknown) => {
				if (/HTTP (404|409)/.test(message(error))) return undefined;
				throw error;
			});
			if (out?.exitCode === 0) return;
			if (out === undefined) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		const gvisor = this.gvisor() ? " (con gVisor serve runsc con --net-raw, vedi il runbook)" : "";
		throw new ComputerError(`il computer non è partito: non ha potuto chiudere la strada verso gli indirizzi privati${gvisor}. L'operatore controlla il log di Docker del container ${name(key)}`);
	}

	/** gVisor implements only the legacy iptables interface, through raw sockets. */
	private gvisor(): boolean {
		return this.options.runtime?.startsWith("runsc") === true;
	}

	private spec(key: string): Record<string, unknown> {
		const memory = (this.options.memoryMb ?? 1024) * 1024 * 1024;
		return {
			Image: this.options.image,
			// The first process is root with only NET_ADMIN (and NET_RAW for gVisor's iptables): it
			// applies the egress rules and idles. Commands run as 1000: they cannot signal it, and
			// with no file capabilities and no setuid programs they hold none of its capabilities.
			User: "0:0",
			Cmd: ["/usr/local/bin/owni-run", "guard", this.gvisor() ? "legacy" : "nft"],
			WorkingDir: "/work",
			HostConfig: {
				// Out to the public internet (pip install, curl, git clone), not to private addresses
				// (the guard's rules); no port published, so nothing comes in.
				NetworkMode: "bridge",
				Binds: [`${name(key)}:/work`],
				ReadonlyRootfs: true,
				Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m", "/run": "rw,nosuid,nodev,noexec,size=16m,mode=0755" },
				CapDrop: ["ALL"],
				CapAdd: this.gvisor() ? ["NET_ADMIN", "NET_RAW"] : ["NET_ADMIN"],
				SecurityOpt: ["no-new-privileges:true"],
				// An init as pid 1 reaps what commands leave behind.
				Init: true,
				Memory: memory,
				MemorySwap: memory,
				NanoCpus: Math.round((this.options.cpus ?? 1) * 1e9),
				PidsLimit: 128,
				Ulimits: [{ Name: "fsize", Soft: MAX_FILE_BYTES, Hard: MAX_FILE_BYTES }],
				RestartPolicy: { Name: "no" },
				LogConfig: { Type: "none", Config: {} },
				...(this.options.runtime === undefined ? {} : { Runtime: this.options.runtime }),
			},
		};
	}

	private diskMb(): number {
		return this.options.diskMb ?? 2048;
	}

	/** /work against its quota, after each command. Its files are 1000's: after a chmod it can read them all. */
	private async checkDisk(key: string): Promise<boolean> {
		try {
			const du = await this.exec(key, ["sh", "-c", "chmod -R u+rwX /work 2>/dev/null; du -sxk /work"], API_TIMEOUT_MS);
			const kb = Number.parseInt(du.stdout, 10);
			if (Number.isFinite(kb) && kb > this.diskMb() * 1024) this.full.add(key);
			else if (Number.isFinite(kb)) this.full.delete(key);
		} catch (error) {
			this.options.log?.(`computer: disk check failed: ${message(error)}`);
		}
		return this.full.has(key);
	}

	/** A command in the computer as uid 1000 (root only for the egress check), in /work, with its output and exit code. */
	private async exec(key: string, cmd: string[], timeoutMs: number, signal?: AbortSignal, user = "1000:1000"): Promise<Exec> {
		const created = (await this.api(
			"POST",
			`/containers/${name(key)}/exec`,
			{ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: user, WorkingDir: "/work", Env: ["HOME=/tmp", "MPLCONFIGDIR=/tmp", "LANG=C.UTF-8"] },
			[201],
		)) as { Id?: string } | undefined;
		const id = created?.Id;
		if (id === undefined || !/^[0-9a-f]{12,64}$/.test(id)) throw new Error("docker exec: no id");
		const output = await this.stream(`/exec/${id}/start`, { Detach: false, Tty: false }, timeoutMs, signal);
		// The stream can end a moment before Docker records the exit code.
		for (let i = 0; i < 20; i++) {
			const info = (await this.api("GET", `/exec/${id}/json`, undefined, [200])) as { ExitCode?: number | null; Running?: boolean };
			if (info.Running !== true) return { ...output, exitCode: info.ExitCode ?? null };
			if (output.cut) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { ...output, exitCode: null };
	}

	/** Docker's stat of a path (the X-Docker-Container-Path-Stat header of HEAD), or undefined when missing. */
	private statOf(path: string): Promise<{ size: number; mode: number } | undefined> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: this.socket(), path: `${API}${path}`, method: "HEAD" }, (res) => {
				res.resume();
				if (res.statusCode === 404) return resolve(undefined);
				const header = res.headers["x-docker-container-path-stat"];
				if (res.statusCode !== 200 || typeof header !== "string") return reject(new Error(`docker HEAD archive: HTTP ${res.statusCode}`));
				try {
					const stat = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { size?: number; mode?: number };
					resolve({ size: Number(stat.size ?? 0), mode: Number(stat.mode ?? 0) >>> 0 });
				} catch {
					reject(new Error("docker HEAD archive: unreadable stat"));
				}
			});
			req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error("docker HEAD archive: no answer")));
			req.on("error", reject);
			req.end();
		});
	}

	/**
	 * An exec's output: Docker's stream of frames (8-byte header: stream, 3 zeros, length). Ends
	 * at the latest `timeoutMs` after it starts (a wall clock, not an inactivity timer) or on abort.
	 */
	private stream(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Omit<Exec, "exitCode">> {
		return new Promise((resolve, reject) => {
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let outSize = 0;
			let errSize = 0;
			let truncated = false;
			let pending = Buffer.alloc(0);
			let cut = false;
			let done = false;
			const settle = (error?: Error) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				if (error !== undefined) return reject(error);
				resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), truncated, cut });
			};
			const stop = () => {
				cut = true;
				req.destroy();
				settle();
			};
			const take = (kind: number, payload: Buffer) => {
				if (kind === 2) {
					// The end of stderr is where the error is: the oldest part goes.
					err.push(payload);
					errSize += payload.length;
					while (errSize > MAX_STREAM_BYTES) {
						truncated = true;
						const first = err[0] as Buffer;
						const extra = errSize - MAX_STREAM_BYTES;
						if (first.length <= extra) {
							err.shift();
							errSize -= first.length;
						} else {
							err[0] = first.subarray(extra);
							errSize -= extra;
						}
					}
					return;
				}
				const room = MAX_STREAM_BYTES - outSize;
				if (payload.length > room) truncated = true;
				if (room <= 0) return;
				out.push(payload.subarray(0, room));
				outSize += Math.min(room, payload.length);
			};
			const req = request({ socketPath: this.socket(), path: `${API}${path}`, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
				if (res.statusCode !== 200) {
					res.resume();
					return settle(new Error(`docker exec start: HTTP ${res.statusCode}`));
				}
				res.on("data", (chunk: Buffer) => {
					pending = Buffer.concat([pending, chunk]);
					while (pending.length >= 8) {
						const kind = pending[0] as number;
						const length = pending.readUInt32BE(4);
						if (kind > 2 || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0 || length > MAX_FRAME_BYTES) {
							req.destroy();
							return settle(new Error("docker exec: unreadable output stream"));
						}
						if (pending.length < 8 + length) break;
						take(kind, Buffer.from(pending.subarray(8, 8 + length)));
						pending = pending.subarray(8 + length);
					}
				});
				res.on("end", () => settle());
				res.on("error", (error) => (cut ? undefined : settle(error)));
			});
			const timer = setTimeout(stop, timeoutMs);
			if (signal?.aborted === true) queueMicrotask(stop);
			else signal?.addEventListener("abort", stop, { once: true });
			req.on("error", (error) => (cut ? undefined : settle(error)));
			req.end(JSON.stringify(body));
		});
	}

	private socket(): string {
		return this.options.socketPath ?? "/var/run/docker.sock";
	}

	private api(method: string, path: string, body: unknown, ok: readonly number[], raw = false): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const tar = Buffer.isBuffer(body);
			const headers = body === undefined ? {} : { "content-type": tar ? "application/x-tar" : "application/json" };
			const req = request({ socketPath: this.socket(), path: `${API}${path}`, method, headers }, (res) => {
				const chunks: Buffer[] = [];
				let total = 0;
				res.on("data", (c: Buffer) => {
					total += c.length;
					// An archive asked for is at most one file of maxFileBytes, plus its headers.
					if (total > COMPUTER_LIMITS.maxFileBytes + 64 * 1024) return req.destroy(new ComputerError("file troppo grande"));
					chunks.push(c);
				});
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					const data = Buffer.concat(chunks);
					if (!ok.includes(status)) return reject(new Error(`docker ${method} ${path.split("?")[0]}: HTTP ${status} ${dockerMessage(data.toString("utf8"))}`));
					// 404 where it is expected: missing, not an error.
					if (status === 404) return resolve(undefined);
					if (raw) return resolve(data);
					if (data.length === 0) return resolve(undefined);
					try {
						resolve(JSON.parse(data.toString("utf8")));
					} catch {
						resolve(undefined);
					}
				});
			});
			req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: no answer in ${API_TIMEOUT_MS / 1000} s`)));
			req.on("error", reject);
			req.end(body === undefined ? undefined : tar ? body : JSON.stringify(body));
		});
	}
}

function name(key: string): string {
	if (!/^[a-z0-9][a-z0-9_-]{0,100}$/.test(key)) throw new Error("Invalid computer key");
	return `owni-computer-${key}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function dockerMessage(text: string): string {
	try {
		return String((JSON.parse(text) as { message?: string }).message ?? "").slice(0, 200);
	} catch {
		return text.slice(0, 200);
	}
}
