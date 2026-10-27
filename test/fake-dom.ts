// A minimal DOM for console modules whose DOM builders are replaced: enough to render, read back and fire handlers.
export type FakeNode = {
	spec: string;
	attrs: Record<string, any>;
	children: (FakeNode | string)[];
	listeners: Record<string, ((event: any) => void)[]>;
	scrollTop: number;
	open: boolean;
	value: string;
	setAttribute(name: string, value: unknown): void;
	getAttribute(name: string): string | undefined;
	removeAttribute(name: string): void;
	addEventListener(type: string, handler: (event: any) => void): void;
	fire(type: string, event?: Record<string, unknown>): any;
	append(...nodes: (FakeNode | string)[]): void;
	querySelector(selector: string): FakeNode | undefined;
	showModal(): void;
	close(): void;
	remove(): void;
	focus(): void;
};

export function fakeNode(spec: string, attrs: Record<string, any> = {}, children: (FakeNode | string)[] = []): FakeNode {
	const node: FakeNode = {
		spec, attrs: {}, children, listeners: {}, scrollTop: 0, open: false, value: "",
		setAttribute(name, value) { this.attrs[name] = String(value); },
		getAttribute(name) { return this.attrs[name]; },
		removeAttribute(name) { delete this.attrs[name]; },
		addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
		fire(type, event = {}) {
			const e = { preventDefault() {}, ...event };
			for (const handler of this.listeners[type] ?? []) handler(e);
			return e;
		},
		append(...nodes) { this.children.push(...nodes); },
		querySelector(selector) {
			for (const child of this.children) {
				if (typeof child === "string") continue;
				if (selector.startsWith(".") && child.spec.split(".").slice(1).includes(selector.slice(1))) return child;
				const found = child.querySelector(selector);
				if (found) return found;
			}
		},
		showModal() { this.open = true; },
		close() { this.open = false; this.fire("close"); },
		remove() {},
		focus() {},
	};
	for (const [name, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
		else node.setAttribute(name, value === true ? "" : value);
	}
	return node;
}

const isNode = (value: unknown): value is FakeNode => typeof value === "object" && value !== null && "spec" in value;

export const fakeH = (spec: string, attrs?: unknown, ...children: unknown[]): FakeNode => {
	const plain = attrs && typeof attrs === "object" && !Array.isArray(attrs) && !isNode(attrs);
	if (!plain) children.unshift(attrs);
	return fakeNode(spec, plain ? attrs as Record<string, any> : {}, children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => isNode(c) ? c : String(c)));
};

export const fakeMount = (node: FakeNode, ...children: unknown[]) => {
	node.children = children.flat(Infinity).filter((c) => c != null && c !== false) as (FakeNode | string)[];
};

/** Every node under `node`, itself first. */
export const allNodes = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap((c) => typeof c === "string" ? [] : allNodes(c))];

/** Everything a person could read or follow in the tree: its text and its links. */
export const visible = (node: FakeNode): string => JSON.stringify(node, (key, value) => key === "listeners" ? undefined : value);
