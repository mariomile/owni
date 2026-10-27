import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit.ts";
import { auditFile } from "../src/core/paths.ts";
import { tenantId } from "../src/core/ids.ts";
import { tempDataDir } from "./helpers.ts";

const ACME = tenantId("acme");

describe("audit log tail", () => {
	it("reads only the newest records of a large log, in order, and matches a full read", async () => {
		const dataDir = tempDataDir();
		const file = auditFile(dataDir, ACME);
		mkdirSync(dirname(file), { recursive: true });
		const lines: string[] = [];
		for (let i = 0; i < 20_000; i++) lines.push(JSON.stringify({ ts: "t", tenantId: ACME, type: "x", n: i, note: "caffè ✓".repeat(3) }));
		writeFileSync(file, `${lines.join("\n")}\n`);
		const log = new AuditLog(dataDir, ACME);
		const tail = await log.read(150);
		expect(tail.map((r) => r.n)).toEqual(Array.from({ length: 150 }, (_, i) => 19_850 + i));
		expect((await log.read(100_000)).length).toBe(20_000);
		expect((await log.read()).slice(-150)).toEqual(tail);
	});

	it("handles a missing log, a tiny log, a zero limit and a file without final newline", async () => {
		const dataDir = tempDataDir();
		const log = new AuditLog(dataDir, ACME);
		expect(await log.read(5)).toEqual([]);
		await log.append({ type: "a" });
		await log.append({ type: "b" });
		expect((await log.read(1)).map((r) => r.type)).toEqual(["b"]);
		expect((await log.read(5)).map((r) => r.type)).toEqual(["a", "b"]);
		expect(await log.read(0)).toEqual([]);
		writeFileSync(auditFile(dataDir, ACME), JSON.stringify({ ts: "t", tenantId: ACME, type: "c" }));
		expect((await log.read(3)).map((r) => r.type)).toEqual(["c"]);
	});
});
