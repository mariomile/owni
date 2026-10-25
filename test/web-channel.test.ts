import { describe, expect, it } from "vitest";
import { WebChannel, chatTitle } from "../src/web/channel.ts";
import { tempDataDir } from "./helpers.ts";

describe("web channel", () => {
	it("an answer ready before the question is written down still lands after it", async () => {
		const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, tempDataDir());
		const thread = await channel.createThread("p_000000000001");
		let delivered: Promise<void> | undefined;
		channel.onInbound(async (message) => {
			// The fastest possible answer: sent while the question is still being admitted.
			delivered = channel.send({ tenantId: "acme", instanceId: "ops", channel: "web", threadId: message.threadId, text: "risposta", idempotencyKey: "reply:1" });
			await new Promise((r) => setTimeout(r, 20));
		});
		await channel.post(thread.id, "p_000000000001", "domanda");
		await delivered;
		expect((await channel.transcript(thread.id)).map((e) => [e.from, e.text])).toEqual([
			["person", "domanda"],
			["owni", "risposta"],
		]);
	});

	it("a chat started with a command is titled in words", () => {
		expect(chatTitle("  ciao   owni ")).toBe("ciao owni");
		expect(chatTitle("/chiusura-del-mese ottobre")).toBe("Chiusura del mese ottobre");
		expect(chatTitle('/tool tool_propose {"name":"cambio_eur"}')).toBe("Tool tool_propose");
		expect(chatTitle("/modello")).toBe("Modello");
		expect(chatTitle("/ cosa")).toBe("/ cosa");
	});
});
