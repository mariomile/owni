import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CHANNEL } from "../src/core/agent-messages.ts";
import { BoardStore } from "../src/core/board.ts";
import { BoardWork } from "../src/core/board-work.ts";
import type { OwniTool, ToolContext } from "../src/core/engine.ts";
import { cardSubjects, OVERLAP_GENERIC, overlapText, sameParty, SubjectLedger, type SubjectSeam, type SubjectStores, subjectsKey, syncAgent, withSubjects } from "../src/core/subjects.ts";
import { createBoardTools } from "../src/core/tools/board-tools.ts";

const OWNER = { channel: "web", threadId: "w-owner" };
const MEMBER = { channel: "web", threadId: "w-member" };
const fresh = (o: Partial<ToolContext> = {}): ToolContext => ({ step: (_k, work) => work(), progress: () => {}, origin: "person", signal: new AbortController().signal, callId: `c${Math.random()}`, thread: OWNER, ...o }) as ToolContext;
const member = () => fresh({ thread: MEMBER });

/** One agente's registers in memory: what the fake tools below write. */
function registers() {
	const books = {
		clients: [] as { id: string; name: string; vat?: string; cf?: string; note?: string }[],
		suppliers: [] as { id: string; name: string; vat?: string }[],
		quotes: [] as { number: string; customer: { name: string; vat?: string; fiscal?: string } }[],
		orders: [] as { id: string; supplier: { key: string; name: string; vat?: string } }[],
		appointments: [] as { id: string; client: { name: string } }[],
		sales: [] as { id: string; buyer: { name: string; vat?: string } }[],
		ddt: [] as { id: string; client: { name: string; vat?: string } }[],
	};
	const reads: string[] = [];
	const read = <T>(register: string, book: () => T) => () => {
		reads.push(register);
		return book();
	};
	const stores = {
		clients: { read: read("clients", () => ({ cards: books.clients, broken: false })) },
		suppliers: { read: read("suppliers", () => ({ cards: books.suppliers, broken: false })) },
		quotes: { read: read("quotes", () => ({ quotes: books.quotes, broken: false })) },
		orders: { read: read("orders", () => ({ orders: books.orders, broken: false })) },
		appointments: { read: read("appointments", () => ({ appointments: books.appointments, broken: false })) },
		sales: { read: read("sales", () => ({ invoices: books.sales, broken: false })) },
		ddt: { read: read("ddt", () => ({ ddts: books.ddt, broken: false })) },
	} as unknown as SubjectStores;
	return { books, stores, reads };
}

/** A register tool: «list» reads, anything else runs `write`. */
const tool = (name: string, write: (args: Record<string, unknown>) => void): OwniTool => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
	replaySafe: true,
	async execute(args) {
		if (args.op !== "list") write(args);
		return `fatto ${String(args.op)}`;
	},
});

const NAMES: Record<string, string> = { vendite: "Vendite", acquisti: "Acquisti" };

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "owni-subjects-"));
	const ledger = new SubjectLedger(dir, "test-key");
	const board = new BoardStore(dir);
	const logs: string[] = [];
	const agent = (id: string, before: (books: ReturnType<typeof registers>["books"]) => void = () => {}) => {
		const { books, stores, reads } = registers();
		before(books);
		const seam: SubjectSeam = { ledger, agent: id, stores, agentName: async (a) => NAMES[a] ?? a, isOwner: async (thread) => thread?.threadId === OWNER.threadId, cardShown: (c) => board.get(c) !== undefined };
		const tools = withSubjects(
			[
				tool("clients", (a) => {
					if (a.op === "remove") books.clients.splice(0, books.clients.length, ...books.clients.filter((c) => c.id !== a.id));
					else books.clients.splice(0, books.clients.length, ...books.clients.filter((c) => c.id !== a.id), { id: String(a.id), name: String(a.name), ...(typeof a.vat === "string" ? { vat: a.vat } : {}), ...(typeof a.note === "string" ? { note: a.note } : {}) });
				}),
				tool("orders", (a) => void books.orders.push({ id: String(a.id), supplier: { key: "k", name: String(a.name), ...(typeof a.vat === "string" ? { vat: a.vat } : {}) } })),
				tool("quotes", (a) => void books.quotes.push({ number: String(a.id), customer: { name: String(a.name) } })),
				tool("weather", () => {}),
			],
			seam,
			(m) => void logs.push(m),
		);
		const run = async (name: string, args: Record<string, unknown>, ctx = fresh()) => String(await (tools.find((t) => t.name === name) as OwniTool).execute(args, ctx));
		return { books, stores, reads, seam, tools, run };
	};
	return { dir, ledger, board, agent, logs };
}

describe("il registro di chi segue cosa (ADR 0110)", () => {
	it("records the writes of two registers, warns the owner with ids, kinds and the scheda only", async () => {
		const { dir, ledger, board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		// Reads leave the ledger alone.
		expect(await vendite.run("clients", { op: "list" })).toBe("fatto list");
		expect(await acquisti.run("orders", { op: "list" })).toBe("fatto list");

		expect(await vendite.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa S.r.l.", vat: "01234567890" })).toBe("fatto upsert");
		expect(await vendite.run("quotes", { op: "create", id: "2026-004", name: "Alfa srl" })).toBe("fatto create");
		const card = board.create({ title: "Offerta Alfa" }, { kind: "agent", id: "vendite" });
		expect(await cardSubjects(vendite.seam).link(card, ["2026-004"], OWNER)).toBe("");

		// Acquisti orders from the same company, spelled otherwise: the same partita IVA, the same name and form.
		const said = await acquisti.run("orders", { op: "create", id: "OR-0003", name: "ALFA SRL", vat: "IT01234567890" });
		expect(said).toBe(`fatto create\n\nAttenzione, lo stesso cliente o fornitore lo segue anche un altro agente: Vendite ha già preventivo 2026-004 (scheda #${card.n}); Vendite ha già cliente CL-0001. Dillo alla persona prima di andare avanti.`);
		// Counts-only: no name, no partita IVA, in the warning or in the file.
		for (const text of [said, readFileSync(join(dir, "subjects.json"), "utf8")]) {
			expect(text).not.toMatch(/alfa/i);
			expect(text).not.toContain("01234567890");
		}

		// Vendite writing again about Alfa hears of Acquisti's order.
		expect(await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Alfa" })).toContain("Acquisti ha già ordine OR-0003.");
		// A client nobody else has: no warning.
		expect(await vendite.run("clients", { op: "upsert", id: "CL-0003", name: "Beta" })).toBe("fatto upsert");

		// Persisted: a new ledger on the same folder has the entries, with the agente, kind, scheda and when.
		const again = new SubjectLedger(dir, "test-key").list();
		expect(again.map((e) => `${e.agent} ${e.kind} ${e.id}${e.card ? ` #${e.card.n}` : ""}`).sort()).toEqual(["acquisti ordine OR-0003", "vendite cliente CL-0001", "vendite cliente CL-0002", "vendite cliente CL-0003", `vendite preventivo 2026-004 #${card.n}`]);
		expect(again.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
		expect(ledger.list()).toHaveLength(5);
	});

	it("a person who is not the owner hears only that another agente has it: no agente, no record, no scheda", async () => {
		const { board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await vendite.run("quotes", { op: "create", id: "2026-004", name: "Alfa srl" });
		const card = board.create({ title: "Offerta Alfa" }, { kind: "agent", id: "vendite" });
		await cardSubjects(vendite.seam).link(card, ["2026-004"], OWNER);
		const said = await acquisti.run("orders", { op: "create", id: "OR-0003", name: "Alfa srl" }, member());
		expect(said).toBe(`fatto create\n\n${OVERLAP_GENERIC}`);
		expect(said).not.toMatch(/Vendite|2026-004|preventivo|#\d/);
		// Nor through a scheda.
		const own = board.create({ title: "Ordine" }, { kind: "agent", id: "acquisti" });
		expect(await cardSubjects(acquisti.seam).link(own, ["OR-0003"], MEMBER)).toBe(OVERLAP_GENERIC);
		// Nor in a conversation that is not the console.
		expect(await acquisti.run("orders", { op: "create", id: "OR-0004", name: "Alfa" }, fresh({ thread: { channel: "telegram", threadId: "7" } }))).toBe(`fatto create\n\n${OVERLAP_GENERIC}`);
	});

	it("matching: both with a number, the number decides; by name, a different legal form is another company", async () => {
		const { agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await vendite.run("clients", { op: "upsert", id: "CL-0001", name: "Rossi Srl", vat: "01234567890" });
		// The same name, another partita IVA: not the same company.
		expect(await acquisti.run("orders", { op: "create", id: "OR-0001", name: "Rossi Srl", vat: "09876543210" })).toBe("fatto create");
		// The same name, another legal form, no number on one side: not the same company.
		expect(await acquisti.run("orders", { op: "create", id: "OR-0002", name: "Rossi SpA" })).toBe("fatto create");
		// The same name, no legal form: it may be.
		expect(await acquisti.run("orders", { op: "create", id: "OR-0003", name: "Rossi" })).toContain("Vendite ha già cliente CL-0001.");

		const l = new SubjectLedger(mkdtempSync(join(tmpdir(), "owni-subjects-")), "k1");
		expect(l.party({ name: "Alfa S.r.l.", vat: "01234567890" })).toEqual(l.party({ name: "alfa srl", vat: "IT 01234567890" }));
		// A company's codice fiscale is its partita IVA.
		expect(l.party({ name: "Alfa", cf: "01234567890" }).ids).toEqual(l.party({ vat: "IT01234567890" }).ids);
		expect(sameParty(l.party({ name: "Rossi Srl" }), l.party({ name: "Rossi SpA" }))).toBe(false);
		expect(sameParty(l.party({ name: "Rossi Srl", vat: "01234567890" }), l.party({ name: "Rossi SpA", vat: "01234567890" }))).toBe(true);
		expect(sameParty(l.party({ name: "Rossi Srl", vat: "01234567890" }), l.party({ name: "Rossi Srl", vat: "09876543210" }))).toBe(false);
		// Pseudonyms: an HMAC under the tenant's key, another key gives others.
		const p = l.party({ name: "Alfa Srl", vat: "01234567890" });
		expect([...p.ids, p.name].every((k) => /^[0-9a-f]{32}$/.test(String(k)))).toBe(true);
		expect(p.form).toBe("srl");
		expect(new SubjectLedger(mkdtempSync(join(tmpdir(), "owni-subjects-")), "k2").party({ name: "Alfa Srl", vat: "01234567890" }).ids).not.toEqual(p.ids);
	});

	it("a record saved again about the same client is not news; about another one it is", async () => {
		const { agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await vendite.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa" });
		expect(await acquisti.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa" })).toContain("Vendite ha già cliente CL-0001.");
		// Changed, the same client: the entry is touched, no warning.
		expect(await acquisti.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa", note: "paga a 60 giorni" })).toBe("fatto upsert");
		// Now about Beta, whom nobody else has: no warning; back on Alfa: warned.
		expect(await acquisti.run("clients", { op: "upsert", id: "CL-0001", name: "Beta" })).toBe("fatto upsert");
		expect(await acquisti.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa" })).toContain("Vendite ha già cliente CL-0001.");
	});

	it("a write reads only the registers its tool writes, all of them in one go", async () => {
		const { agent } = setup();
		const vendite = agent("vendite");
		// At start, all seven.
		expect([...vendite.reads].sort()).toEqual(["appointments", "clients", "ddt", "orders", "quotes", "sales", "suppliers"]);
		vendite.reads.length = 0;
		await vendite.run("orders", { op: "create", id: "OR-0001", name: "Alfa" });
		expect(vendite.reads).toEqual(["orders"]);
	});

	it("reads do not write, another agente's request is skipped, other tools are untouched", async () => {
		const { ledger, agent } = setup();
		const vendite = agent("vendite");
		await vendite.run("clients", { op: "list" });
		vendite.books.clients.push({ id: "CL-0001", name: "Alfa" });
		await vendite.run("clients", { op: "list" });
		expect(ledger.list()).toHaveLength(0);
		await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Beta" }, fresh({ origin: "agent", thread: { channel: AGENT_CHANNEL, threadId: "a1" } }));
		expect(ledger.list()).toHaveLength(0);
		expect(vendite.tools.find((t) => t.name === "weather")?.execute).toBe(vendite.tools.find((t) => t.name === "weather")?.execute);
		await vendite.run("clients", { op: "upsert", id: "CL-0003", name: "Gamma" });
		expect(ledger.list().map((e) => e.id)).toEqual(["CL-0001", "CL-0002", "CL-0003"]);
	});

	it("a record deleted, a scheda deleted, an agente deleted leave the ledger", async () => {
		const { ledger, board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await vendite.run("clients", { op: "upsert", id: "CL-0001", name: "Alfa" });
		await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Beta" });
		await acquisti.run("orders", { op: "create", id: "OR-0001", name: "Alfa" });
		const card = board.create({ title: "Alfa" }, { kind: "agent", id: "vendite" });
		await cardSubjects(vendite.seam).link(card, ["CL-0001", "CL-0002"], OWNER);

		await vendite.run("clients", { op: "remove", id: "CL-0002" });
		expect(ledger.list().map((e) => e.id).sort()).toEqual(["CL-0001", "OR-0001"]);

		ledger.unlinkCard(card.id);
		expect(ledger.list().some((e) => e.card !== undefined)).toBe(false);

		ledger.forgetAgent("acquisti");
		expect(ledger.list().map((e) => `${e.agent} ${e.id}`)).toEqual(["vendite CL-0001"]);
		// Its next first reading is again without warning.
		acquisti.books.orders.push({ id: "OR-0002", supplier: { key: "k", name: "Alfa" } });
		expect(await acquisti.run("orders", { op: "create", id: "OR-0003", name: "Alfa" })).toBe("fatto create");
	});

	it("the board tools link a scheda to the agente's records, each once, at most ten, and warn of the others", async () => {
		const { dir, ledger, board, agent } = setup();
		const vendite = agent("vendite");
		const acquisti = agent("acquisti");
		await acquisti.run("orders", { op: "create", id: "OR-0001", name: "Alfa" });
		vendite.books.quotes.push({ number: "2026-001", customer: { name: "Alfa srl" } });
		vendite.books.clients.push({ id: "CL-0009", name: "Delta" });
		for (let i = 10; i < 22; i++) vendite.books.clients.push({ id: `CL-00${i}`, name: `Cliente ${i}` });
		const work = new BoardWork({ store: board, agentName: async (id) => NAMES[id], canChat: async () => true, isOwner: async () => false, owners: async () => [], personName: async () => undefined, openThread: async () => "t1", post: async () => {} });
		const tools = createBoardTools({ self: "vendite", store: board, work, agents: async () => [{ id: "vendite", name: "Vendite" }], personOf: () => "p_anna", subjects: cardSubjects(vendite.seam) });
		const run = async (name: string, args: Record<string, unknown>) => String(await (tools.find((t) => t.name === name) as OwniTool).execute(args, fresh()));

		expect(await run("board_create", { title: "Offerta", subjects: ["2026-999"] })).toBe("Errore: nei tuoi registri non c'è 2026-999. Usa gli ID dei tuoi record (CL-0012, OR-0003...).");
		expect(board.list()).toHaveLength(0);
		const made = await run("board_create", { title: "Offerta", subjects: ["2026-001", " 2026-001"] });
		expect(made).toBe("Scheda #1 creata in «Da fare». Collegata a 2026-001. Attenzione, lo stesso cliente o fornitore lo segue anche un altro agente: Acquisti ha già ordine OR-0001. Dillo alla persona prima di andare avanti.");
		const card = board.get("1");
		expect(ledger.list().find((e) => e.id === "2026-001")?.card).toEqual({ id: card?.id, n: 1 });

		expect(await run("board_update", { card: "1", subjects: ["CL-0009"] })).toBe("Scheda #1 collegata a CL-0009.");
		expect(ledger.list().filter((e) => e.card !== undefined).map((e) => e.id)).toEqual(["CL-0009"]);
		// Twelve given: the first ten.
		const twelve = Array.from({ length: 12 }, (_, i) => `CL-00${i + 10}`);
		expect(await run("board_update", { card: "1", subjects: twelve })).toBe(`Scheda #1 collegata a ${twelve.slice(0, 10).join(", ")}.`);
		expect(ledger.list().filter((e) => e.card !== undefined)).toHaveLength(10);
		expect(await run("board_update", { card: "1", subjects: [] })).toBe("Scheda #1: non più collegata ai tuoi record.");
		expect(ledger.list().some((e) => e.card !== undefined)).toBe(false);

		// Not its scheda: no linking.
		const other = board.create({ title: "Altro" }, { kind: "person", id: "p_anna" });
		expect(await run("board_update", { card: String(other.n), subjects: ["CL-0009"] })).toMatch(/^Errore: la scheda #2 non è tua/);
		expect(readFileSync(join(dir, "subjects.json"), "utf8")).not.toMatch(/alfa|delta/i);
	});

	it("a broken ledger never fails a call: the scheda is made, the register written, without link or warning", async () => {
		const { dir, board, agent, logs } = setup();
		const vendite = agent("vendite");
		vendite.books.clients.push({ id: "CL-0001", name: "Alfa" });
		writeFileSync(join(dir, "subjects.json"), "{ non è json");
		const work = new BoardWork({ store: board, agentName: async (id) => NAMES[id], canChat: async () => true, isOwner: async () => false, owners: async () => [], personName: async () => undefined, openThread: async () => "t1", post: async () => {} });
		const tools = createBoardTools({ self: "vendite", store: board, work, agents: async () => [{ id: "vendite", name: "Vendite" }], personOf: () => "p_anna", subjects: cardSubjects(vendite.seam, (m) => void logs.push(m)) });
		const run = async (name: string, args: Record<string, unknown>) => String(await (tools.find((t) => t.name === name) as OwniTool).execute(args, fresh()));

		expect(await run("board_create", { title: "Offerta", subjects: ["CL-0001"] })).toBe("Scheda #1 creata in «Da fare».");
		expect(board.list()).toHaveLength(1);
		expect(await run("board_update", { card: "1", subjects: ["CL-0001"] })).toBe("Errore: non sono riuscita a collegare la scheda #1 ai tuoi record, riprova più tardi.");
		expect(await run("board_update", { card: "1", comment: "fatto", subjects: ["CL-0001"] })).toBe("Scheda #1: commento aggiunto.");
		expect(await vendite.run("clients", { op: "upsert", id: "CL-0002", name: "Beta" })).toBe("fatto upsert");
		expect(vendite.books.clients.map((c) => c.id)).toEqual(["CL-0001", "CL-0002"]);
		expect(logs.length).toBeGreaterThanOrEqual(4);
		expect(logs.every((m) => m.startsWith("owni: "))).toBe(true);
	});

	it("the text names at most five, then how many more", () => {
		const entries = Array.from({ length: 7 }, (_, i) => ({ agent: "acquisti", register: "orders" as const, id: `OR-000${i}`, kind: "ordine", party: { ids: [] }, f: "", at: "" }));
		expect(overlapText(entries, (id) => NAMES[id] ?? id)).toMatch(/Acquisti ha già ordine OR-0004, e altri 2\. Dillo/);
		expect(overlapText([], () => "")).toBe("");
	});

	it("the key is made once and kept with the tenant's secrets", async () => {
		const kept = new Map<string, string>();
		const secrets = { get: async (n: string) => kept.get(n), set: async (n: string, v: string) => void kept.set(n, v) };
		const first = await subjectsKey(secrets);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await subjectsKey(secrets)).toBe(first);
		expect([...kept.keys()]).toEqual(["subjects.key"]);
	});

	it("what the registers had before goes in at start, without warning; the next write warns", async () => {
		const { ledger, agent } = setup();
		agent("vendite", (b) => void b.clients.push({ id: "CL-0001", name: "Alfa" }));
		const acquisti = agent("acquisti", (b) => void b.orders.push({ id: "OR-0001", supplier: { key: "k", name: "Alfa srl" } }));
		expect(ledger.list().map((e) => `${e.agent} ${e.id}`).sort()).toEqual(["acquisti OR-0001", "vendite CL-0001"]);
		expect(await acquisti.run("orders", { op: "create", id: "OR-0002", name: "Alfa S.p.A." })).toContain("Vendite ha già cliente CL-0001.");
	});

	it("a register that does not read keeps its entries", () => {
		const { ledger, agent } = setup();
		const vendite = agent("vendite");
		vendite.books.clients.push({ id: "CL-0001", name: "Alfa" });
		syncAgent(vendite.seam);
		const broken = { ...vendite.stores, clients: { read: () => ({ cards: [], broken: true }) } } as unknown as SubjectStores;
		syncAgent({ ...vendite.seam, stores: broken });
		expect(ledger.list().map((e) => e.id)).toEqual(["CL-0001"]);
	});
});
