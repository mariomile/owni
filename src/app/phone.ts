import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectTwilioNumber, MissingPhoneField, type PendingReplies, PhoneAdapter, type PhoneCredentials, parsePhoneCredentials } from "../channels/phone.ts";
import { instanceId as toInstanceId, tenantId as toTenantId } from "../core/ids.ts";
import { readJsonFile, updateJsonFile } from "../core/locked-json.ts";
import { instanceDir } from "../core/paths.ts";
import { withChannel } from "../core/policy.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { connectChannel } from "../gateway.ts";
import type { OwniConfig } from "../main/config.ts";
import type { WebAppOptions } from "../web/server.ts";

export type PhoneWiring = {
	readonly runtime: OwniRuntime;
	readonly tenant: string;
	readonly config: OwniConfig;
	/** Tests: the Twilio REST API fetch. */
	readonly fetch: typeof fetch | undefined;
	/** Tests: how long a webhook waits for a reply, and how many waits. */
	readonly wait: { readonly ms: number; readonly max: number } | undefined;
	readonly log: (message: string) => void;
};

export type Phone = {
	/** The number of each instance that has one. */
	readonly adapters: ReadonlyMap<string, PhoneAdapter>;
	/** Connects the instances whose credentials are saved, and points their numbers at this server again. */
	restore(instances: readonly string[]): Promise<void>;
	detach(instance: string): void;
} & NonNullable<WebAppOptions["phone"]>;

/** The Twilio credentials of an instance, as one JSON value in its secret store. */
export function phoneSecret(instance: string): string {
	return `phone.credentials.${instance}`;
}

/** Phone, at most one Twilio number per instance, by webhook only (ADR 0012). */
export function startPhone(w: PhoneWiring): Phone {
	const { runtime, tenant, config, log } = w;
	const adapters = new Map<string, PhoneAdapter>();
	const unsubscribes = new Map<string, () => void>();

	const pendingFile = (instance: string) => join(instanceDir(config.dataDir, toTenantId(tenant), toInstanceId(instance)), "phone-pending.json");

	function attach(instance: string, credentials: PhoneCredentials): PhoneAdapter | undefined {
		if (!(config.web.publicUrl?.startsWith("https://") ?? false)) return undefined;
		const adapter = new PhoneAdapter({
			credentials,
			tenantId: tenant,
			instanceId: instance,
			publicUrl: config.web.publicUrl as string,
			pending: pendingReplies(pendingFile(instance), log),
			mayCall: async (number) => ((await runtime.registry.getInstance(tenant, instance)).allowedUsers.phone ?? []).includes(number),
			voice: config.phone.voice,
			log,
			...(w.wait === undefined ? {} : { waitMs: w.wait.ms, maxWaits: w.wait.max }),
		});
		unsubscribes.set(instance, connectChannel(runtime, adapter, { tenantId: tenant, instanceId: instance }, log));
		adapters.set(instance, adapter);
		return adapter;
	}

	function detach(instance: string): void {
		void adapters.get(instance)?.stop();
		adapters.delete(instance);
		unsubscribes.get(instance)?.();
		unsubscribes.delete(instance);
	}

	return {
		adapters,
		detach,
		restore: async (instances) => {
			for (const instance of instances) {
				const saved = await runtime.secrets(tenant).get(phoneSecret(instance));
				const credentials = saved === undefined ? undefined : parsePhoneCredentials(saved);
				if (credentials !== undefined && attach(instance, credentials) === undefined) log(`phone: ${instance} has a number but this server has no public https address; calls are off`);
				// The public address may have changed since the number was connected: point it here again.
				else if (credentials !== undefined)
					void connectTwilioNumber({ ...credentials, voiceUrl: `${config.web.publicUrl}/hooks/phone/${instance}`, apiBase: config.phone.apiBase, ...(w.fetch === undefined ? {} : { fetch: w.fetch }) }).catch((error: unknown) =>
						log(`phone: could not point the number of ${instance} here: ${error instanceof Error ? error.message : String(error)}`),
					);
				else if (saved !== undefined && credentials === undefined) log(`phone: saved credentials of ${instance} unreadable; connect it again from the console`);
			}
		},
		status: async (id) => {
			const record = await runtime.registry.getInstance(tenant, id);
			const saved = await runtime.secrets(tenant).get(phoneSecret(id));
			const credentials = saved === undefined ? undefined : parsePhoneCredentials(saved);
			return {
				connected: adapters.has(id),
				https: config.web.publicUrl?.startsWith("https://") ?? false,
				...(credentials === undefined ? {} : { number: credentials.number, accountSid: credentials.accountSid }),
				allowedUsers: record.allowedUsers.phone ?? [],
			};
		},
		// Checked with Twilio, and the number pointed at this cell, before anything changes.
		connect: async (id, given) => {
			const publicUrl = config.web.publicUrl;
			if (!(publicUrl?.startsWith("https://") ?? false)) throw new MissingPhoneField("https");
			const saved = await runtime.secrets(tenant).get(phoneSecret(id));
			const old = saved === undefined ? undefined : parsePhoneCredentials(saved);
			const accountSid = given.accountSid ?? old?.accountSid;
			const authToken = given.authToken ?? old?.authToken;
			const number = given.number ?? old?.number;
			const pin = given.pin ?? old?.pin;
			if (accountSid === undefined || authToken === undefined || number === undefined || pin === undefined) throw new MissingPhoneField("fields");
			const twilio = { apiBase: config.phone.apiBase, ...(w.fetch === undefined ? {} : { fetch: w.fetch }) };
			// Only the code changed: nothing to ask Twilio.
			const same = old !== undefined && old.accountSid === accountSid && old.authToken === authToken && old.number === number;
			const { numberSid } = same ? { numberSid: old.numberSid } : await connectTwilioNumber({ accountSid, authToken, number, voiceUrl: `${publicUrl}/hooks/phone/${id}`, ...twilio });
			// A number replaced still points here: the adapter refuses calls to any other number.
			const credentials: PhoneCredentials = { accountSid, authToken, number, numberSid, pin };
			detach(id);
			await runtime.secrets(tenant).set(phoneSecret(id), JSON.stringify(credentials));
			attach(id, credentials);
			const record = await runtime.registry.getInstance(tenant, id);
			await runtime.registry.setEgress(tenant, id, (egress) => withChannel(egress, "phone", true));
			return { number };
		},
		disconnect: async (id) => {
			detach(id);
			// The number keeps pointing here, and its calls are refused before they are answered (no cost).
			await runtime.secrets(tenant).delete(phoneSecret(id));
			rmSync(pendingFile(id), { force: true });
		},
	};
}

/** Replies waiting for a caller, on disk: at most 5 per number, none older than 7 days. */
function pendingReplies(file: string, log: (message: string) => void): PendingReplies {
	type State = Record<string, { text: string; at: string; key?: string }[]>;
	const fresh = (list: State[string] | undefined) => (list ?? []).filter((r) => Date.now() - Date.parse(r.at) < 7 * 24 * 3600_000);
	// Every write also drops what is too old, for every number.
	const prune = (s: State): State => Object.fromEntries(Object.entries(s).map(([n, list]) => [n, fresh(list)] as const).filter(([, list]) => list.length > 0));
	const update = (change: (s: State) => State) => {
		try {
			return updateJsonFile<State>(file, {}, (s) => change(prune(s)));
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			log(`phone: ${file} unreadable, set aside as .damaged`);
			renameSync(file, `${file}.damaged`);
			return updateJsonFile<State>(file, {}, (s) => change(prune(s)));
		}
	};
	return {
		take: (number) => {
			// Read first: most waits find nothing, and need no write.
			try {
				if (readJsonFile<State>(file, {})[number] === undefined) return [];
			} catch {
				/* damaged: update() sets it aside */
			}
			let taken: string[] = [];
			update((s) => {
				taken = fresh(s[number]).map((r) => r.text);
				const { [number]: _, ...rest } = s;
				return rest;
			});
			return taken;
		},
		put: (number, text, key) => {
			update((s) => {
				const list = fresh(s[number]);
				if (list.some((r) => r.key === key)) return s;
				return { ...s, [number]: [...list, { text, at: new Date().toISOString(), key }].slice(-5) };
			});
		},
	};
}
