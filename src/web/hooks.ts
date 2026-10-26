import type { IncomingMessage, ServerResponse } from "node:http";
import type { WhatsAppWebhook } from "../channels/whatsapp.ts";
import { callAutomation } from "../core/automation-call.ts";
import { AUTOMATION_LIMITS, AutomationRate } from "../core/automations.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import { HttpError, readBody, readJson, send } from "./http.ts";
import { sameSecret } from "./compare.ts";
import type { WebAppOptions } from "./server.ts";

export type WebhooksDeps = Pick<WebAppOptions, "phoneHooks" | "whatsappHooks" | "telegramHooks" | "log"> & {
	readonly runtime: OwniRuntime;
	readonly tenantId: string;
};

/** What other services call, outside the console's sessions: Twilio, an automazione's caller, Meta, Telegram. */
export function webhooks(options: WebhooksDeps) {
	const { runtime, tenantId } = options;
	const automationRate = new AutomationRate();

	/**
	 * Twilio's webhook for an instance's phone number: a call starting, a phrase heard, a wait for
	 * the reply. Signed with the account's auth token over our public URL and the parameters.
	 * Answers TwiML.
	 */
	async function phoneHook(req: IncomingMessage, res: ServerResponse, url: URL, instance: string): Promise<void> {
		const adapter = options.phoneHooks?.get(instance);
		// A number still pointing here after it was disconnected: refused before it is answered, so it costs nothing.
		if (adapter === undefined) {
			res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
			return void res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
		}
		let raw: Buffer;
		try {
			raw = await readBody(req, 64 * 1024);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			throw error;
		}
		const params = new URLSearchParams(raw.toString("utf8"));
		if (!adapter.signed(adapter.hookUrl(url.search), params, req.headers["x-twilio-signature"] as string | undefined)) return send(res, 403, { error: "Forbidden" });
		try {
			// The caller hung up while the reply was awaited: Twilio closes the request.
			const gone = new AbortController();
			res.on("close", () => {
				if (!res.writableFinished) gone.abort();
			});
			const xml = await adapter.handle(url.searchParams, params, gone.signal);
			res.writeHead(200, { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" });
			res.end(xml);
		} catch (error) {
			options.log?.(`phone webhook: not handled: ${error instanceof Error ? error.message : String(error)}`);
			res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
			res.end(adapter.apology());
		}
	}

	/**
	 * An automazione called by another service (ADR 0060). The token in `Authorization: Bearer`,
	 * `X-Owni-Token` or `?token=`; anything wrong answers 404, so the address reveals nothing.
	 */
	async function automationHook(req: IncomingMessage, res: ServerResponse, url: URL, instance: string, id: string): Promise<void> {
		let raw: Buffer;
		try {
			raw = await readBody(req, AUTOMATION_LIMITS.bodyBytes);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			throw error;
		}
		const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
		const token = bearer ?? String(req.headers["x-owni-token"] ?? url.searchParams.get("token") ?? "");
		const key = req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"];
		let result;
		try {
			result = await callAutomation(runtime, { tenant: tenantId, instance, id, token, body: raw, contentType: req.headers["content-type"], key: typeof key === "string" ? key : undefined }, automationRate);
		} catch (error) {
			// Logged by path only: the query may hold the token.
			options.log?.(`automazione ${instance}/${id}: not run: ${error instanceof Error ? error.message : String(error)}`);
			return send(res, 503, { error: "Riprova più tardi" });
		}
		send(res, result.status, result.status === 202 ? { ok: true } : { error: result.error });
	}

	/**
	 * Meta's webhook for an instance's WhatsApp number. GET: Meta checks the address, with our
	 * verify token, and wants its challenge back as plain text. POST: messages, signed with the
	 * Meta app's secret over the raw body. An error answer makes Meta deliver again; the core
	 * dedupes by message id.
	 */
	async function whatsappHook(req: IncomingMessage, res: ServerResponse, url: URL, instance: string): Promise<void> {
		const adapter = options.whatsappHooks?.get(instance);
		if (adapter === undefined) return send(res, 404, { error: "Not found" });
		if (req.method === "GET") {
			const challenge = adapter.verify(url.searchParams);
			if (challenge === undefined) return send(res, 403, { error: "Forbidden" });
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			return void res.end(challenge);
		}
		let raw: Buffer;
		try {
			raw = await readBody(req, MAX_WHATSAPP_BODY);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			throw error;
		}
		if (!adapter.signed(raw, req.headers["x-hub-signature-256"] as string | undefined)) return send(res, 401, { error: "Unauthorized" });
		let payload: WhatsAppWebhook;
		try {
			payload = JSON.parse(raw.toString("utf8")) as WhatsAppWebhook;
		} catch {
			return send(res, 400, { error: "JSON non valido" });
		}
		try {
			await adapter.handleWebhook(payload);
		} catch (error) {
			options.log?.(`whatsapp webhook: not handled, Meta will retry: ${error instanceof Error ? error.message : String(error)}`);
			return send(res, 500, { error: "retry" });
		}
		send(res, 200, { ok: true });
	}

	/**
	 * An update Telegram pushes. Authenticated by the secret Telegram repeats in a header, not
	 * by a session. An error answer makes Telegram deliver it again; the core dedupes by ID.
	 */
	async function telegramHook(req: IncomingMessage, res: ServerResponse, instance: string): Promise<void> {
		const target = options.telegramHooks?.get(instance);
		if (target === undefined) return send(res, 404, { error: "Not found" });
		const given = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
		if (!sameSecret(given, target.secret)) return send(res, 401, { error: "Unauthorized" });
		let update: Record<string, unknown>;
		try {
			update = await readJson(req);
		} catch (error) {
			if (error instanceof HttpError) return send(res, error.status, { error: error.message });
			throw error;
		}
		try {
			await target.handle(update);
		} catch (error) {
			options.log?.(`telegram webhook: update not handled, Telegram will retry: ${error instanceof Error ? error.message : String(error)}`);
			return send(res, 500, { error: "retry" });
		}
		send(res, 200, { ok: true });
	}

	return { phoneHook, automationHook, whatsappHook, telegramHook };
}

const MAX_WHATSAPP_BODY = 1024 * 1024;
