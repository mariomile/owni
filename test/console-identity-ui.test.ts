import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, fakeDocument, fakeNode, visible, type FakeNode } from "./fake-dom.ts";
import { deferred, fakeFetch, json } from "./fake-fetch.ts";

const mocks = vi.hoisted(() => ({ windowListeners: {} as Record<string, ((event: Event) => void)[]>, server: vi.fn(), toast: vi.fn(), renderLogin: vi.fn() }));

vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH, fakeMount } = await import("./fake-dom.ts");
	const real = await vi.importActual<Record<string, unknown>>("../src/web/ui/common.js");
	return { ...real, h: fakeH, mount: fakeMount, toast: mocks.toast, icon: (name: string) => fakeH("svg", name), face: () => fakeH("svg.face"), emptyNote: (spec: string, ...children: unknown[]) => fakeH(spec, ...children) };
});
vi.mock("../src/web/ui/login.js", () => ({ renderLogin: mocks.renderLogin, renderCode: vi.fn() }));
vi.mock("../src/web/ui/google.js", () => ({}));
vi.mock("../src/web/ui/setup.js", () => ({ setupLeft: () => 0 }));
vi.mock("../src/web/ui/signin.js", () => ({}));
vi.mock("../src/web/ui/account.js", () => ({ accountDialog: vi.fn() }));
vi.mock("../src/web/ui/models.js", () => ({ closeModelMenu: vi.fn() }));
vi.mock("../src/web/ui/pwa.js", () => ({ install: vi.fn(), installed: () => true, installOffer: false }));
vi.mock("../src/web/ui/pages/activity.js", () => ({ viewActivity: vi.fn() }));
vi.mock("../src/web/ui/pages/agents.js", () => ({ agentForm: vi.fn(), viewAgents: vi.fn() }));
vi.mock("../src/web/ui/pages/approvals.js", () => ({ viewApprovals: vi.fn() }));
vi.mock("../src/web/ui/pages/org.js", () => ({ viewOrg: vi.fn() }));
vi.mock("../src/web/ui/pages/automations.js", () => ({ viewAutomations: vi.fn() }));
vi.mock("../src/web/ui/pages/board.js", () => ({ viewBoard: vi.fn() }));
vi.mock("../src/web/ui/pages/chat.js", () => ({ viewDm: vi.fn(async () => {}) }));
vi.mock("../src/web/ui/pages/people.js", () => ({ viewPeople: vi.fn() }));
vi.mock("../src/web/ui/pages/rooms.js", () => ({ viewRooms: vi.fn() }));
vi.mock("../src/web/ui/pages/settings.js", () => ({ viewSettings: vi.fn() }));
vi.mock("../src/web/ui/pages/start.js", () => ({ viewStart: vi.fn() }));
vi.mock("../src/web/ui/pages/tasks.js", () => ({ viewTasks: vi.fn() }));
vi.mock("../src/web/ui/pages/work.js", () => ({ viewPrograms: vi.fn() }));

type Common = { state: Record<string, any> };
const alice = { id: "alice", name: "Alice", role: "member" };
const bob = { id: "bob", name: "Bob", role: "member" };
const aliceChannels = { direct: [], channels: [{ id: "c-alice-private", title: "Fusione segreta", unread: false }] };
const AGENT = { id: "ops", name: "Ops", canChat: true };

let doc: ReturnType<typeof fakeDocument>;
beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	mocks.server.mockReset();
	mocks.toast.mockReset();
	mocks.renderLogin.mockReset();
	for (const key of Object.keys(mocks.windowListeners)) delete mocks.windowListeners[key];
	doc = fakeDocument();
	doc.body.append(fakeNode("div", { id: "app" }), fakeNode("aside.rail", { id: "rail" }));
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", {
		innerHeight: 800,
		addEventListener: (type: string, handler: (event: Event) => void) => { (mocks.windowListeners[type] ??= []).push(handler); },
		removeEventListener: vi.fn(),
		dispatchEvent: (event: Event) => { for (const handler of mocks.windowListeners[event.type] ?? []) handler(event); },
	});
	vi.stubGlobal("fetch", fakeFetch(mocks.server));
	vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
	vi.stubGlobal("location", { hash: "", pathname: "/" });
	vi.stubGlobal("navigator", { platform: "Mac", onLine: true });
	vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
	vi.stubGlobal("MutationObserver", class { observe() {} });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
	vi.stubGlobal("Node", class {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function consoleWith() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const common = await import("../src/web/ui/common.js") as Common;
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const shell = await import("../src/web/ui/shell.js") as { refreshConversations(): Promise<void>; renderRail(): void };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const session = await import("../src/web/ui/session.js") as { enter(): Promise<void>; refreshCounters(): Promise<void> };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const palette = await import("../src/web/ui/palette.js") as { openPalette(): void };
	const rail = doc.getElementById("rail") as FakeNode;
	const dialogs = () => doc.body.querySelectorAll("dialog");
	const read = async () => { const reading = shell.refreshConversations(); await vi.advanceTimersByTimeAsync(200); await reading; shell.renderRail(); };
	const signOut = () => { for (const handler of mocks.windowListeners["owni:unauthorized"] ?? []) handler(new Event("owni:unauthorized")); };
	return { common, shell, session, palette, rail, dialogs, read, signOut };
}

describe("a console tab never shows the previous person's conversations", () => {
	it("after Alice leaves and Bob signs in, his slow read shows none of Alice's canali, in the rail or in the palette", async () => {
		const { common, shell, palette, rail, dialogs, read, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		mocks.server.mockResolvedValueOnce(aliceChannels);
		await read();
		expect(visible(rail)).toContain("c-alice-private");
		signOut();
		common.state.me = bob;
		common.state.instances = [AGENT];
		const slow = deferred();
		mocks.server.mockImplementationOnce(() => slow.promise);
		const reading = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		shell.renderRail();
		expect(visible(rail)).not.toContain("c-alice-private");
		expect(visible(rail)).not.toContain("segreta");
		palette.openPalette();
		const dialog = dialogs()[0] as FakeNode;
		const input = allNodes(dialog).find((n) => n.spec === "input") as FakeNode;
		input.value = "fusione";
		input.fire("input");
		expect(visible(dialog)).not.toContain("c-alice-private");
		expect(visible(dialog)).not.toContain("segreta");
		slow.release({ direct: [], channels: [] });
		await reading;
	});

	it("a failed read (500) for Bob leaves the rail empty, not Alice's last list", async () => {
		const { common, rail, read, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		mocks.server.mockResolvedValueOnce(aliceChannels);
		await read();
		signOut();
		common.state.me = bob;
		common.state.instances = [AGENT];
		mocks.server.mockResolvedValueOnce(json({ error: "Errore 500" }, 500));
		await read();
		expect(visible(rail)).not.toContain("c-alice-private");
		expect(visible(rail)).not.toContain("segreta");
	});

	it("a response to Alice's read that arrives after Bob signed in is discarded", async () => {
		const { common, shell, rail, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		const late = deferred();
		mocks.server.mockImplementationOnce(() => late.promise);
		const reading = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		signOut();
		common.state.me = bob;
		common.state.instances = [AGENT];
		late.release(aliceChannels);
		await reading;
		shell.renderRail();
		expect(common.state.conversations).toEqual({ direct: [], channels: [] });
		expect(visible(rail)).not.toContain("c-alice-private");
	});

	it("a response to Alice's read that arrives after the same tab re-entered as Alice (a new session) is discarded too", async () => {
		const { common, shell, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		const late = deferred();
		mocks.server.mockImplementationOnce(() => late.promise);
		const reading = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		signOut();
		// Same person object, new session: the request belonged to the session that ended.
		common.state.me = alice;
		late.release(aliceChannels);
		await reading;
		expect(common.state.conversations).toEqual({ direct: [], channels: [] });
	});

	it("a 401 with the palette open leaves no dialog over the login, so Alice's canali are not readable there", async () => {
		const { common, palette, dialogs, read, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		mocks.server.mockResolvedValueOnce(aliceChannels);
		await read();
		palette.openPalette();
		const dialog = dialogs()[0] as FakeNode;
		(allNodes(dialog).find((n) => n.spec === "input") as FakeNode).value = "fusione";
		(allNodes(dialog).find((n) => n.spec === "input") as FakeNode).fire("input");
		expect(visible(dialog)).toContain("segreta");
		expect(dialog.open).toBe(true);
		signOut();
		expect(dialog.open).toBe(false);
		expect(dialogs()).toHaveLength(0);
	});

	it("a dialog that redraws when it closes finds nobody signed in and asks the server nothing", async () => {
		const { common, shell, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		const seen: unknown[] = [];
		const dialog = fakeNode("dialog");
		dialog.addEventListener("close", () => { seen.push(common.state.me); void shell.refreshConversations(); });
		doc.body.append(dialog);
		dialog.showModal();
		signOut();
		await vi.advanceTimersByTimeAsync(200);
		expect(seen).toEqual([undefined]);
		expect(mocks.server).not.toHaveBeenCalled();
	});

	it("a sign-out closes the live stream and clears every person-scoped counter and list", async () => {
		const { common, signOut } = await consoleWith();
		const close = vi.fn();
		Object.assign(common.state, { me: alice, instances: [AGENT], instance: AGENT, usage: { todayUsd: 3 }, pendingApprovals: 4, boardReview: 2, conversations: aliceChannels, setupLeft: 3, setup: { steps: [] }, events: { close }, onEntry: () => true, onRoom: () => true });
		signOut();
		expect(close).toHaveBeenCalledOnce();
		expect(common.state).toMatchObject({ me: undefined, instances: [], instance: undefined, usage: undefined, pendingApprovals: 0, boardReview: 0, conversations: { direct: [], channels: [] }, setupLeft: 0, setup: undefined, events: undefined, onEntry: undefined, onRoom: undefined });
	});
});

describe("signing out", () => {
	/** Alice inside the console, with the counters' timer running. */
	async function signedIn() {
		const it = await consoleWith();
		mocks.server.mockImplementation(async (path: string) => {
			if (path === "/api/me") return { person: alice };
			if (path === "/api/instances") return { instances: [AGENT] };
			if (path === "/api/conversations") return { direct: [], channels: [] };
			return { usage: undefined, pendingApprovals: 0, boardReview: 0 };
		});
		await it.session.enter();
		await vi.advanceTimersByTimeAsync(200);
		mocks.server.mockClear();
		return it;
	}

	it("a 401 shows the login once, cancels what was on its way and stops the counters", async () => {
		const { common, session, shell } = await signedIn();
		const late = deferred();
		mocks.server.mockImplementation((path: string) => path === "/api/console-summary" ? late.promise : json({ error: "Sessione scaduta" }, 401));
		const counting = session.refreshCounters();
		const reading = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		await reading;
		expect(mocks.renderLogin).toHaveBeenCalledOnce();
		expect(common.state.me).toBeUndefined();
		late.release({ usage: { todayUsd: 9 }, pendingApprovals: 7, boardReview: 5 });
		await counting;
		expect(common.state.pendingApprovals).toBe(0);
		mocks.server.mockClear();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.server).not.toHaveBeenCalled();
	});

	it("«Esci» in the account menu signs out the same way: login, dialogs gone, requests cancelled, counters stopped", async () => {
		const { common, session, rail, dialogs } = await signedIn();
		const late = deferred();
		mocks.server.mockImplementation((path: string) => path === "/api/console-summary" ? late.promise : {});
		const counting = session.refreshCounters();
		const open = fakeNode("dialog");
		doc.body.append(open);
		open.showModal();
		(allNodes(rail).find((n) => n.spec.startsWith("button.who-id")) as FakeNode).fire("click");
		const exit = doc.body.querySelectorAll(".menu button").find((b) => b.textContent.includes("Esci")) as FakeNode;
		exit.fire("click");
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.server).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
		expect(mocks.renderLogin).toHaveBeenCalledOnce();
		expect(common.state.me).toBeUndefined();
		expect(dialogs()).toHaveLength(0);
		late.release({ usage: { todayUsd: 9 }, pendingApprovals: 7, boardReview: 5 });
		await counting;
		expect(common.state.pendingApprovals).toBe(0);
		mocks.server.mockClear();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.server).not.toHaveBeenCalled();
		expect(mocks.toast).not.toHaveBeenCalled();
	});
});
