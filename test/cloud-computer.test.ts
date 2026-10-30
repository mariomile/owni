import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StripeBilling } from "../src/cloud/billing.ts";
import { type ControlPlane, cloudComputers, deleteTenantComputers, startControlPlane } from "../src/cloud/control-plane.ts";
import { MemoryMailer } from "../src/cloud/mailer.ts";
import type { CellProvider } from "../src/cloud/provider.ts";
import { createComputerProvider } from "../src/computer/create.ts";
import { RemoteComputerProvider } from "../src/computer/remote-computer.ts";
import { ComputerError, type ComputerProvider, type ComputerRun, type ComputerScreen, computerKey } from "../src/core/computer.ts";
import { ConfigError, loadOwniConfig, loadComputerConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";

/** The computers of Owni Cloud (ADR 0015): cells ask the control plane, which holds Fly's token. */
const running: ControlPlane[] = [];
afterEach(async () => {
	for (const cp of running.splice(0)) await cp.stop();
});

const SECRET_A = "segreto-della-cella-a-0123456789";
const SECRET_B = "segreto-della-cella-b-0123456789";
const KEY = "0123456789abcdef0123456789abcdef";

/** What the control plane's provider was asked, and a command that can be held open. */
class Recorder implements ComputerProvider {
	readonly calls: string[] = [];
	readonly files = new Map<string, Uint8Array>();
	hold: Promise<void> | undefined;
	aborted = false;
	async run(key: string, command: string, options: { readonly timeoutS: number; readonly signal?: AbortSignal }): Promise<ComputerRun> {
		this.calls.push(`run ${key} ${command}`);
		let cut = () => {};
		const stopped = new Promise<"cut">((resolve) => (cut = () => resolve("cut")));
		options.signal?.addEventListener("abort", () => {
			this.aborted = true;
			cut();
		});
		if (command === "rifiuta") throw new ComputerError("il disco del computer è pieno");
		if (command === "rompi") throw new Error("fly POST /v1/apps: HTTP 500 dettagli interni");
		// Like the real computers: a cancelled command ends, and what it wrote so far comes back.
		if ((await Promise.race([this.hold, stopped])) === "cut") return { exitCode: null, stdout: "a metà", stderr: "", timedOut: true, killed: false, truncated: false, ms: 1, diskFull: false };
		return { exitCode: 0, stdout: `ok ${options.timeoutS}`, stderr: "", timedOut: false, killed: false, truncated: false, ms: 1, diskFull: false };
	}
	async put(key: string, files: readonly { readonly path: string; readonly data: Uint8Array }[]): Promise<void> {
		for (const f of files) this.files.set(`${key}/${f.path}`, f.data);
	}
	async get(key: string, path: string): Promise<Uint8Array> {
		const data = this.files.get(`${key}/${path}`);
		if (data === undefined) throw new ComputerError(`nel computer non c'è /work/${path}`);
		return data;
	}
	async reset(key: string): Promise<void> {
		this.calls.push(`reset ${key}`);
	}
	async screen(key: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<ComputerScreen> {
		this.calls.push(`screen ${key} ${tool} ${JSON.stringify(args)}`);
		if (tool === "rifiuta") throw new ComputerError("lo schermo non ha risposto in tempo");
		if (tool === "aspetta") await this.hold;
		return { text: `ok ${tool}`, image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), structured: { capture_id: "c" } };
	}
	async check(): Promise<string | undefined> {
		return undefined;
	}
	async close(): Promise<void> {}
}

const idle: CellProvider = {
	create: async () => {},
	start: async () => {},
	stop: async () => {},
	destroy: async () => {},
	status: async () => "stopped",
	list: async () => [],
	baseUrl: async () => "http://127.0.0.1:1",
};

async function controlPlane(computer: ComputerProvider, state: Record<string, unknown> = {}, billing?: StripeBilling, dataDir = tempDataDir()) {
	const now = new Date().toISOString();
	writeFileSync(
		join(dataDir, "control-plane.json"),
		JSON.stringify({
			accounts: [
				{ email: "a@x.example", tenant: "aaaa", createdAt: now },
				{ email: "b@x.example", tenant: "bbbb", createdAt: now },
			],
			cells: [
				{ tenant: "aaaa", secret: SECRET_A, nextWakeAt: null },
				{ tenant: "bbbb", secret: SECRET_B, nextWakeAt: null },
			],
			links: [],
			...state,
		}),
	);
	const cp = await startControlPlane({ dataDir, domain: "owni.test", publicScheme: "http", provider: idle, mailer: new MemoryMailer(), cellEnv: {}, idleMs: 60_000, web: { host: "127.0.0.1", port: 0 }, tickMs: 0, computer, ...(billing === undefined ? {} : { billing }), log: () => {} });
	running.push(cp);
	return `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
}

describe("computers through the control plane", () => {
	it("runs a cell's command under a key of its own tenant, so no cell reaches another's computer", async () => {
		const recorder = new Recorder();
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		const b = new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B });
		expect((await a.run(KEY, "echo ciao", { timeoutS: 30 })).stdout).toBe("ok 30");
		await b.run(KEY, "echo ciao", { timeoutS: 30 });
		// The same key from two tenants: two computers.
		expect(recorder.calls).toEqual([`run ${computerKey("aaaa", KEY)} echo ciao`, `run ${computerKey("bbbb", KEY)} echo ciao`]);
		await a.put(KEY, [{ path: "dati/x.csv", data: Buffer.from("1,2") }]);
		expect(Buffer.from(await a.get(KEY, "dati/x.csv", 100)).toString()).toBe("1,2");
		await expect(b.get(KEY, "dati/x.csv", 100)).rejects.toThrow("non c'è");
		await a.reset(KEY);
		expect(recorder.calls.at(-1)).toBe(`reset ${computerKey("aaaa", KEY)}`);
		expect(await a.check()).toBeUndefined();
	});

	it("the screen of a cell's agente is in its tenant's computer: the picture comes back whole, a refusal stays a refusal, bad input is refused", async () => {
		const recorder = new Recorder();
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		expect(await a.screen(KEY, "get_desktop_state", { max_image_dimension: 1280 })).toEqual({ text: "ok get_desktop_state", image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), structured: { capture_id: "c" } });
		expect(recorder.calls).toEqual([`screen ${computerKey("aaaa", KEY)} get_desktop_state {"max_image_dimension":1280}`]);
		await expect(a.screen(KEY, "rifiuta", {})).rejects.toThrow(ComputerError);
		await expect(a.screen(KEY, "Rm -rf", {})).rejects.toThrow("HTTP 400");
		await expect(a.screen("non-una-chiave", "click", {})).rejects.toThrow("HTTP 400");
		await expect(new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_B }).screen(KEY, "click", {})).rejects.toThrow("HTTP 404");
	});

	it("holds at most two screen actions at once for a tenant; another tenant is not held up, and a place frees when an action ends", async () => {
		const recorder = new Recorder();
		let release = () => {};
		recorder.hold = new Promise((resolve) => (release = resolve));
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		const held = [a.screen(KEY, "aspetta", {}), a.screen(KEY, "aspetta", {})];
		await expect.poll(() => recorder.calls.length).toBe(2);
		await expect(a.screen(KEY, "click", {})).rejects.toThrow("altre azioni");
		expect(await new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B }).screen(KEY, "click", {})).toMatchObject({ text: "ok click" });
		release();
		await Promise.all(held);
		expect(await a.screen(KEY, "click", {})).toMatchObject({ text: "ok click" });
	});

	it("answers no one without the cell's token, and never with the cell's secret itself", async () => {
		const url = await controlPlane(new Recorder());
		await expect(new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_B }).run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("HTTP 404");
		await expect(new RemoteComputerProvider({ url, tenant: "zzzz", cellSecret: SECRET_A }).run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("HTTP 404");
		const raw = await fetch(`${url}/internal/computer/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET_A}`, "x-owni-tenant": "aaaa" }, body: JSON.stringify({ key: KEY, command: "x", timeoutS: 5 }) });
		expect(raw.status).toBe(404);
		// Through a tenant's own host the cell's internal paths stay closed.
		const viaTenant = await fetch(`${url}/internal/computer/check`, { headers: { host: "aaaa.owni.test" } });
		expect(viaTenant.status).toBe(404);
	});

	it("says what the person can act on, hides the rest, and checks keys, paths and sizes", async () => {
		const url = await controlPlane(new Recorder());
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		await expect(a.run(KEY, "rifiuta", { timeoutS: 5 })).rejects.toThrow(ComputerError);
		await expect(a.run(KEY, "rompi", { timeoutS: 5 })).rejects.toThrow(/HTTP 502 il computer non risponde$/);
		await expect(a.run("non-una-chiave", "x", { timeoutS: 5 })).rejects.toThrow("HTTP 400");
		await expect(a.put(KEY, [{ path: "../fuori", data: Buffer.from("x") }])).rejects.toThrow("percorso non valido");
		await expect(a.get(KEY, "x", 999 * 1024 * 1024)).rejects.toThrow("HTTP 400");
	});

	it("ends the command when the cell lets go, and lets a tenant run two at a time", async () => {
		const recorder = new Recorder();
		let release = () => {};
		recorder.hold = new Promise((resolve) => (release = resolve));
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		const cancel = new AbortController();
		const first = a.run(KEY, "uno", { timeoutS: 60, signal: cancel.signal });
		const second = a.run(KEY, "due", { timeoutS: 60 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect(a.run(KEY, "tre", { timeoutS: 60 })).rejects.toThrow("altri comandi in corso");
		// Another tenant is not held up.
		const b = new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B });
		const other = b.run(KEY, "suo", { timeoutS: 60 });
		cancel.abort();
		expect(await first).toMatchObject({ exitCode: null, stdout: "a metà", timedOut: true });
		expect(recorder.aborted).toBe(true);
		release();
		expect((await second).exitCode).toBe(0);
		expect((await other).exitCode).toBe(0);
	});

	it("gives a tenant at most 10 computers, and a reset one frees its place", async () => {
		const recorder = new Recorder();
		const url = await controlPlane(recorder);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		const keys = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(32, "0"));
		for (const key of keys.slice(0, 10)) await a.run(key, "x", { timeoutS: 5 });
		await expect(a.run(keys[10] as string, "x", { timeoutS: 5 })).rejects.toThrow("già 10 computer");
		// Another tenant has places of its own.
		await new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B }).run(keys[10] as string, "x", { timeoutS: 5 });
		await a.reset(keys[0] as string);
		expect((await a.run(keys[10] as string, "x", { timeoutS: 5 })).exitCode).toBe(0);
	});

	it("lists the computers of each tenant, and deletes a leaving tenant's", async () => {
		const recorder = new Recorder();
		const dataDir = tempDataDir();
		const url = await controlPlane(recorder, {}, undefined, dataDir);
		await new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A }).run(KEY, "x", { timeoutS: 5 });
		await new RemoteComputerProvider({ url, tenant: "bbbb", cellSecret: SECRET_B }).run(KEY, "x", { timeoutS: 5 });
		expect(cloudComputers({ dataDir }).map((c) => c.tenant)).toEqual(["aaaa", "bbbb"]);
		expect(await deleteTenantComputers({ dataDir, tenant: "aaaa", computer: recorder })).toBe(1);
		expect(recorder.calls.at(-1)).toBe(`reset ${computerKey("aaaa", KEY)}`);
		expect(cloudComputers({ dataDir }).map((c) => c.tenant)).toEqual(["bbbb"]);
	});

	it("tells a cell when Owni Cloud offers no computer", async () => {
		const dataDir = tempDataDir();
		writeFileSync(join(dataDir, "control-plane.json"), JSON.stringify({ accounts: [{ email: "a@x.example", tenant: "aaaa", createdAt: new Date().toISOString() }], cells: [{ tenant: "aaaa", secret: SECRET_A, nextWakeAt: null }], links: [] }));
		const cp = await startControlPlane({ dataDir, domain: "owni.test", publicScheme: "http", provider: idle, mailer: new MemoryMailer(), cellEnv: {}, idleMs: 60_000, web: { host: "127.0.0.1", port: 0 }, tickMs: 0, log: () => {} });
		running.push(cp);
		const a = new RemoteComputerProvider({ url: `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`, tenant: "aaaa", cellSecret: SECRET_A });
		expect(await a.check()).toBe("Owni Cloud non offre il computer");
		await expect(a.run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("HTTP 404");
	});

	it("runs nothing for a tenant whose trial is over", async () => {
		const past = new Date(Date.now() - 40 * 86_400_000).toISOString();
		const recorder = new Recorder();
		const billing = new StripeBilling({ secretKey: "sk_test_owni", webhookSecret: "whsec_test_owni", price: "price_flat", trialDays: 14, apiBase: "http://127.0.0.1:1" });
		const url = await controlPlane(recorder, { billingSince: past, accounts: [{ email: "a@x.example", tenant: "aaaa", createdAt: past }] }, billing);
		const a = new RemoteComputerProvider({ url, tenant: "aaaa", cellSecret: SECRET_A });
		await expect(a.run(KEY, "x", { timeoutS: 5 })).rejects.toThrow("periodo di prova è finito");
		expect(recorder.calls).toEqual([]);
	});
});

describe("computer settings", () => {
	it("reads Docker, Fly and the cell's computers, and refuses what Fly cannot give", () => {
		expect(loadComputerConfig({ OWNI_COMPUTER: "docker" })).toMatchObject({ kind: "docker", image: "owni-computer:latest" });
		const fly = { OWNI_COMPUTER: "fly", FLY_API_TOKEN: "t", OWNI_FLY_ORG: "owni", OWNI_COMPUTER_IMAGE: "registry.fly.io/owni-computer:fly" };
		expect(loadComputerConfig(fly)).toEqual({ kind: "fly", token: "t", org: "owni", region: "fra", image: "registry.fly.io/owni-computer:fly", memoryMb: 2048, cpus: 1, diskMb: 2048 });
		expect(() => loadComputerConfig({ ...fly, OWNI_COMPUTER_IMAGE: "" })).toThrow(ConfigError);
		expect(() => loadComputerConfig({ ...fly, OWNI_COMPUTER_MEMORY_MB: "1000" })).toThrow("256");
		expect(() => loadComputerConfig({ ...fly, OWNI_COMPUTER_CPUS: "0.5" })).toThrow("whole CPUs");
		expect(() => loadComputerConfig({ OWNI_COMPUTER: "cloud", OWNI_COMPUTER_URL: "https://owni.example" })).toThrow("OWNI_CELL_SECRET");
		expect(() => loadComputerConfig({ OWNI_COMPUTER: "podman" })).toThrow("docker or fly");
		const cell = loadOwniConfig({ OWNI_MODEL_PROVIDER: "faux", OWNI_TENANT_ID: "aaaa", OWNI_CELL_SECRET: SECRET_A, OWNI_COMPUTER: "cloud", OWNI_COMPUTER_URL: "https://owni.example/" });
		expect(cell.computer).toEqual({ kind: "cloud", url: "https://owni.example" });
		expect(createComputerProvider(cell.computer as NonNullable<typeof cell.computer>, { tenant: "aaaa", dataDir: tempDataDir(), cellSecret: SECRET_A })).toBeInstanceOf(RemoteComputerProvider);
	});
});
