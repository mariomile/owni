import { request } from "node:http";
import type { CellProvider, CellStatus } from "./provider.ts";

export type DockerCellOptions = {
	/** The Owni image (the repository's Dockerfile). */
	readonly image: string;
	/** Docker Engine API socket. */
	readonly socketPath?: string;
	/** Per cell. */
	readonly memoryMb?: number;
	readonly cpus?: number;
	/** How long a starting cell has to answer /healthz. */
	readonly startTimeoutMs?: number;
};

const LABEL = "owni.cell";
const NETWORK = "owni-cells";
const API_TIMEOUT_MS = 30_000;
const PORT = "8080/tcp";

/**
 * Cells as containers on one Docker host: for a single EU server before micro-VMs (ADR 0008).
 * Each cell has its own container and volume on a shared bridge where containers cannot reach
 * each other; it runs as uid 1000 (never root) with a read-only root, no Linux capabilities, no
 * privilege escalation, and memory, CPU and process limits. Its port is published on 127.0.0.1
 * only: the control plane on the same host is the way in.
 *
 * Isolation is a container's, weaker than a micro-VM's (ADR 0007): the kernel is shared.
 */
export class DockerCellProvider implements CellProvider {
	private readonly starting = new Map<string, Promise<void>>();

	constructor(private readonly options: DockerCellOptions) {
		const memory = options.memoryMb ?? 512;
		const cpus = options.cpus ?? 1;
		// Docker reads a missing or zero value as "no limit".
		if (!Number.isInteger(memory) || memory < 128) throw new Error("Docker cells: memory of at least 128 MB");
		if (!(cpus > 0)) throw new Error("Docker cells: a positive number of CPUs");
	}

	async create(id: string, env: Readonly<Record<string, string>>): Promise<void> {
		if ((await this.inspect(id)) !== undefined) throw new Error(`Cell ${id} exists`);
		await this.ensureNetwork();
		await this.createContainer(id, env);
	}

	/**
	 * One bridge for every cell, with traffic between containers turned off: cells reach the
	 * internet and the host reaches them, but they cannot reach each other. (A network per cell
	 * would run out of Docker's address pools at about thirty tenants.)
	 */
	private async ensureNetwork(): Promise<void> {
		if ((await this.api("GET", `/networks/${NETWORK}`, undefined, [200, 404])) !== undefined) return;
		await this.api("POST", "/networks/create", { Name: NETWORK, Driver: "bridge", Options: { "com.docker.network.bridge.enable_icc": "false" }, Labels: { [LABEL]: "network" } }, [201, 409]);
	}

	/**
	 * A new container for the cell from the current image, with its environment changed by
	 * `changes`; volume and network stay, so its data does too. For upgrades and a new model key.
	 * Run it with the control plane stopped: the cell is down meanwhile.
	 */
	async upgrade(id: string, changes: Readonly<Record<string, string>> = {}): Promise<void> {
		const info = await this.inspect(id);
		if (info === undefined) throw new Error(`No cell ${id}`);
		// The cell's own environment: what the container has minus what its old image set.
		const image = (await this.api("GET", `/images/${encodeURIComponent(info.Image ?? "")}/json`, undefined, [200, 404])) as { Config?: { Env?: string[] } } | undefined;
		const fromImage = new Set(image?.Config?.Env ?? []);
		const env = Object.fromEntries((info.Config?.Env ?? []).filter((e) => !fromImage.has(e)).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
		const wasRunning = info.State?.Running === true;
		await this.api("DELETE", `/containers/${cellName(id)}?force=true`, undefined, [204, 404]);
		await this.createContainer(id, { ...env, ...changes });
		if (wasRunning) await this.start(id);
	}

	private async createContainer(id: string, env: Readonly<Record<string, string>>): Promise<void> {
		const name = cellName(id);
		const memory = (this.options.memoryMb ?? 512) * 1024 * 1024;
		await this.api(
			"POST",
			`/containers/create?name=${name}`,
			{
				Image: this.options.image,
				// The node user of the official image, whatever the image says: never root.
				User: "1000:1000",
				Env: Object.entries({ ...env, OWNI_DATA_DIR: "/data", OWNI_WEB_HOST: "0.0.0.0", OWNI_WEB_PORT: "8080" }).map(([k, v]) => `${k}=${v}`),
				Labels: { [LABEL]: id },
				ExposedPorts: { [PORT]: {} },
				HostConfig: {
					Binds: [`${name}:/data`],
					NetworkMode: NETWORK,
					PortBindings: { [PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
					ReadonlyRootfs: true,
					Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
					CapDrop: ["ALL"],
					SecurityOpt: ["no-new-privileges:true"],
					Memory: memory,
					MemorySwap: memory,
					NanoCpus: Math.round((this.options.cpus ?? 1) * 1e9),
					PidsLimit: 256,
					RestartPolicy: { Name: "no" },
					LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
				},
			},
			[201],
		);
	}

	start(id: string): Promise<void> {
		const pending = this.starting.get(id);
		if (pending !== undefined) return pending;
		const starting = this.launch(id).finally(() => this.starting.delete(id));
		this.starting.set(id, starting);
		return starting;
	}

	async stop(id: string): Promise<void> {
		await this.starting.get(id)?.catch(() => {});
		// 304: already stopped.
		await this.api("POST", `/containers/${cellName(id)}/stop?t=10`, undefined, [204, 304, 404]);
	}

	async destroy(id: string): Promise<void> {
		const name = cellName(id);
		await this.api("DELETE", `/containers/${name}?force=true`, undefined, [204, 404]);
		await this.api("DELETE", `/volumes/${name}`, undefined, [204, 404]);
	}

	async status(id: string): Promise<CellStatus> {
		const info = await this.inspect(id);
		if (info === undefined) return "missing";
		return info.State?.Running === true ? "running" : "stopped";
	}

	async list(): Promise<string[]> {
		const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
		const containers = (await this.api("GET", `/containers/json?all=true&filters=${filters}`, undefined, [200])) as { Labels?: Record<string, string> }[];
		return containers.map((c) => c.Labels?.[LABEL]).filter((id): id is string => id !== undefined);
	}

	async baseUrl(id: string): Promise<string> {
		const port = (await this.inspect(id))?.NetworkSettings?.Ports?.[PORT]?.[0]?.HostPort;
		if (port === undefined || port === "") throw new Error(`Cell ${id} is not running`);
		return `http://127.0.0.1:${port}`;
	}

	private async launch(id: string): Promise<void> {
		if ((await this.status(id)) === "running") return;
		await this.api("POST", `/containers/${cellName(id)}/start`, undefined, [204, 304]);
		const deadline = Date.now() + (this.options.startTimeoutMs ?? 60_000);
		while (Date.now() < deadline) {
			const info = await this.inspect(id);
			if (info?.State?.Running !== true) {
				// The cell's output can hold its content: it stays in `docker logs`, not in ours.
				throw new Error(`Cell ${id} exited at start (code ${info?.State?.ExitCode ?? "?"}); see docker logs ${cellName(id)}`);
			}
			const ok = await fetch(`${await this.baseUrl(id)}/healthz`, { signal: AbortSignal.timeout(2_000) })
				.then((r) => r.ok)
				.catch(() => false);
			if (ok) return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		// Not stop(): it waits for this very start to finish.
		await this.api("POST", `/containers/${cellName(id)}/stop?t=10`, undefined, [204, 304, 404]).catch(() => {});
		throw new Error(`Cell ${id} did not answer in time`);
	}

	private async inspect(id: string): Promise<ContainerInfo | undefined> {
		const info = await this.api("GET", `/containers/${cellName(id)}/json`, undefined, [200, 404]);
		return info === undefined ? undefined : (info as ContainerInfo);
	}

	/** One Docker Engine API call. Returns undefined for a 404 that was accepted. */
	private api(method: string, path: string, body: unknown, ok: readonly number[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath: this.options.socketPath ?? "/var/run/docker.sock", path: `/v1.44${path}`, method, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					const text = Buffer.concat(chunks).toString("utf8");
					if (!ok.includes(status)) return reject(new Error(`docker ${method} ${path.split("?")[0]}: HTTP ${status} ${dockerMessage(text)}`));
					if (status === 404 || status === 204 || status === 304 || text === "") return resolve(undefined);
					try {
						resolve(JSON.parse(text));
					} catch {
						resolve(undefined);
					}
				});
			});
			// A daemon that hangs must not hang the control plane with it.
			req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: no answer in ${API_TIMEOUT_MS / 1000} s`)));
			req.on("error", reject);
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
}

type ContainerInfo = { Image?: string; Config?: { Env?: string[] }; State?: { Running?: boolean; ExitCode?: number }; NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> } };

function cellName(id: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`Invalid cell id ${id}`);
	return `owni-cell-${id}`;
}

function dockerMessage(text: string): string {
	try {
		return String((JSON.parse(text) as { message?: string }).message ?? "").slice(0, 200);
	} catch {
		return text.slice(0, 200);
	}
}
