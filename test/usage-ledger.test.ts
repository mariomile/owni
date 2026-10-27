import { mkdtempSync } from "node:fs";
import { appendFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuditLog } from "../src/core/audit.ts";
import { romeDayKey, UsageLedger, type UsageRecord } from "../src/core/usage.ts";

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

	it("skips and says each whole line that is not a record, the same for the cap and the stats", async () => {
		const { dir, ledger } = ledgerIn();
		const said = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await ledger.record(turn("s1", 15));
			await appendFile(join(dir, "usage.jsonl"), 'not json\n{"at":"yesterday","estimatedUsd":9}\n{"at":"2026-10-22T10:00:00Z","estimatedUsd":"9"}\n');
			await ledger.record(turn("s2", 6));
			expect((await ledger.records()).map((r) => r.submissionId)).toEqual(["s1", "s2"]);
			expect(await ledger.todaySpent()).toBe(21);
			expect((await ledger.byMonth())[romeDayKey().slice(0, 7)]).toBe(21);
			expect(await ledger.hardCapped()).toBeDefined();
			expect(said.mock.calls.map(([message]) => String(message))).toEqual(expect.arrayContaining([expect.stringMatching(/usage\.jsonl: line 2 is not a usage record, skipped/), expect.stringMatching(/line 3 /), expect.stringMatching(/line 4 /)]));
		} finally {
			said.mockRestore();
		}
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
		expect(await ledger.hardCapped()).toBeDefined();
		// A restart: nothing of this process is left.
		vi.resetModules();
		const { UsageLedger: Restarted } = await import("../src/core/usage.ts");
		const after = new Restarted(dir, { softUsdPerDay: 5, hardUsdPerDay: 20 });
		expect(await after.records()).toHaveLength(1);
		expect(await after.todaySpent()).toBe(25);
		expect((await after.byMonth())[romeDayKey().slice(0, 7)]).toBe(25);
		expect(await after.hardCapped()).toBeDefined();
	});
});

describe("the ledger kept by month (ADR 0130)", () => {
	const at = (iso: string, submissionId: string, estimatedUsd = 1): UsageRecord => ({ ...turn(submissionId, estimatedUsd), at: iso });
	/** A date in the Europe/Rome month `back` months before this one, mid-month so no timezone moves it. */
	const monthsAgo = (back: number): string => {
		const d = new Date();
		d.setUTCDate(15);
		d.setUTCMonth(d.getUTCMonth() - back);
		return d.toISOString();
	};
	const names = async (dir: string) => (await readdir(dir)).filter((n) => n.startsWith("usage")).sort();

	it("moves the live file to the archive of its month on the first record of a new month", async () => {
		const { dir, ledger } = ledgerIn();
		await ledger.record(at("2026-08-10T10:00:00Z", "a"));
		await ledger.record(at("2026-08-20T10:00:00Z", "b"));
		expect(await names(dir)).toEqual(["usage.jsonl"]);
		await ledger.record(at("2026-09-02T10:00:00Z", "c"));
		expect(await names(dir)).toEqual(["usage-2026-08.jsonl", "usage.jsonl"]);
		expect((await readFile(join(dir, "usage-2026-08.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
		expect((await readFile(join(dir, "usage.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
		expect((await ledger.records()).map((r) => r.submissionId)).toEqual(["a", "b", "c"]);
		expect(await ledger.byMonth()).toEqual({ "2026-08": 2, "2026-09": 1 });
		expect(await ledger.size()).toBe((await Promise.all(["usage-2026-08.jsonl", "usage.jsonl"].map((n) => stat(join(dir, n))))).reduce((sum, s) => sum + s.size, 0));
	});

	it("deletes archives older than twelve months and keeps the twelfth", async () => {
		const { dir, ledger } = ledgerIn();
		const line = (iso: string) => `${JSON.stringify(at(iso, iso))}\n`;
		await writeFile(join(dir, "usage-2025-09.jsonl"), line("2025-09-10T10:00:00Z"));
		await writeFile(join(dir, "usage-2025-10.jsonl"), line("2025-10-10T10:00:00Z"));
		await writeFile(join(dir, "usage.jsonl"), line("2026-09-10T10:00:00Z"));
		await ledger.record(at("2026-10-27T10:00:00Z", "now"));
		expect(await names(dir)).toEqual(["usage-2025-10.jsonl", "usage-2026-09.jsonl", "usage.jsonl"]);
		expect(Object.keys(await ledger.byMonth())).toEqual(["2025-10", "2026-09", "2026-10"]);
	});

	it("keeps today's total and the month's right after a rotation, and the hard cap reads them", async () => {
		const { dir, ledger } = ledgerIn();
		await ledger.record(at(monthsAgo(1), "old", 19));
		expect(await ledger.hardCapped()).toBeUndefined();
		const first = await ledger.record(turn("new1", 15));
		expect(await names(dir)).toHaveLength(2);
		// Last month's 19 is not today's spend: the cap sees 15, then 30.
		expect(first.hardExceeded).toBe(false);
		expect(await ledger.todaySpent()).toBe(15);
		expect((await ledger.byMonth())[romeDayKey().slice(0, 7)]).toBe(15);
		expect((await ledger.byMonth())[monthsAgo(1).slice(0, 7)]).toBe(19);
		expect((await ledger.record(turn("new2", 5))).hardExceeded).toBe(true);
		expect(await ledger.hardCapped()).toBeDefined();
		// A new process reads the same totals from the files.
		expect(await new UsageLedger(dir, { softUsdPerDay: 5, hardUsdPerDay: 20 }).todaySpent()).toBe(20);
	});

	it("bills a submission once even when its retry arrives after the month changed", async () => {
		const { dir, ledger } = ledgerIn();
		await ledger.record(at("2026-09-30T21:59:00Z", "s1", 3));
		await ledger.record(at("2026-10-01T10:00:00Z", "s1", 3));
		// The retry rotated the ledger, found the turn in the archive and wrote nothing: no live file yet.
		expect(await names(dir)).toEqual(["usage-2026-09.jsonl"]);
		expect(await ledger.records()).toHaveLength(1);
		expect(await ledger.byMonth()).toEqual({ "2026-09": 3 });
		// Another instance with the same submission id is a different turn.
		await ledger.record({ ...at("2026-10-01T11:00:00Z", "s1", 2), instanceId: "other" });
		expect(await ledger.byMonth()).toEqual({ "2026-09": 3, "2026-10": 2 });
	});
});
