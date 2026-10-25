/**
 * Model providers the Pi Durable adapter can register. Part of the adapter: the only
 * other place, besides pi-durable.ts, that imports Pi packages.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { MEMORY_NOTE_MARKER } from "../memory.ts";
import { NOW_MARKER } from "../turn-context.ts";
import { DEV_MODEL_ID, DEV_PROVIDER, type ModelInfo, providerIds } from "../model-providers.ts";
import { subscriptionProvider } from "../model-providers.ts";
import type { LocalProviders } from "../local-providers.ts";
import { localCliProvider } from "./pi-durable-local-cli.ts";

/** pi-ai's factory for each provider Owni offers (MODEL_PROVIDERS), and the local model. */
const FACTORIES: Readonly<Record<string, () => Provider>> = {
	anthropic: anthropicProvider,
	openai: openaiProvider,
	google: googleProvider,
	xai: xaiProvider,
	mistral: mistralProvider,
	deepseek: deepseekProvider,
	moonshotai: moonshotaiProvider,
	zai: zaiProvider,
	minimax: minimaxProvider,
	meta: metaProvider,
	openrouter: openrouterProvider,
	"vercel-ai-gateway": vercelAIGatewayProvider,
	groq: groqProvider,
	cerebras: cerebrasProvider,
	together: togetherProvider,
	fireworks: fireworksProvider,
	huggingface: huggingfaceProvider,
	nvidia: nvidiaProvider,
	[DEV_PROVIDER]: createDevModel,
};

export function createProvider(id: string, localProviders?: LocalProviders): Provider {
	if (subscriptionProvider(id) !== undefined) return localCliProvider(id, localProviders);
	const factory = Object.hasOwn(FACTORIES, id) ? FACTORIES[id] : undefined;
	if (factory === undefined) throw new Error(`Unsupported model provider "${id}". Supported: ${providerIds().join(", ")}`);
	return factory();
}

const catalogs = new Map<string, readonly ModelInfo[]>();

/** The chat models of a provider, from pi-ai's catalog, as plain data. Built once per provider. */
export function providerModels(id: string): readonly ModelInfo[] {
	let models = catalogs.get(id);
	if (models === undefined) {
		models = createProvider(id)
			.getModels()
			.map((m) => ({ id: m.id, name: m.name, images: m.input.includes("image"), reasoning: m.reasoning, contextWindow: m.contextWindow, inputUsd: m.cost.input, outputUsd: m.cost.output }));
		catalogs.set(id, models);
	}
	return models;
}

/**
 * A local, deterministic model: no network, no key. Its answer depends only on the
 * transcript, so a new process after a crash continues exactly where the old one was.
 *
 * - "conta fino a N" / "count to N" → calls the slow_counter tool with n = N
 * - "/tool <name> <json args>" → calls that tool (for tests and development); also when it is
 *   the whole request of another agente's message (agent_message), so a test can drive both sides
 * - after a tool result → "Fatto. <tool output>", and "[N immagini]" when it shows pictures
 * - anything else → echoes the message, saying which pictures came with it
 */
function createDevModel(): Provider {
	const faux = fauxProvider({ provider: DEV_PROVIDER, models: [{ id: DEV_MODEL_ID, name: "Owni dev (deterministic)" }] });
	// Faux responses are consumed one per request; this step re-queues itself forever.
	const step = (context: { messages: Message[] }): AssistantMessage => {
		faux.appendResponses([step]);
		return respond(context.messages);
	};
	faux.setResponses([step]);
	return faux.provider;
}

function respond(messages: readonly Message[]): AssistantMessage {
	// Pi appends system entries (tool or instruction changes) after the person's message.
	const last = messages.filter((m) => m.role === "user" || m.role === "toolResult" || m.role === "assistant").at(-1);
	if (last?.role === "toolResult") {
		const output = last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const shown = last.content.filter((block) => block.type === "image").length;
		return fauxAssistantMessage(`Fatto. ${output}${shown === 0 ? "" : ` [${shown} ${shown === 1 ? "immagine" : "immagini"}]`}`);
	}
	const said = last?.role === "user" ? userText(last.content) : "";
	const text = personText(said);
	// Another agente's fenced request run as a /tool command: tests only (vitest sets NODE_ENV=test), never
	// on a server where the faux model is the default provider (OWNI_LOCAL_PROVIDERS=1).
	const asked = process.env.NODE_ENV === "test" ? /^\[Messaggio dall'agente [^\n]*\n<<<richiesta di \S+ ([0-9a-f]+)>>>\n([\s\S]*?)\n<<<fine richiesta di \S+ \1>>>/.exec(text)?.[2] : undefined;
	// A note the gateway adds after the person's words (a spoken reply, ADR 0020) is not part of a command.
	const direct = /^\/tool\s+([\w-]+)\s*([\s\S]*)$/.exec((asked ?? text.replace(/\n\n\[[^\]]*\]\s*$/, "")).trim());
	if (direct?.[1] !== undefined) {
		let args: Record<string, unknown> = {};
		try {
			args = direct[2] ? (JSON.parse(direct[2]) as Record<string, unknown>) : {};
		} catch {
			return fauxAssistantMessage(`Argomenti non validi per ${direct[1]}: serve JSON.`);
		}
		return fauxAssistantMessage(fauxToolCall(direct[1], args as never), { stopReason: "toolUse" });
	}
	const count = /(?:conta(?:re)? fino a|count to)\s+(\d+)/i.exec(text);
	if (count?.[1] !== undefined) {
		return fauxAssistantMessage(fauxToolCall("slow_counter", { n: Number(count[1]) }), { stopReason: "toolUse" });
	}
	// Pictures of earlier messages still in the request: old ones should have left it.
	const earlier = messages.filter((m) => m !== last && m.role !== "assistant" && typeof m.content !== "string" && m.content.some((c) => c.type === "image")).length;
	return fauxAssistantMessage(`Owni (modello locale di sviluppo): hai scritto «${text}${said.includes(MEMORY_NOTE_MARKER) ? said.slice(said.indexOf(MEMORY_NOTE_MARKER)) : ""}»${last?.role === "user" ? imagesSeen(last.content) : ""}${earlier === 0 ? "" : ` [${earlier} ${earlier === 1 ? "messaggio precedente" : "messaggi precedenti"} con immagini]`}`);
}

/** The pictures of a message as the model received them: how many, of which type and size. */
function imagesSeen(content: string | readonly { type: string; data?: string; mimeType?: string }[]): string {
	if (typeof content === "string") return "";
	const images = content.filter((block) => block.type === "image");
	if (images.length === 0) return "";
	const each = images.map((image) => `${image.mimeType}, ${Buffer.from(image.data ?? "", "base64").length} byte`);
	return ` e mandato ${images.length} ${images.length === 1 ? "immagine" : "immagini"} (${each.join("; ")})`;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
}

/** The person's words and the gateway's notes: the text up to the first note the core adds, the time and the memories (ADR 0097). */
function personText(text: string): string {
	const cuts = [NOW_MARKER, MEMORY_NOTE_MARKER].map((marker) => text.indexOf(marker)).filter((at) => at >= 0);
	return text.slice(0, Math.min(text.length, ...cuts));
}
