import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Jbig2Image, JpxImage } from "pdfjs-dist/image_decoders/pdf.image_decoders.mjs";
import { PdfImageError } from "./pdf-codecs.ts";

/**
 * The two scan formats too large to decode by hand (ADR 0136): JBIG2, the black and white of
 * office scanners, and JPEG 2000, with PDF.js's decoders (pdfjs-dist, WebAssembly builds of
 * PDFium's JBIG2 decoder and OpenJPEG). The caller bounds every size before and after.
 *
 * Only erasable TypeScript here: the document worker runs this file by stripping the types.
 */

const wasm = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "wasm");
// Node's fetch reads no files: the WebAssembly comes from the package folder. The options are
// shared by both decoders.
JpxImage.setOptions({ useWasm: true, useWorkerFetch: false, handler: { sendWithPromise: async (_kind, { filename }) => new Uint8Array(await readFile(join(wasm, filename))) } });

/** A JBIG2 page: packed rows of 1-bit samples, 0 black (as a grey PDF image), exactly width × height. */
export async function jbig2Decode(data: Buffer, globals: Buffer | undefined, width: number, height: number): Promise<Buffer> {
	const samples = await decoding(() => Jbig2Image.instance.decode(new Uint8Array(data), width, height, globals === undefined ? null : new Uint8Array(globals), null));
	if (samples.length !== Math.ceil(width / 8) * height) throw new PdfImageError("l'immagine della pagina è rovinata");
	return Buffer.from(samples.buffer, samples.byteOffset, samples.length);
}

/** A JPEG 2000 picture's own size and number of colour components, read before decoding it. */
export function jpxSize(data: Buffer): { width: number; height: number; components: number } {
	try {
		const { width, height, componentsCount } = JpxImage.parseImageProperties(new Uint8Array(data));
		return { width, height, components: componentsCount };
	} catch {
		throw new PdfImageError("l'immagine della pagina è rovinata");
	}
}

/** A JPEG 2000 picture: 8-bit samples, its components interleaved (a palette index when indexed). */
export async function jpxDecode(data: Buffer, indexed: boolean): Promise<Buffer> {
	const samples = await decoding(() => JpxImage.instance.decode(new Uint8Array(data), { isIndexedColormap: indexed }));
	return Buffer.from(samples.buffer, samples.byteOffset, samples.length);
}

async function decoding(run: () => Promise<Uint8Array>): Promise<Uint8Array> {
	try {
		return await run();
	} catch {
		throw new PdfImageError("l'immagine della pagina è rovinata");
	}
}
