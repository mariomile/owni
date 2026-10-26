import { type Dict, type Document, isDict, isStream, Lexer, type Matrix, multiply, Name, nameOf, Op, openPdf, PDF_LIMITS, PdfError, Ref, type Value } from "./pdf-objects.ts";

/**
 * The text of a PDF, without dependencies (ADR 0026). Reads the objects (also those packed in
 * object streams), walks the pages in order, decodes each page's content with its fonts
 * (ToUnicode maps, simple encodings with Differences, widths for spacing) and lays the text out
 * in lines. What it does not do: decrypt, OCR scans, read text drawn as curves. Every size is
 * bounded: a crafted file costs at most the limits below.
 */
export type PdfText = { readonly text: string; readonly pages: number; readonly note?: string };

/** Spaces at line ends removed, line by line: a regex here backtracks on long runs of spaces. */
export function trimLines(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function endsInSpace(text: string): boolean {
	const last = text.at(-1);
	return last === " " || last === "\n" || last === "\t" || last === "\r";
}

// ---------- fonts ----------

const WIN_ANSI_HIGH = "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ";

function winAnsi(code: number): string {
	if (code >= 0x80 && code <= 0x9f) return WIN_ANSI_HIGH[code - 0x80] as string;
	return String.fromCharCode(code);
}

const GLYPHS: Record<string, string> = {
	space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "−", period: ".", slash: "/",
	zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@",
	bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
	quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„", endash: "–", emdash: "—", bullet: "•", ellipsis: "…", Euro: "€", euro: "€", degree: "°", copyright: "©", registered: "®", trademark: "™", section: "§", paragraph: "¶",
	fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", germandbls: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", oslash: "ø", Oslash: "Ø", guillemotleft: "«", guillemotright: "»", guilsinglleft: "‹", guilsinglright: "›", periodcentered: "·", nbspace: " ", sterling: "£", yen: "¥", cent: "¢", multiply: "×", divide: "÷", plusminus: "±", ordfeminine: "ª", ordmasculine: "º", exclamdown: "¡", questiondown: "¿", dotlessi: "ı",
};
const ACCENTS: Record<string, string> = { grave: "̀", acute: "́", circumflex: "̂", tilde: "̃", dieresis: "̈", ring: "̊", cedilla: "̧", caron: "̌" };

function glyphChar(name: string): string | undefined {
	if (GLYPHS[name] !== undefined) return GLYPHS[name];
	if (/^[A-Za-z]$/.test(name)) return name;
	const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
	if (uni !== null) {
		const n = Number.parseInt(uni[1] as string, 16);
		return n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
	}
	const accented = /^([A-Za-z])(grave|acute|circumflex|tilde|dieresis|ring|cedilla|caron)$/.exec(name);
	if (accented !== null) return `${accented[1]}${ACCENTS[accented[2] as string]}`.normalize("NFC");
	const base = name.split(".")[0] ?? "";
	return base !== name && base !== "" ? glyphChar(base) : undefined;
}

type Font = {
	/** Byte lengths of codes, longest first. */
	readonly widths: readonly number[];
	readonly toUnicode?: Map<string, string>;
	readonly simple?: Map<number, string>;
	readonly advance: (code: number) => number;
	readonly twoByte: boolean;
};

/** A font has at most 65,536 codes of each length: more entries than this are a crafted map. */
const CMAP_MAX_ENTRIES = 200_000;

function cmap(text: string): { map: Map<string, string>; lengths: number[] } {
	const map = new Map<string, string>();
	const lengths = new Set<number>();
	const utf16 = (hex: string) => {
		const b = Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, "hex");
		let s = "";
		for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
		return s;
	};
	for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>/g)) lengths.add(Math.ceil((m[1] as string).length / 2));
	for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
		for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
			map.set((m[1] as string).toLowerCase(), utf16(m[2] as string));
			lengths.add(Math.ceil((m[1] as string).length / 2));
		}
	}
	for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
		for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
			const lo = Number.parseInt(m[1] as string, 16);
			const hi = Number.parseInt(m[2] as string, 16);
			const size = (m[1] as string).length;
			lengths.add(Math.ceil(size / 2));
			if (!(hi >= lo) || hi - lo > 65_535 || map.size + (hi - lo) > CMAP_MAX_ENTRIES) continue;
			const list = m[5] === undefined ? undefined : [...(m[5] as string).matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1] as string);
			for (let code = lo; code <= hi; code++) {
				const key = code.toString(16).padStart(size, "0");
				if (list !== undefined) {
					const dst = list[code - lo];
					if (dst !== undefined) map.set(key, utf16(dst));
				} else {
					const start = Buffer.from((m[4] as string).length % 2 ? `${m[4]}0` : (m[4] as string), "hex");
					if (start.length < 2) continue;
					const last = start.readUInt16BE(start.length - 2) + (code - lo);
					const prefix = utf16(start.subarray(0, start.length - 2).toString("hex"));
					map.set(key, prefix + String.fromCharCode(last & 0xffff));
				}
			}
		}
	}
	return { map, lengths: [...lengths].filter((n) => n >= 1 && n <= 4).sort((a, b) => b - a) };
}

function loadFont(doc: Document, value: Value | undefined): Font {
	const font = doc.dict(value) ?? new Map();
	const subtype = nameOf(doc.get(font.get("Subtype")));
	const twoByte = subtype === "Type0";
	let toUnicode: Map<string, string> | undefined;
	let lengths: number[] = twoByte ? [2] : [1];
	const tu = doc.get(font.get("ToUnicode"));
	if (isStream(tu)) {
		try {
			const parsed = cmap(doc.stream(tu).toString("latin1"));
			if (parsed.map.size > 0) {
				toUnicode = parsed.map;
				if (parsed.lengths.length > 0) lengths = parsed.lengths;
			}
		} catch (error) {
			// A broken map falls back on the encoding; a limit reached stops the reading.
			if (error instanceof PdfError) throw error;
		}
	}
	let simple: Map<number, string> | undefined;
	if (!twoByte) {
		simple = new Map();
		const enc = doc.get(font.get("Encoding"));
		const differences = isDict(enc) ? doc.get(enc.get("Differences")) : undefined;
		if (Array.isArray(differences)) {
			let code = 0;
			for (const item of differences) {
				const v = doc.get(item);
				if (typeof v === "number") code = v;
				else if (v instanceof Name) {
					const ch = glyphChar(v.name);
					if (ch !== undefined) simple.set(code, ch);
					code++;
				}
			}
		}
	}
	// Advances in thousandths of the font size.
	let advance: (code: number) => number = () => 500;
	if (twoByte) {
		const descendant = doc.dict((doc.get(font.get("DescendantFonts")) as Value[] | undefined)?.[0]);
		const dw = Number(doc.get(descendant?.get("DW")) ?? 1000);
		const widths = new Map<number, number>();
		const w = doc.get(descendant?.get("W"));
		if (Array.isArray(w)) {
			for (let i = 0; i < w.length && widths.size < 70_000; ) {
				const first = doc.get(w[i]);
				const second = doc.get(w[i + 1]);
				if (typeof first !== "number") break;
				if (Array.isArray(second)) {
					second.forEach((x, k) => widths.set(first + k, Number(doc.get(x)) || dw));
					i += 2;
				} else {
					const width = Number(doc.get(w[i + 2]));
					if (typeof second === "number" && second >= first && second - first < 70_000) for (let c = first; c <= second; c++) widths.set(c, width);
					i += 3;
				}
			}
		}
		advance = (code) => widths.get(code) ?? dw;
	} else {
		const first = Number(doc.get(font.get("FirstChar")) ?? 0);
		const w = doc.get(font.get("Widths"));
		if (Array.isArray(w)) advance = (code) => Number(doc.get(w[code - first])) || 500;
	}
	return { widths: lengths, ...(toUnicode === undefined ? {} : { toUnicode }), ...(simple === undefined ? {} : { simple }), advance, twoByte };
}

/** Bytes of a shown string → characters, with each glyph's advance. */
function decode(font: Font, bytes: Buffer): { text: string; advance: number; spaces: number } {
	let text = "";
	let advance = 0;
	let spaces = 0;
	for (let i = 0; i < bytes.length; ) {
		let used = 0;
		let char: string | undefined;
		let code = 0;
		if (font.toUnicode !== undefined) {
			for (const n of font.widths) {
				if (i + n > bytes.length) continue;
				const key = bytes.subarray(i, i + n).toString("hex");
				const hit = font.toUnicode.get(key);
				if (hit !== undefined) {
					char = hit;
					used = n;
					code = Number.parseInt(key, 16);
					break;
				}
			}
		}
		if (used === 0) {
			used = font.twoByte ? Math.min(2, bytes.length - i) : 1;
			code = used === 2 ? bytes.readUInt16BE(i) : (bytes[i] as number);
			// Without a map a two-byte font's codes are glyph numbers: nothing to read.
			char = font.twoByte ? "" : (font.simple?.get(code) ?? winAnsi(code));
		}
		i += used;
		if (char === " ") spaces++;
		text += char ?? "";
		advance += font.advance(code);
	}
	return { text, advance, spaces };
}

// ---------- pages ----------

class PageText {
	private out = "";
	private lastY: number | undefined;
	private lastX = 0;
	private lastSize = 10;

	/** A run of text at (x, y) in text space, `size` tall, ending at x + width. */
	add(text: string, x: number, y: number, size: number, width: number): void {
		if (text === "") return;
		const s = Math.max(Math.abs(size), 0.1);
		if (this.lastY !== undefined) {
			const dy = Math.abs(y - this.lastY);
			if (dy > 0.5 * Math.min(s, this.lastSize)) this.out += dy > 1.9 * Math.max(s, this.lastSize) ? "\n\n" : "\n";
			else if (x - this.lastX > 0.15 * s && !endsInSpace(this.out) && !/^\s/.test(text)) this.out += " ";
			else if (x < this.lastX - 2 * s && !endsInSpace(this.out)) this.out += " ";
		}
		this.out += text;
		this.lastY = y;
		this.lastX = x + width;
		this.lastSize = s;
	}

	space(): void {
		if (this.out !== "" && !endsInSpace(this.out)) this.out += " ";
	}

	get length(): number {
		return this.out.length;
	}

	text(): string {
		return this.out;
	}
}

function runContent(doc: Document, content: Buffer, resources: Dict | undefined, page: PageText, depth: number, fonts: Map<unknown, Font>): void {
	const lexer = new Lexer(content);
	const stack: Value[] = [];
	let ctm: Matrix = [1, 0, 0, 1, 0, 0];
	const saved: Matrix[] = [];
	let tm: Matrix = [1, 0, 0, 1, 0, 0];
	let tlm: Matrix = [1, 0, 0, 1, 0, 0];
	let font: Font | undefined;
	let size = 0;
	let leading = 0;
	let hscale = 1;
	let charSpacing = 0;
	let wordSpacing = 0;
	const fontDict = doc.dict(resources?.get("Font"));
	const xobjects = doc.dict(resources?.get("XObject"));
	const show = (bytes: Buffer) => {
		if (font === undefined) return;
		const run = decode(font, bytes);
		const m = multiply(tm, ctm);
		const scale = Math.hypot(m[2], m[3]) || 1;
		const width = ((run.advance / 1000) * size + charSpacing * bytes.length + wordSpacing * run.spaces) * hscale;
		page.add(run.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ""), m[4], m[5], size * scale, width * (Math.hypot(m[0], m[1]) || 1));
		tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + width * tm[0], tm[5] + width * tm[1]];
	};
	const moveLine = (tx: number, ty: number) => {
		tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
		tm = tlm;
	};
	for (;;) {
		const token = lexer.next();
		if (token === undefined) break;
		if (!(token instanceof Op)) {
			if (stack.length < 64) stack.push(token);
			continue;
		}
		const num = (i: number) => Number(stack[stack.length - i]) || 0;
		switch (token.op) {
			case "BT":
				tm = [1, 0, 0, 1, 0, 0];
				tlm = tm;
				break;
			case "q":
				if (saved.length < 64) saved.push(ctm);
				break;
			case "Q":
				ctm = saved.pop() ?? ctm;
				break;
			case "cm":
				ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
				break;
			case "Tf": {
				const ref = fontDict?.get(nameOf(stack[stack.length - 2]) ?? "");
				size = num(1);
				if (ref === undefined) font = undefined;
				else {
					// By object number: a thousand names pointing at one font load it once.
					const key = ref instanceof Ref ? `${ref.num} ${ref.gen}` : ref;
					let cached = fonts.get(key);
					if (cached === undefined) {
						cached = loadFont(doc, ref);
						fonts.set(key, cached);
					}
					font = cached;
				}
				break;
			}
			case "Tz":
				hscale = num(1) / 100;
				break;
			case "Tc":
				charSpacing = num(1);
				break;
			case "Tw":
				wordSpacing = num(1);
				break;
			case "TL":
				leading = num(1);
				break;
			case "Td":
				moveLine(num(2), num(1));
				break;
			case "TD":
				leading = -num(1);
				moveLine(num(2), num(1));
				break;
			case "Tm":
				tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
				tm = tlm;
				break;
			case "T*":
				moveLine(0, -leading);
				break;
			case "Tj": {
				const s = stack.at(-1);
				if (Buffer.isBuffer(s)) show(s);
				break;
			}
			case "'":
			case '"': {
				moveLine(0, -leading);
				const s = stack.at(-1);
				if (Buffer.isBuffer(s)) show(s);
				break;
			}
			case "TJ": {
				const arr = stack.at(-1);
				if (Array.isArray(arr)) {
					for (const item of arr) {
						if (Buffer.isBuffer(item)) show(item);
						else if (typeof item === "number") {
							const shift = (-item / 1000) * size * hscale;
							tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * tm[0], tm[5] + shift * tm[1]];
							if (item < -180) page.space();
						}
					}
				}
				break;
			}
			case "Do": {
				const xo = doc.get(xobjects?.get(nameOf(stack.at(-1)) ?? ""));
				if (depth < 6 && isStream(xo) && nameOf(xo.dict.get("Subtype")) === "Form") {
					try {
						runContent(doc, doc.stream(xo), doc.dict(xo.dict.get("Resources")) ?? resources, page, depth + 1, fonts);
					} catch (error) {
						if (error instanceof PdfError) throw error;
					}
				}
				break;
			}
			case "ID": {
				// Inline image data: binary until EI.
				const at = content.indexOf("EI", lexer.pos);
				lexer.pos = at < 0 ? content.length : at + 2;
				break;
			}
		}
		stack.length = 0;
		if (page.length > PDF_LIMITS.maxTextChars) break;
	}
}


export function pdfText(data: Buffer): PdfText {
	const { doc, pages } = openPdf(data);
	const fonts = new Map<unknown, Font>();
	const out: string[] = [];
	let total = 0;
	let empty = 0;
	let read = 0;
	const blank: number[] = [];
	for (const [index, page] of pages.entries()) {
		const text = new PageText();
		const contents = doc.get(page.get("Contents"));
		const parts = Array.isArray(contents) ? contents.map((c) => doc.get(c)) : [contents];
		const body = Buffer.concat(parts.filter(isStream).map((s) => Buffer.concat([doc.stream(s), Buffer.from("\n")])));
		runContent(doc, body, doc.dict(page.get("Resources")), text, 0, fonts);
		const pageText = trimLines(text.text()).trim();
		read++;
		if (pageText === "") {
			empty++;
			blank.push(index + 1);
		}
		out.push(`--- Pagina ${index + 1} ---\n${pageText}`);
		total += pageText.length;
		if (total > PDF_LIMITS.maxTextChars) break;
	}
	const notes: string[] = [];
	if (empty === read)
		notes.push(
			"Il PDF non contiene testo: è probabilmente una scansione. Guarda le pagine con image_view (il percorso del PDF e page) e leggi tu cosa dicono.",
		);
	else if (blank.length > 0) {
		const listed = blank.length > 20 ? `${blank.slice(0, 20).join(", ")} e altre ${blank.length - 20}` : blank.join(", ");
		notes.push(
			blank.length === 1
				? `La pagina ${listed} non ha testo (forse una scansione o un'immagine): guardala con image_view (page ${listed}).`
				: `Le pagine ${listed} non hanno testo (forse scansioni o immagini): guardale con image_view (page e il numero).`,
		);
	}
	if (pages.length >= PDF_LIMITS.maxPages) notes.push(`Il PDF ha almeno ${PDF_LIMITS.maxPages} pagine: oltre queste non leggo.`);
	if (read < pages.length) notes.push(`Il testo è molto lungo: lette le prime ${read} pagine su ${pages.length}.`);
	const note = notes.length === 0 ? undefined : notes.join(" ");
	if (empty === read) return { text: "", pages: pages.length, ...(note === undefined ? {} : { note }) };
	return { text: out.join("\n\n"), pages: pages.length, ...(note === undefined ? {} : { note }) };
}
