import { readDocumentText } from "./document-reader.ts";
import { DocumentError, type DocumentText, documentKind, looksLikeDocument } from "./documents.ts";
import type { WebPage } from "./web-fetch.ts";

/**
 * Documents found on the web (ADR 0027): a link to a PDF, a Word file, a spreadsheet. They are
 * read with the reader of the files people send (ADR 0026), in its worker; what decides is the
 * content, not what the server says it is.
 */
export const WEB_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const DOCUMENT_TYPE = /^application\/(pdf|x-pdf|pkcs7-mime|x-pkcs7-mime|octet-stream|msword|vnd\.openxmlformats-officedocument\.[\w.+-]+|vnd\.oasis\.opendocument\.[\w.+-]+|vnd\.ms-[\w.+-]+|zip|force-download|download)$|^binary\/octet-stream$/;

/** Answers that may be a document, by content type or by the address's extension: these may be larger than a page. */
export function documentLimit(contentType: string, url?: URL): number | undefined {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (DOCUMENT_TYPE.test(type)) return WEB_DOCUMENT_MAX_BYTES;
	// A server that calls a PDF text/plain or nothing at all: the address says what it is.
	if (url !== undefined && !type.startsWith("text/html") && looksLikeDocument(urlFileName(url.toString()))) return WEB_DOCUMENT_MAX_BYTES;
	return undefined;
}

/** A name that is safe as a file name: letters of any language, digits, spaces, dot, dash, underscore. */
export function safeFileName(raw: string, fallback = "documento"): string {
	const clean = raw
		.replace(/[\uD800-\uDFFF]/g, "_")
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}_.\- ]+/gu, "_")
		.replace(/^[.\s]+/, "")
		.trim()
		.slice(0, 120);
	return clean === "" ? fallback : clean;
}

/** The file name a URL ends with, for the reader and for saving it; "documento" when there is none. */
export function urlFileName(url: string): string {
	let last = "";
	try {
		last = new URL(url).pathname.split("/").at(-1) ?? "";
		last = decodeURIComponent(last);
	} catch {
		// A broken escape: the name as it is.
	}
	return safeFileName(last);
}

/** The file name a Content-Disposition header gives (filename* before filename), or undefined. */
export function dispositionName(header: string | undefined): string | undefined {
	if (header === undefined || header.length > 2000) return undefined;
	const star = /filename\*\s*=\s*([\w-]+)'[^']*'([^;]+)/i.exec(header);
	if (star !== null) {
		try {
			const name = safeFileName(decodeURIComponent(star[2]?.trim() ?? ""), "");
			if (name !== "") return name;
		} catch {
			// Fall back to the plain parameter.
		}
	}
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header);
	const raw = plain?.[1] ?? plain?.[2];
	if (raw === undefined) return undefined;
	const name = safeFileName(raw.split(/[\\/]/).at(-1) ?? "", "");
	return name === "" ? undefined : name;
}

/** Links on a page to documents (PDF, Office, OpenDocument, CSV, signed files): absolute, once each, at most `max`. */
export function documentLinks(html: string, base: string, max = 20): string[] {
	const out = new Set<string>();
	for (const tag of html.matchAll(/<(?:a|iframe|embed|object)\s[^>]{0,2000}>/gi)) {
		const attr = /\s(?:href|src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
		const raw = (attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? "").trim().replace(/&amp;/g, "&");
		if (raw === "") continue;
		let url: URL;
		try {
			url = new URL(raw, base);
		} catch {
			continue;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		url.hash = "";
		if (!/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|p7m)$/i.test(url.pathname)) continue;
		out.add(url.toString());
		if (out.size >= max) break;
	}
	return [...out];
}

/** The page's document text, or undefined when the answer is not a document. */
export async function webDocument(page: WebPage, options: { timeoutMs?: number; waitMs?: number } = {}): Promise<DocumentText | undefined> {
	const name = urlFileName(page.url);
	if (documentKind(name, page.bytes) === undefined) {
		// A document cut at the size limit no longer opens: say so, rather than "not a page".
		if (page.truncated && looksLikeDocument(name)) throw new DocumentError(tooLarge());
		return undefined;
	}
	if (page.truncated) throw new DocumentError(tooLarge());
	return readDocumentText(name, page.bytes, options);
}

function tooLarge(): string {
	return `il documento è oltre ${WEB_DOCUMENT_MAX_BYTES / 1024 / 1024} MB, non posso leggerlo: posso solo darti il link`;
}
