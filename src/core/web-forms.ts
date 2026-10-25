import { randomBytes } from "node:crypto";

/**
 * The HTML forms of a page, as web_read lists them and web_submit sends them. Parsed with
 * indexOf and regexes on single tags only, so a hostile page costs linear time.
 */
export type FormField = {
	readonly name: string;
	/** input type, or "select" / "textarea". */
	readonly kind: string;
	readonly value: string;
	readonly checked: boolean;
	readonly required: boolean;
	/** Browsers never send a disabled field. */
	readonly disabled: boolean;
	/** What the page shows for it: its label, aria-label or placeholder. */
	readonly label: string;
	/** For select and radio: the values that may be chosen. */
	readonly options?: readonly string[];
};

export type WebForm = {
	readonly index: number;
	readonly method: "GET" | "POST";
	/** Absolute URL the form is sent to. */
	readonly action: string;
	readonly enctype: "application/x-www-form-urlencoded" | "multipart/form-data" | "other";
	readonly fields: readonly FormField[];
};

const MAX_FORMS = 20;
const MAX_FIELDS = 100;
const MAX_TAG = 4096;
const HIDDEN_KINDS = new Set(["hidden"]);
const BUTTON_KINDS = new Set(["submit", "button", "image", "reset"]);

/** Fields the model may fill: visible ones that carry a value (no hidden, buttons or files). */
export function fillable(field: FormField): boolean {
	return !HIDDEN_KINDS.has(field.kind) && !BUTTON_KINDS.has(field.kind) && field.kind !== "file" && !field.disabled;
}

/** The buttons that send the form, in page order: web_submit presses one. */
export function submitButtons(form: WebForm): FormField[] {
	return form.fields.filter((f) => (f.kind === "submit" || f.kind === "image") && !f.disabled);
}

/** Lowercase for ASCII only: same length as the input, so indices found in it fit the original. */
export function asciiLower(text: string): string {
	return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** A page attribute shown outside the data fence (errors): letters, digits and a few signs, short. */
export function plain(text: string): string {
	return text.replace(/[^\p{L}\p{N}_.\-[\] ]/gu, "").slice(0, 40);
}

export function pageForms(html: string, pageUrl: string): WebForm[] {
	const lower = asciiLower(html);
	const labels = labelTexts(html, lower);
	const forms: WebForm[] = [];
	let from = 0;
	while (forms.length < MAX_FORMS) {
		const start = lower.indexOf("<form", from);
		if (start < 0) break;
		const open = tagAt(html, start);
		if (open === undefined) break;
		const close = lower.indexOf("</form", open.end);
		const end = close < 0 ? html.length : close;
		const attrs = attributes(open.text);
		let action: string;
		try {
			action = new URL(attrs.get("action") || pageUrl, pageUrl).toString();
		} catch {
			from = end;
			continue;
		}
		const method = (attrs.get("method") ?? "get").toLowerCase() === "post" ? "POST" : "GET";
		const type = (attrs.get("enctype") ?? "").toLowerCase();
		const enctype = type === "" || type === "application/x-www-form-urlencoded" ? "application/x-www-form-urlencoded" : type === "multipart/form-data" ? "multipart/form-data" : "other";
		forms.push({ index: forms.length, method, action, enctype, fields: formFields(html.slice(open.end, end), labels) });
		from = end + 1;
	}
	return forms;
}

function formFields(html: string, labels: ReadonlyMap<string, string>): FormField[] {
	const lower = asciiLower(html);
	const fields: FormField[] = [];
	const radios = new Map<string, string[]>();
	const find = tagFinder(lower, ["<input", "<select", "<textarea", "<button"]);
	let at = 0;
	while (fields.length < MAX_FIELDS) {
		const next = find(at);
		if (next === undefined) break;
		const tag = tagAt(html, next.start);
		if (tag === undefined) break;
		at = tag.end;
		const attrs = attributes(tag.text);
		const name = attrs.get("name");
		const label = (attrs.get("aria-label") ?? labels.get(attrs.get("id") ?? "") ?? attrs.get("placeholder") ?? "").slice(0, 120);
		const required = attrs.has("required");
		const disabled = attrs.has("disabled");
		if (next.tag === "<select") {
			const close = lower.indexOf("</select", at);
			const inner = html.slice(at, close < 0 ? html.length : close);
			const options = optionValues(inner);
			at = close < 0 ? html.length : close;
			if (name) fields.push({ name, kind: "select", value: options.selected ?? options.values[0] ?? "", checked: false, required, disabled, label, options: options.values });
			continue;
		}
		if (next.tag === "<textarea") {
			const close = lower.indexOf("</textarea", at);
			const value = decode(html.slice(at, close < 0 ? html.length : close));
			at = close < 0 ? html.length : close;
			if (name) fields.push({ name, kind: "textarea", value, checked: false, required, disabled, label });
			continue;
		}
		const kind = next.tag === "<button" ? (attrs.get("type") ?? "submit").toLowerCase() : (attrs.get("type") ?? "text").toLowerCase();
		const buttonLabel = next.tag === "<button" ? decode(html.slice(at, Math.max(at, lower.indexOf("</button", at))).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80) : "";
		if (!name && kind !== "submit" && kind !== "image") continue;
		const value = attrs.get("value") ?? (kind === "checkbox" || kind === "radio" ? "on" : kind === "submit" ? buttonLabel : "");
		if (kind === "radio" && name) {
			const list = radios.get(name);
			if (list !== undefined) {
				list.push(value);
				if (attrs.has("checked")) {
					const i = fields.findIndex((f) => f.name === name && f.kind === "radio");
					if (i >= 0) fields[i] = { ...(fields[i] as FormField), value, checked: true };
				}
				continue;
			}
			const values = [value];
			radios.set(name, values);
			fields.push({ name, kind, value, checked: attrs.has("checked"), required, disabled, label, options: values });
			continue;
		}
		fields.push({ name: name ?? "", kind, value, checked: attrs.has("checked"), required, disabled, label: label || buttonLabel || (kind === "submit" ? value : "") });
	}
	return fields;
}

/**
 * The body of a form sent with the model's values over the page's defaults, as a browser would
 * after pressing `button` (the n-th submit button, the first by default). Hidden fields come
 * only from the page; a value for a name the form lacks, or only for fields the model may not
 * fill, is refused before anything leaves. `shown` is everything sent except hidden fields:
 * what the approver reads.
 */
export function formBody(form: WebForm, values: Readonly<Record<string, string>>, button = 0): { contentType: string; body: Buffer; shown: [string, string][] } {
	const given = new Map(Object.entries(values));
	for (const name of given.keys()) {
		const named = form.fields.filter((f) => f.name === name);
		if (named.length === 0) throw new FormRefused(`il modulo non ha un campo «${plain(name)}»`);
		if (!named.some(fillable)) throw new FormRefused(`il campo «${plain(name)}» lo decide il sito, non si compila`);
	}
	const buttons = submitButtons(form);
	if (button !== 0 && buttons[button] === undefined) throw new FormRefused(`il modulo non ha il pulsante ${button}`);
	const pressed = buttons[button];
	const pairs: [string, string, boolean][] = [];
	for (const field of form.fields) {
		if (field.disabled || field.kind === "file" || field.kind === "reset" || field.kind === "button") continue;
		if (field.kind === "submit" || field.kind === "image") {
			if (field !== pressed || field.name === "") continue;
			if (field.kind === "image") pairs.push([`${field.name}.x`, "1", true], [`${field.name}.y`, "1", true]);
			else pairs.push([field.name, field.value, true]);
			continue;
		}
		if (HIDDEN_KINDS.has(field.kind)) {
			pairs.push([field.name, field.value, false]);
			continue;
		}
		const value = given.get(field.name);
		if (field.kind === "checkbox") {
			// Several checkboxes with one name: the value lists which ones, comma-separated.
			const group = form.fields.filter((f) => f.kind === "checkbox" && f.name === field.name);
			const on = value === undefined ? field.checked : group.length > 1 ? value.split(",").map((v) => v.trim()).includes(field.value) : value !== "" && value !== "false" && value !== "no";
			if (on) pairs.push([field.name, field.value, true]);
			continue;
		}
		if (value !== undefined && field.options !== undefined && !field.options.includes(value)) {
			throw new FormRefused(`«${plain(value)}» non è tra le scelte di «${plain(field.name)}»`);
		}
		if (field.kind === "radio") {
			if (value !== undefined) pairs.push([field.name, value, true]);
			else if (field.checked) pairs.push([field.name, field.value, true]);
			continue;
		}
		pairs.push([field.name, value ?? field.value, true]);
	}
	const shown = pairs.filter((p) => p[2]).map(([k, v]): [string, string] => [k, v]);
	if (form.enctype === "multipart/form-data") {
		const boundary = `----owni${randomBytes(12).toString("hex")}`;
		const parts = pairs.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/["\r\n]/g, "_")}"\r\n\r\n${v}\r\n`);
		return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.from(`${parts.join("")}--${boundary}--\r\n`), shown };
	}
	return { contentType: "application/x-www-form-urlencoded", body: Buffer.from(new URLSearchParams(pairs.map(([k, v]) => [k, v])).toString()), shown };
}

/**
 * What must not change between the request and the send: destination, method, format, every
 * field with its kind and default, hidden ones by name only (their values, like a token, are
 * fresh at each visit).
 */
export function formFingerprint(form: WebForm): string {
	return JSON.stringify([form.action, form.method, form.enctype, form.fields.map((f) => [f.name, f.kind, f.disabled, HIDDEN_KINDS.has(f.kind) ? "" : f.value, f.checked, f.options ?? null])]);
}

export class FormRefused extends Error {
	override readonly name = "FormRefused";
}

/** One line per form, for web_read: what can be sent and with which fields. */
export function describeForms(forms: readonly WebForm[]): string {
	return forms
		.map((form) => {
			const fields = form.fields.filter(fillable).map((f) => {
				const choices = f.options === undefined ? "" : ` [${f.options.slice(0, 8).join("|")}]`;
				return `${f.name} (${f.kind}${f.required ? ", obbligatorio" : ""}${f.label ? `, «${f.label}»` : ""})${choices}`;
			});
			const buttons = submitButtons(form);
			const pressable = buttons.length > 1 ? `\n  pulsanti: ${buttons.map((b, i) => `${i} «${b.label || b.value || b.name}»`).join("; ")}` : "";
			return `Modulo ${form.index}: ${form.method} ${form.action}${fields.length > 0 ? `\n  campi: ${fields.join("; ")}` : "\n  nessun campo da compilare"}${pressable}`;
		})
		.join("\n");
}

function labelTexts(html: string, lower: string): Map<string, string> {
	const out = new Map<string, string>();
	let at = 0;
	for (let n = 0; n < 500; n++) {
		const start = lower.indexOf("<label", at);
		if (start < 0) break;
		const tag = tagAt(html, start);
		if (tag === undefined) break;
		const close = lower.indexOf("</label", tag.end);
		const end = close < 0 ? tag.end : close;
		const target = attributes(tag.text).get("for");
		if (target) out.set(target, decode(html.slice(tag.end, end).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim());
		at = end + 1;
	}
	return out;
}

function optionValues(html: string): { values: string[]; selected?: string } {
	const lower = asciiLower(html);
	const values: string[] = [];
	let selected: string | undefined;
	let at = 0;
	while (values.length < 200) {
		const start = lower.indexOf("<option", at);
		if (start < 0) break;
		const tag = tagAt(html, start);
		if (tag === undefined) break;
		const attrs = attributes(tag.text);
		const close = lower.indexOf("<", tag.end);
		const value = attrs.get("value") ?? decode(html.slice(tag.end, close < 0 ? html.length : close)).trim();
		values.push(value);
		if (attrs.has("selected") && selected === undefined) selected = value;
		at = tag.end;
	}
	return selected === undefined ? { values } : { values, selected };
}

/**
 * The next of these tags at or after a position, for a cursor that only moves forward: each
 * tag's next match is remembered, so the page is scanned once per tag, however many decoys.
 */
function tagFinder(lower: string, tags: readonly string[]): (from: number) => { start: number; tag: string } | undefined {
	const at = new Map<string, number>(tags.map((t) => [t, -2]));
	return (from) => {
		let best: { start: number; tag: string } | undefined;
		for (const tag of tags) {
			let i = at.get(tag) as number;
			if (i !== -1 && i < from) {
				i = lower.indexOf(tag, from);
				// "<input" must not match "<inputx": the next character ends the name.
				while (i >= 0 && /[\w-]/.test(lower[i + tag.length] ?? "")) i = lower.indexOf(tag, i + 1);
				at.set(tag, i);
			}
			if (i >= 0 && (best === undefined || i < best.start)) best = { start: i, tag };
		}
		return best;
	};
}

/** The tag that starts at `start`, up to its ">" (bounded: a tag longer than 4 KB is dropped). */
function tagAt(html: string, start: number): { text: string; end: number } | undefined {
	const close = html.indexOf(">", start);
	if (close < 0) return undefined;
	if (close - start > MAX_TAG) return { text: "<x>", end: close + 1 };
	return { text: html.slice(start, close + 1), end: close + 1 };
}

function attributes(tag: string): Map<string, string> {
	const out = new Map<string, string>();
	const body = tag.replace(/^<[\w-]+/, "").replace(/\/?>$/, "");
	for (const m of body.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		const name = (m[1] ?? "").toLowerCase();
		if (!out.has(name)) out.set(name, decode(m[2] ?? m[3] ?? m[4] ?? ""));
	}
	return out;
}

function decode(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d{1,7});/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
		.replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => String.fromCodePoint(Math.min(Number.parseInt(n, 16), 0x10ffff)))
		.replace(/&amp;/g, "&");
}
