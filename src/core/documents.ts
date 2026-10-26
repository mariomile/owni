import { withoutBidiControls, xmlUnescape } from "./html-text.ts";
import { isSignedEnvelope, P7mError, signedContent, signedContentStart } from "./p7m.ts";
import { PdfError, pdfText, trimLines } from "./pdf-text.ts";
import { Zip, ZipError } from "./zip.ts";

/**
 * Text out of the documents people send (ADR 0026): PDF, Word, Excel, PowerPoint and their
 * OpenDocument cousins. Any of them signed (.p7m, p7m.ts) is read as what it holds. No new dependencies: ZIP and XML
 * for the office formats, a small PDF reader for PDF. What comes out is text for the model, with
 * the document's structure kept where it helps (pages, sheets, slides, table cells), never the
 * formatting.
 */
export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";

export type DocumentText = {
	readonly kind: DocumentKind;
	readonly text: string;
	/** Pages, sheets or slides, when the format has them. */
	readonly parts?: number;
	/** What could not be read, in Italian, for the model to pass on. */
	readonly note?: string;
};

export class DocumentError extends Error {
	override readonly name = "DocumentError";
}

const LABEL: Record<DocumentKind, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PowerPoint", odt: "OpenDocument (testo)", ods: "OpenDocument (foglio di calcolo)", odp: "OpenDocument (presentazione)" };

export function documentLabel(kind: DocumentKind): string {
	return LABEL[kind];
}

const PART_NAMES: Record<DocumentKind, readonly [string, string]> = {
	pdf: ["pagina", "pagine"],
	docx: ["parte", "parti"],
	odt: ["parte", "parti"],
	xlsx: ["foglio", "fogli"],
	ods: ["foglio", "fogli"],
	pptx: ["diapositiva", "diapositive"],
	odp: ["diapositiva", "diapositive"],
};

/** «2 pagine», «1 foglio», «3 diapositive». */
export function documentPartsLabel(kind: DocumentKind, parts: number): string {
	return `${parts} ${PART_NAMES[kind][parts === 1 ? 0 : 1]}`;
}

/** The page, sheet or slide a piece starts in; for a sheet also its first row, usually the headings. */
export function documentSectionAt(text: string, at: number): string | undefined {
	let found: RegExpExecArray | undefined;
	const marker = sectionMarker();
	for (let m = marker.exec(text); m !== null && m.index < at; m = marker.exec(text)) found = m;
	if (found === undefined) return undefined;
	const name = found[1] ?? found[2] ?? "";
	if (!name.startsWith("Foglio")) return name;
	const lineEnd = text.indexOf("\n", found.index);
	const first = lineEnd < 0 ? "" : (text.slice(lineEnd + 1, lineEnd + 401).split("\n")[0] ?? "");
	return first === "" ? name : `${name}, prima riga: ${first}`;
}

/** The lines where a page, a sheet or a slide starts in a document's text, as [start, end) ranges. */
export function documentSectionLines(text: string): { start: number; end: number }[] {
	return [...text.matchAll(sectionMarker())].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** Whether a document's text has any word beyond the page and sheet lines: a scan has none. */
export function documentHasWords(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text.replace(sectionMarker(), ""));
}

/** «--- Pagina 3 ---», «## Foglio «Ordini» (4 righe…)», «## Diapositiva 2…»: how documentText marks the parts. */
function sectionMarker(): RegExp {
	return /^(?:--- (Pagina \d+) ---|## (Foglio «[^»\n]*»|Diapositiva \d+)[^\n]*)$/gm;
}

/** What kind of document this is, from its bytes (the name only breaks ties among ZIP files). */
export function documentKind(name: string, data: Uint8Array): DocumentKind | undefined {
	if (isSignedEnvelope(data)) return signedKind(name, data);
	const start = startKind(data);
	if (start === "pdf") return "pdf";
	if (start === undefined) return undefined;
	let zip: Zip;
	try {
		zip = new Zip(Buffer.from(data));
	} catch {
		return undefined;
	}
	if (zip.has("word/document.xml")) return "docx";
	if (zip.has("xl/workbook.xml")) return "xlsx";
	if (zip.has("ppt/presentation.xml")) return "pptx";
	if (zip.has("content.xml")) {
		const mime = safeText(zip, "mimetype") ?? "";
		if (mime.includes("opendocument.text")) return "odt";
		if (mime.includes("opendocument.spreadsheet")) return "ods";
		if (mime.includes("opendocument.presentation")) return "odp";
		const ext = name.toLowerCase().split(".").at(-1);
		if (ext === "odt" || ext === "ods" || ext === "odp") return ext;
	}
	return undefined;
}

/** What the first bytes say: a ZIP's local header, a PDF's (readers accept a little junk before it; a text that mentions %PDF- later is still text), or neither. */
function startKind(data: Uint8Array): "pdf" | "zip" | undefined {
	if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return "zip";
	const header = Buffer.from(data.subarray(0, 1024)).indexOf("%PDF-");
	return header >= 0 && header < 16 ? "pdf" : undefined;
}

const NOT_A_DOCUMENT = "il file è rovinato o non è un documento che so leggere (PDF, Word, Excel, PowerPoint, OpenDocument o .p7m)";

/** How much of a signed file's content is looked at to tell what it is: a ZIP format's first entries are in it. */
const SIGNED_SNIFF_BYTES = 256 * 1024;

/**
 * What a signed file holds, from the start of its content only, so telling it costs the same for
 * any size: a PDF, or a ZIP format by the names of its first entries (or, when they do
 * not say, the extension of what was signed). The whole content is opened only to read it, in the
 * worker. Undefined when the envelope does not open or holds nothing known.
 */
function signedKind(name: string, data: Uint8Array): DocumentKind | undefined {
	const start = signedContentStart(data, SIGNED_SNIFF_BYTES);
	if (start === undefined) return undefined;
	const kind = startKind(start);
	if (kind !== "zip") return kind;
	const ext = unsignedName(name).toLowerCase().split(".").at(-1);
	return zipKindAtStart(start) ?? (ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "odt" || ext === "ods" || ext === "odp" ? ext : undefined);
}

/**
 * A ZIP format from the start of the archive, walking its local headers one after the other: an
 * entry under word/, xl/ or ppt/, or an OpenDocument's «mimetype», which is stored first and
 * uncompressed. When an entry's size comes after its data (bit 3), the next header is looked for.
 */
function zipKindAtStart(data: Uint8Array): DocumentKind | undefined {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let at = 0;
	for (let entry = 0; entry < 1000 && at >= 0 && at + 30 <= bytes.length && bytes.readUInt32LE(at) === 0x04034b50; entry++) {
		const nameEnd = Math.min(bytes.length, at + 30 + bytes.readUInt16LE(at + 26));
		const entryName = bytes.toString("latin1", at + 30, nameEnd);
		if (entryName.startsWith("word/")) return "docx";
		if (entryName.startsWith("xl/")) return "xlsx";
		if (entryName.startsWith("ppt/")) return "pptx";
		const contentAt = nameEnd + bytes.readUInt16LE(at + 28);
		const size = bytes.readUInt32LE(at + 18);
		if (entryName === "mimetype") {
			const mime = bytes.toString("latin1", contentAt, Math.min(bytes.length, contentAt + Math.min(size, 100)));
			if (mime.includes("opendocument.text")) return "odt";
			if (mime.includes("opendocument.spreadsheet")) return "ods";
			if (mime.includes("opendocument.presentation")) return "odp";
		}
		at = (bytes.readUInt16LE(at + 6) & 0x08) !== 0 ? bytes.indexOf(ZIP_ENTRY, contentAt) : contentAt + size;
	}
	return undefined;
}

const ZIP_ENTRY = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** «contratto.pdf.p7m» → «contratto.pdf»: the name of what was signed. */
function unsignedName(name: string): string {
	return name.replace(/\.p7m$/i, "");
}

/** The document inside a signed file, or the bytes as they are; a P7mError when the envelope is broken. */
export function unsignedData(data: Uint8Array): Uint8Array {
	return isSignedEnvelope(data) ? signedContent(data) : data;
}

/** The largest signed text file opened where it is asked for, outside the worker. */
const SIGNED_TEXT_BYTES = 1024 * 1024;

/**
 * The text of a small signed text or CSV file (note.txt.p7m, elenco.csv.p7m), with the signature
 * said, not verified; undefined for anything else, a broken envelope included.
 */
export function signedPlainText(name: string, data: Uint8Array): { text: string; note: string } | undefined {
	if (!/\.(txt|csv)\.p7m$/i.test(name) || data.length > SIGNED_TEXT_BYTES || !isSignedEnvelope(data)) return undefined;
	let inner: Uint8Array;
	try {
		inner = signedContent(data);
	} catch {
		return undefined;
	}
	if (isSignedEnvelope(inner) || inner.includes(0)) return undefined;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(inner);
	} catch {
		// Not UTF-8: a CSV saved by Excel on Windows, accented letters in latin1.
		text = Buffer.from(inner).toString("latin1");
	}
	return { text: withoutBidiControls(text.replace(/^\ufeff/, "")), note: SIGNED };
}

/** Names that promise a document: one of these that does not open is broken, not text. */
export function looksLikeDocument(name: string): boolean {
	return /\.(pdf|docx|xlsx|pptx|odt|ods|odp|p7m)$/i.test(name);
}

/** The extension a document's file should have; a signed file adds .p7m (pdf.p7m). */
export function documentExtension(kind: DocumentKind, data: Uint8Array): string {
	return isSignedEnvelope(data) ? `${kind}.p7m` : kind;
}

/**
 * What to say about a file in a format that is not read here: the old Office formats and RTF.
 * Undefined for any other file.
 */
export function oldFormatAdvice(name: string, data: Uint8Array): string | undefined {
	const ext = name.toLowerCase().split(".").at(-1) ?? "";
	if (Buffer.from(data.subarray(0, 8)).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
		if (ext === "xls") return "è un foglio Excel nel vecchio formato .xls: non lo leggo direttamente. Se hai il computer, leggilo con python e xlrd; altrimenti chiedi di salvarlo come .xlsx o PDF.";
		if (ext === "ppt") return "è una presentazione PowerPoint nel vecchio formato .ppt: non la leggo. Chiedi di salvarla come .pptx o PDF.";
		if (ext === "doc") return "è un documento Word nel vecchio formato .doc: non lo leggo. Chiedi di salvarlo come .docx o PDF.";
		return "è un file Office nel vecchio formato: non lo leggo. Chiedi di salvarlo come .docx, .xlsx, .pptx o PDF.";
	}
	if (Buffer.from(data.subarray(0, 5)).toString("latin1") === "{\\rtf") return "è un documento RTF: se hai il computer, convertilo in testo con pandoc (pandoc -t plain); altrimenti chiedi di salvarlo come .docx o PDF.";
	return undefined;
}

/** The document's text, or a DocumentError saying in Italian why not. A signed file is read as what it holds, with the signature said, not verified. */
export function documentText(name: string, data: Uint8Array): DocumentText {
	if (isSignedEnvelope(data)) return signedText(name, data);
	const kind = documentKind(name, data);
	if (kind === undefined) throw new DocumentError(NOT_A_DOCUMENT);
	return readKind(kind, data);
}

function signedText(name: string, data: Uint8Array): DocumentText {
	let inner: Uint8Array;
	try {
		inner = signedContent(data);
	} catch (error) {
		if (error instanceof P7mError) throw new DocumentError(error.message);
		throw error;
	}
	const kind = documentKind(unsignedName(name), inner);
	if (kind === undefined) throw new DocumentError("è un file firmato digitalmente (.p7m), ma quello che contiene non è un documento che so leggere (PDF, Word, Excel, PowerPoint, OpenDocument)");
	const doc = readKind(kind, inner);
	const note = doc.note === undefined ? SIGNED : `${SIGNED} ${doc.note}`;
	return { ...doc, note };
}

const SIGNED = "Firma digitale presente, non verificata.";

function readKind(kind: DocumentKind, data: Uint8Array): DocumentText {
	try {
		if (kind === "pdf") {
			const pdf = pdfText(Buffer.from(data));
			return { kind, text: pdf.text, parts: pdf.pages, ...(pdf.note === undefined ? {} : { note: pdf.note }) };
		}
		const zip = new Zip(Buffer.from(data));
		if (kind === "docx") return { kind, text: docxText(zip) };
		if (kind === "xlsx") return { kind, ...xlsxText(zip) };
		if (kind === "pptx") return { kind, ...pptxText(zip) };
		return { kind, ...odfText(zip, kind) };
	} catch (error) {
		if (error instanceof ZipError || error instanceof PdfError || error instanceof P7mError) throw new DocumentError(error.message);
		// Anything else is a file the readers did not expect: broken, as far as the person is concerned.
		throw new DocumentError(error instanceof RangeError ? "il documento è troppo complesso da leggere" : NOT_A_DOCUMENT);
	}
}

function safeText(zip: Zip, name: string): string | undefined {
	try {
		return zip.text(name);
	} catch {
		return undefined;
	}
}

/** Collapse what the walkers leave: spaces at line ends, runs of blank lines; and bidi controls, which would reorder what is read. */
function tidy(text: string): string {
	return trimLines(withoutBidiControls(text)).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Word: the letterhead (headers), the body, footnotes and endnotes, the footers. Paragraphs on their
 * own lines, headings as «#», list items as «-», links with their address, table rows on one line
 * with cells split by tabs.
 */
function docxText(zip: Zip): string {
	const rels = rawRelationships(zip, "word/_rels/document.xml.rels");
	const parts = (pattern: RegExp) =>
		zip
			.names()
			.filter((name) => pattern.test(name))
			.sort()
			.map((name) => tidy(wordRuns(zip.text(name) ?? "", rawRelationships(zip, `word/_rels/${name.slice("word/".length)}.rels`))))
			.filter((text) => text !== "");
	const unique = (list: string[]) => [...new Set(list)];
	const headers = unique(parts(/^word\/header\d*\.xml$/));
	const footers = unique(parts(/^word\/footer\d*\.xml$/));
	// Notes are numbered as Word shows them, 1, 2, 3, not by their internal ids.
	const numbers = new Map<string, number>();
	const notes = [...wordNotes(zip.text("word/footnotes.xml") ?? "", "footnote", numbers), ...wordNotes(zip.text("word/endnotes.xml") ?? "", "endnote", numbers)];
	const out: string[] = [];
	if (headers.length > 0) out.push(`[Intestazione] ${headers.join(" / ")}`);
	out.push(tidy(wordRuns(zip.text("word/document.xml") ?? "", rels, numbers)));
	if (notes.length > 0) out.push(`[Note]\n${notes.join("\n")}`);
	if (footers.length > 0) out.push(`[Piè di pagina] ${footers.join(" / ")}`);
	return tidy(out.join("\n\n"));
}

/** Footnotes or endnotes, numbered as in the text; the separators Word keeps there are skipped. */
function wordNotes(xml: string, kind: "footnote" | "endnote", numbers: Map<string, number>): string[] {
	const notes: string[] = [];
	for (const piece of xml.split(`</w:${kind}>`)) {
		const open = piece.lastIndexOf(`<w:${kind} `);
		if (open < 0) continue;
		const attrs = piece.slice(open, piece.indexOf(">", open));
		if (attribute(attrs, "w:type") !== undefined) continue;
		const text = tidy(wordRuns(piece.slice(open), new Map())).replace(/\s*\n\s*/g, " ");
		if (text === "") continue;
		const n = numbers.size + 1;
		numbers.set(`${kind}:${attribute(attrs, "w:id") ?? n}`, n);
		notes.push(`${n}. ${text}`);
	}
	return notes;
}

function wordRuns(xml: string, rels: Map<string, string>, notes: Map<string, number> = new Map()): string {
	let out = "";
	// Paragraphs inside a table cell become spaces, so each row stays on one line, cells split by tabs.
	let cells = 0;
	const links: (string | undefined)[] = [];
	for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<(\/?)w:(tab|br|cr|p|tc|tr|hyperlink|numPr|pStyle|footnoteReference|endnoteReference)\b([^>]*)>/g)) {
		const [, text, close, tag, attrs = ""] = m;
		if (text !== undefined) {
			out += xmlUnescape(text);
			continue;
		}
		const selfClosing = attrs.endsWith("/");
		if (tag === "tab") out += "\t";
		else if (tag === "br" || tag === "cr") out += cells > 0 ? " " : "\n";
		else if (tag === "tc") {
			if (close === "/") {
				cells = Math.max(0, cells - 1);
				out = `${trimEndOf(out, " ")}\t`;
			} else if (!selfClosing) cells++;
		} else if (tag === "tr") {
			if (close === "/") out = `${trimEndOf(out, " \t")}\n`;
		} else if (tag === "p") {
			if (close === "/" || selfClosing) out += cells > 0 ? " " : "\n";
		} else if (tag === "hyperlink") {
			if (close === "/") {
				const url = links.pop();
				if (url !== undefined) out += ` (${url})`;
			} else if (!selfClosing) {
				const id = attribute(attrs, "r:id");
				const url = id === undefined ? undefined : rels.get(id);
				links.push(url !== undefined && /^(https?:|mailto:)/i.test(url) ? url : undefined);
			}
		} else if (tag === "numPr" && close !== "/") out += "- ";
		else if (tag === "pStyle") {
			// Heading 1 is «Heading1» in English Word and «Titolo1» in Italian; the title is «Title» or «Titolo».
			const name = attribute(attrs, "w:val") ?? "";
			const style = /^(?:heading|titolo|title)\s*(\d?)$/i.exec(name);
			if (style !== null && cells === 0) out += `${"#".repeat(Math.min(Number(style[1] || "1"), 6))} `;
			else if (/^(?:list|elenco|paragrafoelenco)/i.test(name) && !/^list ?paragraph$/i.test(name)) out += "- ";
		} else if ((tag === "footnoteReference" || tag === "endnoteReference") && close !== "/") {
			const kind = tag === "footnoteReference" ? "footnote" : "endnote";
			out += `[${notes.get(`${kind}:${attribute(attrs, "w:id")}`) ?? "*"}]`;
		}
	}
	return out;
}

/** Without the trailing characters in `chars`, looking only at the end of the text. */
function trimEndOf(text: string, chars: string): string {
	let end = text.length;
	while (end > 0 && chars.includes(text[end - 1] as string)) end--;
	return end === text.length ? text : text.slice(0, end);
}

/** The relationships of a part: id → target path, resolved against the part's folder. */
function relationships(zip: Zip, folder: string, relsPath: string): Map<string, string> {
	const rels = new Map<string, string>();
	const xml = zip.text(relsPath) ?? "";
	for (const m of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
		const attrs = m[1] ?? "";
		const id = attribute(attrs, "Id");
		const target = attribute(attrs, "Target");
		if (id === undefined || target === undefined) continue;
		rels.set(id, resolvePath(folder, xmlUnescape(target)));
	}
	return rels;
}

/** The relationships of a part as written: links to the web keep their address. */
function rawRelationships(zip: Zip, relsPath: string): Map<string, string> {
	const rels = new Map<string, string>();
	let xml: string;
	try {
		xml = zip.text(relsPath) ?? "";
	} catch {
		return rels;
	}
	for (const m of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
		const id = attribute(m[1] ?? "", "Id");
		const target = attribute(m[1] ?? "", "Target");
		if (id !== undefined && target !== undefined) rels.set(id, xmlUnescape(target));
	}
	return rels;
}

function resolvePath(folder: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = folder === "" ? [] : folder.split("/");
	for (const piece of target.split("/")) {
		if (piece === "..") parts.pop();
		else if (piece !== "." && piece !== "") parts.push(piece);
	}
	return parts.join("/");
}

/**
 * Excel: each sheet by name and size, rows as lines, cells by tabs, values as Excel shows them:
 * dates and times, percentages, money with its symbol, the decimals of the format, Italian separators.
 */
function xlsxText(zip: Zip): { text: string; parts: number } {
	const sheets = xlsxSheets(zip, false);
	const out = sheets.map((sheet) => {
		const rows: string[] = [];
		let widest = 0;
		let lastRow = 0;
		for (const row of sheet.rows) {
			// After empty rows, the row number: the model can still say «riga 500».
			if (row.number > lastRow + 1 && lastRow > 0) rows.push(`[riga ${row.number}]`);
			lastRow = row.number;
			rows.push(row.cells.join("\t"));
			widest = Math.max(widest, row.cells.length);
		}
		const columns = widest <= 1 ? "colonna A" : `colonne A-${columnName(widest - 1)}`;
		const size = rows.length === 0 ? "vuoto" : `${lastRow} ${lastRow === 1 ? "riga" : "righe"}, ${columns}`;
		const notes = [sheet.hidden ? "nascosto" : "", sheet.wide ? `le colonne dopo ${columnName(MAX_COLUMNS)} non sono lette` : ""].filter((n) => n !== "");
		return `## Foglio «${sheet.name}» (${[size, ...notes].join("; ")})\n${rows.join("\n")}`;
	});
	return { text: tidy(out.join("\n\n")), parts: sheets.length };
}

/** A sheet as rows of cells, for reading as a table (ADR 0031): no text markers to confuse with the cells. */
export type SheetRows = { readonly name: string; readonly hidden: boolean; readonly rows: string[][] };

/**
 * The sheets of an Excel or OpenDocument workbook as rows of cells, with the values as stored, not
 * as the format rounds them (10,4 stays 10,4 under a «0» format), so sums are exact. `maxRows` stops
 * a sheet of repeated rows from growing without end.
 */
export function spreadsheetRows(name: string, data: Uint8Array, maxRows: number): SheetRows[] | undefined {
	const kind = documentKind(name, data);
	if (kind !== "xlsx" && kind !== "ods") return undefined;
	try {
		const zip = new Zip(Buffer.from(unsignedData(data)));
		if (kind === "xlsx") return xlsxSheets(zip, true).map((s) => ({ name: s.name, hidden: s.hidden, rows: s.rows.map((r) => r.cells) }));
		return odsSheets(zip, maxRows);
	} catch (error) {
		if (error instanceof ZipError || error instanceof P7mError) throw new DocumentError(error.message);
		throw new DocumentError(error instanceof RangeError ? "il documento è troppo complesso da leggere" : NOT_A_DOCUMENT);
	}
}

type XlsxSheet = { name: string; hidden: boolean; wide: boolean; rows: { number: number; cells: string[] }[] };

/** Excel's sheets; with `exact` numbers keep every decimal stored, without grouping, and the format's unit. */
function xlsxSheets(zip: Zip, exact: boolean): XlsxSheet[] {
	const workbook = zip.text("xl/workbook.xml") ?? "";
	const rels = relationships(zip, "xl", "xl/_rels/workbook.xml.rels");
	const shared = [...(zip.text("xl/sharedStrings.xml") ?? "").split("</si>")].slice(0, -1).map((piece) => inlineText(piece.slice(piece.lastIndexOf("<si"))));
	const formats = excelFormats(zip.text("xl/styles.xml") ?? "");
	const sheets = [...workbook.matchAll(/<sheet\b([^>]*)>/g)].map((m) => {
		const attrs = m[1] ?? "";
		const state = attribute(attrs, "state");
		return { name: xmlUnescape(attribute(attrs, "name") ?? "Foglio"), id: attribute(attrs, "r:id") ?? "", hidden: state === "hidden" || state === "veryHidden" };
	});
	const out: XlsxSheet[] = [];
	for (const sheet of sheets) {
		const path = rels.get(sheet.id);
		const xml = path === undefined ? undefined : zip.text(path);
		if (xml === undefined) continue;
		const rows: { number: number; cells: string[] }[] = [];
		let wide = false;
		let lastRow = 0;
		for (const piece of xml.split("</row>")) {
			const open = piece.lastIndexOf("<row");
			if (open < 0) continue;
			const cells: string[] = [];
			// The cell being read: its value comes in the tags after its own.
			let current: { column: number; type: string | undefined; style: number } | undefined;
			for (const c of piece.slice(open).matchAll(/<c\b([^>]*)>|<\/c>|<v>([^<]*)<\/v>|<is>([\s\S]*?)<\/is>/g)) {
				if (c[1] !== undefined) {
					const attrs = c[1];
					const ref = /^([A-Z]+)\d+$/.exec(attribute(attrs, "r") ?? "")?.[1];
					const column = ref === undefined ? cells.length : columnIndex(ref);
					current = { column, type: attribute(attrs, "t"), style: Number(attribute(attrs, "s") ?? "0") };
					continue;
				}
				if (current === undefined) continue;
				let value: string | undefined;
				if (c[3] !== undefined) value = inlineText(c[3]);
				else if (c[2] !== undefined) {
					const v = c[2];
					if (current.type === "s") value = shared[Number(v)] ?? "";
					else if (current.type === "b") value = v === "1" ? "VERO" : "FALSO";
					else if (current.type === undefined || current.type === "n") value = excelValue(Number(v), formats.get(current.style), v, exact);
					else value = xmlUnescape(v);
				} else continue;
				if (current.column > MAX_COLUMNS) {
					wide = true;
					continue;
				}
				while (cells.length < current.column) cells.push("");
				cells[current.column] = value.replace(/[\t\n\r]+/g, " ");
			}
			while (cells.length > 0 && cells.at(-1) === "") cells.pop();
			const number = Number(attribute(piece.slice(open, piece.indexOf(">", open)), "r") ?? lastRow + 1);
			if (cells.length > 0) {
				lastRow = number;
				rows.push({ number, cells });
			}
		}
		out.push({ name: sheet.name, hidden: sheet.hidden, wide, rows });
	}
	return out;
}

/**
 * OpenDocument sheets as rows, from the stored values (office:value, office:date-value), with
 * repeated rows and cells written out as many times as they repeat (empty ones are only skipped).
 */
function odsSheets(zip: Zip, maxRows: number): SheetRows[] {
	const content = zip.text("content.xml") ?? "";
	const bodyAt = content.indexOf("<office:body");
	const xml = bodyAt < 0 ? "" : content.slice(bodyAt);
	const hiddenStyles = new Set<string>();
	for (const m of content.slice(0, Math.max(0, bodyAt)).matchAll(/<style:style\b([^>]*)>\s*<style:table-properties\b([^>]*)>/g)) {
		if (attribute(m[2] ?? "", "table:display") === "false") hiddenStyles.add(attribute(m[1] ?? "", "style:name") ?? "");
	}
	const sheets: SheetRows[] = [];
	let sheet: SheetRows | undefined;
	let depth = 0;
	let row: string[] | undefined;
	let rowRepeat = 1;
	let cell: { value: string | undefined; text: string; repeat: number } | undefined;
	let paragraphs = 0;
	let total = 0;
	for (const m of xml.matchAll(/<(\/?)([\w:.-]+)([^>]*)>|<[?!][^>]*>|([^<]+)/g)) {
		const [, close, tag, attrs = ""] = m;
		if (m[4] !== undefined) {
			if (cell !== undefined && paragraphs > 0) cell.text += xmlUnescape(m[4]).replace(/\s+/g, " ");
			continue;
		}
		if (tag === undefined) continue;
		const selfClosing = attrs.endsWith("/");
		if (tag === "table:table") {
			if (close === "/") depth = Math.max(0, depth - 1);
			else if (!selfClosing && ++depth === 1) {
				sheet = { name: xmlUnescape(attribute(attrs, "table:name") ?? ""), hidden: hiddenStyles.has(attribute(attrs, "table:style-name") ?? ""), rows: [] };
				sheets.push(sheet);
			}
			continue;
		}
		// Tables inside a cell (rare) are not rows of the sheet.
		if (depth !== 1 || sheet === undefined) continue;
		if (tag === "table:table-row") {
			if (close !== "/") {
				row = [];
				rowRepeat = Math.max(1, Math.min(Number(attribute(attrs, "table:number-rows-repeated") ?? "1") || 1, 1_048_576));
				if (!selfClosing) continue;
			}
			if (row !== undefined) {
				while (row.length > 0 && row.at(-1) === "") row.pop();
				if (row.length > 0) {
					for (let i = 0; i < rowRepeat && total <= maxRows; i++, total++) sheet.rows.push(i === 0 ? row : [...row]);
				}
			}
			row = undefined;
			continue;
		}
		if ((tag === "table:table-cell" || tag === "table:covered-table-cell") && row !== undefined) {
			if (close !== "/") {
				cell = { value: odsValue(attrs), text: "", repeat: Math.max(1, Math.min(Number(attribute(attrs, "table:number-columns-repeated") ?? "1") || 1, MAX_COLUMNS + 1)) };
				if (!selfClosing) continue;
			}
			if (cell !== undefined) {
				const value = (cell.value ?? cell.text.trim()).replace(/[\t\n\r]+/g, " ");
				for (let i = 0; i < cell.repeat && row.length <= MAX_COLUMNS; i++) row.push(value);
			}
			cell = undefined;
			continue;
		}
		if (cell === undefined) continue;
		if (tag === "text:p" || tag === "text:h") {
			if (close === "/") paragraphs = Math.max(0, paragraphs - 1);
			else if (!selfClosing) {
				if (cell.text !== "") cell.text += " ";
				paragraphs++;
			}
		} else if (tag === "text:s" && close !== "/") cell.text += " ".repeat(Math.min(Number(attribute(attrs, "text:c") ?? "1") || 1, 50));
	}
	return sheets;
}

/** A cell's stored value: numbers with every decimal and the decimal comma, the unit of money and percentages, dates as ISO. */
function odsValue(attrs: string): string | undefined {
	const type = attribute(attrs, "office:value-type");
	const raw = attribute(attrs, "office:value");
	if (type === "date") {
		const date = attribute(attrs, "office:date-value") ?? "";
		return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date) && !/T00:00(:00)?$/.test(date) ? `${date.slice(0, 10)} ${date.slice(11, 16)}` : date.slice(0, 10) || undefined;
	}
	if (raw === undefined || !Number.isFinite(Number(raw))) return undefined;
	const n = Number(raw);
	if (type === "percentage") return `${exactNumber(n * 100)}%`;
	if (type === "currency") {
		const currency = attribute(attrs, "office:currency");
		return currency === "EUR" ? `${exactNumber(n)} €` : currency === "USD" ? `$${exactNumber(n)}` : exactNumber(n);
	}
	if (type === "float") return exactNumber(n);
	return undefined;
}

/** A number with every decimal it has and the decimal comma, never grouped: 1234,5. */
function exactNumber(n: number): string {
	return String(Number(n.toPrecision(15))).replace(".", ",");
}

/** Columns read in a sheet: A to SG. A sheet wider than this is data for the computer. */
const MAX_COLUMNS = 500;

function inlineText(xml: string): string {
	return [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => xmlUnescape(m[1] ?? "")).join("");
}

function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function columnName(index: number): string {
	let n = Math.max(0, index) + 1;
	let name = "";
	while (n > 0) {
		const rest = (n - 1) % 26;
		name = String.fromCharCode(65 + rest) + name;
		n = Math.floor((n - 1) / 26);
	}
	return name;
}

type ExcelFormat = { readonly kind: "date" | "time" | "datetime" | "percent" | "number"; readonly decimals?: number; readonly grouping: boolean; readonly currency?: string };

/** The number format of each cell style, as far as reading the value needs it. */
function excelFormats(styles: string): Map<number, ExcelFormat> {
	const custom = new Map<number, string>();
	for (const m of styles.matchAll(/<numFmt\b([^>]*)>/g)) {
		const id = attribute(m[1] ?? "", "numFmtId");
		const code = attribute(m[1] ?? "", "formatCode");
		if (id !== undefined && code !== undefined) custom.set(Number(id), xmlUnescape(code));
	}
	const open = styles.indexOf("<cellXfs");
	const close = styles.indexOf("</cellXfs>", open);
	const xfs = open < 0 || close < 0 ? "" : styles.slice(open, close);
	const formats = new Map<number, ExcelFormat>();
	[...xfs.matchAll(/<xf\b([^>]*)>/g)].forEach((m, index) => {
		const format = excelFormat(Number(attribute(m[1] ?? "", "numFmtId") ?? "0"), custom);
		if (format !== undefined) formats.set(index, format);
	});
	return formats;
}

const BUILT_IN: Record<number, string> = { 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 37: "#,##0", 38: "#,##0", 39: "#,##0.00", 40: "#,##0.00" };

function excelFormat(id: number, custom: Map<number, string>): ExcelFormat | undefined {
	if ((id >= 14 && id <= 17) || id === 22) return { kind: id === 22 ? "datetime" : "date", grouping: false };
	if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return { kind: "time", grouping: false };
	const raw = custom.get(id) ?? BUILT_IN[id];
	if (raw === undefined || /^general$/i.test(raw)) return undefined;
	// The positive section only, without quoted text, colours and conditions.
	const first = raw.split(";")[0] ?? "";
	const bare = first.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, "");
	// «m» is a month next to d or y and minutes next to h or s: d, y, h and s decide.
	const hasTime = /[hs]/i.test(bare);
	if (/[dy]/i.test(bare)) return { kind: hasTime ? "datetime" : "date", grouping: false };
	if (hasTime) return { kind: "time", grouping: false };
	const currency = /€|\[\$€/.test(first) ? "€" : /\$|\[\$\$/.test(first) ? "$" : /£/.test(first) ? "£" : undefined;
	const decimals = /\.([0#?]+)/.exec(bare)?.[1]?.length ?? 0;
	return { kind: bare.includes("%") ? "percent" : "number", decimals, grouping: /#,#|0,0/.test(bare), ...(currency === undefined ? {} : { currency }) };
}

/**
 * A number as the format shows it; without a format, as written, with the Italian decimal comma.
 * `exact`: every stored decimal, ungrouped, with only the format's unit (for sums that must add up).
 */
function excelValue(n: number, format: ExcelFormat | undefined, raw: string, exact = false): string {
	if (!Number.isFinite(n)) return xmlUnescape(raw);
	if (format === undefined) return exact ? exactNumber(n) : italian(n, undefined, false);
	if (format.kind === "date" || format.kind === "datetime" || format.kind === "time") return excelDate(n, format.kind);
	if (exact) {
		if (format.kind === "percent") return `${exactNumber(n * 100)}%`;
		if (format.currency === undefined) return exactNumber(n);
		return format.currency === "€" ? `${exactNumber(n)} €` : `${format.currency}${exactNumber(n).replace(/^-/, "")}`.replace(/^/, n < 0 ? "-" : "");
	}
	if (format.kind === "percent") return `${italian(n * 100, format.decimals, false)}%`;
	const shown = italian(n, format.decimals, format.grouping || format.currency !== undefined);
	if (format.currency === undefined) return shown;
	return format.currency === "€" ? `${shown} €` : `${format.currency}${shown}`;
}

function italian(n: number, decimals: number | undefined, grouping: boolean): string {
	return new Intl.NumberFormat("it-IT", decimals === undefined ? { maximumFractionDigits: 10, useGrouping: grouping } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping }).format(n);
}

function excelDate(serial: number, kind: "date" | "datetime" | "time"): string {
	const ms = Math.round((serial - 25569) * 86_400_000);
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return String(serial);
	const iso = date.toISOString();
	if (kind === "time") return iso.slice(11, 16);
	return kind === "date" && serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** PowerPoint: slides in the order of the presentation, each with its text, tables, charts and notes. */
function pptxText(zip: Zip): { text: string; parts: number } {
	const presentation = zip.text("ppt/presentation.xml") ?? "";
	const rels = relationships(zip, "ppt", "ppt/_rels/presentation.xml.rels");
	const ids = [...presentation.matchAll(/<p:sldId\b([^>]*)>/g)].map((m) => attribute(m[1] ?? "", "r:id") ?? "");
	const out: string[] = [];
	ids.forEach((id, index) => {
		const path = rels.get(id);
		const xml = path === undefined ? undefined : zip.text(path);
		if (path === undefined || xml === undefined) return;
		let slide = `## Diapositiva ${index + 1}\n${drawingText(xml)}`;
		const folder = path.split("/").slice(0, -1).join("/");
		const slideRels = relationships(zip, folder, `${folder}/_rels/${path.split("/").at(-1)}.rels`);
		for (const chart of [...slideRels.values()].filter((p) => /charts\/chart\d*\.xml$/.test(p))) {
			const shown = chartText(zip.text(chart) ?? "");
			if (shown !== "") slide += `\n${shown}`;
		}
		const notesPath = [...slideRels.values()].find((p) => /notesSlide\d*\.xml$/.test(p));
		const notes = notesPath === undefined ? "" : drawingText(zip.text(notesPath) ?? "").replace(/^\d+$/gm, "").trim();
		if (notes !== "") slide += `\nNote: ${notes}`;
		out.push(slide);
	});
	return { text: tidy(out.join("\n\n")), parts: ids.length };
}

/** Text of shapes: paragraphs by lines; in tables, rows by lines and cells by tabs. */
function drawingText(xml: string): string {
	let out = "";
	let cells = 0;
	for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>|<(\/?)a:(br|p|tc|tr)\b([^>]*)>/g)) {
		const [, text, close, tag, attrs = ""] = m;
		if (text !== undefined) out += xmlUnescape(text);
		else if (tag === "br") out += cells > 0 ? " " : "\n";
		else if (tag === "tc") {
			if (close === "/") {
				cells = Math.max(0, cells - 1);
				out = `${trimEndOf(out, " ")}\t`;
			} else if (!attrs.endsWith("/")) cells++;
			else out += "\t";
		} else if (tag === "tr") {
			if (close === "/") out = `${trimEndOf(out, " \t")}\n`;
		} else if (tag === "p" && close === "/") out += cells > 0 ? " " : "\n";
	}
	return out;
}

/** A chart as its title and the numbers it was drawn from (the cache the file keeps). */
function chartText(xml: string): string {
	const values = (part: string) => [...part.matchAll(/<c:pt\b[^>]*>\s*<c:v>([^<]*)<\/c:v>/g)].map((m) => xmlUnescape(m[1] ?? ""));
	const titleEnd = xml.indexOf("</c:title>");
	const title = titleEnd < 0 ? "" : [...xml.slice(0, titleEnd).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => xmlUnescape(m[1] ?? "")).join("");
	const lines: string[] = [];
	for (const piece of xml.split("</c:ser>").slice(0, -1)) {
		const series = piece.slice(piece.lastIndexOf("<c:ser>"));
		const section = (tag: string) => {
			const open = series.indexOf(`<c:${tag}>`);
			const close = series.indexOf(`</c:${tag}>`, open);
			return open < 0 || close < 0 ? "" : series.slice(open, close);
		};
		const name = values(section("tx"))[0] ?? `Serie ${lines.length + 1}`;
		const categories = values(section("cat"));
		const numbers = values(section("val")).map((v) => (Number.isFinite(Number(v)) ? italian(Number(v), undefined, false) : v));
		if (numbers.length === 0) continue;
		lines.push(`${name}: ${numbers.map((v, i) => (categories[i] === undefined ? v : `${categories[i]} ${v}`)).join("; ")}`);
	}
	if (lines.length === 0) return title === "" ? "" : `[Grafico «${title}»]`;
	return `[Grafico${title === "" ? "" : ` «${title}»`}]\n${lines.join("\n")}`;
}

/**
 * OpenDocument: the body only (not the styles before it). Paragraphs and headings by lines, table
 * rows by lines with cells by tabs (repeated and empty cells kept, so columns stay in place), sheets
 * by name, slides by number with their notes, footnotes at the end.
 */
function odfText(zip: Zip, kind: "odt" | "ods" | "odp"): { text: string; parts?: number } {
	const content = zip.text("content.xml") ?? "";
	const bodyAt = content.indexOf("<office:body");
	const xml = bodyAt < 0 ? "" : content.slice(bodyAt);
	const hiddenStyles = new Set<string>();
	for (const m of content.slice(0, Math.max(0, bodyAt)).matchAll(/<style:style\b([^>]*)>\s*<style:table-properties\b([^>]*)>/g)) {
		if (attribute(m[2] ?? "", "table:display") === "false") hiddenStyles.add(attribute(m[1] ?? "", "style:name") ?? "");
	}
	let out = "";
	let parts = 0;
	let cells = 0;
	let tables = 0;
	let notes = "";
	let inNote = 0;
	let inCitation = false;
	let skip = 0;
	let paragraphs = 0;
	let bullet = false;
	// Spreadsheet rows: empty ones are dropped, and after a gap the row number is said.
	let rowStart = -1;
	let rowRepeat = 1;
	let rowNumber = 0;
	let lastRow = 0;
	const footnotes: string[] = [];
	const write = (text: string) => {
		if (skip > 0) return;
		if (inNote > 0) notes += text;
		else out += text;
	};
	// One tag or one run of text per match; attributes are read apart, so no pattern backtracks on a long tag.
	for (const m of xml.matchAll(/<(\/?)([\w:.-]+)([^>]*)>|<[?!][^>]*>|([^<]+)/g)) {
		const [, close, tag, attrs = ""] = m;
		const selfClosing = attrs.endsWith("/");
		if (m[4] !== undefined) {
			if (inCitation) out += `[${xmlUnescape(m[4]).trim()}]`;
			// Text counts inside paragraphs only, with runs of white space as one space (the ODF rule).
			else if (paragraphs > 0) write(xmlUnescape(m[4]).replace(/\s+/g, " "));
			continue;
		}
		if (tag === undefined) continue;
		if (close === "/") {
			if (tag === "table:table-cell" || tag === "table:covered-table-cell") {
				cells = Math.max(0, cells - 1);
				if (inNote === 0 && skip === 0) out = `${trimEndOf(out, " ")}\t`;
			} else if (tag === "table:table-row") {
				if (kind === "ods" && rowStart >= 0 && inNote === 0) {
					const row = out.slice(rowStart);
					if (row.trim() === "") out = out.slice(0, rowStart);
					else {
						if (rowNumber + 1 > lastRow + 1 && lastRow > 0) out = `${out.slice(0, rowStart)}[riga ${rowNumber + 1}]\n${row}`;
						lastRow = rowNumber + 1;
						out += "\n";
					}
					rowNumber += rowRepeat;
					rowStart = -1;
				} else write("\n");
			}
			else if (tag === "table:table") tables = Math.max(0, tables - 1);
			else if (tag === "text:p" || tag === "text:h") {
				paragraphs = Math.max(0, paragraphs - 1);
				write(cells > 0 ? " " : "\n");
			}
			else if (tag === "text:note-citation") inCitation = false;
			else if (tag === "text:note-body") {
				inNote--;
				footnotes.push(tidy(notes).replace(/\s*\n\s*/g, " "));
				notes = "";
			} else if (tag === "text:page-number" || tag === "text:date" || tag === "text:time" || tag === "draw:page-thumbnail") skip = Math.max(0, skip - 1);
			continue;
		}
		if (tag === "text:p" || tag === "text:h") {
			if (selfClosing) {
				write(cells > 0 ? " " : "\n");
				continue;
			}
			paragraphs++;
			if (bullet) write("- ");
			else if (tag === "text:h") write(`${"#".repeat(Math.min(Number(attribute(attrs, "text:outline-level") ?? "1") || 1, 6))} `);
			bullet = false;
		} else if (tag === "text:list-item" && !selfClosing) bullet = true;
		else if (tag === "table:table-row" && kind === "ods" && inNote === 0 && !selfClosing) {
			rowStart = out.length;
			rowRepeat = Math.min(Number(attribute(attrs, "table:number-rows-repeated") ?? "1") || 1, 1_048_576);
		} else if (tag === "table:table-cell" || tag === "table:covered-table-cell") {
			// Repeated cells are written once; the tabs keep the next columns where they belong.
			const repeat = Math.min(Number(attribute(attrs, "table:number-columns-repeated") ?? "1") || 1, 200);
			if (selfClosing) write("\t".repeat(repeat));
			else {
				cells++;
				if (repeat > 1) write("\t".repeat(repeat - 1));
			}
		} else if (tag === "table:table") {
			tables++;
			if (kind !== "ods" || tables > 1) continue;
			parts++;
			rowNumber = 0;
			lastRow = 0;
			const hidden = hiddenStyles.has(attribute(attrs, "table:style-name") ?? "");
			write(`\n\n## Foglio «${xmlUnescape(attribute(attrs, "table:name") ?? "")}»${hidden ? " (nascosto)" : ""}\n`);
		} else if (tag === "draw:page" && kind === "odp") {
			parts++;
			write(`\n\n## Diapositiva ${parts}\n`);
		} else if (tag === "presentation:notes" && !selfClosing) write("\nNote: ");
		else if (tag === "text:tab") write("\t");
		else if (tag === "text:line-break") write(cells > 0 ? " " : "\n");
		else if (tag === "text:s") write(" ".repeat(Math.min(Number(attribute(attrs, "text:c") ?? "1") || 1, 50)));
		else if (tag === "text:note-citation" && !selfClosing) inCitation = true;
		else if (tag === "text:note-body" && !selfClosing) inNote++;
		else if ((tag === "text:page-number" || tag === "text:date" || tag === "text:time" || tag === "draw:page-thumbnail") && !selfClosing) skip++;
	}
	const text = out
		.split("\n")
		.map((line) => trimEndOf(line, "\t "))
		.join("\n");
	const withNotes = footnotes.length === 0 ? text : `${text}\n\n[Note]\n${footnotes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
	return { text: tidy(withNotes.replace(/\nNote: *(?=\n|$)/g, "")), ...(kind === "odt" ? {} : { parts }) };
}

/** An attribute's value in a tag's attribute text, found with indexOf: no backtracking. */
function attribute(attrs: string, name: string): string | undefined {
	let at = attrs.indexOf(`${name}="`);
	while (at > 0 && !/\s/.test(attrs[at - 1] ?? "")) at = attrs.indexOf(`${name}="`, at + 1);
	if (at < 0) return undefined;
	const start = at + name.length + 2;
	const end = attrs.indexOf('"', start);
	return end < 0 ? undefined : attrs.slice(start, end);
}
