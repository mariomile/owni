/**
 * Text out of HTML and XML for the tools that read pages (web_read, the sentinelle): elements
 * dropped whole, comments dropped, entities decoded. Every scan moves forward with indexOf, so a hostile document is read in linear time.
 */

/** ASCII letters in lower case, nothing else: the text keeps its length, so an index in it is an index in the original («İ» would grow under toLowerCase). */
export function asciiLower(text: string): string {
	return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** The HTML without the given elements and their content, found with indexOf: one pass per tag. An unclosed one takes the rest. */
export function withoutBlocks(html: string, tags: readonly string[], lower: string = asciiLower(html)): string {
	const cut: [number, number][] = [];
	for (const tag of tags) {
		let from = 0;
		for (;;) {
			const start = lower.indexOf(`<${tag}`, from);
			if (start < 0) break;
			const close = lower.indexOf(`</${tag}`, start + 1);
			const end = close < 0 ? html.length : Math.max(close, lower.indexOf(">", close) + 1);
			cut.push([start, end]);
			from = end;
		}
	}
	cut.sort((a, b) => a[0] - b[0]);
	let out = "";
	let at = 0;
	for (const [start, end] of cut) {
		if (end <= at) continue;
		out += `${html.slice(at, Math.max(at, start))} `;
		at = Math.max(at, end);
	}
	return out + html.slice(at);
}

/** The HTML without `<!-- … -->`; an unclosed comment takes the rest. */
export function withoutComments(html: string): string {
	let out = "";
	let at = 0;
	for (;;) {
		const start = html.indexOf("<!--", at);
		if (start < 0) return out + html.slice(at);
		const end = html.indexOf("-->", start + 4);
		out += `${html.slice(at, start)} `;
		if (end < 0) return out;
		at = end + 3;
	}
}

/**
 * Characters that hide or reorder text: controls, soft hyphen, bidirectional marks and overrides,
 * zero-width and invisible operators, variation selectors, the byte order mark and the tag
 * characters (which can spell hidden instructions). Global: for replace, not test.
 */
export const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/gu;

/** The named entities pages and feeds use, beyond XML's five: Italian letters, quotes and dashes. A Map, so «&constructor;» is no entity. */
const ENTITIES = new Map<string, string>(
	Object.entries({
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		agrave: "à",
		aacute: "á",
		egrave: "è",
		eacute: "é",
		igrave: "ì",
		iacute: "í",
		ograve: "ò",
		oacute: "ó",
		ugrave: "ù",
		uacute: "ú",
		Agrave: "À",
		Egrave: "È",
		Eacute: "É",
		Igrave: "Ì",
		Ograve: "Ò",
		Ugrave: "Ù",
		ccedil: "ç",
		ntilde: "ñ",
		auml: "ä",
		ouml: "ö",
		uuml: "ü",
		szlig: "ß",
		lsquo: "‘",
		rsquo: "’",
		ldquo: "“",
		rdquo: "”",
		laquo: "«",
		raquo: "»",
		ndash: "–",
		mdash: "—",
		hellip: "…",
		middot: "·",
		bull: "•",
		euro: "€",
		pound: "£",
		deg: "°",
		copy: "©",
		reg: "®",
		trade: "™",
	}),
);

/**
 * Named and numeric entities in one pass; an unknown name stays as written, a code point that is
 * not a printable character becomes a space. &#128; to &#159; are read as Windows-1252, as browsers
 * do (&#150; is «–», &#128; «€»): pages written on Windows have them.
 */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (whole, decimal?: string, hex?: string, name?: string) => {
		if (name !== undefined) return ENTITIES.get(name) ?? whole;
		const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
		return referencedCharacter(code >= 0x80 && code <= 0x9f ? windows1252(code) : code, false);
	});
}

/** Windows-1252's bytes 0x80 to 0x9F; the five it leaves unused (·) stay controls, and become spaces. */
const WINDOWS_1252 = "€·‚ƒ„…†‡ˆ‰Š‹Œ·Ž··‘’“”•–—˜™š›œ·žŸ";

/** The character a Windows-1252 byte from 0x80 to 0x9F stands for. */
function windows1252(byte: number): number {
	const char = WINDOWS_1252[byte - 0x80] as string;
	return char === "·" ? byte : (char.codePointAt(0) as number);
}

/** Characters that reorder the text around them without showing (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069). */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** The text without bidi controls: an IBAN or an amount reads as written, not reversed. */
export function withoutBidiControls(text: string): string {
	return text.replace(BIDI_CONTROLS, "");
}

/**
 * The character a numeric reference names, or a space when it is not one to show as written:
 * past Unicode, a surrogate, a C0 or C1 control (U+0085 included), a line or paragraph separator,
 * a bidi control (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) that would reorder the text
 * around it. Tab, line feed and carriage return stay when `breaks`.
 */
export function referencedCharacter(code: number, breaks: boolean): string {
	if (breaks && (code === 0x09 || code === 0x0a || code === 0x0d)) return String.fromCharCode(code);
	const hidden =
		!Number.isInteger(code) ||
		code < 0x20 ||
		code > 0x10ffff ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0xd800 && code <= 0xdfff) ||
		code === 0x200e ||
		code === 0x200f ||
		code === 0x2028 ||
		code === 0x2029 ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069);
	return hidden ? " " : String.fromCodePoint(code);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML's five entities and numeric references (through referencedCharacter), nothing else: no DTD, so no other entity is defined, and an unknown one stays as written. */
export function xmlUnescape(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(?:#x([0-9a-fA-F]{1,8})|#(\d{1,10})|(\w{1,32}));/g, (whole, hex?: string, decimal?: string, name?: string) => {
		if (name !== undefined) return XML_ENTITIES[name] ?? whole;
		return referencedCharacter(hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal), true);
	});
}
