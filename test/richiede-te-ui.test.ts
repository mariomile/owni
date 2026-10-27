import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, fakeNode, type FakeNode } from "./fake-dom.ts";
import { deferred, fakeFetch } from "./fake-fetch.ts";

const mocks = vi.hoisted(() => ({ server: vi.fn(), toast: vi.fn(), renderRail: vi.fn() }));
vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH, fakeMount } = await import("./fake-dom.ts");
	const real = await vi.importActual<Record<string, unknown>>("../src/web/ui/common.js");
	return {
		...real, h: fakeH, mount: fakeMount, toast: mocks.toast, icon: (name: string) => fakeH("svg", name), fmt: { time: (at: string) => `alle ${at.slice(11, 16)}` },
		route: () => ({ view: "approvazioni", rest: [] }), instanceHref: (view: string) => `#/${view}`,
		emptyNote: (spec: string, title: string, ...children: unknown[]) => fakeH(spec, fakeH("b", title), ...children),
		head: (_: unknown, title: string, description: string) => fakeH("header", fakeH("h1", title), description),
	};
});
vi.mock("../src/web/ui/cards.js", () => ({ askedByNote: vi.fn(), connectorActionCard: vi.fn(), decideWith: vi.fn(), decisionCard: (el: unknown) => el, googleActionCard: vi.fn() }));
vi.mock("../src/web/ui/session.js", () => ({ refreshCounters: vi.fn(async () => {}) }));
vi.mock("../src/web/ui/shell.js", () => ({ render: vi.fn(), renderRail: mocks.renderRail }));

const at = "2026-10-25T09:00:00.000Z";
const viewer = { id: "person", role: "owner" };
const card = (id: string, status: string, extra = {}) => ({ id, n: Number(id), title: `Lavoro ${id}`, status, assignee: "sales", updatedAt: at, events: [], ...extra });
const agents = [{ id: "sales", name: "Vendite" }];
const empty = { groups: [], pendingApprovals: 0 };

let doc: ReturnType<typeof fakeDocument>;
beforeEach(() => {
	vi.resetModules();
	mocks.server.mockReset();
	mocks.toast.mockReset();
	mocks.renderRail.mockReset();
	doc = fakeDocument();
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
	vi.stubGlobal("fetch", fakeFetch(mocks.server));
});
afterEach(() => vi.unstubAllGlobals());

async function load() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const common = await import("../src/web/ui/common.js") as { state: Record<string, any>; resetPerson(): void; adoptPerson(me: unknown): void };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const approvals = await import("../src/web/ui/pages/approvals.js") as { needsBoardReview(card: unknown, viewer: unknown): boolean; reviewRows(board: unknown, viewer: unknown): FakeNode[]; viewApprovals(main: FakeNode): Promise<void> };
	common.state.me = viewer;
	const main = fakeNode("main");
	doc.body.append(main);
	return { ...common, ...approvals, main };
}

describe("Richiede te", () => {
	it("gives a review to the person who worked with the agente, and to the owner only when nobody did", async () => {
		const { needsBoardReview } = await load();
		const worked = card("1", "da_rivedere", { work: { agent: "sales", personId: "other", threadId: "private" } });
		expect(needsBoardReview(worked, viewer)).toBe(false);
		expect(needsBoardReview(worked, { id: "other", role: "member" })).toBe(true);
		expect(needsBoardReview(card("2", "da_rivedere"), viewer)).toBe(true);
		expect(needsBoardReview(card("2", "da_rivedere"), { id: "member", role: "member" })).toBe(false);
		expect(needsBoardReview({ ...worked, assignee: "another-agent" }, viewer)).toBe(true);
		expect(needsBoardReview({ ...worked, status: "fatto" }, viewer)).toBe(false);
	});

	it("shows each incarico to review with the latest result the agente left and a way to review it", async () => {
		const { reviewRows } = await load();
		const reviewed = card("3", "da_rivedere", { events: [{ kind: "status", status: "da_rivedere" }, { kind: "comment", by: { kind: "agent" }, text: "Vecchio risultato" }, { kind: "status", status: "in_corso" }, { kind: "status", status: "da_rivedere" }, { kind: "comment", by: { kind: "agent" }, text: "Risultato  aggiornato" }] });
		const rows = reviewRows({ agents, cards: [card("1", "in_corso"), reviewed, card("4", "da_rivedere", { updatedAt: "2026-10-25T08:00:00.000Z" })] }, viewer);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.textContent).toContain("#3 Lavoro 3");
		expect(rows[0]!.textContent).toContain("Vendite · Da rivedere");
		expect(rows[0]!.textContent).toContain("Risultato aggiornato");
		expect(rows[0]!.textContent).not.toContain("Vecchio risultato");
		expect(rows[0]!.querySelector("a.btn")?.attrs.href).toBe("#/board/3");
		expect(rows[1]!.textContent).toContain("senza un commento");
	});

	it("puts decisions and reviews on one page and counts them for the sidebar", async () => {
		const { state, viewApprovals, main } = await load();
		mocks.server.mockImplementation((url: string) => url === "/api/approvals"
			? { groups: [{ instance: { id: "sales", name: "Vendite" }, proposals: [], webActions: [], connectorActions: [], googleActions: [] }], pendingApprovals: 0 }
			: { agents, cards: [card("5", "da_rivedere")] });
		await viewApprovals(main);
		expect(main.textContent).toContain("Richiede te");
		expect(main.textContent).toContain("Da rivedere");
		expect(main.textContent).not.toContain("Da decidere");
		expect(main.textContent).toContain("#5 Lavoro 5");
		expect(state.boardReview).toBe(1);
		expect(mocks.renderRail).toHaveBeenCalled();
	});

	it("says when there is nothing, and keeps the decisions when the incarichi cannot load", async () => {
		const { state, viewApprovals, main } = await load();
		mocks.server.mockImplementation((url: string) => url === "/api/approvals" ? empty : { agents, cards: [] });
		await viewApprovals(main);
		expect(main.textContent).toContain("Niente richiede te");
		state.boardReview = 2;
		mocks.server.mockImplementation((url: string) => { if (url === "/api/approvals") return empty; throw new Error("Board offline"); });
		await viewApprovals(main);
		expect(main.textContent).toContain("Gli incarichi da rivedere non sono disponibili: Board offline");
		expect(state.boardReview).toBe(2);
	});
});

describe("Richiede te while the person changes", () => {
	it("a sign-out while the requests are on their way shows no error and counts nothing for whoever comes next", async () => {
		const { state, resetPerson, viewApprovals, main } = await load();
		const inbox = deferred();
		mocks.server.mockImplementation((url: string) => url === "/api/approvals" ? inbox.promise : { agents, cards: [card("5", "da_rivedere")] });
		const viewing = viewApprovals(main);
		resetPerson();
		inbox.release({ groups: [], pendingApprovals: 4 });
		await viewing;
		expect(main.textContent).not.toContain("Non sono riuscita");
		expect(main.textContent).not.toContain("Sessione chiusa");
		expect(state.pendingApprovals).toBe(0);
		expect(state.boardReview).toBe(0);
		expect(mocks.renderRail).not.toHaveBeenCalled();
	});

	it("a sign-out after the decisions arrived but before the incarichi did keeps the old person's counts out too", async () => {
		const { state, resetPerson, viewApprovals, main } = await load();
		const board = deferred();
		mocks.server.mockImplementation((url: string) => url === "/api/approvals" ? { groups: [], pendingApprovals: 4 } : board.promise);
		const viewing = viewApprovals(main);
		await vi.waitFor(() => expect(mocks.server).toHaveBeenCalledTimes(2));
		resetPerson();
		board.release({ agents, cards: [card("5", "da_rivedere")] });
		await viewing;
		expect(main.textContent).not.toContain("non sono disponibili");
		expect(state.pendingApprovals).toBe(0);
		expect(mocks.renderRail).not.toHaveBeenCalled();
	});

	it("the account dialog reading the same person again (a new object) does not leave the page on «Carico le richieste…»", async () => {
		const { state, adoptPerson, viewApprovals, main } = await load();
		const inbox = deferred();
		mocks.server.mockImplementation((url: string) => url === "/api/approvals" ? inbox.promise : { agents, cards: [] });
		const viewing = viewApprovals(main);
		expect(main.textContent).toContain("Carico le richieste…");
		adoptPerson({ ...viewer, name: "Nome nuovo" });
		inbox.release({ groups: [], pendingApprovals: 0 });
		await viewing;
		expect(main.textContent).not.toContain("Carico le richieste…");
		expect(main.textContent).toContain("Niente richiede te");
		expect(state.me.name).toBe("Nome nuovo");
	});
});
