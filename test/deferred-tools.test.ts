/**
 * Deferred tools (ADR 0122): a tool marked deferred, a connector's, is not offered to the model
 * until it loads it with tool_search; once loaded it stays for the conversation.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startOwni } from "../src/app.ts";
import { piDurableEngine, toolSearch } from "../src/core/adapters/pi-durable.ts";
import type { OwniTool, DurableEngine } from "../src/core/index.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

function tool(name: string, calls: string[], deferred?: true): OwniTool {
	return {
		name,
		description: `The ${name} tool.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		deferred,
		async execute() {
			calls.push(name);
			return `${name} ok`;
		},
	};
}

describe("deferred tools (ADR 0122)", () => {
	it("a deferred tool runs only after tool_search loads it by name, alone, and stays loaded in the conversation", async () => {
		const calls: string[] = [];
		const { runtime, replies } = await runtimeWithInstance({ tools: [tool("near_tool", calls), tool("crm__clienti", calls, true), tool("crm__contratti", calls, true)] });
		const say = async (text: string, messageId: string, count: number) => {
			await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text, messageId });
			await waitFor(() => replies.length === count);
		};
		await say("/tool crm__clienti {}", "1", 1);
		expect(calls).toEqual([]);
		await say('/tool tool_search {"query":"crm__clienti"}', "2", 2);
		await say("/tool crm__clienti {}", "3", 3);
		await say("/tool near_tool {}", "4", 4);
		// The exact name loaded that tool only, not its neighbours.
		await say("/tool crm__contratti {}", "5", 5);
		await runtime.close();
		expect(calls).toEqual(["crm__clienti", "near_tool"]);
	});

	describe("tool_search", () => {
		const connectors = [
			{ ...tool("crm__clienti", []), description: "[CRM] I clienti del CRM: elenco e contatti. Altro testo che non va nell'elenco.", deferred: true as const },
			{ ...tool("notion__pagine", []), description: "[Notion] Le pagine di Notion, cercate per titolo.\nSeconda riga.", deferred: true as const },
		];
		const search = toolSearch(connectors);
		const run = async (query: string, limit?: number, live: readonly OwniTool[] = connectors) => {
			const api = { agent: async () => ({ deferred: live }) };
			return search.execute({ query, ...(limit === undefined ? {} : { limit }) }, api as never, {} as never);
		};

		it("lists each deferred tool with its first sentence, whole", () => {
			expect(search.description).toContain("- crm__clienti: [CRM] I clienti del CRM: elenco e contatti\n");
			expect(search.description).not.toContain("Altro testo");
			expect(search.description).toContain("- notion__pagine: [Notion] Le pagine di Notion, cercate per titolo");
			expect(search.description).not.toContain("Seconda riga");
		});

		it("loads only the tools named, once each", async () => {
			const result = await run("crm__clienti, crm__clienti");
			expect(result.control).toEqual({ addTools: ["crm__clienti"] });
		});

		it("a name already loaded is reported, not searched again", async () => {
			const result = await run("crm__clienti", undefined, [connectors[1]!]);
			expect(result.control).toBeUndefined();
			expect(JSON.stringify(result.output)).toContain("Già caricati: crm__clienti");
		});

		it("a mix of loaded and unloaded names loads only the unloaded, without BM25", async () => {
			const result = await run("crm__clienti notion__pagine", undefined, [connectors[1]!]);
			expect(result.control).toEqual({ addTools: ["notion__pagine"] });
			expect(JSON.stringify(result.output)).toContain("Già caricati: crm__clienti");
		});

		it("loads more than three exact names, limit ignored", async () => {
			const many = ["a", "b", "c", "d", "e"].map((name) => ({ ...tool(name, []), description: `Strumento ${name}.`, deferred: true as const }));
			const manySearch = toolSearch(many);
			const result = await manySearch.execute({ query: "a b c d e" }, { agent: async () => ({ deferred: many }) } as never, {} as never);
			expect(result.control).toEqual({ addTools: ["a", "b", "c", "d", "e"] });
		});

		it("falls back to the free-text search for anything else", async () => {
			const result = await run("pagine Notion titolo");
			expect(result.control).toEqual({ addTools: ["notion__pagine"] });
			expect((await run("zzzz")).control).toBeUndefined();
		});
	});

	it("Owni without connectors defers nothing, so the model gets no tool_search; no description has an em-dash", async () => {
		const tools = new Map<string, OwniTool>();
		const engine: DurableEngine = {
			open: (options) => {
				for (const t of options.tools) tools.set(t.name, t);
				return piDurableEngine.open(options);
			},
		};
		const config = loadOwniConfig({ OWNI_DATA_DIR: mkdtempSync(join(tmpdir(), "owni-deferred-")), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1", OWNI_GOOGLE_CLIENT_ID: "id", OWNI_GOOGLE_CLIENT_SECRET: "secret", OWNI_GOOGLE_WRITE: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { engine, schedulerIntervalMs: 3_600_000, log: () => {} });
		await owni.stop();
		expect(tools.size).toBeGreaterThan(10);
		expect([...tools.values()].filter((t) => t.deferred === true)).toEqual([]);
		for (const t of tools.values()) expect(t.description, t.name).not.toContain("\u2014");
		expect(toolSearch([tool("crm__clienti", [], true)]).description).not.toContain("\u2014");
	});
});
