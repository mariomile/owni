/** Nightly first-tool routing, not outcome success. Every handled exit writes a report. */
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AuditLog } from "../../src/core/audit.ts";
import { tenantId } from "../../src/core/ids.ts";
import { modelProvider } from "../../src/core/model-providers.ts";
import { tenantDir } from "../../src/core/paths.ts";
import { UsageLedger } from "../../src/core/usage.ts";
import { bootOwni, loadCases, root } from "./owni.ts";
import { evaluateRouting, type RoutingSession } from "./real-runner.ts";
import { routingSummary } from "./report.ts";

const key = process.env.OWNI_JUDGE_MODEL_KEY;
const selectedModel = { provider: "anthropic", model: process.env.OWNI_MODEL_ID?.trim() || modelProvider("anthropic")!.defaultModel };
const TURN_TIMEOUT_MS = 180_000;

async function open(): Promise<RoutingSession> {
	const boot = await bootOwni({ OWNI_MODEL_PROVIDER: selectedModel.provider, ANTHROPIC_API_KEY: key!, OWNI_MODEL_ID: selectedModel.model });
	const { owni, dataDir } = boot;
	try {
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token: owni.ownerLink?.split("#")[1] }) });
		if (login.status !== 200) throw new Error(`login: ${login.status}`);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
		const api = async (path: string, body: unknown) => {
			const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, "x-owni": "1" }, body: JSON.stringify(body) });
			if (!res.ok) throw new Error(`${path}: ${res.status}`);
			return await res.json() as { thread?: { id: string } };
		};
		const audit = new AuditLog(dataDir, tenantId("default"));
		const ledger = new UsageLedger(tenantDir(dataDir, tenantId("default")));
		return {
			close: boot.close,
			async observe(c) {
				const thread = (await api("/api/instances/owni/threads", {})).thread;
				if (thread === undefined) throw new Error("Thread creation returned no thread");
				await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: c.text });
				for (const start = Date.now(); Date.now() - start < TURN_TIMEOUT_MS;) {
					// Matched by thread: a late reply cannot score the next case.
					const turn = (await ledger.records()).find((r) => r.role === "agent" && r.instanceId === "owni" && r.threadId === thread.id);
					if (turn !== undefined) {
						if (turn.tools === undefined || turn.modelCalls === undefined) throw new Error("Usage is missing tools/model calls");
						return { tools: turn.tools, provider: turn.provider, model: turn.model, costUsd: turn.estimatedUsd, modelCalls: turn.modelCalls };
					}
					// Usage precedes replies. An unmeasured reply is an error, even for no-tool cases.
					const reply = (await audit.read()).find((r) => r.instanceId === "owni" && r.threadId === thread.id && r.type === "reply.emitted");
					if (reply !== undefined) throw new Error(reply.status === "unanswered" ? String(reply.reason ?? "unanswered") : "Answered without usage");
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				throw new Error(`No answer in ${TURN_TIMEOUT_MS / 1000}s`);
			},
		};
	} catch (error) {
		await boot.close();
		throw error;
	}
}

const report = await evaluateRouting({ load: loadCases, selectors: process.argv.slice(2), selectedModel, key, open });
await mkdir(join(root, "last-report"), { recursive: true });
await writeFile(join(root, "last-report", "agente.json"), `${JSON.stringify(report, null, 2)}\n`);
const summary = routingSummary(report);
await writeFile(join(root, "last-report", "agente.md"), summary);
console.log(summary);
process.exitCode = report.status === "passed" || report.status === "skipped" ? 0 : 1;
