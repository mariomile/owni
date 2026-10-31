import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, fakeH, type FakeNode } from "./fake-dom.ts";

const mocks = vi.hoisted(() => ({ api: vi.fn(), store: vi.fn(), toast: vi.fn(), fmt: { time: (at: string) => `alle ${at.slice(11, 16)}` } }));
vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH } = await import("./fake-dom.ts");
	return { ...mocks, h: fakeH, face: (_agent: unknown, _size: number, mood: string) => fakeH(`span.face.${mood}`), icon: (name: string) => fakeH("svg", name) };
});

// @ts-expect-error Console modules intentionally use plain JavaScript.
import { screenPanel } from "../src/web/ui/screen-panel.js";
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

describe("the agente's computer next to the chat", () => {
	it("has no button for an agente without the screen", async () => {
		mocks.api.mockResolvedValue({ on: false, screen: null });
		const panel = screenPanel(inst, "t1", () => {});
		await tick();
		expect(panel.toggle.hidden).toBe(true);
		expect(panel.el.hidden).toBe(true);
	});

	it("is asleep until the agente uses its screen here, and the button is already there", async () => {
		mocks.api.mockResolvedValue({ on: true, screen: null });
		const panel = screenPanel(inst, "t1", () => {});
		await tick();
		expect(panel.toggle.hidden).toBe(false);
		expect(panel.toggle.textContent).toContain("Computer");
		expect(panel.el.hidden).toBe(true);
		expect(find(panel.el, "div.computer-asleep").hidden).toBe(false);
		expect(find(panel.el, "div.computer-asleep").textContent).toContain("Il computer dorme");
		expect(find(panel.el, "span.face.asleep")).toBeDefined();
		expect(find(panel.el, "img.screen").hidden).toBe(true);
		expect(find(panel.el, "figure.computer-view").textContent).toContain("Lo schermo di Owni");
	});

	it("opens by itself on the screen the first time the agente uses it, on a wide window", async () => {
		mocks.api.mockResolvedValue({ on: true, screen: { version: 3, at: "2026-10-31T16:44:00.000Z", action: "Ha aperto la pagina." } });
		const onShow = vi.fn();
		const panel = screenPanel(inst, "t1", onShow);
		await tick();
		await tick();
		expect(onShow).toHaveBeenCalled();
		expect(panel.el.hidden).toBe(false);
		const picture = find(panel.el, "img.screen");
		expect(picture.hidden).toBe(false);
		expect(picture.attrs.src ?? (picture as unknown as { src: string }).src).toBe("/api/instances/owni/threads/t1/screen.png?v=3");
		expect(find(panel.el, "div.computer-asleep").hidden).toBe(true);
		expect(panel.el.textContent).toContain("Ha aperto la pagina.");
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
