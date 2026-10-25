import { join } from "node:path";
import { mkdir, symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { egressFetch } from "../src/connectors/http.ts";
import { runSandboxed, SandboxError } from "../src/core/sandbox.ts";
import { tempDataDir } from "./helpers.ts";

const policy = async () => ({ modelProviders: [], channels: [], connectors: ["tool:meteo"] });
const fakeApi = (async (input: string | URL | Request) => Response.json({ url: String(input), temp: 18 })) as typeof fetch;

function run(code: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) {
	const dir = tempDataDir();
	return runSandboxed({
		code,
		args: { x: 21 },
		workDir: join(dir, "tools", "meteo"),
		runnerDir: join(dir, "runner"),
		fetch: egressFetch("tool:meteo", ["api.meteo.example"], policy, fakeApi),
		timeoutMs: 10_000,
		...extra,
	});
}

describe("sandbox for tools proposti", () => {
	it("runs through a directory alias while keeping access confined to its real workspace", async () => {
		const dir = tempDataDir();
		await mkdir(join(dir, "real"));
		await symlink(join(dir, "real"), join(dir, "alias"), "dir");
		const paths = { workDir: join(dir, "alias", "work"), runnerDir: join(dir, "alias", "runner") };
		expect(await run('import { writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path"; export default (_, { workDir }) => { const file = join(workDir, "result.txt"); writeFileSync(file, "done"); return readFileSync(file, "utf8"); }', paths)).toBe("done");
		await expect(run(`import { readFileSync } from "node:fs"; export default () => readFileSync(${JSON.stringify(join(dir, "real", "runner", "unrelated.txt"))}, "utf8");`, paths)).rejects.toThrow(/restricted|allow-fs-read/);
	});

	it("runs the default export with the arguments; objects come back as JSON", async () => {
		expect(await run("export default async (a) => a.x * 2")).toBe("42");
		expect(await run("export default async (a) => ({ doubled: a.x * 2 })")).toBe('{"doubled":42}');
	});

	it("reaches only the declared hosts, through the egress-guarded fetch", async () => {
		expect(await run('export default async () => (await (await fetch("https://api.meteo.example/roma")).json()).temp')).toBe("18");
		await expect(run('export default async () => (await fetch("https://evil.example/steal")).status')).rejects.toThrow(/Egress denied/);
	});

	it("cannot open sockets, spawn processes, read outside its folder or see the environment", async () => {
		process.env.OWNI_SECRET_PROBE = "leak";
		await expect(run('import net from "node:net"; export default async () => "x"')).rejects.toThrow("Module not allowed in the sandbox: node:net");
		await expect(run('export default async () => (await import("node:https")).request')).rejects.toThrow("not allowed");
		await expect(run('export default async () => process.getBuiltinModule("net").connect')).rejects.toThrow("not allowed");
		await expect(run('import { execSync } from "node:child_process"; export default async () => execSync("id")')).rejects.toThrow("not allowed");
		await expect(run('import { readFileSync } from "node:fs"; export default async () => readFileSync("/etc/hostname", "utf8")')).rejects.toThrow(/restricted|allow-fs-read/);
		expect(await run("export default async () => Object.keys(process.env).length")).toBe("0");
		expect(await run('import { writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path"; export default async (_a, { workDir }) => { writeFileSync(join(workDir, "cache.txt"), "ok"); return readFileSync(join(workDir, "cache.txt"), "utf8"); }')).toBe("ok");
	});

	it("only standard library modules load: no internal network modules, no sqlite", async () => {
		await expect(run('export default async () => (await import("_http_agent")).globalAgent.createConnection({ host: "127.0.0.1", port: 1 }) && "x"')).rejects.toThrow("not allowed");
		await expect(run('export default async () => typeof process.getBuiltinModule("_tls_wrap").connect')).rejects.toThrow("not allowed");
		await expect(run('export default async () => typeof (await import("dns/promises")).lookup')).rejects.toThrow("not allowed");
		await expect(run('export default async () => typeof (await import("node:sqlite")).DatabaseSync')).rejects.toThrow("not allowed");
		await expect(run('export default async () => typeof (await import("file:///etc/hostname"))')).rejects.toThrow();
		expect(await run('import { createHash } from "node:crypto"; import { join } from "path"; export default async () => createHash("sha256").update(join("a","b")).digest("hex").slice(0, 8)')).toBe("c14cddc0");
	});

	it("cannot signal other processes, Owni included", async () => {
		const { spawn } = await import("node:child_process");
		const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
		try {
			await expect(run(`export default async () => { process.kill(${victim.pid}, "SIGKILL"); return "killed"; }`)).rejects.toThrow("not allowed");
			await expect(run(`export default async () => { process._kill(${victim.pid}, 9); return "killed"; }`)).rejects.toThrow();
			await expect(run("export default async () => { process.kill(process.ppid, 0); return String(process.ppid); }")).rejects.toThrow();
			expect(victim.exitCode).toBeNull();
			expect(victim.signalCode).toBeNull();
		} finally {
			victim.kill();
		}
	});

	it("caps what a declared host can send back", async () => {
		const huge = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }))) as typeof fetch;
		const dir = tempDataDir();
		await expect(
			runSandboxed({
				code: 'export default async () => (await (await fetch("https://api.meteo.example/big")).arrayBuffer()).byteLength',
				args: {},
				workDir: join(dir, "tools", "meteo"),
				runnerDir: join(dir, "runner"),
				fetch: egressFetch("tool:meteo", ["api.meteo.example"], policy, huge),
				timeoutMs: 10_000,
			}),
		).rejects.toThrow("over 10485760 bytes");
	});

	it("is stopped when it runs too long", async () => {
		await expect(run("export default async () => new Promise(() => {})", { timeoutMs: 500 })).rejects.toThrow(SandboxError);
	});
});
