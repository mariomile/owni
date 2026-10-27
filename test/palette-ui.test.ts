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

	it("«Niente con questo nome» is a status next to the listbox, never inside it", async () => {
		const { input, list } = await opened();
		const status = allNodes(dialog).find((n) => n.attrs.role === "status") as FakeNode;
		expect(status).toBeDefined();
		expect(allNodes(list)).not.toContain(status);
		expect(status.children).toEqual([]);
		input.value = "zzzz-niente";
		input.fire("input");
		expect(status.children).toEqual(["Niente con questo nome"]);
		expect(JSON.stringify(list.children)).not.toContain("Niente con questo nome");
		input.value = "";
		input.fire("input");
		expect(status.children).toEqual([]);
	});

	it("an entry keeps its option id while the results change, so the active descendant follows the entry", async () => {
		const { input, options } = await opened();
		const idOf = (label: string) => options().find((o) => JSON.stringify(o.children).includes(label))?.attrs.id;
		const before = input.attrs["aria-activedescendant"];
		const agenti = idOf("Agenti");
		expect(agenti).toBeTruthy();
		input.value = "agent";
		input.fire("input");
		const after = input.attrs["aria-activedescendant"];
		expect(after).not.toBe(before);
		expect(after).toBe(options()[0]?.attrs.id);
		expect(idOf("Agenti")).toBe(agenti);
		expect(new Set(options().map((o) => o.attrs.id)).size).toBe(options().length);
	});
});
