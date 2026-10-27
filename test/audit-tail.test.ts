import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

describe("audit retention (ADR 0129)", () => {
	const at = (iso: string) => () => new Date(iso);
	const archives = (dataDir: string) =>
		readdirSync(dirname(auditFile(dataDir, ACME)))
			.filter((name) => name.startsWith("audit-"))
			.sort();

	it("moves the live file to a monthly archive on the first append of a new month", async () => {
		const dataDir = tempDataDir();
		await new AuditLog(dataDir, ACME, at("2026-03-10T10:00:00Z")).append({ type: "march" });
		utimesSync(auditFile(dataDir, ACME), new Date("2026-03-10T10:00:00Z"), new Date("2026-03-10T10:00:00Z"));
		await new AuditLog(dataDir, ACME, at("2026-03-20T10:00:00Z")).append({ type: "march-2" });
		utimesSync(auditFile(dataDir, ACME), new Date("2026-03-20T10:00:00Z"), new Date("2026-03-20T10:00:00Z"));
		expect(archives(dataDir)).toEqual([]);
		await new AuditLog(dataDir, ACME, at("2026-04-01T00:00:01Z")).append({ type: "april" });
		expect(archives(dataDir)).toEqual(["audit-2026-03.jsonl"]);
		expect((await new AuditLog(dataDir, ACME).read()).map((r) => r.type)).toEqual(["march", "march-2", "april"]);
		expect(readFileSync(auditFile(dataDir, ACME), "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("deletes archives older than 12 months and keeps the rest", async () => {
		const dataDir = tempDataDir();
		const dir = dirname(auditFile(dataDir, ACME));
		mkdirSync(dir, { recursive: true });
		for (const month of ["2025-05", "2025-06", "2025-07"]) writeFileSync(join(dir, `audit-${month}.jsonl`), `${JSON.stringify({ ts: month, tenantId: ACME, type: month })}\n`);
		await new AuditLog(dataDir, ACME, at("2026-06-15T00:00:00Z")).append({ type: "june" });
		utimesSync(auditFile(dataDir, ACME), new Date("2026-06-15T00:00:00Z"), new Date("2026-06-15T00:00:00Z"));
		await new AuditLog(dataDir, ACME, at("2026-07-02T00:00:00Z")).append({ type: "july" });
		// Now July 2026: 2025-05 and 2025-06 are 14 and 13 months old, 2025-07 is exactly 12.
		expect(archives(dataDir)).toEqual(["audit-2025-07.jsonl", "audit-2026-06.jsonl"]);
	});

	it("adds to an archive of the same month already there, never replaces it", async () => {
		const dataDir = tempDataDir();
		const dir = dirname(auditFile(dataDir, ACME));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "audit-2026-03.jsonl"), `${JSON.stringify({ ts: "2026-03-01T00:00:00Z", tenantId: ACME, type: "archived" })}\n`);
		// A live file restored with an old mtime: its month is already archived.
		writeFileSync(auditFile(dataDir, ACME), `${JSON.stringify({ ts: "2026-03-20T00:00:00Z", tenantId: ACME, type: "restored" })}\n`);
		utimesSync(auditFile(dataDir, ACME), new Date("2026-03-20T00:00:00Z"), new Date("2026-03-20T00:00:00Z"));
		await new AuditLog(dataDir, ACME, at("2026-04-02T00:00:00Z")).append({ type: "april" });
		expect(archives(dataDir)).toEqual(["audit-2026-03.jsonl"]);
		expect((await new AuditLog(dataDir, ACME).read()).map((r) => r.type)).toEqual(["archived", "restored", "april"]);
	});

	it("reads the newest records across files and reports the size of all of them", async () => {
		const dataDir = tempDataDir();
		const dir = dirname(auditFile(dataDir, ACME));
		mkdirSync(dir, { recursive: true });
		const lines = (month: string, n: number) => `${Array.from({ length: n }, (_, i) => JSON.stringify({ ts: month, tenantId: ACME, type: month, n: i })).join("\n")}\n`;
		writeFileSync(join(dir, "audit-2026-01.jsonl"), lines("jan", 5));
		writeFileSync(join(dir, "audit-2026-02.jsonl"), lines("feb", 5));
		writeFileSync(auditFile(dataDir, ACME), lines("mar", 2));
		const log = new AuditLog(dataDir, ACME);
		expect((await log.read(2)).map((r) => r.type)).toEqual(["mar", "mar"]);
		expect((await log.read(4)).map((r) => `${r.type}${r.n}`)).toEqual(["feb3", "feb4", "mar0", "mar1"]);
		expect((await log.read(100)).length).toBe(12);
		expect((await log.read()).length).toBe(12);
		const total = ["audit-2026-01.jsonl", "audit-2026-02.jsonl", "audit.jsonl"].reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
		expect(await log.size()).toBe(total);
	});
});
