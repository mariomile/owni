import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, fakeH, type FakeNode } from "./fake-dom.ts";

const mocks = vi.hoisted(() => ({ api: vi.fn(), store: vi.fn(), toast: vi.fn(), fmt: { time: (at: string) => `alle ${at.slice(11, 16)}` } }));
vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH } = await import("./fake-dom.ts");
	return { ...mocks, h: fakeH, face: (_agent: unknown, _size: number, mood: string) => fakeH(`span.face.${mood}`), icon: (name: string) => fakeH("svg", name) };
});

// @ts-expect-error Console modules intentionally use plain JavaScript.
import { computerView } from "../src/web/ui/screen-panel.js";
// @ts-expect-error Console modules intentionally use plain JavaScript.
import { browserPanel } from "../src/web/ui/browser-panel.js";

const inst = { id: "owni", name: "Owni" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const find = (node: FakeNode, prefix: string) => allNodes(node).find((item) => item.spec.startsWith(prefix))!;

beforeEach(() => {
	mocks.api.mockReset();
	mocks.store.mockReset();
	vi.stubGlobal("matchMedia", () => ({ matches: false }));
	vi.stubGlobal("document", { visibilityState: "visible" });
});
afterEach(() => vi.unstubAllGlobals());

describe("the agente's computer, a tab of its panel", () => {
	it("is asleep with the screen off, says so, and the button is there anyway", async () => {
		mocks.api.mockResolvedValue({ on: false, screen: null });
		const view = computerView(inst, "t1", () => {});
		await tick();
		expect(view.toggle.hidden).toBeFalsy();
		expect(view.toggle.textContent).toContain("Computer");
		expect(find(view.el, "div.computer-asleep").hidden).toBe(false);
		expect(allNodes(view.el).find((n) => n.textContent.includes("è spento") && n.spec.startsWith("p"))!.hidden).toBe(false);
	});

	it("is asleep until the agente uses its screen here, with whose screen it is", async () => {
		mocks.api.mockResolvedValue({ on: true, screen: null });
		const open = vi.fn();
		const view = computerView(inst, "t1", open);
		await tick();
		expect(open).not.toHaveBeenCalled();
		expect(find(view.el, "div.computer-asleep").textContent).toContain("Il computer dorme");
		expect(find(view.el, "span.face.asleep")).toBeDefined();
		expect(find(view.el, "img.screen").hidden).toBe(true);
		expect(find(view.el, "figure.computer-view").textContent).toContain("Lo schermo di Owni");
		expect(allNodes(view.el).find((n) => n.textContent.includes("è spento") && n.spec.startsWith("p"))!.hidden).toBe(true);
		view.toggle.fire("click");
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("asks to open its tab the first time the agente uses it, and shows the picture once visible", async () => {
		mocks.api.mockResolvedValue({ on: true, screen: { version: 3, at: "2026-10-31T16:44:00.000Z", action: "Ha aperto la pagina." } });
		const open = vi.fn();
		const view = computerView(inst, "t1", open);
		await tick();
		expect(open).toHaveBeenCalledTimes(1);
		view.visible(true);
		await tick();
		const picture = find(view.el, "img.screen");
		expect(picture.hidden).toBe(false);
		expect(picture.attrs.src ?? (picture as unknown as { src: string }).src).toBe("/api/instances/owni/threads/t1/screen.png?v=3");
		expect(find(view.el, "div.computer-asleep").hidden).toBe(true);
		expect(view.el.textContent).toContain("Ha aperto la pagina.");
		expect(view.toggle.attrs["aria-pressed"]).toBe("true");
	});
});

describe("the conversation's browser", () => {
	it("keeps its button with no page open: the first page and «Esci dai siti» live there", async () => {
		mocks.api.mockImplementation(async (path: string) => (path.endsWith("/profile") ? { hosts: [] } : { browser: { open: false }, available: true }));
		const closed = browserPanel(inst, "t1", () => {});
		await tick();
		expect(closed.toggle.hidden).toBe(false);
	});
});
