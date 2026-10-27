import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestNode = {
	tag: string;
	attrs: Record<string, unknown>;
	children: (TestNode | string)[];
	value: string;
	textContent: string;
	isConnected: boolean;
	disabled: boolean;
	selectedOptions: { textContent: string }[];
	setAttribute(name: string, value: unknown): void;
	addEventListener(name: string, handler: unknown): void;
};

const mocks = vi.hoisted(() => {
	const text = (node: TestNode | string): string => typeof node === "string" ? node : node.children.map(text).join(" ");
	const h = (spec: string, attrs?: unknown, ...children: unknown[]): TestNode => {
		const attributes = attrs && typeof attrs === "object" && !Array.isArray(attrs) && !("tag" in attrs) ? attrs as Record<string, unknown> : {};
		if (attributes !== attrs) children.unshift(attrs);
		const node: TestNode = {
			tag: spec,
			attrs: { ...attributes },
			children: children.flat(Infinity).filter((child) => child != null && child !== false).map((child) => typeof child === "object" ? child as TestNode : String(child)),
			value: String(attributes.value ?? ""),
			get textContent() { return text(this); },
			set textContent(value) { this.children = [value]; },
			isConnected: true,
			disabled: Boolean(attributes.disabled),
			selectedOptions: [],
			setAttribute(name, value) { this.attrs[name] = value; },
			addEventListener(name, handler) { this.attrs[`on${name}`] = handler; },
		};
		return node;
	};
	const mount = (node: TestNode, ...children: unknown[]) => { node.children = children.flat(Infinity).filter((child) => child != null && child !== false) as (TestNode | string)[]; };
	const state = { me: { id: "person", role: "owner" }, instance: { id: "unrelated", name: "Unrelated" }, instances: [] as unknown[], onRun: undefined as unknown, onRunsReconnect: undefined as unknown, onBoard: undefined as unknown };
	const instanceHref = (view: string, rest: string[] = [], instanceId: string | null = state.instance.id) => `#/${[view, ...rest].map(encodeURIComponent).join("/")}${instanceId ? `?agent=${encodeURIComponent(instanceId)}` : ""}`;
	return { h, mount, state, instanceHref, dmHref: (id: string, thread?: string) => `#/dm/${encodeURIComponent(id)}${thread ? `/t/${encodeURIComponent(thread)}` : ""}`, api: vi.fn(), route: vi.fn(() => ({ view: "programmi", rest: [] as string[] })), icon: (name: string) => h("svg", name), emptyNote: (spec: string, title: string, ...children: unknown[]) => h(spec, h("h2", title), ...children), head: (_: unknown, title: string, description: string, ...actions: unknown[]) => h("header", h("h1", title), description, ...actions) };
});
vi.mock("../src/web/ui/common.js", () => mocks);

// @ts-expect-error Console modules intentionally use plain JavaScript.
import { programRows, runOutcome, viewPrograms } from "../src/web/ui/pages/work.js";

const at = "2026-10-25T09:00:00.000Z";
const inst = { id: "sales", name: "Vendite", canChat: true };
const viewer = { id: "person", role: "owner" };
const card = (id: string, status: string, extra = {}) => ({ id, n: Number(id) || 1, title: `Lavoro ${id}`, status, description: "Obiettivo reale", createdAt: at, updatedAt: at, events: [], ...extra });
const routine = (title: string) => ({ id: "r1", title, assignee: inst.id, personId: viewer.id, whenText: "ogni lunedì", next: at, createdAt: at });
const run = (id: string, status: string, extra = {}) => ({ id, status, source: "message", sourceId: id, instanceId: "sales", threadId: `thread-${id}`, createdAt: at, updatedAt: at, ...extra });
const flatten = (node: TestNode): TestNode[] => [node, ...node.children.flatMap((child) => typeof child === "string" ? [] : flatten(child))];
const nodes = (node: TestNode, prefix: string) => flatten(node).filter((item) => item.tag.startsWith(prefix));

beforeEach(() => {
	vi.useFakeTimers();
	mocks.api.mockReset();
	mocks.route.mockReturnValue({ view: "programmi", rest: [] });
	mocks.state.instance = { id: "unrelated", name: "Unrelated" };
	mocks.state.me = viewer;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("execution outcomes", () => {
	it("distinguishes queued, stopping, interrupted and delivery-pending outcomes", () => {
		expect(runOutcome(run("1", "queued"))).toBe("In coda");
		expect(runOutcome(run("1", "running", { cancelRequestedAt: at }))).toBe("Interruzione in corso");
		expect(runOutcome(run("1", "cancelled"))).toBe("Interrotta");
		expect(runOutcome(run("1", "succeeded", { delivery: "pending" }))).toBe("Risposta pronta · Consegna in attesa");
		expect(runOutcome(run("1", "succeeded", { delivery: "delivered" }))).toBe("Risposta pronta · Consegnata");
	});

});

describe("automation overview transformations", () => {
	it("combines four existing models with separate configuration, last outcome and next condition", () => {
		const board = { agents: [inst], cards: [card("7", "da_rivedere")], routines: [{ id: "routine", assignee: inst.id, title: "Report ricorrente", personId: viewer.id, whenText: "ogni lunedì", next: at, last: "7", createdAt: at }] };
		const groups = [{ instance: inst, schedules: [{ id: "schedule", instruction: "Controlla le mail", when: { cron: "0 9 * * *", timeZone: "Europe/Rome" }, nextRunAt: at, lastRunAt: at, createdAt: at, channel: "web", createdBy: { kind: "person", channel: "web", userId: viewer.id } }], watches: [{ id: "watch", url: "https://example.com/product", everyMinutes: 60, nextCheckAt: at, lastCheckAt: at, below: 50, failures: 1, lastError: "Pagina non disponibile", notified: 2, createdAt: at }], automations: [{ id: "auto", name: "Nuovo ordine", instruction: "Riassumi l'ordine", lastRunAt: at, runs: 3, createdAt: at, mine: false, channel: "whatsapp", path: "/secret/path", token: "DO_NOT_PREVIEW", receivedBody: "PRIVATE_PAYLOAD" }], runs: [run("s", "succeeded", { source: "schedule", sourceId: "schedule", delivery: "delivered" }), run("a", "failed", { source: "automation", sourceId: "auto" })] }];
		const rows = programRows(board, groups, viewer);
		expect(rows.map((row: { kind: string }) => row.kind)).toEqual(["orario", "pagina", "evento", "incarico"]);
		expect(rows[0].statusLabel).toBe("Attiva");
		expect(rows[0].outcome).toContain("Risposta pronta · Consegnata");
		expect(rows[0].next).toContain("Europe/Rome");
		expect(rows[1].statusLabel).toBe("Errori nel controllo");
		expect(rows[1].next).toContain("Prezzo sotto 50");
		expect(rows[1].problem).toBe("Pagina non disponibile");
		expect(rows[2].statusLabel).toBe("Configurata");
		expect(rows[2].outcome).toContain("Non riuscita");
		expect(rows[2].destination).toContain("un'altra persona");
		expect(rows[3].outcome).toBe("#7 · Da rivedere");
		expect(rows[3].next).toContain("Attende che #7 sia Fatto");
		expect(JSON.stringify(rows)).not.toMatch(/DO_NOT_PREVIEW|PRIVATE_PAYLOAD|secret\/path/);
	});

	it("does not borrow another agent's run outcome for an identical source id", () => {
		const schedule = { id: "same", instruction: "Report", when: { at }, nextRunAt: null, createdAt: at };
		const rows = programRows({}, [{ instance: inst, schedules: [schedule], runs: [run("r", "failed", { source: "schedule", sourceId: "same" })] }, { instance: { id: "support", name: "Assistenza" }, schedules: [schedule], runs: [], runsAvailable: false }], viewer);
		expect(rows[0].outcome).toContain("Non riuscita");
		expect(rows[1].outcome).toContain("Esiti non disponibili");
		expect(rows[0].href).toBe("#/task?agent=sales");
		expect(rows[1].href).toBe("#/task?agent=support");
		expect(rows[1].statusLabel).toBe("Terminata");
	});

	it("keeps a paused routine separate from its unfinished last assignment", () => {
		const [row] = programRows({ agents: [inst], cards: [card("7", "in_corso")], routines: [{ id: "r", title: "Report", assignee: inst.id, personId: viewer.id, whenText: "ogni giorno", paused: true, next: at, last: "7", problem: "Agente non disponibile", createdAt: at }] }, [], viewer);
		expect(row.statusLabel).toBe("In pausa");
		expect(row.outcome).toBe("#7 · In corso");
		expect(row.next).toBe("In pausa: non crea nuovi incarichi");
		expect(row.lastHref).toBe("#/board/7");
	});
});

describe("automation overview reads and recovery", () => {
	it("provides the four program choices without creating or executing anything", async () => {
		mocks.api.mockImplementation(async (url: string) => url === "/api/instances" ? { instances: [] } : { cards: [], agents: [], routines: [] });
		const main = mocks.h("main");
		await viewPrograms(main);
		const choices = nodes(main, "button.work-program-choice");
		expect(choices).toHaveLength(4);
		expect(choices.map((node) => node.textContent).join(" ")).toContain("Ripeti un incarico");
		expect(mocks.api.mock.calls.every((call) => call.length === 1)).toBe(true);
		expect(mocks.state.instance.id).toBe("unrelated");
	});

	it("limits the agent filter to the accessible roster rather than the Board directory", async () => {
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [inst] };
			if (url === "/api/board") return { cards: [], agents: [inst, { id: "hidden", name: "Hidden agent directory entry" }], routines: [] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			for (const name of ["runs", "threads", "schedules", "watches", "automations"]) if (url.endsWith(`/${name}`)) return { [name]: [] };
			throw new Error(`Unexpected request ${url}`);
		});
		const main = mocks.h("main");
		await viewPrograms(main);
		const filter = nodes(main, "select")[0]!;
		expect(filter.textContent).toContain(inst.name);
		expect(filter.textContent).not.toContain("Hidden agent directory entry");
		expect(nodes(filter, "option").some((option) => option.value === "hidden")).toBe(false);
		expect(mocks.api.mock.calls.some(([url]) => String(url).includes("/instances/hidden/"))).toBe(false);
	});

	it("drops a retained source after its access is revoked instead of redisplaying private content", async () => {
		let revoked = false;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			if (url === "/api/board" && revoked) throw Object.assign(new Error("Accesso revocato"), { status: 403 });
			return { cards: [], agents: [inst], routines: [routine("Contenuto precedentemente autorizzato")] };
		});
		const main = mocks.h("main");
		await viewPrograms(main);
		expect(main.textContent).toContain("Contenuto precedentemente autorizzato");
		revoked = true;
		(mocks.state.onBoard as () => void)();
		await vi.waitFor(() => expect(main.textContent).toContain("Accesso revocato"));
		expect(main.textContent).not.toContain("Contenuto precedentemente autorizzato");
	});

	it.each([false, true])("invalidates cached Board content after revocation during a Board failure (initial roster failed: %s)", async (initialRosterFails) => {
		let revoked = false;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances" && initialRosterFails && !revoked) throw new Error("Elenco agenti temporaneamente non disponibile");
			if (url === "/api/instances") return { instances: revoked ? [] : [inst] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			if (url === "/api/board" && revoked) throw new Error("Board temporaneamente non disponibile");
			if (url === "/api/board") return { cards: [], agents: [inst], routines: [{ ...routine("Titolo riservato di un'altra persona"), description: "Descrizione riservata" }] };
			for (const name of ["runs", "schedules", "watches", "automations"]) if (url.endsWith(`/${name}`)) return { [name]: [] };
			throw new Error(`Unexpected request ${url}`);
		});
		const main = mocks.h("main");
		await viewPrograms(main);
		expect(main.textContent).toContain("Descrizione riservata");
		revoked = true;
		(mocks.state.onBoard as () => void)();
		await vi.waitFor(() => expect(main.textContent).toContain("Board temporaneamente non disponibile"));
		expect(main.textContent).not.toContain("Titolo riservato di un'altra persona");
		expect(main.textContent).not.toContain("Descrizione riservata");
		expect(nodes(main, "select")[0]?.textContent).not.toContain("Vendite");
	});

	it("shows available automation models when another model's first read fails", async () => {
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [inst] };
			if (url === "/api/board") return { cards: [], agents: [inst], routines: [] };
			if (url.endsWith("/schedules")) return { schedules: [{ id: "s", instruction: "Controlla preventivi", when: { cron: "0 9 * * *", timeZone: "Europe/Rome" }, nextRunAt: at, createdAt: at }] };
			if (url.endsWith("/watches")) throw new Error("Controlli pagina non disponibili");
			if (url.endsWith("/automations")) return { automations: [] };
			if (url.endsWith("/runs")) return { runs: [] };
			throw new Error(`Unexpected request ${url}`);
		});
		const main = mocks.h("main");
		await viewPrograms(main);
		expect(main.textContent).toContain("Controlla preventivi");
		expect(main.textContent).toContain("1 automazione");
		expect(main.textContent).toContain("Dati parziali");
		expect(main.textContent).toContain("Controlli pagina non disponibili");
	});
});
