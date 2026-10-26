import { deflateSync } from "node:zlib";


/**
 * What a scanned PDF page is made of, turned into a picture the model can look at (ADR 0028):
 * a fax-coded black and white scan decoded (CCITT group 3 and 4), raw samples written as a PNG.
 * No dependencies; every size is bounded by the caller.
 *
 * Only erasable TypeScript here: the document worker runs this file by stripping the types.
 */
export class PdfImageError extends Error {
	override readonly name = "PdfImageError";
}

// T.4 run-length codes: [run, code]. Terminating codes (0-63), then makeup codes.
const WHITE: readonly (readonly [number, string])[] = [
	[0, "00110101"], [1, "000111"], [2, "0111"], [3, "1000"], [4, "1011"], [5, "1100"], [6, "1110"], [7, "1111"],
	[8, "10011"], [9, "10100"], [10, "00111"], [11, "01000"], [12, "001000"], [13, "000011"], [14, "110100"], [15, "110101"],
	[16, "101010"], [17, "101011"], [18, "0100111"], [19, "0001100"], [20, "0001000"], [21, "0010111"], [22, "0000011"], [23, "0000100"],
	[24, "0101000"], [25, "0101011"], [26, "0010011"], [27, "0100100"], [28, "0011000"], [29, "00000010"], [30, "00000011"], [31, "00011010"],
	[32, "00011011"], [33, "00010010"], [34, "00010011"], [35, "00010100"], [36, "00010101"], [37, "00010110"], [38, "00010111"], [39, "00101000"],
	[40, "00101001"], [41, "00101010"], [42, "00101011"], [43, "00101100"], [44, "00101101"], [45, "00000100"], [46, "00000101"], [47, "00001010"],
	[48, "00001011"], [49, "01010010"], [50, "01010011"], [51, "01010100"], [52, "01010101"], [53, "00100100"], [54, "00100101"], [55, "01011000"],
	[56, "01011001"], [57, "01011010"], [58, "01011011"], [59, "01001010"], [60, "01001011"], [61, "00110010"], [62, "00110011"], [63, "00110100"],
	[64, "11011"], [128, "10010"], [192, "010111"], [256, "0110111"], [320, "00110110"], [384, "00110111"], [448, "01100100"], [512, "01100101"],
	[576, "01101000"], [640, "01100111"], [704, "011001100"], [768, "011001101"], [832, "011010010"], [896, "011010011"], [960, "011010100"], [1024, "011010101"],
	[1088, "011010110"], [1152, "011010111"], [1216, "011011000"], [1280, "011011001"], [1344, "011011010"], [1408, "011011011"], [1472, "010011000"], [1536, "010011001"],
	[1600, "010011010"], [1664, "011000"], [1728, "010011011"],
];
const BLACK: readonly (readonly [number, string])[] = [
	[0, "0000110111"], [1, "010"], [2, "11"], [3, "10"], [4, "011"], [5, "0011"], [6, "0010"], [7, "00011"],
	[8, "000101"], [9, "000100"], [10, "0000100"], [11, "0000101"], [12, "0000111"], [13, "00000100"], [14, "00000111"], [15, "000011000"],
	[16, "0000010111"], [17, "0000011000"], [18, "0000001000"], [19, "00001100111"], [20, "00001101000"], [21, "00001101100"], [22, "00000110111"], [23, "00000101000"],
	[24, "00000010111"], [25, "00000011000"], [26, "000011001010"], [27, "000011001011"], [28, "000011001100"], [29, "000011001101"], [30, "000001101000"], [31, "000001101001"],
	[32, "000001101010"], [33, "000001101011"], [34, "000011010010"], [35, "000011010011"], [36, "000011010100"], [37, "000011010101"], [38, "000011010110"], [39, "000011010111"],
	[40, "000001101100"], [41, "000001101101"], [42, "000011011010"], [43, "000011011011"], [44, "000001010100"], [45, "000001010101"], [46, "000001010110"], [47, "000001010111"],
	[48, "000001100100"], [49, "000001100101"], [50, "000001010010"], [51, "000001010011"], [52, "000000100100"], [53, "000000110111"], [54, "000000111000"], [55, "000000100111"],
	[56, "000000101000"], [57, "000001011000"], [58, "000001011001"], [59, "000000101011"], [60, "000000101100"], [61, "000001011010"], [62, "000001100110"], [63, "000001100111"],
	[64, "0000001111"], [128, "000011001000"], [192, "000011001001"], [256, "000001011011"], [320, "000000110011"], [384, "000000110100"], [448, "000000110101"], [512, "0000001101100"],
	[576, "0000001101101"], [640, "0000001001010"], [704, "0000001001011"], [768, "0000001001100"], [832, "0000001001101"], [896, "0000001110010"], [960, "0000001110011"], [1024, "0000001110100"],
	[1088, "0000001110101"], [1152, "0000001110110"], [1216, "0000001110111"], [1280, "0000001010010"], [1344, "0000001010011"], [1408, "0000001010100"], [1472, "0000001010101"], [1536, "0000001011010"],
	[1600, "0000001011011"], [1664, "0000001100100"], [1728, "0000001100101"],
];
/** Makeup codes longer than 1728, the same for both colours. */
const EXTENDED: readonly (readonly [number, string])[] = [
	[1792, "00000001000"], [1856, "00000001100"], [1920, "00000001101"], [1984, "000000010010"], [2048, "000000010011"], [2112, "000000010100"], [2176, "000000010101"],
	[2240, "000000010110"], [2304, "000000010111"], [2368, "000000011100"], [2432, "000000011101"], [2496, "000000011110"], [2560, "000000011111"],
];

/** Codes keyed by length and value: a code is looked up as the bits are read, one at a time. */
function table(codes: readonly (readonly [number, string])[]): Map<number, number> {
	const map = new Map<number, number>();
	for (const [run, code] of [...codes, ...EXTENDED]) map.set((code.length << 16) | parseInt(code, 2), run);
	return map;
}
const WHITE_CODES = table(WHITE);
const BLACK_CODES = table(BLACK);

class Bits {
	private at = 0;
	readonly data: Buffer;
	constructor(data: Buffer) {
		this.data = data;
	}
	get done(): boolean {
		return this.at >= this.data.length * 8;
	}
	bit(): number {
		if (this.done) throw new PdfImageError("la scansione è troncata");
		const b = ((this.data[this.at >> 3] as number) >> (7 - (this.at & 7))) & 1;
		this.at++;
		return b;
	}
	peek(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) {
			const at = this.at + i;
			v = (v << 1) | (at >= this.data.length * 8 ? 0 : ((this.data[at >> 3] as number) >> (7 - (at & 7))) & 1);
		}
		return v;
	}
	skip(n: number): void {
		this.at += n;
	}
	align(): void {
		this.at = (this.at + 7) & ~7;
	}
}

/** One run length of a colour: makeup codes add up until a terminating code (under 64). */
function run(bits: Bits, codes: Map<number, number>): number {
	let total = 0;
	for (let guard = 0; guard < 64; guard++) {
		let code = 0;
		let found: number | undefined;
		for (let length = 1; length <= 13 && found === undefined; length++) {
			code = (code << 1) | bits.bit();
			found = codes.get((length << 16) | code);
		}
		if (found === undefined) throw new PdfImageError("la scansione è rovinata");
		total += found;
		if (found < 64) return total;
	}
	throw new PdfImageError("la scansione è rovinata");
}

/** Skips an end-of-line code (eleven zeros and a one, after any fill bits) if one is next. */
function skipEol(bits: Bits): boolean {
	if (bits.peek(11) !== 0) return false;
	let zeros = 0;
	while (!bits.done && bits.peek(1) === 0 && zeros < 4096) {
		bits.skip(1);
		zeros++;
	}
	if (bits.done) return true;
	bits.skip(1);
	return true;
}

export type CcittParams = { readonly k: number; readonly columns: number; readonly rows: number; readonly blackIs1: boolean; readonly byteAlign: boolean };

/**
 * CCITT fax data (group 4 when k < 0, one-dimensional group 3 when k = 0) as rows of packed
 * bits, as the PDF filter gives them: 1 is black when blackIs1, white otherwise.
 */
export function ccittDecode(data: Buffer, p: CcittParams): Buffer {
	if (p.k > 0) throw new PdfImageError("la scansione è in un formato che non so aprire (fax misto)");
	const columns = p.columns;
	const rowBytes = (columns + 7) >> 3;
	const out = Buffer.alloc(rowBytes * p.rows, p.blackIs1 ? 0 : 0xff);
	const bits = new Bits(data);
	let reference: number[] = [];
	for (let row = 0; row < p.rows; row++) {
		if (p.byteAlign) bits.align();
		if (p.k === 0) skipEol(bits);
		else if (bits.peek(12) === 1) {
			// End of the block (two EOLs): the rest of the page is white.
			if (bits.peek(24) === 0x001001) break;
			skipEol(bits);
		}
		if (bits.done) break;
		const changes = p.k === 0 ? oneDimensional(bits, columns) : twoDimensional(bits, columns, reference);
		paint(out, row * rowBytes, changes, columns, p.blackIs1);
		reference = changes;
	}
	return out;
}

/** A line of white and black runs, starting with white. Changes: where the colour flips. */
function oneDimensional(bits: Bits, columns: number): number[] {
	const changes: number[] = [];
	let at = 0;
	let white = true;
	while (at < columns) {
		at = Math.min(columns, at + run(bits, white ? WHITE_CODES : BLACK_CODES));
		changes.push(at);
		// Runs of zero that never get anywhere: a broken line, not a long one.
		if (changes.length > columns + 2) throw new PdfImageError("la scansione è rovinata");
		white = !white;
	}
	return changes;
}

/** A line coded against the one above (modified READ). Each step moves a0 right, so a line costs its width at most. */
function twoDimensional(bits: Bits, columns: number, reference: readonly number[]): number[] {
	const changes: number[] = [];
	let a0 = -1;
	let white = true;
	// Where b1 is looked for: a0 only moves right, so neither does this.
	let from = 0;
	while (a0 < columns) {
		while (from < reference.length && (reference[from] as number) <= a0) from++;
		// b1: the first change on the line above, right of a0, to the colour opposite to a0's.
		const i = from % 2 === (white ? 0 : 1) ? from : from + 1;
		const b1 = reference[i] ?? columns;
		const b2 = reference[i + 1] ?? columns;
		const before = a0;
		if (bits.bit() === 1) {
			// V0
			a0 = vertical(changes, b1, columns);
			white = !white;
		} else if (bits.bit() === 1) {
			if (bits.bit() === 1) a0 = vertical(changes, b1 + 1, columns);
			else a0 = vertical(changes, b1 - 1, columns);
			white = !white;
		} else if (bits.bit() === 1) {
			// Horizontal: two runs, a0's colour first.
			const start = Math.max(a0, 0);
			const first = Math.min(columns, start + run(bits, white ? WHITE_CODES : BLACK_CODES));
			const second = Math.min(columns, first + run(bits, white ? BLACK_CODES : WHITE_CODES));
			changes.push(first, second);
			a0 = second;
		} else if (bits.bit() === 1) {
			// Pass: a0 moves under b2, no change of colour.
			a0 = b2;
		} else if (bits.bit() === 1) {
			a0 = vertical(changes, bits.bit() === 1 ? b1 + 2 : b1 - 2, columns);
			white = !white;
		} else if (bits.bit() === 1) {
			a0 = vertical(changes, bits.bit() === 1 ? b1 + 3 : b1 - 3, columns);
			white = !white;
		} else throw new PdfImageError("la scansione è in un formato che non so aprire (fax con estensioni)");
		// Only the first step of a line may stay where it is (a line that starts black).
		if (a0 <= before && before >= 0) throw new PdfImageError("la scansione è rovinata");
	}
	return changes;
}

function vertical(changes: number[], a1: number, columns: number): number {
	const at = Math.max(0, Math.min(columns, a1));
	changes.push(at);
	return at;
}

/** Black where the changes say, in a row that starts all white. */
function paint(out: Buffer, start: number, changes: readonly number[], columns: number, blackIs1: boolean): void {
	let from = 0;
	for (let i = 0; i < changes.length; i++) {
		const to = Math.min(columns, Math.max(from, changes[i] as number));
		if (i % 2 === 1) {
			for (let x = from; x < to; x++) {
				const byte = start + (x >> 3);
				const mask = 0x80 >> (x & 7);
				out[byte] = blackIs1 ? (out[byte] as number) | mask : (out[byte] as number) & ~mask;
			}
		}
		from = to;
	}
}

export type PngPixels = {
	readonly width: number;
	readonly height: number;
	/** 0 grey, 2 RGB, 3 palette. */
	readonly colorType: 0 | 2 | 3;
	readonly bitDepth: number;
	/** Rows of samples, each padded to a whole byte, as in a PDF image. */
	readonly samples: Buffer;
	/** RGB triplets, for a palette. */
	readonly palette?: Buffer;
};

/** A PNG of the samples: every row with filter 0, one deflated IDAT. */
export function pngOf(p: PngPixels): Buffer {
	const channels = p.colorType === 2 ? 3 : 1;
	const rowBytes = Math.ceil((p.width * channels * p.bitDepth) / 8);
	const raw = Buffer.alloc((rowBytes + 1) * p.height);
	for (let y = 0; y < p.height; y++) p.samples.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, Math.min(p.samples.length, (y + 1) * rowBytes));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(p.width, 0);
	header.writeUInt32BE(p.height, 4);
	header[8] = p.bitDepth;
	header[9] = p.colorType;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		...(p.palette === undefined ? [] : [chunk("PLTE", p.palette)]),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(data: Buffer): number {
	let c = 0xffffffff;
	for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** LZW, as PDF uses it (codes of 9 to 12 bits, EarlyChange 1 by default). At most `max` bytes. */
export function lzwDecode(data: Buffer, earlyChange: 0 | 1, max: number): Buffer {
	const prefix = new Int32Array(4096);
	const suffix = new Uint8Array(4096);
	const first = new Uint8Array(4096);
	const length = new Int32Array(4096);
	for (let i = 0; i < 256; i++) {
		prefix[i] = -1;
		suffix[i] = i;
		first[i] = i;
		length[i] = 1;
	}
	const chunks: Buffer[] = [];
	let out = Buffer.alloc(Math.min(max, Math.max(1024, data.length * 4)));
	let size = 0;
	let next = 258;
	let width = 9;
	let previous = -1;
	let acc = 0;
	let held = 0;
	let at = 0;
	const write = (code: number) => {
		const n = length[code] as number;
		if (size + n > out.length) {
			chunks.push(out.subarray(0, size));
			if (chunks.reduce((sum, c) => sum + c.length, 0) + n > max) throw new PdfImageError("una parte del PDF è troppo grande da leggere");
			out = Buffer.alloc(Math.min(max, Math.max(out.length * 2, n)));
			size = 0;
		}
		for (let c = code, i = n - 1; i >= 0; i--) {
			out[size + i] = suffix[c] as number;
			c = prefix[c] as number;
		}
		size += n;
	};
	for (;;) {
		while (held < width && at < data.length) {
			acc = ((acc << 8) | (data[at++] as number)) & 0xffffff;
			held += 8;
		}
		if (held < width) break;
		const code = (acc >> (held - width)) & ((1 << width) - 1);
		held -= width;
		if (code === 256) {
			next = 258;
			width = 9;
			previous = -1;
			continue;
		}
		if (code === 257) break;
		if (previous === -1) {
			if (code > 255) break;
			write(code);
			previous = code;
			continue;
		}
		if (code > next) break;
		if (next < 4096) {
			prefix[next] = previous;
			suffix[next] = code === next ? (first[previous] as number) : (first[code] as number);
			first[next] = first[previous] as number;
			length[next] = (length[previous] as number) + 1;
			next++;
		}
		write(code);
		if (next + earlyChange >= 1 << width && width < 12) width++;
		previous = code;
	}
	chunks.push(out.subarray(0, size));
	return Buffer.concat(chunks);
}

/** RunLength: a length byte, then that many bytes or one byte repeated. At most `max` bytes. */
export function runLengthDecode(data: Buffer, max: number): Buffer {
	const parts: Buffer[] = [];
	let total = 0;
	for (let at = 0; at < data.length; ) {
		const n = data[at] as number;
		if (n === 128) break;
		const part = n < 128 ? data.subarray(at + 1, at + 2 + n) : Buffer.alloc(257 - n, data[at + 1] ?? 0);
		at += n < 128 ? n + 2 : 2;
		total += part.length;
		if (total > max) throw new PdfImageError("una parte del PDF è troppo grande da leggere");
		parts.push(part);
	}
	return Buffer.concat(parts);
}
