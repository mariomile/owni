/**
 * Control characters that never belong in text a person gives for a document or a record: the C0
 * controls but the newline, DEL, and the Unicode line and paragraph separators. Shared by the
 * quotes and the company's details.
 */
export const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g;

const CONTROL_CHAR = new RegExp(CONTROL_CHARS.source);

/** Whether `text` holds one of CONTROL_CHARS. */
export function hasControlChars(text: string): boolean {
	return CONTROL_CHAR.test(text);
}

/**
 * Invisible characters that can reorder or hide what a person reads: every format character
 * (zero-width, bidi controls, tags, the soft hyphen, the BOM), variation selectors and the
 * combining grapheme joiner.
 */
const FORMAT_CHARS = /[\p{Cf}\u034f\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/** `text` without FORMAT_CHARS. */
export function withoutFormatChars(text: string): string {
	return text.replace(FORMAT_CHARS, "");
}

/** Text on one line, as a person reads it: no line breaks, controls or format characters, single spaces; at most `max` characters (an ellipsis when cut, never inside a character). */
export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string {
	const flat = withoutFormatChars(text)
		.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();
	if (flat.length <= max) return flat;
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
