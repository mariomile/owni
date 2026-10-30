/** The parts of PDF.js's image decoders (pdfjs-dist ships them without types) that pdf-scan-codecs.ts uses. */
declare module "pdfjs-dist/image_decoders/pdf.image_decoders.mjs" {
	type Wasm = { setOptions(options: { useWasm: boolean; useWorkerFetch: boolean; handler?: { sendWithPromise(kind: string, data: { filename: string }): Promise<Uint8Array> } }): void };
	export const Jbig2Image: Wasm & { readonly instance: { decode(data: Uint8Array, width: number, height: number, globals: Uint8Array | null, ccitt: null): Promise<Uint8Array | null> } };
	export const JpxImage: Wasm & {
		readonly instance: { decode(data: Uint8Array, options: { numComponents: number; isIndexedColormap: boolean; smaskInData: boolean }): Promise<Uint8Array | null> };
	};
}
