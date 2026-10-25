/**
 * Just enough of an MCP client for Cua's daemon (ADR 0045): JSON-RPC 2.0 over Streamable HTTP,
 * with `initialize` first, the session id the server mints echoed on every later request, the
 * tool list asked once, tool calls with a time limit. Replies are JSON; an event stream is read
 * too, for servers that answer that way. Connectors keep the full SDK (src/connectors/mcp.ts):
 * here a few requests to a daemon Owni starts herself need no transport of their own.
 */

export type McpContent = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string } | { readonly type: string; readonly [field: string]: unknown };

export type McpToolResult = {
	readonly content: readonly McpContent[];
	readonly structuredContent?: Readonly<Record<string, unknown>>;
	/** The tool ran and failed (an app not found): its content says why. */
	readonly isError: boolean;
};

export type McpHttpClientOptions = {
	/** The MCP endpoint, e.g. http://172.18.0.2:3211/mcp. */
	readonly url: string;
	/** Sent as a bearer token. */
	readonly token?: string;
	readonly fetch?: typeof fetch;
	/** Per request (default 60 s). */
	readonly timeoutMs?: number;
};

/** A JSON-RPC error from the server: a method or tool it does not know, bad arguments. */
export class McpError extends Error {
	override readonly name = "McpError";
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** The server no longer knows the session (it restarted): a new one is opened. */
class SessionExpired extends Error {}

const PROTOCOL_VERSION = "2025-06-18";
/** A screenshot is a few MB of base64 at most. */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;

export class McpHttpClient {
	private readonly fetch: typeof fetch;
	private session: string | undefined;
	private protocol: string | undefined;
	private ready: Promise<void> | undefined;
	private toolNames: Promise<readonly string[]> | undefined;
	private nextId = 1;

	constructor(private readonly options: McpHttpClientOptions) {
		this.fetch = options.fetch ?? fetch;
	}

	/** The names of the server's tools, asked once. */
	listTools(signal?: AbortSignal): Promise<readonly string[]> {
		this.toolNames ??= this.allTools(signal).catch((error: unknown) => {
			this.toolNames = undefined;
			throw error;
		});
		return this.toolNames;
	}

	async callTool(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpToolResult> {
		const result = (await this.request("tools/call", { name, arguments: args }, signal)) as { content?: unknown; structuredContent?: unknown; isError?: unknown } | undefined;
		const content = Array.isArray(result?.content) ? (result.content.filter((c) => typeof c === "object" && c !== null && typeof (c as { type?: unknown }).type === "string") as McpContent[]) : [];
		const structured = result?.structuredContent;
		return { content, ...(typeof structured === "object" && structured !== null && !Array.isArray(structured) ? { structuredContent: structured as Record<string, unknown> } : {}), isError: result?.isError === true };
	}

	/** Forget the session and the tool list: the next call opens a new one. */
	reset(): void {
		this.session = undefined;
		this.protocol = undefined;
		this.ready = undefined;
		this.toolNames = undefined;
	}

	private async allTools(signal?: AbortSignal): Promise<readonly string[]> {
		const names: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			const result = (await this.request("tools/list", cursor === undefined ? {} : { cursor }, signal)) as { tools?: { name?: unknown }[]; nextCursor?: unknown } | undefined;
			for (const tool of result?.tools ?? []) if (typeof tool.name === "string") names.push(tool.name);
			if (typeof result?.nextCursor !== "string" || result.nextCursor === "") break;
			cursor = result.nextCursor;
		}
		return names;
	}

	/** A request in an open session; a session the server forgot is opened again, once. */
	private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		await this.initialized(signal);
		try {
			return await this.rpc(method, params, signal);
		} catch (error) {
			if (!(error instanceof SessionExpired)) throw error;
			this.reset();
			await this.initialized(signal);
			return this.rpc(method, params, signal);
		}
	}

	private initialized(signal?: AbortSignal): Promise<void> {
		this.ready ??= (async () => {
			const result = (await this.rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "owni", version: "1" } }, signal)) as { protocolVersion?: unknown } | undefined;
			this.protocol = typeof result?.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
			const response = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
			await response.body?.cancel();
			if (!response.ok) throw new Error(`MCP notifications/initialized: HTTP ${response.status}`);
		})().catch((error: unknown) => {
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	private async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
		if (response.status === 404 && this.session !== undefined && method !== "initialize") {
			await response.body?.cancel();
			throw new SessionExpired();
		}
		const text = await readCapped(response);
		if (!response.ok) throw new Error(`MCP ${method}: HTTP ${response.status}`);
		if (method === "initialize") this.session = response.headers.get("mcp-session-id") ?? undefined;
		const message = (response.headers.get("content-type") ?? "").includes("text/event-stream") ? fromEventStream(text, id) : parse(text);
		if (typeof message !== "object" || message === null) throw new Error(`MCP ${method}: unreadable reply`);
		const { error, result } = message as { error?: { code?: unknown; message?: unknown }; result?: unknown };
		if (error !== undefined) throw new McpError(typeof error.code === "number" ? error.code : -32603, String(error.message ?? "error").slice(0, 300));
		return result;
	}

	private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
		const timeoutMs = this.options.timeoutMs ?? 60_000;
		const timeout = AbortSignal.timeout(timeoutMs);
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
		if (this.options.token !== undefined) headers.authorization = `Bearer ${this.options.token}`;
		if (this.session !== undefined) headers["mcp-session-id"] = this.session;
		if (this.protocol !== undefined) headers["mcp-protocol-version"] = this.protocol;
		try {
			return await this.fetch(this.options.url, { method: "POST", headers, body: JSON.stringify(body), signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), redirect: "error" });
		} catch (error) {
			if (timeout.aborted && signal?.aborted !== true) throw new Error(`MCP: no answer in ${timeoutMs / 1000} s`);
			throw error;
		}
	}
}

async function readCapped(response: Response): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_REPLY_BYTES) {
			await reader.cancel();
			throw new Error(`MCP: reply over ${MAX_REPLY_BYTES / 1024 / 1024} MB`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The JSON-RPC response with this id among the events of a stream (`data:` lines, blank line between events). */
function fromEventStream(text: string, id: number): unknown {
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		const message = parse(data) as { id?: unknown } | undefined;
		if (message?.id === id) return message;
	}
	return undefined;
}
