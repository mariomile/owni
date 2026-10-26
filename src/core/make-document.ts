import { imageType } from "./images.ts";
import { makeDocx, type Picture } from "./make-docx.ts";
import { makePdf, PdfMakeError } from "./make-pdf.ts";
import { makeXlsx, SheetError, sheetOfCsv, sheetsOf } from "./make-xlsx.ts";
import { type Block, markdownBlocks, plainText } from "./markdown-blocks.ts";
import { jpegSize } from "./pdf-images.ts";
import { pngSize } from "./png-read.ts";

/**
 * Word, Excel and PDF files from what Owni writes (ADR 0029): Markdown for a letter, a quote or a
 * report; tables, or a CSV, for a sheet. Runs in the document worker (document-reader.ts), so its
 * files use only erasable TypeScript.
 */
export class MakeError extends Error {
	override readonly name = "MakeError";
}

export type MakeFormat = "docx" | "xlsx" | "pdf";

/** `maxColumns`: Word takes at most 63 columns in a table; `maxBytes`: the largest file the workspace keeps. */
export const MAKE_LIMITS = { maxPictures: 20, maxPictureBytes: 10 * 1024 * 1024, maxPictureSide: 10_000, maxColumns: 63, maxBytes: 20 * 1024 * 1024 } as const;

export type MakeInput = {
	readonly format: MakeFormat;
	/** Markdown, or with `csv` the text of a CSV file. */
	readonly text: string;
	readonly csv?: boolean;
	/** For a sheet without headings: its name. */
	readonly name: string;
	/** Pictures the Markdown points to, read from the workspace by the caller, or why they could not be. */
	readonly pictures: readonly { readonly path: string; readonly data?: Uint8Array; readonly problem?: string }[];
	readonly now: number;
};

/** `notes`: what did not go in as asked, for Owni to tell (a missing picture, characters the PDF fonts lack). */
export type MadeDocument = { readonly data: Uint8Array; readonly pages?: number; readonly sheets?: number; readonly notes: readonly string[] };

/**
 * The workspace paths of the pictures in a Markdown text, for the caller to read them before the
 * worker starts. A line-by-line look, cheap enough for the main thread: the full parse is in the worker.
 */
export function picturePaths(markdown: string): string[] {
	const paths = new Set<string>();
	for (const line of markdown.split("\n")) {
		if (!line.trimStart().startsWith("![")) continue;
		const path = /^\s*!\[[^\]\n]{0,500}\]\(\s*<?([^)\s>]{1,500})/.exec(line)?.[1];
		if (path !== undefined) paths.add(path);
	}
	return [...paths];
}

export function makeDocument(input: MakeInput): MadeDocument {
	const now = new Date(input.now);
	try {
		if (input.format === "xlsx") {
			const blocks = input.csv ? [] : markdownBlocks(input.text);
			const sheets = input.csv ? [sheetOfCsv(input.text, input.name)] : sheetsOf(blocks, input.name);
			const title = titleOf(blocks);
			const made = makeXlsx(sheets, { ...(title === undefined ? {} : { title }), now });
			const notes = [...made.notes, ...(blocks.some((b) => b.type === "image") ? ["Le immagini non vanno nei fogli Excel: le ho lasciate fuori."] : [])];
			return { data: fits(made.data), sheets: sheets.length, notes };
		}
		const blocks = input.csv ? [csvTable(input.text)] : markdownBlocks(input.text);
		if (!blocks.some((b) => b.type !== "rule" && b.type !== "pagebreak")) throw new MakeError("il documento è vuoto: scrivi il testo in content");
		const wide = blocks.find((b) => b.type === "table" && b.header.length > MAKE_LIMITS.maxColumns);
		if (wide !== undefined) throw new MakeError(`una tabella ha più di ${MAKE_LIMITS.maxColumns} colonne, troppe per Word e per una pagina: per una tabella così larga crea un Excel`);
		const notes: string[] = [];
		const pictures = picturesOf(blocks, input.pictures, notes);
		const title = titleOf(blocks);
		if (input.format === "docx") return { data: fits(makeDocx({ ...(title === undefined ? {} : { title }), blocks, pictures, now })), notes };
		const pdf = makePdf({ ...(title === undefined ? {} : { title }), blocks, pictures, now });
		if (pdf.approximated > 0) notes.push("Alcune lettere (come ș, ř, ł) non ci sono nei caratteri del PDF: le ho scritte senza il segno (s, r, l). Se servono esatte, crea il documento in Word.");
		if (pdf.emoji > 0) notes.push("Le emoji non ci sono nei caratteri del PDF: le ho tolte (in Word restano).");
		if (pdf.replaced > 0) notes.push(`${pdf.replaced === 1 ? "Un carattere non c'è" : `${pdf.replaced} caratteri non ci sono`} nei caratteri del PDF (alfabeti non latini, simboli rari): al loro posto c'è un punto di domanda. Se servono, crea il documento in Word.`);
		if (pdf.cut > 0) notes.push(`${pdf.cut === 1 ? "Una riga di tabella era più alta di una pagina ed è stata tagliata" : `${pdf.cut} righe di tabella erano più alte di una pagina e sono state tagliate`}.`);
		for (const skipped of pdf.skipped) notes.push(`Non ho messo l'immagine ${skipped}.`);
		return { data: fits(pdf.data), pages: pdf.pages, notes };
	} catch (error) {
		if (error instanceof SheetError || error instanceof PdfMakeError) throw new MakeError(error.message);
		throw error;
	}
}

/** A file the workspace can keep: otherwise said now, not after the work. */
function fits(data: Buffer): Buffer {
	if (data.length > MAKE_LIMITS.maxBytes) throw new MakeError("il file verrebbe più grande di 20 MB: usa meno immagini o più piccole, o dividi il documento");
	return data;
}

/** The document's title: its first heading. */
function titleOf(blocks: readonly Block[]): string | undefined {
	const heading = blocks.find((b) => b.type === "heading");
	return heading === undefined ? undefined : plainText(heading.spans).trim().slice(0, 200);
}

/** A CSV as one table, for a Word or PDF file. */
function csvTable(text: string): Block {
	const sheet = sheetOfCsv(text, "CSV");
	const [head, ...rows] = sheet.rows;
	const columns = Math.max(...sheet.rows.map((r) => r.cells.length));
	const fit = (cells: readonly (readonly { text: string }[])[]) => Array.from({ length: columns }, (_, i) => cells[i] ?? []);
	return { type: "table", header: fit(head?.cells ?? []), rows: rows.map((r) => fit(r.cells)), align: Array.from({ length: columns }, () => undefined) };
}

function picturesOf(blocks: readonly Block[], given: MakeInput["pictures"], notes: string[]): Map<string, Picture> {
	const byPath = new Map(given.map((p) => [p.path, p.data === undefined ? undefined : Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength)]));
	const problems = new Map(given.map((p) => [p.path, p.problem]));
	const pictures = new Map<string, Picture>();
	const seen = new Set<string>();
	for (const block of blocks) {
		if (block.type !== "image" || seen.has(block.path)) continue;
		seen.add(block.path);
		const data = byPath.get(block.path);
		const say = (why: string) => notes.push(`Non ho messo l'immagine ${block.path}: ${why}.`);
		const problem = problems.get(block.path);
		if (problem !== undefined) {
			say(problem);
			continue;
		}
		if (data === undefined) {
			say(/^https?:/i.test(block.path) ? "le immagini vanno prese dal workspace (scaricala prima con web_download)" : "non c'è nel workspace");
			continue;
		}
		const mime = imageType(data);
		if (mime !== "image/png" && mime !== "image/jpeg") {
			say("nei documenti metto solo immagini PNG e JPEG");
			continue;
		}
		const size = mime === "image/png" ? pngSize(data) : jpegSize(data);
		if (size === undefined || size.width === 0 || size.height === 0) {
			say("l'immagine è rovinata");
			continue;
		}
		if (size.width > MAKE_LIMITS.maxPictureSide || size.height > MAKE_LIMITS.maxPictureSide) {
			say(`l'immagine è più grande di ${MAKE_LIMITS.maxPictureSide} pixel per lato`);
			continue;
		}
		pictures.set(block.path, { path: block.path, alt: block.alt, mime, data, ...size });
	}
	return pictures;
}
