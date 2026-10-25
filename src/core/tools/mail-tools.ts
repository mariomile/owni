import type { OwniTool } from "../engine.ts";
import { hashIdempotency } from "../practice.ts";
import type { MailAdapter } from "../../connectors/types.ts";
import type { PracticeStore } from "../practice.ts";

/**
 * Mail tools for the durable engine.
 * send_email is ALWAYS replaySafe: false — a crash mid-send must never re-execute on replay.
 * Retries happen only via a fresh human Approva.
 */
export function createMailTools(options: {
	tenantId: string;
	mail: MailAdapter;
	practices: PracticeStore;
	/** Returns true only when the pratica is approved and not yet sent. */
	maySend: (praticaId: string) => Promise<boolean>;
}): OwniTool[] {
	const { tenantId, mail, practices, maySend } = options;

	const sendEmail: OwniTool = {
		name: "send_email",
		description: "Send an approved draft email reply. Only callable after human Approva.",
		parameters: {
			type: "object",
			properties: {
				praticaId: { type: "string" },
				to: { type: "string" },
				subject: { type: "string" },
				bodyText: { type: "string" },
				inReplyToMessageId: { type: "string" },
			},
			required: ["praticaId", "to", "subject", "bodyText", "inReplyToMessageId"],
			additionalProperties: false,
		},
		replaySafe: false,
		async execute(args) {
			const praticaId = String(args.praticaId);
			const pratica = await practices.get(praticaId);
			if (!pratica) return JSON.stringify({ ok: false, error: "pratica_not_found" });
			if (pratica.sentMessageId) {
				return JSON.stringify({ ok: true, sentMessageId: pratica.sentMessageId, deduped: true });
			}
			if (!(await maySend(praticaId))) {
				return JSON.stringify({ ok: false, error: "not_approved" });
			}
			const idempotencyKey = hashIdempotency("send", praticaId, String(pratica.draftVersion));
			try {
				const result = await mail.sendReply(tenantId, {
					to: String(args.to),
					subject: String(args.subject),
					bodyText: String(args.bodyText),
					inReplyToMessageId: String(args.inReplyToMessageId),
					idempotencyKey,
				});
				pratica.sentMessageId = result.sentMessageId;
				pratica.status = "sent";
				await practices.save(pratica);
				return JSON.stringify({ ok: true, sentMessageId: result.sentMessageId });
			} catch (err) {
				pratica.status = "failed";
				pratica.lastError = {
					code: "mail_send_failed",
					message: err instanceof Error ? err.message : String(err),
					at: new Date().toISOString(),
				};
				await practices.save(pratica);
				return JSON.stringify({ ok: false, error: "mail_send_failed", message: pratica.lastError.message });
			}
		},
	};

	const readMail: OwniTool = {
		name: "mail_read",
		description: "Read a previously ingested inbound mail by message id (idempotent).",
		parameters: {
			type: "object",
			properties: { messageId: { type: "string" } },
			required: ["messageId"],
			additionalProperties: false,
		},
		replaySafe: true,
		async execute(args, ctx) {
			const messageId = String(args.messageId);
			return ctx.step(`mail_read:${messageId}`, async () => {
				const pratica = await practices.findByMailMessageId(messageId);
				if (!pratica) return JSON.stringify({ ok: false, error: "not_found" });
				return JSON.stringify({
					ok: true,
					praticaId: pratica.praticaId,
					subject: pratica.lead.rawSubject,
					snippet: pratica.lead.rawSnippet,
				});
			});
		},
	};

	return [sendEmail, readMail];
}
