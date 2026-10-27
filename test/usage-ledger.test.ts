import { mkdtempSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuditLog } from "../src/core/audit.ts";
import { UsageLedger, type UsageRecord } from "../src/core/usage.ts";

/** A fault in the next file replaced atomically, the way a full disk or a crash would leave it. */
const fault = vi.hoisted(() => ({ atomicWrite: false }));
vi.mock("../src/core/atomic-file.ts", async (actual) => {
	const real = await actual<typeof import("../src/core/atomic-file.ts")>();
	return {
		...real,
		writeFileAtomic: async (...args: Parameters<typeof real.writeFileAtomic>) => {
			if (fault.atomicWrite) throw new Error("ENOSPC: no space left on device");
			return real.writeFileAtomic(...args);
		},
	};
});

const turn = (submissionId: string, estimatedUsd = 0.5): UsageRecord => ({ at: new Date().toISOString(), provider: "p", model: "m", role: "agent", inputTokens: 10, outputTokens: 1, estimatedUsd, instanceId: "ops", threadId: "t1", submissionId });

function ledgerIn() {
	const dir = mkdtempSync(join(tmpdir(), "owni-usage-"));
	return { dir, ledger: new UsageLedger(dir, { softUsdPerDay: 5, hardUsdPerDay: 20 }) };
}

describe("the usage ledger (ADR 0098)", () => {
	it("bills a turn once: a recovery that records it again changes neither the ledger nor the day's spend", async () => {
		const { ledger } = ledgerIn();
		await ledger.record(turn("s1", 4));
		const again = await ledger.record(turn("s1", 4));
		expect(again).toEqual({ softExceeded: false, hardExceeded: false });
		expect(await ledger.records()).toHaveLength(1);
		expect(await ledger.todaySpent()).toBe(4);
		await ledger.record({ ...turn("s1", 4), instanceId: "casa" });
		expect(await ledger.todaySpent()).toBe(8);
	});

	it("sees records another ledger of the same file wrote, without reading the file again when nothing changed", async () => {
		const { dir, ledger } = ledgerIn();
		const other = new UsageLedger(dir, { softUsdPerDay: 5, hardUsdPerDay: 20 });
		await ledger.record(turn("s1"));
		await other.record(turn("s2"));
		await appendFile(join(dir, "usage.jsonl"), `${JSON.stringify(turn("s3"))}\n`);
		expect((await ledger.records()).map((r) => r.submissionId)).toEqual(["s1", "s2", "s3"]);
		// Written from outside: still billed once.
		await ledger.record(turn("s3"));
		expect(await ledger.records()).toHaveLength(3);
	});

	it("reads only whole lines, and the next record drops a line cut short", async () => {
		const { dir, ledger } = ledgerIn();
		await ledger.record(turn("s1"));
		await appendFile(join(dir, "usage.jsonl"), '{"at":"2026-10-22T10:00:00Z","prov');
		expect((await ledger.records()).map((r) => r.submissionId)).toEqual(["s1"]);
		await ledger.record(turn("s2"));
		expect((await ledger.records()).map((r) => r.submissionId)).toEqual(["s1", "s2"]);
		expect(await readFile(join(dir, "usage.jsonl"), "utf8")).not.toContain("prov\n");
	});

	it("says which whole line is not a record instead of skipping it", async () => {
		const { dir, ledger } = ledgerIn();
		await ledger.record(turn("s1"));
		await appendFile(join(dir, "usage.jsonl"), "not json\n");
		await expect(ledger.records()).rejects.toThrow(/usage\.jsonl: line 2 is not a usage record/);
	});

	it("a read while records are being written sees each of them whole", async () => {
		const { ledger } = ledgerIn();
		const writes = Array.from({ length: 20 }, (_, i) => ledger.record(turn(`s${i}`, 0.01)));
		const reads = Array.from({ length: 20 }, () => ledger.records());
		await Promise.all(writes);
		for (const read of await Promise.all(reads)) for (const r of read) expect(r.role).toBe("agent");
		expect(await ledger.records()).toHaveLength(20);
	});

	it.each(["the next file written", "the audit"])("is the record of the spend: a fault in %s after a line is written, a retry and a restart all give one row and the day's total from it", async (where) => {
		const { dir, ledger } = ledgerIn();
		let failAudit = where === "the audit";
		const audit = { append: async () => { if (failAudit) throw new Error("EIO: audit not written"); } } as unknown as AuditLog;
		fault.atomicWrite = where === "the next file written";
		await ledger.record(turn("s1", 25), audit).catch(() => {});
		fault.atomicWrite = false;
		failAudit = false;
		// The same submission recorded again, as a recovery delivers it.
		await ledger.record(turn("s1", 25), audit);
		expect(await ledger.records()).toEqual([expect.objectContaining({ submissionId: "s1", estimatedUsd: 25 })]);
		expect(await ledger.todaySpent()).toBe(25);
		expect(await ledger.isHardCapped()).toBe(true);
		// A restart: nothing of this process is left.
		vi.resetModules();
		const { UsageLedger: Restarted } = await import("../src/core/usage.ts");
		const after = new Restarted(dir, { softUsdPerDay: 5, hardUsdPerDay: 20 });
		expect(await after.records()).toHaveLength(1);
		expect(await after.todaySpent()).toBe(25);
		expect(await after.monthSpent()).toBe(25);
		expect(await after.isHardCapped()).toBe(true);
	});
});
