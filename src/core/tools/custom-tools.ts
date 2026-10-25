import { join } from "node:path";
import { egressFetch } from "../../connectors/http.ts";
import type { OwniTool } from "../engine.ts";
import type { EgressPolicy } from "../policy.ts";
import { customToolName, ProposalError, type ProposalStore, type ToolProposal, toolEgressName } from "../proposals.ts";
import { runSandboxed } from "../sandbox.ts";

export type CustomToolsOptions = {
	readonly store: ProposalStore;
	/** Folder of the approved tools' own folders and of the sandbox runner. */
	readonly toolsDir: string;
	readonly policy: () => Promise<EgressPolicy>;
	/** Tell the approvers a proposal is waiting (Telegram cards, web). */
	readonly onProposed: (proposal: ToolProposal) => Promise<void>;
	readonly timeoutMs?: number;
};

/**
 * `tool_propose`, and every approved tool proposto as a tool the model can call. An
 * approved tool runs in the sandbox, reaching only its declared hosts, and only while the
 * egress policy lists tool:<name>.
 */
export async function createCustomTools(options: CustomToolsOptions): Promise<OwniTool[]> {
	const propose: OwniTool = {
		name: "tool_propose",
		description:
			"Write a new tool for yourself when no existing tool can do the job (e.g. call a public API, transform data). " +
			"It does not run until a human approver approves it; tell the person it is waiting for approval. " +
			"code is an ES module: `export default async (args, { workDir }) => result`, using only `fetch` (to the declared hosts), " +
			"node:fs inside workDir, and standard JavaScript. No other network, processes or environment.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "snake_case, 3-41 chars, e.g. weather_forecast" },
				description: { type: "string", description: "What it does and when to use it, for the approver and for you" },
				parameters: { type: "object", description: 'JSON Schema of its arguments, with type "object"' },
				code: { type: "string", description: "ES module source with a default export" },
				hosts: { type: "array", items: { type: "string" }, description: "Host names it needs over https, e.g. api.open-meteo.com; empty for none" },
			},
			required: ["name", "description", "parameters", "code", "hosts"],
			additionalProperties: false,
		},
		replaySafe: true,
		async execute(args, ctx) {
			return ctx.step("propose", async () => {
				try {
					const proposal = await options.store.propose({
						name: String(args.name),
						description: String(args.description),
						parameters: (args.parameters ?? {}) as Record<string, unknown>,
						code: String(args.code),
						hosts: Array.isArray(args.hosts) ? args.hosts.map(String) : [],
						...(ctx.thread === undefined ? {} : { thread: ctx.thread }),
					});
					await options.onProposed(proposal);
					return `Proposta ${proposal.id} (${customToolName(proposal.name)}) inviata agli approvatori. Non posso usarla finché non viene approvata.`;
				} catch (error) {
					if (error instanceof ProposalError) return `Errore: ${error.message}`;
					throw error;
				}
			});
		},
	};
	const approved = (await options.store.approved()).map((proposal): OwniTool => ({
		name: customToolName(proposal.name),
		description: `${proposal.description} (tool proposto ${proposal.id}, approvato)`.slice(0, 1024),
		parameters: proposal.parameters,
		// Written by the instance: what it does outside is not known to be safe to repeat.
		replaySafe: false,
		async execute(args, ctx) {
			try {
				return await runSandboxed({
					code: proposal.code,
					args,
					workDir: join(options.toolsDir, proposal.name),
					runnerDir: options.toolsDir,
					fetch: egressFetch(toolEgressName(proposal.name), proposal.hosts, options.policy),
					signal: ctx.signal,
					...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				});
			} catch (error) {
				return `Errore del tool ${proposal.name}: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	}));
	return [propose, ...approved];
}
