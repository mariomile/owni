import { ChannelRefused } from "../channels/types.ts";
import { MissingPhoneField, PHONE_NUMBER, PHONE_PIN } from "../channels/phone.ts";
import { MissingWhatsAppField, TEMPLATE_LANGUAGE, TEMPLATE_NAME, type WhatsAppTemplate } from "../channels/whatsapp.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { type AddRoute, HttpError, readJson } from "./http.ts";
import type { WebAppOptions } from "./server.ts";

export type ChannelRoutesDeps = Pick<WebAppOptions, "telegram" | "whatsapp" | "phone" | "log"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
	readonly knownInstance: (id: string) => Promise<InstanceRecord>;
};

/** The owner connects an agente's Telegram bot, WhatsApp number and phone number; secrets never come back. */
export function channelRoutes(route: AddRoute, options: ChannelRoutesDeps): void {
	const { runtime, tenantId, knownInstance } = options;
	// --- owner: the Telegram bot of an instance (the token never comes back) ---
	const telegramOf = () => {
		if (options.telegram === undefined) throw new HttpError(501, "Telegram non disponibile");
		return options.telegram;
	};
	route("GET", "/api/instances/:id/telegram", "owner", async ({ params }) => {
		await knownInstance(params[0]);
		return { telegram: await telegramOf().status(params[0]) };
	});
	route("PUT", "/api/instances/:id/telegram", "owner", async ({ params, req }) => {
		const id = params[0];
		const body = (await readJson(req)) as { token?: unknown; allowedUsers?: unknown; approvers?: unknown };
		const ids = (list: unknown, what: string): string[] | undefined => {
			if (list === undefined) return undefined;
			if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && /^\d{1,20}$/.test(x))) throw new HttpError(400, `${what}: ID numerici di Telegram`);
			return [...new Set(list as string[])];
		};
		const allowed = ids(body.allowedUsers, "Persone ammesse");
		const approvers = ids(body.approvers, "Approvatori");
		const record = await knownInstance(id);
		if (typeof body.token === "string" && body.token.trim() !== "") {
			try {
				await telegramOf().connect(id, body.token.trim());
			} catch (error) {
				if (error instanceof HttpError) throw error;
				// Telegram said no, or we never reached it: different fixes for the owner.
				if (error instanceof ChannelRefused) throw new HttpError(400, "Telegram non accetta questo token: copialo di nuovo da @BotFather");
				throw new HttpError(502, "Telegram non è raggiungibile da questo server: controlla la rete e riprova");
			}
			await runtime.audit(tenantId).append({ type: "telegram.connected", instanceId: id });
		}
		if (allowed !== undefined) await runtime.registry.setAllowedUsers(tenantId, id, "telegram", allowed);
		if (approvers !== undefined) await runtime.registry.updateInstance(tenantId, id, { approvers: { ...(record.approvers ?? {}), telegram: approvers } });
		return { telegram: await telegramOf().status(id) };
	});
	route("DELETE", "/api/instances/:id/telegram", "owner", async ({ params }) => {
		await telegramOf().disconnect(params[0]);
		await runtime.audit(tenantId).append({ type: "telegram.disconnected", instanceId: params[0] });
		return { ok: true };
	});

	// --- owner: WhatsApp of an instance (token and app secret never come back) ---
	const whatsappOf = () => {
		if (options.whatsapp === undefined) throw new HttpError(501, "WhatsApp non disponibile");
		return options.whatsapp;
	};
	route("GET", "/api/instances/:id/whatsapp", "owner", async ({ params }) => {
		await knownInstance(params[0]);
		return { whatsapp: await whatsappOf().status(params[0]) };
	});
	route("PUT", "/api/instances/:id/whatsapp", "owner", async ({ params, req }) => {
		const id = params[0];
		const body = (await readJson(req)) as { accessToken?: unknown; phoneNumberId?: unknown; appSecret?: unknown; allowedUsers?: unknown; approvers?: unknown; templateName?: unknown; templateLanguage?: unknown };
		// Numbers as WhatsApp writes them: international, digits only (393331234567).
		const numbers = (list: unknown, what: string): string[] | undefined => {
			if (list === undefined) return undefined;
			if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && /^\d{6,15}$/.test(x))) throw new HttpError(400, `${what}: numeri con prefisso internazionale, solo cifre (393331234567)`);
			return [...new Set(list as string[])];
		};
		const allowed = numbers(body.allowedUsers, "Chi può scrivere");
		const approvers = numbers(body.approvers, "Chi approva");
		const text = (value: unknown, pattern: RegExp, what: string): string | undefined => {
			if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
			if (typeof value !== "string" || !pattern.test(value.trim())) throw new HttpError(400, `${what} non valido`);
			return value.trim();
		};
		const given = {
			accessToken: text(body.accessToken, /^[\w-]{20,1024}$/, "Token di accesso"),
			phoneNumberId: text(body.phoneNumberId, /^\d{5,30}$/, "ID del numero"),
			appSecret: text(body.appSecret, /^[0-9a-f]{16,128}$/i, "App secret"),
		};
		// The template: both name and language, or both empty to remove it; left out, unchanged.
		let template: WhatsAppTemplate | null | undefined;
		if (body.templateName !== undefined || body.templateLanguage !== undefined) {
			const name = typeof body.templateName === "string" ? body.templateName.trim() : "";
			const language = typeof body.templateLanguage === "string" ? body.templateLanguage.trim() : "";
			if (name === "" && language === "") template = null;
			else if (TEMPLATE_NAME.test(name) && TEMPLATE_LANGUAGE.test(language)) template = { name, language };
			else throw new HttpError(400, "Template: il nome come in Meta (minuscole, cifre e _) e la lingua come it o en_US");
		}
		const record = await knownInstance(id);
		if (Object.values(given).some((v) => v !== undefined) || template !== undefined) {
			try {
				await whatsappOf().connect(id, { ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)), ...(template === undefined ? {} : { template }) });
			} catch (error) {
				if (error instanceof HttpError) throw error;
				if (error instanceof MissingWhatsAppField) throw new HttpError(400, "La prima volta servono token di accesso, ID del numero e app secret");
				if (error instanceof ChannelRefused) throw new HttpError(400, "Meta non accetta questi dati: controlla token e ID del numero");
				throw new HttpError(502, "WhatsApp non è raggiungibile da questo server: controlla la rete e riprova");
			}
			await runtime.audit(tenantId).append({ type: "whatsapp.connected", instanceId: id });
		}
		if (allowed !== undefined) await runtime.registry.setAllowedUsers(tenantId, id, "whatsapp", allowed);
		if (approvers !== undefined) await runtime.registry.updateInstance(tenantId, id, { approvers: { ...(record.approvers ?? {}), whatsapp: approvers } });
		return { whatsapp: await whatsappOf().status(id) };
	});
	route("DELETE", "/api/instances/:id/whatsapp", "owner", async ({ params }) => {
		await whatsappOf().disconnect(params[0]);
		await runtime.audit(tenantId).append({ type: "whatsapp.disconnected", instanceId: params[0] });
		return { ok: true };
	});

	// --- owner: a phone number for an instance (Twilio, ADR 0012) ---
	const phoneOf = () => {
		if (options.phone === undefined) throw new HttpError(501, "Telefono non disponibile");
		return options.phone;
	};
	route("GET", "/api/instances/:id/phone", "owner", async ({ params }) => {
		await knownInstance(params[0]);
		return { phone: await phoneOf().status(params[0]) };
	});
	route("PUT", "/api/instances/:id/phone", "owner", async ({ params, req }) => {
		const id = params[0];
		await knownInstance(id);
		const body = (await readJson(req)) as { accountSid?: unknown; authToken?: unknown; number?: unknown; pin?: unknown; allowedUsers?: unknown };
		const text = (value: unknown, pattern: RegExp, what: string): string | undefined => {
			if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
			if (typeof value !== "string" || !pattern.test(value.replace(/\s+/g, ""))) throw new HttpError(400, `${what} non valido`);
			return value.replace(/\s+/g, "");
		};
		const given = { accountSid: text(body.accountSid, /^AC[0-9a-f]{32}$/i, "Account SID"), authToken: text(body.authToken, /^[0-9a-f]{32}$/i, "Auth token"), number: text(body.number, PHONE_NUMBER, "Numero (con +, per esempio +390612345678)"), pin: text(body.pin, PHONE_PIN, "Codice (da 4 a 8 cifre)") };
		let allowed: string[] | undefined;
		if (body.allowedUsers !== undefined) {
			const list = Array.isArray(body.allowedUsers) ? body.allowedUsers.map((n) => String(n).replace(/[\s.-]+/g, "")) : [];
			if (!Array.isArray(body.allowedUsers) || !list.every((n) => PHONE_NUMBER.test(n))) throw new HttpError(400, "Chi può chiamare: numeri con + e prefisso internazionale (+393331234567)");
			allowed = [...new Set(list)];
		}
		if (Object.values(given).some((v) => v !== undefined)) {
			try {
				await phoneOf().connect(id, Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)));
			} catch (error) {
				if (error instanceof HttpError) throw error;
				if (error instanceof MissingPhoneField) throw new HttpError(400, error.message === "https" ? "Serve un indirizzo https pubblico: Twilio deve poter chiamare questo server" : "La prima volta servono Account SID, auth token, numero e codice");
				if (error instanceof ChannelRefused) throw new HttpError(400, `Twilio: ${error.message}`);
				options.log?.(`phone: not connected: ${error instanceof Error ? error.message : String(error)}`);
				throw new HttpError(502, "Twilio non è raggiungibile da questo server: controlla la rete e riprova");
			}
			await runtime.audit(tenantId).append({ type: "phone.connected", instanceId: id });
		}
		if (allowed !== undefined) await runtime.registry.setAllowedUsers(tenantId, id, "phone", allowed);
		return { phone: await phoneOf().status(id) };
	});
	route("DELETE", "/api/instances/:id/phone", "owner", async ({ params }) => {
		await knownInstance(params[0]);
		await phoneOf().disconnect(params[0]);
		await runtime.audit(tenantId).append({ type: "phone.disconnected", instanceId: params[0] });
		return { ok: true };
	});
}
