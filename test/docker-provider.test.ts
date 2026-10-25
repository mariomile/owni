import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlane } from "../src/cloud/control-plane.ts";
import { DockerCellProvider } from "../src/cloud/docker-provider.ts";
import { MemoryMailer } from "../src/cloud/mailer.ts";
import { tempDataDir } from "./helpers.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A fake Docker Engine API on a unix socket: records every call, keeps containers in memory. */
async function fakeDocker(options: { healthy?: boolean } = {}) {
	const calls: { method: string; path: string; body: any }[] = [];
	const containers = new Map<string, { running: boolean; labels: Record<string, string>; env: string[] }>();
	const networks = new Set<string>();
	const socketPath = join(mkdtempSync(join(tmpdir(), "docker-")), "docker.sock");
	const server = createServer((req, res) => {
		let text = "";
		req.on("data", (c) => (text += c));
		req.on("end", () => {
			const path = (req.url ?? "").replace(/^\/v1\.43/, "");
			const body = text === "" ? undefined : JSON.parse(text);
			calls.push({ method: req.method ?? "", path, body });
			const send = (status: number, value?: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(value === undefined ? "" : JSON.stringify(value));
			};
			const name = /\/containers\/([^/?]+)/.exec(path)?.[1] ?? "";
			if (path.startsWith("/networks/create")) return (networks.add(body.Name), send(201, { Id: "n" }));
			if (path.startsWith("/networks/")) return networks.has(path.slice("/networks/".length)) ? send(200, { Name: "n" }) : send(404, { message: "no network" });
			if (path.startsWith("/containers/create")) {
				// The daemon adds the image's own environment to the container's.
				containers.set(new URL(path, "http://x").searchParams.get("name") ?? "", { running: false, labels: body.Labels, env: ["PATH=/usr/local/bin", ...body.Env] });
				return send(201, { Id: "c" });
			}
			if (path.startsWith("/images/")) return send(200, { Config: { Env: ["PATH=/usr/local/bin"] } });
			if (path.startsWith("/containers/json")) return send(200, [...containers.values()].map((c) => ({ Labels: c.labels })));
			const c = containers.get(name);
			if (path.endsWith("/json")) return c === undefined ? send(404, { message: "No such container" }) : send(200, { Image: "sha256:old", Config: { Env: c.env }, State: { Running: c.running, ExitCode: 0 }, NetworkSettings: { Ports: { "8080/tcp": c.running ? [{ HostIp: "127.0.0.1", HostPort: String(cellPort) }] : null } } });
			if (path.endsWith("/start") && c) return (c.running = true), send(204);
			if (path.includes("/stop") && c) return (c.running = false), send(204);
			if (req.method === "DELETE") return containers.delete(name), send(204);
			send(404, { message: "not found" });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
	// The "cell" answers /healthz.
	const cell = createServer((_req, res) => {
		res.statusCode = options.healthy === false ? 503 : 200;
		res.end('{"ok":true}');
	});
	await new Promise<void>((resolve) => cell.listen(0, "127.0.0.1", () => resolve()));
	const cellPort = (cell.address() as AddressInfo).port;
	closers.push(() => new Promise((r) => server.close(() => r())), () => new Promise((r) => cell.close(() => r())));
	return { socketPath, calls, containers };
}

describe("Docker cell provider", () => {
	it("a cell that never becomes healthy is stopped, and the tenant is not left stuck", async () => {
		const docker = await fakeDocker({ healthy: false });
		const provider = new DockerCellProvider({ image: "owni:local", socketPath: docker.socketPath, startTimeoutMs: 500 });
		await provider.create("b1", {});
		await expect(provider.start("b1")).rejects.toThrow(/did not answer in time/);
		expect(await provider.status("b1")).toBe("stopped");
		// start and stop answer again.
		await provider.stop("b1");
		await expect(provider.start("b1")).rejects.toThrow(/did not answer in time/);
	});

	it("creates each cell locked down, on a network where cells cannot reach each other, reachable only from this host", async () => {
		const docker = await fakeDocker();
		const provider = new DockerCellProvider({ image: "owni:local", socketPath: docker.socketPath });
		await provider.create("a1", { OWNI_TENANT_ID: "a1", OWNI_CELL_SECRET: "s".repeat(32) });
		const create = docker.calls.find((c) => c.path.startsWith("/containers/create"))?.body;
		expect(create.Env).toEqual(expect.arrayContaining(["OWNI_TENANT_ID=a1", "OWNI_DATA_DIR=/data", "OWNI_WEB_HOST=0.0.0.0"]));
		expect(create.HostConfig).toMatchObject({
			Binds: ["owni-cell-a1:/data"],
			NetworkMode: "owni-cells",
			PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
			ReadonlyRootfs: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges:true"],
			PidsLimit: 256,
		});
		expect(create.HostConfig.Memory).toBe(512 * 1024 * 1024);
		expect(create.User).toBe("1000:1000");
		expect(docker.calls.find((c) => c.path.startsWith("/networks/create"))?.body).toMatchObject({ Name: "owni-cells", Driver: "bridge", Options: { "com.docker.network.bridge.enable_icc": "false" } });
		// A second cell reuses the network.
		await provider.create("a2", {});
		expect(docker.calls.filter((c) => c.path.startsWith("/networks/create"))).toHaveLength(1);
		await provider.destroy("a2");
		expect(await provider.status("a1")).toBe("stopped");
		await provider.start("a1");
		expect(await provider.status("a1")).toBe("running");
		expect(await provider.baseUrl("a1")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await provider.list()).toEqual(["a1"]);
		// Upgrade: a new container with the cell's own environment changed, the volume kept, running again.
		await provider.upgrade("a1", { OWNI_MODEL_ID: "nuovo" });
		const recreated = docker.calls.filter((c) => c.path.startsWith("/containers/create")).at(-1)?.body;
		expect(recreated.Env).toEqual(expect.arrayContaining(["OWNI_TENANT_ID=a1", `OWNI_CELL_SECRET=${"s".repeat(32)}`, "OWNI_MODEL_ID=nuovo"]));
		expect(recreated.Env).not.toContain("PATH=/usr/local/bin");
		expect(recreated.HostConfig.Binds).toEqual(["owni-cell-a1:/data"]);
		expect(docker.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/volumes/owni-cell-a1"))).toBe(false);
		expect(await provider.status("a1")).toBe("running");
		await provider.stop("a1");
		expect(await provider.status("a1")).toBe("stopped");
		await provider.destroy("a1");
		expect(await provider.status("a1")).toBe("missing");
		expect(docker.calls.filter((c) => c.method === "DELETE" && c.path.includes("a1")).map((c) => c.path.split("?")[0])).toEqual(["/containers/owni-cell-a1", "/containers/owni-cell-a1", "/volumes/owni-cell-a1"]);
		await expect(provider.create("../x", {})).rejects.toThrow(/Invalid cell id/);
		expect(() => new DockerCellProvider({ image: "x", memoryMb: Number.NaN })).toThrow(/128 MB/);
	});
});

// With a Docker daemon and the Owni image: OWNI_TEST_DOCKER_IMAGE=owni:local pnpm vitest run test/docker-provider.test.ts
const image = process.env.OWNI_TEST_DOCKER_IMAGE;
describe.skipIf(image === undefined)("Docker cell provider, real daemon", () => {
	it("sign up through the control plane into a container cell, sleep, wake with the data still there", async () => {
		const dataDir = tempDataDir();
		const provider = new DockerCellProvider({ image: image as string });
		const mailer = new MemoryMailer();
		const cp = await startControlPlane({ dataDir, domain: "owni.test", publicScheme: "http", provider, mailer, cellEnv: { OWNI_MODEL_PROVIDER: "faux" }, idleMs: 0, web: { host: "127.0.0.1", port: 0 }, tickMs: 0, log: () => {} });
		closers.push(async () => {
			await cp.stop();
			for (const id of await provider.list()) await provider.destroy(id);
		});
		const port = (cp.server.address() as AddressInfo).port;
		const call = (host: string, path: string, body?: unknown, cookie?: string) =>
			new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
				const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { host, "x-owni": "1", ...(cookie ? { cookie } : {}) } }, (res) => {
					let text = "";
					res.on("data", (c) => (text += c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text.startsWith("{") ? JSON.parse(text) : text, cookie: String(res.headers["set-cookie"] ?? "").split(";")[0] as string }));
				});
				req.on("error", reject);
				req.end(body === undefined ? undefined : JSON.stringify(body));
			});
		expect((await call("owni.test", "/api/signup", { email: "anna@example.com" })).status).toBe(200);
		const token = /#([\w-]+)/.exec(mailer.sent[0]?.text ?? "")?.[1];
		const started = Date.now();
		const verified = await call("owni.test", "/api/verify", { token });
		expect(verified.status).toBe(200);
		const url = new URL(verified.body.loginUrl);
		const login = await call(url.host, "/api/login", { token: url.hash.slice(1) });
		expect(login.status).toBe(200);
		const thread = (await call(url.host, "/api/instances/owni/threads", {}, login.cookie)).body.thread;
		await call(url.host, `/api/instances/owni/threads/${thread.id}/messages`, { text: "ciao dal container" }, login.cookie);
		const answered = async () => ((await call(url.host, `/api/instances/owni/threads/${thread.id}`, undefined, login.cookie)).body.entries as { from: string }[]).some((e) => e.from === "owni");
		while (!(await answered())) await new Promise((r) => setTimeout(r, 100));
		console.log(`docker cell: sign-up to first answer in ${((Date.now() - started) / 1000).toFixed(1)} s`);
		// Idle: stopped. The next request with a session wakes it, and the conversation is still there.
		const tenant = url.host.split(".")[0] as string;
		await cp.tick(new Date());
		expect(await provider.status(tenant)).toBe("stopped");
		const woke = Date.now();
		const again = await call(url.host, `/api/instances/owni/threads/${thread.id}`, undefined, login.cookie);
		console.log(`docker cell: wake in ${((Date.now() - woke) / 1000).toFixed(1)} s`);
		expect(again.body.entries.some((e: { text?: string }) => e.text === "ciao dal container")).toBe(true);
		// What a cell costs: memory while it runs, disk while it sleeps.
		const docker = (path: string) =>
			new Promise<any>((resolve, reject) => {
				const req = request({ socketPath: "/var/run/docker.sock", path: `/v1.43${path}` }, (res) => {
					let text = "";
					res.on("data", (c) => (text += c));
					res.on("end", () => resolve(JSON.parse(text)));
				});
				req.on("error", reject);
				req.end();
			});
		const stats = await docker(`/containers/owni-cell-${tenant}/stats?stream=false`);
		console.log(`docker cell: ${Math.round((stats.memory_stats?.usage ?? 0) / 1024 / 1024)} MB of memory while running`);
		// An upgrade keeps the conversation.
		await provider.upgrade(tenant, { OWNI_TIME_ZONE: "Europe/Berlin" });
		const after = await call(url.host, `/api/instances/owni/threads/${thread.id}`, undefined, login.cookie);
		expect(after.body.entries.some((e: { text?: string }) => e.text === "ciao dal container")).toBe(true);
		await provider.stop(tenant);
		const df = await docker("/system/df");
		const volume = (df.Volumes as { Name: string; UsageData?: { Size?: number } }[]).find((v) => v.Name === `owni-cell-${tenant}`);
		console.log(`docker cell: ${((volume?.UsageData?.Size ?? 0) / 1024 / 1024).toFixed(1)} MB on disk while asleep`);
	}, 180_000);
});
