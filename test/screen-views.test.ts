import { describe, expect, it } from "vitest";
import { SCREEN_VIEWS_BYTES, SCREEN_VIEWS_LIMIT, ScreenViews } from "../src/core/screen-views.ts";

describe("the live screen views", () => {
	it("keep the last picture per agente and conversation, with a version that grows and what was done", () => {
		const views = new ScreenViews();
		const web = { channel: "web", threadId: "t1" };
		expect(views.get("owni", "web", "t1")).toBeUndefined();
		views.set("owni", web, new Uint8Array([1]), undefined, Date.now(), new Date("2026-10-18T10:00:00Z"));
		const first = views.get("owni", "web", "t1")?.version ?? 0;
		views.set("owni", web, new Uint8Array([2]), "Clic in 1, 2.", Date.now(), new Date("2026-10-18T10:00:05Z"));
		views.set("owni", { channel: "telegram", threadId: "t1" }, new Uint8Array([3]));
		views.set("ricerca", web, new Uint8Array([4]));
		const last = views.get("owni", "web", "t1");
		expect(last).toMatchObject({ version: first + 1, at: "2026-10-18T10:00:05.000Z", action: "Clic in 1, 2." });
		// From the clock: after a restart the versions do not start again from where an open tab is.
		expect(first).toBeGreaterThan(1_700_000_000_000);
		expect([...(last?.png ?? [])]).toEqual([2]);
		expect([...(views.get("owni", "telegram", "t1")?.png ?? [])]).toEqual([3]);
		views.forget("owni");
		expect(views.get("owni", "web", "t1")).toBeUndefined();
		expect(views.get("owni", "telegram", "t1")).toBeUndefined();
		expect(views.get("ricerca", "web", "t1")?.version).toBe(first + 3);
	});

	it("a picture asked for before a reset arrives too late and is dropped; one asked for after is kept", () => {
		const views = new ScreenViews();
		const web = { channel: "web", threadId: "t1" };
		const before = Date.now() - 1;
		views.forget("owni");
		views.set("owni", web, new Uint8Array([1]), undefined, before);
		expect(views.get("owni", "web", "t1")).toBeUndefined();
		views.set("owni", web, new Uint8Array([2]), undefined, Date.now() + 1);
		expect(views.get("owni", "web", "t1")).toBeDefined();
	});

	it("hold at most a few hundred conversations, and a bounded size: the one written the longest ago goes", () => {
		const views = new ScreenViews();
		for (let i = 0; i <= SCREEN_VIEWS_LIMIT; i += 1) views.set("owni", { channel: "web", threadId: `t${i}` }, new Uint8Array([i % 256]));
		expect(views.get("owni", "web", "t0")).toBeUndefined();
		expect(views.get("owni", "web", "t1")).toBeDefined();
		views.set("owni", { channel: "web", threadId: "t1" }, new Uint8Array([9]));
		views.set("owni", { channel: "web", threadId: "nuova" }, new Uint8Array([9]));
		expect(views.get("owni", "web", "t1")).toBeDefined();
		expect(views.get("owni", "web", "t2")).toBeUndefined();
		const big = new ScreenViews();
		const third = new Uint8Array(Math.ceil(SCREEN_VIEWS_BYTES / 3) + 1);
		for (const t of ["a", "b", "c"]) big.set("owni", { channel: "web", threadId: t }, third);
		expect(big.get("owni", "web", "a")).toBeUndefined();
		expect(big.get("owni", "web", "b")).toBeDefined();
		expect(big.get("owni", "web", "c")).toBeDefined();
	});
});
