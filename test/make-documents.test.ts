import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { documentText } from "../src/core/documents.ts";
import { makeDocument } from "../src/core/make-document.ts";
import { cellOf, columnName, parseCsv } from "../src/core/make-xlsx.ts";
import { inlineSpans, markdownBlocks } from "../src/core/markdown-blocks.ts";
import { pngOf } from "../src/core/pdf-codecs.ts";
import { readPng } from "../src/core/png-read.ts";
import { evaluateFormula, normalizeFormula } from "../src/core/sheet-formulas.ts";
import { createDocumentTools } from "../src/core/tools/document-tools.ts";
import { Workspace } from "../src/core/workspace.ts";
import { writeZip, Zip } from "../src/core/zip.ts";
import { tempDataDir } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 17, 9, 30);

const QUOTE = `# Preventivo n. 42/2026

**Buildrs S.r.l.**
Via Roma 1
00100 Roma

Gentile *Mario Rossi*, ecco il preventivo. Più info sul [sito](https://example.com).

## Voci

| Voce | Quantità | Prezzo |
|:-----|---------:|-------:|
| Progettazione | 1 | € 1.200,00 |
| Sviluppo \\| pagine | 5 | € 300,00 |

1. Primo passo
   - dettaglio
2. Secondo passo

> IVA esclusa.

Grazie.
`;

function make(format: "docx" | "xlsx" | "pdf", text: string, pictures: { path: string; data: Buffer }[] = []) {
	return makeDocument({ format, text, name: "prova", pictures, now: NOW });
}

/** A PNG from RGBA rows, each row with the given filter (to read back every kind of filter). */
function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number], filters: number[]): Buffer {
	const rows: Buffer[] = [];
	let prior = Buffer.alloc(width * 4);
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(width * 4);
		for (let x = 0; x < width; x++) row.set(pixel(x, y), x * 4);
		const filter = filters[y % filters.length] as number;
		const out = Buffer.alloc(width * 4 + 1);
		out[0] = filter;
		for (let i = 0; i < row.length; i++) {
			const left = i >= 4 ? (row[i - 4] as number) : 0;
			const up = prior[i] as number;
			const corner = i >= 4 ? (prior[i - 4] as number) : 0;
			const p = left + up - corner;
			const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
			const predicted = [0, left, up, (left + up) >> 1, paeth][filter] as number;
			out[i + 1] = ((row[i] as number) - predicted) & 0xff;
		}
		rows.push(out);
		prior = row;
	}
	return png(width, height, 6, 8, deflateSync(Buffer.concat(rows)));
}

function png(width: number, height: number, colorType: number, bitDepth: number, idat: Buffer, interlace = 0, extra: Buffer[] = []): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "latin1");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	ihdr[12] = interlace;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** The smallest JPEG header with a frame: enough for its size and colour components. */
function tinyJpeg(width: number, height: number): Buffer {
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

describe("Markdown for documents", () => {
	it("reads headings, paragraphs with their line breaks, nested lists, tables, quotes, code and page breaks", () => {
		const blocks = markdownBlocks(`${QUOTE}\n\`\`\`\nx = 1\n\`\`\`\n\n---\n\n\\newpage\n\n![logo](uploads/logo.png)\n`);
		expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph", "heading", "table", "list", "quote", "paragraph", "code", "rule", "pagebreak", "image"]);
		expect(blocks[1]).toEqual({ type: "paragraph", spans: [{ text: "Buildrs S.r.l.", bold: true }, { text: "\nVia Roma 1\n00100 Roma" }] });
		const table = blocks[4] as Extract<(typeof blocks)[number], { type: "table" }>;
		expect(table.align).toEqual(["left", "right", "right"]);
		expect(table.rows[1]?.[0]).toEqual([{ text: "Sviluppo | pagine" }]);
		const list = blocks[5] as Extract<(typeof blocks)[number], { type: "list" }>;
		expect(list.items.map((i) => [i.level, i.ordered])).toEqual([
			[0, true],
			[1, false],
			[0, true],
		]);
		expect(blocks[11]).toEqual({ type: "image", alt: "logo", path: "uploads/logo.png" });
	});

	it("reads bold, italic, code and links, and keeps snake_case names and unsafe links as text", () => {
		expect(inlineSpans("**a** *b* `c` [d](https://x.it) e_f_g")).toEqual([
			{ text: "a", bold: true },
			{ text: " " },
			{ text: "b", italic: true },
			{ text: " " },
			{ text: "c", code: true },
			{ text: " " },
			{ text: "d", link: "https://x.it" },
			{ text: " e_f_g" },
		]);
		expect(inlineSpans("[clic](javascript:alert(1))")).toEqual([{ text: "clic" }]);
		expect(inlineSpans("\\*non corsivo\\*")).toEqual([{ text: "*non corsivo*" }]);
	});
});

describe("ZIP writing", () => {
	it("writes files our reader (and Office) can open", () => {
		const zip = new Zip(writeZip([{ name: "a.xml", data: "<a>è</a>" }, { name: "media/p.png", data: Buffer.from([1, 2, 3]) }]));
		expect(zip.names()).toEqual(["a.xml", "media/p.png"]);
		expect(zip.text("a.xml")).toBe("<a>è</a>");
		expect(zip.file("media/p.png")).toEqual(Buffer.from([1, 2, 3]));
	});
});

describe("Word", () => {
	it("writes a document Word opens, with its text, table, list and link", () => {
		const made = make("docx", QUOTE);
		const zip = new Zip(Buffer.from(made.data));
		const xml = zip.text("word/document.xml") as string;
		expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
		expect(xml).toContain("<w:br/>");
		expect(xml).toContain("<w:tbl>");
		expect(xml).toContain('<w:numId w:val="2"/>');
		expect(zip.text("word/_rels/document.xml.rels")).toContain('Target="https://example.com/" TargetMode="External"');
		expect(zip.text("docProps/core.xml")).toContain("<dc:title>Preventivo n. 42/2026</dc:title>");
		const text = documentText("prova.docx", made.data).text.replace(/\u00a0/g, " ");
		expect(text).toContain("Preventivo n. 42/2026");
		expect(text).toContain("Progettazione");
		expect(text).toContain("€ 300,00");
		expect(made.notes).toEqual([]);
	});

	it("puts in pictures from the workspace and says which it left out", () => {
		const logo = rgbaPng(4, 2, () => [200, 10, 10, 255], [0]);
		const made = make("docx", "# Lettera\n\n![logo](uploads/logo.png)\n\n![foto](uploads/manca.jpg)\n\n![web](https://x.it/a.png)\n", [{ path: "uploads/logo.png", data: logo }]);
		const zip = new Zip(Buffer.from(made.data));
		expect(zip.file("word/media/image1.png")).toEqual(logo);
		expect(zip.text("word/document.xml")).toContain('<wp:extent cx="38100" cy="19050"/>');
		expect(made.notes).toEqual([
			"Non ho messo l'immagine uploads/manca.jpg: non c'è nel workspace.",
			"Non ho messo l'immagine https://x.it/a.png: le immagini vanno prese dal workspace (scaricala prima con web_download).",
		]);
	});

	it("drops characters XML cannot hold instead of writing a broken file", () => {
		const made = make("docx", "Testo con \u0001 controllo e <tag> & \ud800 resto");
		const xml = new Zip(Buffer.from(made.data)).text("word/document.xml") as string;
		expect(xml).toContain("Testo con  controllo e &lt;tag&gt; &amp;  resto");
	});
});

describe("Excel", () => {
	it("reads numbers the Italian and the international way, amounts, percentages and dates", () => {
		const cell = (text: string) => cellOf([{ text }]);
		expect(cell("1.234,56")).toEqual({ kind: "number", value: 1234.56, style: 3 });
		expect(cell("1,234.5")).toEqual({ kind: "number", value: 1234.5, style: 3 });
		expect(cell("1.200")).toEqual({ kind: "number", value: 1200, style: 4 });
		expect(cell("12,5")).toEqual({ kind: "number", value: 12.5, style: 0 });
		expect(cell("42")).toEqual({ kind: "number", value: 42, style: 0 });
		expect(cell("€ 1.200,00")).toEqual({ kind: "number", value: 1200, style: 8 });
		expect(cell("15%")).toEqual({ kind: "number", value: 0.15, style: 5 });
		expect(cell("2026-10-17")).toEqual({ kind: "number", value: 46312, style: 7 });
		expect(cell("17/10/2026")).toEqual({ kind: "number", value: 46312, style: 7 });
		expect(cell("31/02/2026")).toEqual({ kind: "text", text: "31/02/2026", bold: false });
		// Codes stay text: a CAP, a long number, a phone.
		expect(cell("00100").kind).toBe("text");
		expect(cell("1234567890123456").kind).toBe("text");
		expect(cell("+39 333 1234567").kind).toBe("text");
		expect(cell("'=non formula")).toEqual({ kind: "text", text: "=non formula", bold: false });
		expect(cell("=SUM(B2:B9)")).toEqual({ kind: "formula", formula: "SUM(B2:B9)", bold: false });
	});

	it("never writes a formula that reaches outside the workbook", () => {
		for (const formula of ['=WEBSERVICE("https://x.it")', "=cmd|' /C calc'!A0", "=[altro.xlsx]Foglio1!A1", '=HYPERLINK("https://x.it","clic")', '=IMPORTXML("https://x.it","//a")']) {
			expect(() => cellOf([{ text: formula }])).toThrow(/non scrivo|altri file/);
			// From a CSV file the cell stays as text, so the conversion goes on.
			expect(cellOf([{ text: formula }], true).kind).toBe("text");
		}
	});

	it("makes one sheet per table after a heading, with the header in bold, frozen and filtered", () => {
		const made = make("xlsx", "# Vendite\n\n| Mese | Totale |\n|---|---|\n| Gennaio | 100 |\n| Febbraio | 120 |\n| **Totale** | =SUM(B2:B3) |\n\n# Costi\n\n| Voce | Euro |\n|---|---|\n| Affitto | € 800 |\n");
		expect(made.sheets).toBe(2);
		const zip = new Zip(Buffer.from(made.data));
		expect(zip.text("xl/workbook.xml")).toContain('<sheet name="Vendite" sheetId="1" r:id="rIdSheet1"/><sheet name="Costi" sheetId="2" r:id="rIdSheet2"/>');
		const sheet = zip.text("xl/worksheets/sheet1.xml") as string;
		expect(sheet).toContain('<c r="A1" t="inlineStr" s="2"><is><t xml:space="preserve">Mese</t></is></c>');
		expect(sheet).toContain('<c r="B2"><v>100</v></c>');
		expect(sheet).toContain('<c r="B4"><f>SUM(B2:B3)</f><v>220</v></c>');
		expect(sheet).toContain('<c r="A4" t="inlineStr" s="1">');
		expect(sheet).toContain('state="frozen"');
		expect(sheet).toContain('<autoFilter ref="A1:B4"/>');
		expect(documentText("prova.xlsx", made.data).text).toContain("Affitto");
	});

	it("keeps a title and text above a table in the same sheet", () => {
		const made = make("xlsx", "# Listino\n\nPrezzi validi da ottobre.\n\n## Servizi\n\n| Servizio | Prezzo |\n|---|---|\n| Sito | € 900 |\n");
		expect(made.sheets).toBe(1);
		const zip = new Zip(Buffer.from(made.data));
		expect(zip.text("xl/workbook.xml")).toContain('<sheet name="Listino"');
		expect(zip.text("xl/worksheets/sheet1.xml")).toContain('<c r="A3" t="inlineStr" s="1"><is><t xml:space="preserve">Servizi</t></is></c>');
	});

	it("gives sheets names Excel accepts and refuses an empty sheet", () => {
		const made = make("xlsx", "# Q1/Q2: [bozza]\n\n| a |\n|---|\n| 1 |\n\n# Q1/Q2: [bozza]\n\n| b |\n|---|\n| 2 |\n");
		expect(new Zip(Buffer.from(made.data)).text("xl/workbook.xml")).toContain('<sheet name="Q1 Q2 bozza" sheetId="1" r:id="rIdSheet1"/><sheet name="Q1 Q2 bozza 2"');
		expect(() => make("xlsx", "# Solo un titolo")).toThrow(/niente da mettere nel foglio/);
		expect(columnName(0)).toBe("A");
		expect(columnName(27)).toBe("AB");
	});

	it("reads a CSV with semicolons and quotes", () => {
		expect(parseCsv('Nome;Città;Note\n"Rossi, Mario";Roma;"dice ""ciao"""\n')).toEqual([
			["Nome", "Città", "Note"],
			["Rossi, Mario", "Roma", 'dice "ciao"'],
		]);
		const made = makeDocument({ format: "xlsx", text: "a,b\n1,2\n", csv: true, name: "dati", pictures: [], now: NOW });
		expect(new Zip(Buffer.from(made.data)).text("xl/workbook.xml")).toContain('<sheet name="dati"');
	});
});

describe("PDF", () => {
	it("writes a PDF with the text, accents and euro readable, and the title", () => {
		const made = make("pdf", QUOTE);
		expect(made.pages).toBe(1);
		const text = documentText("prova.pdf", made.data).text.replace(/\u00a0/g, " ");
		for (const piece of ["Preventivo n. 42/2026", "Via Roma 1", "Più info sul sito", "€ 1.200,00", "Sviluppo | pagine", "IVA esclusa", "1 / 1"]) expect(text).toContain(piece);
		const raw = Buffer.from(made.data).toString("latin1");
		expect(raw).toContain("/Subtype /Link");
		expect(raw).toContain("/Title <feff");
		expect(raw.endsWith("%%EOF\n")).toBe(true);
	});

	it("goes on over pages, repeating a table's header, and numbers the pages", () => {
		const rows = Array.from({ length: 120 }, (_, i) => `| Riga ${i + 1} | ${i * 10} |`).join("\n");
		const made = make("pdf", `# Elenco\n\n| Voce | Valore |\n|---|---|\n${rows}\n`);
		expect(made.pages).toBeGreaterThan(2);
		const text = documentText("prova.pdf", made.data).text;
		expect(text.match(/Voce/g)?.length).toBe(made.pages);
		expect(text).toContain("Riga 120");
		expect(text).toContain(`${made.pages} / ${made.pages}`);
	});

	it("leaves emoji out and says so; refuses more than 300 pages", () => {
		const made = make("pdf", "Ciao 👋🏽 a tutti ✓ → fatto Ж");
		expect(documentText("prova.pdf", made.data).text).toContain("Ciao  a tutti v -> fatto ?");
		expect(made.notes).toEqual(["Le emoji non ci sono nei caratteri del PDF: le ho tolte (in Word restano).", "Un carattere non c'è nei caratteri del PDF (alfabeti non latini, simboli rari): al loro posto c'è un punto di domanda. Se servono, crea il documento in Word."]);
		expect(() => make("pdf", Array.from({ length: 302 }, () => "pagina\n\n\\newpage\n").join("\n"))).toThrow(/300 pagine/);
	});

	it("puts in PNG pictures with their transparency apart and JPEGs as they are", () => {
		const logo = rgbaPng(3, 3, (x, y) => [x * 80, y * 80, 50, x === 1 ? 0 : 255], [0, 1, 2, 3, 4]);
		const made = make("pdf", "![logo](logo.png)\n\n![foto](foto.jpg)\n\n![logo di nuovo](logo.png)", [
			{ path: "logo.png", data: logo },
			{ path: "foto.jpg", data: tinyJpeg(40, 30) },
		]);
		const raw = Buffer.from(made.data).toString("latin1");
		expect(raw.match(/\/Subtype \/Image/g)?.length).toBe(3); // the PNG, its transparency, the JPEG: each once
		expect(raw).toContain("/SMask");
		expect(raw).toContain("/Width 40 /Height 30 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode");
	});

	it("refuses an empty document", () => {
		expect(() => make("pdf", "\n\n---\n")).toThrow(/vuoto/);
	});
});

describe("PNG reading", () => {
	it("undoes every row filter and keeps the transparency apart", () => {
		const read = readPng(rgbaPng(5, 5, (x, y) => [x * 50, y * 50, (x + y) * 20, x === y ? 128 : 255], [0, 1, 2, 3, 4]));
		expect(read.channels).toBe(3);
		expect([...read.pixels.subarray(3 * (2 * 5 + 3), 3 * (2 * 5 + 3) + 3)]).toEqual([150, 100, 100]);
		expect(read.alpha?.[2 * 5 + 2]).toBe(128);
		expect(read.alpha?.[2 * 5 + 3]).toBe(255);
	});

	it("reads grey, palette and low-bit images as 8-bit pixels", () => {
		const grey = readPng(pngOf({ width: 4, height: 1, colorType: 0, bitDepth: 2, samples: Buffer.from([0b00011011]) }));
		expect([...grey.pixels]).toEqual([0, 85, 170, 255]);
		expect(grey.alpha).toBeUndefined();
		const palette = readPng(pngOf({ width: 2, height: 1, colorType: 3, bitDepth: 1, samples: Buffer.from([0b01000000]), palette: Buffer.from([255, 0, 0, 0, 0, 255]) }));
		expect([...palette.pixels]).toEqual([255, 0, 0, 0, 0, 255]);
	});

	it("refuses huge and interlaced images before taking memory for them", () => {
		expect(() => readPng(png(100_000, 100_000, 6, 8, deflateSync(Buffer.alloc(10))))).toThrow(/troppo grande/);
		expect(() => readPng(png(2, 2, 6, 8, deflateSync(Buffer.alloc(18)), 1))).toThrow(/interlacciato/);
		// More data than the size says: refused, not inflated without end.
		expect(() => readPng(png(2, 2, 6, 8, deflateSync(Buffer.alloc(10_000_000))))).toThrow(/rovinato/);
		expect(inflateSync(deflateSync(Buffer.alloc(1))).length).toBe(1);
	});
});

describe("document_create", () => {
	const setup = () => {
		const workspace = new Workspace(tempDataDir());
		const [tool] = createDocumentTools({ workspace, now: () => new Date(NOW) });
		const ctx = { step: <T>(_n: string, run: () => Promise<T>) => run() } as never;
		return { workspace, run: (args: Record<string, unknown>) => (tool as NonNullable<typeof tool>).execute(args, ctx) };
	};

	it("creates the file in the workspace and says how to send it", async () => {
		const { workspace, run } = setup();
		expect(await run({ path: "preventivi/rossi.pdf", content: QUOTE })).toMatch(/^Creato preventivi\/rossi\.pdf \(PDF, 1 pagina, \d+ KB\)\. Per darlo a chi te l'ha chiesto usa file_send\.$/);
		expect((await workspace.read("preventivi/rossi.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
		expect(await run({ path: "listino.xlsx", content: "| a | b |\n|---|---|\n| 1 | 2 |" })).toMatch(/^Creato listino\.xlsx \(Excel, 1 foglio, \d+ KB\)\./);
		expect(await run({ path: "lettera.docx", content: "Ciao" })).toMatch(/^Creato lettera\.docx \(Word, \d+ KB\)\./);
	});

	it("converts a CSV from the workspace, and refuses what it cannot make", async () => {
		const { workspace, run } = setup();
		await workspace.write("dati/clienti.csv", "Nome;Spesa\nRossi;1.200,50\n");
		expect(await run({ path: "dati/clienti.xlsx", source: "dati/clienti.csv" })).toMatch(/^Creato dati\/clienti\.xlsx \(Excel, 1 foglio/);
		const sheet = new Zip(await workspace.read("dati/clienti.xlsx")).text("xl/worksheets/sheet1.xml") as string;
		expect(sheet).toContain('<c r="B2" s="3"><v>1200.5</v></c>');
		expect(await run({ path: "a.odt", content: "x" })).toBe("Errore: il nome del file deve finire con .docx (Word), .xlsx (Excel) o .pdf.");
		expect(await run({ path: "a.pdf" })).toBe("Errore: dammi il testo in content oppure un file del workspace in source (uno dei due).");
		expect(await run({ path: "a.pdf", content: "x", source: "dati/clienti.csv" })).toBe("Errore: dammi il testo in content oppure un file del workspace in source (uno dei due).");
		expect(await run({ path: "b.pdf", source: "dati/clienti.xlsx" })).toMatch(/è già un documento/);
		expect(await run({ path: "b.pdf", source: "manca.csv" })).toBe("Errore: File not found: manca.csv");
		expect(await run({ path: "b.xlsx", content: '| a |\n|---|\n| =WEBSERVICE("https://x.it") |' })).toMatch(/^Errore: non ho creato b\.xlsx: la formula =WEBSERVICE.* usa WEBSERVICE, una funzione che non scrivo/);
		expect(await run({ path: "../fuori.pdf", content: "x" })).toMatch(/^Errore: Paths cannot go up/);
		expect(await run({ path: "lungo.pdf", content: "x".repeat(400_001) })).toBe("Errore: il testo è troppo lungo per un documento (più di 400000 caratteri): dividilo in più file.");
	});

	it("puts in workspace pictures and tells about the ones too big", async () => {
		const { workspace, run } = setup();
		await workspace.write("logo.png", rgbaPng(2, 2, () => [0, 0, 0, 255], [0]));
		await workspace.write("grande.png", Buffer.alloc(11 * 1024 * 1024));
		const said = await run({ path: "a.docx", content: "![logo](logo.png)\n\n![grande](grande.png)\n\n![fuori](../x.png)" });
		expect(said).toContain("Non ho messo l'immagine grande.png: è più grande di 10 MB.");
		expect(said).toContain("Non ho messo l'immagine ../x.png: non c'è nel workspace.");
		expect(new Zip(await workspace.read("a.docx")).has("word/media/image1.png")).toBe(true);
	});
});

describe("what models write, read as meant", () => {
	it("reads underlined headings, HTML line breaks, task lists, bare links and a picture with text after it", () => {
		const blocks = markdownBlocks("Titolo\n======\n\nVia Roma 1<br>Roma\n\n- [ ] da fare\n- [x] fatto\n\nVedi https://example.com/listino.\n\n![logo](logo.png) Idraulica Rossi");
		expect(blocks[0]).toEqual({ type: "heading", level: 1, spans: [{ text: "Titolo" }] });
		expect(blocks[1]).toEqual({ type: "paragraph", spans: [{ text: "Via Roma 1\nRoma" }] });
		expect((blocks[2] as Extract<(typeof blocks)[number], { type: "list" }>).items.map((i) => i.spans[0]?.text)).toEqual(["☐ da fare", "☑ fatto"]);
		expect(blocks[3]).toEqual({ type: "paragraph", spans: [{ text: "Vedi " }, { text: "https://example.com/listino", link: "https://example.com/listino" }, { text: "." }] });
		expect(blocks.slice(4)).toEqual([
			{ type: "image", alt: "logo", path: "logo.png" },
			{ type: "paragraph", spans: [{ text: "Idraulica Rossi" }] },
		]);
		expect(markdownBlocks("![foto|8cm](a.png)")[0]).toEqual({ type: "image", alt: "foto", path: "a.png", widthCm: 8 });
	});

	it("parses text made to be slow in linear time", () => {
		// Not a wall-clock bound (it fails under a loaded suite): CPU time at 4x the input must stay near 4x, not 16x as a quadratic parser would.
		const cpuMs = (text: string): number => {
			const before = process.cpuUsage();
			const blocks = markdownBlocks(text);
			expect(blocks.length).toBeGreaterThan(0);
			const used = process.cpuUsage(before);
			return (used.user + used.system) / 1000;
		};
		const repeat = (unit: string) => (n: number) => unit.repeat(n);
		const slow: [string, (n: number) => string, number][] = [
			["spaces in a heading", (n) => `# a${" ".repeat(n)}x`, 2_000_000],
			["[", repeat("["), 200_000],
			["*a ", repeat("*a "), 20_000],
			["_a_b ", repeat("_a_b "), 12_000],
			["**a ", repeat("**a "), 10_000],
			["`a", repeat("`a"), 250_000],
			["[a](b", repeat("[a](b"), 60_000],
		];
		for (const [label, build, count] of slow) {
			// The best of two runs each: a garbage collection in one run is noise, not the parser's growth.
			const best = (n: number) => Math.min(...[1, 2].map(() => cpuMs(build(n))));
			const base = best(count);
			const quadrupled = best(count * 4);
			expect(quadrupled, `${label}: ${base} ms at ${count}, ${quadrupled} ms at ${count * 4}`).toBeLessThan(Math.max(base, 10) * 10);
		}
	});
});

describe("Excel formulas", () => {
	it("turns Italian formulas into the form Excel stores", () => {
		expect(normalizeFormula("D5*0,22")).toBe("D5*0.22");
		expect(normalizeFormula("ROUND(D7*(1-B8);2)")).toBe("ROUND(D7*(1-B8),2)");
		expect(normalizeFormula("SOMMA(B2:B3)")).toBe("SUM(B2:B3)");
		expect(normalizeFormula('SE(A1>0,5;"a,b; c";ARROTONDA(A1;2))')).toBe('IF(A1>0.5,"a,b; c",ROUND(A1,2))');
		expect(normalizeFormula("ROUND(A1,2)")).toBe("ROUND(A1,2)");
		expect(normalizeFormula("A1*1,5+SUM(B1,2)")).toBe("A1*1.5+SUM(B1,2)");
	});

	it("works out simple formulas, and leaves to Excel what it cannot", () => {
		const cells: Record<string, number | string | null> = { "0:0": 100, "0:1": 50, "0:2": "testo", "1:0": 0.22 };
		const at = (c: number, r: number) => cells[`${c}:${r}`] ?? null;
		const run = (f: string) => evaluateFormula(f, at, { left: 1000 });
		expect(run("SUM(A1:A3)*(1+B1)")).toBeCloseTo(183);
		expect(run("ROUND(1.005,2)")).toBe(1.01);
		expect(run('IF(A1>A2,"più","meno")')).toBe("più");
		expect(run("AVERAGE(A1:A3)")).toBe(75);
		expect(run("-2^2")).toBe(4);
		expect(run("A1*10%")).toBe(10);
		expect(run("A1/0")).toBeUndefined();
		expect(run("A3+1")).toBeUndefined();
		expect(run("VLOOKUP(1,A1:B2,2)")).toBeUndefined();
		expect(run("Foglio2!A1")).toBeUndefined();
		expect(evaluateFormula("SUM(A1:Z1000)", at, { left: 100 })).toBeUndefined();
	});

	it("stores the values, the column's format and the newer functions' prefix; refuses functions that call out", () => {
		const made = make("xlsx", "| Voce | Prezzo |\n|---|---|\n| Sito | € 1.000,00 |\n| IVA | =B2*22% |\n| **Totale** | **=SOMMA(B2:B3)** |\n| Loop | =B5+1 |\n| Cerca | =XLOOKUP(\"Sito\",A2:A3,B2:B3) |\n");
		const sheet = new Zip(Buffer.from(made.data)).text("xl/worksheets/sheet1.xml") as string;
		expect(sheet).toContain('<c r="B3" s="8"><f>B2*22%</f><v>220</v></c>');
		expect(sheet).toContain('<c r="B4" s="16"><f>SUM(B2:B3)</f><v>1220</v></c>');
		expect(sheet).toContain('<c r="B5" s="8"><f>B5+1</f></c>');
		expect(sheet).toContain("<f>_xlfn.XLOOKUP(&quot;Sito&quot;,A2:A3,B2:B3)</f>");
		for (const formula of ['=_xlfn.COPILOT("riassumi",A1:Z99)', '=TRANSLATE(A1,"en","it")', '=INDIRECT("A1")', "=STOCKHISTORY(A1)", "=@A1"]) expect(() => cellOf([{ text: formula }])).toThrow(/non scrivo|altri file/);
	});

	it("names sheets after the sections, keeps the intro with the title, and says where tables start when formulas count rows", () => {
		const sections = make("xlsx", "# Listino 2026\n\n## Bevande\n\n| a |\n|---|\n| 1 |\n\n## Cibo\n\n| b |\n|---|\n| 2 |\n");
		expect(new Zip(Buffer.from(sections.data)).text("xl/workbook.xml")).toContain('<sheet name="Bevande" sheetId="1" r:id="rIdSheet1"/><sheet name="Cibo"');
		const report = make("xlsx", "# Report\n\nIntroduzione.\n\n# Gennaio\n\n| a |\n|---|\n| 1 |\n");
		expect(report.sheets).toBe(2);
		const moved = make("xlsx", "Prezzi validi da ottobre.\n\n| Voce | Euro |\n|---|---|\n| a | 1 |\n| Totale | =SUM(B4:B4) |\n");
		expect(moved.notes).toEqual(["Nel foglio «prova» la tabella ha l'intestazione alla riga 3 (i dati dalla riga dopo): controlla che le formule contino le righe così."]);
		const sheet = new Zip(Buffer.from(moved.data)).text("xl/worksheets/sheet1.xml") as string;
		expect(sheet).toContain('<pane ySplit="3" topLeftCell="A4"');
		expect(sheet).toContain('<autoFilter ref="A3:B5"/>');
	});

	it("keeps sheet names whole and unique, and cuts a cell longer than Excel holds", () => {
		const made = make("xlsx", `# ${"😀".repeat(16)}\n\n| a |\n|---|\n| 1 |\n\n# ${"😀".repeat(15)}🤖\n\n| b |\n|---|\n| 2 |\n\n# \ufffe\n\n| c |\n|---|\n| ${"x".repeat(40_000)} |\n`);
		const names = [...(new Zip(Buffer.from(made.data)).text("xl/workbook.xml") as string).matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
		expect(names).toEqual(["😀".repeat(15), `${"😀".repeat(14)} 2`, "Foglio3"]);
		expect(made.notes).toContain("Una cella aveva più di 32000 caratteri, più di quanti Excel ne tiene: l'ho accorciata.");
	});
});

describe("documents for Italian offices", () => {
	it("writes accents in code, and Central European names without their signs, in the PDF", () => {
		const made = make("pdf", "Cliente: Ștefan Țăranu, Dvořák, Łukasz\n\n`perché è così`");
		const text = documentText("prova.pdf", made.data).text;
		expect(text).toContain("Stefan Taranu, Dvorák, Lukasz");
		expect(text).toContain("perché è così");
		expect(made.notes).toEqual(["Alcune lettere (come ș, ř, ł) non ci sono nei caratteri del PDF: le ho scritte senza il segno (s, r, l). Se servono esatte, crea il documento in Word."]);
	});

	it("puts a logo small on the left, and refuses tables too wide for a page", () => {
		const logo = rgbaPng(1200, 400, () => [0, 0, 0, 255], [0]);
		const made = make("docx", "![logo](logo.png)\n\nIdraulica Rossi", [{ path: "logo.png", data: logo }]);
		const xml = new Zip(Buffer.from(made.data)).text("word/document.xml") as string;
		expect(xml).toContain('<wp:extent cx="1625600" cy="541867"/>');
		expect(xml).not.toContain('<w:jc w:val="center"/></w:pPr><w:r><w:drawing>');
		const wide = `| ${Array.from({ length: 70 }, (_, i) => `c${i}`).join(" | ")} |\n|${"---|".repeat(70)}\n`;
		expect(() => make("pdf", wide)).toThrow(/più di 63 colonne/);
		expect(make("xlsx", wide).sheets).toBe(1);
	});
});
