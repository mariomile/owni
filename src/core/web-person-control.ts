import { randomBytes } from "node:crypto";
import { DEEP, MAX_TYPED } from "./web-page-scripts.ts";
import type { Page } from "./web-session.ts";
import { ACTION_TIMEOUT_MS, BrowseError, Hung, READ_TIMEOUT_MS, within } from "./web-session-support.ts";

const MAX_PRIVATE_VALUES = 256;
export const PRESS_KEYS = ["Enter", "Tab", "Shift+Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type PressKey = (typeof PRESS_KEYS)[number];

/** Redact whole matches before selecting a window, including matches crossing either edge.
 * Offsets stay in the original text, so the next page cannot reveal a private value's suffix.
 */
export function privateSlice(text: string, forms: readonly string[], from = 0, to = text.length): string {
	const end = Math.min(to, text.length);
	if (from >= end) return "";
	let hidden: Uint8Array | undefined;
	for (const form of forms) {
		let at = text.indexOf(form, Math.max(0, from - form.length + 1));
		while (at >= 0 && at < end) {
			hidden ??= new Uint8Array(end - from);
			hidden.fill(1, Math.max(0, at - from), Math.min(end, at + form.length) - from);
			at = text.indexOf(form, at + 1);
		}
	}
	if (hidden === undefined) return text.slice(from, end);
	const out: string[] = [];
	for (let at = 0; at < hidden.length;) {
		const masked = hidden[at] === 1;
		let next = at + 1;
		while (next < hidden.length && (hidden[next] === 1) === masked) next++;
		out.push(masked ? "[privato]" : text.slice(from + at, from + next));
		at = next;
	}
	return out.join("");
}

/**
 * The person's side of a session (ADR 0106): who holds the page, what they typed in private
 * fields and how it is kept out of every view. `close` ends the session when a private value
 * can no longer be protected.
 */
export class PersonControl {
	readonly humanFlag = `__person${randomBytes(6).toString("hex")}`;
	readonly privateAttr = `data-private-${randomBytes(6).toString("hex")}`;
	readonly privateBinding = `__private${randomBytes(12).toString("hex")}`;
	readonly privateValues = new Set<string>();
	privateEdit: { readonly token: string; readonly document: string; readonly done: Promise<boolean>; readonly acknowledge: (retained: boolean) => void } | undefined;
	control: "agent" | "person" = "agent";
	humanAction = false;
	/** A person moved the page since the agente's last view: its numbers point elsewhere now. */
	movedByPerson = false;

	constructor(private readonly page: () => Page, private readonly close: () => Promise<void>) {}

	holder(owner: string | undefined, person: string): void {
		if (owner !== person || this.control !== "person") throw new BrowseError("prendi prima il controllo del tuo browser", "denied");
	}

	async release(): Promise<void> {
		await within(this.page().evaluate(`(() => { ${DEEP} for (const e of deep('[${this.privateAttr}]')) { e.value = ''; e.removeAttribute('${this.privateAttr}'); } })()`), READ_TIMEOUT_MS);
		this.control = "agent";
		this.humanAction = false;
	}

	async type(owner: string | undefined, person: string, text: string): Promise<void> {
		this.holder(owner, person);
		if (!text || text.length > MAX_TYPED || this.privateValues.size >= MAX_PRIVATE_VALUES) throw new BrowseError("testo non disponibile per questo campo", "no-field");
		await this.beginPrivateEdit();
		this.privateValues.add(text);
		try { await this.page().fill(":focus", text, { timeout: ACTION_TIMEOUT_MS }); }
		catch { throw new BrowseError("scrittura nel campo non riuscita", "failed"); }
	}

	async press(owner: string | undefined, person: string, keyName: PressKey): Promise<void> {
		this.holder(owner, person);
		if (!(PRESS_KEYS as readonly string[]).includes(keyName)) throw new BrowseError("tasto non disponibile", "denied");
		const focused = await this.beginPrivateEdit(keyName);
		try { await this.page().press(focused ? ":focus" : "body", keyName, { timeout: ACTION_TIMEOUT_MS }); }
		catch { throw new BrowseError("pressione del tasto non riuscita", "failed"); }
	}

	/** Start of an action: the page learns whether a person is driving it. */
	async begin(person: boolean): Promise<void> {
		this.humanAction = person && this.control === "person";
		if (this.humanAction) await within(this.page().evaluate(`window[${JSON.stringify(this.humanFlag)}] = true`), READ_TIMEOUT_MS);
	}

	/** End of an action, however it ended: the page stops taking the person's forms. */
	async finish(armed: boolean): Promise<void> {
		this.privateEdit = undefined;
		this.humanAction = false;
		if (armed) await within(this.page().evaluate(`window[${JSON.stringify(this.humanFlag)}] = false`), READ_TIMEOUT_MS).catch(() => {});
	}

	/** Arm only native value-changing gestures. A random edit token and document identity
	 * let the input binding acknowledge this action, never an older document or another field. */
	private async beginPrivateEdit(key?: PressKey): Promise<boolean> {
		const token = randomBytes(12).toString("hex");
		const raw = await within(this.page().evaluate<unknown>(`(() => {
			const editToken = ${JSON.stringify(token)};
			const key = ${JSON.stringify(key ?? "")};
			const e = document.activeElement;
			const field = e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && /^(text|password|email|search|tel|url|number)$/.test(e.type));
			const editing = field && (!key || (e.hasAttribute('${this.privateAttr}') && (key === 'Backspace' || (key === 'Enter' && e instanceof HTMLTextAreaElement) || (/^Arrow(Up|Down)$/.test(key) && e.type === 'number'))));
			if (editing) e.setAttribute('${this.privateAttr}', editToken);
			return { focused: e !== document.body && e !== document.documentElement, editing, document: window[${JSON.stringify(this.privateBinding + "Document")}] };
		})()`), READ_TIMEOUT_MS);
		const field = raw !== null && typeof raw === "object" ? raw as { focused?: unknown; editing?: unknown; document?: unknown } : undefined;
		if (field === undefined || typeof field.focused !== "boolean" || typeof field.editing !== "boolean") return this.fail();
		if (key === undefined && !field.editing) throw new BrowseError("seleziona prima un campo di testo", "no-field");
		if (field.editing) {
			if (typeof field.document !== "string" || !field.document || field.document.length > 128) return this.fail();
			let acknowledge!: (retained: boolean) => void;
			const done = new Promise<boolean>((resolve) => { acknowledge = resolve; });
			this.privateEdit = { token, document: field.document, done, acknowledge };
		}
		return field.focused;
	}

	/** The page's input binding: true when it is this action's own edit, in the main frame of this page. */
	async received(source: { page: Page; frame: unknown }, document: unknown, edit: unknown, value: unknown): Promise<boolean> {
		const pending = this.privateEdit;
		const page = this.page();
		if (pending === undefined || source.page !== page || source.frame !== page.mainFrame?.() || pending.document !== document || pending.token !== edit) return false;
		try { this.keep([value]); }
		catch { await this.fail().catch(() => {}); return false; }
		pending.acknowledge(true);
		return true;
	}

	async retain(): Promise<void> {
		const edit = this.privateEdit;
		if (edit === undefined) return;
		try {
			if (await within(edit.done, READ_TIMEOUT_MS)) return;
		} catch {}
		return this.fail();
	}

	async fail(): Promise<never> {
		this.privateEdit?.acknowledge(false);
		await this.close();
		throw new BrowseError("il browser non può proteggere altri dati privati: riapri la pagina", "failed");
	}

	/** Native edits and maxlength can change a supplied value. Read only marked fields,
	 * before a submit/navigation or release can remove them, and retain their history on the host. */
	async capture(): Promise<void> {
		if (this.privateValues.size === 0) return;
		const page = this.page();
		try {
			const read = () => within(page.evaluate<unknown>(`(() => {
				${DEEP}
				const values = [];
				for (const e of deep('[${this.privateAttr}]')) {
					if (!(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)) continue;
					values.push(String(e.value).slice(0, ${MAX_TYPED + 1}));
					if (values.length > ${MAX_PRIVATE_VALUES}) break;
				}
				return values;
			})()`), READ_TIMEOUT_MS);
			const values = await read().catch(async (error: unknown) => {
				if (error instanceof Hung) throw error;
				// A navigation can replace the execution context just after the action returned.
				await within(page.waitForLoadState("load", { timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS);
				return read();
			});
			this.keep(values);
		} catch {
			// Never discard history or truncate an unknown value and then expose its remainder.
			return this.fail();
		}
	}

	private keep(values: unknown): void {
		if (!Array.isArray(values) || values.length > MAX_PRIVATE_VALUES) throw new Error("private field limit");
		for (const value of values) {
			if (typeof value !== "string" || value.length > MAX_TYPED) throw new Error("private value limit");
			if (!value || this.privateValues.has(value)) continue;
			if (this.privateValues.size >= MAX_PRIVATE_VALUES) throw new Error("private history limit");
			this.privateValues.add(value);
		}
	}

	forms(): readonly string[] {
		const forms = new Set<string>();
		for (const value of this.privateValues) {
			// Textareas expose LF, native forms send CRLF, and single-line inputs remove line breaks.
			for (const plain of [value, value.replace(/\r\n|\r|\n/g, "\n"), value.replace(/\r\n|\r|\n/g, "\r\n"), value.replace(/[\r\n]/g, ""), value.replace(/\s+/g, " ").trim()]) {
				if (!plain) continue;
				forms.add(plain);
				forms.add(new URLSearchParams({ q: plain }).toString().slice(2));
				// URLSearchParams also handles malformed surrogate input; encodeURIComponent does not.
				try { forms.add(encodeURIComponent(plain)); } catch {}
			}
		}
		return [...forms];
	}

	redact(text: string): string {
		return privateSlice(text, this.forms());
	}
}
