/** Nightly routing session: one Owni per case, so no case reads the conversation of the one before. */
import type { AddressInfo } from "node:net";
import { AuditLog } from "../../src/core/audit.ts";
import { tenantId } from "../../src/core/ids.ts";
import { tenantDir } from "../../src/core/paths.ts";
import { UsageLedger } from "../../src/core/usage.ts";
import { bootOwni } from "./owni.ts";
import type { RoutingSession } from "./real-runner.ts";
import type { EvalModel } from "./report.ts";

const TURN_TIMEOUT_MS = 180_000;

export function openRoutingSession(model: EvalModel, key: string, timeoutMs = TURN_TIMEOUT_MS): RoutingSession {
	return {
		async close() {},
		async observe(c) {
			const boot = await bootOwni({ OWNI_MODEL_PROVIDER: model.provider, ANTHROPIC_API_KEY: key, OWNI_MODEL_ID: model.model });
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
				// The direct conversation: one per person and agente, fresh in this Owni.
				const thread = (await api("/api/instances/owni/dm", {})).thread;
				if (thread === undefined) throw new Error("Thread creation returned no thread");
				await api(`/api/instances/owni/threads/${thread.id}/messages`, { text: c.text });
				for (const start = Date.now(); Date.now() - start < timeoutMs;) {
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
				throw new Error(`No answer in ${timeoutMs / 1000}s`);
			} finally {
				await boot.close();
			}
		},
	};
}
