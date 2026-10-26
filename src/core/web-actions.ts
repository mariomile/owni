import { ActionQueue, type QueuedStatus } from "./action-queue.ts";
import type { AskedBy } from "./agent-asks.ts";
import { CookieJar, checkedUrl, pageText, WebFetchRefused, type WebFetchOptions, webFetch } from "./web-fetch.ts";
import { FormRefused, formBody, formFingerprint, pageForms, type WebForm } from "./web-forms.ts";

/**
 * A form Owni asked to send (web_submit), waiting for (or past) a person's decision. Sent at
 * most once: the status is "running" on disk before the request leaves, so a crash in between
 * leaves it "uncertain", never sent twice (ADR 0011).
 */
export type WebAction = {
	readonly id: string;
	/** The page the form is on. */
	readonly pageUrl: string;
	readonly form: number;
	/** Where the form goes and how, as seen when it was asked: checked again before sending. */
	readonly action: string;
	readonly method: "POST";
	readonly values: Readonly<Record<string, string>>;
	/** The submit button pressed (its number among the form's buttons). */
	readonly button: number;
	/** Everything that will be sent except hidden fields, as the approver reads it. */
	readonly shown: readonly (readonly [string, string])[];
	/** The form as it was when asked (formFingerprint): a changed form is not sent. */
	readonly fingerprint: string;
	/** Why, in Owni's words: shown on the card. */
	readonly reason: string;
	readonly status: QueuedStatus;
	readonly thread?: { readonly channel: string; readonly threadId: string };
	/** The person whose private conversation asked for it ("channel:userId"): they may decide. */
	readonly requester?: string;
	/** Another agente asked for it, in this agente's conversation with it (ADR 0108): shown on the card. */
	readonly askedBy?: AskedBy;
	readonly proposedAt: string;
	/** The conversation was told it expired undecided. */
	readonly expiryTold?: true;
	readonly decidedBy?: { readonly channel: string; readonly userId: string };
	readonly decidedAt?: string;
	readonly result?: WebActionResult;
	/** Chats that have the card. */
	readonly notified?: readonly string[];
};

/** What the site answered; or why nothing left; or, once the form had gone out, that the outcome is not known. */
export type WebActionResult = { readonly status: number; readonly url: string; readonly title: string; readonly text: string } | { readonly error: string; readonly uncertain?: true };

export class WebActionError extends Error {
	override readonly name = "WebActionError";
}

/** The form may have reached the site: never "not sent", never sent again. */
export class WebActionUncertain extends Error {
	override readonly name = "WebActionUncertain";
}

export const WEB_ACTION_LIMITS = { maxPending: 20, ttlMs: 24 * 3600_000, maxValues: 50, maxValueChars: 5_000, maxResultChars: 4_000, keepMs: 30 * 24 * 3600_000 } as const;
/** Connector name in the egress policy: the owner turned web actions on for the instance. */
export const WEB_ACTIONS_CONNECTOR = "web-actions";

export class WebActionStore {
	private readonly queue: ActionQueue<WebAction>;

	constructor(dir: string) {
		this.queue = new ActionQueue<WebAction>(dir, WEB_ACTION_LIMITS, (error) => error instanceof WebActionUncertain, () => new WebActionError(`troppe azioni in attesa (${WEB_ACTION_LIMITS.maxPending})`));
	}

	/** `key` (the tool call's) makes a rerun return the same request instead of a second one. */
	async propose(input: Pick<WebAction, "pageUrl" | "form" | "action" | "values" | "button" | "shown" | "fingerprint" | "reason" | "thread" | "requester" | "askedBy">, now = new Date(), key?: string): Promise<WebAction> {
		const id = this.queue.idFor(key);
		if (key !== undefined) {
			const existing = await this.get(id, now);
			if (existing !== undefined) return existing;
		}
		if (Object.keys(input.values).length > WEB_ACTION_LIMITS.maxValues) throw new WebActionError(`al massimo ${WEB_ACTION_LIMITS.maxValues} campi`);
		if (Object.values(input.values).some((v) => v.length > WEB_ACTION_LIMITS.maxValueChars)) throw new WebActionError(`un valore supera ${WEB_ACTION_LIMITS.maxValueChars} caratteri`);
		return this.queue.add({ ...input, method: "POST", id, status: "pending", proposedAt: now.toISOString() }, now);
	}

	get(id: string, now = new Date()): Promise<WebAction | undefined> {
		return this.queue.get(id, now);
	}

	list(now = new Date()): Promise<WebAction[]> {
		return this.queue.list(now);
	}

	/**
	 * Decide a pending action; one decision at a time per action, the first one wins. Approving
	 * marks it running and sends it with `run`, then stores the result.
	 */
	async decide(id: string, decision: "approved" | "rejected", by: { channel: string; userId: string }, run: (action: WebAction) => Promise<WebActionResult>, now = new Date()): Promise<{ action: WebAction; changed: boolean }> {
		const decided = await this.queue.decide(id, decision, () => {}, { decidedBy: by }, run, now);
		if (decided.missing) throw new WebActionError(`nessuna azione ${id}`);
		return decided;
	}

	/** Nobody decided in time and the conversation does not know yet. */
	expiredUntold(now = new Date()): Promise<WebAction[]> {
		return this.queue.expiredUntold(now);
	}

	claimExpired(id: string, now = new Date()): Promise<WebAction | undefined> {
		return this.queue.claimExpired(id, now);
	}

	/** At start: an action left running by a dead process may or may not have been sent. */
	settleInterrupted(): Promise<WebAction[]> {
		return this.queue.settleInterrupted();
	}

	markNotified(id: string, chat: string): Promise<void> {
		return this.queue.update(id, (current) => ({ ...current, notified: [...new Set([...(current.notified ?? []), chat])] }));
	}
}

/** The form `index` of the page, read through the guarded fetch with this visit's cookies. */
export async function readForm(pageUrl: string, index: number, guard: WebFetchOptions): Promise<{ form: WebForm; page: string }> {
	const page = await webFetch(pageUrl, guard);
	if (page.status >= 400) throw new WebFetchRefused(`la pagina risponde ${page.status}`);
	if (!/^text\/html/i.test(page.contentType)) throw new WebFetchRefused("la pagina non è HTML, non ha moduli");
	const form = pageForms(page.body, page.url)[index];
	if (form === undefined) throw new FormRefused(`la pagina non ha il modulo ${index}`);
	if (form.method !== "POST") throw new FormRefused(`il modulo ${index} è di ricerca (GET): leggi direttamente ${form.action} con i parametri nell'indirizzo`);
	if (form.enctype === "other") throw new FormRefused(`il modulo ${index} usa un formato che Owni non invia`);
	if (page.url.startsWith("https:") && form.action.startsWith("http:")) throw new FormRefused(`il modulo ${index} manda i dati in chiaro (http): Owni non lo invia`);
	return { form, page: page.url };
}

/**
 * Send an approved action: the page again (fresh hidden fields and cookies), the same form,
 * the same destination, then one POST. Everything through the guarded fetch.
 */
export async function sendWebAction(action: WebAction, guard: Omit<WebFetchOptions, "cookies" | "send">): Promise<WebActionResult> {
	const cookies = new CookieJar();
	const { form } = await readForm(action.pageUrl, action.form, { ...guard, cookies });
	if (form.action !== action.action) throw new FormRefused(`il modulo ora va a ${form.action}, non più a ${action.action}: chiedi di nuovo`);
	if (formFingerprint(form) !== action.fingerprint) throw new FormRefused("il modulo è cambiato da quando è stato chiesto: chiedi di nuovo");
	const send = formBody(form, action.values, action.button);
	checkedUrl(form.action, guard);
	// From here the form may reach the site: any failure is an unknown outcome, not "not sent".
	let answer: Awaited<ReturnType<typeof webFetch>>;
	try {
		answer = await webFetch(form.action, { ...guard, cookies, send });
	} catch (error) {
		throw new WebActionUncertain(`il modulo è partito ma la risposta non è arrivata (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
	}
	const html = /^text\/html/i.test(answer.contentType);
	const { title, text } = html ? pageText(answer.body) : { title: "", text: /^(text\/|application\/(json|xml))/i.test(answer.contentType) ? answer.body : "" };
	return { status: answer.status, url: answer.url, title: title.slice(0, 200), text: text.slice(0, WEB_ACTION_LIMITS.maxResultChars) };
}
