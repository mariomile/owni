import { beforeEach, describe, expect, it, vi } from "vitest";

type TestNode = {
	tag: string;
	attrs: Record<string, unknown>;
	children: (TestNode | string)[];
	textContent: string;
	isConnected: boolean;
	dataset: Record<string, string>;
	querySelector(): null;
	querySelectorAll(): TestNode[];
	prepend(node: TestNode): void;
	append(node: TestNode): void;
};

const mocks = vi.hoisted(() => {
	const text = (node: TestNode | string): string => typeof node === "string" ? node : node.children.map(text).join(" ");
	const h = (spec: string, attrs?: unknown, ...children: unknown[]): TestNode => {
		const attributes = attrs && typeof attrs === "object" && !Array.isArray(attrs) && !("tag" in attrs) ? attrs as Record<string, unknown> : {};
		if (attributes !== attrs) children.unshift(attrs);
		return {
			tag: spec,
			attrs: { ...attributes },
			children: children.flat(Infinity).filter((child) => child != null && child !== false).map((child) => typeof child === "object" ? child as TestNode : String(child)),
			get textContent() { return text(this); },
			isConnected: true,
			dataset: {},
			querySelector: () => null,
			querySelectorAll: () => [],
			prepend(node) { this.children.unshift(node); },
			append(node) { this.children.push(node); },
		};
	};
	const mount = (node: TestNode, ...children: unknown[]) => { node.children = children.flat(Infinity).filter((child) => child != null && child !== false) as (TestNode | string)[]; };
	const state = { me: { id: "person", role: "owner" }, pendingApprovals: 0, boardReview: 0 };
	return {
		common: {
			h, mount, state, api: vi.fn(), toast: vi.fn(), icon: (name: string) => h("svg", name), fmt: { time: (at: string) => `alle ${at.slice(11, 16)}` },
			route: () => ({ view: "approvazioni", rest: [] }), instanceHref: (view: string) => `#/${view}`,
			emptyNote: (spec: string, title: string, ...children: unknown[]) => h(spec, h("b", title), ...children),
			head: (_: unknown, title: string, description: string) => h("header", h("h1", title), description),
		},
		renderRail: vi.fn(),
	};
});
vi.mock("../src/web/ui/common.js", () => mocks.common);
vi.mock("../src/web/ui/cards.js", () => ({ askedByNote: vi.fn(), connectorActionCard: vi.fn(), decideWith: vi.fn(), decisionCard: (el: unknown) => el, googleActionCard: vi.fn() }));
vi.mock("../src/web/ui/session.js", () => ({ refreshCounters: vi.fn(async () => {}) }));
vi.mock("../src/web/ui/shell.js", () => ({ render: vi.fn(), renderRail: mocks.renderRail }));

// @ts-expect-error Console modules intentionally use plain JavaScript.
import { needsBoardReview, reviewRows, viewApprovals } from "../src/web/ui/pages/approvals.js";

const at = "2026-10-25T09:00:00.000Z";
const viewer = { id: "person", role: "owner" };
const card = (id: string, status: string, extra = {}) => ({ id, n: Number(id), title: `Lavoro ${id}`, status, assignee: "sales", updatedAt: at, events: [], ...extra });
const agents = [{ id: "sales", name: "Vendite" }];
const flatten = (node: TestNode): TestNode[] => [node, ...node.children.flatMap((child) => typeof child === "string" ? [] : flatten(child))];

beforeEach(() => {
	mocks.common.api.mockReset();
	mocks.common.state.me = viewer;
	mocks.common.state.boardReview = 0;
});

describe("Richiede te", () => {
	it("gives a review to the person who worked with the agente, and to the owner only when nobody did", () => {
		const worked = card("1", "da_rivedere", { work: { agent: "sales", personId: "other", threadId: "private" } });
		expect(needsBoardReview(worked, viewer)).toBe(false);
		expect(needsBoardReview(worked, { id: "other", role: "member" })).toBe(true);
		expect(needsBoardReview(card("2", "da_rivedere"), viewer)).toBe(true);
		expect(needsBoardReview(card("2", "da_rivedere"), { id: "member", role: "member" })).toBe(false);
		expect(needsBoardReview({ ...worked, assignee: "another-agent" }, viewer)).toBe(true);
		expect(needsBoardReview({ ...worked, status: "fatto" }, viewer)).toBe(false);
	});

	it("shows each incarico to review with the latest result the agente left and a way to review it", () => {
		const reviewed = card("3", "da_rivedere", { events: [{ kind: "status", status: "da_rivedere" }, { kind: "comment", by: { kind: "agent" }, text: "Vecchio risultato" }, { kind: "status", status: "in_corso" }, { kind: "status", status: "da_rivedere" }, { kind: "comment", by: { kind: "agent" }, text: "Risultato  aggiornato" }] });
		const rows = reviewRows({ agents, cards: [card("1", "in_corso"), reviewed, card("4", "da_rivedere", { updatedAt: "2026-10-25T08:00:00.000Z" })] }, viewer);
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain("#3 Lavoro 3");
		expect(rows[0].textContent).toContain("Vendite · Da rivedere");
		expect(rows[0].textContent).toContain("Risultato aggiornato");
		expect(rows[0].textContent).not.toContain("Vecchio risultato");
		expect(flatten(rows[0]).find((node) => node.tag.startsWith("a.btn"))?.attrs.href).toBe("#/board/3");
		expect(rows[1].textContent).toContain("senza un commento");
	});

	it("puts decisions and reviews on one page and counts them for the sidebar", async () => {
		mocks.common.api.mockImplementation(async (url: string) => url === "/api/approvals"
			? { groups: [{ instance: { id: "sales", name: "Vendite" }, proposals: [], webActions: [], connectorActions: [], googleActions: [] }], pendingApprovals: 0 }
			: { agents, cards: [card("5", "da_rivedere")] });
		const main = mocks.common.h("main");
		await viewApprovals(main);
		expect(main.textContent).toContain("Richiede te");
		expect(main.textContent).toContain("Da rivedere");
		expect(main.textContent).not.toContain("Da decidere");
		expect(main.textContent).toContain("#5 Lavoro 5");
		expect(mocks.common.state.boardReview).toBe(1);
		expect(mocks.renderRail).toHaveBeenCalled();
	});

	it("says when there is nothing, and keeps the decisions when the incarichi cannot load", async () => {
		const empty = { groups: [], pendingApprovals: 0 };
		mocks.common.api.mockImplementation(async (url: string) => url === "/api/approvals" ? empty : { agents, cards: [] });
		const main = mocks.common.h("main");
		await viewApprovals(main);
		expect(main.textContent).toContain("Niente richiede te");
		mocks.common.state.boardReview = 2;
		mocks.common.api.mockImplementation(async (url: string) => { if (url === "/api/approvals") return empty; throw new Error("Board offline"); });
		await viewApprovals(main);
		expect(main.textContent).toContain("Gli incarichi da rivedere non sono disponibili: Board offline");
		expect(mocks.common.state.boardReview).toBe(2);
	});
});
