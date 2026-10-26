import { inflateSync } from "node:zlib";
import { type PdfEncryption, pdfCipher, type PdfCipher } from "./pdf-crypt.ts";
import { ccittDecode, lzwDecode, PdfImageError, runLengthDecode } from "./pdf-codecs.ts";

/**
 * The object layer of the PDF reader (ADR 0026): the lexer, the objects of a file (also those
 * packed in object streams), stream filters, decryption, and the page tree. Shared by the text
 * reader and the page-image reader.
 */
export class PdfError extends Error {
	override readonly name = "PdfError";
}

export const PDF_LIMITS = { maxStreamBytes: 20 * 1024 * 1024, maxDecodedBytes: 120 * 1024 * 1024, maxPages: 1_000, maxTextChars: 2_000_000, maxObjects: 500_000, maxDepth: 64 } as const;

// No parameter properties in the files the document worker loads: Node strips the types there, nothing else.
export class Name {
	readonly name: string;
	constructor(name: string) {
		this.name = name;
	}
}
export class Ref {
	readonly num: number;
	readonly gen: number;
	constructor(num: number, gen: number) {
		this.num = num;
		this.gen = gen;
	}
}
export class Op {
	readonly op: string;
	constructor(op: string) {
		this.op = op;
	}
}
export type Dict = Map<string, Value>;
export type Value = null | boolean | number | Buffer | Name | Ref | Value[] | Dict;
/** A stream and, for decryption, the number of the object that holds it. */
export type Stream = { readonly dict: Dict; readonly raw: Buffer; readonly num?: number; readonly gen?: number };
export type Obj = Value | Stream;

export const isDict = (v: unknown): v is Dict => v instanceof Map;
export const isStream = (v: unknown): v is Stream => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && !Buffer.isBuffer(v) && "raw" in v && "dict" in v;

/** What the lexer returns for a byte it skips. */
const SKIP = Symbol("skip");

export const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
export const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** PDF syntax: objects in a file, operands and operators in a content stream. */
export class Lexer {
	pos: number;
	readonly data: Buffer;
	constructor(data: Buffer, start = 0) {
		this.data = data;
		this.pos = start;
	}

	skip(): void {
		const d = this.data;
		while (this.pos < d.length) {
			const c = d[this.pos] as number;
			if (WS.has(c)) this.pos++;
			else if (c === 0x25) {
				while (this.pos < d.length && d[this.pos] !== 0x0a && d[this.pos] !== 0x0d) this.pos++;
			} else break;
		}
	}

	/** The next value, an operator, or undefined at the end. Depth bounds nested arrays and dicts. */
	next(depth = 0): Value | Op | undefined {
		if (depth > PDF_LIMITS.maxDepth) throw new PdfError("struttura troppo annidata");
		// Stray delimiters and unknown bytes are skipped here, in a loop, never by recursion.
		for (;;) {
			const value = this.token(depth);
			if (value !== SKIP) return value;
		}
	}

	private token(depth: number): Value | Op | undefined | typeof SKIP {
		this.skip();
		const d = this.data;
		if (this.pos >= d.length) return undefined;
		const c = d[this.pos] as number;
		if (c === 0x2f) return new Name(this.word(1));
		if (c === 0x28) return this.literal();
		if (c === 0x3c) {
			if (d[this.pos + 1] === 0x3c) {
				this.pos += 2;
				const dict: Dict = new Map();
				for (;;) {
					this.skip();
					if (this.pos >= d.length) return dict;
					if (d[this.pos] === 0x3e && d[this.pos + 1] === 0x3e) {
						this.pos += 2;
						return dict;
					}
					const key = this.next(depth + 1);
					if (!(key instanceof Name)) {
						if (key === undefined) return dict;
						continue;
					}
					const value = this.value(depth + 1);
					if (value !== undefined) dict.set(key.name, value);
				}
			}
			return this.hex();
		}
		if (c === 0x5b) {
			this.pos++;
			const items: Value[] = [];
			for (;;) {
				this.skip();
				if (this.pos >= d.length) return items;
				if (d[this.pos] === 0x5d) {
					this.pos++;
					return items;
				}
				const item = this.value(depth + 1);
				if (item === undefined) {
					this.pos++;
					continue;
				}
				items.push(item);
			}
		}
		if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7b || c === 0x7d) {
			this.pos++;
			return SKIP;
		}
		const word = this.word(0);
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
			const n = Number(word);
			// "num gen R" is a reference.
			if (/^\d+$/.test(word)) {
				const save = this.pos;
				this.skip();
				const gen = this.word(0);
				this.skip();
				if (/^\d+$/.test(gen) && this.data[this.pos] === 0x52 && this.boundary(this.pos + 1)) {
					this.pos++;
					return new Ref(n, Number(gen));
				}
				this.pos = save;
			}
			return n;
		}
		if (word === "true") return true;
		if (word === "false") return false;
		if (word === "null") return null;
		if (word === "") {
			this.pos++;
			return SKIP;
		}
		return new Op(word);
	}

	/** A value, skipping stray operators (inside objects there are none). */
	value(depth = 0): Value | undefined {
		const v = this.next(depth);
		return v instanceof Op ? undefined : v;
	}

	private boundary(at: number): boolean {
		const c = this.data[at];
		return c === undefined || WS.has(c) || DELIM.has(c);
	}

	private word(from: number): string {
		const d = this.data;
		const start = this.pos + from;
		let end = start;
		while (end < d.length && !WS.has(d[end] as number) && !DELIM.has(d[end] as number)) end++;
		this.pos = end;
		const raw = d.subarray(start, end).toString("latin1");
		return from === 1 ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))) : raw;
	}

	private literal(): Buffer {
		const d = this.data;
		const out: number[] = [];
		let depth = 0;
		this.pos++;
		while (this.pos < d.length) {
			const c = d[this.pos++] as number;
			if (c === 0x5c) {
				const e = d[this.pos++];
				if (e === undefined) break;
				const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
				if (map[e] !== undefined) out.push(map[e] as number);
				else if (e >= 0x30 && e <= 0x37) {
					let n = e - 0x30;
					for (let i = 0; i < 2 && (d[this.pos] as number) >= 0x30 && (d[this.pos] as number) <= 0x37; i++) n = n * 8 + ((d[this.pos++] as number) - 0x30);
					out.push(n & 0xff);
				} else if (e === 0x0d) {
					if (d[this.pos] === 0x0a) this.pos++;
				} else if (e !== 0x0a) out.push(e);
			} else if (c === 0x28) {
				depth++;
				out.push(c);
			} else if (c === 0x29) {
				if (depth === 0) break;
				depth--;
				out.push(c);
			} else out.push(c);
		}
		return Buffer.from(out);
	}

	private hex(): Buffer {
		const d = this.data;
		this.pos++;
		let digits = "";
		while (this.pos < d.length && d[this.pos] !== 0x3e) {
			const ch = String.fromCharCode(d[this.pos++] as number);
			if (/[0-9a-fA-F]/.test(ch)) digits += ch;
		}
		this.pos++;
		if (digits.length % 2 === 1) digits += "0";
		return Buffer.from(digits, "hex");
	}
}

/** The objects of the file, by number: direct ones, then those inside object streams. */
export class Document {
	readonly objects = new Map<number, Obj>();
	/** Set for an encrypted PDF that opens without a password. */
	cipher: PdfCipher | undefined;
	encryptMetadata = true;
	private decoded = 0;
	private spent = false;
	private readonly decodedStreams = new WeakMap<Stream, Buffer>();
	trailer: Dict = new Map();

	readonly data: Buffer;

	constructor(data: Buffer) {
		this.data = data;
		const text = data.toString("latin1");
		const header = /(\d+)\s+(\d+)\s+obj\b/g;
		let count = 0;
		for (let m = header.exec(text); m !== null; m = header.exec(text)) {
			if (++count > PDF_LIMITS.maxObjects) throw new PdfError("troppi oggetti");
			const lexer = new Lexer(data, m.index + m[0].length);
			let value: Value | undefined;
			try {
				value = lexer.value();
			} catch (error) {
				if (error instanceof PdfError) throw error;
				continue;
			}
			if (value === undefined) continue;
			lexer.skip();
			if (isDict(value) && text.startsWith("stream", lexer.pos)) {
				let start = lexer.pos + 6;
				if (data[start] === 0x0d) start++;
				if (data[start] === 0x0a) start++;
				const length = value.get("Length");
				let end = typeof length === "number" && length >= 0 && text.startsWith("endstream", skipWs(data, start + length)) ? start + length : text.indexOf("endstream", start);
				if (end < 0) end = data.length;
				this.objects.set(Number(m[1]), { dict: value, raw: data.subarray(start, end), num: Number(m[1]), gen: Number(m[2]) });
				header.lastIndex = end;
			} else this.objects.set(Number(m[1]), value);
			if (isDict(value) && value.get("Type") instanceof Name && (value.get("Type") as Name).name === "XRef") this.trailer = new Map([...this.trailer, ...value]);
		}
		for (let at = text.indexOf("trailer"); at >= 0; at = text.indexOf("trailer", at + 7)) {
			const dict = new Lexer(data, at + 7).value();
			if (isDict(dict)) this.trailer = new Map([...this.trailer, ...dict]);
		}
	}

	/** After the cipher is known: object streams are encrypted like any other stream. */
	unpackObjectStreams(): void {
		for (const obj of [...this.objects.values()]) {
			if (!isStream(obj) || nameOf(obj.dict.get("Type")) !== "ObjStm") continue;
			let body: Buffer;
			try {
				body = this.stream(obj);
			} catch {
				continue;
			}
			const n = Math.min(Number(this.get(obj.dict.get("N")) ?? 0), PDF_LIMITS.maxObjects);
			const first = Number(this.get(obj.dict.get("First")) ?? 0);
			const head = new Lexer(body);
			const pairs: [number, number][] = [];
			for (let i = 0; i < n; i++) {
				const num = head.value();
				const offset = head.value();
				if (typeof num !== "number" || typeof offset !== "number") break;
				pairs.push([num, offset]);
			}
			for (const [num, offset] of pairs) {
				if (this.objects.has(num)) continue;
				try {
					const value = new Lexer(body, first + offset).value();
					if (value !== undefined) this.objects.set(num, value);
				} catch {
					/* one bad object, the others still count */
				}
			}
		}
	}

	/** Follow a reference (a few hops at most). */
	get(value: Value | Obj | undefined): Obj | undefined {
		let v = value;
		for (let hops = 0; v instanceof Ref && hops < 16; hops++) v = this.objects.get(v.num);
		return v instanceof Ref ? undefined : v;
	}

	dict(value: Value | Obj | undefined): Dict | undefined {
		const v = this.get(value);
		if (isDict(v)) return v;
		if (isStream(v)) return v.dict;
		return undefined;
	}

	/** A stream's bytes after its filters. Images and unknown filters give an empty buffer. */
	stream(stream: Stream): Buffer {
		// Decoded once per stream: a font or form used a thousand times costs one decoding.
		const known = this.decodedStreams.get(stream);
		if (known !== undefined) return known;
		if (this.spent) throw new PdfError("il PDF è troppo grande da leggere");
		try {
			const data = this.decode(stream);
			this.decodedStreams.set(stream, data);
			return data;
		} catch (error) {
			// Once over a limit, every later stream fails at once: nothing can swallow the limit and go on.
			if (error instanceof PdfError) this.spent = true;
			throw error;
		}
	}

	private decode(stream: Stream): Buffer {
		return this.filtered(stream, false).data;
	}

	/**
	 * An image's bytes after the general filters, and the image filter left to apply (DCT, CCITT,
	 * JBIG2, JPX) with its parameters: a JPEG goes to the model as it is.
	 */
	imageData(stream: Stream): { data: Buffer; filter?: string; parm?: Dict } {
		return this.filtered(stream, true);
	}

	private filtered(stream: Stream, image: boolean): { data: Buffer; filter?: string; parm?: Dict } {
		const filters = this.get(stream.dict.get("Filter"));
		const list = (Array.isArray(filters) ? filters : filters === undefined ? [] : [filters]).map((f) => nameOf(this.get(f as Value)));
		const parms = this.get(stream.dict.get("DecodeParms"));
		let data: Buffer = stream.raw;
		const type = nameOf(stream.dict.get("Type"));
		// Cross-reference streams are never encrypted; metadata only when the file says so.
		if (this.cipher !== undefined && stream.num !== undefined && type !== "XRef" && (type !== "Metadata" || this.encryptMetadata)) data = this.cipher(stream.num, stream.gen ?? 0, data);
		let left: { filter: string; parm?: Dict } | undefined;
		list.forEach((filter, i) => {
			if (left !== undefined) return;
			const parm = this.dict(Array.isArray(parms) ? (parms[i] as Value) : (parms as Value | undefined));
			if (filter === "FlateDecode" || filter === "Fl") data = predictor(inflate(data), parm, this);
			else if (filter === "ASCIIHexDecode" || filter === "AHx") data = Buffer.from(data.toString("latin1").replace(/[^0-9a-fA-F]/g, "").replace(/^((?:..)*).$/, "$10"), "hex");
			else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85(data);
			else if (filter === "LZWDecode" || filter === "LZW") data = predictor(bounded(() => lzwDecode(data, Number(this.get(parm?.get("EarlyChange")) ?? 1) === 0 ? 0 : 1, PDF_LIMITS.maxStreamBytes)), parm, this);
			else if (filter === "RunLengthDecode" || filter === "RL") data = bounded(() => runLengthDecode(data, PDF_LIMITS.maxStreamBytes));
			else if (image && filter !== undefined) left = { filter: filter === "DCT" ? "DCTDecode" : filter === "CCF" ? "CCITTFaxDecode" : filter, ...(parm === undefined ? {} : { parm }) };
			else data = Buffer.alloc(0);
		});
		this.decoded += data.length;
		if (this.decoded > PDF_LIMITS.maxDecodedBytes) throw new PdfError("il PDF è troppo grande da leggere");
		return { data, ...left };
	}
}

export function skipWs(data: Buffer, at: number): number {
	let i = at;
	while (i < data.length && WS.has(data[i] as number)) i++;
	return i;
}

export function nameOf(v: unknown): string | undefined {
	return v instanceof Name ? v.name : undefined;
}

export function inflate(data: Buffer): Buffer {
	try {
		return inflateSync(data, { maxOutputLength: PDF_LIMITS.maxStreamBytes });
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new PdfError("una parte del PDF è troppo grande da leggere");
		// A stream cut short: keep what inflates.
		try {
			return inflateSync(data, { maxOutputLength: PDF_LIMITS.maxStreamBytes, finishFlush: 2 });
		} catch {
			return Buffer.alloc(0);
		}
	}
}

/** PNG predictors, as cross-reference and object streams and many images use them. */
export function predictor(data: Buffer, parm: Dict | undefined, doc: Document): Buffer {
	const p = Number(doc.get(parm?.get("Predictor")) ?? 1);
	if (p < 10) return data;
	const columns = Number(doc.get(parm?.get("Columns")) ?? 1);
	const colors = Number(doc.get(parm?.get("Colors")) ?? 1);
	const bits = Number(doc.get(parm?.get("BitsPerComponent")) ?? 8);
	if (!(columns > 0 && columns <= 100_000 && colors >= 1 && colors <= 4 && [1, 2, 4, 8, 16].includes(bits))) return data;
	// Bytes per row and per pixel: the left neighbour of a byte is the same byte of the pixel before.
	const rowBytes = Math.ceil((columns * colors * bits) / 8);
	const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
	const rows = Math.floor(data.length / (rowBytes + 1));
	const out = Buffer.alloc(rows * rowBytes);
	for (let r = 0; r < rows; r++) {
		const at = r * (rowBytes + 1);
		const type = data[at] as number;
		const row = r * rowBytes;
		for (let i = 0; i < rowBytes; i++) {
			const raw = data[at + 1 + i] as number;
			const left = i >= bpp ? (out[row + i - bpp] as number) : 0;
			const up = r > 0 ? (out[row - rowBytes + i] as number) : 0;
			const ul = r > 0 && i >= bpp ? (out[row - rowBytes + i - bpp] as number) : 0;
			let v = raw;
			if (type === 1) v = raw + left;
			else if (type === 2) v = raw + up;
			else if (type === 3) v = raw + ((left + up) >> 1);
			else if (type === 4) {
				const pa = Math.abs(up - ul);
				const pb = Math.abs(left - ul);
				const pc = Math.abs(left + up - 2 * ul);
				v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
			}
			out[row + i] = v & 0xff;
		}
	}
	return out;
}

/** A decoder's limit as the PDF's own error. */
export function bounded(decode: () => Buffer): Buffer {
	try {
		return decode();
	} catch (error) {
		if (error instanceof PdfImageError) throw new PdfError(error.message);
		throw error;
	}
}

export function ascii85(data: Buffer): Buffer {
	const text = data.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/, "");
	const out: number[] = [];
	let group: number[] = [];
	for (const ch of text) {
		if (ch === "z" && group.length === 0) {
			out.push(0, 0, 0, 0);
			continue;
		}
		const c = ch.charCodeAt(0) - 33;
		if (c < 0 || c > 84) continue;
		group.push(c);
		if (group.length === 5) {
			let n = 0;
			for (const g of group) n = n * 85 + g;
			out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
			group = [];
		}
	}
	if (group.length > 1) {
		const missing = 5 - group.length;
		while (group.length < 5) group.push(84);
		let n = 0;
		for (const g of group) n = n * 85 + g;
		out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, 4 - missing));
	}
	return Buffer.from(out);
}
export type Matrix = [number, number, number, number, number, number];

export function multiply(a: Matrix, b: Matrix): Matrix {
	return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}

export function pageList(doc: Document): Dict[] {
	const pages: Dict[] = [];
	const seen = new Set<Dict>();
	// What a page inherits from the tree above it.
	const INHERITED = ["Resources", "MediaBox", "Rotate"] as const;
	const walk = (node: Dict | undefined, inherited: Dict, depth: number) => {
		if (node === undefined || seen.has(node) || depth > 64 || pages.length >= PDF_LIMITS.maxPages) return;
		seen.add(node);
		const here: Dict = new Map(inherited);
		for (const key of INHERITED) if (node.has(key)) here.set(key, node.get(key) as Value);
		const kids = doc.get(node.get("Kids"));
		if (Array.isArray(kids)) for (const kid of kids) walk(doc.dict(kid), here, depth + 1);
		else if (nameOf(node.get("Type")) === "Page" || node.has("Contents")) pages.push(INHERITED.every((key) => node.has(key) || !here.has(key)) ? node : new Map([...here, ...node]));
	};
	const root = doc.dict(doc.trailer.get("Root")) ?? [...doc.objects.values()].map((o) => (isDict(o) ? o : undefined)).find((d) => nameOf(d?.get("Type")) === "Catalog");
	walk(doc.dict(root?.get("Pages")), new Map(), 0);
	if (pages.length === 0) {
		for (const o of doc.objects.values()) if (isDict(o) && nameOf(o.get("Type")) === "Page" && pages.length < PDF_LIMITS.maxPages) pages.push(o);
	}
	return pages;
}

/** The Encrypt dictionary of the standard handler; undefined for other handlers or one that is broken. */
export function encryptionOf(doc: Document, e: Dict): PdfEncryption | undefined {
	if (nameOf(doc.get(e.get("Filter"))) !== "Standard") return undefined;
	const num = (key: string) => {
		const v = doc.get(e.get(key));
		return typeof v === "number" ? v : undefined;
	};
	const bytes = (key: string) => {
		const v = doc.get(e.get(key));
		return Buffer.isBuffer(v) ? v : undefined;
	};
	const v = num("V") ?? 0;
	const r = num("R") ?? 0;
	const o = bytes("O");
	const u = bytes("U");
	if (o === undefined || u === undefined) return undefined;
	const ids = doc.get(doc.trailer.get("ID"));
	const first = Array.isArray(ids) ? doc.get(ids[0]) : undefined;
	let method: PdfEncryption["method"] | undefined;
	if (v === 1 || v === 2) method = "rc4";
	else if (v === 4 || v === 5) {
		const filter = nameOf(doc.get(e.get("StmF"))) ?? "Identity";
		const cf = doc.dict(e.get("CF"));
		const cfm = filter === "Identity" ? "None" : nameOf(doc.get(doc.dict(cf?.get(filter))?.get("CFM")));
		method = cfm === "None" ? "none" : cfm === "V2" ? "rc4" : cfm === "AESV2" ? "aes128" : cfm === "AESV3" ? "aes256" : undefined;
	}
	if (method === undefined) return undefined;
	const ue = bytes("UE");
	return {
		v,
		r,
		length: num("Length") ?? (v === 1 ? 40 : 128),
		o,
		u,
		...(ue === undefined ? {} : { ue }),
		p: num("P") ?? 0,
		id: Buffer.isBuffer(first) ? first : Buffer.alloc(0),
		encryptMetadata: doc.get(e.get("EncryptMetadata")) !== false,
		method,
	};
}

/** The PDF's objects, decrypted when it opens without a password, and its pages. */
export function openPdf(data: Buffer): { doc: Document; pages: Dict[] } {
	if (!data.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw new PdfError("non è un PDF");
	const doc = new Document(data);
	const encrypt = doc.dict(doc.trailer.get("Encrypt"));
	if (encrypt !== undefined) {
		const encryption = encryptionOf(doc, encrypt);
		doc.cipher = encryption === undefined ? undefined : pdfCipher(encryption);
		if (doc.cipher === undefined) throw new PdfError("il PDF è protetto da una password. Chiedi alla persona di mandarlo senza password, o di copiarne il testo");
		doc.encryptMetadata = encryption?.encryptMetadata ?? true;
	}
	doc.unpackObjectStreams();
	const pages = pageList(doc);
	if (pages.length === 0) throw new PdfError("non trovo pagine in questo PDF: forse è rovinato");
	return { doc, pages };
}
