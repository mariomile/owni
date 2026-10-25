import { createHash } from "node:crypto";
import { ConnectorHttpError, requestJson } from "./http.ts";
import type { InboundMail, MailAdapter } from "./types.ts";

/** OAuth client and refresh token of one tenant's mailbox (scopes: gmail.readonly + gmail.send). */
export type GmailCredentials = {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
};

/** Tenant secret names of the Gmail credentials. */
export const GMAIL_SECRETS = {
	clientId: "mail.gmail.clientId",
	clientSecret: "mail.gmail.clientSecret",
	refreshToken: "mail.gmail.refreshToken",
} as const;

/** Hosts the Gmail adapter talks to; the egress fetch allows only these. */
export const GMAIL_HOSTS = ["gmail.googleapis.com", "oauth2.googleapis.com"] as const;

export type GmailAdapterOptions = {
	readonly credentials: () => Promise<GmailCredentials | undefined>;
	/** Pass an egress-guarded fetch (see egressFetch). */
	readonly fetch: typeof fetch;
	readonly now?: () => number;
	/** Upper bound of messages read per poll. */
	readonly maxPerPoll?: number;
	readonly retryBaseMs?: number;
};

type Header = { name: string; value: string };
type MessagePart = { mimeType?: string; headers?: Header[]; body?: { data?: string; size?: number }; parts?: MessagePart[] };
type GmailMessage = { id: string; threadId: string; internalDate?: string; labelIds?: string[]; payload?: MessagePart };

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** How far before the cursor each poll looks again (search indexing lag). */
const OVERLAP_MS = 10 * 60_000;
/** Upper bound of IDs listed per poll. */
const MAX_LISTED = 2000;

/**
 * Gmail over its REST API with plain fetch.
 *
 * - `listNewRequests`: the cursor is the newest `internalDate` seen (epoch ms). An empty
 *   cursor starts from now: the first start never turns old mail into pratiche. Polls
 *   overlap by up to a second; the pipeline drops messages it already has by ID.
 * - `sendReply`: replies in the original thread (threadId, In-Reply-To, References).
 *   The Message-ID is derived from the idempotency key and looked up in sent mail first,
 *   so a retry after a crash finds the earlier send instead of sending again, provided
 *   Gmail keeps the Message-ID we set (to confirm on the live mailbox). Never retried here.
 */
export class GmailMailAdapter implements MailAdapter {
	readonly name = "gmail";
	private token: { value: string; expiresAt: number } | undefined;
	private sender: string | undefined;
	private readonly now: () => number;

	constructor(private readonly options: GmailAdapterOptions) {
		this.now = options.now ?? Date.now;
	}

	async listNewRequests(
		_tenantId: string,
		sinceCursor: string,
		options: { isKnown?: (messageId: string) => Promise<boolean> } = {},
	): Promise<{ messages: InboundMail[]; nextCursor: string }> {
		if (sinceCursor === "") return { messages: [], nextCursor: String(this.now()) };
		const since = Number(sinceCursor);
		if (!Number.isFinite(since)) throw new Error(`Gmail cursor is not a timestamp: ${sinceCursor}`);
		// Search is eventually consistent: a mail can be indexed after a newer one. Each poll
		// looks back OVERLAP_MS before the cursor; the pipeline drops mails it already has.
		const from = since - OVERLAP_MS;
		const q = `in:inbox -from:me after:${Math.floor(from / 1000)}`;
		const max = this.options.maxPerPoll ?? 200;
		// The list comes newest first: read every page (bounded), then keep the oldest `max`,
		// so a backlog is worked through in order over several polls and never skipped.
		const ids: string[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({ q, maxResults: "100" });
			if (pageToken !== undefined) params.set("pageToken", pageToken);
			const page = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>("messages.list", `${API}/messages?${params}`, { retries: 2 });
			ids.push(...(page.messages ?? []).map((m) => m.id));
			pageToken = page.nextPageToken;
		} while (pageToken !== undefined && ids.length < MAX_LISTED);
		const unknown: string[] = [];
		for (const id of ids) if (!(await options.isKnown?.(id))) unknown.push(id);
		const backlog = unknown.length > max;
		const chosen = unknown.slice(-max).reverse();

		const messages: InboundMail[] = [];
		for (const id of chosen) {
			const message = await this.api<GmailMessage>("messages.get", `${API}/messages/${encodeURIComponent(id)}?format=full`, { retries: 2 });
			if (Number(message.internalDate ?? "0") < from) continue;
			messages.push(toInboundMail(message));
		}
		// Oldest first, the order the mails arrived in.
		messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
		const newestRead = messages.reduce((n, m) => Math.max(n, Date.parse(m.receivedAt)), since);
		// With a backlog the cursor stops at the newest mail read; otherwise it moves to now.
		return { messages, nextCursor: String(backlog ? newestRead : Math.max(newestRead, this.now() - OVERLAP_MS)) };
	}

	async sendReply(
		_tenantId: string,
		args: { to: string; subject: string; bodyText: string; inReplyToMessageId: string; idempotencyKey: string },
	): Promise<{ sentMessageId: string }> {
		const messageId = `<owni.${createHash("sha256").update(args.idempotencyKey).digest("hex").slice(0, 32)}@owni.local>`;
		const earlier = await this.api<{ messages?: { id: string }[] }>(
			"messages.list",
			`${API}/messages?${new URLSearchParams({ q: `in:sent rfc822msgid:${messageId}`, maxResults: "1" })}`,
			{ retries: 2 },
		);
		const found = earlier.messages?.[0];
		if (found !== undefined) return { sentMessageId: found.id };

		const original = await this.api<GmailMessage>(
			"messages.get",
			`${API}/messages/${encodeURIComponent(args.inReplyToMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
			{ retries: 2 },
		);
		const originalId = header(original.payload, "Message-ID");
		const references = [header(original.payload, "References"), originalId].filter((v): v is string => v !== undefined && v !== "").join(" ");
		const raw = buildMime({
			from: await this.senderAddress(),
			to: args.to,
			subject: args.subject,
			bodyText: args.bodyText,
			messageId,
			...(originalId === undefined ? {} : { inReplyTo: originalId }),
			...(references === "" ? {} : { references }),
		});
		const sent = await this.api<{ id: string }>("messages.send", `${API}/messages/send`, { body: { raw, threadId: original.threadId } });
		return { sentMessageId: sent.id };
	}

	private async senderAddress(): Promise<string> {
		this.sender ??= (await this.api<{ emailAddress: string }>("getProfile", `${API}/profile`, { retries: 2 })).emailAddress;
		return this.sender;
	}

	private async api<T>(operation: string, url: string, request: { body?: unknown; retries?: number }): Promise<T> {
		const call = async () =>
			requestJson<T>(this.options.fetch, url, {
				connector: "gmail",
				operation,
				headers: { authorization: `Bearer ${await this.accessToken()}` },
				...(request.body === undefined ? {} : { body: request.body }),
				retries: request.retries ?? 0,
				...(this.options.retryBaseMs === undefined ? {} : { retryBaseMs: this.options.retryBaseMs }),
			});
		try {
			return await call();
		} catch (error) {
			// An access token revoked or expired early: refresh once and try again.
			if (!(error instanceof ConnectorHttpError) || error.status !== 401) throw error;
			this.token = undefined;
			return call();
		}
	}

	private async accessToken(): Promise<string> {
		if (this.token !== undefined && this.token.expiresAt > this.now()) return this.token.value;
		const credentials = await this.options.credentials();
		if (credentials === undefined) {
			throw new Error(`Gmail credentials missing: set tenant secrets ${Object.values(GMAIL_SECRETS).join(", ")}`);
		}
		const response = await this.options.fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				refresh_token: credentials.refreshToken,
				grant_type: "refresh_token",
			}),
		});
		const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
		if (!response.ok || body.access_token === undefined) {
			// invalid_grant: the refresh token was revoked or expired (7 days for apps in "Testing").
			throw new ConnectorHttpError("gmail", "token refresh", response.status, [body.error, body.error_description].filter(Boolean).join(": "));
		}
		// Refresh a minute early so a token never expires in the middle of a request.
		this.token = { value: body.access_token, expiresAt: this.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
		return this.token.value;
	}
}

function header(part: MessagePart | undefined, name: string): string | undefined {
	return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Gmail message (format=full) → InboundMail. `messageId` is Gmail's ID, used to reply. */
export function toInboundMail(message: GmailMessage): InboundMail {
	const from = header(message.payload, "From") ?? "";
	const fromName = /^\s*"?([^"<]*?)"?\s*</.exec(from)?.[1]?.trim();
	const inReplyTo = header(message.payload, "In-Reply-To");
	return {
		messageId: message.id,
		threadId: message.threadId,
		from,
		...(fromName ? { fromName } : {}),
		subject: header(message.payload, "Subject") ?? "",
		bodyText: bodyText(message.payload),
		receivedAt: new Date(Number(message.internalDate ?? "0")).toISOString(),
		...(inReplyTo === undefined ? {} : { inReplyTo }),
	};
}

/** The text/plain body; falls back to text/html with tags removed. Attachments are skipped. */
export function bodyText(part: MessagePart | undefined): string {
	const plain = findPart(part, "text/plain");
	if (plain !== undefined) return plain;
	const html = findPart(part, "text/html");
	return html === undefined ? "" : htmlToText(html);
}

function findPart(part: MessagePart | undefined, mimeType: string): string | undefined {
	if (part === undefined) return undefined;
	if (part.mimeType === mimeType && part.body?.data !== undefined) return Buffer.from(part.body.data, "base64url").toString("utf8");
	for (const child of part.parts ?? []) {
		const found = findPart(child, mimeType);
		if (found !== undefined) return found;
	}
	return undefined;
}

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** RFC 2822 text/plain message, UTF-8, base64url-encoded for messages.send. */
export function buildMime(m: { from: string; to: string; subject: string; bodyText: string; messageId: string; inReplyTo?: string; references?: string }): string {
	// A line break in a header value would let text from the model or a mail add headers (Bcc, To).
	for (const [name, value] of Object.entries({ from: m.from, to: m.to, subject: m.subject, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references })) {
		if (value !== undefined && /[\r\n]/.test(value)) throw new Error(`Gmail: line break in the ${name} header`);
	}
	const subject = /^re:/i.test(m.subject) || m.inReplyTo === undefined ? m.subject : `Re: ${m.subject}`;
	const lines = [
		`From: ${m.from}`,
		`To: ${m.to}`,
		`Subject: ${encodeHeader(subject)}`,
		`Message-ID: ${m.messageId}`,
		...(m.inReplyTo === undefined ? [] : [`In-Reply-To: ${m.inReplyTo}`]),
		...(m.references === undefined ? [] : [`References: ${m.references}`]),
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		(Buffer.from(m.bodyText, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
	];
	return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeader(value: string): string {
	return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
