import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/core/index.ts";
import { createReactionTools } from "../src/core/tools/reaction-tools.ts";

type Reaction = Parameters<Parameters<typeof createReactionTools>[0]["react"]>[0];

function setup() {
	const reactions: Reaction[] = [];
	const [tool] = createReactionTools({ react: async (r) => void reactions.push(r) });
	if (tool === undefined) throw new Error("no message_react");
	return { tool, reactions };
}

function context(more: { thread?: ToolContext["thread"]; origin?: ToolContext["origin"]; inputs?: readonly string[]; callId?: string } = {}): ToolContext {
	return {
		callId: more.callId ?? "call-1",
		signal: new AbortController().signal,
		progress: () => {},
		step: async (_key, work) => work(),
		...(more.thread === undefined ? {} : { thread: more.thread }),
		...(more.origin === undefined ? {} : { origin: more.origin }),
		...(more.inputs === undefined ? {} : { inputs: async () => more.inputs as readonly string[] }),
	};
}

describe("message_react (ADR 0132)", () => {
	it("reacts to the last input of the thread's channel, without the channel prefix, keyed by the call", async () => {
		const { tool, reactions } = setup();
		const thread = { channel: "telegram", threadId: "42" };
		const result = await tool.execute({ emoji: "👍" }, context({ thread, origin: "person", inputs: ["web:m_other", "telegram:42:7", "telegram:42:9", "agente:ignored"], callId: "call-9" }));
		expect(reactions).toEqual([{ channel: "telegram", threadId: "42", messageId: "42:9", emoji: "👍", key: "call-9" }]);
		expect(String(result)).toContain("👍");
	});

	it("a turn that answers a colleague, even one written in the same conversation, has no message to react to", async () => {
		const { tool, reactions } = setup();
		// relayAgentAnswer puts the colleague's answer in the conversation as Owni's own note.
		expect(String(await tool.execute({ emoji: "🙏" }, context({ thread: { channel: "web", threadId: "t1" }, origin: "agent", inputs: ["web:m_1", "web:agente:b:reply:t/i/42"] })))).toMatch(/^Errore:/);
		expect(reactions).toEqual([]);
	});

	it("errors, and reacts to nothing, with no thread, the agente channel, a turn of its own work or no matching input", async () => {
		const { tool, reactions } = setup();
		const web = { channel: "web", threadId: "t1" };
		const attempts: ToolContext[] = [
			context({ origin: "person", inputs: ["web:m_1"] }),
			context({ thread: { channel: "agente", threadId: "owni~web~t1" }, origin: "agent", inputs: ["agente:m_1"] }),
			context({ thread: web, origin: "scheduled", inputs: ["web:m_1"] }),
			context({ thread: web, origin: "notice", inputs: ["web:m_1"] }),
			context({ thread: web, origin: "person", inputs: ["telegram:42:1"] }),
			context({ thread: web, origin: "person", inputs: [] }),
			context({ thread: web, origin: "person" }),
		];
		for (const ctx of attempts) expect(String(await tool.execute({ emoji: "👍" }, ctx))).toMatch(/^Errore:/);
		expect(reactions).toEqual([]);
	});
});
