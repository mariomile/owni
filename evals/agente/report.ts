/** Routing only: a correct first tool says nothing about the result of its operation. */
export type EvalStatus = "passed" | "failed" | "skipped" | "error";
export type EvalModel = { provider: string; model: string };
export type RoutingCase = { id: string; expect: string[] };
export type RoutingObservation = { tools: readonly string[]; provider: string; model: string; costUsd: number; modelCalls: number };
export type RoutingRow = {
	id: string;
	expect: string[];
	status: "passed" | "failed" | "error";
	tools: string[];
	firstTool: string | null;
	model: EvalModel | null;
	costUsd: number;
	modelCalls: number;
	reason: string | null;
};

export function selectCases<T extends { id: string }>(cases: readonly T[], selectors: readonly string[]): T[] {
	if (cases.length === 0) throw new Error("The case catalog is empty");
	const ids = new Set(cases.map((c) => c.id));
	if (ids.size !== cases.length || cases.some((c) => typeof c.id !== "string" || !c.id.trim())) throw new Error("Case IDs must be nonempty and unique");
	const unknown = selectors.filter((id) => !ids.has(id));
	if (unknown.length > 0) throw new Error(`Unknown case selectors: ${unknown.join(", ")}`);
	return cases.filter((c) => selectors.length === 0 || selectors.includes(c.id));
}

export function routingError(c: RoutingCase, reason: string): RoutingRow {
	return { id: c.id, expect: c.expect, status: "error", tools: [], firstTool: null, model: null, costUsd: 0, modelCalls: 0, reason };
}

export function scoreRouting(c: RoutingCase, turn: RoutingObservation): RoutingRow {
	if (!turn.provider.trim() || !turn.model.trim()) return routingError(c, "Usage is missing the actual provider/model");
	if (!Array.isArray(turn.tools) || turn.tools.some((t) => typeof t !== "string") || !Number.isFinite(turn.costUsd) || turn.costUsd < 0 || !Number.isInteger(turn.modelCalls) || turn.modelCalls < 1) {
		return routingError(c, "Invalid or missing turn usage");
	}
	const firstTool = turn.tools.find((t) => t !== "tool_search") ?? turn.tools[0] ?? null;
	const ok = c.expect.length === 0 ? firstTool === null : firstTool !== null && c.expect.includes(firstTool);
	return { id: c.id, expect: c.expect, status: ok ? "passed" : "failed", tools: [...turn.tools], firstTool, model: { provider: turn.provider, model: turn.model }, costUsd: turn.costUsd, modelCalls: turn.modelCalls, reason: ok ? null : `Expected ${c.expect.join(" or ") || "no tool"}; got ${firstTool ?? "no tool"}` };
}

export function routingReport(input: {
	selected: readonly RoutingCase[];
	rows: readonly RoutingRow[];
	selectedModel: EvalModel;
	selectors?: readonly string[];
	errors?: readonly string[];
	skipReason?: string;
	at?: string;
}) {
	const { selected, rows } = input;
	const reasons = [...(input.errors ?? [])];
	const ids = new Set(selected.map((c) => c.id));
	if (selected.length === 0) reasons.push("No cases selected; no measurement was made");
	if (ids.size !== selected.length || new Set(rows.map((r) => r.id)).size !== rows.length || rows.some((r) => !ids.has(r.id))) reasons.push("Duplicate or unexpected report cases");
	if (input.skipReason === undefined && rows.length !== selected.length) reasons.push("Selected cases did not all finish");
	if (input.skipReason !== undefined && rows.length > 0) reasons.push("A skipped run cannot contain measurements");
	for (const row of rows) if (row.status === "error") reasons.push(`${row.id}: ${row.reason}`);
	const measured = rows.filter((r) => r.status !== "error");
	const firstToolAccuracy = measured.length === 0 ? null : measured.filter((r) => r.status === "passed").length / measured.length;
	const gate = { firstToolAccuracy: 0.8 };
	const status: EvalStatus = reasons.length > 0 ? "error" : input.skipReason !== undefined ? "skipped" : firstToolAccuracy !== null && firstToolAccuracy >= gate.firstToolAccuracy ? "passed" : "failed";
	if (input.skipReason !== undefined) reasons.push(input.skipReason);
	if (status === "failed") reasons.push("First-tool accuracy is below the gate");
	const actualModels = [...new Map(measured.map((r) => [JSON.stringify(r.model), r.model!])).values()];
	return {
		at: input.at ?? new Date().toISOString(), kind: "routing-first-tool" as const, status,
		selectedModel: input.selectedModel, actualModels, selectors: input.selectors ?? [],
		selectedCases: selected.length, measuredCases: measured.length,
		skippedCases: status === "skipped" ? selected.length : 0,
		errorCases: rows.filter((r) => r.status === "error").length,
		firstToolAccuracy, outcomeSuccess: null, costUsd: rows.reduce((sum, r) => sum + r.costUsd, 0),
		gate, reasons, rows,
	};
}

export type RoutingReport = ReturnType<typeof routingReport>;

export function routingSummary(report: RoutingReport): string {
	const models = report.actualModels.map((m) => `${m.provider}/${m.model}`).join(", ") || "non misurato";
	const accuracy = report.firstToolAccuracy === null ? "non misurata" : `${(report.firstToolAccuracy * 100).toFixed(1)}%`;
	return `## Routing agente: ${report.status}\n\nModello selezionato: ${report.selectedModel.provider}/${report.selectedModel.model}. Modello effettivo: ${models}.\n\nCasi selezionati: ${report.selectedCases}; misurati: ${report.measuredCases}; skipped: ${report.skippedCases}; errori: ${report.errorCases}.\n\nAccuratezza primo tool: ${accuracy} (soglia ${report.gate.firstToolAccuracy * 100}%). Non misura il successo del compito.\n${report.reasons.map((r) => `\n- ${r.replace(/[\r\n]+/g, " ")}`).join("")}\n`;
}
