import { randomBytes } from "node:crypto";
import { validAddress } from "./email-address.ts";
import type { MailDraft } from "./mail-draft.ts";
import type { AttachmentData } from "./mail-attachments.ts";

/** A mail that cannot be written safely: in Italian, the person reads it on the card. */
class MailMimeError extends Error {
	override readonly name = "MailMimeError";
}

/** One header value: no line breaks; outside ASCII, RFC 2047 encoded-words of at most 75 characters, folded. */
function headerValue(value: string): string {
	if (/[\r\n]/.test(value)) throw new MailMimeError("un'intestazione della mail non può andare a capo");
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const words: string[] = [];
	let chunk = "";
	// 39 bytes of UTF-8 become 52 of base64: with "=?UTF-8?B?", "?=" and "Subject: ", 73. Characters are never split.
	for (const char of value) {
		if (Buffer.byteLength(chunk + char) > 39) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk !== "") words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** The ids of a References header as a reply carries them: well-formed ones only, the last ten, folded. */
function references(previous: string, messageId: string): string {
	const ids = [...`${previous} ${messageId}`.matchAll(/<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>/g)].map((m) => m[0]);
	return [...new Set(ids)].slice(-10).join("\r\n ");
}

/** Base64 in lines of 76 characters (RFC 2045), written into one buffer piece by piece: no string as large as the file. */
export function base64Lines(data: Buffer): Buffer {
	const lines = Math.ceil(data.length / 57);
	if (lines === 0) return Buffer.alloc(0);
	const out = Buffer.allocUnsafe(Math.ceil(data.length / 3) * 4 + (lines - 1) * 2);
	let at = 0;
	// 57 bytes make a line of 76: a piece of 1024 lines never ends in padding but the last.
	const step = 57 * 1024;
	for (let i = 0; i < data.length; i += step) {
		const text = data.subarray(i, i + step).toString("base64");
		for (let j = 0; j < text.length; j += 76) {
			if (at > 0) at += out.write("\r\n", at, "latin1");
			at += out.write(text.slice(j, j + 76), at, "latin1");
		}
	}
	return out;
}

/** Longest ASCII name parameter kept on one line. */
const ASCII_NAME = 60;

/**
 * A file name safe in a quoted parameter: printable ASCII without quotes, backslashes, semicolons
 * or «=?» (which some programs would decode as an encoded-word); the rest becomes "_". At most
 * ASCII_NAME characters, the extension kept.
 */
function asciiName(name: string): string {
	const plain = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	const safe = plain.replace(/[^\x20-\x7e]|["\\;]/g, "_").replace(/=\?/g, "=_") || "allegato";
	if (safe.length <= ASCII_NAME) return safe;
	const dot = safe.lastIndexOf(".");
	const ext = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : "";
	return safe.slice(0, ASCII_NAME - ext.length) + ext;
}

/**
 * The name parameters of an attachment. Short ASCII names: quoted. Others: an ASCII fallback, then
 * RFC 2231 (filename*, percent-encoded UTF-8, split into continuations), which mail programs
 * prefer; Content-Type's name also as RFC 2047 encoded-words, for the older ones, unless the name
 * itself holds «=?», which then gets the ASCII fallback there too.
 */
function nameParams(name: string): { type: string; disposition: string } {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (/[\u0000-\u001f\u007f"\\]/.test(name)) throw new MailMimeError("nome di allegato non valido");
	const encodedLookalike = name.includes("=?");
	if (/^[\x20-\x7e]*$/.test(name) && !name.includes(";") && !encodedLookalike && name.length <= ASCII_NAME) return { type: `name="${name}"`, disposition: `filename="${name}"` };
	// Percent-encoded UTF-8 in pieces of whole characters, so each continuation decodes on its own.
	const pieces: string[] = [];
	let piece = "";
	for (const char of name) {
		const code = [...Buffer.from(char, "utf8")].map((b) => (b < 0x80 && /[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
		if (piece.length + code.length > 54) {
			pieces.push(piece);
			piece = "";
		}
		piece += code;
	}
	if (piece !== "") pieces.push(piece);
	const star = pieces.length === 1 ? `filename*=UTF-8''${pieces[0]}` : pieces.map((p, i) => `filename*${i}*=${i === 0 ? "UTF-8''" : ""}${p}`).join(";\r\n ");
	const ascii = asciiName(name);
	return { type: `name="${encodedLookalike ? ascii : headerValue(name)}"`, disposition: `filename="${ascii}";\r\n ${star}` };
}

/** A boundary found nowhere in the parts. */
function boundaryFor(parts: readonly Buffer[]): string {
	for (;;) {
		const boundary = `=_owni_${randomBytes(18).toString("hex")}`;
		if (!parts.some((p) => p.includes(boundary))) return boundary;
	}
}

/**
 * The mail as Gmail takes it (RFC 2822), ASCII, as a buffer. The sender is the account itself.
 * Without attachments, plain text; with them, multipart/mixed: the text first, then each file in
 * base64. The files' own buffers are only read: the caller drops them once this returns.
 */
export function mimeMessage(mail: MailDraft, attachments: readonly AttachmentData[] = []): Buffer {
	if ([...mail.to, ...mail.cc].some((a) => !validAddress(a))) throw new MailMimeError("indirizzo non valido");
	const replyId = mail.inReplyTo === undefined ? "" : (/^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.exec(mail.inReplyTo.messageId.trim())?.[0] ?? "");
	const head = [
		`To: ${mail.to.join(", ")}`,
		...(mail.cc.length === 0 ? [] : [`Cc: ${mail.cc.join(", ")}`]),
		`Subject: ${headerValue(mail.subject)}`,
		...(replyId === "" ? [] : [`In-Reply-To: ${replyId}`, `References: ${references(mail.inReplyTo?.references ?? "", replyId)}`]),
		"MIME-Version: 1.0",
	];
	const text = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
	const body = base64Lines(Buffer.from(mail.body, "utf8"));
	if (attachments.length === 0) return Buffer.concat([Buffer.from(`${[...head, ...text].join("\r\n")}\r\n\r\n`, "latin1"), body]);
	const parts: { head: Buffer; body: Buffer }[] = [
		{ head: Buffer.from(text.join("\r\n"), "latin1"), body },
		...attachments.map((a) => {
			if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(a.contentType)) throw new MailMimeError("tipo di allegato non valido");
			const names = nameParams(a.name);
			return { head: Buffer.from(`Content-Type: ${a.contentType};\r\n ${names.type}\r\nContent-Disposition: attachment;\r\n ${names.disposition}\r\nContent-Transfer-Encoding: base64`, "latin1"), body: base64Lines(a.data) };
		}),
	];
	const boundary = boundaryFor(parts.flatMap((p) => [p.head, p.body]));
	const top = Buffer.from(`${[...head, `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`].join("\r\n")}\r\n\r\n`, "latin1");
	const chunks = parts.flatMap((p) => [Buffer.from(`--${boundary}\r\n`, "latin1"), p.head, Buffer.from("\r\n\r\n", "latin1"), p.body, Buffer.from("\r\n", "latin1")]);
	return Buffer.concat([top, ...chunks, Buffer.from(`--${boundary}--\r\n`, "latin1")]);
}
