import { routingError, routingReport, scoreRouting, selectCases, type EvalModel, type RoutingCase, type RoutingObservation, type RoutingRow } from "./report.ts";

type Case = RoutingCase & { text: string };
export type RoutingSession = { observe(c: Case): Promise<RoutingObservation>; close(): Promise<void> };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Injected execution boundary lets report/lifecycle tests run without a model or network. */
export async function evaluateRouting(options: {
	load: () => Promise<Case[]>;
	selectors: readonly string[];
	selectedModel: EvalModel;
	key?: string;
	open: () => Promise<RoutingSession>;
}) {
	let selected: Case[] = [];
	const rows: RoutingRow[] = [];
	const errors: string[] = [];
	let session: RoutingSession | undefined;
	let skipReason: string | undefined;
	try {
		selected = selectCases(await options.load(), options.selectors);
		if (!options.key?.trim()) skipReason = "Missing OWNI_JUDGE_MODEL_KEY; no real-model calls made";
		else {
			session = await options.open();
			for (const c of selected) {
				try { rows.push(scoreRouting(c, await session.observe(c))); }
				catch (error) { rows.push(routingError(c, message(error))); }
			}
		}
	} catch (error) {
		errors.push(message(error));
	} finally {
		if (session !== undefined) {
			try { await session.close(); }
			catch (error) { errors.push(`Cleanup failed: ${message(error)}`); }
		}
	}
	return routingReport({ selected, rows, errors, skipReason, selectedModel: options.selectedModel, selectors: options.selectors });
}
