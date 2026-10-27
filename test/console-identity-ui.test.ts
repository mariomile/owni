import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allNodes, fakeNode, visible, type FakeNode } from "./fake-dom.ts";

const mocks = vi.hoisted(() => ({ windowListeners: {} as Record<string, (() => void)[]>, api: vi.fn() }));

vi.mock("../src/web/ui/common.js", async () => {
	const { fakeH, fakeMount } = await import("./fake-dom.ts");
	const real = await vi.importActual<Record<string, unknown>>("../src/web/ui/common.js");
	return { ...real, h: fakeH, mount: fakeMount, api: mocks.api, icon: (name: string) => fakeH("svg", name), face: () => fakeH("svg.face"), emptyNote: (spec: string, ...children: unknown[]) => fakeH(spec, ...children) };
});
vi.mock("../src/web/ui/login.js", () => ({ renderLogin: vi.fn(), renderCode: vi.fn() }));
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
vi.mock("../src/web/ui/pages/chat.js", () => ({ viewDm: vi.fn() }));
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

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	mocks.api.mockReset();
	for (const key of Object.keys(mocks.windowListeners)) delete mocks.windowListeners[key];
	vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: vi.fn(), documentElement: { dataset: {} }, body: {}, visibilityState: "visible" });
	vi.stubGlobal("window", { addEventListener: (type: string, handler: () => void) => { (mocks.windowListeners[type] ??= []).push(handler); }, removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
	vi.stubGlobal("location", { hash: "", pathname: "/" });
	vi.stubGlobal("navigator", { platform: "Mac" });
	vi.stubGlobal("MutationObserver", class { observe() {} });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
	vi.stubGlobal("Node", class {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function consoleWith() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const common = await import("../src/web/ui/common.js") as Common;
	const rail = fakeNode("aside.rail");
	const dialogs: FakeNode[] = [];
	vi.stubGlobal("document", { getElementById: (id: string) => id === "rail" ? rail : null, querySelector: () => null, querySelectorAll: (selector: string) => selector === "dialog" ? dialogs.filter((d) => !d.removed) : [], addEventListener: vi.fn(), documentElement: { dataset: {} }, body: { append: (node: FakeNode) => dialogs.push(node) }, visibilityState: "visible" });
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const shell = await import("../src/web/ui/shell.js") as { refreshConversations(): Promise<void>; renderRail(): void };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	await import("../src/web/ui/session.js");
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const palette = await import("../src/web/ui/palette.js") as { openPalette(): void };
	const read = async () => { const reading = shell.refreshConversations(); await vi.advanceTimersByTimeAsync(200); await reading; shell.renderRail(); };
	const signOut = () => { for (const handler of mocks.windowListeners["owni:unauthorized"] ?? []) handler(); };
	return { common, shell, palette, rail, dialogs, read, signOut };
}

describe("a console tab never shows the previous person's conversations", () => {
	it("after Alice leaves and Bob signs in, his slow read shows none of Alice's canali, in the rail or in the palette", async () => {
		const { common, shell, palette, rail, dialogs, read, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		mocks.api.mockResolvedValueOnce(aliceChannels);
		await read();
		expect(visible(rail)).toContain("c-alice-private");
		signOut();
		common.state.me = bob;
		common.state.instances = [AGENT];
		let release!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const reading = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		shell.renderRail();
		expect(visible(rail)).not.toContain("c-alice-private");
		expect(visible(rail)).not.toContain("segreta");
		palette.openPalette();
		const dialog = dialogs[0] as FakeNode;
		const input = allNodes(dialog).find((n) => n.spec === "input") as FakeNode;
		input.value = "fusione";
		input.fire("input");
		expect(visible(dialog)).not.toContain("c-alice-private");
		expect(visible(dialog)).not.toContain("segreta");
		release({ direct: [], channels: [] });
		await reading;
	});

	it("a failed read (500) for Bob leaves the rail empty, not Alice's last list", async () => {
		const { common, rail, read, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		mocks.api.mockResolvedValueOnce(aliceChannels);
		await read();
		signOut();
		common.state.me = bob;
		common.state.instances = [AGENT];
		mocks.api.mockRejectedValueOnce(new Error("Errore 500"));
		await read();
		expect(visible(rail)).not.toContain("c-alice-private");
		expect(visible(rail)).not.toContain("segreta");
	});

	it("a response to Alice's read that arrives after Bob signed in is discarded", async () => {
		const { common, shell, rail, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		let release!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const late = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		signOut();
		common.state.me = bob;
		common.state.instances = [AGENT];
		release(aliceChannels);
		await late;
		shell.renderRail();
		expect(common.state.conversations).toEqual({ direct: [], channels: [] });
		expect(visible(rail)).not.toContain("c-alice-private");
	});

	it("a response to Alice's read that arrives after the same tab re-entered as Alice (a new session) is discarded too", async () => {
		const { common, shell, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		let release!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const late = shell.refreshConversations();
		await vi.advanceTimersByTimeAsync(200);
		signOut();
		// Same person object, new session: only the session generation tells the two apart.
		common.state.me = alice;
		release(aliceChannels);
		await late;
		expect(common.state.conversations).toEqual({ direct: [], channels: [] });
	});

	it("a 401 with the palette open leaves no dialog over the login, so Alice's canali are not readable there", async () => {
		const { common, palette, dialogs, read, signOut } = await consoleWith();
		common.state.me = alice;
		common.state.instances = [AGENT];
		mocks.api.mockResolvedValueOnce(aliceChannels);
		await read();
		palette.openPalette();
		const dialog = dialogs[0] as FakeNode;
		(allNodes(dialog).find((n) => n.spec === "input") as FakeNode).value = "fusione";
		(allNodes(dialog).find((n) => n.spec === "input") as FakeNode).fire("input");
		expect(visible(dialog)).toContain("c-alice-private");
		expect(dialog.open).toBe(true);
		signOut();
		expect(dialog.open).toBe(false);
		expect(dialogs.filter((d) => !d.removed)).toHaveLength(0);
	});

	it("a sign-out closes the live stream and clears every person-scoped counter and list", async () => {
		const { common, signOut } = await consoleWith();
		const close = vi.fn();
		Object.assign(common.state, { me: alice, instances: [AGENT], instance: AGENT, usage: { todayUsd: 3 }, pendingApprovals: 4, boardReview: 2, conversations: aliceChannels, setupLeft: 3, setup: { steps: [] }, events: { close }, onEntry: () => true });
		signOut();
		expect(close).toHaveBeenCalledOnce();
		expect(common.state).toMatchObject({ me: undefined, instances: [], instance: undefined, usage: undefined, pendingApprovals: 0, boardReview: 0, conversations: { direct: [], channels: [] }, setupLeft: 0, setup: undefined, events: undefined, onEntry: undefined });
	});
});
