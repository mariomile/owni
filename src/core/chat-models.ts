import { DEV_MODEL_ID, DEV_PROVIDER, MODEL_PROVIDERS, SUBSCRIPTION_PROVIDERS, subscriptionProvider, type ModelInfo } from "./model-providers.ts";
import type { InstanceRecord, ModelSelection } from "./registry.ts";
import type { OwniRuntime } from "./runtime.ts";
import { modelApiKeySecret } from "./secrets.ts";

/** A provider a person may give one of their chats; `allowed`: the instance already uses it. */
export type ChatProvider = { readonly id: string; readonly label: string; readonly defaultModel: string; readonly allowed: boolean };

/** A model with its name, so a channel shows it without the provider's catalog. */
export type NamedModel = ModelSelection & { readonly name: string };

/** A checked choice, ready for `give`. */
export type ChatModelChoice = ModelSelection & { readonly allowed: boolean };

/** The choice is not one this person may give a chat; the message says why, for them to read. */
export class ChatModelRefused extends Error {
	override readonly name = "ChatModelRefused";
}

/**
 * Which models a person may give one of their chats (ADR 0036), the same on every channel:
 * the providers with a key that the instance may use; the owner also the ones with a key it
 * does not use yet, which their choice allows. A member never widens what the instance reaches.
 */
export class ChatModels {
	constructor(
		private readonly runtime: OwniRuntime,
		private readonly tenant: string,
		private readonly catalog: {
			/** The models of a provider Owni offers. */
			readonly models: (provider: string) => readonly ModelInfo[];
			/** Providers whose key the operator gave the server. */
			readonly serverModelKeys: readonly string[];
		},
	) {}

	async keyOf(provider: string): Promise<"server" | "saved" | "missing" | "local"> {
		if (subscriptionProvider(provider) !== undefined) return this.runtime.localProviders(this.tenant)?.connected(provider) ? "local" : "missing";
		if (this.catalog.serverModelKeys.includes(provider)) return "server";
		return (await this.runtime.secrets(this.tenant).get(modelApiKeySecret(provider))) === undefined ? "missing" : "saved";
	}

	async providers(record: InstanceRecord, owner: boolean): Promise<ChatProvider[]> {
		const allowed = (id: string) => record.egress.modelProviders.includes(id);
		const keyed: ChatProvider[] = [];
		for (const p of [...MODEL_PROVIDERS, ...SUBSCRIPTION_PROVIDERS]) if ((allowed(p.id) || owner) && (await this.keyOf(p.id)) !== "missing") keyed.push({ id: p.id, label: p.label, defaultModel: p.defaultModel, allowed: allowed(p.id) });
		// The local model only while the instance itself runs on it (a development setup).
		return record.model.provider === DEV_PROVIDER ? [...keyed, { id: DEV_PROVIDER, label: "Modello di prova", defaultModel: DEV_MODEL_ID, allowed: true }] : keyed;
	}

	/** The models of a provider; none for one the catalog does not know. */
	models(provider: string): readonly ModelInfo[] {
		try {
			return this.catalog.models(provider);
		} catch {
			return [];
		}
	}

	named(model: ModelSelection): NamedModel {
		const name = this.models(model.provider).find((m) => m.id === model.modelId)?.name;
		return { provider: model.provider, modelId: model.modelId, name: name ?? model.modelId };
	}

	/** Check `{provider, modelId}` against what this person may give a chat. */
	async choice(record: InstanceRecord, owner: boolean, model: ModelSelection): Promise<ChatModelChoice> {
		const provider = (await this.providers(record, owner)).find((p) => p.id === model.provider);
		if (provider === undefined) throw new ChatModelRefused("Per questo provider non c'è una chiave che la chat possa usare");
		if (!this.models(provider.id).some((m) => m.id === model.modelId)) throw new ChatModelRefused(`${provider.label} non ha il modello «${model.modelId}»`);
		return { provider: provider.id, modelId: model.modelId, allowed: provider.allowed };
	}

	/**
	 * Give a chat its model (undefined: the instance's again). An owner's choice of a provider the
	 * instance does not use yet allows it. Rejects with EgressDenied when the provider stopped
	 * being reachable since the check.
	 */
	async give(record: InstanceRecord, chat: { readonly channel: string; readonly threadId: string }, choice: ChatModelChoice | undefined, by: string): Promise<NamedModel | undefined> {
		if (choice !== undefined && !choice.allowed) await this.runtime.registry.allowModelProvider(this.tenant, record.id, choice.provider);
		const model = choice === undefined ? undefined : { provider: choice.provider, modelId: choice.modelId };
		await this.runtime.setChatModel(this.tenant, record.id, chat, model, by);
		return model === undefined ? undefined : this.named(model);
	}
}
