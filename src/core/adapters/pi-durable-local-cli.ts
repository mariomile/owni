/** Subscription inference through official CLIs; Owni alone executes requested tools. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, JsonObject, Model, StreamOptions, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { LocalProviderError, type LocalProviders } from "../local-providers.ts";
import { subscriptionProvider } from "../model-providers.ts";

const API = "owni-local-cli";
const ZERO_USAGE = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const MODELS: Readonly<Record<string, readonly { id: string; name: string }[]>> = {
	"claude-code": [{ id: "sonnet", name: "Claude Sonnet · abbonamento" }, { id: "opus", name: "Claude Opus · abbonamento" }, { id: "haiku", name: "Claude Haiku · abbonamento" }],
	codex: [{ id: "default", name: "Codex · modello del tuo piano" }, { id: "gpt-5.5", name: "GPT-5.5 · abbonamento" }, { id: "gpt-5.4", name: "GPT-5.4 · abbonamento" }],
};

/** Catalog creation never probes credentials. Without the capability it cannot infer. */
export function localCliProvider(id: string, local?: LocalProviders): Provider {
	const offered = subscriptionProvider(id);
	if (offered === undefined) throw new Error("Unknown local provider");
	const models: Model<typeof API>[] = (MODELS[id] ?? []).map((m) => ({ ...m, provider: id, api: API, baseUrl: "local://subscription", input: ["text", "image"], reasoning: true, contextWindow: 200_000, maxTokens: 16_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
	const stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
		const events = createAssistantMessageEventStream();
		const message: AssistantMessage = { role: "assistant", content: [], api: API, provider: id, model: model.id, usage: ZERO_USAGE(), stopReason: "stop", timestamp: Date.now() };
		void (async () => {
			let dir: string | undefined;
			try {
				if (local === undefined || !local.connected(id)) throw new LocalProviderError("Collega il tuo abbonamento nelle impostazioni Provider");
				if (!models.some((m) => m.id === model.id)) throw new LocalProviderError("Modello locale non disponibile");
				if (options?.signal?.aborted) throw new LocalProviderError("Operazione annullata");
				events.push({ type: "start", partial: message });
				dir = await mkdtemp(join(tmpdir(), "owni-model-"));
				const request = await cliRequest(id, model.id, context, dir);
				const result = await local.inference({ provider: id, ...request, cwd: dir, signal: options?.signal }).catch((error: unknown) => {
					throw inferenceFailure(failureDetails(error));
				});
				if (options?.signal?.aborted) throw new LocalProviderError("Operazione annullata");
				if (result.code !== 0) {
					const failure = failureEvents(result.stdout);
					failure.messages.push(result.stderr);
					throw inferenceFailure(failure);
				}
				const parsed = parseResponse(id, result.stdout, request.tools);
				if (parsed.text !== "") {
					message.content.push({ type: "text", text: "" });
					events.push({ type: "text_start", contentIndex: 0, partial: message });
					(message.content[0] as { type: "text"; text: string }).text = parsed.text;
					events.push({ type: "text_delta", contentIndex: 0, delta: parsed.text, partial: message });
					events.push({ type: "text_end", contentIndex: 0, content: parsed.text, partial: message });
				}
				for (const call of parsed.toolCalls) {
					const index = message.content.length;
					const toolCall = { type: "toolCall" as const, id: randomUUID(), name: call.name, arguments: call.arguments };
					message.content.push(toolCall);
					events.push({ type: "toolcall_start", contentIndex: index, partial: message });
					events.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
				}
				message.usage.input = parsed.inputTokens;
				message.usage.output = parsed.outputTokens;
				message.usage.totalTokens = parsed.inputTokens + parsed.outputTokens;
				message.stopReason = parsed.toolCalls.length === 0 ? "stop" : "toolUse";
			} catch (error) {
				message.stopReason = options?.signal?.aborted || (error instanceof InferenceFailure && error.aborted) ? "aborted" : "error";
				message.errorMessage = message.stopReason === "aborted" ? "Operazione annullata" : error instanceof LocalProviderError ? error.message : "Risposta del provider non valida. Riprova o aggiorna la CLI ufficiale.";
			} finally {
				if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
				if (message.stopReason === "error" || message.stopReason === "aborted") events.push({ type: "error", reason: message.stopReason, error: message });
				else events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				events.end(message);
			}
		})();
		return events;
	};
	return { id, name: offered.label,
		auth: { apiKey: { name: "Abbonamento locale", async resolve({ credential }) { return credential?.key === "owni-local-subscription" && local?.connected(id) ? { auth: { apiKey: "owni-local-subscription" }, source: "Abbonamento locale" } : undefined; } } },
		getModels: () => models, stream, streamSimple: stream,
	};
}

class InferenceFailure extends LocalProviderError {
	constructor(message: string, readonly aborted = false) { super(message); }
}

type FailureDetails = { messages: string[]; statuses: number[] };

/** Traverse only error fields: usage, timings, session IDs and other envelope metadata are not evidence. */
function failureDetails(value: unknown): FailureDetails {
	const details: FailureDetails = { messages: [], statuses: [] };
	const collect = (part: unknown, depth: number): void => {
		if (depth > 8) return;
		if (typeof part === "string") { details.messages.push(part); return; }
		if (Array.isArray(part)) { for (const entry of part) collect(entry, depth + 1); return; }
		if (typeof part !== "object" || part === null) return;
		const error = part as Record<string, unknown>;
		for (const key of ["status", "status_code", "statusCode", "http_status", "http_status_code", "httpStatus", "httpStatusCode"]) {
			const status = error[key];
			if ((typeof status === "number" || typeof status === "string") && /^[45]\d{2}$/.test(String(status))) details.statuses.push(Number(status));
		}
		for (const key of ["message", "type", "code", "name", "error", "errors", "result"]) collect(error[key], depth + 1);
	};
	collect(value, 0);
	return details;
}

/** Classify privately, then emit only fixed text and an allowlisted HTTP status, never CLI logs. */
function inferenceFailure(failure: FailureDetails): InferenceFailure {
	const details = failure.messages.join("\n");
	const statuses = [...failure.statuses, ...Array.from(details.matchAll(/\b(?:HTTP(?:\/\d(?:\.\d)?)?(?:\s+(?:status(?:\s+code)?|error))?|(?:response\s+)?status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/gi), (match) => Number(match[1]))];
	// A cancelled transport stream is retryable in Pi; only explicit abort/caller/operation cancellation is terminal.
	if (/\b(?:AbortError|aborted)\b|operazione annullata|\b(?:operation|request|user|caller)(?: (?:was|has been))? cancel(?:led|ed)\b|\bcancel(?:led|ed) by (?:the )?(?:user|caller)\b/i.test(details)) return new InferenceFailure("Operazione annullata", true);
	if (statuses.some((status) => status === 401 || status === 403) || /authentication[_ -]?(?:error|failed|required)|unauthori[sz]ed|forbidden|not logged in|login required|invalid[_ -](?:api[_ -])?(?:key|token)|permission[_ ]denied/i.test(details)) return new InferenceFailure("Autenticazione del provider non valida. Controlla l'accesso nelle impostazioni Provider.");
	if (/quota|billing|out of budget|available balance|usage[_ ]limit|usage_not_included|GoUsageLimitError|FreeUsageLimitError|hit (?:your|the) (?:usage )?limit/i.test(details)) return new InferenceFailure("Provider quota exceeded. Controlla i limiti del tuo piano nelle impostazioni Provider.");
	const candidate: AssistantMessage = { role: "assistant", content: [], api: API, provider: "local", model: "local", usage: ZERO_USAGE(), timestamp: 0, stopReason: "error", errorMessage: details };
	// Pi checks overflow before retries; use the installed matchers so the bridge agrees with the engine.
	if (isContextOverflow(candidate)) return new InferenceFailure("Context length exceeded. La conversazione supera il contesto del modello.");
	// Pi's retry matcher accepts bare numeric substrings. Supply only actual HTTP statuses, not request IDs or counts.
	candidate.errorMessage = `${details.replace(/\d{3,}/g, "[number]")}\n${statuses.map((status) => `HTTP ${status}`).join("\n")}`;
	if (isRetryableAssistantError(candidate) || /ECONNRESET|connection reset|non ha risposto in tempo/i.test(details)) {
		const status = statuses.find((value) => [429, 500, 502, 503, 504, 520, 524].includes(value));
		return new InferenceFailure(`Errore temporaneo del provider (server error${status === undefined ? "" : `, HTTP ${status}`}). Riprova.`);
	}
	return new InferenceFailure("Il provider ha rifiutato la richiesta. Controlla l'accesso e i limiti del tuo piano nelle impostazioni Provider.");
}

/** Nonzero exits may also contain a JSON failure; successful assistant text is never error evidence. */
function failureEvents(stdout: string): FailureDetails {
	const failures: FailureDetails = { messages: [], statuses: [] };
	for (const line of stdout.split("\n")) {
		try {
			const event = JSON.parse(line) as Record<string, unknown> | null;
			if (event !== null && (event.type === "error" || event.type === "turn.failed" || (event.type === "result" && (event.is_error === true || event.subtype !== "success")))) {
				const details = failureDetails(event);
				failures.messages.push(...details.messages);
				failures.statuses.push(...details.statuses);
			}
		} catch { /* A CLI can exit before emitting JSON; stderr remains available for classification. */ }
	}
	return failures;
}

const BRIDGE = "You are Owni's inference engine. The transcript below is the complete conversation, including system instructions, tool declarations, prior assistant tool calls and tool results. Continue it faithfully. Return only the requested JSON object. To use an Owni tool, return its name and JSON-encoded arguments in toolCalls; Owni executes it after its own authorization checks and sends its result in the next request. Never execute native CLI tools, commands, file operations, browser operations, or MCP tools. Use only the Owni tools declared in the transcript. A final user-facing answer goes in text with an empty toolCalls array. When requesting tools text may be empty. Images are attached in transcript order.";
function schema(names: string[]) {
	return { type: "object", additionalProperties: false, required: ["text", "toolCalls"], properties: { text: { type: "string" }, toolCalls: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["name", "arguments"], properties: { name: { type: "string", ...(names.length === 0 ? {} : { enum: names }) }, arguments: { type: "string", description: "A JSON object encoded as a string, matching the named Owni tool's parameters" } } } } } };
}
async function cliRequest(id: string, model: string, context: TranscriptContext, dir: string) {
	const tools = new Map<string, Tool>();
	const images: { type: "image"; source: { type: "base64"; media_type: string; data: string } }[] = [];
	const messages = context.messages.map((m) => {
		if (m.role === "system") {
			for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
			for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
			return { role: m.role, content: getSystemMessageText(m) };
		}
		const content = typeof m.content === "string" ? m.content : m.content.map((block) => {
			if (block.type === "image") {
				if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType) || block.data.length > 28_000_000) throw new LocalProviderError("Immagine non supportata dal provider locale");
				images.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
				return { image: images.length, mimeType: block.mimeType };
			}
			return block;
		});
		return { role: m.role, content, ...(m.role === "toolResult" ? { toolName: m.toolName, toolCallId: m.toolCallId, isError: m.isError } : {}) };
	});
	const prompt = JSON.stringify({ instructions: BRIDGE, messages, tools: [...tools.values()] });
	if (Buffer.byteLength(prompt) > 16_000_000 || images.length > 24) throw new LocalProviderError("Conversazione troppo grande per il provider locale");
	const outputSchema = schema([...tools.keys()]);
	if (id === "claude-code") return { tools,
		args: ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--json-schema", JSON.stringify(outputSchema), "--tools", "", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--permission-mode", "dontAsk", "--system-prompt", BRIDGE],
		input: `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }, ...images] } })}\n`,
	};
	const schemaPath = join(dir, "response.schema.json");
	await writeFile(schemaPath, JSON.stringify(outputSchema), { mode: 0o600 });
	// Model metadata is public catalog data, never credentials. Remove the native tools
	// at their model-catalog source, including apply_patch (which has no feature toggle).
	let cached: unknown;
	try { cached = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8")); } catch { cached = undefined; }
	const catalog = codexInferenceCatalog(model, cached);
	const catalogPath = join(dir, "models.json");
	await writeFile(catalogPath, JSON.stringify({ models: [catalog] }), { mode: 0o600 });
	const imageArgs: string[] = [];
	for (const [i, image] of images.entries()) {
		const path = join(dir, `image-${i}.${image.source.media_type.split("/")[1]}`);
		await writeFile(path, Buffer.from(image.source.data, "base64"), { mode: 0o600 });
		imageArgs.push("--image", path);
	}
	// Ignore user/project config while retaining official CLI-managed authentication.
	const config = [`model_catalog_json=${JSON.stringify(catalogPath)}`, 'model_provider="openai"', 'forced_login_method="chatgpt"', 'web_search="disabled"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false', 'features.apps=false', 'features.plugins=false', 'features.browser_use=false', 'features.computer_use=false', 'features.image_generation=false', 'features.view_image=false', 'features.hooks=false', 'features.memories=false', 'features.shell_snapshot=false', 'features.skill_mcp_dependency_install=false', 'features.tool_suggest=false', 'features.request_permissions_tool=false', 'features.send_message_to_user_async=false', 'features.current_time_reminder=false', 'features.sleep_tool=false', 'skills.include_instructions=false', 'skills.bundled.enabled=false', 'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false', 'project_doc_max_bytes=0', 'mcp_servers={}', 'developer_instructions=""', 'approval_policy="never"'];
	return { tools, args: ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", "--output-schema", schemaPath, "--model", catalog.slug, ...config.flatMap((entry) => ["-c", entry]), ...imageArgs, "-"], input: prompt };
}

/** Only model catalog fields survive; account identity, config, and credentials never do. */
export function codexInferenceCatalog(model: string, cache?: unknown): Record<string, unknown> & { slug: string } {
	const raw = typeof cache === "object" && cache !== null && "models" in cache && Array.isArray(cache.models) ? cache.models : [];
	const models = raw.filter((m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null && "slug" in m && typeof m.slug === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(m.slug));
	const cached = model === "default" ? models.filter((m) => m.visibility !== "hide").sort((a, b) => Number(a.priority ?? 100) - Number(b.priority ?? 100))[0] : models.find((m) => m.slug === model);
	const slug = typeof cached?.slug === "string" ? cached.slug : model === "default" ? "gpt-5.5" : model;
	return {
		slug, display_name: slug, description: "Owni subscription inference", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium", description: "Standard reasoning" }], visibility: "list", supported_in_api: true, priority: 0, support_verbosity: false, default_verbosity: null, truncation_policy: { mode: "bytes", limit: 10_000 }, context_window: 200_000,
		...(cached ?? {}),
		shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, tool_mode: "direct", include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false, supports_search_tool: false, supports_experimental_context: false, model_messages: { instructions_template: BRIDGE },
	};
}

function parseResponse(id: string, stdout: string, tools: ReadonlyMap<string, Tool>) {
	let response: unknown;
	let inputTokens = 0;
	let outputTokens = 0;
	if (id === "claude-code") {
		const result = stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>).findLast((entry) => entry.type === "result" || entry.subtype === "success");
		if (result === undefined) throw new Error("Missing Claude result");
		if (result.is_error === true || result.subtype !== "success") throw inferenceFailure(failureDetails(result));
		response = result.structured_output ?? (typeof result.result === "string" ? JSON.parse(result.result) : undefined);
		const usage = result.usage as Record<string, number> | undefined;
		inputTokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
		outputTokens = usage?.output_tokens ?? 0;
	} else {
		let finalText: string | undefined;
		for (const line of stdout.split("\n").filter((s) => s.trim() !== "")) {
			const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
			if (event.type === "error" || event.type === "turn.failed") throw inferenceFailure(failureDetails(event));
			if (event.item !== undefined && ["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(event.item.type ?? "")) throw new LocalProviderError("La CLI ha tentato uno strumento esterno a Owni. Aggiorna la CLI e riprova.");
			if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") finalText = event.item.text;
			if (event.usage !== undefined) { inputTokens = event.usage.input_tokens ?? 0; outputTokens = event.usage.output_tokens ?? 0; }
		}
		if (finalText !== undefined) response = JSON.parse(finalText);
	}
	if (typeof response !== "object" || response === null) throw new Error("Missing structured result");
	const result = response as { text?: unknown; toolCalls?: unknown };
	if (typeof result.text !== "string" || result.text.length > 1_000_000 || !Array.isArray(result.toolCalls) || result.toolCalls.length > 16) throw new Error("Invalid structured result");
	const toolCalls = result.toolCalls.map((call: unknown) => {
		if (typeof call !== "object" || call === null) throw new Error("Invalid tool call");
		const tool = call as { name?: unknown; arguments?: unknown };
		if (typeof tool.name !== "string" || !tools.has(tool.name) || typeof tool.arguments !== "string") throw new Error("Unknown tool call");
		const args = JSON.parse(tool.arguments) as unknown;
		if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Invalid tool arguments");
		const checked = validateToolArguments(tools.get(tool.name) as Tool, { type: "toolCall", id: "validate", name: tool.name, arguments: args as JsonObject }) as JsonObject;
		return { name: tool.name, arguments: checked };
	});
	if (result.text === "" && toolCalls.length === 0) throw new Error("Empty result");
	return { text: result.text, toolCalls, inputTokens, outputTokens };
}
