import { DELIM, type Dict, type Document, isStream, Lexer, type Matrix, multiply, Name, nameOf, type Obj, Op, openPdf, PDF_LIMITS, PdfError, type Stream, type Value, WS } from "./pdf-objects.ts";
import { ccittDecode, PdfImageError, pngOf } from "./pdf-codecs.ts";

/** The pictures of a PDF page: what a scan shows, found and decoded. Only erasable TypeScript here (see pdf-codecs.ts). */

/** The largest picture a scanned page shows, at most: what the model can be given to look at. */
export const PDF_IMAGE_LIMITS = { maxPixels: 25_000_000, maxSide: 8_000, maxSamples: 64 * 1024 * 1024, perPage: 4, maxBytes: 20 * 1024 * 1024 } as const;

export type PdfImage = { readonly mime: "image/jpeg" | "image/png"; readonly data: Buffer; readonly width: number; readonly height: number };

export type PdfPageImage = {
	/** The page's pictures from top to bottom (a scan in strips comes in several). */
	readonly images: readonly PdfImage[];
	readonly pages: number;
	/** Pictures on the page left out: too small to matter, or past the limit. */
	readonly leftOut: number;
	/** Clockwise degrees to turn the picture to see it as the page shows it. */
	readonly turn: 0 | 90 | 180 | 270;
	/** A JPEG stored upside down and mirrored back by the page: seen as stored. */
	readonly mirrored: boolean;
	/** The pictures cover little of the page: a logo or a photo beside the text. */
	readonly small: boolean;
};

/**
 * The pictures on a page of a PDF (ADR 0028), for a scan: what the page draws, largest first in
 * weight, given from top to bottom; a JPEG as it is in the file, the rest (fax-coded, raw) as a
 * PNG. PdfError says why not.
 */
export function pdfPageImage(data: Buffer, pageNumber: number): PdfPageImage {
	const { doc, pages } = openPdf(data);
	const page = pages[pageNumber - 1];
	if (page === undefined) throw new PdfError(`il PDF ha ${pages.length} ${pages.length === 1 ? "pagina" : "pagine"}: la pagina ${pageNumber} non c'è`);
	const placed = pageImages(doc, page);
	if (placed.length === 0) throw new PdfError(`la pagina ${pageNumber} non contiene immagini`);
	const area = (m: Matrix) => Math.abs(m[0] * m[3] - m[1] * m[2]);
	const largest = Math.max(...placed.map((p) => area(p.at)));
	// Decorations (a stamp, a line drawn as an image) next to a scan are left out.
	const kept = placed.filter((p) => area(p.at) >= largest * 0.02).sort((a, b) => area(b.at) - area(a.at)).slice(0, PDF_IMAGE_LIMITS.perPage);
	const top = (m: Matrix) => m[5] + Math.max(0, m[1]) + Math.max(0, m[3]);
	kept.sort((a, b) => top(b.at) - top(a.at) || a.at[4] - b.at[4]);
	const main = kept.reduce((best, p) => (area(p.at) > area(best.at) ? p : best));
	const box = doc.get(page.get("MediaBox"));
	const pageArea = Array.isArray(box) && box.length === 4 ? Math.abs((Number(doc.get(box[2])) - Number(doc.get(box[0]))) * (Number(doc.get(box[3])) - Number(doc.get(box[1])))) : 0;
	const covered = kept.reduce((sum, p) => sum + area(p.at), 0);
	const { turn, flipped } = orientation(main.at, Number(doc.get(page.get("Rotate"))) || 0);
	const images: PdfImage[] = [];
	let bytes = 0;
	try {
		for (const p of kept) {
			const image = imageOf(doc, p.stream, p.resources, flipped);
			bytes += image.data.length;
			if (bytes > PDF_IMAGE_LIMITS.maxBytes && images.length > 0) break;
			images.push(image);
		}
	} catch (error) {
		if (error instanceof PdfImageError) throw new PdfError(error.message);
		throw error;
	}
	return { images, pages: pages.length, leftOut: placed.length - images.length, turn, mirrored: flipped && images.some((i) => i.mime === "image/jpeg"), small: pageArea > 0 && covered < pageArea * 0.15 };
}

/**
 * How the picture is drawn: its "up" in page space, after the page's own rotation, against the
 * screen's up. A picture drawn upside down and mirrored (bottom-up rows) is flipped back first.
 */
function orientation(m: Matrix, rotate: number): { turn: 0 | 90 | 180 | 270; flipped: boolean } {
	const flipped = m[0] * m[3] - m[1] * m[2] < 0;
	const up = flipped ? [-m[2], -m[3]] : [m[2], m[3]];
	const shown = (Math.atan2(up[1] as number, up[0] as number) * 180) / Math.PI - rotate;
	const turn = (((Math.round((90 - shown) / 90) * 90) % 360) + 360) % 360;
	return { turn: turn as 0 | 90 | 180 | 270, flipped };
}

type Placed = { readonly stream: Stream; readonly at: Matrix; readonly resources: Dict | undefined };

/** Inline image keys and names, in full. */
const INLINE_KEYS: Record<string, string> = { W: "Width", H: "Height", BPC: "BitsPerComponent", CS: "ColorSpace", F: "Filter", DP: "DecodeParms", IM: "ImageMask", D: "Decode", I: "Interpolate", L: "Length" };

/** The images a page draws (XObjects, inside forms too, and inline ones) with where they are drawn; each once. */
function pageImages(doc: Document, page: Dict): Placed[] {
	const found: Placed[] = [];
	const seen = new Set<Stream>();
	const walk = (content: Buffer, resources: Dict | undefined, start: Matrix, depth: number) => {
		const xobjects = doc.dict(resources?.get("XObject"));
		const lexer = new Lexer(content);
		const stack: Value[] = [];
		const saved: Matrix[] = [];
		let ctm = start;
		for (let steps = 0; steps < 2_000_000 && found.length < 200; steps++) {
			const token = lexer.next();
			if (token === undefined) break;
			if (!(token instanceof Op)) {
				if (stack.length < 64) stack.push(token);
				continue;
			}
			const num = (i: number) => Number(stack[stack.length - i]) || 0;
			if (token.op === "q" && saved.length < 64) saved.push(ctm);
			else if (token.op === "Q") ctm = saved.pop() ?? ctm;
			else if (token.op === "cm") ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
			else if (token.op === "Do") {
				const xo = doc.get(xobjects?.get(nameOf(stack.at(-1)) ?? ""));
				if (isStream(xo) && !seen.has(xo)) {
					seen.add(xo);
					const subtype = nameOf(xo.dict.get("Subtype"));
					if (subtype === "Image") found.push({ stream: xo, at: ctm, resources });
					else if (subtype === "Form" && depth < 6) {
						const matrix = doc.get(xo.dict.get("Matrix"));
						const m: Matrix = Array.isArray(matrix) && matrix.length === 6 ? (matrix.map((v) => Number(doc.get(v)) || 0) as unknown as Matrix) : [1, 0, 0, 1, 0, 0];
						walk(doc.stream(xo), doc.dict(xo.dict.get("Resources")) ?? resources, multiply(m, ctm), depth + 1);
					}
				}
			} else if (token.op === "BI") {
				// An inline image: key value pairs up to ID, the bytes up to EI.
				const dict: Dict = new Map();
				let key: string | undefined;
				for (let pairs = 0; pairs < 64; pairs++) {
					const item = lexer.next();
					if (item === undefined || item instanceof Op) break;
					if (key === undefined && item instanceof Name) key = INLINE_KEYS[item.name] ?? item.name;
					else if (key !== undefined) {
						dict.set(key, item);
						key = undefined;
					}
				}
				const begin = lexer.pos + 1;
				const end = inlineEnd(content, begin);
				lexer.pos = end + 2;
				found.push({ stream: { dict, raw: content.subarray(begin, end) }, at: ctm, resources });
			}
			stack.length = 0;
		}
	};
	const contents = doc.get(page.get("Contents"));
	const parts = Array.isArray(contents) ? contents.map((c) => doc.get(c)) : [contents];
	walk(Buffer.concat(parts.filter(isStream).map((s) => Buffer.concat([doc.stream(s), Buffer.from("\n")]))), doc.dict(page.get("Resources")), [1, 0, 0, 1, 0, 0], 0);
	return found;
}

/** Where an inline image's bytes end: an EI between white space (binary data may hold the letters). */
function inlineEnd(content: Buffer, from: number): number {
	for (let at = content.indexOf("EI", from); at >= 0; at = content.indexOf("EI", at + 1)) {
		const after = content[at + 2];
		if (WS.has(content[at - 1] ?? 0x20) && (after === undefined || WS.has(after) || DELIM.has(after))) return at - 1;
	}
	return content.length;
}

/** A colour space as what a PNG can say: grey (maybe inverted, as ink), RGB, CMYK (made RGB) or a palette. */
type Colors = { kind: "gray"; ink?: boolean } | { kind: "rgb" } | { kind: "cmyk" } | { kind: "indexed"; palette: Buffer; entries: number };

function colorsOf(doc: Document, value: Value | Obj | undefined, resources: Dict | undefined, depth = 0): Colors | undefined {
	const v = doc.get(value as Value);
	const name = nameOf(v);
	if (name === "DeviceGray" || name === "G" || name === "CalGray") return { kind: "gray" };
	if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return { kind: "rgb" };
	if (name === "DeviceCMYK" || name === "CMYK") return { kind: "cmyk" };
	// A name of the page's resources (inline images use these).
	if (name !== undefined && depth < 2) {
		const named = doc.dict(resources?.get("ColorSpace"))?.get(name);
		return named === undefined ? undefined : colorsOf(doc, named, resources, depth + 1);
	}
	if (!Array.isArray(v) || depth > 2) return undefined;
	const family = nameOf(doc.get(v[0]));
	if (family === "CalGray") return { kind: "gray" };
	if (family === "CalRGB") return { kind: "rgb" };
	if (family === "ICCBased") {
		const n = Number(doc.dict(v[1])?.get("N"));
		return n === 1 ? { kind: "gray" } : n === 3 ? { kind: "rgb" } : n === 4 ? { kind: "cmyk" } : undefined;
	}
	// One ink (a black-only scan as a separation): more ink is darker.
	if (family === "Separation" || (family === "DeviceN" && Array.isArray(doc.get(v[1])) && (doc.get(v[1]) as Value[]).length === 1)) return { kind: "gray", ink: true };
	if (family === "Indexed" || family === "I") {
		const base = colorsOf(doc, v[1], resources, depth + 1);
		const hival = Math.min(255, Math.max(0, Math.floor(Number(doc.get(v[2])) || 0)));
		const lookupValue = doc.get(v[3]);
		const lookup = Buffer.isBuffer(lookupValue) ? lookupValue : isStream(lookupValue) ? doc.stream(lookupValue) : undefined;
		if (base === undefined || base.kind === "indexed" || lookup === undefined) return undefined;
		const entries = hival + 1;
		const palette = Buffer.alloc(entries * 3);
		const size = base.kind === "gray" ? 1 : base.kind === "rgb" ? 3 : 4;
		for (let i = 0; i < entries; i++) {
			const at = i * size;
			const c = [0, 1, 2, 3].map((k) => lookup[at + k] ?? 0) as [number, number, number, number];
			const g = base.kind === "gray" && base.ink === true ? 255 - c[0] : c[0];
			const rgb = base.kind === "gray" ? [g, g, g] : base.kind === "rgb" ? [c[0], c[1], c[2]] : cmyk(c[0], c[1], c[2], c[3]);
			palette.set(rgb, i * 3);
		}
		return { kind: "indexed", palette, entries };
	}
	return undefined;
}

function cmyk(c: number, m: number, y: number, k: number): [number, number, number] {
	return [255 - Math.min(255, c + k), 255 - Math.min(255, m + k), 255 - Math.min(255, y + k)];
}

const CANNOT = "la scansione è in un formato che non so aprire";

function imageOf(doc: Document, stream: Stream, resources: Dict | undefined, flipped: boolean): PdfImage {
	const d = stream.dict;
	const width = Math.floor(Number(doc.get(d.get("Width"))) || 0);
	const height = Math.floor(Number(doc.get(d.get("Height"))) || 0);
	if (width <= 0 || height <= 0) throw new PdfError("l'immagine della pagina è rovinata");
	if (width > PDF_IMAGE_LIMITS.maxSide || height > PDF_IMAGE_LIMITS.maxSide || width * height > PDF_IMAGE_LIMITS.maxPixels) throw new PdfError("l'immagine della pagina è troppo grande da aprire");
	const { data, filter, parm } = doc.imageData(stream);
	if (filter === "DCTDecode") {
		// The size the JPEG itself says, not the one the PDF claims.
		const size = jpegSize(data);
		if (size === undefined) throw new PdfError("l'immagine della pagina è rovinata");
		if (size.width > PDF_IMAGE_LIMITS.maxSide || size.height > PDF_IMAGE_LIMITS.maxSide) throw new PdfError("l'immagine della pagina è troppo grande da aprire");
		return { mime: "image/jpeg", data, ...size };
	}
	if (filter === "JBIG2Decode") throw new PdfError(`${CANNOT} (JBIG2)`);
	if (filter === "JPXDecode") throw new PdfError(`${CANNOT} (JPEG 2000)`);
	if (filter !== undefined && filter !== "CCITTFaxDecode") throw new PdfError(CANNOT);
	const mask = doc.get(d.get("ImageMask")) === true;
	const fax = filter === "CCITTFaxDecode";
	const bits = mask || fax ? 1 : Math.floor(Number(doc.get(d.get("BitsPerComponent"))) || 8);
	const colors: Colors | undefined = mask || fax ? { kind: "gray" } : colorsOf(doc, d.get("ColorSpace"), resources);
	if (colors === undefined) throw new PdfError("i colori della scansione sono in un formato che non so aprire");
	// What a PNG can hold: grey at any depth, a palette up to 8 bits, RGB at 8 or 16, CMYK at 8 (made RGB).
	const fits = colors.kind === "gray" ? [1, 2, 4, 8, 16].includes(bits) : colors.kind === "indexed" ? [1, 2, 4, 8].includes(bits) : colors.kind === "rgb" ? bits === 8 || bits === 16 : bits === 8;
	if (!fits) throw new PdfError(CANNOT);
	const channels = colors.kind === "rgb" ? 3 : colors.kind === "cmyk" ? 4 : 1;
	const rowBytes = Math.ceil((width * channels * bits) / 8);
	// Every buffer below is sized from these numbers: checked before any is made.
	if (rowBytes * height > PDF_IMAGE_LIMITS.maxSamples || (colors.kind === "cmyk" && width * height * 3 > PDF_IMAGE_LIMITS.maxSamples)) throw new PdfError("l'immagine della pagina è troppo grande da aprire");
	const decodeArray = doc.get(d.get("Decode"));
	const inverted = Array.isArray(decodeArray) && Number(doc.get(decodeArray[0])) === 1 && Number(doc.get(decodeArray[1])) === 0;
	let samples = data;
	if (fax) {
		const k = doc.get(parm?.get("K"));
		samples = ccittDecode(data, { k: typeof k === "number" ? k : 0, columns: width, rows: height, blackIs1: doc.get(parm?.get("BlackIs1")) === true, byteAlign: doc.get(parm?.get("EncodedByteAlign")) === true });
	}
	// A short tail is padded white; an image with most of its bytes missing is not a scan.
	if (samples.length < (rowBytes * height) / 2) throw new PdfError("l'immagine della pagina è rovinata");
	if (samples.length < rowBytes * height) samples = Buffer.concat([samples, Buffer.alloc(rowBytes * height - samples.length, 0xff)]);
	samples = Buffer.from(samples.subarray(0, rowBytes * height));
	// Rows stored bottom up come out the right way round.
	if (flipped) {
		const rows = Buffer.alloc(samples.length);
		for (let y = 0; y < height; y++) samples.copy(rows, (height - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
		samples = rows;
	}
	if (colors.kind === "gray") {
		// 0 is black in a grey image and in a mask; Decode [1 0], and an ink, turn it round.
		if (inverted !== (colors.ink === true)) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] as number) ^ 0xff;
		return { mime: "image/png", data: pngOf({ width, height, colorType: 0, bitDepth: bits, samples }), width, height };
	}
	if (colors.kind === "indexed") return { mime: "image/png", data: pngOf({ width, height, colorType: 3, bitDepth: bits, samples, palette: colors.palette }), width, height };
	if (colors.kind === "rgb") return { mime: "image/png", data: pngOf({ width, height, colorType: 2, bitDepth: bits, samples }), width, height };
	const rgb = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) rgb.set(cmyk(samples[i * 4] ?? 0, samples[i * 4 + 1] ?? 0, samples[i * 4 + 2] ?? 0, samples[i * 4 + 3] ?? 0), i * 3);
	return { mime: "image/png", data: pngOf({ width, height, colorType: 2, bitDepth: 8, samples: rgb }), width, height };
}

/** A JPEG's size from its frame header, or undefined when there is none. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
	if (data[0] !== 0xff || data[1] !== 0xd8) return undefined;
	for (let at = 2; at + 9 < data.length; ) {
		if (data[at] !== 0xff) return undefined;
		const marker = data[at + 1] as number;
		if (marker === 0xff) {
			at++;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			at += 2;
			continue;
		}
		// Start of frame: any of C0 to CF except C4 (tables), C8 (reserved) and CC (arithmetic tables).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
		at += 2 + data.readUInt16BE(at + 2);
	}
	return undefined;
}
