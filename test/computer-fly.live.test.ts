import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlyComputerProvider } from "../src/computer/fly-computer.ts";
import { type Backend, fakeFly, runProcess } from "./fake-fly.ts";

/**
 * The computer of a micro-VM with the real image (ADR 0015).
 *
 * In CI (OWNI_TEST_FLY_IMAGE, the `fly` target built by the Image workflow): each machine is a
 * container of that image on Docker's default network, which reaches the internet as a Fly
 * machine does (ADR 0124), with a /.fly folder for owni-fly-init to close. Fly's API is the
 * stand-in of fake-fly.ts.
 *
 * Against Fly itself (FLY_API_TOKEN, OWNI_TEST_FLY_ORG and OWNI_TEST_FLY_IMAGE pushed to a
 * registry Fly can pull from): the same checks on a real machine, then the app is deleted.
 */
const image = process.env.OWNI_TEST_FLY_IMAGE;
const realFly = process.env.FLY_API_TOKEN !== undefined && process.env.OWNI_TEST_FLY_ORG !== undefined;
const key = `live${process.pid}`;

function checks(computer: () => FlyComputerProvider) {
	it("runs as uid 1000 in /work, reaches the internet, and not Fly's API, the host or raw packets", async () => {
		const who = await computer().run(key, "id -u; pwd", { timeoutS: 60 });
		expect(who).toMatchObject({ exitCode: 0, stdout: "1000\n/work\n" });
		const net = await computer().run(key, "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), 5); print('fuori')\"", { timeoutS: 30 });
		expect(net).toMatchObject({ exitCode: 0, stdout: "fuori\n" });
		// pip installs for uid 1000, into /work/.local, where the package stays.
		const pip = await computer().run(key, "pip install -q --no-deps six && python3 -c 'import six; print(six.__file__)'", { timeoutS: 120 });
		expect(pip.exitCode).toBe(0);
		expect(pip.stdout).toMatch(/^\/work\/\.local\//);
		// Fly's API inside the machine answers without a token: uid 1000 cannot reach its socket.
		expect((await computer().run(key, "ls /.fly", { timeoutS: 30 })).exitCode).not.toBe(0);
		// vsock talks to the host, packet sockets forge and sniff: both refused.
		for (const family of ["AF_PACKET, socket.SOCK_RAW", "AF_VSOCK, socket.SOCK_STREAM"]) {
			const side = await computer().run(key, `python3 -c "import socket; socket.socket(socket.${family})"`, { timeoutS: 30 });
			expect(side.stderr).toContain("Errno 97");
		}
		// What the commands below rely on is in the image.
		expect((await computer().run(key, "command -v ps", { timeoutS: 30 })).exitCode).toBe(0);
	}, 240_000);

	it("files in, a pandas script, a chart out; a long command; background processes end", async () => {
		await computer().put(key, [{ path: "dati/vendite.csv", data: Buffer.from("mese,euro\ngen,10\nfeb,32\n") }]);
		const script = "import pandas as pd, matplotlib.pyplot as plt; d = pd.read_csv('dati/vendite.csv'); print(d.euro.sum()); d.plot(x='mese', y='euro'); plt.savefig('grafico.png')";
		const run = await computer().run(key, `python3 -c "${script}"`, { timeoutS: 120 });
		expect(run.stderr).toBe("");
		expect(run).toMatchObject({ exitCode: 0, stdout: "42\n" });
		const png = await computer().get(key, "grafico.png", 5 * 1024 * 1024);
		expect(Buffer.from(png.subarray(1, 4)).toString()).toBe("PNG");
		expect((await computer().run(key, "sleep 70; echo fine", { timeoutS: 120 })).stdout).toBe("fine\n");
		expect((await computer().run(key, "sleep 30", { timeoutS: 2 })).timedOut).toBe(true);
		await computer().run(key, "(sleep 600 &); echo via", { timeoutS: 30 });
		expect((await computer().run(key, "ps -u 1000 -o stat=,comm= | grep -v '^Z' | grep -c sleep || true", { timeoutS: 30 })).stdout.trim()).toBe("0");
	}, 600_000);
}

const docker = (args: string[], stdin = "") => runProcess("docker", args, stdin);

/** Machines as containers of the image; `caps` false leaves out what the first process needs to make it ready. */
function containers(caps = true): Backend {
	const name = (app: string) => `owni-fly-${app}`;
	return {
		async boot(app, config) {
			const env = (config.env ?? {}) as Record<string, string>;
			await docker(["rm", "-f", name(app)]);
			// What Fly's root in a VM has: SYS_ADMIN (and no AppArmor profile) for its mounts.
			const privileges = caps ? ["--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined"] : [];
			// Fly's API folder, open to all as on a machine before owni-fly-init closes it.
			const fly = ["--mount", "type=tmpfs,destination=/.fly,tmpfs-mode=0755"];
			const out = await docker(["run", "-d", "--name", name(app), ...privileges, ...fly, "-v", `${name(app)}:/work`, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), String(config.image)]);
			if (out.exit_code !== 0) throw new Error(out.stderr);
		},
		exec: (app, command, stdin) => docker(["exec", "-i", name(app), ...command], stdin),
		async destroy(app) {
			await docker(["rm", "-f", name(app)]);
			await docker(["volume", "rm", name(app)]);
		},
	};
}

describe.skipIf(image === undefined || realFly)("the computer of a micro-VM, as a container of the real image", () => {
	let fly: Awaited<ReturnType<typeof fakeFly>>;
	let provider: FlyComputerProvider;
	beforeAll(async () => {
		fly = await fakeFly(containers());
		provider = new FlyComputerProvider({ token: "fly-test-token", org: "owni", region: "fra", image: image as string, apiUrl: fly.url, salt: "sale-di-prova-0123456789" });
	});
	afterAll(async () => {
		await provider.reset(key);
		await fly.close();
	});

	it("leaves Fly's API folder open to all before owni-fly-init, so the check below means something", async () => {
		const out = await docker(["run", "--rm", "--user", "1000", "--mount", "type=tmpfs,destination=/.fly,tmpfs-mode=0755", "--entrypoint", "ls", image as string, "-ld", "/.fly"]);
		expect(out.stdout).toMatch(/^drwxr-xr-x/);
	}, 120_000);

	checks(() => provider);

	it("runs nothing on a machine whose first process could not finish", async () => {
		const unready = await fakeFly(containers(false));
		const c = new FlyComputerProvider({ token: "fly-test-token", org: "owni", region: "fra", image: image as string, apiUrl: unready.url, salt: "sale-di-prova-0123456789" });
		try {
			await expect(c.run(`${key}x`, "echo fuori", { timeoutS: 30 })).rejects.toThrow(/start failed|not ready/);
		} finally {
			await c.reset(`${key}x`);
			await unready.close();
		}
	}, 120_000);
});

describe.skipIf(image === undefined || !realFly)("the computer on a real Fly machine", () => {
	const provider = new FlyComputerProvider({ token: process.env.FLY_API_TOKEN as string, org: process.env.OWNI_TEST_FLY_ORG as string, region: process.env.OWNI_TEST_FLY_REGION ?? "fra", image: image as string, memoryMb: 1024, salt: `live-${process.pid}-0123456789abcdef` });
	afterAll(() => provider.reset(key));
	checks(() => provider);
});
