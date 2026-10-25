import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { PerKey } from "../computer/queue.ts";
import { DESKTOP_READ_TOOLS, DesktopError, type DesktopProvider, type DesktopResult } from "../core/desktop.ts";
import { McpHttpClient } from "./mcp-client.ts";
import { Spaces } from "./spaces.ts";

/** Cua's XFCE desktop, pinned: a new tag is a choice, tried before it is made (amd64 only, about 8 GB). */
export const DESKTOP_IMAGE = "trycua/cua-xfce:0.3.0";

export type DockerDesktopOptions = {
	/** none: an internal Docker network, no internet. internet: a network that reaches it (the operator's choice). */
	readonly network: "none" | "internet";
	/** Docker Engine API socket. */
	readonly socketPath?: string;
	/** Tests: another image. */
	readonly image?: string;
	readonly memoryMb?: number;
	readonly cpus?: number;
	/** A desktop with no action for this long is stopped (what is open in it is lost on the next start). */
	readonly idleMs?: number;
	/** Desktops running at once; the one unused the longest is stopped to start another. */
	readonly maxRunning?: number;
	/** How long a desktop gets to boot (XFCE, VNC, Cua's daemon) before it is given up on. */
	readonly bootTimeoutMs?: number;
	/** Tests: the daemon's port (Cua's is 3211) and how often /health is asked while booting. */
	readonly spacesPort?: number;
	readonly healthIntervalMs?: number;
	readonly fetch?: typeof fetch;
	readonly log?: (message: string) => void;
};

/** Docker Engine API 1.41: Docker 20.10 and later. */
const API = "/v1.41";
const LABEL = "owni.desktop";
/** A hash of how the container was created, without its secrets: a change of image or limits recreates it. */
const SPEC_LABEL = "owni.desktop.spec";
const API_TIMEOUT_MS = 30_000;
const SPACES_PORT = 3211;
/** The screen's size: screenshots reach the model at this size, so its coordinates are the screen's. */
const RESOLUTION = "1280x800";

type Running = { readonly spaces: Spaces; readonly timer: NodeJS.Timeout };
type Inspect = { State?: { Running?: boolean }; Config?: { Labels?: Record<string, string>; Env?: string[] }; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } };

/**
 * A desktop per agente as a container of Cua's image on this Docker host (ADR 0045). It sits on
 * its own Docker network: internal (no internet) unless the operator chose otherwise, with
 * traffic between containers off when Owni creates it, so desktops do not see each other.
 * Owni reaches Cua's daemon at the container's address on that network, with a token made
 * for that container; the VNC password is random too, and no port is published on the host.
 */
export class DockerDesktopProvider implements DesktopProvider {
	readonly network: "none" | "internet";
	readonly shared = false;
	private readonly locks = new PerKey();
	/** Desktops this process talks to, least recently used first, with their idle timers. */
	private readonly running = new Map<string, Running>();
	private networkReady: Promise<void> | undefined;
	private readonly fetch: typeof fetch;

	constructor(private readonly options: DockerDesktopOptions) {
		const memory = options.memoryMb ?? 3072;
		if (!Number.isInteger(memory) || memory < 1024) throw new Error("Desktop: memory of at least 1024 MB");
		if (!((options.cpus ?? 2) > 0)) throw new Error("Desktop: a positive number of CPUs");
		this.network = options.network;
		this.fetch = options.fetch ?? fetch;
	}

	call(key: string, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<DesktopResult> {
		return this.locks.run(key, async () => {
			let spaces = await this.launch(key);
			let result: DesktopResult;
			try {
				result = await spaces.call(tool, args, signal);
			} catch (error) {
				// A desktop stopped behind our back (a restart of Docker) is started again, once. A look is
				// asked again after any lost connection; an action only when it surely never arrived, so
				// a click that went through is never made twice.
				if (error instanceof DesktopError || signal?.aborted === true || !(DESKTOP_READ_TOOLS.includes(tool) ? unreachable(error) : refused(error))) throw error;
				this.forget(key);
				spaces = await this.launch(key);
				result = await spaces.call(tool, args, signal);
			}
			this.touch(key);
			return result;
		});
	}

	reset(key: string): Promise<void> {
		return this.locks.run(key, async () => {
			this.forget(key);
			await this.api("DELETE", `/containers/${name(key)}?force=true`, undefined, [204, 404]);
		});
	}

	async check(): Promise<string | undefined> {
		try {
			await this.api("GET", "/_ping", undefined, [200]);
			const info = (await this.api("GET", "/info", undefined, [200])) as { Architecture?: string } | undefined;
			if (info?.Architecture !== undefined && !["x86_64", "amd64"].includes(info.Architecture)) return `l'immagine di Cua esiste solo per amd64, e questo server è ${info.Architecture}`;
			const image = await this.api("GET", `/images/${encodeURIComponent(this.image())}/json`, undefined, [200, 404]);
			if (image === undefined) return `l'immagine ${this.image()} non c'è: si scarica con docker pull ${this.image()} (circa 8 GB)`;
			return undefined;
		} catch (error) {
			return `Docker non risponde su ${this.socket()} (${message(error).slice(0, 120)})`;
		}
	}

	/**
	 * At boot: desktops left running by a previous run of Owni are stopped, those already stopped
	 * removed (nothing in them is kept: a desktop starts afresh). They start again at their next action.
	 */
	async stopLeftovers(): Promise<number> {
		const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
		const list = ((await this.api("GET", `/containers/json?all=1&filters=${filters}`, undefined, [200])) ?? []) as { Labels?: Record<string, string>; State?: string }[];
		let handled = 0;
		for (const container of list) {
			const key = container.Labels?.[LABEL];
			if (key === undefined || !KEY.test(key) || this.running.has(key)) continue;
			if (container.State === "running") await this.locks.run(key, () => this.stop(key));
			else await this.locks.run(key, () => this.api("DELETE", `/containers/${name(key)}?force=true`, undefined, [204, 404]));
			handled += 1;
		}
		return handled;
	}

	async close(): Promise<void> {
		await Promise.all([...this.running.keys()].map((key) => this.locks.run(key, () => this.stop(key))));
	}

	private async stop(key: string): Promise<void> {
		this.forget(key);
		await this.api("POST", `/containers/${name(key)}/stop?t=5`, undefined, [204, 304, 404]).catch((error: unknown) => this.options.log?.(`desktop: ${key} not stopped: ${message(error)}`));
	}

	private forget(key: string): void {
		const running = this.running.get(key);
		if (running === undefined) return;
		clearTimeout(running.timer);
		running.spaces.reset();
		this.running.delete(key);
	}

	/** Stopped after a while with no actions; most recently used last. */
	private touch(key: string): void {
		const running = this.running.get(key);
		if (running === undefined) return;
		clearTimeout(running.timer);
		this.running.delete(key);
		this.running.set(key, { spaces: running.spaces, timer: this.idleTimer(key) });
	}

	private idleTimer(key: string): NodeJS.Timeout {
		const timer = setTimeout(() => void this.locks.run(key, () => this.stop(key)), this.options.idleMs ?? 15 * 60_000);
		timer.unref();
		return timer;
	}

	/** Created on first use, recreated when its spec changed, started when stopped, waited for. Called under the desktop's lock. */
	private async launch(key: string): Promise<Spaces> {
		const known = this.running.get(key);
		if (known !== undefined) return known.spaces;
		// Room for one more: the desktop unused the longest stops (not awaited: it waits for its own lock).
		const max = this.options.maxRunning ?? 4;
		for (const other of [...this.running.keys()]) {
			if (this.running.size < max) break;
			if (this.locks.has(other)) continue;
			this.forget(other);
			void this.locks.run(other, () => this.stop(other));
		}
		if (this.running.size >= max) throw new DesktopError(`troppi schermi accesi su questo server (${max}), tutti al lavoro: riprova tra un minuto`);
		await this.ensureNetwork();
		const spec = this.spec();
		const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
		let info = (await this.api("GET", `/containers/${name(key)}/json`, undefined, [200, 404])) as Inspect | undefined;
		if (info !== undefined && info.Config?.Labels?.[LABEL] !== key) throw new Error(`desktop: container ${name(key)} exists and is not this desktop`);
		if (info !== undefined && info.Config?.Labels?.[SPEC_LABEL] !== hash) {
			this.options.log?.(`desktop: ${key} recreated with the new image, network or limits`);
			await this.api("DELETE", `/containers/${name(key)}?force=true`, undefined, [204, 404]);
			info = undefined;
		}
		if (info === undefined) {
			// The secrets live in the container's settings: after a restart Owni reads them back from Docker.
			const env = [`CUA_ENV_TOKEN=${randomBytes(32).toString("hex")}`, `VNC_PW=${randomBytes(12).toString("hex")}`, `VNC_RESOLUTION=${RESOLUTION}`];
			try {
				await this.api("POST", `/containers/create?name=${name(key)}`, { ...spec, Env: env, Labels: { [LABEL]: key, [SPEC_LABEL]: hash } }, [201]);
			} catch (error) {
				if (/No such image/i.test(message(error))) throw new DesktopError(`lo schermo non è pronto su questo server: manca l'immagine ${this.image()}, l'operatore la scarica con docker pull`);
				throw error;
			}
		}
		if (info?.State?.Running !== true) await this.api("POST", `/containers/${name(key)}/start`, undefined, [204, 304]);
		info = (await this.api("GET", `/containers/${name(key)}/json`, undefined, [200])) as Inspect;
		const token = info.Config?.Env?.find((e) => e.startsWith("CUA_ENV_TOKEN="))?.slice("CUA_ENV_TOKEN=".length);
		const address = info.NetworkSettings?.Networks?.[this.networkName()]?.IPAddress;
		if (token === undefined || token === "") throw new Error(`desktop: ${name(key)} has no token`);
		if (address === undefined || !/^[\d.]{7,15}$/.test(address)) throw new Error(`desktop: ${name(key)} has no address on ${this.networkName()}`);
		const base = `http://${address}:${this.options.spacesPort ?? SPACES_PORT}`;
		await this.waitHealthy(base);
		const spaces = new Spaces(new McpHttpClient({ url: `${base}/mcp`, token, fetch: this.fetch }));
		this.running.set(key, { spaces, timer: this.idleTimer(key) });
		return spaces;
	}

	/** Cua's daemon answers /health once the desktop is up. */
	private async waitHealthy(base: string): Promise<void> {
		const deadline = Date.now() + (this.options.bootTimeoutMs ?? 120_000);
		for (;;) {
			try {
				const response = await this.fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
				await response.body?.cancel();
				if (response.ok) return;
			} catch {
				// Not listening yet.
			}
			if (Date.now() > deadline) throw new Error(`desktop: no answer on ${base}/health after ${Math.round((this.options.bootTimeoutMs ?? 120_000) / 1000)} s`);
			await new Promise((resolve) => setTimeout(resolve, this.options.healthIntervalMs ?? 1_000));
		}
	}

	/** The desktops' network, created once: internal, or not, as the operator chose; an existing one must match. */
	private ensureNetwork(): Promise<void> {
		this.networkReady ??= (async () => {
			const network = this.networkName();
			const internal = this.network === "none";
			const found = (await this.api("GET", `/networks/${network}`, undefined, [200, 404])) as { Internal?: boolean; Options?: Record<string, string> } | undefined;
			if (found !== undefined) {
				if ((found.Internal === true) !== internal) throw new Error(`desktop: the Docker network ${network} ${internal ? "reaches the internet" : "is internal"}, and OWNI_DESKTOP_NETWORK says ${internal ? "no internet" : "internet"}: remove it or fix it`);
				// Made by someone else (Docker Compose, so that Owni can join it): desktops may then reach each other.
				if (found.Options?.["com.docker.network.bridge.enable_icc"] !== "false") this.options.log?.(`desktop: warning: the Docker network ${network} lets containers talk to each other (com.docker.network.bridge.enable_icc is not "false"): one agente's screen can reach another's, kept apart only by their tokens and VNC passwords`);
				return;
			}
			// No traffic between containers: one agente's desktop cannot reach another's.
			await this.api("POST", "/networks/create", { Name: network, Driver: "bridge", Internal: internal, Labels: { [LABEL]: "network" }, Options: { "com.docker.network.bridge.enable_icc": "false" } }, [201, 409]);
		})().catch((error: unknown) => {
			this.networkReady = undefined;
			throw error;
		});
		return this.networkReady;
	}

	private networkName(): string {
		return this.network === "none" ? "owni-desktop" : "owni-desktop-internet";
	}

	private image(): string {
		return this.options.image ?? DESKTOP_IMAGE;
	}

	private spec(): Record<string, unknown> {
		const memory = (this.options.memoryMb ?? 3072) * 1024 * 1024;
		return {
			Image: this.image(),
			Hostname: "schermo",
			HostConfig: {
				NetworkMode: this.networkName(),
				// Firefox needs a large /dev/shm.
				ShmSize: 1024 * 1024 * 1024,
				Memory: memory,
				MemorySwap: memory,
				NanoCpus: Math.round((this.options.cpus ?? 2) * 1e9),
				PidsLimit: 1024,
				// No capability but those a root supervisord needs to start the desktop as its user and
				// own its files (to verify in the live test: ADR 0045). No NET_ADMIN: Docker gives the address.
				CapDrop: ["ALL"],
				CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "KILL"],
				// An init as pid 1 reaps what the desktop's programs leave behind.
				Init: true,
				SecurityOpt: ["no-new-privileges:true"],
				RestartPolicy: { Name: "no" },
				LogConfig: { Type: "none", Config: {} },
			},
		};
	}

	private socket(): string {
		return this.options.socketPath ?? "/var/run/docker.sock";
	}

	private api(method: string, path: string, body: unknown, ok: readonly number[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const headers = body === undefined ? {} : { "content-type": "application/json" };
			const req = request({ socketPath: this.socket(), path: `${API}${path}`, method, headers }, (res) => {
				const chunks: Buffer[] = [];
				let total = 0;
				res.on("data", (c: Buffer) => {
					total += c.length;
					if (total > 4 * 1024 * 1024) return req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: reply too large`));
					chunks.push(c);
				});
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					const text = Buffer.concat(chunks).toString("utf8");
					if (!ok.includes(status)) return reject(new Error(`docker ${method} ${path.split("?")[0]}: HTTP ${status} ${dockerMessage(text)}`));
					// 404 where it is expected: missing, not an error.
					if (status === 404 || text === "") return resolve(undefined);
					try {
						resolve(JSON.parse(text));
					} catch {
						resolve(undefined);
					}
				});
			});
			req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: no answer in ${API_TIMEOUT_MS / 1000} s`)));
			req.on("error", reject);
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,100}$/;

function name(key: string): string {
	if (!KEY.test(key)) throw new Error("Invalid desktop key");
	return `owni-desktop-${key}`;
}

/** The connection to the daemon was lost (refused, reset, cut): its container may not be running. */
function unreachable(error: unknown): boolean {
	return /fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up/.test(`${message(error)} ${causeOf(error)}`);
}

/** The daemon refused the connection: the request never reached it. */
function refused(error: unknown): boolean {
	return /ECONNREFUSED/.test(causeOf(error));
}

function causeOf(error: unknown): string {
	const cause = error instanceof Error ? error.cause : undefined;
	if (!(cause instanceof Error)) return "";
	return `${(cause as { code?: unknown }).code ?? ""} ${cause.message}`;
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
