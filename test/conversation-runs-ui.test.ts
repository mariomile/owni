import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UiNode = {
	tag: string; attrs: Record<string, any>; children: (UiNode | string)[];
	hidden: boolean; disabled: boolean; open: boolean; isConnected: boolean; textContent: string;
	setAttribute(name: string, value: unknown): void;
	querySelector(selector: string): UiNode | undefined;
};
const mocks = vi.hoisted(() => {
	const h = (tag: string, attrs?: any, ...children: any[]): UiNode => {
		const props = attrs && typeof attrs === "object" && !Array.isArray(attrs) && !attrs.tag ? attrs : {};
		if (props !== attrs) children.unshift(attrs);
		const node: UiNode = {
			tag, attrs: props, children: children.flat(Infinity).filter((v) => v != null && v !== false),
			hidden: Boolean(props.hidden), disabled: Boolean(props.disabled), open: false, isConnected: true,
			get textContent() { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(" "); },
			set textContent(text) { this.children = [text]; },
			setAttribute(name, value) { this.attrs[name] = value; },
			querySelector(selector) {
				for (const child of this.children) if (typeof child !== "string") {
					if (child.tag.split(".")[0] === selector) return child;
					const match = child.querySelector(selector);
					if (match) return match;
				}
			},
		};
		return node;
	};
	return { h, mount: (el: UiNode, ...children: any[]) => { el.children = children.flat(Infinity).filter((v) => v != null && v !== false); }, api: vi.fn(), toast: vi.fn(), state: {} as Record<string, any>, icon: (name: string) => h("svg", name), face: () => h("svg.face"), faceColor: () => "#000", emptyNote: (tag: string, ...text: any[]) => h(tag, ...text), fmt: { time: (at: string) => at }, store: vi.fn() };
});
vi.mock("../src/web/ui/common.js", () => mocks);
// @ts-expect-error Browser modules deliberately use plain JavaScript.
import { conversationRuns } from "../src/web/ui/runs.js";

const inst = { id: "sales" };
const base = "/api/instances/sales/threads/private%2Fthread";
const run = (status: string, extra = {}) => ({ id: "run", instanceId: inst.id, threadId: "private/thread", status, delivery: "delivered", progress: [{ kind: "model", at: "2026-10-25T10:00:00Z" }], createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z", ...extra });
const all = (el: UiNode): UiNode[] => [el, ...el.children.flatMap((child) => typeof child === "string" ? [] : all(child))];
const find = (el: UiNode, tag: string) => all(el).find((node) => node.tag === tag)!;
async function control(rows: unknown[]) {
	mocks.api.mockResolvedValue({ runs: rows });
	const changed = vi.fn();
	const result = conversationRuns(inst, "private/thread", changed);
	await result.refresh();
	return { ...result, changed };
}
beforeEach(() => { vi.useFakeTimers(); mocks.api.mockReset(); mocks.toast.mockReset(); mocks.state.onRun = undefined; vi.stubGlobal("document", { visibilityState: "visible" }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("quiet conversation work status", () => {
	it("leaves a delivered reply free of a redundant completion panel or model-only activity", async () => {
		const { el, changed } = await control([run("succeeded")]);
		expect(el.hidden).toBe(true);
		expect(find(el, "span.run-status").textContent).toBe("");
		expect(el.querySelector("details")).toBeUndefined();
		expect(changed).toHaveBeenLastCalledWith(false);
	});

	it("shows real queued/running progress and hides it after successful delivery", async () => {
		const { el, changed } = await control([run("queued")]);
		expect(el.hidden).toBe(false);
		expect(find(el, "span.run-status").textContent).toBe("In attesa di iniziare");
		expect(all(el).find((node) => node.textContent === "stop Interrompi")?.hidden).toBe(false);
		mocks.state.onRun(run("running", { updatedAt: "2026-10-25T10:01:00Z", progress: [{ kind: "tool_start", toolName: "web_search", at: "2026-10-25T10:01:00Z" }] }));
		expect(find(el, "span.run-status").textContent).toBe("Cerco sul web");
		expect(el.attrs["data-state"]).toBe("running");
		expect(changed).toHaveBeenLastCalledWith(true);
		mocks.state.onRun(run("succeeded", { updatedAt: "2026-10-25T10:02:00Z" }));
		expect(el.hidden).toBe(true);
		expect(changed).toHaveBeenLastCalledWith(false);
	});

	it.each(["pending", "failed"])("preserves a visible %s delivery outcome until delivery is confirmed", async (delivery) => {
		const { el } = await control([run("succeeded", { delivery })]);
		expect(el.hidden).toBe(false);
		expect(el.attrs["data-state"]).toBe(`delivery-${delivery}`);
		expect(find(el, "p.run-note").hidden).toBe(false);
		expect(find(el, "span.run-status").textContent).toBe(delivery === "failed" ? "Consegna non riuscita" : "Consegna in attesa");
		mocks.state.onRun(run("succeeded", { updatedAt: "2026-10-25T10:02:00Z" }));
		expect(el.hidden).toBe(true);
	});

	it("keeps failure guidance and cancellation consequences visible without exposing raw errors", async () => {
		const { el } = await control([run("failed", { error: "sensitive raw provider details" })]);
		expect(el.hidden).toBe(false);
		expect(find(el, "span.run-status").textContent).toBe("Risposta non completata");
		expect(find(el, "p.run-note").textContent).toContain("nuovo messaggio");
		expect(el.textContent).not.toContain("sensitive raw provider details");
		mocks.state.onRun(run("cancelled", { updatedAt: "2026-10-25T10:02:00Z" }));
		expect(el.hidden).toBe(false);
		expect(find(el, "p.run-note").textContent).toBe("Le azioni già completate restano.");
	});

	it("lists live actions while running, folds the log once over, and rejects stale or foreign events", async () => {
		const { el } = await control([run("running", { progress: [{ kind: "tool_start", toolName: "web_search", at: "2026-10-25T10:00:00Z" }] })]);
		expect(find(el, "li.run-task.now").textContent).toContain("Cerco sul web");
		mocks.state.onRun(run("running", { updatedAt: "2026-10-25T10:02:00Z", progress: [{ kind: "tool_start", toolName: "web_search", at: "2026-10-25T10:00:00Z" }, { kind: "tool_end", toolName: "web_search", at: "2026-10-25T10:01:00Z" }, { kind: "tool_start", toolName: "web_search", at: "2026-10-25T10:02:00Z" }] }));
		const items = all(el).filter((node) => node.tag.startsWith("li.run-task"));
		expect(items.map((node) => node.tag)).toEqual(["li.run-task.done", "li.run-task.now.enter"]);
		expect(el.querySelector("details")).toBeUndefined();
		mocks.state.onRun(run("failed", { updatedAt: "2026-10-25T10:03:00Z", progress: [{ kind: "tool_start", toolName: "web_search", at: "2026-10-25T10:00:00Z" }] }));
		expect(all(el).some((node) => node.tag === "ol.run-tasks")).toBe(false);
		expect(el.querySelector("details")).toBeDefined();
		expect(mocks.state.onRun(run("succeeded", { updatedAt: "2026-10-25T10:01:00Z" }))).toBe(true);
		expect(el.attrs["data-state"]).toBe("failed");
		expect(mocks.state.onRun(run("succeeded", { threadId: "another-person" }))).toBe(false);
	});

	it("stops the exact conversation and keeps the interruption state authoritative", async () => {
		const { el } = await control([run("running")]);
		mocks.api.mockResolvedValue({ runs: [run("cancelled", { updatedAt: "2026-10-25T10:02:00Z" })] });
		const stop = all(el).find((node) => node.tag.startsWith("button") && node.attrs.title?.startsWith("Interrompi"))!;
		stop.attrs.onclick();
		await vi.waitFor(() => expect(el.attrs["data-state"]).toBe("cancelled"));
		expect(mocks.api).toHaveBeenCalledWith(`${base}/stop`, { method: "POST" });
		expect(stop.hidden).toBe(true);
	});

	it("shows a failed status read as unavailable and allows a read-only recovery", async () => {
		const { el, refresh } = await control([]);
		mocks.api.mockRejectedValue(new Error("offline"));
		await refresh();
		expect(el.hidden).toBe(false);
		expect(el.attrs["data-state"]).toBe("unavailable");
		expect(all(el).find((node) => node.tag.startsWith("button") && node.textContent === "Aggiorna stato")?.hidden).toBe(false);
		mocks.api.mockResolvedValue({ runs: [run("succeeded")] });
		await refresh();
		expect(el.hidden).toBe(true);
		expect(mocks.api.mock.calls.every((args) => args.length === 1)).toBe(true);
	});
});
