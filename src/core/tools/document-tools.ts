import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError, documentKind } from "../documents.ts";
import { Type } from "typebox";
import { defineOwniTool, type OwniTool } from "../engine.ts";
import { MAKE_LIMITS, type MakeFormat, picturePaths } from "../make-document.ts";
import { type Workspace, WorkspaceError } from "../workspace.ts";

export type DocumentToolsOptions = { readonly workspace: Workspace; readonly now?: () => Date };

/** The longest Markdown or CSV a document is made from, in characters. */
const MAX_TEXT = 400_000;

const FORMATS: Record<string, { format: MakeFormat; label: string }> = { docx: { format: "docx", label: "Word" }, xlsx: { format: "xlsx", label: "Excel" }, pdf: { format: "pdf", label: "PDF" } };

/** Creating Word, Excel and PDF files from Markdown or a CSV (ADR 0029), in the workspace, to send with file_send. */
export function createDocumentTools(options: DocumentToolsOptions): OwniTool[] {
	const { workspace } = options;
	return [
		defineOwniTool({
			name: "document_create",
			description:
				"Create a Word (.docx), Excel (.xlsx) or PDF file in your workspace: a letter, a report, a price list, a table. Then send it with file_send in the same turn. " +
				"Write the content in Markdown. Word and PDF: # headings, paragraphs (a single line break stays a line break, as in an address), **bold**, *italic*, " +
				"- and 1. lists, | tables | (columns size themselves; ---: aligns a column right, numbers already are), > quotes, --- for a line, \\newpage for a new page, " +
				"[links](https://...), pictures from the workspace ![logo](uploads/logo.png) (PNG or JPEG; a picture whose description says logo comes out small on the left; ![foto|8cm](...) sets the width). " +
				"The PDF has no emoji and only Latin letters: for names in other alphabets make a Word file. " +
				"Excel: each table becomes rows with its header in bold; the top headings become sheets (a single # title at the start names the file). Write numbers as 1234.5 or 1.234,56, " +
				"amounts as € 1.200,00, percentages as 15%, dates as 2026-10-17 or 17/10/2026, formulas starting with = in English or Italian (=SUM(B2:B9), =SOMMA(B2:B9;C2)); start a cell with ' to keep it as text. " +
				"Rows count from the top of the sheet: a sheet that starts with its table has the header in row 1 and data from row 2; text above a table moves it down. " +
				"Instead of content, source converts a Markdown or CSV file already in the workspace (a CSV to Excel, a report to PDF).",
			parameters: Type.Object(
				{
					path: Type.String({ description: "Where to save it, ending in .docx, .xlsx or .pdf, e.g. preventivi/rossi.pdf", minLength: 1, maxLength: 300 }),
					content: Type.Optional(Type.String({ description: "The document in Markdown", maxLength: MAX_TEXT })),
					source: Type.Optional(Type.String({ description: "Instead of content: a .md, .txt or .csv file in the workspace to convert", minLength: 1, maxLength: 300 })),
				},
				{ additionalProperties: false },
			),
			replaySafe: true,
			async execute(args) {
				const path = args.path;
				const kind = FORMATS[/\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""];
				if (kind === undefined) return "Errore: il nome del file deve finire con .docx (Word), .xlsx (Excel) o .pdf.";
				const hasContent = args.content !== undefined && args.content.trim() !== "";
				const source = args.source;
				const hasSource = source !== undefined;
				if (hasContent === hasSource) return "Errore: dammi il testo in content oppure un file del workspace in source (uno dei due).";
				try {
					let text: string;
					let csv = false;
					if (hasSource) {
						const data = await workspace.read(source);
						if (documentKind(source, data) !== undefined) return `Errore: ${source} è già un documento: converto solo testo Markdown o CSV. Leggilo con file_read e scrivi il nuovo documento in content.`;
						if (data.includes(0)) return `Errore: ${source} non è un file di testo.`;
						text = data.toString("utf8");
						if (text.length > MAX_TEXT) return `Errore: ${source} è troppo lungo per farne un documento (più di ${MAX_TEXT} caratteri).`;
						csv = /\.(csv|tsv)$/i.test(source);
					} else {
						text = String(args.content);
						if (text.length > MAX_TEXT) return `Errore: il testo è troppo lungo per un documento (più di ${MAX_TEXT} caratteri): dividilo in più file.`;
					}
					const pictures = csv ? [] : await readPictures(workspace, picturePaths(text));
					const name = (path.split("/").pop() as string).replace(/\.[^.]+$/, "");
					const made = await makeDocumentFile({ format: kind.format, text, csv, name, pictures, now: (options.now?.() ?? new Date()).getTime() });
					const file = await workspace.write(path, made.data);
					const size = file.size < 1024 ? `${file.size} byte` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
					const parts = made.pages !== undefined ? `, ${made.pages === 1 ? "1 pagina" : `${made.pages} pagine`}` : made.sheets !== undefined ? `, ${made.sheets === 1 ? "1 foglio" : `${made.sheets} fogli`}` : "";
					const notes = made.notes.length === 0 ? "" : ` ${made.notes.join(" ")}`;
					return `Creato ${file.path} (${kind.label}${parts}, ${size}).${notes} Per darlo a chi te l'ha chiesto usa file_send.`;
				} catch (error) {
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					if (error instanceof DocumentError) return `Errore: non ho creato ${path}: ${error.message.replace("leggerlo", "crearlo")}.`;
					throw error;
				}
			},
		}),
	];
}

/** The pictures a document shows, read from the workspace; at most MAKE_LIMITS.maxPictures, each at most maxPictureBytes. */
async function readPictures(workspace: Workspace, paths: readonly string[]) {
	const out: { path: string; data?: Uint8Array; problem?: string }[] = [];
	for (const [i, path] of paths.entries()) {
		if (i >= MAKE_LIMITS.maxPictures) {
			out.push({ path, problem: `in un documento metto al massimo ${MAKE_LIMITS.maxPictures} immagini` });
			continue;
		}
		try {
			const stat = await workspace.stat(path);
			if (stat === undefined) continue;
			if (stat.size > MAKE_LIMITS.maxPictureBytes) out.push({ path, problem: "è più grande di 10 MB" });
			else out.push({ path, data: await workspace.read(path) });
		} catch (error) {
			// A path the workspace refuses (outside it, hidden): as if it were not there.
			if (!(error instanceof WorkspaceError)) throw error;
		}
	}
	return out;
}
