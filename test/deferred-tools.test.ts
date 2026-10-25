/**
 * Deferred tools (ADR 0100): a tool marked deferred is not offered to the model until it loads it
 * with tool_search; once loaded it stays for the conversation.
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
		description: `The ${name} register.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		replaySafe: true,
		deferred,
		async execute() {
			calls.push(name);
			return `${name} ok`;
		},
	};
}

describe("deferred tools (ADR 0100)", () => {
	it("a deferred tool runs only after tool_search loads it by name, alone, and stays loaded in the conversation", async () => {
		const calls: string[] = [];
		const { runtime, replies } = await runtimeWithInstance({ tools: [tool("near_tool", calls), tool("fatture_registro", calls, true), tool("fatture_archivio", calls, true)] });
		const say = async (text: string, messageId: string, count: number) => {
			await runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "u", text, messageId });
			await waitFor(() => replies.length === count);
		};
		await say("/tool fatture_registro {}", "1", 1);
		expect(calls).toEqual([]);
		await say('/tool tool_search {"query":"fatture_registro"}', "2", 2);
		await say("/tool fatture_registro {}", "3", 3);
		await say("/tool near_tool {}", "4", 4);
		// The exact name loaded that tool only, not its neighbours.
		await say("/tool fatture_archivio {}", "5", 5);
		await runtime.close();
		expect(calls).toEqual(["fatture_registro", "near_tool"]);
	});

	describe("tool_search", () => {
		const registers = [
			{ ...tool("fatture_registro", []), description: "Le fatture da pagare o incassare: elenco e scadenze. Altro testo che non va nell'elenco.", deferred: true as const },
			{ ...tool("magazzino_giacenze", []), description: "Il magazzino, quante unità restano di un articolo.\nSeconda riga.", deferred: true as const },
		];
		const search = toolSearch(registers);
		const run = async (query: string, limit?: number, live: readonly OwniTool[] = registers) => {
			const api = { agent: async () => ({ deferred: live }) };
			return search.execute({ query, ...(limit === undefined ? {} : { limit }) }, api as never, {} as never);
		};

		it("lists each deferred tool with its first sentence, whole", () => {
			expect(search.description).toContain("- fatture_registro: Le fatture da pagare o incassare\n");
			expect(search.description).not.toContain("elenco e scadenze");
			expect(search.description).toContain("- magazzino_giacenze: Il magazzino, quante unità restano di un articolo");
			expect(search.description).not.toContain("Seconda riga");
		});

		it("loads only the tools named, once each", async () => {
			const result = await run("fatture_registro, fatture_registro");
			expect(result.control).toEqual({ addTools: ["fatture_registro"] });
		});

		it("a name already loaded is reported, not searched again", async () => {
			const result = await run("fatture_registro", undefined, [registers[1]!]);
			expect(result.control).toBeUndefined();
			expect(JSON.stringify(result.output)).toContain("Già caricati: fatture_registro");
		});

		it("a mix of loaded and unloaded names loads only the unloaded, without BM25", async () => {
			const result = await run("fatture_registro magazzino_giacenze", undefined, [registers[1]!]);
			expect(result.control).toEqual({ addTools: ["magazzino_giacenze"] });
			expect(JSON.stringify(result.output)).toContain("Già caricati: fatture_registro");
		});

		it("loads more than three exact names, limit ignored", async () => {
			const many = ["a", "b", "c", "d", "e"].map((name) => ({ ...tool(name, []), description: `Registro ${name}.`, deferred: true as const }));
			const manySearch = toolSearch(many);
			const result = await manySearch.execute({ query: "a b c d e" }, { agent: async () => ({ deferred: many }) } as never, {} as never);
			expect(result.control).toEqual({ addTools: ["a", "b", "c", "d", "e"] });
		});

		it("falls back to the free-text search for anything else", async () => {
			const result = await run("magazzino unità articolo");
			expect(result.control).toEqual({ addTools: ["magazzino_giacenze"] });
			expect((await run("zzzz")).control).toBeUndefined();
		});
	});

	describe("the tools Owni really gets", () => {
		const realTools = async () => {
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
			return tools;
		};

		// What the model sees at the first request, before loading anything: the descriptions of the
		// eager tools and the tool_search listing. A rule that routes between tools must be there.
		it("the first request already carries the rules that route between tools", async () => {
			const tools = await realTools();
			const listing = toolSearch([...tools.values()].filter((t) => t.deferred === true)).description;
			const entry = (name: string) => listing.split("\n").find((line) => line.startsWith(`- ${name}: `)) ?? "";
			const eager = (name: string) => tools.get(name)?.description ?? "";
			const rules: [string, string, string[]][] = [
				// An always-visible tool sends to a register.
				[eager("schedule_create"), "schedule_create", ["recurring_invoices", "clients follow_up", "appointments reminders", "renewals"]],
				[eager("file_search"), "file_search", ["invoices, not this"]],
				[eager("image_view"), "image_view", ["expenses add"]],
				// The Google tools, present when Google is connected, send to the registers.
				[eager("google_mail_send"), "google_mail_send", ["quotes op send", "invoices op reminder"]],
				[eager("google_calendar_events"), "google_calendar_events", ["appointments agenda"]],
				[eager("google_calendar_create"), "google_calendar_create", ["fiscal_agenda export_ics"]],
				// A register sends to another register or to an eager tool.
				[entry("invoices"), "invoices", ["non file_search", "reminder", "bank_statement"]],
				[entry("quotes"), "quotes", ["price_list", "sales_invoices", "quotes con op send", "google_mail_send"]],
				[entry("expenses"), "expenses", ["renewals"]],
				[entry("timesheet"), "timesheet", ["to_quote", "sales_invoices"]],
				[entry("price_list"), "price_list", ["purchase_prices", "stock", "price_change"]],
				[entry("renewals"), "renewals", ["recurring_invoices", "schedule_create"]],
				[entry("cashflow"), "cashflow", ["renewals", "add_item"]],
				[entry("taxes"), "taxes", ["vat_settlement", "cashflow"]],
				[entry("vat_settlement"), "vat_settlement", ["taxes"]],
				[entry("bank_statement"), "bank_statement", ["invoices", "expenses", "renewals"]],
				[entry("clients"), "clients", ["clients follow_up, non schedule_create", "clients top", "suppliers"]],
				[entry("suppliers"), "suppliers", ["clients", "invoices"]],
				[entry("business_report"), "business_report", ["margins", "clients top", "budgets"]],
				[entry("budgets"), "budgets", ["business_report"]],
				[entry("purchase_prices"), "purchase_prices", ["price_list", "stock", "receive_invoice"]],
				[entry("margins"), "margins", ["price_list", "purchase_prices", "business_report", "price_change"]],
				[entry("stock"), "stock", ["receive_invoice", "orders suggest"]],
				[entry("orders"), "orders", ["stock", "received", "file_send"]],
				[entry("fiscal_agenda"), "fiscal_agenda", ["appointments", "schedule_create", "google_calendar_create", "fiscal_agenda export_ics"]],
				[entry("sales_invoices"), "sales_invoices", ["preventivo", "ore", "DDT", "appuntamenti", "recurring_invoices"]],
				[entry("ddt"), "ddt", ["magazzino", "credit_note", "sales_invoices"]],
				[entry("appointments"), "appointments", ["appointments reminders, non schedule_create", "fiscal_agenda", "settings", "sales_invoices", "appointments agenda", "google_calendar_events"]],
				[entry("staff"), "staff", ["appointments settings"]],
				[entry("recurring_invoices"), "recurring_invoices", ["schedule_create", "renewals", "sales_invoices"]],
			];
			for (const [text, name, needles] of rules) {
				expect(text, `${name} is offered`).not.toBe("");
				for (const needle of needles) expect(text, `${name} says ${needle}`).toContain(needle);
			}
		});

		it("every deferred tool is listed by name in the tool_search description, and no description has an em-dash", async () => {
			const tools = await realTools();
			const deferred = [...tools.values()].filter((t) => t.deferred === true);
			expect(deferred.length).toBeGreaterThan(20);
			const listing = toolSearch(deferred).description;
			for (const t of deferred) expect(listing, t.name).toContain(`- ${t.name}: `);
			for (const t of [...tools.values(), { name: "tool_search", description: listing }]) expect(t.description, t.name).not.toContain("\u2014");
		});
	});
});
