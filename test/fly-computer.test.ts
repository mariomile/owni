import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlyComputerProvider } from "../src/computer/fly-computer.ts";
import { fakeFly, runProcess } from "./fake-fly.ts";

/**
 * The computer on micro-VMs (ADR 0015), against a stand-in for Fly's Machines API whose execs
 * run docker/owni-run.py here: a state folder and a /work per app, the runner as it runs in the
 * machine. Run as root, the runner drops to a uid of its own (4242 here, 1000 on the machine).
 */
const root = mkdtempSync(join(tmpdir(), "fly-computer-"));
// uid 1000 reaches its /work through here, as it does on the machine.
chmodSync(root, 0o755);
const runner = join(import.meta.dirname, "..", "docker", "owni-run.py");
const asRoot = process.getuid?.() === 0;
const UID = asRoot ? 4242 : (process.getuid?.() ?? 0);
const dirs = (app: string) => ({ state: join(root, app, "state"), work: join(root, app, "work") });
const booted: string[] = [];
/** An exec answered as Fly would for one the kernel killed, by the runner's subcommand. */
const killedBySignal = new Set<string>();
const backend = {
	async boot(app: string) {
		const { state, work } = dirs(app);
		booted.push(app);
		mkdirSync(state, { recursive: true, mode: 0o700 });
		if (!existsSync(work)) {
			mkdirSync(work, { recursive: true });
			if (asRoot) {
				chmodSync(join(root, app), 0o755);
				chownSync(work, UID, UID);
			}
		}
		// What owni-fly-init leaves once Fly's API inside the machine is closed.
		writeFileSync(join(state, "ready"), "");
	},
	exec(app: string, command: readonly string[], stdin: string) {
		const { state, work } = dirs(app);
		if (command[0] !== "/usr/local/bin/owni-run") return Promise.resolve({ exit_code: 127, stdout: "", stderr: "not found" });
		if (killedBySignal.has(String(command[1]))) return Promise.resolve({ exit_code: 0, exit_signal: 9, stdout: "", stderr: "" });
		return runProcess("python3", [runner, ...command.slice(1)], stdin, { OWNI_RUN_STATE: state, OWNI_RUN_WORK: work, OWNI_RUN_UID: String(UID) });
	},
	async destroy(app: string) {
		rmSync(join(root, app), { recursive: true, force: true });
	},
};

let fly: Awaited<ReturnType<typeof fakeFly>>;
const appOf = (key: string) => computer().appOf(key);
const computer = (extra: Partial<ConstructorParameters<typeof FlyComputerProvider>[0]> = {}) =>
	new FlyComputerProvider({ token: "fly-test-token", org: "owni", region: "fra", image: "registry.fly.io/owni-computer:fly", apiUrl: fly.url, salt: "sale-di-prova-0123456789", waitSliceS: 1, chunkBytes: 10, diskMb: 1, ...extra });

beforeAll(async () => {
	fly = await fakeFly(backend);
});
afterAll(async () => {
	await fly.close();
	rmSync(root, { recursive: true, force: true });
});

describe("the computer on a Fly machine", () => {
	it("creates an app on a network of its own, a volume and a machine with no service, then runs in /work as the runner's uid", async () => {
		const c = computer();
		const run = await c.run("aaaa1111", "id -u; pwd; echo errore >&2; exit 3", { timeoutS: 10 });
		expect(run).toMatchObject({ exitCode: 3, stderr: "errore\n", timedOut: false, killed: false, truncated: false, diskFull: false });
		expect(run.stdout).toBe(`${UID}\n${realpathSync(dirs(appOf("aaaa1111")).work)}\n`);
		const app = fly.apps.get(appOf("aaaa1111"));
		expect(app).toMatchObject({ network: appOf("aaaa1111"), org: "owni" });
		expect(app?.volumes).toEqual([{ id: expect.any(String), name: "work", size_gb: 1, region: "fra", encrypted: true, attached_machine_id: app?.machines[0]?.id, state: "created" }]);
		const config = app?.machines[0]?.config as Record<string, unknown>;
		expect(config).toMatchObject({
			image: "registry.fly.io/owni-computer:fly",
			services: [],
			restart: { policy: "no" },
			mounts: [{ volume: app?.volumes[0]?.id, path: "/work" }],
			guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
			env: { OWNI_IDLE_S: "600" },
			metadata: { owni_computer: "aaaa1111" },
		});
		// A second command reuses the machine.
		expect((await c.run("aaaa1111", "echo di nuovo", { timeoutS: 10 })).stdout).toBe("di nuovo\n");
		expect(app?.machines).toHaveLength(1);
	});

	it("waits past one slice of Fly's exec, kills at its time, and ends what a command left running", async () => {
		const c = computer();
		const long = await c.run("bbbb2222", "sleep 2.5; echo fatto", { timeoutS: 30 });
		expect(long).toMatchObject({ exitCode: 0, stdout: "fatto\n" });
		expect(fly.calls.filter((call) => call.endsWith("/exec")).length).toBeGreaterThan(3);
		const slow = await c.run("bbbb2222", "sleep 30", { timeoutS: 2 });
		expect(slow).toMatchObject({ exitCode: 137, timedOut: true, killed: false });
		if (asRoot) {
			await c.run("bbbb2222", "(sleep 60 &) ; echo via", { timeoutS: 10 });
			const left = await c.run("bbbb2222", `ps -u ${UID} -o stat=,comm= | grep -v '^Z' | grep -c sleep || true`, { timeoutS: 10 });
			expect(left.stdout.trim()).toBe("0");
		}
	});

	it("stops a command when the conversation is cancelled", async () => {
		const c = computer();
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 1200);
		const started = Date.now();
		const run = await c.run("cccc3333", "sleep 30", { timeoutS: 60, signal: abort.signal });
		expect(run).toMatchObject({ exitCode: null, timedOut: true });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("keeps the start of stdout and the end of stderr", async () => {
		const run = await computer().run("dddd4444", "python3 -c \"import sys; print('a' * 100000); sys.stderr.write('b' * 100000 + 'FINE')\"", { timeoutS: 30 });
		expect(run.truncated).toBe(true);
		expect(run.stdout.length).toBe(64 * 1024);
		expect(run.stderr.endsWith("FINE")).toBe(true);
		expect(run.stderr.length).toBe(64 * 1024);
	});

	it("copies files in and out in pieces, and refuses folders, links and missing files", async () => {
		const c = computer();
		const data = Buffer.from("una riga di dati che non sta in un pezzo solo\n".repeat(3));
		await c.put("eeee5555", [
			{ path: "dati/vendite.csv", data },
			{ path: "vuoto.txt", data: new Uint8Array() },
		]);
		const run = await c.run("eeee5555", "wc -c < dati/vendite.csv; wc -c < vuoto.txt; ln -s /etc/passwd link; mkdir -p cartella", { timeoutS: 10 });
		// BSD wc pads its counts; GNU wc does not. The byte counts are the contract.
		expect(run.stdout.trim().split(/\s+/).map(Number)).toEqual([data.length, 0]);
		expect(Buffer.from(await c.get("eeee5555", "dati/vendite.csv", 1024))).toEqual(data);
		expect((await c.get("eeee5555", "vuoto.txt", 10)).length).toBe(0);
		await expect(c.get("eeee5555", "dati/vendite.csv", 20)).rejects.toThrow("più grande");
		await expect(c.get("eeee5555", "cartella", 1024)).rejects.toThrow("cartella");
		await expect(c.get("eeee5555", "link", 1024)).rejects.toThrow("collegamento");
		await expect(c.get("eeee5555", "manca.txt", 1024)).rejects.toThrow("non c'è");
		await expect(c.put("eeee5555", [{ path: "../fuori", data }])).rejects.toThrow("percorso non valido");
	});

	it("marks the disk full past its quota and refuses more files until some are deleted", async () => {
		const c = computer();
		const run = await c.run("ffff6666", "head -c 2000000 /dev/zero > grande.bin", { timeoutS: 10 });
		expect(run.diskFull).toBe(true);
		await expect(c.put("ffff6666", [{ path: "altro.txt", data: Buffer.from("x") }])).rejects.toThrow("disco del computer è pieno");
		expect((await c.run("ffff6666", "rm grande.bin", { timeoutS: 10 })).diskFull).toBe(false);
		await c.put("ffff6666", [{ path: "altro.txt", data: Buffer.from("x") }]);
	});

	it("starts a machine that stopped by itself, and keeps the files", async () => {
		const c = computer();
		await c.put("gggg7777", [{ path: "resta.txt", data: Buffer.from("ciao") }]);
		fly.stopMachine(appOf("gggg7777"));
		expect((await c.run("gggg7777", "cat resta.txt", { timeoutS: 10 })).stdout).toBe("ciao");
		expect(fly.calls).toContain(`POST /v1/apps/${appOf("gggg7777")}/machines/${fly.apps.get(appOf("gggg7777"))?.machines[0]?.id}/start`);
	});

	it("updates the machine when the image changes, on the same volume", async () => {
		await computer().put("hhhh8888", [{ path: "resta.txt", data: Buffer.from("ciao") }]);
		const before = fly.apps.get(appOf("hhhh8888"))?.machines[0];
		const c = computer({ image: "registry.fly.io/owni-computer:nuova" });
		expect((await c.run("hhhh8888", "cat resta.txt", { timeoutS: 10 })).stdout).toBe("ciao");
		const app = fly.apps.get(appOf("hhhh8888"));
		expect(app?.machines).toHaveLength(1);
		expect(app?.machines[0]?.id).toBe(before?.id);
		expect(app?.machines[0]?.config).toMatchObject({ image: "registry.fly.io/owni-computer:nuova", mounts: [{ volume: app?.volumes[0]?.id }] });
		expect(app?.volumes).toHaveLength(1);
	});

	it("reset deletes the app with its machine and volume; check tells a bad token apart", async () => {
		const c = computer();
		await c.run("iiii9999", "touch x", { timeoutS: 10 });
		await c.reset("iiii9999");
		expect(fly.apps.has(appOf("iiii9999"))).toBe(false);
		expect(await c.check()).toBeUndefined();
		expect(await computer({ token: "sbagliato" }).check()).toContain("token");
	});

	it("never runs a command on a machine whose first process has not closed Fly's API", async () => {
		const c = computer();
		await c.put("jjjj0000", [{ path: "x", data: Buffer.from("x") }]);
		rmSync(join(dirs(appOf("jjjj0000")).state, "ready"));
		await expect(c.run("jjjj0000", "echo no", { timeoutS: 10 })).rejects.toThrow("the way to private addresses inside it may be open");
	}, 20_000);

	it("uses a volume left free again, and grows the volume with the quota", async () => {
		const app = appOf("kkkk1111");
		fly.apps.set(app, { name: app, network: app, org: "owni", machines: [], volumes: [{ id: "vol_left", name: "work", size_gb: 1, region: "fra", encrypted: true, attached_machine_id: null, state: "created" }] });
		await computer().run("kkkk1111", "true", { timeoutS: 10 });
		expect(fly.apps.get(app)?.volumes).toHaveLength(1);
		expect(fly.apps.get(app)?.machines[0]?.config).toMatchObject({ mounts: [{ volume: "vol_left" }] });
		await computer({ diskMb: 3000 }).run("kkkk1111", "true", { timeoutS: 10 });
		expect(fly.apps.get(app)?.volumes[0]?.size_gb).toBe(3);
		expect(fly.calls).toContain(`PUT /v1/apps/${app}/volumes/vol_left/extend`);
	});

	it("tells an exec the kernel killed from a success", async () => {
		const c = computer();
		await c.put("llll2222", [{ path: "x", data: Buffer.from("x") }]);
		killedBySignal.add("stat");
		try {
			await expect(c.get("llll2222", "x", 100)).rejects.toThrow("failed (137)");
		} finally {
			killedBySignal.delete("stat");
		}
	});

	it("lets the machine stop once nothing has asked for a while", async () => {
		const state = dirs("idle").state;
		mkdirSync(state, { recursive: true });
		const started = Date.now();
		const out = await runProcess("python3", [runner, "idle", "1"], "", { OWNI_RUN_STATE: state, OWNI_RUN_WORK: root });
		expect(out.exit_code).toBe(0);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("never runs a command on a machine whose egress rules are not in place", async () => {
		const c = computer();
		await c.put("mmmm3333", [{ path: "x", data: Buffer.from("x") }]);
		// A real machine ("machine" in ready) with no rules: owni-run checks them before each command.
		writeFileSync(join(dirs(appOf("mmmm3333")).state, "ready"), "machine");
		await expect(c.run("mmmm3333", "echo no", { timeoutS: 10 })).rejects.toThrow("the way to private addresses inside it may be open");
	}, 20_000);

	it("the egress rules: the public internet only, the resolver it is given on port 53, the same on both providers", async () => {
		const state = dirs("rules").state;
		mkdirSync(state, { recursive: true });
		const resolv = join(state, "resolv.conf");
		// A cloud's private resolver, Fly's, a link-local one with its zone, a public one, and junk.
		writeFileSync(resolv, "# Generated\nnameserver 10.0.0.2\nnameserver fdaa::3\nnameserver fe80::1%eth0\nnameserver 8.8.8.8\nnameserver nonsense\nsearch internal\n");
		const out = await runProcess("python3", [runner, "egress", "rules"], "", { OWNI_RUN_STATE: state, OWNI_RUN_RESOLV: resolv });
		expect(out.exit_code).toBe(0);
		const rules = JSON.parse(out.stdout) as Record<string, Record<string, string[]>>;
		const deny = (net: string) => `-A OUTPUT -d ${net} -j OWNI-DENY`;
		const dns = (ip: string) => [`-A OUTPUT -d ${ip} -p udp -m udp --dport 53 -j ACCEPT`, `-A OUTPUT -d ${ip} -p tcp -m tcp --dport 53 -j ACCEPT`];
		expect(rules.iptables?.OUTPUT).toEqual([
			"-P OUTPUT ACCEPT",
			"-A OUTPUT -o lo -j ACCEPT",
			// The private resolver on port 53 only; the public one needs no rule.
			...dns("10.0.0.2/32"),
			...[
				"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "168.63.129.16/32", "169.254.0.0/16", "172.16.0.0/12",
				"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
				"224.0.0.0/4", "240.0.0.0/4",
			].map(deny),
		]);
		// Neighbor Discovery and its errors, to link-local and the link's multicast only.
		const ndp = ["fe80::/10", "ff02::/16"].flatMap((net) => [1, 2, 3, 4, 133, 134, 135, 136].map((kind) => `-A OUTPUT -d ${net} -p ipv6-icmp -m icmp6 --icmpv6-type ${kind} -j ACCEPT`));
		expect(rules.ip6tables?.OUTPUT).toEqual([
			"-P OUTPUT ACCEPT",
			"-A OUTPUT -o lo -j ACCEPT",
			...dns("fdaa::3/128"),
			...dns("fe80::1/128"),
			...ndp,
			...["64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"].map(deny),
		]);
		// TCP refused at once with a reset (gVisor hangs on an ICMP reject), the rest dropped.
		for (const table of ["iptables", "ip6tables"]) expect(rules[table]?.["OWNI-DENY"]).toEqual(["-N OWNI-DENY", "-A OWNI-DENY -p tcp -j REJECT --reject-with tcp-reset", "-A OWNI-DENY -j DROP"]);
		// No resolver at all: no hole for one.
		const none = await runProcess("python3", [runner, "egress", "rules"], "", { OWNI_RUN_STATE: state, OWNI_RUN_RESOLV: join(state, "missing") });
		expect(JSON.parse(none.stdout).iptables.OUTPUT.filter((r: string) => r.includes("--dport 53"))).toEqual([]);
		// Rules never applied are never taken as in place; an unknown backend is refused.
		expect((await runProcess("python3", [runner, "egress", "check"], "", { OWNI_RUN_STATE: state })).exit_code).not.toBe(0);
		expect((await runProcess("python3", [runner, "egress", "apply", "ufw"], "", { OWNI_RUN_STATE: state })).stderr).toContain("nft|legacy");
	});

	it("refuses limits Fly cannot give", () => {
		expect(() => computer({ memoryMb: 1000 })).toThrow("256");
		expect(() => computer({ cpus: 0.5 })).toThrow("CPU");
		expect(() => computer({ region: "Frankfurt" })).toThrow("region");
	});
});
