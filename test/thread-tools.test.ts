import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/core/index.ts";
import { createThreadTools } from "../src/core/tools/thread-tools.ts";

type Sent = Parameters<Parameters<typeof createThreadTools>[0]["send"]>[0];

function setup(open: (at: { threadId: string; messageId: string }) => string | undefined = () => "p_000000000001.aaaaaaaaaaaa") {
	const sent: Sent[] = [];
	const opened: { threadId: string; messageId: string }[] = [];
	const [tool] = createThreadTools({ open: async (at) => (opened.push(at), open(at)), send: async (m) => void sent.push(m) });
	if (tool === undefined) throw new Error("no thread_reply");
	return { tool, sent, opened };
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

const WEB = { channel: "web", threadId: "p_000000000001.bbbbbbbbbbbb" };

describe("thread_reply (ADR 0133)", () => {
	it("opens the thread under the person's last message and sends the answer there, keyed by the call", async () => {
		const { tool, sent, opened } = setup();
		const result = await tool.execute({ text: "Il piano, punto per punto" }, context({ thread: WEB, origin: "person", inputs: ["web:m_1", "telegram:4:2", "web:m_2"], callId: "call-7" }));
		expect(opened).toEqual([{ threadId: WEB.threadId, messageId: "m_2" }]);
		expect(sent).toEqual([{ channel: "web", threadId: "p_000000000001.aaaaaaaaaaaa", text: "Il piano, punto per punto", key: "call-7" }]);
		expect(result).toMatch(/^Risposta scritta nel thread/);
	});

	it("answers in place off the web, on a turn that is not the person's, or where no thread opens", async () => {
		const telegram = setup();
		expect(await telegram.tool.execute({ text: "x" }, context({ thread: { channel: "telegram", threadId: "4" }, origin: "person", inputs: ["telegram:4:2"] }))).toMatch(/^Errore: qui non ci sono thread/);
		for (const origin of ["notice", "scheduled", "agent"] as const) {
			const s = setup();
			expect(await s.tool.execute({ text: "x" }, context({ thread: WEB, origin, inputs: ["web:m_1"] }))).toMatch(/^Errore: non c'è un messaggio/);
			expect(s.opened).toEqual([]);
		}
		const none = setup(() => undefined);
		expect(await none.tool.execute({ text: "x" }, context({ thread: WEB, origin: "person", inputs: ["web:m_1"] }))).toMatch(/^Errore: qui non si apre un thread/);
		expect(none.sent).toEqual([]);
		const noInput = setup();
		expect(await noInput.tool.execute({ text: "x" }, context({ thread: WEB, origin: "person", inputs: [] }))).toMatch(/^Errore: qui non si apre un thread/);
		expect(noInput.opened).toEqual([]);
	});
});
