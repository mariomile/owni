import { afterAll, describe, expect, it } from "vitest";
import { DockerComputerProvider } from "../src/computer/docker-computer.ts";

/**
 * The computer on a real Docker daemon, with the real image (CI's Image workflow builds it):
 * OWNI_TEST_COMPUTER_IMAGE=owni-computer:ci pnpm vitest run test/computer-docker.live.test.ts
 */
const image = process.env.OWNI_TEST_COMPUTER_IMAGE;
const key = `live-${process.pid}`;

describe.skipIf(image === undefined)("the computer on a real Docker host", () => {
	const computer = new DockerComputerProvider({ image: image as string, ...(process.env.OWNI_TEST_COMPUTER_RUNTIME ? { runtime: process.env.OWNI_TEST_COMPUTER_RUNTIME } : {}) });
	afterAll(() => computer.reset(key));

	it("runs as uid 1000 in /work, reaches the internet, with no secrets and a read-only system", async () => {
		const who = await computer.run(key, "id -u; pwd", { timeoutS: 30 });
		expect(who).toMatchObject({ exitCode: 0, stdout: "1000\n/work\n" });
		const net = await computer.run(key, "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), 5); print('fuori')\"", { timeoutS: 30 });
		expect(net).toMatchObject({ exitCode: 0, stdout: "fuori\n" });
		// pip installs for uid 1000, into /work/.local, where the package stays.
		const pip = await computer.run(key, "pip install -q --no-deps six && python3 -c 'import six; print(six.__file__)'", { timeoutS: 120 });
		expect(pip.exitCode).toBe(0);
		expect(pip.stdout).toMatch(/^\/work\/\.local\//);
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
});
