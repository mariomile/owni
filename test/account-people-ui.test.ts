import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, fakeDocument, fakeNode, type FakeNode } from "./fake-dom.ts";
import { fakeFetch } from "./fake-fetch.ts";

const mocks = vi.hoisted(() => ({ server: vi.fn(), toast: vi.fn(), render: vi.fn(), refreshInstances: vi.fn() }));
vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH, fakeMount } = await import("./fake-dom.ts");
	const real = await vi.importActual<Record<string, unknown>>("../src/web/ui/common.js");
	// Inputs that select their text, as the link dialog does with the new link.
	const h = (spec: string, ...rest: unknown[]) => Object.assign(fakeH(spec, ...rest), { select() {} });
	return { ...real, h, mount: fakeMount, toast: mocks.toast, icon: (name: string) => fakeH("svg", name), monogram: () => fakeH("span.monogram"), head: (_parent: unknown, title: unknown, text?: string) => fakeH("div.head", typeof title === "string" ? fakeH("h1", title) : title, text ? fakeH("p", text) : null) };
});
vi.mock("../src/web/ui/shell.js", () => ({ render: mocks.render, renderRail: vi.fn() }));
vi.mock("../src/web/ui/session.js", () => ({ refreshInstances: mocks.refreshInstances }));
vi.mock("../src/web/ui/login.js", async () => {
	const { fakeH } = await import("./fake-dom.ts");
	return { codeInput: () => fakeH("input.code") };
});
vi.mock("../src/web/ui/google.js", async () => {
	const { fakeH } = await import("./fake-dom.ts");
	return { googleSection: () => fakeH("div.card.google", "Google") };
});

type Common = { state: Record<string, any> };
const anna = { id: "anna", name: "Anna", role: "owner", createdAt: "2026-10-01T00:00:00Z", twoFactor: false };
const bruno = { id: "bruno", name: "Bruno", role: "member", createdAt: "2026-10-02T00:00:00Z", twoFactor: false };
const ops = { id: "ops", name: "Ops", canChat: true };
const ricerca = { id: "ricerca", name: "Ricerca", canChat: true };

let doc: ReturnType<typeof fakeDocument>;
let main: FakeNode;
beforeEach(() => {
	vi.resetModules();
	mocks.server.mockReset();
	mocks.toast.mockReset();
	mocks.render.mockReset();
	mocks.refreshInstances.mockReset();
	doc = fakeDocument();
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
	vi.stubGlobal("fetch", fakeFetch(mocks.server));
	vi.stubGlobal("location", { hash: "#/account", pathname: "/", origin: "https://owni.test" });
	vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
	main = fakeNode("main");
});
afterEach(() => vi.unstubAllGlobals());

const button = (root: FakeNode, label: string) => allNodes(root).find((n) => n.spec.startsWith("button") && n.textContent.trim() === label) as FakeNode;
/** A checkbox: the fake DOM has no `checked`, the page reads and sets it as a plain property. */
type Box = FakeNode & { checked?: boolean };
const box = (root: FakeNode, label: string) => allNodes(root).find((n) => n.attrs["aria-label"] === label) as Box;
const puts = () => mocks.server.mock.calls.filter(([, init]) => init.method === "PUT").map(([path, init]) => [path, JSON.parse(String(init.body))]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function account(me: typeof anna) {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const common = (await import("../src/web/ui/common.js")) as Common;
	common.state.me = me;
	mocks.server.mockImplementation((path: string) => (path === "/api/me" ? { person: me } : {}));
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { viewAccount } = (await import("../src/web/ui/pages/account.js")) as { viewAccount(main: FakeNode): Promise<void> };
	await viewAccount(main);
	await vi.waitFor(() => expect(main.textContent).toContain("Verifica in due passaggi"));
	return main.textContent;
}

describe("the Account page", () => {
	it("is one page for everyone: Google and two-factor are inline, no dialog to open", async () => {
		const text = await account(bruno);
		expect(text).toContain("Il tuo account");
		expect(text).toContain("Google");
		expect(button(main, "Attiva")).toBeDefined();
		expect(doc.body.querySelector("dialog")).toBeUndefined();
	});

	it("a member sees their own runs, not the installation", async () => {
		const text = await account(bruno);
		expect(text).toContain("Le tue esecuzioni e i consumi");
		expect(text).not.toContain("Installazione");
		expect(text).not.toContain("Persone e accessi");
	});

	it("the owner also gets the installation: people and access, providers, spend and audit", async () => {
		const text = await account(anna);
		expect(text).toContain("Installazione");
		const links = allNodes(main).filter((n) => n.spec.startsWith("a")).map((n) => n.attrs.href);
		expect(links).toContain("#/persone");
		expect(links).toContain("#/attivita");
		expect(text).toContain("Provider disponibili");
	});
});

/** The «Persone e accessi» page: Bruno writes to Ops, Anna approves for Ops; nobody uses Ricerca. */
async function people(fail?: (path: string) => boolean, people = [anna, bruno], instances = [ops, ricerca]) {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const common = (await import("../src/web/ui/common.js")) as Common;
	common.state.me = anna;
	common.state.instances = instances;
	const settings: Record<string, { allowedUsers: { web: string[] }; approvers: { web: string[] } }> = {
		ops: { allowedUsers: { web: ["bruno"] }, approvers: { web: ["anna"] } },
		ricerca: { allowedUsers: { web: [] }, approvers: { web: [] } },
	};
	mocks.server.mockImplementation((path: string, init: RequestInit) => {
		if (path === "/api/people" && init.method === "POST") return { person: { ...bruno, id: "carla", name: "Carla" }, link: "/login#t" };
		if (path === "/api/people") return { people };
		const agent = /^\/api\/instances\/(\w+)\/settings$/.exec(path)?.[1];
		if (agent && init.method === "PUT") {
			if (fail?.(path)) throw new Error("Salvataggio non riuscito");
			return { ok: true };
		}
		if (agent && !settings[agent]) throw new Error("Agente non trovato");
		if (agent) return { settings: settings[agent] };
		return {};
	});
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { viewPeople } = (await import("../src/web/ui/pages/people.js")) as { viewPeople(main: FakeNode): Promise<void> };
	await viewPeople(main);
	return main;
}

describe("Persone e accessi", () => {
	it("says per person which agents they write to and approve for", async () => {
		const page = await people();
		const rows = page.querySelectorAll("li.person-row").map((r) => r.textContent);
		expect(rows[0]).toContain("Non scrive a nessun agente");
		expect(rows[0]).toContain("approva per Ops");
		expect(rows[1]).toContain("Scrive a Ops");
		expect(rows[1]).not.toContain("approva");
	});

	it("«Accessi» changes a person's permissions on each agent, saving the whole lists of that agent", async () => {
		const page = await people();
		button(page.querySelectorAll("li.person-row")[1] as FakeNode, "Accessi").fire("click");
		const dialog = doc.body.querySelector("dialog.access-dialog") as FakeNode;
		expect(dialog.textContent).toContain("Accessi di Bruno");
		const approve = box(dialog, "Bruno approva per Ops");
		approve.checked = true;
		approve.fire("change");
		const writeRicerca = box(dialog, "Bruno scrive a Ricerca");
		writeRicerca.checked = true;
		writeRicerca.fire("change");
		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(puts()).toEqual([
			["/api/instances/ops/settings", { webPeople: ["bruno"], webApprovers: ["anna", "bruno"] }],
			["/api/instances/ricerca/settings", { webPeople: ["bruno"], webApprovers: [] }],
		]);
		dialog.close();
		// Who can chat changed: the agents again, then the page.
		await vi.waitFor(() => expect(mocks.render).toHaveBeenCalled());
		expect(mocks.refreshInstances).toHaveBeenCalled();
	});

	it("two quick changes on one agent go one after the other, the second carrying the first", async () => {
		const page = await people();
		button(page.querySelectorAll("li.person-row")[0] as FakeNode, "Accessi").fire("click");
		const dialog = doc.body.querySelector("dialog.access-dialog") as FakeNode;
		const write = box(dialog, "Anna scrive a Ops");
		write.checked = true;
		write.fire("change");
		const approve = box(dialog, "Anna approva per Ops");
		approve.checked = false;
		approve.fire("change");
		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(puts()[1]).toEqual(["/api/instances/ops/settings", { webPeople: ["bruno", "anna"], webApprovers: [] }]);
	});

	it("a change the server refuses is undone on screen and said", async () => {
		const page = await people(() => true);
		button(page.querySelectorAll("li.person-row")[1] as FakeNode, "Accessi").fire("click");
		const dialog = doc.body.querySelector("dialog.access-dialog") as FakeNode;
		const write = box(dialog, "Bruno scrive a Ops");
		write.checked = false;
		write.fire("change");
		await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Salvataggio non riuscito", true));
		expect(write.checked).toBe(true);
		// The next change still goes out, with Bruno still among the writers.
		const approve = box(dialog, "Bruno approva per Ops");
		approve.checked = true;
		approve.fire("change");
		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(puts()[1]?.[1]).toEqual({ webPeople: ["bruno"], webApprovers: ["anna", "bruno"] });
	});

	it("a refused change undone meanwhile is not sent again by the change queued after it", async () => {
		// Bruno approving for Ops is refused; Bruno no longer writing to Ops, queued after it, goes out without it.
		let first = true;
		const page = await people(() => (first ? ((first = false), true) : false));
		button(page.querySelectorAll("li.person-row")[1] as FakeNode, "Accessi").fire("click");
		const dialog = doc.body.querySelector("dialog.access-dialog") as FakeNode;
		const approve = box(dialog, "Bruno approva per Ops");
		approve.checked = true;
		approve.fire("change");
		const write = box(dialog, "Bruno scrive a Ops");
		write.checked = false;
		write.fire("change");
		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(approve.checked).toBe(false);
		expect(puts()[1]?.[1]).toEqual({ webPeople: [], webApprovers: ["anna"] });
	});

	it("an agente whose settings do not load is left out, the people are still there", async () => {
		const page = await people(undefined, [anna, bruno], [ops, { id: "sparito", name: "Sparito", canChat: true }]);
		expect(page.querySelectorAll("li.person-row")).toHaveLength(2);
		button(page.querySelectorAll("li.person-row")[1] as FakeNode, "Accessi").fire("click");
		const dialog = doc.body.querySelector("dialog.access-dialog") as FakeNode;
		expect(dialog.textContent).toContain("Ops");
		expect(dialog.textContent).not.toContain("Sparito");
	});

	it("an owner with no access still manages everything, and the row says so", async () => {
		const page = await people(undefined, [{ ...anna, id: "zoe", name: "Zoe" }]);
		expect(page.querySelector("li.person-row")?.textContent).toContain("Gestisce tutto, ma non scrive a nessun agente");
	});

	it("a new person gets the agents ticked in the form right away", async () => {
		const page = await people();
		vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
		const name = allNodes(page).find((n) => n.attrs.placeholder === "Nome e cognome") as FakeNode;
		name.value = "Carla";
		const pick = allNodes(page.querySelector("fieldset.access-pick") as FakeNode).filter((n) => n.spec === "input") as Box[];
		expect(pick).toHaveLength(2);
		pick[1]!.checked = true;
		button(page, "Crea e mostra il link").fire("click");
		await vi.waitFor(() => expect(doc.body.querySelector("dialog")?.textContent).toContain("Link di Carla"));
		expect(puts()).toEqual([["/api/instances/ricerca/settings", { webPeople: ["carla"], webApprovers: [] }]]);
		await flush();
		expect(mocks.toast.mock.calls).toEqual([]);
	});
});
