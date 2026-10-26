import { MODEL_PROVIDERS, modelProvider, subscriptionProvider } from "../core/model-providers.ts";
import { LocalProviderError } from "../core/local-providers.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { ChatModels } from "../core/chat-models.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { modelApiKeySecret } from "../core/secrets.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type ModelRoutesDeps = Pick<WebAppOptions, "models"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly chats: ChatModels;
	readonly knownInstance: (id: string) => Promise<InstanceRecord>;
};

/** The owner's providers, keys and each instance's model (ADR 0032). */
export function modelRoutes(route: AddRoute, options: ModelRoutesDeps): void {
	const { runtime, tenantId, chats, knownInstance } = options;
	// --- the model (ADR 0032): any provider Owni offers, with the server's key or the owner's ---
	const keyOf = (provider: string) => chats.keyOf(provider);
	const localProviders = runtime.localProviders(tenantId);
	const providerStatus = async () => ({
		localEnabled: localProviders !== undefined,
		providers: [...(localProviders?.list() ?? []), ...(await Promise.all(MODEL_PROVIDERS.map(async (p) => ({ ...p, kind: "api-key", key: await keyOf(p.id) }))))],
	});
	route("GET", "/api/providers", "owner", providerStatus);
	route("POST", "/api/providers/detect", "owner", async () => {
		if (localProviders !== undefined) await localProviders.detect();
		return providerStatus();
	});
	route("POST", "/api/providers/:provider/connect", "owner", async ({ params }) => {
		const id = params[0];
		if (localProviders === undefined || subscriptionProvider(id) === undefined) throw new HttpError(404, "Provider locale non disponibile");
		try { return { provider: await localProviders.connect(id) }; }
		catch (error) { if (error instanceof LocalProviderError) throw new HttpError(409, error.message); throw error; }
	});
	route("DELETE", "/api/providers/:provider", "owner", async ({ params }) => {
		const id = params[0];
		if (localProviders === undefined || subscriptionProvider(id) === undefined) throw new HttpError(404, "Provider locale non disponibile");
		const users = (await runtime.registry.listInstances(tenantId)).filter((r) => r.model.provider === id);
		if (users.length > 0) throw new HttpError(409, `Lo usa ${users.map((r) => r.name).join(", ")}: prima scegli un altro modello`);
		localProviders.disconnect(id);
		return { removed: true };
	});
	const offeredModels = (provider: string) => {
		if (modelProvider(provider) === undefined || options.models === undefined || (subscriptionProvider(provider) !== undefined && localProviders === undefined)) throw new HttpError(404, "Provider non disponibile");
		return options.models(provider);
	};
	route("GET", "/api/instances/:id/model", "owner", async ({ params }) => {
		const record = await knownInstance(params[0]);
		return { model: record.model, providers: [...(localProviders?.list() ?? []), ...(await Promise.all(MODEL_PROVIDERS.map(async (p) => ({ ...p, key: await keyOf(p.id) }))))] };
	});
	route("GET", "/api/models/:provider", "owner", async ({ params }) => ({ models: offeredModels(params[0]) }));
	route("PUT", "/api/instances/:id/model", "owner", async ({ params, req }) => {
		const id = params[0];
		await knownInstance(id);
		const body = (await readJson(req)) as { provider?: unknown; modelId?: unknown; apiKey?: unknown };
		const provider = typeof body.provider === "string" ? modelProvider(body.provider) : undefined;
		if (provider === undefined || (subscriptionProvider(provider.id) !== undefined && localProviders === undefined)) throw new HttpError(400, "Scegli un provider dall'elenco");
		const modelId = typeof body.modelId === "string" ? body.modelId : "";
		if (!offeredModels(provider.id).some((m) => m.id === modelId)) throw new HttpError(400, `${provider.label} non ha il modello «${modelId}»`);
		const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		const key = await keyOf(provider.id);
		if (subscriptionProvider(provider.id) !== undefined) {
			if (apiKey !== "") throw new HttpError(400, "Questo provider usa il tuo abbonamento, senza chiave API");
			if (key !== "local") throw new HttpError(409, "Collega prima il tuo abbonamento nelle impostazioni Provider");
		} else if (apiKey !== "") {
			if (key === "server") throw new HttpError(400, `La chiave di ${provider.label} la mette il server: non serve la tua`);
			if (!/^\S{8,500}$/.test(apiKey)) throw new HttpError(400, "La chiave non sembra giusta: incollala intera, senza spazi");
			await runtime.secrets(tenantId).set(modelApiKeySecret(provider.id), apiKey);
			// A key is the whole account's, not this instance's.
			await runtime.audit(tenantId).append({ type: "secret.set", name: modelApiKeySecret(provider.id) });
		} else if (key === "missing") {
			throw new HttpError(400, `Serve la chiave di ${provider.label}`);
		}
		const record = await runtime.registry.setModel(tenantId, id, { provider: provider.id, modelId });
		await runtime.reopen(tenantId, id);
		return { model: record.model };
	});
	route("DELETE", "/api/model-keys/:provider", "owner", async ({ params }) => {
		const provider = modelProvider(params[0]);
		const key = provider === undefined ? "missing" : await keyOf(provider.id);
		if (provider === undefined || key === "missing") throw new HttpError(404, "Nessuna chiave salvata per questo provider");
		if (key === "server") throw new HttpError(409, `La chiave di ${provider.label} è del server: la toglie chi lo gestisce`);
		const users = (await runtime.registry.listInstances(tenantId)).filter((r) => r.model.provider === provider.id);
		if (users.length > 0) throw new HttpError(409, `La usa ${users.map((r) => r.name).join(", ")}: prima scegli un altro modello`);
		await runtime.secrets(tenantId).delete(modelApiKeySecret(provider.id));
		await runtime.audit(tenantId).append({ type: "secret.deleted", name: modelApiKeySecret(provider.id) });
		return { removed: true };
	});
}
