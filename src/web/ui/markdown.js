import { h } from "./common.js";

// A bounded subset for assistant replies, not a full CommonMark implementation. Beyond these
// limits the remaining content stays readable as text; no source text is silently truncated.
const MAX_TEXT = 262_144;
const MAX_INLINE = 4096;
const MAX_DEPTH = 12;
const MAX_CELLS = 64;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT = /^ {0,3}(={2,}|-{3,})[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_END = /^ {0,3}(`+|~+)[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/;
const ESCAPE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}_]/u;

function el(context, spec, ...args) {
	context.nodes--;
	return h(spec, ...args);
}

/** Render assistant text without interpreting HTML, fetching images or changing the raw reply. */
export function renderMarkdown(text) {
	const source = String(text ?? "");
	const root = h("div.markdown");
	if (source.length > MAX_TEXT) {
		root.append(h("p.markdown-fallback", source));
		return root;
	}
	const context = { nodes: 12_000, work: Math.max(32_768, source.length * 24) };
	blocks(source.replace(/\r\n?/g, "\n").split("\n"), root, context, 0);
	return root;
}

function unescape(text) {
	return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

// Console navigation uses #/ routes. Arbitrary relative paths (including local file paths) do
// not have a known browser destination here, so they deliberately remain text.
function safeHref(value) {
	const target = unescape(value);
	if (!target || /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\\]/u.test(target)) return null;
	// Also reject escaped controls, including repeated percent encoding, before setting href.
	if (/%(?:25)*(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(target)) return null;
	if (target.startsWith("#/")) return target;
	if (!/^(?:https?:\/\/|mailto:)/i.test(target)) return null;
	try {
		const url = new URL(target);
		if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) return target;
		if (url.protocol === "mailto:" && url.pathname) return target;
	} catch { /* Malformed destinations remain text, like unsupported schemes. */ }
	return null;
}

function anchor(context, href, title, children) {
	return el(context, "a", {
		href,
		title: title || undefined,
		...(/^https?:/i.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {}),
	}, children);
}

/** One bounded forward scan; work is shared across recursive labels and the entire reply. */
function linkAt(text, at, context) {
	const image = text[at] === "!";
	const labelAt = at + (image ? 2 : 1);
	const end = Math.min(text.length, at + MAX_INLINE);
	let cursor = labelAt;
	let depth = 1;
	for (; cursor < end && context.work-- > 0; cursor++) {
		const char = text[cursor];
		if (char === "\\") cursor++;
		else if (char === "[") { if (++depth > MAX_DEPTH) return null; }
		else if (char === "]" && --depth === 0) break;
	}
	if (depth || text[cursor + 1] !== "(") return null;
	const label = text.slice(labelAt, cursor);
	cursor += 2;
	while (cursor < end && context.work-- > 0 && /[ \t]/.test(text[cursor])) cursor++;
	const angled = text[cursor] === "<";
	if (angled) cursor++;
	const targetAt = cursor;
	depth = 0;
	for (; cursor < end && context.work-- > 0; cursor++) {
		const char = text[cursor];
		if (char === "\\") { cursor++; continue; }
		if (char === "\n") return null;
		if (angled) { if (char === ">") break; }
		else if (char === "(") { if (++depth > MAX_DEPTH) return null; }
		else if (char === ")") { if (depth === 0) break; depth--; }
		else if (/[ \t]/.test(char) && depth === 0) break;
	}
	const target = text.slice(targetAt, cursor);
	if (angled && text[cursor++] !== ">") return null;
	while (cursor < end && context.work-- > 0 && /[ \t]/.test(text[cursor])) cursor++;
	let title = "";
	if (text[cursor] === '"' || text[cursor] === "'") {
		const quote = text[cursor++];
		const titleAt = cursor;
		for (; cursor < end && context.work-- > 0; cursor++) {
			if (text[cursor] === "\\") cursor++;
			else if (text[cursor] === quote) break;
		}
		if (text[cursor] !== quote) return null;
		title = unescape(text.slice(titleAt, cursor++));
		while (cursor < end && context.work-- > 0 && /[ \t]/.test(text[cursor])) cursor++;
	}
	if (cursor >= end || text[cursor] !== ")" || !target) return null;
	return { image, label, target, title, end: cursor + 1 };
}

function ticksAt(text, at) {
	let end = at;
	while (text[end] === "`") end++;
	return end - at;
}

function codeAt(text, at, width, context) {
	const end = Math.min(text.length, at + MAX_INLINE);
	for (let cursor = at + width; cursor < end && context.work-- > 0; cursor++) {
		if (text[cursor] !== "`") continue;
		const run = ticksAt(text, cursor);
		if (run === width) {
			let code = text.slice(at + width, cursor).replace(/\n/g, " ");
			if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
			return { text: code, end: cursor + run };
		}
		cursor += run - 1;
	}
	return null;
}

function autoAt(text, at, context, angled) {
	const start = at + (angled ? 1 : 0);
	const end = Math.min(text.length, start + MAX_INLINE);
	let cursor = start;
	for (; cursor < end && context.work-- > 0; cursor++) {
		if (/[\s<>"`\\]/u.test(text[cursor])) break;
	}
	if (cursor === end && cursor < text.length && !/[\s<>"`\\]/u.test(text[cursor])) return null;
	if (angled && text[cursor] !== ">") return null;
	let target = text.slice(start, cursor);
	if (!angled) {
		// Sentence punctuation is not part of a bare URL; balanced path parentheses are.
		let opens = 0;
		let closes = 0;
		for (const char of target) { if (char === "(") opens++; else if (char === ")") closes++; }
		while (target && (/[.,;:!?\]}']/.test(target.at(-1)) || (target.endsWith(")") && closes > opens))) {
			if (target.endsWith(")")) closes--;
			target = target.slice(0, -1);
		}
	}
	if (angled && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9][A-Z0-9.-]*\.[A-Z]{2,63}$/i.test(target)) target = `mailto:${target}`;
	const href = safeHref(target);
	return href ? { href, label: target.replace(/^mailto:/i, ""), end: angled ? cursor + 1 : start + target.length } : null;
}

function inline(text, context, depth = 0, inLink = false) {
	if (depth >= MAX_DEPTH || context.nodes < 16 || context.work <= 0) return [el(context, "span.markdown-fallback", text)];
	const frames = [{ nodes: [], marker: "", char: "", tag: "" }];
	const current = () => frames[frames.length - 1];
	let cursor = 0;
	let rawAt = 0;
	const flush = (end) => { if (end > rawAt) current().nodes.push(text.slice(rawAt, end)); };
	const emit = (value, end) => {
		flush(cursor);
		current().nodes.push(value);
		cursor = rawAt = end;
	};
	while (cursor < text.length && context.nodes >= 16 && context.work-- > 0) {
		const char = text[cursor];
		if (char === "\\" && ESCAPE.test(text[cursor + 1] ?? "")) {
			emit(text[cursor + 1], cursor + 2);
			continue;
		}
		if (char === "\n" || (char === "\\" && text[cursor + 1] === "\n")) {
			emit(el(context, "br"), cursor + (char === "\\" ? 2 : 1));
			continue;
		}
		if (char === "`") {
			const run = ticksAt(text, cursor);
			const code = run <= 32 ? codeAt(text, cursor, run, context) : null;
			if (code) { emit(el(context, "code", code.text), code.end); continue; }
			cursor += run;
			continue;
		}
		if (char === "[" || (char === "!" && text[cursor + 1] === "[")) {
			const link = linkAt(text, cursor, context);
			if (link) {
				const href = inLink ? null : safeHref(link.target);
				const label = link.image ? [`Immagine: ${unescape(link.label) || "senza descrizione"}`] : inline(link.label || link.target, context, depth + 1, true);
				// A picture is an explicit link, never a request triggered by rendering the reply.
				emit(href ? anchor(context, href, link.title, label) : el(context, "span", label), link.end);
				continue;
			}
		}
		if (!inLink && (char === "<" || ((char === "h" || char === "H") && !/[\p{L}\p{N}_/"'=]/u.test(text[cursor - 1] ?? "") && /^https?:\/\//i.test(text.slice(cursor, cursor + 8))))) {
			const link = autoAt(text, cursor, context, char === "<");
			if (link) { emit(anchor(context, link.href, "", [link.label]), link.end); continue; }
		}
		if (char === "*" || char === "_" || char === "~") {
			let end = cursor + 1;
			while (text[end] === char) end++;
			let remaining = end - cursor;
			if ((char === "~" && remaining !== 2) || remaining > 3) { cursor = end; continue; }
			const before = text[cursor - 1] ?? "";
			const after = text[end] ?? "";
			const opens = Boolean(after) && !/\s/u.test(after) && (char !== "_" || !WORD.test(before));
			const closes = Boolean(before) && !/\s/u.test(before) && (char !== "_" || !WORD.test(after));
			while (remaining > 0) {
				const top = current();
				if (closes && frames.length > 1 && top.char === char && top.marker.length <= remaining) {
					flush(cursor);
					frames.pop();
					current().nodes.push(el(context, top.tag, top.nodes));
					remaining -= top.marker.length;
					cursor = rawAt = cursor + top.marker.length;
				} else if (opens && frames.length <= MAX_DEPTH && (char !== "~" || remaining === 2)) {
					const width = remaining >= 2 ? 2 : 1;
					flush(cursor);
					frames.push({ nodes: [], marker: char.repeat(width), char, tag: char === "~" ? "del" : width === 2 ? "strong" : "em" });
					remaining -= width;
					cursor = rawAt = cursor + width;
				} else { cursor += remaining; break; }
			}
			continue;
		}
		cursor++;
	}
	if (cursor < text.length) {
		flush(cursor);
		current().nodes.push(el(context, "span.markdown-fallback", text.slice(cursor)));
	} else flush(text.length);
	while (frames.length > 1) {
		const unfinished = frames.pop();
		current().nodes.push(unfinished.marker);
		for (const node of unfinished.nodes) current().nodes.push(node);
	}
	return frames[0].nodes;
}

function headingText(text) {
	let value = text.trim();
	let end = value.length;
	while (end > 0 && value[end - 1] === "#") end--;
	if (end < value.length && (end === 0 || /[ \t]/.test(value[end - 1]))) value = value.slice(0, end).trimEnd();
	return value;
}

function indentWidth(text) {
	let width = 0;
	for (const char of text) width += char === "\t" ? 4 - width % 4 : 1;
	return width;
}

function marker(line) {
	const match = ITEM.exec(line);
	if (!match) return null;
	const indent = indentWidth(match[1]);
	const ordered = /\d/.test(match[2][0]);
	return { indent, ordered, start: ordered ? Number.parseInt(match[2], 10) : 1, content: match[4] ?? "", contentIndent: indent + match[2].length + Math.max(1, indentWidth(match[3] ?? "")) };
}

function dedent(line, width) {
	let at = 0;
	let removed = 0;
	while (removed < width && (line[at] === " " || line[at] === "\t")) {
		removed += line[at++] === "\t" ? 4 - removed % 4 : 1;
	}
	return " ".repeat(Math.max(0, removed - width)) + line.slice(at);
}

function cells(line) {
	const row = line.trim();
	const values = [];
	let value = "";
	let codeTicks = 0;
	let separators = 0;
	for (let at = 0; at < row.length; at++) {
		const char = row[at];
		if (char === "\\" && at + 1 < row.length) value += char + row[++at];
		else if (char === "`") {
			const width = ticksAt(row, at);
			if (!codeTicks) codeTicks = width;
			else if (codeTicks === width) codeTicks = 0;
			value += "`".repeat(width);
			at += width - 1;
		} else if (char === "|" && !codeTicks) {
			values.push(value.trim());
			value = "";
			separators++;
			if (values.length > MAX_CELLS + 1) return null;
		} else value += char;
	}
	values.push(value.trim());
	if (row.startsWith("|")) values.shift();
	if (value === "" && row.endsWith("|") && !codeTicks) values.pop();
	return separators && values.length <= MAX_CELLS ? values : null;
}

function tableAt(lines, at) {
	if (!lines[at]?.includes("|") || !lines[at + 1]?.includes("-")) return null;
	const header = cells(lines[at]);
	const separator = cells(lines[at + 1]);
	if (!header || !separator || header.length !== separator.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
	return { header, align: separator.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined) };
}

function startsBlock(lines, at) {
	const line = lines[at] ?? "";
	return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line) || Boolean(marker(line)) || SETEXT.test(lines[at + 1] ?? "") || Boolean(tableAt(lines, at));
}

function codeBlock(context, text, info) {
	const token = info.trim().split(/\s/, 1)[0];
	const language = /^[a-z0-9_+#.-]{1,48}$/i.test(token) ? token : "";
	const feedback = el(context, "span.markdown-code-status", { role: "status", "aria-live": "polite", "aria-atomic": "true" });
	const copy = el(context, "button.markdown-code-copy", {
		type: "button",
		"aria-label": language ? `Copia codice ${language}` : "Copia codice",
		onclick: async () => {
			if (copy.disabled) return;
			copy.disabled = true;
			feedback.textContent = "Copia in corso…";
			try {
				if (typeof globalThis.navigator?.clipboard?.writeText !== "function") {
					feedback.textContent = "Copia non disponibile. Seleziona il codice e copialo manualmente.";
					return;
				}
				await globalThis.navigator.clipboard.writeText(text);
				feedback.textContent = "Codice copiato.";
			} catch {
				feedback.textContent = "Copia non riuscita. Seleziona il codice e copialo manualmente.";
			} finally { copy.disabled = false; }
		},
	}, "Copia codice");
	return el(context, "div.markdown-code",
		el(context, "div.markdown-code-head", el(context, "span", language || "Codice"), copy),
		el(context, "pre", el(context, "code", { class: language ? `language-${language}` : undefined }, text)),
		feedback,
	);
}

function list(lines, at, parent, context, depth) {
	const first = marker(lines[at]);
	const container = el(context, first.ordered ? "ol" : "ul", { start: first.ordered && first.start !== 1 ? first.start : undefined });
	parent.append(container);
	while (at < lines.length && context.nodes > 128) {
		const item = marker(lines[at]);
		if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;
		const content = [item.content];
		at++;
		let blank = false;
		while (at < lines.length) {
			const line = lines[at];
			if (!line.trim()) { content.push(""); blank = true; at++; continue; }
			const next = marker(line);
			if (next && next.indent < item.contentIndent) break;
			const indent = /^[ \t]*/.exec(line)[0];
			if (indentWidth(indent) >= item.contentIndent) content.push(dedent(line, item.contentIndent));
			else if (!blank && !startsBlock(lines, at)) content.push(line.trimStart());
			else break;
			blank = false;
			at++;
		}
		const li = el(context, "li");
		blocks(content, li, context, depth + 1);
		container.append(li);
	}
	return at;
}

function table(lines, at, parent, context, schema) {
	const row = (values, header) => el(context, "tr", schema.header.map((_, index) => el(context, header ? "th" : "td", { scope: header ? "col" : undefined, "data-align": schema.align[index] }, inline(values[index] ?? "", context))));
	const body = el(context, "tbody");
	const element = el(context, "table", el(context, "thead", row(schema.header, true)), body);
	parent.append(el(context, "div.markdown-table", { role: "region", "aria-label": "Tabella", tabindex: "0" }, element));
	at += 2;
	while (at < lines.length && lines[at].trim() && context.nodes > schema.header.length * 3 + 128) {
		const values = cells(lines[at]);
		if (!values) break;
		body.append(row(values, false));
		at++;
	}
	return at;
}

function blocks(lines, parent, context, depth) {
	let at = 0;
	while (at < lines.length) {
		if (depth >= MAX_DEPTH || context.nodes <= 128 || context.work <= 0) {
			parent.append(el(context, "p.markdown-fallback", lines.slice(at).join("\n")));
			return;
		}
		const line = lines[at];
		if (!line.trim()) { at++; continue; }
		const fence = FENCE.exec(line);
		if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
			const code = [];
			at++;
			while (at < lines.length) {
				const end = FENCE_END.exec(lines[at]);
				if (end && end[1][0] === fence[1][0] && end[1].length >= fence[1].length) { at++; break; }
				code.push(lines[at++]);
			}
			parent.append(codeBlock(context, code.join("\n"), fence[2]));
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			parent.append(el(context, `h${heading[1].length}`, inline(headingText(heading[2] ?? ""), context)));
			at++;
			continue;
		}
		if (RULE.test(line)) { parent.append(el(context, "hr")); at++; continue; }
		if (QUOTE.test(line)) {
			const quoted = [];
			while (at < lines.length && QUOTE.test(lines[at])) quoted.push(QUOTE.exec(lines[at++])[1]);
			const quote = el(context, "blockquote");
			blocks(quoted, quote, context, depth + 1);
			parent.append(quote);
			continue;
		}
		if (marker(line)) { at = list(lines, at, parent, context, depth); continue; }
		const schema = tableAt(lines, at);
		if (schema) { at = table(lines, at, parent, context, schema); continue; }
		const underline = SETEXT.exec(lines[at + 1] ?? "");
		if (underline) {
			parent.append(el(context, underline[1][0] === "=" ? "h1" : "h2", inline(line.trim(), context)));
			at += 2;
			continue;
		}
		const paragraph = [line];
		at++;
		while (at < lines.length && lines[at].trim() && !startsBlock(lines, at)) paragraph.push(lines[at++]);
		parent.append(el(context, "p", inline(paragraph.join("\n"), context)));
	}
}
