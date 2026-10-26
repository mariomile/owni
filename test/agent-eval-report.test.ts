import { describe, expect, it, vi } from "vitest";
import { evaluateRouting } from "../evals/agente/real-runner.ts";
import { routingError, routingReport, routingSummary, scoreRouting, selectCases, type RoutingObservation } from "../evals/agente/report.ts";

const selectedModel = { provider: "anthropic", model: "selected-model" };
const c = { id: "calc", text: "Calcola", expect: ["code_run"] };
const turn: RoutingObservation = { tools: ["code_run"], provider: "actual-provider", model: "actual-model", costUsd: 0.001, modelCalls: 2 };
const build = (rows = [scoreRouting(c, turn)]) => routingReport({ selected: [c], rows, selectedModel });

describe("routing report: first-tool accuracy is not outcome success", () => {
	it("reports actual provider/model from usage separately from the selection", () => {
		const report = build();
		expect(report).toMatchObject({ status: "passed", selectedCases: 1, measuredCases: 1, selectedModel, actualModels: [{ provider: "actual-provider", model: "actual-model" }], firstToolAccuracy: 1, outcomeSuccess: null });
		expect(routingSummary(report)).toContain("actual-provider/actual-model");
	});
	it("fails for a wrong tool", () => {
		const report = build([scoreRouting(c, { ...turn, tools: ["file_read"] })]);
		expect(report.status).toBe("failed");
		expect(report.firstToolAccuracy).toBe(0);
	});
	it("accepts a no-tool case only when the measured turn actually used no tools", () => {
		expect(scoreRouting({ id: "hello", expect: [] }, { ...turn, tools: [] }).status).toBe("passed");
		expect(scoreRouting(c, { ...turn, tools: [] }).status).toBe("failed");
	});
	it("ignores tool_search only when it is followed by an actual tool", () => {
		expect(scoreRouting(c, { ...turn, tools: ["tool_search", "code_run"] }).status).toBe("passed");
		expect(scoreRouting({ id: "hello", expect: [] }, { ...turn, tools: ["tool_search"] }).status).toBe("failed");
	});
	it("does not invent an accuracy for zero selected cases", () => {
		const report = routingReport({ selected: [], rows: [], selectedModel });
		expect(report).toMatchObject({ status: "error", measuredCases: 0, firstToolAccuracy: null, actualModels: [] });
		expect(routingSummary(report)).toContain("non misurata");
	});
	it("reports skip and the selected coverage without claiming a measured model or accuracy", () => {
		const report = routingReport({ selected: [c], rows: [], selectedModel, skipReason: "no key" });
		expect(report).toMatchObject({ status: "skipped", selectedCases: 1, measuredCases: 0, skippedCases: 1, firstToolAccuracy: null, actualModels: [], reasons: ["no key"] });
		expect(routingSummary(report)).toContain("Routing agente: skipped");
	});
	it("rejects skipped runs that contain measurements", () => {
		expect(routingReport({ selected: [c], rows: [scoreRouting(c, turn)], selectedModel, skipReason: "no key" }).status).toBe("error");
	});
	it("does not turn an execution failure into a valid no-tool answer", () => {
		const hello = { id: "hello", expect: [] };
		const report = routingReport({ selected: [hello], rows: [routingError(hello, "timeout")], selectedModel });
		expect(report).toMatchObject({ status: "error", errorCases: 1, measuredCases: 0, firstToolAccuracy: null, reasons: ["hello: timeout"] });
	});
	it("marks partial runs as errors even if all measured tools are correct", () => {
		const report = routingReport({ selected: [c, { ...c, id: "second" }], rows: [scoreRouting(c, turn)], selectedModel });
		expect(report).toMatchObject({ status: "error", selectedCases: 2, measuredCases: 1, firstToolAccuracy: 1 });
	});
	it.each([
		{ provider: "" }, { model: "" }, { costUsd: Number.NaN }, { costUsd: -1 }, { modelCalls: 0 }, { modelCalls: 1.5 },
	])("refuses incomplete usage: %j", (invalid) => {
		expect(build([scoreRouting(c, { ...turn, ...invalid })])).toMatchObject({ status: "error", measuredCases: 0, firstToolAccuracy: null });
	});
	it("cannot pass duplicate or unexpected measurement rows", () => {
		expect(build([scoreRouting(c, turn), scoreRouting(c, turn)]).status).toBe("error");
		expect(build([scoreRouting({ ...c, id: "other" }, turn)]).status).toBe("error");
	});
	it("applies the gate at exactly 80 percent", () => {
		const selected = Array.from({ length: 5 }, (_, i) => ({ ...c, id: String(i) }));
		const rows = selected.map((test, i) => scoreRouting(test, { ...turn, tools: i === 0 ? [] : ["code_run"] }));
		expect(routingReport({ selected, rows, selectedModel })).toMatchObject({ status: "passed", firstToolAccuracy: 0.8 });
	});
});

describe("case selectors", () => {
	it("selects known IDs and deduplicates repeated selectors", () => {
		expect(selectCases([c], [c.id, c.id])).toEqual([c]);
	});
	it.each([["typo"], ["calc", "typo"], ["--unknown"]])("rejects unknown selectors %j", (...selectors) => {
		expect(() => selectCases([c], selectors)).toThrow(/Unknown case selectors/);
	});
	it("rejects an empty or duplicate catalog", () => {
		expect(() => selectCases([], [])).toThrow(/empty/);
		expect(() => selectCases([c, c], [])).toThrow(/unique/);
	});
});

describe("routing runner error/skip boundaries (no model calls)", () => {
	const setup = () => {
		const observe = vi.fn(async () => turn);
		const close = vi.fn(async () => {});
		const open = vi.fn(async () => ({ observe, close }));
		return { options: { load: async () => [c], selectors: [] as string[], selectedModel, key: "test-only", open }, open, observe, close };
	};
	it("missing credentials produces a skip report without booting", async () => {
		const f = setup();
		expect(await evaluateRouting({ ...f.options, key: undefined })).toMatchObject({ status: "skipped", selectedCases: 1, firstToolAccuracy: null });
		expect(f.open).not.toHaveBeenCalled();
	});
	it("unknown selectors fail even when credentials are absent", async () => {
		const f = setup();
		const report = await evaluateRouting({ ...f.options, key: undefined, selectors: ["nope"] });
		expect(report.status).toBe("error");
		expect(report.reasons.join()).toContain("Unknown case selectors");
		expect(f.open).not.toHaveBeenCalled();
	});
	it("catalog read failure produces an error report", async () => {
		const f = setup();
		expect(await evaluateRouting({ ...f.options, load: async () => { throw new Error("bad JSONL"); } })).toMatchObject({ status: "error", measuredCases: 0, firstToolAccuracy: null });
		expect(f.open).not.toHaveBeenCalled();
	});
	it("boot failure produces an error report with selected coverage", async () => {
		const f = setup();
		f.open.mockRejectedValueOnce(new Error("boot failed"));
		expect(await evaluateRouting(f.options)).toMatchObject({ status: "error", selectedCases: 1, measuredCases: 0, firstToolAccuracy: null });
	});
	it("closes after an observation error and still measures the next case", async () => {
		const f = setup();
		f.observe.mockRejectedValueOnce(new Error("timeout"));
		const report = await evaluateRouting({ ...f.options, load: async () => [c, { ...c, id: "second" }] });
		expect(report).toMatchObject({ status: "error", measuredCases: 1, errorCases: 1, firstToolAccuracy: 1 });
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("cleanup errors cannot become a passing report", async () => {
		const f = setup();
		f.close.mockRejectedValueOnce(new Error("stop failed"));
		const report = await evaluateRouting(f.options);
		expect(report.status).toBe("error");
		expect(report.reasons).toContain("Cleanup failed: stop failed");
	});
});
