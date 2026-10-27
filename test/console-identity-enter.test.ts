import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/web/ui/common.js", async () => {
	const real = await vi.importActual<Record<string, unknown>>("../src/web/ui/common.js");
	return { ...real, api: mocks.api };
});
vi.mock("../src/web/ui/shell.js", () => ({ render: vi.fn(), renderRail: vi.fn(), refreshConversations: vi.fn(async () => {}) }));
vi.mock("../src/web/ui/login.js", () => ({}));
vi.mock("../src/web/ui/google.js", () => ({}));
vi.mock("../src/web/ui/setup.js", () => ({ setupLeft: () => 0 }));
vi.mock("../src/web/ui/signin.js", () => ({}));

beforeEach(() => {
	vi.resetModules();
	mocks.api.mockReset();
	vi.stubGlobal("document", { getElementById: () => null, visibilityState: "visible" });
	vi.stubGlobal("window", { addEventListener: vi.fn() });
	vi.stubGlobal("location", { hash: "", pathname: "/" });
	vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
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
