import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred, fakeFetch } from "./fake-fetch.ts";

// The real api(): a person leaving cancels what was asked for them, the way the browser does.
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/web/ui/shell.js", () => ({ render: vi.fn(), renderRail: vi.fn(), refreshConversations: vi.fn(async () => {}) }));
vi.mock("../src/web/ui/login.js", () => ({}));
vi.mock("../src/web/ui/google.js", () => ({}));
vi.mock("../src/web/ui/setup.js", () => ({ setupLeft: () => 0 }));
vi.mock("../src/web/ui/signin.js", () => ({}));

beforeEach(() => {
	vi.resetModules();
	mocks.api.mockReset();
	vi.stubGlobal("document", { getElementById: () => null, querySelectorAll: () => [], visibilityState: "visible" });
	vi.stubGlobal("window", { addEventListener: vi.fn() });
	vi.stubGlobal("location", { hash: "", pathname: "/" });
	vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
	vi.stubGlobal("fetch", fakeFetch(mocks.api));
});
afterEach(() => vi.unstubAllGlobals());

const routes = (me: { id: string; role: string }, instances: { id: string }[]) => async (path: string) => {
	if (path === "/api/me") return { person: me };
	if (path === "/api/instances") return { instances };
	return { usage: undefined, pendingApprovals: 0, boardReview: 0 };
};

async function load() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { state } = await import("../src/web/ui/common.js") as { state: Record<string, any> };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { enter } = await import("../src/web/ui/session.js") as { enter(): Promise<void> };
	return { state, enter };
}

it("entering as another person drops the previous person's lists before anything is drawn", async () => {
	const { state, enter } = await load();
	const close = vi.fn();
	Object.assign(state, { me: { id: "alice", role: "member" }, instances: [{ id: "alice-only" }], conversations: { direct: [], channels: [{ id: "c-alice-private", title: "Fusione segreta" }] }, events: { close } });
	mocks.api.mockImplementation(routes({ id: "bob", role: "member" }, [{ id: "ops" }]));
	await enter();
	expect(state.me.id).toBe("bob");
	expect(state.instances).toEqual([{ id: "ops" }]);
	expect(state.conversations).toEqual({ direct: [], channels: [] });
	expect(close).toHaveBeenCalled();
});

it("entering again as the same person keeps what they already have", async () => {
	const { state, enter } = await load();
	const channels = [{ id: "c1", title: "Vendite" }];
	Object.assign(state, { me: { id: "alice", role: "member" }, conversations: { direct: [], channels } });
	mocks.api.mockImplementation(routes({ id: "alice", role: "member" }, [{ id: "ops" }]));
	await enter();
	expect(state.conversations.channels).toBe(channels);
});

async function loadSession() {
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const { state, resetPerson } = await import("../src/web/ui/common.js") as { state: Record<string, any>; resetPerson(): void };
	// @ts-expect-error Console modules intentionally use plain JavaScript.
	const session = await import("../src/web/ui/session.js") as { refreshInstances(): Promise<void>; refreshSetup(): Promise<void>; refreshCounters(): Promise<void> };
	return { state, resetPerson, ...session };
}

it("a late list of agents for a person who has left is not kept", async () => {
	const { state, resetPerson, refreshInstances } = await loadSession();
	state.me = { id: "alice", role: "member" };
	const late = deferred();
	mocks.api.mockImplementationOnce(() => late.promise);
	const reading = refreshInstances();
	resetPerson();
	state.me = { id: "alice", role: "member" };
	late.release({ instances: [{ id: "alice-only", name: "Segreto di Alice" }] });
	// The caller hears a closed session, which the toasts keep quiet about.
	await expect(reading).rejects.toMatchObject({ status: 0, message: "Sessione chiusa" });
	expect(state.instances).toEqual([]);
	expect(state.instance).toBeUndefined();
});

it("a late «Primi passi» for a person who has left is not kept", async () => {
	const { state, resetPerson, refreshSetup } = await loadSession();
	state.me = { id: "alice", role: "owner" };
	state.instance = { id: "ops" };
	const late = deferred();
	mocks.api.mockImplementationOnce(() => late.promise);
	const reading = refreshSetup();
	resetPerson();
	state.me = { id: "alice", role: "owner" };
	late.release({ setup: { steps: [{ id: "alice-step" }] } });
	await reading;
	expect(state.setup).toBeUndefined();
	expect(state.setupLeft).toBe(0);
});

it("late counters from a session that ended are dropped even when the person object is the same", async () => {
	const { state, resetPerson, refreshCounters } = await loadSession();
	const alice = { id: "alice", role: "member" };
	state.me = alice;
	const late = deferred();
	mocks.api.mockImplementationOnce(() => late.promise);
	const reading = refreshCounters();
	resetPerson();
	state.me = alice;
	late.release({ usage: { todayUsd: 9 }, pendingApprovals: 7, boardReview: 5 });
	await reading;
	expect(state.usage).toBeUndefined();
	expect(state.pendingApprovals).toBe(0);
	expect(state.boardReview).toBe(0);
});
