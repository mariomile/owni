import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER_LIMITS, ComputerError, type ComputerProvider, type ComputerRun } from "../core/computer.ts";
import { PerKey, Slots } from "./queue.ts";

export type FlyComputerOptions = {
	/** A Fly.io API token of the organization (the control plane's, never a cell's). */
	readonly token: string;
	/** The organization's slug: every computer is an app of its own in it. */
	readonly org: string;
	/** Where the computers run: a region in the EU (fra, ams, cdg, arn, waw, mad). */
	readonly region: string;
	/** The `fly` target of docker/computer.Dockerfile, in a registry Fly can pull from. */
	readonly image: string;
	readonly memoryMb?: number;
	readonly cpus?: number;
	/** Quota of /work; the volume is this, rounded up to whole gigabytes. */
	readonly diskMb?: number;
	/** A machine with no call for this long stops by itself (its files stay). */
	readonly idleS?: number;
	/** Commands running at once, across all computers. */
	readonly maxConcurrent?: number;
	/** Apps are named `<prefix>-<hash>`: of the organization, this salt and the computer key. */
	readonly appPrefix?: string;
	/**
	 * A secret of this installation (computerSalt): Fly app names are global, and from a tenant
	 * and an instance alone anyone could take a computer's name first in their own organization.
	 */
	readonly salt: string;
	/** Fly's Machines API; a fake in tests. */
	readonly apiUrl?: string;
	readonly fetch?: typeof fetch;
	/** Tests: shorter waits and smaller pieces than Fly allows. */
	readonly waitSliceS?: number;
	readonly chunkBytes?: number;
	readonly log?: (message: string) => void;
};

type Machine = { readonly id: string; readonly state?: string; readonly region?: string; readonly instance_id?: string; readonly config?: { readonly metadata?: Record<string, string>; readonly mounts?: readonly { readonly volume?: string }[] } };
type Exec = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type Result = { readonly done: boolean; readonly missing?: boolean; readonly exitCode?: number | null; readonly stdout?: string; readonly stderr?: string; readonly truncated?: boolean; readonly timedOut?: boolean; readonly killed?: boolean; readonly ms?: number; readonly diskKb?: number };

const API_TIMEOUT_MS = 30_000;
/** docker/owni-run.py in the `fly` image. */
const RUNNER = "/usr/local/bin/owni-run";
/** Fly's exec answers within 60 seconds: a command is waited for in slices shorter than that. */
const WAIT_SLICE_S = 45;
/** Fly's exec takes its input as a string, and gives its output as one: files go in pieces. */
const CHUNK_BYTES = 512 * 1024;
/** Fly's wait answers within this; asked again until BOOT_TIMEOUT_MS. */
const START_TIMEOUT_S = 60;
/** A first boot pulls an image of about 1 GB: what starting may take, beyond which the command is not even tried. */
const BOOT_TIMEOUT_MS = 4 * 60_000;
/** What `call` gives for a status asked to be read as "not yet". */
const TIMED_OUT = Symbol("timed out");

/**
 * A computer per instance as a Fly.io Machine (ADR 0015): a micro-VM with a kernel of its own,
 * in an app of its own on a private network of its own, with no public address and no service,
 * and a volume for /work. It reaches the internet (ADR 0124); nothing reaches it. Its first
 * process closes Fly's API inside it (docker/owni-fly-init) and stops it after a while with
 * nothing to do. Commands and files go through Fly's exec API to
 * docker/owni-run, which runs them as uid 1000: a command starts in the background and is
 * waited for in slices, because an exec answers within 60 seconds.
 */
export class FlyComputerProvider implements ComputerProvider {
	private readonly locks = new PerKey();
	private readonly slots: Slots;
	private readonly machines = new Map<string, string>();
	private readonly full = new Set<string>();
	private readonly api: string;
	private readonly fetch: typeof fetch;

	constructor(private readonly options: FlyComputerOptions) {
		const memory = options.memoryMb ?? 1024;
		const cpus = options.cpus ?? 1;
		if (!Number.isInteger(cpus) || cpus < 1 || cpus > 8) throw new Error("Computer: Fly machines have 1 to 8 whole CPUs");
		if (!Number.isInteger(memory) || memory < 256 || memory % 256 !== 0 || memory > cpus * 2048) throw new Error("Computer: Fly memory in steps of 256 MB, at most 2048 MB per CPU");
		if (!/^[a-z0-9-]{1,40}$/.test(options.org)) throw new Error("Computer: invalid Fly organization");
		if (!/^[a-z]{3}$/.test(options.region)) throw new Error("Computer: invalid Fly region");
		if (!/^[a-z][a-z0-9-]{1,20}$/.test(this.prefix())) throw new Error("Computer: invalid app prefix");
		if (options.salt.length < 16) throw new Error("Computer: a salt of at least 16 characters");
		this.slots = new Slots(options.maxConcurrent ?? 8);
		this.api = (options.apiUrl ?? "https://api.machines.dev").replace(/\/+$/, "");
		this.fetch = options.fetch ?? fetch;
	}

	run(key: string, command: string, options: { readonly timeoutS: number; readonly signal?: AbortSignal }): Promise<ComputerRun> {
		return this.locks.run(key, () =>
			this.slots.run(async () => {
				// Cancelled while it waited its turn, or while its machine started: nothing is started for it.
				const aborted = () => options.signal?.aborted === true;
				if (aborted()) return cancelled(this.full.has(key));
				const machine = await this.launch(key);
				if (aborted()) return cancelled(this.full.has(key));
				const timeoutS = Math.max(1, Math.min(COMPUTER_LIMITS.maxTimeoutS, Math.round(options.timeoutS)));
				const job = randomBytes(8).toString("hex");
				const started = Date.now();
				await this.startJob(key, machine, job, command, timeoutS);
				const result = await this.waitJob(key, machine, job, started + (timeoutS + 30) * 1000, options.signal);
				const ms = result.ms ?? Date.now() - started;
				if (result.diskKb !== undefined) {
					if (result.diskKb > this.diskMb() * 1024) this.full.add(key);
					else this.full.delete(key);
				}
				return {
					exitCode: result.exitCode ?? null,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					timedOut: result.timedOut === true,
					killed: result.killed === true,
					truncated: result.truncated === true,
					ms,
					diskFull: this.full.has(key),
				};
			}),
		);
	}

	put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		if (files.length === 0) return Promise.resolve();
		return this.locks.run(key, async () => {
			if (this.full.has(key)) throw new ComputerError(`il disco del computer è pieno (${this.diskMb()} MB): prima vanno cancellati dei file in /work`);
			const machine = await this.launch(key);
			const chunk = this.chunk();
			for (const file of files) {
				// At least one piece, so an empty file is written too.
				for (let offset = 0; offset === 0 || offset < file.data.length; offset += chunk) {
					const piece = Buffer.from(file.data.subarray(offset, offset + chunk)).toString("base64");
					await this.tool(key, machine, ["write", file.path, String(offset)], piece);
				}
			}
		});
	}

	get(key: string, path: string, maxBytes: number): Promise<Uint8Array> {
		return this.locks.run(key, async () => {
			const machine = await this.launch(key);
			const stat = JSON.parse(await this.tool(key, machine, ["stat", path])) as { kind?: string; size?: number };
			if (stat.kind === "missing") throw new ComputerError(`nel computer non c'è /work/${path}`);
			if (stat.kind === "dir") throw new ComputerError(`/work/${path} è una cartella: indica i file uno per uno`);
			if (stat.kind === "link") throw new ComputerError(`/work/${path} è un collegamento, non un file`);
			if (stat.kind !== "file") throw new ComputerError(`/work/${path} non è un file`);
			const size = Number(stat.size ?? 0);
			if (size > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
			const parts: Buffer[] = [];
			let read = 0;
			while (read < size) {
				const piece = Buffer.from((await this.tool(key, machine, ["read", path, String(read), String(Math.min(this.chunk(), size - read))])).trim(), "base64");
				// Nothing where the file had more: it changed while it was read, and half a file is not a file.
				if (piece.length === 0) throw new ComputerError(`/work/${path} è cambiato mentre veniva letto: riprova`);
				parts.push(piece);
				read += piece.length;
				if (read > maxBytes) throw new ComputerError(`/work/${path} è più grande di ${Math.round(maxBytes / 1024 / 1024)} MB`);
			}
			return new Uint8Array(Buffer.concat(parts));
		});
	}

	reset(key: string): Promise<void> {
		return this.locks.run(key, async () => {
			this.machines.delete(key);
			this.full.delete(key);
			// The app goes with its machine, its volume and its network; Fly deletes it in the background.
			await this.call("DELETE", `/v1/apps/${this.app(key)}`, undefined, [200, 202, 404]);
			for (let i = 0; i < 30 && (await this.call("GET", `/v1/apps/${this.app(key)}`, undefined, [200, 404])) !== undefined; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
		});
	}

	async check(): Promise<string | undefined> {
		try {
			await this.call("GET", `/v1/apps?org_slug=${encodeURIComponent(this.options.org)}`, undefined, [200]);
			return undefined;
		} catch (error) {
			const text = message(error);
			if (/HTTP 401|HTTP 403/.test(text)) return "Fly rifiuta il token: controlla FLY_API_TOKEN e che sia dell'organizzazione indicata";
			this.options.log?.(`computer: Fly check failed: ${text.slice(0, 200)}`);
			return "Fly non risponde: riprova tra poco";
		}
	}

	/** Machines stop by themselves when idle; this stops the ones this process used, sooner. */
	async close(): Promise<void> {
		await Promise.all(
			[...this.machines].map(([key, machine]) =>
				this.locks.run(key, () => this.call("POST", `/v1/apps/${this.app(key)}/machines/${machine}/stop`, {}, [200, 404, 412]).catch((error: unknown) => this.options.log?.(`computer: ${key} not stopped: ${message(error)}`))),
			),
		);
	}

	/** The command, started in the background. Right after a boot the machine may not be ready yet: it is asked again. */
	private async startJob(key: string, machine: string, job: string, command: string, timeoutS: number): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const out = await this.exec(key, machine, [RUNNER, "start", job, String(timeoutS), this.full.has(key) ? "1" : "0"], 30, command);
			if (out.exitCode === 0) return;
			if (/not ready/.test(out.stderr) && attempt < 10) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				continue;
			}
			if (/not ready/.test(out.stderr)) throw new Error("computer: the machine is not ready, Fly's API or the way to private addresses inside it may be open (owni-fly-init failed): no command runs there");
			throw new Error(`computer: start failed (${out.exitCode}): ${out.stderr.slice(0, 200)}`);
		}
	}

	/** Its result, waited for in slices until `deadline`; cut short on abort or when the deadline passes. */
	private async waitJob(key: string, machine: string, job: string, deadline: number, signal?: AbortSignal): Promise<Result> {
		const slice = this.options.waitSliceS ?? WAIT_SLICE_S;
		const aborted = () => signal?.aborted === true;
		while (Date.now() < deadline && !aborted()) {
			const seconds = Math.max(1, Math.min(slice, Math.ceil((deadline - Date.now()) / 1000)));
			let out: Exec;
			try {
				out = await this.exec(key, machine, [RUNNER, "wait", job, String(seconds)], seconds + 15, undefined, signal);
			} catch (error) {
				if (aborted()) break;
				throw error;
			}
			const result = parseResult(out);
			if (result.done) return result;
			if (result.missing === true) throw new Error("computer: the command's result is gone (the machine restarted?)");
		}
		// Aborted, or no end in sight: the command ends here, and what it wrote so far comes back.
		await this.exec(key, machine, [RUNNER, "kill", job], 30).catch((error: unknown) => this.options.log?.(`computer: kill failed: ${message(error)}`));
		const last = await this.exec(key, machine, [RUNNER, "wait", job, "10"], 25)
			.then(parseResult)
			.catch((): Result => ({ done: false }));
		return last.done ? { ...last, exitCode: null, timedOut: true, killed: false } : { done: true, exitCode: null, timedOut: true };
	}

	/** One of owni-run's file tools, as uid 1000: its output, or a ComputerError for what it refused. */
	private async tool(key: string, machine: string, args: string[], stdin?: string): Promise<string> {
		const out = await this.exec(key, machine, [RUNNER, ...args], 50, stdin);
		if (out.exitCode === 0) return out.stdout;
		if (/invalid path/.test(out.stderr)) throw new ComputerError("percorso non valido");
		if (/No space left|File too large|Disk quota/i.test(out.stderr)) throw new ComputerError(`il disco del computer è pieno (${this.diskMb()} MB): prima vanno cancellati dei file in /work`);
		if (/IsADirectoryError|NotADirectoryError|FileExistsError/.test(out.stderr)) throw new ComputerError(`in /work c'è già una cartella o un file con quel nome: ${args[1] ?? ""}`);
		if (/not a file|ELOOP|Too many levels of symbolic links/i.test(out.stderr)) throw new ComputerError(`/work/${args[1] ?? ""} non è un file`);
		if (/FileNotFoundError/.test(out.stderr)) throw new ComputerError(`nel computer non c'è /work/${args[1] ?? ""}`);
		throw new Error(`computer: ${args[0]} failed (${out.exitCode}): ${out.stderr.slice(0, 200)}`);
	}

	/** A command through Fly's exec API; a machine that stopped since (idle) is started again, once. */
	private async exec(key: string, machine: string, command: string[], timeoutS: number, stdin?: string, signal?: AbortSignal): Promise<Exec> {
		const body = { command, timeout: Math.min(60, timeoutS), ...(stdin === undefined ? {} : { stdin }) };
		const path = (id: string) => `/v1/apps/${this.app(key)}/machines/${id}/exec`;
		let answer: unknown;
		try {
			answer = await this.call("POST", path(machine), body, [200], (timeoutS + 10) * 1000, signal);
		} catch (error) {
			if (signal?.aborted === true || !/HTTP (404|409|412)/.test(message(error))) throw error;
			this.machines.delete(key);
			answer = await this.call("POST", path(await this.launch(key)), body, [200], (timeoutS + 10) * 1000, signal);
		}
		const out = (answer ?? {}) as { exit_code?: number; exit_signal?: number; stdout?: string; stderr?: string };
		// Ended by a signal (the kernel out of memory): Fly leaves exit_code out, as for a success.
		if (out.exit_signal !== undefined && out.exit_signal !== 0) return { exitCode: 128 + Number(out.exit_signal), stdout: String(out.stdout ?? ""), stderr: `${String(out.stderr ?? "")}\nkilled by signal ${out.exit_signal}` };
		return { exitCode: Number(out.exit_code ?? 0), stdout: String(out.stdout ?? ""), stderr: String(out.stderr ?? "") };
	}

	/**
	 * The computer's machine, started: its app, network and volume created on first use, its
	 * config updated when image or limits changed (the volume stays, and grows with the quota).
	 * Called under its lock.
	 */
	private async launch(key: string): Promise<string> {
		const app = this.app(key);
		const spec = this.spec(key);
		const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
		let machine: Machine | undefined;
		const known = this.machines.get(key);
		if (known !== undefined) machine = (await this.call("GET", `/v1/apps/${app}/machines/${known}`, undefined, [200, 404])) as Machine | undefined;
		if (machine === undefined) {
			const exists = await this.call("GET", `/v1/apps/${app}`, undefined, [200, 404]);
			if (exists === undefined) {
				// A network of its own: no other app, no other computer, can reach it on Fly's private network.
				// Both spellings of the name: the public API documents app_name, Fly's own client sends name.
				try {
					await this.call("POST", "/v1/apps", { app_name: app, name: app, org_slug: this.options.org, network: app }, [200, 201]);
				} catch (error) {
					// App names are global on Fly: taken by another organization means a clash of prefixes.
					if (/HTTP (409|422)/.test(message(error))) throw new Error(`computer: the Fly app name ${app} is taken outside ${this.options.org}: set OWNI_FLY_APP_PREFIX to a name of this installation`);
					throw error;
				}
			}
			const list = ((await this.call("GET", `/v1/apps/${app}/machines`, undefined, [200])) ?? []) as Machine[];
			machine = list.find((m) => m.config?.metadata?.owni_computer === key && m.state !== "destroyed" && m.state !== "destroying");
			if (list.some((m) => m.config?.metadata?.owni_computer !== key)) throw new Error(`computer: app ${app} has machines that are not this computer`);
		}
		let version: string | undefined;
		if (machine === undefined) {
			// A volume left by a machine that failed to be created is used again, not paid for twice.
			const volumes = ((await this.call("GET", `/v1/apps/${app}/volumes`, undefined, [200])) ?? []) as { id?: string; name?: string; attached_machine_id?: string | null; state?: string }[];
			const free = volumes.find((v) => v.name === "work" && (v.attached_machine_id ?? null) === null && v.state !== "destroyed" && v.state !== "pending_destroy");
			const volume = free ?? ((await this.call("POST", `/v1/apps/${app}/volumes`, { name: "work", region: this.options.region, size_gb: this.volumeGb(), encrypted: true, auto_backup_enabled: false }, [200, 201])) as { id?: string });
			if (typeof volume?.id !== "string") throw new Error("computer: Fly gave no volume id");
			const created = (await this.call("POST", `/v1/apps/${app}/machines`, { name: "computer", region: this.options.region, config: this.config(spec, hash, volume.id) }, [200, 201])) as Machine;
			if (typeof created?.id !== "string") throw new Error("computer: Fly gave no machine id");
			machine = created;
			version = created.instance_id;
		} else if (machine.config?.metadata?.owni_spec !== hash) {
			const volume = machine.config?.mounts?.[0]?.volume;
			if (volume === undefined) throw new Error(`computer: machine ${machine.id} has no volume`);
			// A bigger quota grows the volume; a volume never shrinks.
			const current = (await this.call("GET", `/v1/apps/${app}/volumes/${volume}`, undefined, [200])) as { size_gb?: number };
			if (Number(current?.size_gb ?? 0) < this.volumeGb()) await this.call("PUT", `/v1/apps/${app}/volumes/${volume}/extend`, { size_gb: this.volumeGb() }, [200]);
			this.options.log?.(`computer: ${key} updated with the new image or limits (its files stay)`);
			// Its region stays: the volume cannot move.
			const updated = (await this.call("POST", `/v1/apps/${app}/machines/${machine.id}`, { ...(machine.region === undefined ? {} : { region: machine.region }), config: this.config(spec, hash, volume) }, [200])) as Machine;
			machine = { ...updated, id: machine.id };
			version = updated.instance_id;
		}
		const id = machine.id;
		if (!/^[a-z0-9]{6,40}$/.test(id)) throw new Error("computer: unexpected machine id");
		await this.started(app, id, machine.state, version);
		this.machines.set(key, id);
		return id;
	}

	/** Until the machine runs: started from where it is, a first boot (an image pull) waited for longer. */
	private async started(app: string, id: string, state: string | undefined, version: string | undefined): Promise<void> {
		if (state === "started") return;
		const wait = (want: string, of?: string) => this.call("GET", `/v1/apps/${app}/machines/${id}/wait?state=${want}&timeout=${START_TIMEOUT_S}${of === undefined ? "" : `&instance_id=${encodeURIComponent(of)}`}`, undefined, [200, 408], (START_TIMEOUT_S + 10) * 1000);
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		const until = async (want: string, of?: string) => {
			// Fly's wait answers 408 after its timeout: asked again until the deadline.
			while ((await wait(want, of)) === TIMED_OUT) if (Date.now() > deadline) throw new Error(`computer: machine ${id} not ${want} after ${BOOT_TIMEOUT_MS / 1000} s`);
		};
		// Stopping (its idle time just ended): it stops first, then starts again.
		if (state === "stopping") {
			await until("stopped");
			state = "stopped";
		}
		if (state === "stopped" || state === "suspended" || state === "failed") await this.call("POST", `/v1/apps/${app}/machines/${id}/start`, {}, [200]);
		if (state === "destroying" || state === "destroyed") throw new Error(`computer: machine ${id} is being destroyed`);
		await until("started", version);
	}

	private spec(key: string): Record<string, unknown> {
		return {
			key,
			image: this.options.image,
			guest: { cpu_kind: "shared", cpus: this.options.cpus ?? 1, memory_mb: this.options.memoryMb ?? 1024 },
			idleS: this.options.idleS ?? 600,
			volumeGb: this.volumeGb(),
		};
	}

	private config(spec: Record<string, unknown>, hash: string, volume: string): Record<string, unknown> {
		return {
			image: spec.image,
			guest: spec.guest,
			env: { OWNI_IDLE_S: String(spec.idleS) },
			mounts: [{ volume, path: "/work" }],
			// No services: nothing reaches it through Fly's proxy, and it has no public address.
			services: [],
			// Its first process ending (idle) stops the machine; nothing starts it again but a command.
			restart: { policy: "no" },
			auto_destroy: false,
			dns: { skip_registration: true },
			metadata: { owni_computer: spec.key as string, owni_spec: hash },
		};
	}

	private diskMb(): number {
		return this.options.diskMb ?? 2048;
	}

	private volumeGb(): number {
		return Math.max(1, Math.ceil(this.diskMb() / 1024));
	}

	private chunk(): number {
		return this.options.chunkBytes ?? CHUNK_BYTES;
	}

	private prefix(): string {
		return this.options.appPrefix ?? "owni-computer";
	}

	/** App names are global on Fly: the organization goes into it, so two installations never clash. */
	private app(key: string): string {
		if (!/^[a-z0-9]{1,40}$/.test(key)) throw new Error("Invalid computer key");
		return `${this.prefix()}-${createHmac("sha256", this.options.salt).update(`${this.options.org}\0${key}`).digest("hex").slice(0, 24)}`;
	}

	/** The Fly app of a computer, for the operator (pnpm cloud computers). */
	appOf(key: string): string {
		return this.app(key);
	}

	private async call(method: string, path: string, body: unknown, ok: readonly number[], timeoutMs = API_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const token = this.options.token.startsWith("FlyV1 ") ? this.options.token : `Bearer ${this.options.token}`;
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await this.fetch(`${this.api}${path}`, {
			method,
			headers: { authorization: token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
		});
		const text = await response.text();
		if (!ok.includes(response.status)) throw new Error(`fly ${method} ${path.split("?")[0]}: HTTP ${response.status} ${flyMessage(text)}`);
		if (response.status === 404) return undefined;
		if (response.status === 408) return TIMED_OUT;
		if (text === "") return {};
		try {
			return JSON.parse(text);
		} catch {
			return {};
		}
	}
}

/**
 * The installation's salt for the names of its Fly apps, made once in the data folder. Kept with
 * the data (and its backup): with another salt the computers' apps are other apps, and the old
 * ones stay on Fly until deleted there.
 */
export function computerSalt(dataDir: string): string {
	const file = join(dataDir, "computer-salt");
	if (!existsSync(file)) {
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(file, randomBytes(24).toString("hex"), { flag: "wx", mode: 0o600 });
	}
	chmodSync(file, 0o600);
	return readFileSync(file, "utf8").trim();
}

function cancelled(diskFull: boolean): ComputerRun {
	return { exitCode: null, stdout: "", stderr: "", timedOut: true, killed: false, truncated: false, ms: 0, diskFull };
}

function parseResult(out: Exec): Result {
	if (out.exitCode !== 0) throw new Error(`computer: wait failed (${out.exitCode}): ${out.stderr.slice(0, 200)}`);
	try {
		const result = JSON.parse(out.stdout) as Result;
		return typeof result === "object" && result !== null ? result : { done: false };
	} catch {
		throw new Error("computer: unreadable result");
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function flyMessage(text: string): string {
	try {
		return String((JSON.parse(text) as { error?: string }).error ?? "").slice(0, 200);
	} catch {
		return text.slice(0, 200);
	}
}
