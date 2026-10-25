import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit.ts";
import { tenantId } from "../src/core/ids.ts";
import { estimateUsd, TELEGRAM_HARD_CAP, TELEGRAM_SOFT_CAP, UsageLedger } from "../src/core/usage.ts";
import { DEFAULT_MODEL_ROLES, FAUX_MODEL_ROLES, roleModel } from "../src/core/model-routing.ts";

describe("usage caps and routing", () => {
	it("routes extract to Haiku and draft to Sonnet by default", () => {
		expect(roleModel(DEFAULT_MODEL_ROLES, "extract").modelId).toBe("claude-haiku-5-5");
		expect(roleModel(DEFAULT_MODEL_ROLES, "draft").modelId).toBe("claude-sonnet-5-5");
		expect(FAUX_MODEL_ROLES.extract.provider).toBe("faux");
	});

	it("soft and hard caps trip with audit + Telegram copy constants", async () => {
		const dir = mkdtempSync(join(tmpdir(), "owni-cap-"));
		const audit = new AuditLog(dir, tenantId("acme"));
		const ledger = new UsageLedger(join(dir, "acme"), { softUsdPerDay: 5, hardUsdPerDay: 20 });
		const big = estimateUsd("claude-sonnet-5-5", 2_000_000, 500_000); // well over soft
		await ledger.record(
			{
				at: new Date().toISOString(),
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				role: "draft",
				inputTokens: 2_000_000,
				outputTokens: 500_000,
				estimatedUsd: Math.max(big, 6),
			},
			audit,
		);
		expect(await ledger.isSoftCapped()).toBe(true);
		expect(TELEGRAM_SOFT_CAP).toContain("Limite soft di spesa");
		await ledger.record(
			{
				at: new Date().toISOString(),
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				role: "draft",
				inputTokens: 5_000_000,
				outputTokens: 2_000_000,
				estimatedUsd: 20,
			},
			audit,
		);
		expect(await ledger.isHardCapped()).toBe(true);
		expect(TELEGRAM_HARD_CAP).toContain("Limite hard di spesa");
		const events = await audit.read();
		expect(events.some((e) => e.type === "cost.warn" || e.type === "cost.denied")).toBe(true);
	});
});
