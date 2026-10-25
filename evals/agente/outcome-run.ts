import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTCOME_CASES, runOutcome, type OutcomeResult } from "./outcomes.ts";
import { selectCases } from "./report.ts";

const rows: OutcomeResult[] = [];
const errors: string[] = [];
let selectedCases = 0;
try {
	const selected = selectCases(OUTCOME_CASES, process.argv.slice(2));
	selectedCases = selected.length;
	for (const c of selected) {
		const row = await runOutcome(c.id);
		rows.push(row);
		console.log(`${row.status}: ${c.id} (${row.checks.length} checks)${row.reasons.length ? `: ${row.reasons.join("; ")}` : ""}`);
	}
} catch (error) { errors.push(String(error)); }
const status = errors.length || rows.some((r) => r.status === "error") ? "error" : rows.some((r) => r.status === "failed") ? "failed" : "passed";
const report = { at: new Date().toISOString(), kind: "integration-outcome-contract", model: { provider: "faux", model: "owni-dev" }, status, selectedCases, measuredCases: rows.length, passedCases: rows.filter((r) => r.status === "passed").length, errors, rows };
const dir = join(dirname(fileURLToPath(import.meta.url)), "last-report");
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "outcomes.json"), `${JSON.stringify(report, null, 2)}\n`);
const summary = `## Outcome integration contracts: ${status}\n\n${report.passedCases}/${selectedCases} scenari superati. Runtime/tool/store reali, modello faux, servizi esterni stub. Non misura qualità linguistica, routing naturale o parità Grok.\n${rows.map((r) => `\n- ${r.id}: ${r.status}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}`).join("")}\n${errors.join("\n")}\n`;
await writeFile(join(dir, "outcomes.md"), summary);
console.log(summary);
process.exitCode = status === "passed" ? 0 : 1;
