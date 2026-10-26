import { beforeEach, describe, expect, it, vi } from "vitest";

type TestNode = {
	tag: string;
	attrs: Record<string, unknown>;
	children: (TestNode | string)[];
	hidden: boolean;
	id: string;
	textContent: string;
	readonly dataset: Record<string, unknown>;
	setAttribute(name: string, value: unknown): void;
	remove(): void;
};

const mocks = vi.hoisted(() => {
	const text = (node: TestNode | string): string => typeof node === "string" ? node : node.children.map(text).join(" ");
	const h = (spec: string, attrs?: unknown, ...children: unknown[]): TestNode => {
		const attributes = attrs && typeof attrs === "object" && !Array.isArray(attrs) && !("tag" in attrs) ? attrs as Record<string, unknown> : {};
		if (attributes !== attrs) children.unshift(attrs);
		return {
			tag: spec,
			attrs: { ...attributes },
			children: children.flat(Infinity).filter((child) => child != null && child !== false).map((child) => typeof child === "object" ? child as TestNode : String(child)),
			hidden: Boolean(attributes.hidden),
			id: "",
			get textContent() { return text(this); },
			set textContent(value) { this.children = [value]; },
			get dataset() { return { section: this.attrs["data-section"] }; },
			setAttribute(name, value) { this.attrs[name] = value; },
			remove() { this.attrs.removed = true; },
		};
	};
	const mount = (node: TestNode, ...children: unknown[]) => { node.children = children.flat(Infinity).filter((child) => child != null && child !== false) as (TestNode | string)[]; };
	const state = { me: { id: "person", role: "owner" } };
	return {
		h,
		mount,
		state,
		api: vi.fn(),
		toast: vi.fn(),
		confirmDialog: vi.fn(),
		face: (agent: { name?: string }) => h("span.face", agent.name ?? ""),
		agentStatus: (agent?: { statusText?: string; doing?: string }) => (agent?.statusText ? h("span.agent-status", h("span.chip", agent.statusText), agent.doing ? h("span.agent-doing", agent.doing) : null) : null),
		icon: (name: string) => h("svg", name),
		emptyNote: (spec: string, title: string, ...children: unknown[]) => h(spec, h("b", title), ...children),
		fmt: { time: (at: string) => `alle ${at.slice(11, 16)}` },
		channelName: (title: string) => `#${title.toLowerCase().replace(/\s+/g, "-")}`,
		dmHref: (id: string, thread?: string) => `#/dm/${id}${thread ? `/t/${thread}` : ""}`,
		instanceHref: (view: string, rest: string[] = [], id?: string) => `#/${[view, ...rest].join("/")}${id ? `?agent=${id}` : ""}`,
		materials: { memorySection: vi.fn(), filesSection: vi.fn(), skillsSection: vi.fn() },
	};
});
vi.mock("../src/web/ui/common.js", () => mocks);
vi.mock("../src/web/ui/agent-materials.js", () => mocks.materials);

// @ts-expect-error Console modules intentionally use plain JavaScript.
import { agentPanel, folded, madeIn, routineRows } from "../src/web/ui/agent-panel.js";

const flatten = (node: TestNode): TestNode[] => [node, ...node.children.flatMap((child) => typeof child === "string" ? [] : flatten(child))];
const find = (node: TestNode, prefix: string) => flatten(node).filter((item) => item.tag.startsWith(prefix));
const inst = { id: "sales", name: "Vendite", tagline: "Segue i clienti" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	mocks.api.mockReset();
	mocks.state.me = { id: "person", role: "owner" };
	for (const section of Object.values(mocks.materials)) section.mockReset();
});

describe("the agente's panel", () => {
	it("says where each artifact was made, as the rail names it", () => {
		expect(madeIn({ kind: "dm" })).toBe("Messaggi diretti");
		expect(madeIn({ kind: "chat", title: "Offerta" })).toBe("«Offerta»");
		expect(madeIn({ kind: "thread", title: "Prezzi" })).toBe("Thread «Prezzi»");
		expect(madeIn({ kind: "channel", title: "Bando regionale" })).toBe("#bando-regionale");
		expect(madeIn({ kind: "channel", title: "Bando regionale", inThread: true })).toBe("#bando-regionale · thread");
		expect(madeIn({ kind: "channel" })).toBe("Un canale");
	});

	it("shows the first rows of a long list and the rest on request", () => {
		const rows = Array.from({ length: 9 }, (_, i) => mocks.h("li", `Riga ${i}`));
		const [list, more] = folded(rows, mocks.h("p", "vuoto"));
		expect(list.children).toHaveLength(6);
		expect(more.textContent).toBe("Mostra tutti (9)");
		(more.attrs.onclick as () => void)();
		expect(list.children).toHaveLength(9);
		expect(more.attrs.removed).toBe(true);
		expect(folded([], mocks.h("p", "vuoto")).textContent).toBe("vuoto");
		expect(folded(rows.slice(0, 3), null).tag).toBe("ul.task-list");
	});

	it("lists every kind of routine in a line, with resume only for a sentinella that stopped", () => {
		const rows = routineRows(inst, {
			schedules: [{ id: "s1", kind: "task", instruction: "Manda il report", when: { cron: "0 9 * * 1", timeZone: "Europe/Rome" }, whenText: "ogni lunedì alle 9", nextRunAt: "2026-10-26T09:00:00.000Z" }],
			watches: [
				{ id: "w1", url: "https://example.com/prezzi", everyMinutes: 60, nextCheckAt: "2026-10-26T10:00:00.000Z", failures: 0 },
				{ id: "w2", url: "https://example.com/", everyMinutes: 30, disabledReason: "Troppi errori", failures: 3 },
			],
			automations: [{ id: "a1", name: "Nuovo ordine", runs: 2 }],
			routines: [{ title: "Chiusura del mese", whenText: "Il primo del mese", paused: true }],
		}, () => {});
		const said = rows.map((row: TestNode) => row.textContent);
		expect(said[0]).toContain("Manda il report");
		expect(said[0]).toContain("Ogni lunedì alle 9 · prossima alle 09:00");
		expect(said[1]).toContain("example.com/prezzi");
		expect(said[1]).toContain("Controlla ogni 60 min · attiva");
		expect(said[1]).not.toContain("Riattiva");
		expect(said[2]).toContain("ferma");
		expect(said[2]).toContain("Troppi errori");
		expect(said[2]).toContain("Riattiva");
		expect(said[3]).toContain("Nuovo ordine");
		expect(said[3]).toContain("2 chiamate");
		expect(said[4]).toContain("Il primo del mese · in pausa");
		expect(find(rows[4], "a.btn")[0]!.attrs.href).toBe("#/board?agent=sales");
	});

	it("resumes a sentinella and deletes a routine only after confirming, then reloads the list", async () => {
		const changed = vi.fn();
		mocks.api.mockResolvedValue({});
		const rows = routineRows(inst, { watches: [{ id: "w2", url: "https://example.com/", everyMinutes: 30, disabledReason: "Troppi errori", failures: 3 }] }, changed);
		const [resume, remove] = find(rows[0], "button.btn") as [TestNode, TestNode];
		(resume.attrs.onclick as () => void)();
		await tick();
		expect(mocks.api).toHaveBeenCalledWith("/api/instances/sales/watches/w2/resume", { method: "POST" });
		(remove.attrs.onclick as () => void)();
		expect(mocks.api).toHaveBeenCalledTimes(1);
		const [, , okLabel, ok] = mocks.confirmDialog.mock.calls[0]!;
		expect(okLabel).toBe("Elimina");
		ok();
		await tick();
		expect(mocks.api).toHaveBeenLastCalledWith("/api/instances/sales/watches/w2", { method: "DELETE" });
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("opens at the section asked, says it to the page and closes with nothing left running", async () => {
		mocks.api.mockImplementation(async (path: string) => (path === "/api/agents" ? { agents: [{ id: "sales", status: "al_lavoro", statusText: "Al lavoro", doing: "Offerta Rossi" }] } : { runs: [] }));
		const onShow = vi.fn();
		const onHide = vi.fn();
		const panel = agentPanel(inst, { onShow, onHide });
		expect(panel.isOpen()).toBe(false);
		panel.show(true, "memoria");
		expect(panel.isOpen()).toBe(true);
		expect(onShow).toHaveBeenLastCalledWith("memoria");
		expect(mocks.materials.memorySection).toHaveBeenCalledTimes(1);
		const tabs = find(panel.el, "button.agent-tab");
		expect(tabs.map((t) => t.textContent)).toEqual(["Attività", "Artifact", "Routine", "Memoria", "Documenti", "Procedure"]);
		expect(tabs.filter((t) => t.attrs["aria-selected"] === "true").map((t) => t.textContent)).toEqual(["Memoria"]);
		await tick();
		expect(find(panel.el, "p.agent-panel-status")[0]!.textContent).toContain("Al lavoro Offerta Rossi");
		// Another tab: loaded once, and the page keeps the address.
		(tabs[0]!.attrs.onclick as () => void)();
		expect(onShow).toHaveBeenLastCalledWith("attivita");
		await tick();
		expect(mocks.api).toHaveBeenCalledWith("/api/instances/sales/runs");
		expect(panel.el.textContent).toContain("Ancora niente");
		panel.show(false);
		expect(panel.isOpen()).toBe(false);
		expect(onHide).toHaveBeenCalledTimes(1);
		expect(find(panel.el, "div.agent-panel-body")[0]!.children).toHaveLength(0);
		panel.show(false);
		expect(onHide).toHaveBeenCalledTimes(1);
	});

	it("gives the configuration only to the owner", () => {
		const href = (panel: { el: TestNode }) => find(panel.el, "a.icon-btn").map((a) => a.attrs.href);
		expect(href(agentPanel(inst))).toEqual(["#/impostazioni?agent=sales"]);
		mocks.state.me = { id: "luca", role: "member" };
		expect(href(agentPanel(inst))).toEqual([]);
	});

	it("opens an artifact in the page's panel, at the version shown", async () => {
		mocks.api.mockImplementation(async (path: string) => (path === "/api/agents" ? { agents: [] } : { artifacts: [{ id: "report", threadId: "t1", title: "Report", version: 2, at: "2026-10-25T09:30:00.000Z", where: { kind: "dm" } }] }));
		const openArtifact = vi.fn();
		const panel = agentPanel(inst, { openArtifact });
		panel.show(true, "artifact");
		await tick();
		expect(panel.el.textContent).toContain("Messaggi diretti · v2 · alle 09:30");
		const open = find(panel.el, "button.btn.small").find((b) => b.textContent === "Apri");
		(open?.attrs.onclick as () => void)();
		expect(openArtifact).toHaveBeenCalledWith("t1", { id: "report", version: 2, title: "Report" });
	});
});
