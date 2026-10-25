import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { piDurableEngine, withTurnContext } from "../src/core/adapters/pi-durable.ts";
import type { DurableEngine, EngineOpenOptions } from "../src/core/engine.ts";
import { OwniRuntime } from "../src/core/runtime.ts";
import { createMemoryTools } from "../src/core/tools/memory-tools.ts";
import { nowLine } from "../src/core/turn-context.ts";
import { FAUX_MODEL, tempDataDir, waitFor } from "./helpers.ts";

const user = (content: Message["content"]): Message => ({ role: "user", content, timestamp: 0 }) as Message;

describe("contesto del turno (ADR 0097)", () => {
	it("says the day and the time in Rome", () => {
		expect(nowLine(new Date("2026-10-22T14:40:00Z"))).toBe("\n\n[Ora] giovedì 22 ottobre 2026 alle ore 16:40, ora italiana.");
		expect(nowLine(new Date("2026-01-05T08:05:00Z"))).toContain("lunedì 5 gennaio 2026 alle ore 09:05");
	});

	it("goes after the newest message of the person only, and leaves the messages it was given as they were", () => {
		const messages = [user("prima"), { role: "assistant", content: [{ type: "text", text: "ok" }] } as unknown as Message, user([{ type: "text", text: "poi" }])];
		const out = withTurnContext(messages, "\n\n[Ora] adesso");
		expect(out[0]).toBe(messages[0]);
		expect(out[2]?.content).toEqual([
			{ type: "text", text: "poi" },
			{ type: "text", text: "\n\n[Ora] adesso" },
		]);
		expect(messages[2]?.content).toEqual([{ type: "text", text: "poi" }]);
		expect(withTurnContext([user("solo")], "\n\nnota")[0]?.content).toEqual([
			{ type: "text", text: "solo" },
			{ type: "text", text: "\n\nnota" },
		]);
		expect(withTurnContext(messages, "")).toBe(messages);
	});

	it("the memories reach the model with each request but are not written into the person's message", async () => {
		const submitted: string[] = [];
		let opened: EngineOpenOptions | undefined;
		const engine: DurableEngine = {
			async open(options) {
				opened = options;
				const session = await piDurableEngine.open(options);
				const submit = session.submit.bind(session);
				session.submit = (threadKey, text, ...rest) => {
					submitted.push(text);
					return submit(threadKey, text, ...rest);
				};
				return session;
			},
		};
		const runtime: OwniRuntime = new OwniRuntime({ dataDir: tempDataDir(), engine, tools: async () => createMemoryTools({ store: runtime.memory("acme", "ops"), whoIs: (thread) => runtime.participant("acme", "ops", thread) }) });
		await runtime.registry.createTenant({ id: "acme", name: "acme" });
		await runtime.registry.createInstance("acme", { id: "ops", name: "ops", model: FAUX_MODEL, egress: { modelProviders: ["faux"], channels: ["test"] }, allowedUsers: { test: ["anna"] } });
		const replies: { text?: string }[] = [];
		runtime.onReply((reply) => replies.push(reply as { text?: string }));
		const from = (text: string, messageId: string) => ({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId: "anna", text, messageId, privateThread: true });
		await runtime.submit(from('/tool memory_remember {"text":"Preferisce risposte brevi"}', "1"));
		await waitFor(() => replies.length === 1);
		await runtime.submit(from("ciao di nuovo", "2"));
		await waitFor(() => replies.length === 2);
		expect(replies[1]?.text).toContain("Preferisce risposte brevi");
		expect(submitted).toEqual(['/tool memory_remember {"text":"Preferisce risposte brevi"}', "ciao di nuovo"]);
		const context = opened?.turnContext?.("test:t1") ?? "";
		expect(context).toMatch(/^\n\n\[Ora\] \S+ \d+ \S+ \d{4} alle ore \d{2}:\d{2}, ora italiana\.\n\n\[Memoria\]/);
		expect(context).toContain("Preferisce risposte brevi");
		await runtime.close();
	});
});
