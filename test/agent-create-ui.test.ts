import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, fakeDocument, type FakeNode } from "./fake-dom.ts";
import { deferred, fakeFetch } from "./fake-fetch.ts";

const mocks = vi.hoisted(() => ({ server: vi.fn(), toast: vi.fn(), render: vi.fn() }));
vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH, fakeMount } = await import("./fake-dom.ts");
	const real = await vi.importActual<Record<string, unknown>>("../src/web/ui/common.js");
	return { ...real, h: fakeH, mount: fakeMount, toast: mocks.toast, face: () => fakeH("svg.face"), icon: (name: string) => fakeH("svg", name) };
});
vi.mock("../src/web/ui/shell.js", () => ({ render: mocks.render, renderRail: vi.fn(), refreshConversations: vi.fn(async () => {}) }));
vi.mock("../src/web/ui/login.js", () => ({ renderLogin: vi.fn() }));
vi.mock("../src/web/ui/google.js", () => ({}));
vi.mock("../src/web/ui/setup.js", () => ({ setupLeft: () => 0 }));
vi.mock("../src/web/ui/signin.js", () => ({}));

const owner = { id: "anna", role: "owner" };
const created = { id: "ricercatore", name: "Ricercatore" };

let doc: ReturnType<typeof fakeDocument>;
let stored: Record<string, string>;
let place: { hash: string; pathname: string };
beforeEach(() => {
	vi.resetModules();
	mocks.server.mockReset();
	mocks.toast.mockReset();
	mocks.render.mockReset();
	stored = {};
	doc = fakeDocument();
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
	vi.stubGlobal("fetch", fakeFetch(mocks.server));
	place = { hash: "#/agenti", pathname: "/" };
	vi.stubGlobal("location", place);
	vi.stubGlobal("localStorage", { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, value: string) => { stored[key] = value; }, removeItem() {} });
});
afterEach(() => vi.unstubAllGlobals());

/** The «Nuovo agente» form, filled from the «Ricercatore» template, with its «Crea agente» button. */
async function form() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const common = await import("../src/web/ui/common.js") as { state: Record<string, any>; resetPerson(): void };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { agentForm } = await import("../src/web/ui/pages/agents.js") as { agentForm(): void };
	common.state.me = owner;
	agentForm();
	const dialog = doc.body.querySelector("dialog.agent-form") as FakeNode;
	const template = allNodes(dialog).find((n) => n.spec === "button.pick" && n.textContent === "Ricercatore") as FakeNode;
	template.fire("click", { currentTarget: template });
	const create = allNodes(dialog).find((n) => n.textContent === "Crea agente") as FakeNode;
	return { ...common, dialog, create };
}

describe("creating an agente while the person leaves", () => {
	it("a sign-out while the agents are read again after the creation ends quietly: no error, nothing written, no page", async () => {
		const { state, resetPerson, create } = await form();
		const counters = deferred();
		mocks.server.mockImplementation((path: string, init: RequestInit) => {
			if (path === "/api/instances" && init.method === "POST") return { instance: created };
			if (path === "/api/instances") return { instances: [created] };
			if (path === "/api/console-summary") return counters.promise;
			return {};
		});
		create.fire("click");
		await vi.waitFor(() => expect(mocks.server).toHaveBeenCalledWith("/api/console-summary", expect.anything()));
		resetPerson();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mocks.toast).not.toHaveBeenCalled();
		expect(state.instance).toBeUndefined();
		expect(state.instances).toEqual([]);
		expect(stored["owni.instance"]).toBeUndefined();
		expect(place.hash).toBe("#/agenti");
		expect(mocks.render).not.toHaveBeenCalled();
		expect(mocks.server.mock.calls.map(([path]) => path)).not.toContain(`/api/instances/${created.id}/setup`);
	});

	it("a sign-out while the creation itself is on its way says only that the session closed, which the toasts keep quiet", async () => {
		const { state, resetPerson, dialog, create } = await form();
		const answer = deferred();
		mocks.server.mockImplementation(() => answer.promise);
		create.fire("click");
		resetPerson();
		answer.release({ instance: created });
		await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
		expect(mocks.toast.mock.calls).toEqual([["Sessione chiusa", true]]);
		expect(state.instance).toBeUndefined();
		expect(place.hash).toBe("#/agenti");
		expect(mocks.render).not.toHaveBeenCalled();
		expect(dialog.removed).toBe(true);
	});

	it("with nobody leaving, the new agente is chosen and its conversation opens", async () => {
		const { state, create } = await form();
		mocks.server.mockImplementation((path: string, init: RequestInit) => {
			if (path === "/api/instances" && init.method === "POST") return { instance: created };
			if (path === "/api/instances") return { instances: [{ id: "ops", name: "Ops" }, created] };
			if (path === "/api/console-summary") return { usage: undefined, pendingApprovals: 0, boardReview: 0 };
			return { setup: { steps: [] } };
		});
		create.fire("click");
		await vi.waitFor(() => expect(mocks.render).toHaveBeenCalled());
		expect(state.instance).toEqual(created);
		expect(stored["owni.instance"]).toBe(created.id);
		expect(place.hash).toBe(`#/dm/${created.id}`);
		expect(mocks.toast).toHaveBeenCalledWith(`Agente ${created.name} creato`, false, expect.objectContaining({ label: "Configura" }));
	});
});
