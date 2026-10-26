import { randomBytes } from "node:crypto";
import { CookieJar, USER_AGENT } from "./web-fetch.ts";
import { guardContext, type Budget, type Guard, type Traffic } from "./web-guard.ts";
import { DEEP, initScript, MAX_ELEMENTS, MAX_TYPED, snapshotScript, VIEW_TEXT } from "./web-page-scripts.ts";
import { PersonControl, PRESS_KEYS, type PressKey, privateSlice } from "./web-person-control.ts";
import type { BrowserProfiles } from "./web-profiles.ts";
import { ACTION_TIMEOUT_MS, BrowseError, Hung, READ_TIMEOUT_MS, within } from "./web-session-support.ts";

/** What the browser needs from Chromium (Playwright's Browser satisfies it). */
export type Browser = {
	newContext(options: { viewport: { width: number; height: number }; userAgent: string; acceptDownloads: boolean; serviceWorkers: "block" }): Promise<BrowserContext>;
	close(): Promise<void>;
	on(event: "disconnected", listener: () => void): unknown;
};
export type BrowserContext = {
	route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
	routeWebSocket(url: RegExp, handler: (socket: { close(): Promise<void> }) => Promise<void> | void): Promise<void>;
	exposeBinding?(name: string, callback: (source: { page: Page; frame: unknown }, document: unknown, edit: unknown, value: unknown) => Promise<boolean>): Promise<void>;
	addInitScript(script: string): Promise<void>;
	on(event: "page", listener: (page: Page) => void): unknown;
	newPage(): Promise<Page>;
	close(): Promise<void>;
};
type Route = {
	request(): { url(): string; method(): string; isNavigationRequest(): boolean; frame?(): unknown; headers?(): Record<string, string>; postDataBuffer?(): Buffer | null };
	fulfill(response: { status: number; headers?: Record<string, string>; body?: Buffer }): Promise<void>;
	abort(reason?: string): Promise<void>;
};
export type Page = {
	mainFrame?(): unknown;
	goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	goBack(options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
	screenshot(options: { fullPage: boolean; type: "png"; timeout?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
	title(): Promise<string>;
	url(): string;
	evaluate<T>(expression: string): Promise<T>;
	click(selector: string, options: { timeout: number }): Promise<void>;
	mouse: { click(x: number, y: number): Promise<void> };
	fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
	selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
	press(selector: string, key: string, options: { timeout: number }): Promise<void>;
	waitForLoadState(state: "load", options: { timeout: number }): Promise<void>;
	/** Listening to this makes Chromium hold back its file chooser: the page never gets to open one. */
	on(event: "filechooser", listener: () => void): void;
	close(): Promise<void>;
};

/** The first line of an error, without what could pass for markup. */
export function plainError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message.split("\n")[0] ?? "").replace(/[^\w\s.:/()=-]/g, "").slice(0, 120);
}

/** Where to act: what the last view numbered. */
export type Element = { readonly ref: number; readonly kind: string; readonly label: string; readonly tag: string; readonly type: string; readonly href?: string; readonly value?: string };

export type View = {
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly elements: readonly Element[];
	/** Ours, fixed sentences: shown outside the fence. */
	readonly notes: readonly string[];
	/** Names and addresses the page chose: shown inside the fence. */
	readonly details: readonly string[];
	readonly screenshot?: Uint8Array;
	/** The action itself failed (the browser raised): the agente reads why in the notes, a person's panel treats it as an error. */
	readonly failed?: true;
};

export type ViewOptions = {
	readonly find?: string;
	readonly from?: number;
	readonly screenshot?: boolean;
	/** A person drove the page from the console's panel: the agente's last view no longer matches it. */
	readonly person?: true;
};

/** The size of every page's window: the picture of the panel is this big, and a click on it is placed in it. */
const VIEWPORT = { width: 1280, height: 800 };

/** A point of the picture, as fractions of its width and height (already checked to be 0 to 1 by the caller), in the page's own pixels. */
export function viewportPoint(fx: number, fy: number): { x: number; y: number } {
	return { x: Math.min(Math.floor(fx * VIEWPORT.width), VIEWPORT.width - 1), y: Math.min(Math.floor(fy * VIEWPORT.height), VIEWPORT.height - 1) };
}

const PAGE_BUDGET: Budget = { requests: 400, bytes: 40 * 1024 * 1024 };
/** After an action, how long to wait at most for the page's requests to end. */
const SETTLE_MS = 5_000;
/**
 * A file chooser Chromium reports within this long after a click or a typing returned is that action's
 * own (measured: a few tens of ms). Any later one comes from the page on its own (a timer): told in the next view.
 */
const OWN_CHOOSER_MS = 500;

type Raw = { elements?: unknown; more?: unknown; scannedAll?: unknown; text?: unknown; textLength?: unknown; frames?: unknown; postForms?: unknown; blockedForms?: unknown };

/** What the page script returned, checked: the page can patch the DOM and the builtins it uses. */
function cleanElements(raw: unknown, clean: (text: string, limit: number) => string): Element[] {
	if (!Array.isArray(raw)) return [];
	const text = (value: unknown, n: number) => (typeof value === "string" ? clean(value.replace(/\s+/g, " ").trim(), n) : "");
	const token = (value: unknown) => typeof value === "string" ? value.slice(0, 20) : "";
	return raw.slice(0, MAX_ELEMENTS).flatMap((item: unknown, i) => {
		if (item === null || typeof item !== "object") return [];
		const e = item as Record<string, unknown>;
		const tag = token(e.tag);
		const type = token(e.type);
		const options = Array.isArray(e.options) ? e.options.slice(0, 15).flatMap((option: unknown) => {
			if (option === null || typeof option !== "object") return [];
			const o = option as Record<string, unknown>;
			return [text(o.text, 40) + (o.different === true ? ` = ${text(o.value, 40)}` : "")];
		}).join(", ") + (typeof e.optionCount === "number" && e.optionCount > 15 ? `, +${e.optionCount - 15} altri` : "") : "";
		const own = text(e.label, 80);
		const label = `${own}${options ? `${own ? " " : ""}(valori: ${options})` : ""}`;
		const href = text(e.href, 300);
		const value = text(e.value, 80);
		return [{ ref: i + 1, kind: kindOf(tag, type, token(e.role), e.checked === true), label, tag, type, ...(href ? { href } : {}), ...(value ? { value } : {}) }];
	});
}

function kindOf(tag: string, type: string, role: string, checked: boolean): string {
	const mark = checked ? " (selezionata)" : "";
	if (tag === "a" || role === "link") return "link";
	if (tag === "select" || role === "combobox") return "scelta";
	if (tag === "textarea") return "campo di testo";
	if (tag === "input") {
		if (/^(submit|button|reset|image)$/.test(type)) return "pulsante";
		if (type === "checkbox") return `casella${mark}`;
		if (type === "radio") return `opzione${mark}`;
		if (type === "password") return "campo password";
		if (type === "file") return "caricamento file";
		return "campo di testo";
	}
	if (role === "checkbox" || role === "switch") return `casella${mark}`;
	if (role === "radio" || role === "option") return `opzione${mark}`;
	if (role === "tab") return "scheda";
	return "pulsante";
}

const NO_FILES = "Owni non carica file sui siti";
const LATE_CHOOSER = "La pagina ha provato da sola ad aprire la scelta di un file: rifiutata, Owni non carica file sui siti.";

type Session = {
	readonly scope: string;
	readonly thread: { channel: string; threadId: string };
	readonly owner?: string;
	readonly profile?: Profile;
	/** Who holds the page, and what the person typed in private (ADR 0106). */
	readonly person: PersonControl;
	readonly key: string;
	readonly context: BrowserContext;
	readonly page: Page;
	readonly flag: string;
	readonly traffic: Traffic;
	readonly budget: Budget;
	/** Read fresh at every request: the owner's list as of the current action. */
	readonly guard: { current: Guard };
	attr: string | undefined;
	elements: Map<number, Element>;
	timer: NodeJS.Timeout | undefined;
	used: number;
	busy: boolean;
	queue: Promise<unknown>;
	/** Counts the actions done: what someone watching compares to know the page may have changed. */
	version: number;
	/** The last picture taken for someone watching, and at which version. */
	picture: { readonly version: number; readonly png: Uint8Array } | undefined;
	/** Where the page was after the last action, for someone watching without asking Chromium. */
	shown: { readonly url: string; readonly title: string };
	/** When the page opened a file chooser (refused, whatever the way: label, shadow DOM, frame, input.click()), not yet told to the agente. */
	choosers: number[];
};

/** A conversation's browser as someone watching it sees it (the console's browser panel). */
export type BrowserState = { readonly open: true; readonly url: string; readonly title: string; readonly version: number; readonly busy: boolean; readonly control: "agent" | "person"; readonly profile: boolean } | { readonly open: false; readonly closed?: string };
export type BrowseAccounts = {
	readonly owner: (scope: string, thread: { readonly channel: string; readonly threadId: string }) => Promise<string | undefined>;
	readonly profiles?: BrowserProfiles;
	readonly submitted?: (key: string, person: string, host: string) => void;
};
type Profile = { scope: string; person: string; jar: CookieJar; active: boolean; queue: Promise<void> };

/**
 * Browsers that stay open for a conversation (ADR 0014): one per conversation, closed after a
 * while with no actions, a few at most on this server. Agent actions read; the person can
 * take control to submit basic forms privately.
 */
export class BrowseSessions {
	private readonly sessions = new Map<string, Session>();
	private readonly starting = new Map<string, Promise<void>>();
	private readonly profiles = new Map<string, Promise<Profile>>();
	private readonly clearing = new Map<string, Promise<void>>();
	private readonly uncleared = new Set<string>();
	/** Why a conversation's browser is gone, so Owni can say it, and the late file choosers the agente has not heard of yet. */
	private readonly closed = new Map<string, { readonly why: string; choosers: number[] }>();

	constructor(
		private readonly limits: { readonly max: number; readonly idleMs: number } = { max: 4, idleMs: 5 * 60_000 },
		/** A site's first file chooser refused in this browser, as Chromium reports it (the audit, ADR 0103): the conversation's key and the page's host. */
		private readonly refused: (key: string, host: string) => void = () => {},
		private readonly accounts?: BrowseAccounts,
	) {}

	/** Opens `url` in the conversation's browser, starting one if needed. */
	async open(key: string, browser: Browser, url: string, guard: Guard, options: ViewOptions = {}): Promise<View> {
		if (!this.sessions.has(key)) {
			// Two calls at once for a new conversation start one browser, not two.
			let starting = this.starting.get(key);
			if (starting === undefined) {
				starting = this.start(key, browser, guard).finally(() => this.starting.delete(key));
				this.starting.set(key, starting);
			}
			await starting;
		}
		return this.act(key, guard, options, false, async (s) => {
			// Each page opened gets its own budget.
			Object.assign(s.budget, PAGE_BUDGET);
			await s.page.goto(url, { waitUntil: "load", timeout: 20_000 });
		});
	}

	/** The page as it is now, or the one before it. */
	view(key: string, guard: Guard, options: ViewOptions & { readonly back?: boolean } = {}): Promise<View> {
		return this.act(key, guard, options, false, async (s) => {
			if (options.back !== true) return;
			Object.assign(s.budget, PAGE_BUDGET);
			await s.page.goBack({ waitUntil: "load", timeout: 20_000 });
		});
	}

	click(key: string, ref: number, guard: Guard, options: ViewOptions = {}): Promise<View> {
		return this.act(key, guard, options, true, async (s) => {
			const { selector } = await this.target(s, ref);
			await s.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
		});
	}

	/**
	 * A click on the picture the panel shows (ADR 0103): the point `fx`, `fy` (fractions of the picture)
	 * of the page. Same limits as web_click: no file uploads (the file chooser is refused when it opens), and the page still only reads.
	 */
	clickAt(key: string, fx: number, fy: number, guard: Guard, options: ViewOptions = {}): Promise<View> {
		const point = viewportPoint(fx, fy);
		return this.act(key, guard, options, true, async (s) => {
			await s.page.mouse.click(point.x, point.y);
		});
	}

	type(key: string, ref: number, text: string, submit: boolean, guard: Guard, options: ViewOptions = {}): Promise<View> {
		return this.act(key, guard, options, true, async (s) => {
			const { selector, live } = await this.target(s, ref);
			if (live.type === "password") throw new BrowseError("Owni non scrive password: non entra negli account");
			if (live.type === "checkbox" || live.type === "radio") throw new BrowseError(`l'elemento ${ref} è una casella: si seleziona con web_click`);
			if (live.tag === "select") {
				const forms = s.person.forms();
				const limit = 80 + Math.max(0, ...forms.map((form) => form.length));
				const choices = await within(s.page.evaluate<unknown>(`(() => { ${DEEP} return Array.from(deep(${JSON.stringify(selector)})[0].options).slice(0, 200).map((o) => [String(o.value).slice(0, ${limit}), String(o.text).replace(/\\s+/g, " ").trim().slice(0, ${limit})]); })()`), READ_TIMEOUT_MS);
				const pairs = (Array.isArray(choices) ? choices : []).filter((c): c is [string, string] => Array.isArray(c) && typeof c[0] === "string" && typeof c[1] === "string");
				if (!pairs.some(([value, label]) => value.slice(0, 80) === text || label.slice(0, 80) === text)) throw new BrowseError(`«${s.person.redact(text).slice(0, 40)}» non è tra i valori di questa scelta: ${pairs.slice(0, 15).map(([, label]) => privateSlice(label, forms, 0, 80).slice(0, 80)).join(", ")}`);
				await s.page.selectOption(selector, text, { timeout: ACTION_TIMEOUT_MS });
			} else if (live.tag === "input" || live.tag === "textarea") await s.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
			else throw new BrowseError(`l'elemento ${ref} non è un campo: si clicca con web_click`);
			if (submit) await s.page.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
		});
	}

	async takeover(key: string, person: string, guard: Guard): Promise<BrowserState> {
		await this.act(key, guard, { person: true }, false, async (s) => {
			if (s.owner !== person || !(await this.allowed(s)) || !this.current(s)) throw new BrowseError("questo browser non ti appartiene", "denied");
			s.person.control = "person";
		});
		return this.state(key);
	}

	async release(key: string, person: string): Promise<BrowserState> {
		const s = this.sessions.get(key);
		if (s === undefined) return this.state(key);
		await this.act(key, s.guard.current, { person: true }, false, async (s) => {
			if (s.owner !== person) throw new BrowseError("questo browser non ti appartiene", "denied");
			await s.person.release();
		});
		return this.state(key);
	}

	typeText(key: string, person: string, text: string, guard: Guard): Promise<View> {
		return this.act(key, guard, { person: true }, true, async (s) => {
			await s.person.type(s.owner, person, text);
		});
	}

	press(key: string, person: string, keyName: PressKey, guard: Guard): Promise<View> {
		return this.act(key, guard, { person: true }, true, async (s) => {
			await s.person.press(s.owner, person, keyName);
		});
	}

	private owner(scope: string, thread: { channel: string; threadId: string }): Promise<string | undefined> {
		return this.accounts?.owner(scope, thread).catch(() => undefined) ?? Promise.resolve(undefined);
	}

	private async sharedProfile(scope: string, person: string): Promise<Profile> {
		const key = `${scope}\0${person}`;
		await this.clearing.get(key);
		if (this.uncleared.has(key)) throw new BrowseError("riprova a cancellare gli accessi ai siti", "denied");
		let pending = this.profiles.get(key);
		if (pending === undefined) {
			pending = (async () => ({ scope, person, jar: await this.accounts!.profiles!.load(scope, person), active: true, queue: Promise.resolve() }))();
			this.profiles.set(key, pending);
			void pending.catch(() => { if (this.profiles.get(key) === pending) this.profiles.delete(key); });
		}
		return pending;
	}

	private async save(s: Session): Promise<void> {
		const p = s.profile;
		if (p === undefined || !p.active) return;
		const write = p.queue.catch(() => {}).then(async () => {
			if (!p.active || await this.owner(s.scope, s.thread) !== s.owner || !p.active) return;
			// Closing normally still saves; a profile invalidated while ownership was read never does.
			await this.accounts?.profiles?.save(p.scope, p.person, p.jar);
		});
		p.queue = write;
		await write;
	}

	async profile(scope: string, person: string): Promise<{ readonly hosts: readonly string[] }> {
		if (this.accounts?.profiles === undefined) return { hosts: [] };
		const p = await this.sharedProfile(scope, person);
		return { hosts: p.active ? p.jar.hosts() : [] };
	}

	clearProfile(scope: string, person: string): Promise<void> {
		const key = `${scope}\0${person}`;
		const existing = this.clearing.get(key);
		if (existing !== undefined) return existing;
		this.uncleared.add(key);
		const run = (async () => {
			const pending = this.profiles.get(key);
			const p = await pending;
			if (p !== undefined) p.active = false;
			await Promise.all([...this.sessions.values()].filter((s) => s.scope === scope && s.owner === person).map((s) => this.end(s, "accessi ai siti cancellati")));
			const clear = async () => { await this.accounts?.profiles?.clear(scope, person); };
			const cleared = p === undefined ? clear() : p.queue.catch(() => {}).then(clear);
			if (p !== undefined) p.queue = cleared;
			await cleared;
			if (this.profiles.get(key) === pending) this.profiles.delete(key);
			this.uncleared.delete(key);
		})();
		this.clearing.set(key, run);
		void run.finally(() => { if (this.clearing.get(key) === run) this.clearing.delete(key); }).catch(() => {});
		return run;
	}

	private current(s: Session): boolean {
		return this.sessions.get(s.key) === s && (s.profile === undefined || s.profile.active);
	}

	private async allowed(s: Session, starting = false): Promise<boolean> {
		const current = () => (starting ? !this.sessions.has(s.key) : this.sessions.get(s.key) === s) && (s.profile === undefined || s.profile.active);
		if (!current()) return false;
		const owner = s.owner === undefined || await this.owner(s.scope, s.thread) === s.owner;
		return owner && current();
	}

	private async revoke(s: Session): Promise<void> {
		// A delayed operation on a detached session must not clear its replacement's profile.
		if (this.sessions.get(s.key) !== s) return;
		if (s.owner !== undefined) await this.clearProfile(s.scope, s.owner);
		else await this.end(s, "accesso revocato");
	}

	private redactView(s: Session, view: View): View {
		const clean = (text: string) => s.person.redact(text);
		return { ...view, url: clean(view.url), title: clean(view.title), text: clean(view.text), notes: view.notes.map(clean), details: view.details.map(clean), elements: view.elements.map((e) => ({ ...e, label: clean(e.label), ...(e.value === undefined ? {} : { value: clean(e.value) }), ...(e.href === undefined ? {} : { href: clean(e.href) }) })) };
	}

	has(key: string): boolean {
		return this.sessions.has(key);
	}

	/** Where the conversation's browser is, as of its last action: no question to Chromium, so it is cheap to ask often. */
	state(key: string): BrowserState {
		const s = this.sessions.get(key);
		if (s === undefined) {
			const closed = this.closed.get(key)?.why;
			return closed === undefined ? { open: false } : { open: false, closed };
		}
		return { open: true, ...s.shown, version: s.version, busy: s.busy, control: s.person.control, profile: s.profile !== undefined };
	}

	/**
	 * What is on screen, for someone watching: taken between actions, and taken again only after
	 * one. It changes nothing on the page, so the numbers of the agente's last view stay valid.
	 */
	async picture(key: string): Promise<{ readonly png: Uint8Array; readonly version: number } | undefined> {
		const s = this.sessions.get(key);
		if (s === undefined) return Promise.resolve(undefined);
		if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); return undefined; }
		// Never ahead of the agente: while it acts, the last picture is what there is.
		if (s.picture?.version === s.version || s.busy) return Promise.resolve(s.picture);
		const run = s.queue
			.catch(() => {})
			.then(async () => {
				if (this.sessions.get(key) !== s) return undefined;
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); return undefined; }
				if (s.picture?.version === s.version) return s.picture;
				const version = s.version;
				// Busy, so the idle timer and the room for other conversations leave this session alone meanwhile.
				s.busy = true;
				const png = await within(s.page.screenshot({ fullPage: false, type: "png", timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 1_000)
					.catch(() => undefined)
					.finally(() => {
						s.busy = false;
					});
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); return undefined; }
				if (png === undefined) return s.picture;
				s.picture = { version, png };
				return s.picture;
			});
		s.queue = run;
		return run;
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((s) => this.end(s, "chiusa")));
	}

	/** Close every conversation's browser of one scope (an agente deleted, ADR 0046), and forget them. */
	async closeScope(scope: string): Promise<void> {
		const prefix = `${scope}|`;
		await Promise.allSettled([...this.starting].filter(([key]) => key.startsWith(prefix)).map(([, starting]) => starting));
		for (const key of [...this.profiles.keys()]) if (key.startsWith(`${scope}\0`)) await this.clearProfile(scope, key.slice(scope.length + 1));
		await Promise.all([...this.sessions.values()].filter((s) => s.key.startsWith(prefix)).map((s) => this.end(s, "chiusa")));
		for (const key of [...this.closed.keys()]) if (key.startsWith(prefix)) this.closed.delete(key);
	}

	/** Closes this session, and only it: a newer one of the same conversation stays. */
	private async end(s: Session, reason: string): Promise<void> {
		s.person.privateEdit?.acknowledge(false);
		if (this.sessions.get(s.key) === s) {
			this.sessions.delete(s.key);
			// The late choosers not yet told go with the closure: the agente hears them in its next answer.
			this.closed.set(s.key, { why: reason, choosers: s.choosers });
			if (this.closed.size > 500) this.closed.delete(this.closed.keys().next().value as string);
		}
		clearTimeout(s.timer);
		await s.context.close().catch(() => {});
		await this.save(s);
	}

	/** The element `ref` of the last view, checked on the page as it is now: one element, the same kind. */
	private async target(s: Session, ref: number): Promise<{ selector: string; live: { tag: string; type: string } }> {
		if (s.person.movedByPerson) throw new BrowseError("chi ti scrive ha aperto un'altra pagina nel browser: guardala di nuovo con web_browse senza url");
		const known = s.elements.get(ref);
		if (known === undefined || s.attr === undefined) throw new BrowseError(`nella pagina non c'è l'elemento ${ref}: usa i numeri dell'ultima vista`);
		const selector = `[${s.attr}="${ref}"]`;
		const live = await within(
			s.page.evaluate<unknown>(`(() => { ${DEEP} const all = deep(${JSON.stringify(selector)}); if (all.length !== 1 || all.over) return null; return { tag: all[0].tagName.toLowerCase(), type: String(all[0].getAttribute("type") || "").toLowerCase().slice(0, 20) }; })()`),
			READ_TIMEOUT_MS,
		);
		const found = live !== null && typeof live === "object" ? (live as { tag?: unknown; type?: unknown }) : undefined;
		if (found === undefined || found.tag !== known.tag || found.type !== known.type) throw new BrowseError("la pagina è cambiata dall'ultima vista: guardala di nuovo con web_browse senza url");
		return { selector, live: { tag: known.tag, type: known.type } };
	}

	private async start(key: string, browser: Browser, guard: Guard): Promise<void> {
		// Room for one more: the idle session unused the longest closes. Busy ones are never cut.
		// The new session counts too; other conversations still starting already hold their place.
		const others = () => [...this.starting.keys()].filter((k) => k !== key).length;
		while (this.sessions.size + others() >= this.limits.max) {
			const oldest = [...this.sessions.values()].filter((s) => !s.busy && s.person.control !== "person").sort((a, b) => a.used - b.used)[0];
			if (oldest === undefined) throw new BrowseError("su questo server ci sono già troppi browser al lavoro: riprova tra poco", "busy");
			await this.end(oldest, "chiusa per fare posto a un'altra conversazione");
		}
		const context = await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT, acceptDownloads: false, serviceWorkers: "block" });
		const traffic: Traffic = { sends: new Set(), hosts: new Set(), files: new Set(), overBudget: false, inflight: 0 };
		const budget = { ...PAGE_BUDGET };
		const current = { current: guard };
		const flag = `__owni${randomBytes(6).toString("hex")}`;
		const split = key.indexOf("|");
		const scope = split < 0 ? "" : key.slice(0, split);
		const address = key.slice(split + 1);
		const colon = address.indexOf(":");
		const thread = { channel: address.slice(0, colon), threadId: address.slice(colon + 1) };
		const owner = await this.owner(scope, thread);
		let session: Session | undefined;
		const person = new PersonControl(() => session!.page, () => this.end(session!, "chiusa per proteggere i dati privati"));
		try {
			const profile = owner === undefined || this.accounts?.profiles === undefined ? undefined : await this.sharedProfile(scope, owner);
			await guardContext(context, () => current.current, budget, traffic, profile?.jar ?? new CookieJar(), {
				allowed: async () => session !== undefined && await this.allowed(session),
				current: () => session !== undefined && this.current(session),
				page: () => session?.page,
				human: () => person.control === "person" && person.humanAction,
				retain: async () => { await person.retain(); },
				submitted: (host) => { if (session?.owner !== undefined) this.accounts?.submitted?.(key, session.owner, host); },
				redact: (text) => session === undefined ? text : person.redact(text),
			});
			await context.exposeBinding?.(person.privateBinding, async (source, document, edit, value) => {
				const s = session;
				if (s === undefined || !this.current(s)) return false;
				return person.received(source, document, edit, value);
			});
			await context.addInitScript(initScript(flag, person.humanFlag, person.privateAttr, person.privateBinding));
			const page = await context.newPage();
			// Any other window (one the page opens anyway) is closed: everything happens in one page.
			context.on("page", (other) => {
				if (other !== page) void other.close().catch(() => {});
			});
			session = { key, scope, thread, owner, profile, person, context, page, flag, traffic, budget, guard: current, attr: undefined, elements: new Map(), timer: undefined, used: Date.now(), busy: false, queue: Promise.resolve(), version: 0, picture: undefined, shown: { url: "about:blank", title: "" }, choosers: this.closed.get(key)?.choosers ?? [] };
			const started = session;
			if (!(await this.allowed(started, true)) || (profile !== undefined && !profile.active)) throw new BrowseError("accesso al browser revocato", "denied");
			// Owni uploads no files (ADR 0103): the chooser itself is the one place where it is refused.
			// The audit hears of the first one per site of this browser: a page that retries in a loop is one line, not thousands.
			const told = new Set<string>();
			page.on("filechooser", () => {
				// Three at most, the last always the newest: with the one an action starts from (below) that is enough to tell its own from a late one.
				if (started.choosers.length < 3) started.choosers.push(Date.now());
				else started.choosers[2] = Date.now();
				const host = new URL(page.url()).hostname;
				if (told.has(host)) return;
				told.add(host);
				this.refused(key, host);
			});
			this.sessions.set(key, session);
			this.closed.delete(key);
		} catch (error) {
			await context.close().catch(() => {});
			throw error;
		}
	}

	/**
	 * One action at a time per session; then the page as it is after it. A `gesture` (a click, a typing)
	 * that opens a file chooser is refused as a whole; a chooser the page opens on its own is a note.
	 */
	private act(key: string, guard: Guard, options: ViewOptions, gesture: boolean, action: (s: Session) => Promise<unknown>): Promise<View> {
		const s = this.sessions.get(key);
		if (s === undefined) {
			const why = this.closed.get(key)?.why;
			return Promise.reject(new BrowseError(why === undefined ? "nessuna pagina aperta in questa conversazione: aprila con web_browse" : `la pagina di questa conversazione è stata ${why}: riaprila con web_browse${this.unheard(key, options)}`, why === undefined ? "no-page" : undefined));
		}
		const run = s.queue
			.catch(() => {})
			.then(async () => {
				if (this.sessions.get(key) !== s) throw new BrowseError(`la pagina di questa conversazione è stata chiusa: riaprila con web_browse${this.unheard(key, options)}`);
				if (options.person !== true && s.person.control === "person") throw new BrowseError("la persona sta usando il browser: attendi che restituisca il controllo", "held");
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); throw new BrowseError("accesso al browser revocato", "denied"); }
				s.guard.current = guard;
				s.busy = true;
				// A person drives the page: the agente's numbers point elsewhere from now, however the action ends.
				if (options.person === true) s.person.movedByPerson = true;
				// Idle counts from the end of the last action, never during one.
				clearTimeout(s.timer);
				let result: View;
				try {
					await s.person.begin(options.person === true);
					if (options.person === true) await s.person.capture();
					if (!this.current(s)) throw new BrowseError("accesso al browser revocato", "denied");
					let failure: string | undefined;
					// The ones before the action are all late: one says it.
					s.choosers = s.choosers.slice(0, 1);
					const started = Date.now();
					try {
						await action(s);
					} catch (error) {
						if (error instanceof BrowseError || error instanceof Hung) throw error;
						failure = s.person.humanAction ? "Operazione non riuscita" : plainError(s.person.redact(error instanceof Error ? error.message : String(error)));
						// A browser that went away (a restart of Chromium) leaves nothing to look at.
						if (/closed|disconnected|Target page/i.test(failure)) {
							await this.end(s, "chiusa perché il browser si è fermato");
							throw new BrowseError(`il browser si è chiuso: riapri la pagina con web_browse${this.unheard(key, options)}`);
						}
					} finally {
						if (options.person === true && this.current(s)) await s.person.capture();
					}
					const own = Date.now() + OWN_CHOOSER_MS;
					await this.settle(s);
					// A gesture's own chooser is known only once its time has passed.
					if (gesture && Date.now() < own) await new Promise((resolve) => setTimeout(resolve, own - Date.now()));
					const mine = (t: number) => t >= started && t <= own;
					if (gesture && s.choosers.some(mine)) {
						// Only its own: one the page opened earlier is still the agente's to hear.
						s.choosers = s.choosers.filter((t) => !mine(t));
						// The agente's numbers stay those of its last view; what someone watching reads is the page now.
						await this.remember(s);
						throw new BrowseError(NO_FILES, "no-files");
					}
					if (!(await this.allowed(s))) { await this.revoke(s); throw new BrowseError("accesso al browser revocato", "denied"); }
					const view = s.person.control === "person" && options.person === true
						? { ...await this.remember(s), text: "", elements: [], notes: [], details: [], ...(failure === undefined ? {} : { failed: true as const }) }
						: this.redactView(s, await this.snapshot(s, failure, options));
					// Read after the whole view, screenshot included: one opened meanwhile is told now, not lost.
					// Only the agente's view uses it up: the panel shows a person the page, not the notes.
					const late = s.choosers.length > 0;
					if (options.person !== true) s.choosers = [];
					result = late ? { ...view, notes: [...view.notes, LATE_CHOOSER] } : view;
				} catch (error) {
					if (!(error instanceof Hung)) throw error;
					await this.end(s, "chiusa perché non rispondeva");
					throw new BrowseError(`la pagina non risponde ed è stata chiusa: riaprila con web_browse, o leggila con web_read${this.unheard(key, options)}`);
				} finally {
					await s.person.finish(s.owner !== undefined);
					s.busy = false;
					s.version += 1;
					s.used = Date.now();
					if (this.sessions.get(key) === s) {
						s.timer = setTimeout(() => void this.end(s, "chiusa dopo qualche minuto senza azioni").catch(() => console.error("owni: browser profile could not be saved")), this.limits.idleMs);
						s.timer.unref();
						await this.save(s);
					}
				}
				if (!(await this.allowed(s)) || !this.current(s)) { await this.revoke(s); throw new BrowseError("accesso al browser revocato", "denied"); }
				return result;
			});
		s.queue = run;
		return run;
	}

	/** The late choosers of a conversation whose browser closed, told once, in an answer to the agente. */
	private unheard(key: string, options: ViewOptions): string {
		const closed = this.closed.get(key);
		if (options.person === true || closed === undefined || closed.choosers.length === 0) return "";
		closed.choosers = [];
		return `. ${LATE_CHOOSER}`;
	}

	/** The page loaded, and its requests ended (content that arrives after the load). */
	private async settle(s: Session): Promise<void> {
		await s.page.waitForLoadState("load", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
		const until = Date.now() + SETTLE_MS;
		for (let quiet = 0; quiet < 3 && Date.now() < until; ) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			quiet = s.traffic.inflight === 0 ? quiet + 1 : 0;
		}
	}

	/** Where the page is now, for someone watching (`state`). */
	private async remember(s: Session): Promise<{ readonly url: string; readonly title: string }> {
		const title = await within(s.page.title(), READ_TIMEOUT_MS).catch((error: unknown) => {
			if (error instanceof Hung) throw error;
			return "";
		});
		s.shown = { url: s.person.redact(s.page.url()).slice(0, 500), title: s.person.redact(String(title)).slice(0, 200) };
		return s.shown;
	}

	private async snapshot(s: Session, failure: string | undefined, options: ViewOptions): Promise<View> {
		const attr = `data-owni-${randomBytes(4).toString("hex")}`;
		const forms = s.person.forms();
		const padding = Math.max(0, ...forms.map((form) => form.length));
		const clean = (text: string, limit: number) => privateSlice(text, forms, 0, limit).slice(0, limit);
		const read = () => within(s.page.evaluate<Raw>(snapshotScript(attr, s.attr, s.flag, options, padding)), READ_TIMEOUT_MS);
		// In the middle of a navigation the page has no document yet: once more, a moment later.
		const rawOrNot = await read().catch(async (error: unknown) => {
			if (error instanceof Hung) throw error;
			await new Promise((resolve) => setTimeout(resolve, 500));
			return read().catch((again: unknown) => {
				if (again instanceof Hung) throw again;
				return undefined;
			});
		});
		const raw: Raw | undefined = rawOrNot !== null && typeof rawOrNot === "object" ? rawOrNot : undefined;
		s.attr = attr;
		const elements = cleanElements(raw?.elements, clean);
		s.elements = new Map(elements.map((e) => [e.ref, e]));
		const from = Math.max(0, Math.floor(options.from ?? 0));
		const offset = from - Math.max(0, from - padding);
		const text = typeof raw?.text === "string" ? privateSlice(raw.text, forms, offset, offset + VIEW_TEXT).slice(0, VIEW_TEXT) : "";
		const length = typeof raw?.textLength === "number" ? raw.textLength : from + text.length;
		const next = Math.min(length, from + VIEW_TEXT);
		const more = typeof raw?.more === "number" ? raw.more : 0;
		const frames = Array.isArray(raw?.frames) ? raw.frames.filter((f): f is string => typeof f === "string").map((f) => clean(f, 200)).slice(0, 5) : [];
		const t = s.traffic;
		const notes: string[] = [];
		const details: string[] = [];
		if (raw === undefined) notes.push("La pagina sta ancora caricando: guardala di nuovo con web_browse senza url.");
		if (failure !== undefined) {
			notes.push("L'azione non è riuscita.");
			details.push(`Errore del browser: ${failure}`);
		}
		if (t.sends.size > 0 || Number(raw?.blockedForms) > 0) {
			notes.push("La pagina ha provato a inviare dati: bloccato, non è partito niente. Il browser legge soltanto; per inviare un modulo si apre la pagina con web_read e si usa web_submit, che chiede l'approvazione.");
			if (t.sends.size > 0) details.push(`Invii bloccati: ${[...t.sends].join(", ")}`);
		} else if (Number(raw?.postForms) > 0) notes.push("Questa pagina ha moduli che inviano dati: il browser non li invia. Per inviarne uno si apre la pagina con web_read e si usa web_submit, che chiede l'approvazione.");
		if (t.files.size > 0) {
			notes.push("Un link porta a un file, non a una pagina: il browser non lo apre. Se è un PDF o un documento, leggilo con web_read passando il suo indirizzo (in «File» qui sotto), o salvalo con web_download.");
			details.push(`File: ${[...t.files].join("; ")}`);
		}
		if (t.hosts.size > 0) details.push(`Bloccato quello che la pagina voleva caricare da siti non consentiti: ${[...t.hosts].join(", ")}`);
		if (t.overBudget) notes.push("La pagina ha caricato troppo: il resto è bloccato. Riaprirla con web_browse e l'url dà un nuovo margine.");
		if (more > 0 || raw?.scannedAll === false) details.push(`Altri ${more > 0 ? more : "molti"} elementi non elencati: web_browse con find e una parola li cerca.`);
		if (frames.length > 0) details.push(`Riquadri con altre pagine dentro (si aprono con web_browse): ${frames.join(", ")}`);
		if (length > next) details.push(`[testo da ${from} a ${next} di ${length} caratteri: web_browse con from=${next} per il resto]`);
		t.sends.clear();
		t.hosts.clear();
		t.files.clear();
		t.overBudget = false;
		// Pixels cannot use text redaction: private input may be echoed anywhere, even after navigation.
		// The owner's separate picture() path remains available in their browser panel.
		const privateScreenshot = options.screenshot === true && options.person !== true && s.person.privateValues.size > 0;
		if (privateScreenshot) notes.push("Screenshot non disponibile per proteggere i dati privati inseriti in questo browser. Usa la vista testuale con i dati privati oscurati.");
		const screenshot = options.screenshot === true && !privateScreenshot ? await within(s.page.screenshot({ fullPage: false, type: "png", timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 1_000) : undefined;
		const { url, title } = await this.remember(s);
		// The agente reads this view: its numbers are these now.
		if (options.person !== true) s.person.movedByPerson = false;
		return { url, title, text, elements, notes, details, ...(screenshot === undefined ? {} : { screenshot }), ...(failure === undefined ? {} : { failed: true as const }) };
	}
}

/** A view as Owni reads it: what the page chose goes in the fence, our sentences outside. */
export function describeView(view: View, fence: (text: string) => string): string {
	const list = view.elements.map((e) => `[${e.ref}] ${e.kind}${e.label ? `: ${e.label}` : ""}${e.href ? ` → ${e.href}` : ""}${e.value ? ` (ora: «${e.value}»)` : ""}`).join("\n");
	const body = fence([`URL: ${view.url}${view.title ? `\nTitolo: ${view.title}` : ""}`, view.text, list ? `Elementi (web_click, web_type con il numero):\n${list}` : "", view.details.join("\n")].filter(Boolean).join("\n\n"));
	return [...view.notes, body].join("\n");
}

/** The browser of a conversation; there is none outside one. */
export function sessionKey(scope: string, thread: { readonly channel: string; readonly threadId: string }): string {
	return `${scope}|${thread.channel}:${thread.threadId}`;
}
