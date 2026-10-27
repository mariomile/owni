import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ state: { me: undefined, usage: undefined, pendingApprovals: 0, boardReview: 0 } as Record<string, any>, api: vi.fn(), renderRail: vi.fn() }));
vi.mock("../src/web/ui/common.js", () => ({ ...mocks, ApiError: Error }));
vi.mock("../src/web/ui/shell.js", () => ({ renderRail: mocks.renderRail }));
vi.mock("../src/web/ui/login.js", () => ({}));
vi.mock("../src/web/ui/google.js", () => ({}));
vi.mock("../src/web/ui/setup.js", () => ({}));
vi.mock("../src/web/ui/signin.js", () => ({}));

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.stubGlobal("window", { addEventListener: vi.fn() });
	mocks.state.me = { id: "anna" };
	mocks.state.pendingApprovals = 7;
});
afterEach(() => vi.unstubAllGlobals());

async function session() {
	// @ts-expect-error The browser modules are deliberately plain JavaScript.
	return import("../src/web/ui/session.js") as Promise<{ refreshCounters(): Promise<void> }>;
}

describe("live console counters", () => {
	it("coalesces a burst of events and reads again after a change during the first request", async () => {
		let release!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
			.mockResolvedValue({ usage: { todayUsd: 2 }, pendingApprovals: 3, boardReview: 1 });
		const { refreshCounters } = await session();
		const pending = Array.from({ length: 20 }, () => refreshCounters());
		expect(mocks.api).toHaveBeenCalledTimes(1);
		release({ usage: { todayUsd: 1 }, pendingApprovals: 2, boardReview: 0 });
		await Promise.all(pending);
		expect(mocks.api).toHaveBeenCalledTimes(2);
		expect(mocks.api.mock.calls).toEqual([["/api/console-summary"], ["/api/console-summary"]]);
		expect(mocks.state.pendingApprovals).toBe(3);
		expect(mocks.state.boardReview).toBe(1);
	});

	it("keeps known counts on a failed read and can refresh successfully afterwards", async () => {
		mocks.api.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ usage: {}, pendingApprovals: 2, boardReview: 0 });
		const { refreshCounters } = await session();
		await refreshCounters();
		expect(mocks.state.pendingApprovals).toBe(7);
		await refreshCounters();
		expect(mocks.state.pendingApprovals).toBe(2);
	});

	it("waits for a refresh queued between the last read and shared promise cleanup", async () => {
		let releaseFirst!: (value: unknown) => void;
		let releaseSecond!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
			.mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }));
		const { refreshCounters } = await session();
		const first = refreshCounters();
		let second!: Promise<void>;
		releaseFirst({ usage: {}, pendingApprovals: 2, boardReview: 0 });
		queueMicrotask(() => { second = refreshCounters(); });
		await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
		let settled = false;
		void first.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseSecond({ usage: {}, pendingApprovals: 4, boardReview: 1 });
		await Promise.all([first, second]);
		expect(mocks.state.pendingApprovals).toBe(4);
		expect(mocks.state.boardReview).toBe(1);
	});

	it("does not request data while signed out (a late answer is cancelled by the sign-out: console-identity-enter)", async () => {
		mocks.state.me = undefined;
		const { refreshCounters } = await session();
		await refreshCounters();
		expect(mocks.api).not.toHaveBeenCalled();
		expect(mocks.state.pendingApprovals).toBe(7);
		expect(mocks.renderRail).not.toHaveBeenCalled();
	});
});
