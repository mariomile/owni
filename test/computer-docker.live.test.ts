import { afterAll, describe, expect, it } from "vitest";
import { DockerComputerProvider } from "../src/computer/docker-computer.ts";

/**
 * The computer on a real Docker daemon, with the real image (CI's Image workflow builds it):
 * OWNI_TEST_COMPUTER_IMAGE=owni-computer:ci pnpm vitest run test/computer-docker.live.test.ts
 */
const image = process.env.OWNI_TEST_COMPUTER_IMAGE;
const key = `live-${process.pid}`;
/** Each address with the errno of a connection to it: 111, refused by the egress rules (a reset, at once). */
const PRIVATE = `python3 -c "
import socket
for h in ['169.254.169.254', '10.0.0.1', '172.17.0.1', '192.168.0.1']:
    try:
        socket.create_connection((h, 80), 5); print(h, 'open')
    except OSError as e:
        print(h, e.errno)
"`;

/** io_uring, a user namespace, clone3: each with the errno it gets, or "open" (Docker's seccomp profile refuses all three). */
const KERNEL = `python3 -c "
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
for name, r in [('io_uring', lambda: libc.syscall(425, 1, ctypes.create_string_buffer(120))), ('userns', lambda: libc.unshare(0x10000000)), ('clone3', lambda: libc.syscall(435, None, 0))]:
    print(name, ctypes.get_errno() if r() < 0 else 'open')
"`;

describe.skipIf(image === undefined)("the computer on a real Docker host", () => {
	const computer = new DockerComputerProvider({ image: image as string, ...(process.env.OWNI_DOCKER_SOCKET ? { socketPath: process.env.OWNI_DOCKER_SOCKET } : {}), ...(process.env.OWNI_TEST_COMPUTER_RUNTIME ? { runtime: process.env.OWNI_TEST_COMPUTER_RUNTIME } : {}) });
	afterAll(() => computer.reset(key));

	it("runs as uid 1000 in /work, reaches the public internet and nothing private, with no capabilities, no secrets and a read-only system", async () => {
		const who = await computer.run(key, "id -u; pwd", { timeoutS: 30 });
		expect(who).toMatchObject({ exitCode: 0, stdout: "1000\n/work\n" });
		const net = await computer.run(key, "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), 5); print('fuori')\"", { timeoutS: 30 });
		expect(net).toMatchObject({ exitCode: 0, stdout: "fuori\n" });
		// pip installs for uid 1000, into /work/.local, where the package stays.
		const pip = await computer.run(key, "pip install -q --no-deps tabulate && python3 -c 'import tabulate; print(tabulate.__file__)'", { timeoutS: 120 });
		expect(pip.exitCode).toBe(0);
		expect(pip.stdout).toMatch(/^\/work\/\.local\//);
		// Not the network around it: the metadata endpoint (the host's credentials on a cloud), the
		// host and the LAN are refused at once (111) by the first process's rules.
		const inside = await computer.run(key, PRIVATE, { timeoutS: 60 });
		expect(inside.stdout).toBe("169.254.169.254 111\n10.0.0.1 111\n172.17.0.1 111\n192.168.0.1 111\n");
		// The first process's NET_ADMIN stays in the bounding set only: uid 1000 holds no capability
		// and cannot take the rules away.
		const caps = await computer.run(key, "grep -E '^Cap(Prm|Eff|Amb)' /proc/self/status | tr -s '\\t' ' '", { timeoutS: 10 });
		expect(caps.stdout).toBe("CapPrm: 0000000000000000\nCapEff: 0000000000000000\nCapAmb: 0000000000000000\n");
		expect((await computer.run(key, "/usr/sbin/iptables-nft -F OUTPUT || /usr/sbin/iptables-legacy -F OUTPUT", { timeoutS: 10 })).exitCode).not.toBe(0);
		expect((await computer.run(key, PRIVATE, { timeoutS: 60 })).stdout).toBe(inside.stdout);
		expect((await computer.run(key, KERNEL, { timeoutS: 30 })).stdout).toBe("io_uring 1\nuserns 1\nclone3 38\n");
		// Nothing of Owni's in its environment: no key, no token.
		expect((await computer.run(key, "env | cut -d= -f1 | sort | tr '\\n' ' '", { timeoutS: 10 })).stdout).not.toMatch(/OWNI|KEY|TOKEN|SECRET/);
		expect((await computer.run(key, "touch /etc/owni", { timeoutS: 10 })).exitCode).not.toBe(0);
		expect((await computer.run(key, "touch /work/ok && touch /tmp/ok", { timeoutS: 10 })).exitCode).toBe(0);
	}, 120_000);

	it("files in, a pandas script, a chart out; a command killed at its time", async () => {
		await computer.put(key, [{ path: "dati/vendite.csv", data: Buffer.from("mese,euro\ngen,10\nfeb,32\n") }]);
		const script = "import pandas as pd, matplotlib.pyplot as plt; d = pd.read_csv('dati/vendite.csv'); print(d.euro.sum()); d.plot(x='mese', y='euro'); plt.savefig('grafico.png')";
		const run = await computer.run(key, `python3 -c "${script}"`, { timeoutS: 120 });
		expect(run.stderr).toBe("");
		expect(run).toMatchObject({ exitCode: 0, stdout: "42\n" });
		const png = await computer.get(key, "grafico.png", 5 * 1024 * 1024);
		expect(Buffer.from(png.subarray(1, 4)).toString()).toBe("PNG");
		await expect(computer.get(key, "dati", 1024)).rejects.toThrow("cartella");
		const slow = await computer.run(key, "sleep 30", { timeoutS: 2 });
		expect(slow).toMatchObject({ exitCode: 137, timedOut: true });
		for (const tool of ["jq", "sqlite3", "pandoc", "pdftotext", "pdftoppm", "qpdf", "zip", "convert"]) expect((await computer.run(key, `command -v ${tool}`, { timeoutS: 10 })).exitCode).toBe(0);
		const modules = await computer.run(key, 'python3 -c "import pypdf, openpyxl, xlrd, weasyprint; print(1)"', { timeoutS: 120 });
		expect(modules).toMatchObject({ exitCode: 0, stdout: "1\n" });
	}, 180_000);

	it("nothing a command leaves running survives it; the computer itself does", async () => {
		const run = await computer.run(key, "(sleep 3; touch /work/tardi) >/dev/null 2>&1 & echo partito", { timeoutS: 30 });
		expect(run).toMatchObject({ exitCode: 0, stdout: "partito\n" });
		expect(run.ms).toBeLessThan(2_500);
		await new Promise((r) => setTimeout(r, 4_000));
		expect((await computer.run(key, "test -e /work/tardi", { timeoutS: 10 })).exitCode).toBe(1);
		// A file past the per-file limit cannot be written.
		expect((await computer.run(key, "ulimit -f", { timeoutS: 10 })).stdout.trim()).not.toBe("unlimited");
	}, 60_000);

	it("the screen: Chromium in the same machine; the commands cannot read its profile, see it, stop it or plant code in it; no file:// pages; its downloads reach them; a restart keeps the profile", async () => {
		const look = await computer.screen(key, "get_desktop_state", { max_image_dimension: 1280 });
		expect(Buffer.from((look.image as Uint8Array).subarray(1, 4)).toString()).toBe("PNG");
		expect(Buffer.from(look.image as Uint8Array).readUInt32BE(16)).toBe(1280);
		expect(Buffer.from(look.image as Uint8Array).readUInt32BE(20)).toBe(800);
		expect(look.structured).toEqual({ screenshot_original_width: 1280, screenshot_original_height: 800 });
		await computer.screen(key, "launch_app", { urls: ["https://example.com/"] });
		let title = "";
		for (let i = 0; i < 30 && !title.includes("Example Domain"); i++) {
			await new Promise((r) => setTimeout(r, 500));
			title = (await computer.screen(key, "get_desktop_state", { max_image_dimension: 640 })).text;
		}
		expect(title).toContain("Example Domain");
		// The profile, with the cookies, is 1001's alone; X wants a cookie that is in it.
		expect((await computer.run(key, "ls /screen", { timeoutS: 10 })).exitCode).not.toBe(0);
		const x = await computer.run(key, "for d in 0 1 2 3 4 5 6 7 8 9; do DISPLAY=:$d xdotool getmouselocation 2>/dev/null && echo visto; done; true", { timeoutS: 30 });
		expect(x.stdout).not.toContain("visto");
		// uid 1000 cannot signal 1001: this ends only the command itself.
		await computer.run(key, "pkill -9 chromium; kill -9 -1", { timeoutS: 10 });
		expect((await computer.screen(key, "get_desktop_state", { max_image_dimension: 640 })).text).toContain("Example Domain");
		// A python3 and a .pth that the commands leave in their own PATH and site-packages: they run for
		// uid 1000 alone, never for the screen (1001) or for root, whose interpreter and PATH are fixed.
		const site = (await computer.run(key, "python3 -c 'import site; print(site.getusersitepackages())'", { timeoutS: 10 })).stdout.trim();
		const plant = `mkdir -p /work/.local/bin ${site} && printf '#!/bin/sh\\ntouch /work/preso-$(id -u)\\nexec /usr/bin/python3 "$@"\\n' > /work/.local/bin/python3 && chmod +x /work/.local/bin/python3 && echo "import os; open('/work/preso-%d' % os.getuid(), 'w')" > ${site}/preso.pth`;
		expect((await computer.run(key, plant, { timeoutS: 10 })).exitCode).toBe(0);
		await computer.screen(key, "get_desktop_state", { max_image_dimension: 640 });
		await computer.put(key, [{ path: "radice.txt", data: Buffer.from("ok") }]);
		expect(Buffer.from(await computer.get(key, "radice.txt", 1024)).toString()).toBe("ok");
		expect((await computer.run(key, "python3 -c 1; ls /work | grep '^preso-' | tr '\\n' ' '", { timeoutS: 10 })).stdout).toBe("preso-1000 ");
		// Files go in and come out of /work only: not through a link to the profile.
		expect((await computer.run(key, "ln -s /screen /work/s", { timeoutS: 10 })).exitCode).toBe(0);
		await expect(computer.get(key, "s/profile/Default/Preferences", 1024 * 1024)).rejects.toThrow("collegamento");
		await expect(computer.put(key, [{ path: "s/profile/Default/Preferences", data: Buffer.from("{}") }])).rejects.toThrow("collegamento");
		// No file:// pages, typed in the address bar either: the managed policy blocks them.
		await computer.screen(key, "hotkey", { keys: ["ctrl", "l"] });
		await computer.screen(key, "type_text", { text: "file:///etc/passwd\n" });
		await new Promise((r) => setTimeout(r, 2000));
		expect((await computer.screen(key, "get_desktop_state", { max_image_dimension: 640 })).text).toBe("file:///etc/passwd - Chromium");
		// What the browser downloads, the commands read: a file served from inside the computer.
		const serving = computer.run(key, "mkdir -p /tmp/srv && head -c 1000 /dev/urandom > /tmp/srv/dati.bin && cd /tmp/srv && timeout 25 python3 -m http.server 8765 --bind 127.0.0.1", { timeoutS: 30 });
		await new Promise((r) => setTimeout(r, 1500));
		await computer.screen(key, "launch_app", { urls: ["http://127.0.0.1:8765/dati.bin"] });
		let size = "";
		for (let i = 0; i < 20 && size !== "1000"; i++) {
			await new Promise((r) => setTimeout(r, 500));
			size = (await computer.run(key, "stat -c %s /work/Downloads/dati.bin 2>/dev/null || true", { timeoutS: 10 })).stdout.trim();
		}
		expect(size).toBe("1000");
		await serving;
		// Restart: the browser and the display close, the next action opens them again.
		await computer.screen(key, "restart", {});
		// The first actions after it, at once, open one display and one browser between them.
		const again = await Promise.all([1, 2, 3].map(() => computer.screen(key, "get_desktop_state", { max_image_dimension: 1280 })));
		for (const shot of again) expect(Buffer.from((shot.image as Uint8Array).subarray(1, 4)).toString()).toBe("PNG");
		expect((await computer.run(key, "pgrep -cx Xvfb", { timeoutS: 10 })).stdout).toBe("1\n");
		await expect(computer.screen(key, "launch_app", { name: "xterm" })).rejects.toThrow("solo il browser");
	}, 180_000);
});
