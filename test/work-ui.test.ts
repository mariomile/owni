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
	return { h, mount, state, instanceHref, dmHref: (id: string, thread?: string) => `#/dm/${encodeURIComponent(id)}${thread ? `/t/${encodeURIComponent(thread)}` : ""}`, api: vi.fn(), route: vi.fn(() => ({ view: "lavori", rest: [] as string[] })), icon: (name: string) => h("svg", name), emptyNote: (spec: string, title: string, ...children: unknown[]) => h(spec, h("h2", title), ...children), head: (_: unknown, title: string, description: string, ...actions: unknown[]) => h("header", h("h1", title), description, ...actions) };
});
vi.mock("../src/web/ui/common.js", () => mocks);

// @ts-expect-error Console modules intentionally use plain JavaScript.
import { matchesWorkFilter, needsBoardReview, pendingApprovalRows, programRows, runOutcome, viewPrograms, viewWork, workRows } from "../src/web/ui/pages/work.js";

const at = "2026-10-25T09:00:00.000Z";
const inst = { id: "sales", name: "Vendite", canChat: true, hasSegreteria: false };
const viewer = { id: "person", role: "owner" };
const card = (id: string, status: string, extra = {}) => ({ id, n: Number(id) || 1, title: `Lavoro ${id}`, status, description: "Obiettivo reale", createdAt: at, updatedAt: at, events: [], ...extra });
const run = (id: string, status: string, extra = {}) => ({ id, status, source: "message", sourceId: id, instanceId: "sales", threadId: `thread-${id}`, createdAt: at, updatedAt: at, ...extra });
const flatten = (node: TestNode): TestNode[] => [node, ...node.children.flatMap((child) => typeof child === "string" ? [] : flatten(child))];
const nodes = (node: TestNode, prefix: string) => flatten(node).filter((item) => item.tag.startsWith(prefix));

beforeEach(() => {
	vi.useFakeTimers();
	mocks.api.mockReset();
	mocks.route.mockReturnValue({ view: "lavori", rest: [] });
	mocks.state.instance = { id: "unrelated", name: "Unrelated" };
	mocks.state.me = viewer;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("person-facing work transformations", () => {
	it("keeps another person's board review out of the owner's attention filter", () => {
		const worked = card("1", "da_rivedere", { assignee: "sales", work: { agent: "sales", personId: "other", threadId: "private" } });
		expect(needsBoardReview(worked, viewer)).toBe(false);
		expect(needsBoardReview(worked, { id: "other", role: "member" })).toBe(true);
		expect(needsBoardReview(card("2", "da_rivedere"), viewer)).toBe(true);
		expect(needsBoardReview(card("2", "da_rivedere"), { id: "member", role: "member" })).toBe(false);
		expect(needsBoardReview({ ...worked, assignee: "another-agent" }, viewer)).toBe(true);
		expect(needsBoardReview({ ...worked, status: "fatto" }, viewer)).toBe(false);
	});

	it("preserves all four board states, unassigned work and visible or hidden dependencies", () => {
		const cards = [card("1", "da_fare", { after: ["2", "hidden"], queued: { personId: viewer.id } }), card("2", "in_corso", { assignee: inst.id }), card("3", "da_rivedere", { assignee: inst.id }), card("4", "fatto", { assignee: inst.id })];
		const rows = workRows({ cards, agents: [inst] }, [], viewer);
		expect(rows.map((row: { status: string }) => row.status)).toEqual(["da_fare", "in_corso", "da_rivedere", "fatto"]);
		const waiting = rows[0];
		expect(waiting.agentName).toBe("Non assegnato");
		expect(waiting.blockers).toContain("#2, un incarico non visibile");
		expect(waiting.blockers).toContain("poi parte da solo");
		expect(waiting.href).toBe("#/board/1");
		expect(matchesWorkFilter(waiting, "tutti", "__unassigned")).toBe(true);
		expect(matchesWorkFilter(waiting, "in_corso")).toBe(false);
		expect(rows.filter((row: unknown) => matchesWorkFilter(row, "conclusi"))).toHaveLength(1);
	});

	it("uses the latest review's result and does not label a ready reply as an accepted assignment", () => {
		const reviewed = card("1", "da_rivedere", { assignee: inst.id, work: { agent: inst.id, personId: viewer.id, threadId: "thread-r" }, events: [{ kind: "status", status: "da_rivedere" }, { kind: "comment", by: { kind: "agent" }, text: "Vecchio risultato" }, { kind: "status", status: "in_corso" }, { kind: "status", status: "da_rivedere" }, { kind: "comment", by: { kind: "agent" }, text: "Risultato aggiornato" }] });
		const rows = workRows({ cards: [reviewed], agents: [inst] }, [{ instance: inst, runs: [run("r", "succeeded", { delivery: "failed" })], threads: [{ id: "thread-r", title: "Preventivo cliente" }] }], viewer);
		const assignment = rows.find((row: { kind: string }) => row.kind === "board");
		const execution = rows.find((row: { kind: string }) => row.kind === "run");
		expect(assignment.detail).toBe("Risultato aggiornato");
		expect(assignment.concluded).toBe(false);
		expect(assignment.action).toBe("Rivedi il risultato");
		expect(execution.title).toBe("Preventivo cliente");
		expect(execution.statusLabel).toBe("Risposta pronta · Consegna non riuscita");
		expect(execution.action).toBe("Vedi problema");
		expect(execution.href).toBe("#/dm/sales/t/thread-r");
		expect(execution.attention).toBe(false);
		expect(mocks.state.instance.id).toBe("unrelated");
	});

	it("distinguishes queued, stopping, interrupted and delivery-pending outcomes", () => {
		expect(runOutcome(run("1", "queued"))).toBe("In coda");
		expect(runOutcome(run("1", "running", { cancelRequestedAt: at }))).toBe("Interruzione in corso");
		expect(runOutcome(run("1", "cancelled"))).toBe("Interrotta");
		expect(runOutcome(run("1", "succeeded", { delivery: "pending" }))).toBe("Risposta pronta · Consegna in attesa");
		expect(runOutcome(run("1", "succeeded", { delivery: "delivered" }))).toBe("Risposta pronta · Consegnata");
	});

	it("routes all six pending approval types to their precise agent and record, including a ready practice", () => {
		const groups = [{ instance: { id: "sales/team", name: "Vendite", isApprover: true }, proposals: [{ id: "p/1", status: "pending", name: "report", hosts: ["example.com"] }, { id: "done", status: "approved" }], webActions: [{ id: "w1", status: "pending", action: "https://shop.example/order" }], connectorActions: [{ id: "c1", status: "pending", tool: "delete_page", toolTitle: "Elimina pagina", connectorName: "Documenti", destructive: true }], agentRequests: [{ id: "a1", status: "pending", what: "Emettere la fattura", tool: "sales_invoices", askedBy: { name: "Commerciale" } }], googleActions: [{ id: "g1", status: "pending", kind: "mail.send", account: "me@example.com", mail: { subject: "Preventivo", to: ["client@example.com"], cc: [] } }], pratiche: [{ praticaId: "pr1", status: "draft_ready", lead: { rawSubject: "Richiesta prezzo", email: "lead@example.com" } }, { praticaId: "sent", status: "sent" }] }];
		const rows = pendingApprovalRows(groups);
		expect(rows).toHaveLength(6);
		expect(rows.map((row: { type: string }) => row.type)).toEqual(["proposal", "web", "connector", "agent", "google", "pratica"]);
		expect(rows[0].href).toBe("#/approvazioni/proposal/sales%2Fteam/p%2F1");
		expect(rows[5].href).toBe("#/approvazioni/pratica/sales%2Fteam/pr1");
		expect(rows[2].consequence).toContain("Può cancellare o sovrascrivere");
		expect(rows[3].consequence).toContain("Commerciale");
		expect(rows[4].consequence).toContain("client@example.com");
		expect(rows.every((row: { agentName: string; attention: boolean }) => row.agentName === "Vendite" && row.attention)).toBe(true);
		expect(rows.some((row: { href: string }) => row.href.includes("unrelated"))).toBe(false);
	});

	it("trusts requester and personal Google eligibility from the server without requiring owner or approver", () => {
		const rows = pendingApprovalRows([{ instance: { ...inst, isApprover: false }, webActions: [{ id: "w", status: "pending", action: "https://example.com" }], googleActions: [{ id: "g", status: "pending", kind: "mail.draft", account: "personal@example.com", mail: { subject: "Bozza", to: ["client@example.com"], cc: ["copy@example.com"] } }, { id: "calendar", status: "pending", kind: "calendar.delete", account: "personal@example.com", current: { summary: "Riunione" }, notify: true }] }]);
		expect(rows).toHaveLength(3);
		expect(rows[1].title).toContain("Salva la bozza");
		expect(rows[1].consequence).toContain("Salva una bozza in Gmail");
		expect(rows[1].consequence).toContain("Cc: copy@example.com");
		expect(rows[2].title).toBe("Cancella l'evento: Riunione");
		expect(rows[2].consequence).toContain("Google avvisa gli invitati");
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

describe("work overview reads and recovery", () => {
	it("loads all permitted agents independently of the selected chat, exposes a failed source and retries", async () => {
		let failSales = true;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [inst, { id: "support", name: "Assistenza", canChat: true }] };
			if (url === "/api/board") return { cards: [card("1", "da_fare")], agents: [inst], routines: [] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			if (url.endsWith("/threads")) return { threads: [] };
			if (url === "/api/instances/sales/runs" && failSales) throw new Error("Agente temporaneamente irraggiungibile");
			if (url.endsWith("/runs")) return { runs: [run(url.includes("support") ? "support-run" : "sales-run", "succeeded")] };
			throw new Error(`Unexpected request ${url}`);
		});
		const main = mocks.h("main");
		await viewWork(main);
		expect(main.textContent).toContain("Vista parziale");
		expect(main.textContent).toContain("Dati parziali");
		expect(main.textContent).toContain("Agente temporaneamente irraggiungibile");
		expect(main.textContent).toContain("Lavoro 1");
		expect(main.textContent).toContain("Assistenza");
		expect(mocks.api.mock.calls.some(([url]) => url === "/api/instances/support/runs")).toBe(true);
		expect(mocks.api.mock.calls.some(([url]) => String(url).includes("unrelated"))).toBe(false);
		failSales = false;
		const retry = nodes(main, "button").find((node) => node.textContent === "Riprova le fonti");
		(retry?.attrs.onclick as () => void)();
		await vi.waitFor(() => expect(main.textContent).not.toContain("Vista parziale"));
		expect(main.textContent).toContain("2 esecuzioni recenti");
		expect(mocks.api.mock.calls.every((call) => call.length === 1)).toBe(true);
		expect(mocks.state.instance.id).toBe("unrelated");
	});

	it("retains already loaded work after a refresh failure and never presents the retained counts as complete", async () => {
		let boardFails = false;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			if (url === "/api/board" && boardFails) throw new Error("Board offline");
			return { cards: [card("1", "in_corso", { assignee: "sales" })], agents: [inst], routines: [] };
		});
		const main = mocks.h("main");
		await viewWork(main);
		expect(main.textContent).toContain("Lavoro 1");
		boardFails = true;
		const refresh = nodes(main, "button").find((node) => node.textContent === "Aggiorna");
		(refresh?.attrs.onclick as () => void)();
		await vi.waitFor(() => expect(main.textContent).toContain("Board offline"));
		expect(main.textContent).toContain("Lavoro 1");
		expect(main.textContent).toContain("Dati parziali");
	});

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

	it.each([["work", viewWork], ["programs", viewPrograms]] as const)("limits the %s agent filter to the accessible roster rather than the Board directory", async (_name, view) => {
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [inst] };
			if (url === "/api/board") return { cards: [], agents: [inst, { id: "hidden", name: "Hidden agent directory entry" }], routines: [] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			for (const name of ["runs", "threads", "schedules", "watches", "automations"]) if (url.endsWith(`/${name}`)) return { [name]: [] };
			throw new Error(`Unexpected request ${url}`);
		});
		const main = mocks.h("main");
		await view(main);
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
			return { cards: [card("1", "in_corso", { title: "Contenuto precedentemente autorizzato" })], agents: [inst], routines: [] };
		});
		const main = mocks.h("main");
		await viewWork(main);
		expect(main.textContent).toContain("Contenuto precedentemente autorizzato");
		revoked = true;
		const refresh = nodes(main, "button").find((node) => node.textContent === "Aggiorna");
		(refresh?.attrs.onclick as () => void)();
		await vi.waitFor(() => expect(main.textContent).toContain("Accesso revocato"));
		expect(main.textContent).not.toContain("Contenuto precedentemente autorizzato");
	});

	it("drops cached approvals when visibility refresh succeeds but the aggregate refresh fails", async () => {
		let revoked = false;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: revoked ? [] : [inst] };
			if (url === "/api/board") return { cards: [], agents: [], routines: [] };
			if (url === "/api/approvals" && revoked) throw new Error("Inbox non disponibile");
			if (url === "/api/approvals") return { groups: [{ instance: inst, proposals: [{ id: "secret", name: "private_tool", description: "Descrizione riservata", status: "pending", hosts: [] }] }], pendingApprovals: 1 };
			if (url.endsWith("/runs")) return { runs: [] };
			return { threads: [] };
		});
		const main = mocks.h("main");
		await viewWork(main);
		expect(main.textContent).toContain("Descrizione riservata");
		revoked = true;
		(nodes(main, "button").find((node) => node.textContent === "Aggiorna")?.attrs.onclick as () => void)();
		await vi.waitFor(() => expect(main.textContent).toContain("Inbox non disponibile"));
		expect(main.textContent).not.toContain("Descrizione riservata");
		expect(nodes(main, "select")[0]?.textContent).not.toContain("Vendite");
	});

	it.each([false, true])("invalidates cached Board content after revocation during a Board failure (initial roster failed: %s)", async (initialRosterFails) => {
		let revoked = false;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances" && initialRosterFails && !revoked) throw new Error("Elenco agenti temporaneamente non disponibile");
			if (url === "/api/instances") return { instances: revoked ? [] : [inst] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			if (url === "/api/board" && revoked) throw new Error("Board temporaneamente non disponibile");
			if (url === "/api/board") return { cards: [card("1", "in_corso", { assignee: inst.id, title: "Titolo riservato di un'altra persona", description: "Descrizione riservata" })], agents: [inst], routines: [] };
			return url.endsWith("/runs") ? { runs: [] } : { threads: [] };
		});
		const main = mocks.h("main");
		await viewWork(main);
		expect(main.textContent).toContain("Descrizione riservata");
		revoked = true;
		(nodes(main, "button").find((node) => node.textContent === "Aggiorna")?.attrs.onclick as () => void)();
		await vi.waitFor(() => expect(main.textContent).toContain("Board temporaneamente non disponibile"));
		expect(main.textContent).not.toContain("Titolo riservato di un'altra persona");
		expect(main.textContent).not.toContain("Descrizione riservata");
		expect(nodes(main, "select")[0]?.textContent).not.toContain("Vendite");
	});

	it("skips Segreteria conversation resources while preserving administrative reads without chat access", async () => {
		const secretary = { id: "secretary", name: "Segreteria", hasSegreteria: true, canChat: false };
		const administrative = { ...inst, canChat: false };
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [secretary, administrative] };
			if (url === "/api/board") return { cards: [], agents: [], routines: [] };
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			for (const name of ["runs", "threads", "schedules", "watches", "automations"]) if (url.endsWith(`/${name}`)) {
				if (url.includes("/secretary/") && ["runs", "threads"].includes(name)) throw new Error("Nessun canale web");
				return { [name]: [] };
			}
			throw new Error(`Unexpected request ${url}`);
		});
		const work = mocks.h("main");
		await viewWork(work);
		expect(work.textContent).not.toContain("Vista parziale");
		const programs = mocks.h("main");
		await viewPrograms(programs);
		expect(programs.textContent).not.toContain("Dati parziali");
		expect(mocks.api.mock.calls.some(([url]) => String(url).includes("/secretary/runs") || String(url).includes("/secretary/threads"))).toBe(false);
		expect(mocks.api.mock.calls.some(([url]) => url === "/api/instances/sales/threads")).toBe(true);
		expect(mocks.api.mock.calls.some(([url]) => url === "/api/instances/sales/runs")).toBe(true);
	});

	it("refreshes Board events without resetting work status and agent filters", async () => {
		let reads = 0;
		mocks.api.mockImplementation(async (url: string) => {
			if (url === "/api/instances") return { instances: [inst] };
			if (url === "/api/board") { reads++; return { cards: [card("1", "in_corso", { assignee: inst.id }), card("2", "fatto", { assignee: inst.id })], agents: [inst], routines: [] }; }
			if (url === "/api/approvals") return { groups: [], pendingApprovals: 0 };
			return url.endsWith("/runs") ? { runs: [] } : { threads: [] };
		});
		const main = mocks.h("main");
		await viewWork(main);
		(nodes(main, "button").find((node) => node.textContent === "In corso")?.attrs.onclick as () => void)();
		const select = nodes(main, "select")[0]!;
		select.value = inst.id;
		(select.attrs.onchange as () => void)();
		(mocks.state.onBoard as () => void)();
		await vi.waitFor(() => expect(reads).toBe(2));
		await vi.waitFor(() => expect(main.textContent).not.toContain("Aggiornamento…"));
		expect(select.value).toBe(inst.id);
		expect(nodes(main, "button").find((node) => node.textContent === "In corso")?.attrs["aria-pressed"]).toBe("true");
		expect(main.textContent).not.toContain("Lavoro 2");
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
		expect(main.textContent).toContain("1 automazione caricata");
		expect(main.textContent).toContain("Dati parziali");
		expect(main.textContent).toContain("Controlli pagina non disponibili");
	});
});
