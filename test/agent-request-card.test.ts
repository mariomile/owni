import { describe, expect, it, vi } from "vitest";

/** The console's helpers, as plain nodes: enough to read what a card shows. */
type Node = { tag: string; classes: string[]; children: (Node | string)[]; append(...c: (Node | string)[]): void; prepend(...c: (Node | string)[]): void; querySelector(tag: string): Node | undefined; classList: { toggle(): void }; style: { setProperty(): void } };
const mocks = vi.hoisted(() => {
	const node = (spec: string, kids: unknown[]): Node => {
		const [tag = "div", ...classes] = spec.split(".");
		const el: Node = {
			tag,
			classes,
			children: [],
			append: (...c) => void el.children.push(...c),
			prepend: (...c) => void el.children.unshift(...c),
			querySelector: (t) => el.children.find((c): c is Node => typeof c !== "string" && c.tag === t),
			classList: { toggle: () => {} },
			style: { setProperty: () => {} },
		};
		for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.children.push(typeof kid === "object" ? (kid as Node) : String(kid));
		return el;
	};
	const h = (spec: string, attrs?: unknown, ...kids: unknown[]) => (attrs !== null && typeof attrs === "object" && !Array.isArray(attrs) && !("tag" in attrs) ? node(spec, kids) : node(spec, [attrs, ...kids]));
	return { h, api: () => Promise.resolve({}), toast: () => {}, face: () => "face", faceColor: () => "#000", icon: () => "icon", fmt: { time: () => "ora" } };
});
vi.mock("../src/web/ui/common.js", () => mocks);

const text = (n: Node | string): string => (typeof n === "string" ? n : n.children.map(text).join("\n"));

describe("the console card of another agente's request (ADR 0108)", () => {
	it("shows what will be written, so the approver reads the invoice before saying yes", async () => {
		// @ts-expect-error The browser modules are deliberately plain JavaScript.
		const { agentRequestCard, connectorActionCard } = (await import("../src/web/ui/cards.js")) as { agentRequestCard(inst: unknown, a: unknown, after: () => void): Node; connectorActionCard(inst: unknown, a: unknown, after: () => void): Node };
		const inst = { id: "amministrazione", name: "Amministrazione" };
		const request = {
			id: "abc123abc123",
			status: "pending",
			tool: "sales_invoices",
			what: "emetto la fattura",
			proposedAt: new Date().toISOString(),
			shown: [["draft", "BZ-0001"]],
			preview: "Attenzione: non vengono dai dati salvati, li ha dati l'altro agente: codice destinatario «ZZZ0001», che non avevo.\nEmetterei questa fattura a Delta Servizi Srl\nIBAN IT51X0000000000000000000001\nTotale 1.220,00 €",
			askedBy: { id: "vendite", name: "Vendite", request: "fammi la fattura del preventivo 4" },
		};
		const card = text(agentRequestCard(inst, request, () => {}));
		expect(card).toContain("Cosa scriverei:");
		expect(card).toContain("Emetterei questa fattura a Delta Servizi Srl\nIBAN IT51X0000000000000000000001\nTotale 1.220,00 €");
		expect(card).toContain("codice destinatario «ZZZ0001», che non avevo");
		// No preview: nothing about it.
		expect(text(agentRequestCard(inst, { ...request, preview: undefined }, () => {}))).not.toContain("Cosa scriverei");
		// A connector action has no preview to show.
		expect(text(connectorActionCard(inst, { ...request, toolTitle: "Crea", preview: "non mostrata" }, () => {}))).not.toContain("Cosa scriverei");
	});
});
