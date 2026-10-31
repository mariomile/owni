// A minimal DOM for console modules whose DOM builders are replaced: enough to render, read back and fire handlers.
export type FakeNode = {
	spec: string;
	attrs: Record<string, any>;
	children: (FakeNode | string)[];
	parent?: FakeNode;
	listeners: Record<string, ((event: any) => void)[]>;
	scrollTop: number;
	removed: boolean;
	value: string;
	hidden: boolean;
	disabled: boolean;
	selectedOptions: { textContent: string }[];
	readonly classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
	style: Record<string, unknown> & { setProperty(name: string, value: string): void };
	open: boolean;
	readonly isConnected: boolean;
	readonly dataset: Record<string, string | undefined>;
	/** The text of every part, joined by spaces so separate parts stay readable. */
	textContent: string;
	setAttribute(name: string, value: unknown): void;
	getAttribute(name: string): string | undefined;
	removeAttribute(name: string): void;
	addEventListener(type: string, handler: (event: any) => void): void;
	fire(type: string, event?: Record<string, unknown>): any;
	append(...nodes: (FakeNode | string)[]): void;
	prepend(...nodes: (FakeNode | string)[]): void;
	matches(selector: string): boolean;
	contains(other: unknown): boolean;
	querySelector(selector: string): FakeNode | undefined;
	querySelectorAll(selector: string): FakeNode[];
	showModal(): void;
	close(): void;
	remove(): void;
	focus(): void;
	getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
};

/** `tag.class[attr]` and `[attr="value"]`, with descendants and commas: the selectors the console asks of the DOM. */
function matches(node: FakeNode, selector: string): boolean {
	return selector.split(",").some((one) => {
		const [last, ...above] = one.trim().split(/\s+/).reverse();
		if (!matchesOne(node, last!)) return false;
		let at = node.parent;
		for (const part of above) {
			while (at && !matchesOne(at, part)) at = at.parent;
			if (!at) return false;
			at = at.parent;
		}
		return true;
	});
}

function matchesOne(node: FakeNode, one: string): boolean {
	const parts = one.match(/^([a-z][a-z0-9-]*)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
	if (!parts) throw new Error(`fake-dom does not understand the selector «${one}»`);
	const [tag, ...classes] = node.spec.split(".");
	classes.push(...String(node.attrs.class ?? "").split(" ").filter(Boolean));
	if (parts[1] && parts[1] !== (tag || "div")) return false;
	if (parts[2] && !parts[2].slice(1).split(".").every((c) => classes.includes(c))) return false;
	for (const [, name, value] of (parts[3] ?? "").matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
		if (!(name! in node.attrs) || (value !== undefined && node.attrs[name!] !== value)) return false;
	}
	return true;
}

const dataName = (key: string) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const text = (node: FakeNode | string): string => typeof node === "string" ? node : node.children.map(text).join(" ");

/** Children take `parent` as their parent; the link is not enumerable, so a tree still serializes. */
function adopt(parent: FakeNode, nodes: (FakeNode | string)[]) {
	for (const child of nodes) if (typeof child !== "string") Object.defineProperty(child, "parent", { value: parent, configurable: true, writable: true, enumerable: false });
	return nodes;
}

export function fakeNode(spec: string, attrs: Record<string, any> = {}, children: (FakeNode | string)[] = []): FakeNode {
	const node: FakeNode = {
		spec, attrs: {}, children: [], listeners: {}, scrollTop: 0, removed: false, value: "", hidden: false, disabled: false, selectedOptions: [],
		style: { setProperty() {} },
		get open() { return "open" in this.attrs; },
		set open(value) { if (value) this.attrs.open = ""; else delete this.attrs.open; },
		get isConnected() { return !this.removed && (this.parent?.isConnected ?? true); },
		get textContent() { return text(this); },
		get classList() {
			const names = () => String(this.attrs.class ?? "").split(" ").filter(Boolean);
			return {
				add: (name: string) => { if (!names().includes(name)) this.attrs.class = [...names(), name].join(" "); },
				remove: (name: string) => { this.attrs.class = names().filter((n) => n !== name).join(" "); },
				contains: (name: string) => names().includes(name),
			};
		},
		set textContent(value) { this.children = [String(value)]; },
		dataset: new Proxy({} as Record<string, string | undefined>, {
			get: (_, key) => typeof key === "string" ? node.attrs[dataName(key)] : undefined,
			set: (_, key, value) => { node.attrs[dataName(String(key))] = String(value); return true; },
		}),
		setAttribute(name, value) { this.attrs[name] = String(value); },
		getAttribute(name) { return this.attrs[name]; },
		removeAttribute(name) { delete this.attrs[name]; },
		addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
		fire(type, event = {}) {
			const e = { preventDefault() {}, ...event };
			for (const handler of this.listeners[type] ?? []) handler(e);
			return e;
		},
		append(...nodes) { this.children.push(...adopt(this, nodes)); },
		prepend(...nodes) { this.children.unshift(...adopt(this, nodes)); },
		matches(selector) { return matches(this, selector); },
		contains(other) { return allNodes(this).includes(other as FakeNode); },
		querySelector(selector) { return this.querySelectorAll(selector)[0]; },
		querySelectorAll(selector) { return allNodes(this).slice(1).filter((n) => n.matches(selector)); },
		showModal() { this.attrs.open = ""; },
		close() {
			if (!this.open) return;
			delete this.attrs.open;
			this.fire("close");
		},
		remove() {
			this.removed = true;
			if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
			this.parent = undefined;
		},
		focus() {},
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
	};
	node.append(...children);
	for (const [name, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
		else node.setAttribute(name, value === true ? "" : value);
	}
	node.value = String(node.attrs.value ?? "");
	node.hidden = "hidden" in node.attrs;
	node.disabled = "disabled" in node.attrs;
	return node;
}

const isNode = (value: unknown): value is FakeNode => typeof value === "object" && value !== null && "spec" in value;

export const fakeH = (spec: string, attrs?: unknown, ...children: unknown[]): FakeNode => {
	const plain = attrs && typeof attrs === "object" && !Array.isArray(attrs) && !isNode(attrs);
	if (!plain) children.unshift(attrs);
	return fakeNode(spec, plain ? attrs as Record<string, any> : {}, children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => isNode(c) ? c : String(c)));
};

export const fakeMount = (node: FakeNode, ...children: unknown[]) => {
	node.children = [];
	node.append(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => isNode(c) ? c : String(c)));
};

/** A document whose body holds what the console appends: dialogs, menus. */
export function fakeDocument(extra: Record<string, unknown> = {}) {
	const body = fakeNode("body");
	return {
		body,
		getElementById: (id: string) => body.querySelectorAll(`[id="${id}"]`)[0] ?? null,
		querySelector: (selector: string) => body.querySelector(selector) ?? null,
		querySelectorAll: (selector: string) => body.querySelectorAll(selector),
		addEventListener() {},
		removeEventListener() {},
		documentElement: { dataset: {} },
		visibilityState: "visible",
		...extra,
	};
}

/** Every node under `node`, itself first. */
export const allNodes = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap((c) => typeof c === "string" ? [] : allNodes(c))];

/** Everything a person could read or follow in the tree: its text and its links. */
export const visible = (node: FakeNode): string => JSON.stringify(node, (key, value) => key === "listeners" || key === "dataset" ? undefined : value);
