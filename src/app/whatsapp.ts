import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import type { InstanceVoice } from "../channels/speech.ts";
import type { ChannelAdapter, InboundAction } from "../channels/types.ts";
import type { Transcribe } from "../channels/voice.ts";
import { MissingWhatsAppField, parseCredentials, type WhatsAppCredentials, WhatsAppAdapter, type WhatsAppWindow, type WindowState, windowStore } from "../channels/whatsapp.ts";
import type { ChatModels } from "../core/chat-models.ts";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import { instanceId as toInstanceId, tenantId as toTenantId } from "../core/ids.ts";
import { instanceDir } from "../core/paths.ts";
import { withChannel } from "../core/policy.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { connectChannel } from "../gateway.ts";
import type { OwniConfig } from "../main/config.ts";
import type { WebAppOptions } from "../web/server.ts";

export type WhatsAppWiring = {
	readonly runtime: OwniRuntime;
	readonly tenant: string;
	readonly config: OwniConfig;
	readonly chatModels: ChatModels;
	/** Tests: the WhatsApp Cloud API base (a fake Graph API). */
	readonly apiBase: string | undefined;
	readonly voiceFor: (instance: string) => { transcribe?: Transcribe };
	readonly voiceOf: (instance: string) => InstanceVoice | undefined;
	/** A tap on an approval card in the number's chat. */
	readonly onAction: (instance: string, adapter: ChannelAdapter, action: InboundAction) => Promise<void>;
	readonly log: (message: string) => void;
};

export type WhatsApp = {
	/** The number of each instance that has one. */
	readonly adapters: ReadonlyMap<string, WhatsAppAdapter>;
	/** Connects the instances whose credentials are saved. */
	restore(instances: readonly string[]): Promise<void>;
	detach(instance: string): void;
} & NonNullable<WebAppOptions["whatsapp"]>;

/** The WhatsApp credentials of an instance, as one JSON value in its secret store. */
export function whatsappSecret(instance: string): string {
	return `whatsapp.credentials.${instance}`;
}

/** WhatsApp, at most one business number per instance, by webhook only. */
export function startWhatsApp(w: WhatsAppWiring): WhatsApp {
	const { runtime, tenant, config, log } = w;
	const adapters = new Map<string, WhatsAppAdapter>();
	const unsubscribes = new Map<string, () => void>();

	function attach(instance: string, credentials: WhatsAppCredentials): WhatsAppAdapter {
		const adapter = new WhatsAppAdapter({
			...credentials,
			window: whatsappWindow(join(instanceDir(config.dataDir, toTenantId(tenant), toInstanceId(instance)), "whatsapp-window.json"), log),
			tenantId: tenant,
			instanceId: instance,
			log,
			// Files from strangers are never downloaded.
			mayDownload: async (userId) => ((await runtime.registry.getInstance(tenant, instance)).allowedUsers.whatsapp ?? []).includes(userId),
			...w.voiceFor(instance),
			...(w.apiBase === undefined ? {} : { apiBase: w.apiBase }),
		});
		unsubscribes.set(instance, connectChannel(runtime, adapter, { tenantId: tenant, instanceId: instance }, log, { onAction: (action) => w.onAction(instance, adapter, action), voice: w.voiceOf(instance), models: w.chatModels }));
		adapters.set(instance, adapter);
		return adapter;
	}

	function detach(instance: string): void {
		adapters.delete(instance);
		unsubscribes.get(instance)?.();
		unsubscribes.delete(instance);
	}

	return {
		adapters,
		detach,
		restore: async (instances) => {
			for (const instance of instances) {
				const saved = await runtime.secrets(tenant).get(whatsappSecret(instance));
				const credentials = saved === undefined ? undefined : parseCredentials(saved);
				if (credentials !== undefined) attach(instance, credentials);
				else if (saved !== undefined) log(`whatsapp: saved credentials of ${instance} unreadable; connect it again from the console`);
			}
		},
		status: async (id) => {
			const adapter = adapters.get(id);
			const record = await runtime.registry.getInstance(tenant, id);
			const saved = await runtime.secrets(tenant).get(whatsappSecret(id));
			const credentials = saved === undefined ? undefined : parseCredentials(saved);
			const me = adapter === undefined ? undefined : await adapter.me().catch(() => undefined);
			return {
				connected: adapter !== undefined,
				...(me?.number === undefined ? {} : { number: me.number }),
				...(me?.name === undefined ? {} : { name: me.name }),
				// What the owner pastes into the Meta app: the address and the token Meta sends back to check it.
				webhookUrl: config.web.publicUrl?.startsWith("https://") ? `${config.web.publicUrl}/hooks/whatsapp/${id}` : null,
				...(credentials === undefined ? {} : { verifyToken: credentials.verifyToken }),
				allowedUsers: record.allowedUsers.whatsapp ?? [],
				approvers: record.approvers?.whatsapp ?? [],
				template: credentials?.template ?? null,
			};
		},
		// Checked with Meta before anything changes; a value left out keeps the one saved.
		connect: async (id, given) => {
			const saved = await runtime.secrets(tenant).get(whatsappSecret(id));
			const old = saved === undefined ? undefined : parseCredentials(saved);
			const accessToken = given.accessToken ?? old?.accessToken;
			const phoneNumberId = given.phoneNumberId ?? old?.phoneNumberId;
			const appSecret = given.appSecret ?? old?.appSecret;
			if (accessToken === undefined || phoneNumberId === undefined || appSecret === undefined) throw new MissingWhatsAppField();
			const template = given.template === null ? undefined : (given.template ?? old?.template);
			const credentials: WhatsAppCredentials = { accessToken, phoneNumberId, appSecret, verifyToken: old?.verifyToken ?? randomBytes(18).toString("base64url"), ...(template === undefined ? {} : { template }) };
			const me = await new WhatsAppAdapter({ ...credentials, tenantId: tenant, instanceId: id, ...(w.apiBase === undefined ? {} : { apiBase: w.apiBase }) }).me();
			detach(id);
			await runtime.secrets(tenant).set(whatsappSecret(id), JSON.stringify(credentials));
			attach(id, credentials);
			const record = await runtime.registry.getInstance(tenant, id);
			await runtime.registry.setEgress(tenant, id, (egress) => withChannel(egress, "whatsapp", true));
			return me;
		},
		disconnect: async (id) => {
			detach(id);
			await runtime.secrets(tenant).delete(whatsappSecret(id));
		},
	};
}

/** The WhatsApp window store of an instance, in a locked JSON file. A damaged file is set aside, not left to block the channel. */
function whatsappWindow(file: string, log: (message: string) => void): WhatsAppWindow {
	const aside = (error: unknown) => {
		if (!(error instanceof SyntaxError)) throw error;
		log(`whatsapp: ${file} unreadable, set aside as .damaged`);
		renameSync(file, `${file}.damaged`);
	};
	return windowStore({
		read: () => {
			try {
				return readJsonFile<WindowState>(file, {});
			} catch (error) {
				aside(error);
				return {};
			}
		},
		update: (change) => {
			try {
				updateJsonFile<WindowState>(file, {}, change);
			} catch (error) {
				aside(error);
				updateJsonFile<WindowState>(file, {}, change);
			}
		},
	});
}
