import { randomBytes } from "node:crypto";
import { TelegramAdapter, type TelegramUpdate } from "../channels/telegram.ts";
import type { Transcribe } from "../channels/voice.ts";
import type { InstanceVoice } from "../channels/speech.ts";
import type { ChannelAdapter, InboundAction } from "../channels/types.ts";
import type { ChatModels } from "../core/chat-models.ts";
import { withChannel } from "../core/policy.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { skillMenuEntry } from "../core/skills.ts";
import { connectChannel } from "../gateway.ts";
import type { OwniConfig } from "../main/config.ts";
import { MODEL_COMMAND } from "../model-command.ts";
import type { WebAppOptions } from "../web/server.ts";

export type TelegramWiring = {
	readonly runtime: OwniRuntime;
	readonly tenant: string;
	readonly config: OwniConfig;
	readonly chatModels: ChatModels;
	/** Tests: the Telegram Bot API fetch. */
	readonly fetch: typeof fetch | undefined;
	readonly voiceFor: (instance: string) => { transcribe?: Transcribe };
	readonly voiceOf: (instance: string) => InstanceVoice | undefined;
	/** A tap on an approval card in the bot's chat. */
	readonly onAction: (instance: string, bot: ChannelAdapter, action: InboundAction) => Promise<void>;
	readonly log: (message: string) => void;
};

export type Telegram = {
	/** The bot of each instance that has one. */
	readonly bots: ReadonlyMap<string, TelegramAdapter>;
	/** The bots in webhook mode: the secret Telegram sends, and where the update goes. */
	readonly hooks: ReadonlyMap<string, { secret: string; handle: (update: unknown) => Promise<void> }>;
	/** Connects the instances whose token is saved. */
	restore(instances: readonly string[]): Promise<void>;
	detach(instance: string): Promise<void>;
} & NonNullable<WebAppOptions["telegram"]>;

export function telegramTokenSecret(instance: string): string {
	return `telegram.botToken.${instance}`;
}

/** Telegram, at most one bot per instance. */
export function startTelegram(w: TelegramWiring): Telegram {
	const { runtime, tenant, config, log } = w;
	const bots = new Map<string, TelegramAdapter>();
	const hooks = new Map<string, { secret: string; handle: (update: unknown) => Promise<void> }>();
	const unsubscribes = new Map<string, () => void>();

	/** Webhook when Telegram can reach us over https (a cell), long polling otherwise. */
	async function webhookSecretFor(instance: string): Promise<string | undefined> {
		if (instance === config.instanceId && config.telegram?.webhookSecret !== undefined) return config.telegram.webhookSecret;
		if (!(config.web.publicUrl?.startsWith("https://") ?? false)) return undefined;
		const name = `telegram.webhookSecret.${instance}`;
		const known = await runtime.secrets(tenant).get(name);
		if (known !== undefined) return known;
		const fresh = randomBytes(24).toString("base64url");
		await runtime.secrets(tenant).set(name, fresh);
		return fresh;
	}

	async function attach(instance: string, token: string): Promise<TelegramAdapter> {
		const webhookSecret = await webhookSecretFor(instance);
		const bot = new TelegramAdapter({
			token,
			tenantId: tenant,
			instanceId: instance,
			log,
			// Files from strangers are never downloaded.
			mayDownload: async (userId) => ((await runtime.registry.getInstance(tenant, instance)).allowedUsers.telegram ?? []).includes(userId),
			...w.voiceFor(instance),
			...(w.fetch === undefined ? {} : { fetch: w.fetch }),
			...(webhookSecret === undefined ? {} : { webhook: { url: `${config.web.publicUrl}/hooks/telegram/${instance}`, secretToken: webhookSecret } }),
			// The skills as they are now: the menu is set once, when the bot is connected (ADR 0104).
			commands: [MODEL_COMMAND, ...runtime.skills(tenant, instance).list().map(skillMenuEntry)],
		});
		unsubscribes.set(instance, connectChannel(runtime, bot, { tenantId: tenant, instanceId: instance }, log, { onAction: (action) => w.onAction(instance, bot, action), voice: w.voiceOf(instance), models: w.chatModels }));
		bots.set(instance, bot);
		if (webhookSecret !== undefined) hooks.set(instance, { secret: webhookSecret, handle: (update) => bot.handleUpdate(update as TelegramUpdate) });
		return bot;
	}

	async function detach(instance: string): Promise<void> {
		const bot = bots.get(instance);
		bots.delete(instance);
		hooks.delete(instance);
		unsubscribes.get(instance)?.();
		unsubscribes.delete(instance);
		await bot?.stop();
	}

	return {
		bots,
		hooks,
		detach,
		restore: async (instances) => {
			for (const instance of instances) {
				const token = await runtime.secrets(tenant).get(telegramTokenSecret(instance));
				if (token !== undefined) await attach(instance, token);
			}
		},
		status: async (id) => {
			const bot = bots.get(id);
			const record = await runtime.registry.getInstance(tenant, id);
			const username = bot === undefined ? undefined : (await bot.me().catch(() => ({ username: undefined }))).username;
			return {
				connected: bot !== undefined,
				...(username === undefined ? {} : { username }),
				mode: hooks.has(id) ? "webhook" : "polling",
				allowedUsers: record.allowedUsers.telegram ?? [],
				approvers: record.approvers?.telegram ?? [],
			};
		},
		// The token is checked with Telegram before anything changes.
		connect: async (id, token) => {
			const probe = new TelegramAdapter({ token, tenantId: tenant, instanceId: id, ...(w.fetch === undefined ? {} : { fetch: w.fetch }) });
			const me = await probe.me();
			await detach(id);
			await runtime.secrets(tenant).set(telegramTokenSecret(id), token);
			const bot = await attach(id, token);
			await bot.start();
			const record = await runtime.registry.getInstance(tenant, id);
			await runtime.registry.setEgress(tenant, id, (egress) => withChannel(egress, "telegram", true));
			return me;
		},
		disconnect: async (id) => {
			await detach(id);
			await runtime.secrets(tenant).delete(telegramTokenSecret(id));
		},
	};
}
