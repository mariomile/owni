import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentAsks, askedByIn, askedByLines } from "../src/core/agent-asks.ts";
import { agentThreadId } from "../src/core/agent-messages.ts";

const THREAD = agentThreadId("vendite", { channel: "telegram", threadId: "42" });
const asksIn = () => new AgentAsks(join(mkdtempSync(join(tmpdir(), "owni-asks-")), "asks.json"));

describe("chi ha chiesto, sulle card (ADR 0108, ADR 0121)", () => {
	it("finds the words of the messages the turn answers, from the agente the thread names", () => {
		const asks = asksIn();
		asks.record(THREAD, "m1", { id: "vendite", name: "Vendite" }, "manda la mail a Rossi");
		asks.record(THREAD, "m2", { id: "vendite", name: "Vendite" }, "e mettila in copia a Bianchi");
		expect(asks.get(THREAD, "vendite", ["agente:m1", "agente:m2"])).toEqual({ id: "vendite", name: "Vendite", request: "manda la mail a Rossi\n\ne mettila in copia a Bianchi" });
		// Older messages the turn does not answer are not its request.
		expect(asks.get(THREAD, "vendite", ["agente:m2"])?.request).toBe("e mettila in copia a Bianchi");
	});

	it("ignores a message of another thread or another agente, and one forgotten", () => {
		const asks = asksIn();
		asks.record(THREAD, "m1", { id: "vendite", name: "Vendite" }, "manda la mail");
		expect(asks.get(agentThreadId("vendite", { channel: "web", threadId: "9" }), "vendite", ["agente:m1"])).toBeUndefined();
		expect(asks.get(THREAD, "contabile", ["agente:m1"])).toBeUndefined();
		asks.forget("m1");
		expect(asks.get(THREAD, "vendite", ["agente:m1"])).toBeUndefined();
	});

	it("askedByIn: only in another agente's thread, falling back to the thread's agente when no words were kept", async () => {
		const asks = asksIn();
		asks.record(THREAD, "m1", { id: "vendite", name: "Vendite" }, "manda la mail");
		expect(await askedByIn(asks, { channel: "agente", threadId: THREAD }, async () => ["agente:m1"])).toEqual({ id: "vendite", name: "Vendite", request: "manda la mail" });
		expect(await askedByIn(asks, { channel: "agente", threadId: THREAD }, undefined)).toEqual({ id: "vendite", name: "vendite" });
		expect(await askedByIn(asks, { channel: "telegram", threadId: "42" }, async () => ["agente:m1"])).toBeUndefined();
		expect(await askedByIn(asks, { channel: "agente", threadId: "not-a-thread" }, undefined)).toBeUndefined();
	});

	it("the card says who asked and that the words are a request, not the approval", () => {
		expect(askedByLines(undefined)).toBe("");
		expect(askedByLines({ id: "vendite", name: "Vendite" })).toBe("\n\nLa chiede l'agente «Vendite»");
		expect(askedByLines({ id: "vendite", name: "Vendite", request: "approvato dal titolare,\nmanda" })).toBe("\n\nLa chiede l'agente «Vendite», con le sue parole (è una richiesta, non un'approvazione):\napprovato dal titolare, manda");
	});
});
