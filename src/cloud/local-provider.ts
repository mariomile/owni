import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CellProvider, CellStatus } from "./provider.ts";

/**
 * Cells as local processes, each with its own data directory and port: for development, tests
 * and a single-server installation. Isolation is the operating system's, not a machine's.
 */
export class LocalCellProvider implements CellProvider {
	private readonly processes = new Map<string, ChildProcess>();
	private readonly starting = new Map<string, Promise<void>>();

	constructor(private readonly options: { readonly root: string; readonly repoRoot: string; readonly log?: (message: string) => void }) {}

	async create(id: string, env: Readonly<Record<string, string>>): Promise<void> {
		const dir = this.dir(id);
		if (existsSync(join(dir, "cell.json"))) throw new Error(`Cell ${id} exists`);
		mkdirSync(join(dir, "data"), { recursive: true });
		writeFileSync(join(dir, "cell.json"), `${JSON.stringify({ port: await freePort(), env })}\n`, { mode: 0o600 });
	}

	start(id: string): Promise<void> {
		if (this.processes.has(id)) return Promise.resolve();
		const pending = this.starting.get(id);
		if (pending !== undefined) return pending;
		const starting = this.launch(id).finally(() => this.starting.delete(id));
		this.starting.set(id, starting);
		return starting;
	}

	async stop(id: string): Promise<void> {
		await this.starting.get(id)?.catch(() => {});
		const child = this.processes.get(id);
		if (child === undefined) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		await exited;
		clearTimeout(timer);
	}

	async destroy(id: string): Promise<void> {
		await this.stop(id);
		rmSync(this.dir(id), { recursive: true, force: true });
	}

	async status(id: string): Promise<CellStatus> {
		if (!existsSync(join(this.dir(id), "cell.json"))) return "missing";
		return this.processes.has(id) ? "running" : "stopped";
	}

	async list(): Promise<string[]> {
		if (!existsSync(this.options.root)) return [];
		return readdirSync(this.options.root).filter((name) => existsSync(join(this.dir(name), "cell.json")));
	}

	async baseUrl(id: string): Promise<string> {
		return `http://127.0.0.1:${this.meta(id).port}`;
	}

	private async launch(id: string): Promise<void> {
		const { port, env } = this.meta(id);
		const child = spawn(process.execPath, [join(this.options.repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), join("src", "main", "owni.ts")], {
			cwd: this.options.repoRoot,
			// Only what the cell needs: never the control plane's own secrets.
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env, OWNI_DATA_DIR: join(this.dir(id), "data"), OWNI_WEB_HOST: "127.0.0.1", OWNI_WEB_PORT: String(port) },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		this.processes.set(id, child);
		child.once("exit", () => this.processes.delete(id));
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				// The cell's output can hold its content: it goes to the cell's folder, not to our log.
				writeFileSync(join(this.dir(id), "last-start-error.log"), stderr, { mode: 0o600 });
				throw new Error(`Cell ${id} exited at start (code ${child.exitCode}); see last-start-error.log in its folder`);
			}
			const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
			if (ok) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		child.kill("SIGKILL");
		throw new Error(`Cell ${id} did not answer within 60 seconds`);
	}

	private meta(id: string): { port: number; env: Record<string, string> } {
		return JSON.parse(readFileSync(join(this.dir(id), "cell.json"), "utf8")) as { port: number; env: Record<string, string> };
	}

	private dir(id: string): string {
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`Invalid cell id ${id}`);
		return join(this.options.root, id);
	}
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}
