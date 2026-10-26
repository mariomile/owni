/** Nightly first-tool routing, not outcome success. Every handled exit writes a report. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelProvider } from "../../src/core/model-providers.ts";
import { loadCases, root } from "./owni.ts";
import { evaluateRouting } from "./real-runner.ts";
import { openRoutingSession } from "./real-session.ts";
import { routingSummary } from "./report.ts";

const key = process.env.OWNI_JUDGE_MODEL_KEY;
const selectedModel = { provider: "anthropic", model: process.env.OWNI_MODEL_ID?.trim() || modelProvider("anthropic")!.defaultModel };

const report = await evaluateRouting({ load: loadCases, selectors: process.argv.slice(2), selectedModel, key, open: async () => openRoutingSession(selectedModel, key!) });
await mkdir(join(root, "last-report"), { recursive: true });
await writeFile(join(root, "last-report", "agente.json"), `${JSON.stringify(report, null, 2)}\n`);
const summary = routingSummary(report);
await writeFile(join(root, "last-report", "agente.md"), summary);
console.log(summary);
process.exitCode = report.status === "passed" || report.status === "skipped" ? 0 : 1;
