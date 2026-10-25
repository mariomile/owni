import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore, connectorEgressName, McpConnections, type McpConnector } from "../src/connectors/mcp.ts";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, type Reply } from "../src/core/index.ts";
import { createDemoServer } from "./fixtures/mcp-demo-server.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const servers: HttpServer[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((s) => {
			s.closeAllConnections();
			return new Promise((r) => s.close(r));
		}),
	);
});

/** The demo MCP server over Streamable HTTP on 127.0.0.1 (stateless: one transport per request). */
async function httpDemo(): Promise<string> {
	const http = createServer(async (req, res) => {
		const auth = String(req.headers.authorization ?? "none");
		const server = createDemoServer(() => `header:${auth}`);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => void transport.close());
		await server.connect(transport);
		await transport.handleRequest(req, res);
	});
	servers.push(http);
	await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
	return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

async function setup(connectors: McpConnector[], allowed: string[]) {
	const dataDir = tempDataDir();
	const connections = new Map<string, McpConnections>();
	const runtime: OwniRuntime = new OwniRuntime({
		dataDir,
		engine: piDurableEngine,
		tools: async (record) => {
			const c = new McpConnections({
				instanceId: record.id,
				secrets: runtime.secrets(record.tenantId),
				policy: async () => (await runtime.registry.getInstance(record.tenantId, record.id)).egress,
				audit: runtime.audit(record.tenantId),
			});
			connections.set(record.id, c);
			return { tools: await c.connect(connectors), close: () => c.close() };
		},
	});
	await runtime.registry.createTenant({ id: "acme", name: "acme" });
	await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"], connectors: allowed }, allowedUsers: { test: ["u"] } });
	const replies: Reply[] = [];
	runtime.onReply((r) => replies.push(r));
	const say = (text: string, id: string) => runtime.submit({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t", userId: "u", text, messageId: id });
	return { runtime, replies, say, connections, dataDir };
}
const text = (r: Reply | undefined) => (r?.status === "answered" ? r.text : "");

describe("MCP connectors", () => {
	it("an HTTP connector's tools reach the model, with its secret header from the secret store", async () => {
		const url = await httpDemo();
		const h = await setup([{ id: "demo", name: "Demo", transport: { type: "http", url, headerSecrets: { authorization: "connector.demo.auth" } }, enabled: true }], [connectorEgressName("demo")]);
		await h.runtime.secrets("acme").set("connector.demo.auth", "Bearer s3cret");
		await h.say('/tool demo__add {"a":2,"b":40}', "1");
		await waitFor(() => h.replies.length === 1);
		expect(text(h.replies[0])).toBe("Fatto. 42");
		await h.say("/tool demo__whoami {}", "2");
		await waitFor(() => h.replies.length === 2);
		expect(text(h.replies[1])).toBe("Fatto. header:Bearer s3cret");
		expect(h.connections.get("ops")?.status()).toEqual([{ id: "demo", connected: true, tools: ["demo__add", "demo__whoami"] }]);
		await h.runtime.close();
	});

	it("a stdio connector gets only the environment it names, never Owni's", async () => {
		process.env.OWNI_SHOULD_NOT_LEAK = "leak";
		const h = await setup(
			[{ id: "local", name: "Local", transport: { type: "stdio", command: join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"), args: [join(import.meta.dirname, "fixtures", "mcp-demo-server.ts"), "stdio"], envSecrets: { DEMO_TOKEN: "connector.local.token" } }, enabled: true }],
			[connectorEgressName("local")],
		);
		await h.runtime.secrets("acme").set("connector.local.token", "tok-1");
		await h.say("/tool local__whoami {}", "1");
		await waitFor(() => h.replies.length === 1, 20_000);
		// The SDK passes a fixed set of basics (HOME, PATH, USER, ...); nothing else of Owni's.
		expect(text(h.replies[0])).toBe("Fatto. env:tok-1 leak:none");
		await h.runtime.close();
	});

	it("a connector the egress policy does not list is never contacted, and a broken one is skipped", async () => {
		const url = await httpDemo();
		const h = await setup(
			[
				{ id: "demo", name: "Demo", transport: { type: "http", url }, enabled: true },
				{ id: "broken", name: "Broken", transport: { type: "http", url: "http://127.0.0.1:1/mcp" }, enabled: true },
			],
			[connectorEgressName("broken")],
		);
		await h.say('/tool demo__add {"a":1,"b":1}', "1");
		await waitFor(() => h.replies.length === 1);
		expect(text(h.replies[0])).toContain("Tool demo__add is not available");
		const status = h.connections.get("ops")?.status() ?? [];
		expect(status.map((s) => [s.id, s.connected])).toEqual([["demo", false], ["broken", false]]);
		expect(status[0]?.error).toContain("egress policy does not allow mcp:demo");
		const audit = await h.runtime.audit("acme").read();
		expect(audit).toContainEqual(expect.objectContaining({ type: "egress.denied", kind: "connector", target: "mcp:demo" }));
		expect(audit).toContainEqual(expect.objectContaining({ type: "connector.failed", connector: "broken" }));
		await h.runtime.close();
	});

	it("stores connectors without secrets and validates ids", async () => {
		const store = new ConnectorStore(tempDataDir());
		await store.save({ id: "crm", name: "CRM", transport: { type: "http", url: "https://mcp.example.com/mcp", headerSecrets: { authorization: "connector.crm.auth" } }, enabled: true });
		expect(await store.list()).toHaveLength(1);
		await expect(store.save({ id: "Bad Id", name: "x", transport: { type: "http", url: "https://x.example" }, enabled: true })).rejects.toThrow("Invalid connector id");
		expect(await store.remove("crm")).toBe(true);
		expect(await store.list()).toEqual([]);
	});
});
