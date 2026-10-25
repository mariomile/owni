import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Plain nodes exercise the page's own navigation and save handlers without a browser server. */
type PageNode = {
	tagName: string;
	className: string;
	children: (PageNode | string)[];
	parentElement?: PageNode;
	attrs: Record<string, string>;
	dataset: Record<string, string>;
	id: string;
	value: string;
	checked: boolean;
	hidden: boolean;
	open: boolean;
	scrolled: boolean;
	isConnected: boolean;
	textContent: string;
	append(...children: unknown[]): void;
	setAttribute(key: string, value: string): void;
	removeAttribute(key: string): void;
	trigger(event: string, value?: unknown): Promise<void>;
	querySelectorAll(selector: string): PageNode[];
};

const mocks = vi.hoisted(() => {
	class Node {
		tagName: string;
		className: string;
		children: (Node | string)[] = [];
		parentElement?: Node;
		attrs: Record<string, string> = {};
		dataset: Record<string, string> = {};
		id = "";
		value = "";
		checked = false;
		hidden = false;
		open = false;
		scrolled = false;
		isConnected = true;
		style = { setProperty() {} };
		classList = {
			add: (...names: string[]) => { this.className += ` ${names.join(" ")}`; },
			remove: (...names: string[]) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
		};
		listeners: Record<string, ((event: unknown) => unknown)[]> = {};
		constructor(spec: string) {
			const [tag = "div", ...classes] = spec.split(".");
			this.tagName = tag.toUpperCase();
			this.className = classes.join(" ");
		}
		get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(" "); }
		set textContent(value: string) { this.children = [String(value)]; }
		append(...children: unknown[]) {
			for (const child of children.flat(Infinity)) {
				if (child === undefined || child === null || child === false) continue;
				if (child instanceof Node) child.parentElement = this;
				this.children.push(child instanceof Node ? child : String(child));
			}
		}
		setAttribute(key: string, value: string) {
			this.attrs[key] = String(value);
			if (key === "id") this.id = value;
			if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
		}
		removeAttribute(key: string) { delete this.attrs[key]; }
		addEventListener(event: string, callback: (event: unknown) => unknown) { (this.listeners[event] ??= []).push(callback); }
		async trigger(event: string, value: unknown = {}) { for (const callback of this.listeners[event] ?? []) await callback(value); }
		querySelectorAll(selector: string): Node[] {
			return this.children.flatMap((child) => typeof child === "string" ? [] : [...(child.tagName === selector.toUpperCase() ? [child] : []), ...child.querySelectorAll(selector)]);
		}
		scrollIntoView() { this.scrolled = true; }
		focus() {}
	}
	const h = (spec: string, attrs?: unknown, ...children: unknown[]) => {
		const node = new Node(spec);
		if (attrs && typeof attrs === "object" && !Array.isArray(attrs) && !(attrs instanceof Node)) {
			for (const [key, value] of Object.entries(attrs)) {
				if (value === undefined || value === null || value === false) continue;
				if (key.startsWith("on")) node.addEventListener(key.slice(2), value as (event: unknown) => unknown);
				else if (["value", "checked", "hidden"].includes(key)) Object.assign(node, { [key]: value });
				else node.setAttribute(key, String(value));
			}
		} else children.unshift(attrs);
		node.append(children);
		if (node.tagName === "SELECT") {
			const options = node.querySelectorAll("option");
			node.value = (options.find((option) => "selected" in option.attrs) ?? options[0])?.value ?? "";
		}
		return node;
	};
	const mount = (node: Node, ...children: unknown[]) => { node.children = []; node.append(children); };
	const instance = { id: "second", name: "Assistente", canChat: true, hasSegreteria: false };
	return {
		h, mount,
		api: vi.fn(),
		state: { me: { id: "owner", role: "owner" }, instance, instances: [instance] },
		requested: "",
		frames: [] as (() => void)[],
		route: () => ({ view: "impostazioni", rest: mocks.requested ? [mocks.requested] : [] }),
		instanceHref: (view: string, rest: string[] = [], instanceId: string = mocks.state.instance.id) => `#/${[view, ...rest].map(encodeURIComponent).join("/")}?agent=${encodeURIComponent(instanceId)}`,
		needInstance: () => false,
		agentLabel: (agent: { name: string }) => agent.name,
		head: (_parent: unknown, ...children: unknown[]) => h("div.head", children),
		emptyNote: (spec: string, ...children: unknown[]) => h(spec, children),
		face: () => h("svg.face"),
		faceColor: () => "#000",
		icon: () => h("svg.icon"),
		toast: vi.fn(), store: vi.fn(), go: vi.fn(), confirmDialog: vi.fn(), replaceState: vi.fn(),
	};
});

vi.mock("../src/web/ui/common.js", () => mocks);
vi.mock("../src/web/ui/shell.js", () => ({ render: vi.fn() }));
vi.mock("../src/web/ui/session.js", () => ({ refreshInstances: vi.fn(), refreshSetup: vi.fn(), setupHidden: vi.fn() }));
vi.mock("../src/web/ui/listen.js", () => ({ copyBox: () => mocks.h("div"), copyButton: () => mocks.h("button") }));
vi.mock("../src/web/ui/models.js", () => ({ chatModelCache: { clear: vi.fn() }, modelFacts: () => "", subscriptionState: () => ({ label: "Pronto" }) }));

// @ts-expect-error Browser pages intentionally use plain JavaScript.
const { viewSettings } = await import("../src/web/ui/pages/settings.js") as { viewSettings(main: PageNode): Promise<void> };
// @ts-expect-error Browser pages intentionally use plain JavaScript.
const { viewAgentProfile } = await import("../src/web/ui/pages/agent-profile.js") as { viewAgentProfile(main: PageNode): Promise<void> };
// @ts-expect-error Browser pages intentionally use plain JavaScript.
const { viewAgents } = await import("../src/web/ui/pages/agents.js") as { viewAgents(main: PageNode): Promise<void> };

const nodes = (node: PageNode): PageNode[] => [node, ...node.children.flatMap((child) => typeof child === "string" ? [] : nodes(child))];
const byId = (node: PageNode, id: string) => nodes(node).find((entry) => entry.id === id)!;
const visible = (node: PageNode): boolean => !node.hidden && (!node.parentElement || visible(node.parentElement));
const click = (node: PageNode) => node.trigger("click", { button: 0, preventDefault: vi.fn() });
const frames = () => { for (const frame of mocks.frames.splice(0)) frame(); };
const model = { provider: "faux", modelId: "demo", name: "Modello di prova" };
const selected = () => ({ ...mocks.state.instance, model, tone: "naturale", channels: ["web"], schedules: 1, watches: 2, memories: 4, busy: true, doing: "Report del mese", acceptsFrom: [] });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.frames = [];
	mocks.requested = "";
	mocks.state.me = { id: "owner", role: "owner" };
	mocks.state.instance = { id: "second", name: "Assistente", canChat: true, hasSegreteria: false };
	mocks.state.instances = [mocks.state.instance];
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => mocks.frames.push(callback));
	vi.stubGlobal("history", { replaceState: mocks.replaceState });
	mocks.api.mockImplementation(async (path: string, options?: { method?: string }) => {
		if (options?.method) return {};
		if (path === "/api/agents") return { agents: [{ ...selected(), id: "first", name: "Altro" }, selected()] };
		if (path.endsWith("/settings")) return { settings: { name: "Assistente", persona: {}, instructions: "Regole esistenti", allowedUsers: { web: ["member"] }, approvers: { web: ["owner"] }, egress: { channels: ["web"], connectors: [], web: [] }, model, deletable: true } };
		if (path === "/api/people") return { people: [{ id: "owner", name: "Mario", role: "owner" }, { id: "member", name: "Anna", role: "member" }] };
		if (path.endsWith("/telegram")) return { telegram: { connected: false, allowedUsers: [], approvers: [] } };
		if (path.endsWith("/whatsapp")) return { whatsapp: { connected: false, allowedUsers: [], approvers: [], webhookUrl: null } };
		if (path.endsWith("/phone")) return { phone: { connected: false, allowedUsers: [], https: false } };
		if (path.endsWith("/model")) return { model, providers: [] };
		if (path === "/api/providers") return { localEnabled: false, providers: [] };
		if (path === "/api/desktop") return { available: true, kind: "remote", shared: false, network: "none" };
		return { available: true, host: "servizio locale", maxPerDay: 10 };
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("progressive agent configuration", () => {
	it("starts with identity; switching sections preserves the same unsaved fields and never saves", async () => {
		const main = mocks.h("main");
		await viewSettings(main);
		frames();
		expect(visible(byId(main, "settings-panel-identita"))).toBe(true);
		expect(visible(byId(main, "settings-panel-modello"))).toBe(false);
		const name = nodes(main).find((node) => node.attrs["aria-label"] === "Nome")!;
		name.value = "Bozza non salvata";
		const requests = mocks.api.mock.calls.length;
		await click(byId(main, "settings-section-capacita"));
		expect(visible(byId(main, "card-siti"))).toBe(true);
		expect(visible(byId(main, "card-personalita"))).toBe(false);
		await click(byId(main, "settings-section-accessi"));
		await click(byId(main, "settings-section-identita"));
		expect(nodes(main).find((node) => node.attrs["aria-label"] === "Nome")).toBe(name);
		expect(name.value).toBe("Bozza non salvata");
		expect(mocks.api.mock.calls.length).toBe(requests);
		expect(mocks.replaceState).toHaveBeenLastCalledWith(null, "", "#/impostazioni/identita?agent=second");
	});

	it.each([
		["personalita", "identita"], ["elimina", "identita"], ["providers", "modello"], ["modello", "modello"],
		["telegram", "canali"], ["whatsapp", "canali"], ["telefono", "canali"],
		["computer-use", "capacita"], ["schermo", "capacita"], ["siti", "capacita"], ["voce", "capacita"], ["ricerca", "capacita"], ["immagini", "capacita"], ["agenti", "capacita"],
	])("opens the correct section and folded card for the existing /%s deep link", async (anchor, section) => {
		mocks.requested = anchor;
		const main = mocks.h("main");
		await viewSettings(main);
		frames();
		const card = byId(main, `card-${anchor}`);
		expect(visible(byId(main, `settings-panel-${section}`))).toBe(true);
		expect(card.scrolled).toBe(true);
		for (let parent: PageNode | undefined = card; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") expect(parent.open).toBe(true);
	});

	it("saves identity and web access together without granting chat to the owner", async () => {
		const main = mocks.h("main");
		await viewSettings(main);
		const name = nodes(main).find((node) => node.attrs["aria-label"] === "Nome")!;
		name.value = "Nuovo nome";
		const ownerChat = nodes(main).find((node) => node.attrs["aria-label"] === "Mario può scrivere")!;
		expect(ownerChat.checked).toBe(false);
		await click(byId(main, "settings-section-accessi"));
		await click(nodes(main).find((node) => node.tagName === "BUTTON" && node.textContent === "Salva identità e accessi")!);
		expect(mocks.api).toHaveBeenCalledWith("/api/instances/second/settings", { method: "PUT", body: { name: "Nuovo nome", instructions: "Regole esistenti", persona: { emoji: "", tagline: "", tone: "naturale" }, webPeople: ["member"], webApprovers: ["owner"] } });
	});

	it("never loads or exposes owner configuration for a member", async () => {
		mocks.state.me.role = "member";
		const main = mocks.h("main");
		await viewSettings(main);
		expect(mocks.api).not.toHaveBeenCalled();
		expect(main.textContent).toContain("riservata all'owner");
		expect(nodes(main).some((node) => node.tagName === "INPUT")).toBe(false);
	});
});

describe("agent profile and roster entrances", () => {
	it("uses the selected agent and retains member access to private memory, shared memory and procedures", async () => {
		mocks.state.me.role = "member";
		const main = mocks.h("main");
		await viewAgentProfile(main);
		expect(main.textContent).toContain("Assistente");
		expect(main.textContent).not.toContain("Altro");
		for (const [label, path] of [["Apri documenti", "file"], ["Apri memoria personale", "memoria"], ["Apri memoria condivisa", "memoria"], ["Apri procedure", "skill"]]) {
			expect(main.querySelectorAll("a").find((node) => node.textContent.trim() === label)?.attrs.href).toBe(`#/${path}?agent=second`);
		}
		expect(main.querySelectorAll("a").some((node) => /impostazioni|connettori/.test(node.attrs.href ?? ""))).toBe(false);
		expect(mocks.api.mock.calls.every(([, options]) => !options)).toBe(true);
	});

	it("does not offer chat to an owner lacking chat access; configuration links retain the agent", async () => {
		mocks.state.instance.canChat = false;
		const main = mocks.h("main");
		await viewAgentProfile(main);
		expect(main.querySelectorAll("a").some((node) => node.attrs.href?.startsWith("#/chat"))).toBe(false);
		expect(main.querySelectorAll("a").find((node) => node.textContent.trim() === "Persone e accessi")?.attrs.href).toBe("#/impostazioni/accessi?agent=second");
	});

	it("shows no materials or owner actions if the agent disappears from the visible roster", async () => {
		mocks.api.mockResolvedValue({ agents: [] });
		const main = mocks.h("main");
		await viewAgentProfile(main);
		expect(main.textContent).toContain("Agente non disponibile");
		expect(main.querySelectorAll("a").map((node) => node.attrs.href)).toEqual(["#/agenti"]);
	});

	it("keeps each visible agent's profile reachable without requiring chat or configuration access", async () => {
		mocks.state.me.role = "member";
		mocks.state.instance.canChat = false;
		const main = mocks.h("main");
		await viewAgents(main);
		expect(main.querySelectorAll("a").some((node) => node.attrs.href === "#/agente/second")).toBe(true);
		expect(main.querySelectorAll("a").some((node) => /impostazioni|chat/.test(node.attrs.href ?? ""))).toBe(false);
		expect(main.textContent).not.toContain("Squadre pronte");
	});
});
