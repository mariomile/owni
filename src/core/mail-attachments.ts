import { createHash } from "node:crypto";
import { ATTACHMENT_TYPES, contentMatches, refusedType } from "./attachment-types.ts";
import { oneLine, withoutFormatChars } from "./plain-text.ts";
import { type Workspace, WorkspaceError } from "./workspace.ts";

export { ATTACHMENT_TYPES };

/**
 * Files of the workspace attached to a mail Owni asks to send (google-actions.ts). A request keeps
 * only each file's path, name, size and hash: the file is read again when the person approves,
 * and goes only if it is still exactly the one shown on the card. Contents never reach the model,
 * the request or the logs.
 */
export type MailAttachment = {
	readonly path: string;
	/** The name the recipient sees: the file's own, without what could break a header. */
	readonly name: string;
	readonly size: number;
	readonly sha256: string;
	readonly contentType: string;
};

/** A file read back at approval, as the message carries it. */
export type AttachmentData = { readonly name: string; readonly contentType: string; readonly data: Buffer };

export class AttachmentError extends Error {
	override readonly name = "AttachmentError";
}

/**
 * Gmail takes 25 MB per message (25,000,000 bytes), counted after base64: 4/3 and a line break
 * every 76 characters. 17 MiB of files make about 24.4 MB, leaving room for the text and headers.
 */
export const ATTACHMENT_LIMITS = { maxFiles: 5, maxTotalBytes: 17 * 1024 * 1024, maxName: 120 } as const;

/** The extension, lower case, of a name ("" when none). */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The name the recipient sees: the last part of the path, without control or format characters, quotes or backslashes, at most maxName characters (the extension kept). */
export function attachmentName(path: string): string {
	const last = path.split(/[\\/]+/).filter(Boolean).at(-1) ?? "allegato";
	let name = withoutFormatChars(last)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/g, "")
		.trim();
	if (name === "" || name.startsWith(".")) name = `allegato${name}`;
	const chars = [...name];
	if (chars.length > ATTACHMENT_LIMITS.maxName) {
		const ext = extensionOf(name);
		const keep = ATTACHMENT_LIMITS.maxName - (ext === "" ? 0 : ext.length + 1);
		name = chars.slice(0, keep).join("") + (ext === "" ? "" : `.${ext}`);
	}
	return name;
}

/** «1 KB» at least, «84 KB», «1,2 MB», «18 MB». */
export function sizeText(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	const mb = bytes / (1024 * 1024);
	return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1).replace(".", ",")} MB`;
}

/** The attachments in one line, for the card: «Allegati: preventivi/Preventivo.pdf (84 KB), note/B-70.txt (3 KB)». Paths whole, on one line, without invisible characters. */
export function attachmentsLine(list: readonly MailAttachment[]): string {
	if (list.length === 0) return "";
	return `${list.length === 1 ? "Allegato" : "Allegati"}: ${list.map((a) => `${oneLine(a.path)} (${sizeText(a.size)})`).join(", ")}`;
}

/** Lookalikes of the letters of «alleg» (Cyrillic, Greek, digits, capital I), folded to them: one character for one, so positions hold. */
const LOOKALIKES: Readonly<Record<string, string>> = {
	"\u0430": "a", "\u0410": "a", "\u03b1": "a", "\u0391": "a", "\u0251": "a",
	I: "l", "1": "l", "|": "l", "\u04cf": "l", "\u04c0": "l", "\u03b9": "l", "\u0399": "l", "\u0456": "l", "\u0406": "l", "\u01c0": "l", "\u2113": "l",
	"\u0435": "e", "\u0415": "e", "\u03b5": "e", "\u0395": "e", "\u04bd": "e",
	"\u0261": "g", "\u0581": "g",
};

/**
 * Text written by Owni, with every word that reads as «alleg…» (Allegato, Allegati, also spelt
 * with lookalike letters or spaces) broken by a dot: on the card only the line the server writes
 * may name the attachments.
 */
export function withoutAttachmentWords(text: string): string {
	const plain = withoutFormatChars(text);
	const folded = [...plain].map((c) => (c.length === 1 ? (LOOKALIKES[c] ?? c) : "\0".repeat(c.length))).join("");
	let out = "";
	let last = 0;
	for (const m of folded.matchAll(/a\s*l\s*l\s*e\s*g/gi)) {
		out += `${plain.slice(last, m.index)}alleg.`;
		last = (m.index ?? 0) + m[0].length;
	}
	return out + plain.slice(last);
}

/** Why a request was not sent: one of its files is not the one the card showed. */
export function changedFile(name: string): string {
	return `Non inviata: il file ${name} è cambiato dopo la richiesta. Chiedi a Owni di prepararla di nuovo.`;
}

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** The workspace refused the path (going up, a hidden name, a symlink, outside): said in Italian. */
function refusedPath(path: string): AttachmentError {
	return new AttachmentError(`non posso allegare «${attachmentName(path)}»: il percorso non è un file del workspace che si può mandare (niente cartelle sopra, file nascosti o collegamenti)`);
}

/**
 * The files to attach, checked now: in the workspace, of an allowed type and content, within the
 * limits. Each is read through one handle that never follows a symlink; its size and hash are
 * kept, so the approval sends exactly these bytes.
 */
export async function attachFiles(workspace: Workspace, paths: readonly string[]): Promise<MailAttachment[]> {
	const unique = [
		...new Set(
			paths.map((p) =>
				String(p)
					.trim()
					.split(/[\\/]+/)
					.filter((x) => x !== "" && x !== ".")
					.join("/"),
			),
		),
	].filter((p) => p !== "");
	if (unique.length > ATTACHMENT_LIMITS.maxFiles) throw new AttachmentError(`al massimo ${ATTACHMENT_LIMITS.maxFiles} allegati per mail`);
	const tooLarge = () => new AttachmentError(`gli allegati superano ${sizeText(ATTACHMENT_LIMITS.maxTotalBytes)} in tutto, troppo per una mail: mandane meno, o mandali in chat`);
	const out: MailAttachment[] = [];
	let total = 0;
	for (const path of unique) {
		const name = attachmentName(path);
		const ext = extensionOf(name);
		const contentType = ATTACHMENT_TYPES[ext];
		if (contentType === undefined) throw new AttachmentError(refusedType(ext, name));
		const stat = await workspace.stat(path).catch((error: unknown) => {
			throw error instanceof WorkspaceError ? refusedPath(path) : error;
		});
		if (stat === undefined) throw new AttachmentError(`non trovo «${name}» nel workspace: cercalo con file_search o file_list`);
		if (total + stat.size > ATTACHMENT_LIMITS.maxTotalBytes) throw tooLarge();
		const read = await workspace.readExact(path, ATTACHMENT_LIMITS.maxTotalBytes - total).catch((error: unknown) => {
			if (!(error instanceof WorkspaceError)) throw error;
			throw error.message.startsWith("File too large") ? tooLarge() : refusedPath(path);
		});
		total += read.data.length;
		if (!contentMatches(ext, read.data)) throw new AttachmentError(`«${name}» non è davvero un file .${ext} che si può mandare: non lo allego`);
		out.push({ path: stat.path, name, size: read.data.length, sha256: sha256(read.data), contentType });
	}
	return out;
}

/** The files read again at approval, through a handle that never follows a symlink: each must still be there with the same bytes, or nothing is sent. */
export async function readAttachments(workspace: Workspace, list: readonly MailAttachment[]): Promise<AttachmentData[]> {
	if (list.length > ATTACHMENT_LIMITS.maxFiles || list.reduce((n, a) => n + a.size, 0) > ATTACHMENT_LIMITS.maxTotalBytes) throw new AttachmentError("Non inviata: troppi allegati per una mail.");
	const out: AttachmentData[] = [];
	for (const a of list) {
		let data: Buffer;
		try {
			data = (await workspace.readExact(a.path, a.size)).data;
		} catch (error) {
			if (error instanceof WorkspaceError) throw new AttachmentError(changedFile(a.name));
			throw error;
		}
		if (data.length !== a.size || sha256(data) !== a.sha256) throw new AttachmentError(changedFile(a.name));
		const type = ATTACHMENT_TYPES[extensionOf(a.name)];
		if (type === undefined || type !== a.contentType) throw new AttachmentError(`Non inviata: tipo di allegato non consentito (${a.name}).`);
		out.push({ name: a.name, contentType: a.contentType, data });
	}
	return out;
}
