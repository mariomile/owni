/**
 * Which files a mail may carry (mail-attachments.ts): documents an office sends, each checked to
 * be what its extension says. Nothing that runs: no executables, scripts, web pages, archives,
 * Office files with macros, RTF with embedded objects.
 */

/** Extensions allowed, and their content type. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	doc: "application/msword",
	xls: "application/vnd.ms-excel",
	ppt: "application/vnd.ms-powerpoint",
	rtf: "application/rtf",
	csv: "text/csv",
	txt: "text/plain",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	xml: "application/xml",
	p7m: "application/pkcs7-mime",
};

/** What the person can attach, said when a file is refused. */
const ATTACHMENT_KINDS = "PDF, Word, Excel, PowerPoint, OpenDocument (odt, ods), RTF, CSV, testo, immagini PNG e JPG, XML, file firmati p7m";

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from("PK\x03\x04", "latin1");
const BOM = /^\ufeff/;

/** The names in a zip's central directory, or undefined when it does not read as a zip. Minimal: no zip64, no encryption. */
function zipNames(data: Buffer): string[] | undefined {
	// The end of central directory record: 22 bytes, then a comment of up to 65535.
	const from = Math.max(0, data.length - 22 - 0xffff);
	let end = -1;
	for (let i = data.length - 22; i >= from; i--) {
		if (data.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) return undefined;
	const count = data.readUInt16LE(end + 10);
	const size = data.readUInt32LE(end + 12);
	let at = data.readUInt32LE(end + 16);
	if (at + size > end || count === 0xffff) return undefined;
	const names: string[] = [];
	for (let n = 0; n < count; n++) {
		if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) return undefined;
		const nameLength = data.readUInt16LE(at + 28);
		const extraLength = data.readUInt16LE(at + 30);
		const commentLength = data.readUInt16LE(at + 32);
		if (at + 46 + nameLength > end) return undefined;
		names.push(data.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
		at += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

/** Markup a mail program could render, where a text file starts. */
const MARKUP_START = /<(html|!doctype\s+html|script|body|svg|iframe)\b/i;

/**
 * Text that is not markup a mail program could render: no NUL (unless UTF-16 with its byte order
 * mark), no HTML, script, SVG or frame near the start.
 */
function plainText(data: Buffer): boolean {
	const le = data[0] === 0xff && data[1] === 0xfe;
	const be = data[0] === 0xfe && data[1] === 0xff;
	let start: string;
	if (le || be) {
		const head = Buffer.from(data.subarray(2, 2050));
		if (head.length % 2 === 1) head[head.length - 1] = 0x20;
		if (be) head.swap16();
		start = head.toString("utf16le");
	} else {
		if (data.includes(0)) return false;
		start = data.subarray(0, 1024).toString("utf8").replace(BOM, "");
	}
	return !MARKUP_START.test(start.slice(0, 1024));
}

/** Script anywhere in an XML file: a script element, or SVG with event handlers. */
const XML_SCRIPT = /<([\w.-]+:)?script\b/i;
const XML_SVG = /<([\w.-]+:)?svg\b/i;
const XML_HANDLER = /\son[a-z]+\s*=/i;
/** Pieces the whole file is scanned in, overlapping so a tag across two pieces is still seen. */
const SCAN_PIECE = 1024 * 1024;
const SCAN_OVERLAP = 256;

/** An XML document: a declaration or a root element, no HTML in its first 64 KB, no script anywhere. */
function xmlText(data: Buffer): boolean {
	if (data.includes(0)) return false;
	const head = data.subarray(0, 64 * 1024).toString("utf8").replace(BOM, "");
	const start = head.trimStart();
	if (!start.startsWith("<?xml") && !/^<[A-Za-z_]/.test(start)) return false;
	if (/<html\b/i.test(head)) return false;
	let svg = false;
	let handler = false;
	for (let at = 0; at < data.length; at += SCAN_PIECE) {
		const piece = data.subarray(Math.max(0, at - SCAN_OVERLAP), at + SCAN_PIECE).toString("utf8");
		if (XML_SCRIPT.test(piece)) return false;
		svg ||= XML_SVG.test(piece);
		handler ||= XML_HANDLER.test(piece);
		if (svg && handler) return false;
	}
	return true;
}

/** Macros in a package: a VBA project in an Office file, Basic or scripts in an OpenDocument one. */
function macroEntry(name: string): boolean {
	return /(^|\/)vbaProject\.bin$/i.test(name) || /^(word|xl|ppt)\/.*vba[^/]*\.bin$/i.test(name) || /^(Basic|Scripts)\//.test(name);
}

/** An Office Open XML or OpenDocument package, without macros. */
function officeZip(data: Buffer, kind: "ooxml" | "odf"): boolean {
	if (!data.subarray(0, 4).equals(ZIP)) return false;
	const names = zipNames(data);
	if (names === undefined) return false;
	if (names.some(macroEntry)) return false;
	return kind === "ooxml" ? names.includes("[Content_Types].xml") : names.includes("mimetype");
}

/** Storage names that hold a VBA project in an old Office file. */
const OLE_MACROS = new Set(["_vba_project", "_vba_project_cur", "macros", "vba"]);

/**
 * An old Office file (OLE compound file) without macros. Directory entries are 128 bytes and sit
 * at multiples of 128 after the 512-byte header: each is looked at as one, by its UTF-16LE name
 * and its type, without following the allocation table.
 */
function oleDocument(data: Buffer): boolean {
	if (!data.subarray(0, 8).equals(OLE)) return false;
	for (let at = 512; at + 128 <= data.length; at += 128) {
		const length = data.readUInt16LE(at + 64);
		const type = data[at + 66];
		if (length < 4 || length > 64 || length % 2 !== 0 || (type !== 1 && type !== 2)) continue;
		const name = data.subarray(at, at + length - 2).toString("utf16le");
		if (OLE_MACROS.has(name.toLowerCase())) return false;
	}
	return true;
}

/** RTF without embedded objects (which carry OLE files of their own). */
function rtfText(data: Buffer): boolean {
	if (data.subarray(0, 5).toString("latin1") !== "{\\rtf") return false;
	return !/\\obj(ect|data|update|autlink)/i.test(data.toString("latin1"));
}

/** OID 1.2.840.113549.1.7.2 (PKCS #7 signedData), DER encoded. */
const SIGNED_DATA = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);

/**
 * A signed file (.p7m): a SEQUENCE whose length fits the file (or is indefinite, as some signing
 * programs write it), with the signedData OID right after its header.
 */
function signedFile(data: Buffer): boolean {
	if (data[0] !== 0x30 || data.length < 2) return false;
	const first = data[1] as number;
	let header = 2;
	if (first > 0x80) {
		const bytes = first & 0x7f;
		if (bytes > 4 || data.length < 2 + bytes) return false;
		const length = data.readUIntBE(2, bytes);
		header = 2 + bytes;
		if (length === 0 || header + length > data.length) return false;
	} else if (first < 0x80) {
		if (first === 0 || 2 + first > data.length) return false;
	}
	return data.subarray(header, header + 32).includes(SIGNED_DATA);
}

/** Whether `data` is what extension `ext` says (lower case, one of ATTACHMENT_TYPES). */
export function contentMatches(ext: string, data: Buffer): boolean {
	switch (ext) {
		case "pdf":
			return data.subarray(0, 5).toString("latin1") === "%PDF-";
		case "docx":
		case "xlsx":
		case "pptx":
			return officeZip(data, "ooxml");
		case "odt":
		case "ods":
			return officeZip(data, "odf");
		case "doc":
		case "xls":
		case "ppt":
			return oleDocument(data);
		case "rtf":
			return rtfText(data);
		case "png":
			return data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		case "jpg":
		case "jpeg":
			return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
		case "p7m":
			return signedFile(data);
		case "xml":
			return xmlText(data);
		case "csv":
		case "txt":
			return plainText(data);
		default:
			return false;
	}
}

/** Why an extension is refused, in Italian: a hint where there is one. */
export function refusedType(ext: string, name: string): string {
	if (ext === "") return `non allego «${name}»: il file non ha estensione. Posso allegare ${ATTACHMENT_KINDS}`;
	if (ext === "heic" || ext === "heif") return `non allego «${name}»: le foto HEIC molti non le aprono, converti la foto in JPG`;
	return `non allego «${name}»: i file .${ext} non si mandano. Posso allegare ${ATTACHMENT_KINDS}`;
}
