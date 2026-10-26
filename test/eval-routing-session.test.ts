import { describe, expect, it } from "vitest";
import { openRoutingSession } from "../evals/agente/real-session.ts";

describe("nightly routing session", () => {
	it("opens the conversation the web API allows and reads the first turn of each case", async () => {
		const session = openRoutingSession({ provider: "faux", model: "owni-dev" }, "unused", 30_000);
		const first = await session.observe({ id: "a", text: "ciao", expect: [] });
		const second = await session.observe({ id: "b", text: "ciao di nuovo", expect: [] });
		expect(first.modelCalls).toBeGreaterThan(0);
		expect(second.modelCalls).toBeGreaterThan(0);
		await session.close();
	});
});
