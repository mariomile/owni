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

const BROKEN = "l'immagine della pagina è rovinata";

/** A JBIG2 page: packed rows of 1-bit samples, 0 black (as a grey PDF image), exactly width × height. */
export async function jbig2Decode(data: Buffer, globals: Buffer | undefined, width: number, height: number): Promise<Buffer> {
	const samples = await decoding(() => Jbig2Image.instance.decode(new Uint8Array(data), width, height, globals === undefined ? null : new Uint8Array(globals), null));
	if (samples.length !== Math.ceil(width / 8) * height) throw new PdfImageError(BROKEN);
	return samples;
}

/**
 * A JPEG 2000 picture's own size and number of colour components, from its codestream's SIZ
 * header: right after the start of a raw codestream, or of the jp2c box of a JP2 file. Not by
 * searching the bytes for the marker, which a colour profile or any other box may hold.
 */
export function jpxSize(data: Buffer): { width: number; height: number; components: number } {
	let at = 0;
	if (data.length >= 12 && data.readUInt32BE(0) === 12 && data.toString("latin1", 4, 8) === "jP  ") {
		// A JP2 file: boxes of length (0 to the end, 1 a 64-bit length after the type) and type.
		for (at = 0; ; ) {
			if (at + 8 > data.length) throw new PdfImageError(BROKEN);
			const short = data.readUInt32BE(at);
			const header = short === 1 ? 16 : 8;
			const length = short === 0 ? data.length - at : short === 1 ? Number(data.readBigUInt64BE(at + 8)) : short;
			if (length < header || at + header > data.length) throw new PdfImageError(BROKEN);
			if (data.toString("latin1", at + 4, at + 8) === "jp2c") {
				at += header;
				break;
			}
			at += length;
		}
	}
	// SOC, SIZ, then Lsiz, Rsiz, Xsiz, Ysiz, XOsiz, YOsiz, the tile sizes and offsets, Csiz.
	if (at + 42 > data.length || data.readUInt16BE(at) !== 0xff4f || data.readUInt16BE(at + 2) !== 0xff51) throw new PdfImageError(BROKEN);
	return { width: data.readUInt32BE(at + 8) - data.readUInt32BE(at + 16), height: data.readUInt32BE(at + 12) - data.readUInt32BE(at + 20), components: data.readUInt16BE(at + 40) };
}

/**
 * A JPEG 2000 picture as 8-bit samples, `channels` interleaved per pixel (one palette index when
 * indexed): components past them (an alpha channel) are left out.
 */
export async function jpxDecode(data: Buffer, channels: number, indexed: boolean, alpha: boolean): Promise<Buffer> {
	return decoding(() => JpxImage.instance.decode(new Uint8Array(data), { numComponents: channels, isIndexedColormap: indexed, smaskInData: alpha }));
}

async function decoding(run: () => Promise<Uint8Array | null>): Promise<Buffer> {
	let samples: Uint8Array | null;
	try {
		samples = await run();
	} catch (error) {
		// The WebAssembly did not load: this installation, not the file.
		if (error instanceof Error && error.message.includes("failed to initialize")) throw new PdfImageError("non riesco ad aprire le scansioni JBIG2 e JPEG 2000 su questa installazione");
		throw new PdfImageError(BROKEN);
	}
	if (samples === null) throw new PdfImageError(BROKEN);
	return Buffer.from(samples.buffer, samples.byteOffset, samples.length);
}
