import { describe, expect, it } from "vitest";
import { RollingLimit } from "../src/core/rolling-limit.ts";

describe("rolling limit", () => {
	it("allows `limit` events per key in the window, then again as old ones leave it", () => {
		const limit = new RollingLimit(2, 1000);
		expect(limit.take("a", 0)).toBe(true);
		expect(limit.take("a", 500)).toBe(true);
		expect(limit.take("a", 999)).toBe(false);
		expect(limit.room("b", 999)).toBe(true);
		expect(limit.take("a", 1000)).toBe(true);
		expect(limit.take("a", 1001)).toBe(false);
	});

	it("room and count apart: a check spends nothing until the event is counted", () => {
		const limit = new RollingLimit(1, 1000);
		expect(limit.room("a", 0)).toBe(true);
		expect(limit.room("a", 0)).toBe(true);
		limit.count("a", 0);
		expect(limit.room("a", 1)).toBe(false);
	});
});
