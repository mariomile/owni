import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function browserCommon() {
	const location = { hash: "" };
	const data = new Map<string, string>();
	const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) };
	const source = readFileSync(new URL("../src/web/ui/common.js", import.meta.url), "utf8").replace(/^export /gm, "");
	const common = new Function("document", "location", "localStorage", `${source}\nreturn { route, go, instanceHref, dmHref, movedHref, channelName, selectInstance, state };`)({ getElementById: () => null }, location, storage) as {
		route(): { view: string; rest: string[]; instanceId?: string };
		go(view: string, ...rest: string[]): void;
		instanceHref(view: string, rest: string[], instanceId?: string | null): string;
		dmHref(instanceId: string, threadId?: string): string;
		movedHref(route: { view: string; rest: string[]; instanceId?: string }): string | undefined;
		channelName(title: string): string;
		selectInstance(id: string): boolean;
		state: { instance?: { id: string }; instances: { id: string }[] };
	};
	return { ...common, location, data };
}

describe("agent context in product navigation", () => {
	it("round-trips a conversation and agent whose IDs contain route separators", () => {
		const common = browserCommon();
		common.location.hash = common.instanceHref("file", ["notes/one?two"], "sales/team&one");
		expect(common.route()).toMatchObject({ view: "file", rest: ["notes/one?two"], instanceId: "sales/team&one" });
		common.location.hash = common.dmHref("sales/team&one", "p_1.a/b");
		expect(common.route()).toMatchObject({ view: "dm", rest: ["sales/team&one", "t", "p_1.a/b"] });
	});

	it("only selects an agent present in the current person's visible list", () => {
		const common = browserCommon();
		common.state.instances = [{ id: "sales" }, { id: "research" }];
		common.state.instance = common.state.instances[0];
		expect(common.selectInstance("hidden")).toBe(false);
		expect(common.state.instance?.id).toBe("sales");
		expect(common.selectInstance("research")).toBe(true);
		expect(common.state.instance).toBe(common.state.instances[1]);
		expect(common.data.get("owni.instance")).toBe("research");
	});

	it("gives new agent-scoped links an explicit context without filtering the work overview", () => {
		const common = browserCommon();
		common.state.instance = { id: "sales" };
		common.go("impostazioni", "servizi");
		expect(common.route()).toMatchObject({ view: "impostazioni", rest: ["servizi"], instanceId: "sales" });
		common.go("lavori", "attenzione");
		expect(common.location.hash).toBe("#/lavori/attenzione");
		expect(common.route().instanceId).toBeUndefined();
	});

	it("opens the home on the direct messages and does not let malformed percent escapes break navigation", () => {
		const common = browserCommon();
		common.location.hash = "#/";
		expect(common.route()).toMatchObject({ view: "dm", rest: [] });
		common.location.hash = "#/file/%broken?agent=sales";
		expect(common.route()).toMatchObject({ view: "file", rest: ["%broken"], instanceId: "sales" });
	});

	it("sends links saved before ADR 0113 to where the conversation lives now", () => {
		const common = browserCommon();
		const moved = (hash: string) => {
			common.location.hash = hash;
			return common.movedHref(common.route());
		};
		expect(moved("#/chat/p_1.abc?agent=sales")).toBe("#/dm/sales/t/p_1.abc");
		expect(moved("#/chat?agent=sales")).toBe("#/dm/sales");
		expect(moved("#/chat")).toBe("#/");
		expect(moved("#/stanze/p_1.r2")).toBe("#/canali/p_1.r2");
		expect(moved("#/stanze/nuova")).toBe("#/canali/nuova");
		expect(moved("#/canali/p_1.r2")).toBeUndefined();
		expect(moved("#/dm/sales")).toBeUndefined();
		expect(moved("#/lavori")).toBeUndefined();
	});

	it("sends the agent pages folded into its panel by ADR 0114 to the panel, and its services to its configuration", () => {
		const common = browserCommon();
		const moved = (hash: string) => {
			common.location.hash = hash;
			return common.movedHref(common.route());
		};
		expect(moved("#/file?agent=sales")).toBe("#/dm/sales/info/documenti");
		expect(moved("#/memoria?agent=sales")).toBe("#/dm/sales/info/memoria");
		expect(moved("#/skill?agent=sales/team")).toBe("#/dm/sales%2Fteam/info/procedure");
		expect(moved("#/file")).toBe("#/agenti");
		expect(moved("#/connettori?agent=sales")).toBe("#/impostazioni/servizi?agent=sales");
		expect(moved("#/connettori")).toBe("#/impostazioni/servizi");
		expect(moved("#/dm/sales/info/memoria")).toBeUndefined();
		expect(moved("#/impostazioni/servizi?agent=sales")).toBeUndefined();
	});

	it("names a canale the way a team chat does, the stored title untouched", () => {
		const common = browserCommon();
		expect(common.channelName("Bando regionale 2027")).toBe("#bando-regionale-2027");
		expect(common.channelName("  Città & Più!  ")).toBe("#città-più");
		expect(common.channelName("!!!")).toBe("#canale");
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
