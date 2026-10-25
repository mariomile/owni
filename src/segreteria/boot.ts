import { join } from "node:path";
import { TelegramAdapter } from "../channels/telegram.ts";
import { GMAIL_HOSTS, GMAIL_SECRETS, GmailMailAdapter } from "../connectors/gmail.ts";
import { egressFetch } from "../connectors/http.ts";
import { HUBSPOT_HOSTS, HUBSPOT_SECRET, HubSpotCrmAdapter } from "../connectors/hubspot.ts";
import { createPiCompletionClient } from "../core/adapters/pi-durable-completion.ts";
import { AuditLog } from "../core/audit.ts";
import { instanceId as toInstanceId, tenantId as toTenantId } from "../core/ids.ts";
import { InstanceLock } from "../core/lock.ts";
import { DEFAULT_MODEL_ROLES, FAUX_MODEL_ROLES } from "../core/model-routing.ts";
import { instanceDir, lockFile, tenantDir } from "../core/paths.ts";
import { assertModelProviderAllowed, type EgressPolicy } from "../core/policy.ts";
import { NotFound } from "../core/errors.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { modelApiKeySecret } from "../core/secrets.ts";
import { UsageLedger } from "../core/usage.ts";
import { loadChecks } from "./checks.ts";
import { SegreteriaService } from "./service.ts";

export type SegreteriaBootConfig = {
	readonly dataDir: string;
	readonly tenantId: string;
	readonly instanceId: string;
	readonly telegramBotToken: string;
	readonly modelProvider: "anthropic" | "faux";
	readonly anthropicApiKey: string | undefined;
	readonly gmail: { readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string };
	readonly hubspotAccessToken: string;
	readonly salesUserIds: readonly string[];
	readonly pollSeconds: number;
	readonly requireVatNumber: boolean;
};

export class SegreteriaConfigError extends Error {
	override readonly name = "SegreteriaConfigError";
}

export type RunningSegreteria = { readonly service: SegreteriaService; readonly instanceId: string; stop(): Promise<void> };

/**
 * Create (first start) or check the segreteria instance, store its credentials in the
 * tenant's secret store, take its lock and start polling the mailbox and Telegram.
 * An existing egress policy is the owner's: it is never widened here.
 */
export async function startSegreteria(runtime: OwniRuntime, config: SegreteriaBootConfig, log: (message: string) => void): Promise<RunningSegreteria> {
	const egress: EgressPolicy = { modelProviders: [config.modelProvider], channels: ["telegram"], connectors: ["gmail", "hubspot"] };
	const roles = config.modelProvider === "faux" ? FAUX_MODEL_ROLES : DEFAULT_MODEL_ROLES;
	try {
		await runtime.registry.getTenant(config.tenantId);
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createTenant({ id: config.tenantId, name: config.tenantId });
	}
	try {
		const instance = await runtime.registry.getInstance(config.tenantId, config.instanceId);
		const missing = [
			...egress.modelProviders.filter((p) => !instance.egress.modelProviders.includes(p)).map((p) => `model provider "${p}"`),
			...egress.channels.filter((c) => !instance.egress.channels.includes(c)).map((c) => `channel "${c}"`),
			...(egress.connectors ?? []).filter((c) => !(instance.egress.connectors ?? []).includes(c)).map((c) => `connector "${c}"`),
		];
		if (missing.length > 0) {
			throw new SegreteriaConfigError(
				`instance ${config.tenantId}/${config.instanceId} does not allow ${missing.join(", ")}. Update its egress policy (instance.json) or use another OWNI_SEGRETERIA_INSTANCE_ID.`,
			);
		}
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		await runtime.registry.createInstance(config.tenantId, { id: config.instanceId, name: `Segreteria (${config.instanceId})`, model: roles.draft, egress });
	}
	await runtime.registry.setAllowedUsers(config.tenantId, config.instanceId, "telegram", config.salesUserIds);
	const secrets = runtime.secrets(config.tenantId);
	if (config.anthropicApiKey !== undefined) await secrets.set(modelApiKeySecret("anthropic"), config.anthropicApiKey);
	await secrets.set(GMAIL_SECRETS.clientId, config.gmail.clientId);
	await secrets.set(GMAIL_SECRETS.clientSecret, config.gmail.clientSecret);
	await secrets.set(GMAIL_SECRETS.refreshToken, config.gmail.refreshToken);
	await secrets.set(HUBSPOT_SECRET, config.hubspotAccessToken);

	const t = toTenantId(config.tenantId);
	const i = toInstanceId(config.instanceId);
	const lock = InstanceLock.acquire(lockFile(config.dataDir, t, i), `${t}/${i}`);
	try {
		const record = await runtime.registry.getInstance(config.tenantId, config.instanceId);
		// Read on every request: an owner who removes a connector stops it without a restart.
		const policy = async () => (await runtime.registry.getInstance(config.tenantId, config.instanceId)).egress;
		const mail = new GmailMailAdapter({
			fetch: egressFetch("gmail", GMAIL_HOSTS, policy),
			credentials: async () => {
				const [clientId, clientSecret, refreshToken] = await Promise.all([secrets.get(GMAIL_SECRETS.clientId), secrets.get(GMAIL_SECRETS.clientSecret), secrets.get(GMAIL_SECRETS.refreshToken)]);
				return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
			},
		});
		const crm = new HubSpotCrmAdapter({ fetch: egressFetch("hubspot", HUBSPOT_HOSTS, policy), accessToken: () => secrets.get(HUBSPOT_SECRET), log });
		const telegram = new TelegramAdapter({ token: config.telegramBotToken, tenantId: config.tenantId, instanceId: config.instanceId, log });
		const model =
			config.modelProvider === "faux"
				? undefined
				: {
						client: createPiCompletionClient({ apiKey: (provider) => secrets.get(modelApiKeySecret(provider)), assertAllowed: async (provider) => assertModelProviderAllowed(await policy(), provider) }),
						checks: await loadChecks(join(import.meta.dirname, "..", "..", "evals", "segreteria")),
					};
		const service = new SegreteriaService({
			tenantId: config.tenantId,
			instanceId: config.instanceId,
			instanceDir: instanceDir(config.dataDir, t, i),
			mail,
			crm,
			telegram,
			audit: new AuditLog(config.dataDir, t),
			usage: new UsageLedger(tenantDir(config.dataDir, t)),
			roles,
			...(model === undefined ? {} : { model }),
			salesUserIds: record.allowedUsers.telegram ?? [],
			tenantConfig: { requireVatNumber: config.requireVatNumber },
			pollIntervalMs: config.pollSeconds * 1000,
			log,
		});
		await service.start();
		await telegram.start();
		return {
			service,
			instanceId: config.instanceId,
			async stop() {
				await telegram.stop();
				await service.stop();
				lock.release();
			},
		};
	} catch (error) {
		lock.release();
		throw error;
	}
}
