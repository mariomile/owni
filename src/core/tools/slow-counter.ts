import type { OwniTool } from "../engine.ts";

export type SlowCounterOptions = {
	/** Simulated work per step. */
	readonly stepMs?: number;
	/** The step's side effect; runs once per step, also across crashes and restarts. */
	readonly onStep?: (step: number) => void | Promise<void>;
	/** Called after a step's result is durably stored. */
	readonly onCheckpoint?: (step: number) => void;
};

/**
 * Example of a slow, replay-safe tool: counts to n, one durable step per number.
 * After a crash the call reruns, and steps already stored are skipped.
 */
export function createSlowCounter(options: SlowCounterOptions = {}): OwniTool {
	const stepMs = options.stepMs ?? 500;
	return {
		name: "slow_counter",
		description: "Count from 1 to n slowly, one checkpointed step per number. Use it when asked to count.",
		parameters: {
			type: "object",
			properties: { n: { type: "integer", minimum: 1, maximum: 100, description: "Number to count to" } },
			required: ["n"],
			additionalProperties: false,
		},
		replaySafe: true,
		async execute(args, ctx) {
			const n = args.n as number;
			for (let i = 1; i <= n; i++) {
				await ctx.step(`count-${i}`, async () => {
					await sleep(stepMs, ctx.signal);
					await options.onStep?.(i);
					return i;
				});
				options.onCheckpoint?.(i);
				ctx.progress(`${i}\n`);
			}
			return `Ho contato fino a ${n}.`;
		},
	};
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason);
		}, { once: true });
	});
}
