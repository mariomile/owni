/**
 * ModelClient on pi-ai, for one-shot calls. Part of the Pi adapter: same rules as the
 * engine, the tenant's keys only (no env vars, no credential files) and only providers the
 * caller allows.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import type { CompletionRequest, CompletionResult, ModelClient } from "../completion.ts";
import { createProvider } from "./pi-durable-models.ts";
import type { LocalProviders } from "../local-providers.ts";
import { subscriptionProvider } from "../model-providers.ts";

export type PiCompletionOptions = {
	/** The only source of model credentials (the tenant's secret store). */
	readonly apiKey: (provider: string) => Promise<string | undefined>;
	/** Throws if the provider is not allowed (the instance's egress policy). */
	readonly assertAllowed: (provider: string) => void | Promise<void>;
	/** For tests: build the provider (default: the adapter's own providers). */
	readonly createProvider?: typeof createProvider;
	readonly localProviders?: LocalProviders;
};

export function createPiCompletionClient(options: PiCompletionOptions): ModelClient {
	const byProvider = new Map<string, MutableModels>();
	const modelsFor = (providerId: string): MutableModels => {
		let models = byProvider.get(providerId);
		if (models === undefined) {
			models = createModels({
				credentials: {
					async read(id) {
						if (subscriptionProvider(id) !== undefined) return options.localProviders?.connected(id) ? { type: "api_key", key: "owni-local-subscription" } : undefined;
						const key = await options.apiKey(id);
						return key === undefined ? undefined : { type: "api_key", key };
					},
					async list() {
						return [];
					},
					async modify() {
						throw new Error("Owni credentials are read-only; manage them in the tenant secret store");
					},
					async delete() {
						throw new Error("Owni credentials are read-only; manage them in the tenant secret store");
					},
				},
				authContext: { env: async () => undefined, fileExists: async () => false },
			});
			models.setProvider((options.createProvider ?? createProvider)(providerId, options.localProviders));
			byProvider.set(providerId, models);
		}
		return models;
	};

	return {
		async complete(request: CompletionRequest): Promise<CompletionResult> {
			await options.assertAllowed(request.model.provider);
			const models = modelsFor(request.model.provider);
			const model = models.getModel(request.model.provider, request.model.modelId);
			if (model === undefined) throw new Error(`Unknown model ${request.model.provider}/${request.model.modelId}`);
			const message: AssistantMessage = await models.complete(
				model,
				{ systemPrompt: request.system, messages: [{ role: "user", content: request.user, timestamp: Date.now() }] },
				{ maxTokens: request.maxTokens, ...(request.signal === undefined ? {} : { signal: request.signal }) },
			);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(`Model ${request.model.provider}/${request.model.modelId} failed: ${message.errorMessage ?? message.stopReason}`);
			}
			const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			return {
				text,
				inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
				outputTokens: message.usage.output,
				...(message.usage.cost.total > 0 ? { costUsd: message.usage.cost.total } : {}),
			};
		},
	};
}
