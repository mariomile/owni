import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function browserCommon() {
	const location = { hash: "" };
	const data = new Map<string, string>();
	const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) };
	const source = readFileSync(new URL("../src/web/ui/common.js", import.meta.url), "utf8").replace(/^export /gm, "");
	const common = new Function("document", "location", "localStorage", `${source}\nreturn { route, go, instanceHref, selectInstance, state };`)({ getElementById: () => null }, location, storage) as {
		route(): { view: string; rest: string[]; instanceId?: string };
		go(view: string, ...rest: string[]): void;
		instanceHref(view: string, rest: string[], instanceId?: string | null): string;
		selectInstance(id: string): boolean;
		state: { instance?: { id: string }; instances: { id: string }[]; threads: unknown[] };
	};
	return { ...common, location, data };
}

describe("agent context in product navigation", () => {
	it("round-trips a conversation and agent whose IDs contain route separators", () => {
		const common = browserCommon();
		common.location.hash = common.instanceHref("chat", ["thread/one?two"], "sales/team&one");
		expect(common.route()).toMatchObject({ view: "chat", rest: ["thread/one?two"], instanceId: "sales/team&one" });
	});

	it("only selects an agent present in the current person's visible list", () => {
		const common = browserCommon();
		common.state.instances = [{ id: "sales" }, { id: "research" }];
		common.state.instance = common.state.instances[0];
		expect(common.selectInstance("hidden")).toBe(false);
		expect(common.state.instance?.id).toBe("sales");
		expect(common.selectInstance("research")).toBe(true);
		expect(common.state.instance).toBe(common.state.instances[1]);
		expect(common.data.get("annie.instance")).toBe("research");
	});

	it("gives new agent-scoped links an explicit context without filtering the work overview", () => {
		const common = browserCommon();
		common.state.instance = { id: "sales" };
		common.go("chat", "conversation");
		expect(common.route()).toMatchObject({ view: "chat", rest: ["conversation"], instanceId: "sales" });
		common.go("lavori", "attenzione");
		expect(common.location.hash).toBe("#/lavori/attenzione");
		expect(common.route().instanceId).toBeUndefined();
	});

	it("keeps old routes valid and does not let malformed percent escapes break navigation", () => {
		const common = browserCommon();
		common.location.hash = "#/chat/old-thread";
		expect(common.route()).toMatchObject({ view: "chat", rest: ["old-thread"], instanceId: undefined });
		common.location.hash = "#/file/%broken?agent=sales";
		expect(common.route()).toMatchObject({ view: "file", rest: ["%broken"], instanceId: "sales" });
	});
});

describe("first-use readiness", () => {
	it("does not count optional channels, devices or team setup as unfinished first use", () => {
		const source = readFileSync(new URL("../src/web/ui/setup.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
		const setupLeft = new Function("appleTouch", "installed", "installOffer", `${source}\nreturn setupLeft;`)(false, () => false, undefined) as (setup: Record<string, unknown>) => number;
		expect(setupLeft({ model: true, tried: true, can: { computerUse: true, images: true } })).toBe(0);
		expect(setupLeft({ model: true, tried: false, can: {} })).toBe(1);
		expect(setupLeft({ model: false, tried: false, can: {} })).toBe(2);
	});
});
