/**
 * A tiny MCP server for tests, with two tools: add (numbers) and whoami (echoes the
 * DEMO_TOKEN env var or the Authorization header it received). Run over stdio when started
 * as a process; createDemoServer() is also used in-process over HTTP.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** With `notes`, a third tool that writes (no read-only hint): create_note, recorded in the array. */
export function createDemoServer(identity: () => string, notes?: { text: string }[]): Server {
	const server = new Server({ name: "demo", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } },
			{ name: "whoami", description: "Who is calling", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
			...(notes === undefined
				? []
				: [{ name: "create_note", description: "Create a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { title: "Crea una nota", destructiveHint: false } }]),
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name === "add") {
			const { a, b } = request.params.arguments as { a: number; b: number };
			return { content: [{ type: "text", text: String(a + b) }] };
		}
		if (request.params.name === "whoami") return { content: [{ type: "text", text: identity() }] };
		if (request.params.name === "create_note" && notes !== undefined) {
			const { text } = request.params.arguments as { text: string };
			if (text === "fail") return { content: [{ type: "text", text: "note refused" }], isError: true };
			notes.push({ text });
			return { content: [{ type: "text", text: `note ${notes.length} created` }] };
		}
		return { content: [{ type: "text", text: "unknown tool" }], isError: true };
	});
	return server;
}

if (process.argv[2] === "stdio") {
	await createDemoServer(() => `env:${process.env.DEMO_TOKEN ?? "none"} leak:${process.env.OWNI_SHOULD_NOT_LEAK ?? "none"}`).connect(new StdioServerTransport());
}
