import { mkdtempSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageLedger, type UsageRecord } from "../src/core/usage.ts";

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
});
