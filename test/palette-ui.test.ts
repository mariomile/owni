import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, type FakeNode } from "./fake-dom.ts";

vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH, fakeMount } = await import("./fake-dom.ts");
	return {
		h: fakeH, mount: fakeMount, icon: (name: string) => fakeH("svg", name), go: vi.fn(), channelName: (title: string) => `#${title}`,
		channelHref: (id: string) => `#/canali/${id}`, dmHref: (id: string) => `#/dm/${id}`,
		state: { me: { id: "anna", role: "member" }, instance: undefined, instances: [{ id: "ops", name: "Ops", canChat: true }], conversations: { direct: [], channels: [{ id: "c1", title: "vendite" }] } },
	};
});
vi.mock("../src/web/ui/shell.js", () => ({
	newAgent: vi.fn(), setTheme: vi.fn(),
	PAGES: [{ id: "board", label: "Incarichi", group: "Lavoro" }, { id: "approvazioni", label: "Richiede te", group: "Lavoro" }, { id: "agenti", label: "Agenti", group: "Gestione" }],
}));

let dialog: FakeNode;
beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("window", { addEventListener: vi.fn() });
	vi.stubGlobal("document", { querySelector: () => null, body: { append: (node: FakeNode) => { dialog = node; } } });
});
afterEach(() => vi.unstubAllGlobals());

async function opened() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { openPalette } = await import("../src/web/ui/palette.js") as { openPalette(): void };
	openPalette();
	const nodes = allNodes(dialog);
	const input = nodes.find((n) => n.spec === "input") as FakeNode;
	const list = nodes.find((n) => n.spec === "ul") as FakeNode;
	const options = () => allNodes(list).filter((n) => n.attrs.role === "option");
	return { input, list, options };
}

describe("command palette as an ARIA combobox", () => {
	it("the input is a combobox that controls the listbox, and says it is expanded", async () => {
		const { input, list } = await opened();
		expect(input.attrs.role).toBe("combobox");
		expect(list.attrs.role).toBe("listbox");
		expect(list.attrs.id).toBeTruthy();
		expect(input.attrs["aria-controls"]).toBe(list.attrs.id);
		expect(input.attrs["aria-expanded"]).toBe("true");
		expect(input.attrs["aria-autocomplete"]).toBe("list");
	});

	it("every option has its own id, and the input names the active one", async () => {
		const { input, options } = await opened();
		const ids = options().map((o) => o.attrs.id);
		expect(ids.length).toBeGreaterThan(1);
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		expect(input.attrs["aria-activedescendant"]).toBe(ids[0]);
		expect(options()[0]?.attrs["aria-selected"]).toBe("true");
	});

	it("the arrows move aria-activedescendant with the selection, wrapping around", async () => {
		const { input, options } = await opened();
		const activeId = () => options().find((o) => o.attrs["aria-selected"] === "true")?.attrs.id;
		const first = activeId();
		input.fire("keydown", { key: "ArrowDown" });
		expect(input.attrs["aria-activedescendant"]).toBe(options()[1]?.attrs.id);
		expect(input.attrs["aria-activedescendant"]).toBe(activeId());
		expect(activeId()).not.toBe(first);
		input.fire("keydown", { key: "ArrowUp" });
		input.fire("keydown", { key: "ArrowUp" });
		expect(input.attrs["aria-activedescendant"]).toBe(options().at(-1)?.attrs.id);
		expect(input.attrs["aria-activedescendant"]).toBe(activeId());
	});

	it("with nothing to pick there is no active descendant and the list is not expanded", async () => {
		const { input, options } = await opened();
		input.value = "zzzz-niente";
		input.fire("input");
		expect(options()).toHaveLength(0);
		expect(input.attrs["aria-activedescendant"]).toBeUndefined();
		expect(input.attrs["aria-expanded"]).toBe("false");
	});
});
