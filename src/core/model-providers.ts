/**
 * The model providers Owni offers: any of them can run an instance (ADR 0032). An entry is
 * a product choice; the adapter supplies the models each provider has. The IDs are pi-ai's.
 */
export type ModelProvider = {
	readonly id: string;
	readonly label: string;
	/** The environment variable through which the operator gives the server this provider's key. */
	readonly keyEnv: string;
	/** Used when the operator names the provider and no model (OWNI_MODEL_ID). */
	readonly defaultModel: string;
};

/** One model a provider has, as the console shows it. Prices in USD per million tokens. */
export type ModelInfo = {
	readonly id: string;
	readonly name: string;
	/** It looks at pictures (photos, scanned pages, the screen of the computer). */
	readonly images: boolean;
	/** It thinks before answering. */
	readonly reasoning: boolean;
	readonly contextWindow: number;
	readonly inputUsd: number;
	readonly outputUsd: number;
};

/** The local, deterministic development model: no key, no network. */
export const DEV_PROVIDER = "faux";
export const DEV_MODEL_ID = "owni-dev";

export type SubscriptionProvider = {
	readonly id: "claude-code" | "codex";
	readonly label: string;
	readonly kind: "subscription";
	readonly keyEnv?: never;
	readonly defaultModel: string;
	readonly loginCommand: string;
};

/** Available only in the explicitly enabled, single-tenant local app. */
export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = [
	{ id: "claude-code", label: "Claude Code", kind: "subscription", defaultModel: "sonnet", loginCommand: "claude auth login" },
	{ id: "codex", label: "Codex", kind: "subscription", defaultModel: "default", loginCommand: "codex login" },
];

export function subscriptionProvider(id: string): SubscriptionProvider | undefined {
	return SUBSCRIPTION_PROVIDERS.find((p) => p.id === id);
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
	{ id: "anthropic", label: "Anthropic (Claude)", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-5-5" },
	{ id: "openai", label: "OpenAI (GPT)", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.5" },
	{ id: "google", label: "Google (Gemini)", keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-3.5-flash" },
	{ id: "xai", label: "xAI (Grok)", keyEnv: "XAI_API_KEY", defaultModel: "grok-4.7" },
	{ id: "mistral", label: "Mistral", keyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-large-latest" },
	{ id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-pro" },
	{ id: "moonshotai", label: "Moonshot (Kimi)", keyEnv: "MOONSHOT_API_KEY", defaultModel: "kimi-k3" },
	{ id: "zai", label: "Z.AI (GLM)", keyEnv: "ZAI_API_KEY", defaultModel: "glm-5.3" },
	{ id: "minimax", label: "MiniMax", keyEnv: "MINIMAX_API_KEY", defaultModel: "MiniMax-M3" },
	{ id: "meta", label: "Meta (Muse)", keyEnv: "META_API_KEY", defaultModel: "muse-spark-1.3" },
	{ id: "openrouter", label: "OpenRouter (tutti i modelli)", keyEnv: "OPENROUTER_API_KEY", defaultModel: "~anthropic/claude-sonnet-latest" },
	{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", keyEnv: "AI_GATEWAY_API_KEY", defaultModel: "anthropic/claude-sonnet-5.5" },
	{ id: "groq", label: "Groq", keyEnv: "GROQ_API_KEY", defaultModel: "openai/gpt-oss-120b" },
	{ id: "cerebras", label: "Cerebras", keyEnv: "CEREBRAS_API_KEY", defaultModel: "gpt-oss-120b" },
	{ id: "together", label: "Together AI", keyEnv: "TOGETHER_API_KEY", defaultModel: "moonshotai/Kimi-K3" },
	{ id: "fireworks", label: "Fireworks", keyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/kimi-k3" },
	{ id: "huggingface", label: "Hugging Face", keyEnv: "HF_TOKEN", defaultModel: "moonshotai/Kimi-K3" },
	{ id: "nvidia", label: "NVIDIA", keyEnv: "NVIDIA_API_KEY", defaultModel: "nvidia/nemotron-3-ultra-550b-a55b" },
];

export function modelProvider(id: string): ModelProvider | SubscriptionProvider | undefined {
	return MODEL_PROVIDERS.find((p) => p.id === id) ?? subscriptionProvider(id);
}

/** Every value OWNI_MODEL_PROVIDER takes: the offered providers, then the local model. */
export function providerIds(): string[] {
	return [...MODEL_PROVIDERS.map((p) => p.id), ...SUBSCRIPTION_PROVIDERS.map((p) => p.id), DEV_PROVIDER];
}
