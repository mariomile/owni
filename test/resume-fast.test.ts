import { describe, expect, it } from "vitest";
import { piDurableEngine } from "../src/core/adapters/pi-durable.ts";
import { OwniRuntime, type DurableEngine, type Reply } from "../src/core/index.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

/** Pi Durable whose session stops right after admitting a submission: admitted, never run. */
const stopAfterAdmission: DurableEngine = {
	async open(options) {
		const session = await piDurableEngine.open(options);
		let closed: Promise<void> | undefined;
		const close = () => (closed ??= session.close());
		return {
			submit: async (threadKey, text, requestId) => {
				const result = await session.submit(threadKey, text, requestId);
				await close();
				return result;
			},
			resume: () => session.resume(),
			reattach: (submissionId, threadKey) => session.reattach(submissionId, threadKey),
			setThreadModel: (threadKey, model) => session.setThreadModel(threadKey, model),
			threadModel: (threadKey) => session.threadModel(threadKey),
			onReply: (listener) => session.onReply(listener),
			idle: () => session.idle(),
			close,
		};
	},
};

describe("resume with a fast model", () => {
	it("replies to work a previous process admitted but never ran, even when it finishes instantly", async () => {
		const first = await runtimeWithInstance({});
		await first.runtime.close();
		const stopping = new OwniRuntime({ dataDir: first.dataDir, engine: stopAfterAdmission });
		const stoppedReplies: Reply[] = [];
		stopping.onReply((reply) => stoppedReplies.push(reply));
		const instance = await stopping.openInstance("acme", "ops");
		await instance.submit({ channel: "test", threadId: "1", userId: "u", text: "ciao", messageId: "m1" });
		await stopping.close();
		expect(stoppedReplies).toEqual([]);

		const second = new OwniRuntime({ dataDir: first.dataDir, engine: piDurableEngine });
		const replies: Reply[] = [];
		second.onReply((reply) => replies.push(reply));
		expect(await second.resume("acme", "ops")).toEqual({ pending: 1, undelivered: 0, reattached: 1 });
		await waitFor(() => replies.length === 1);
		expect(replies[0]).toMatchObject({ threadId: "1", status: "answered", text: "Owni (modello locale di sviluppo): hai scritto «ciao»" });

		// A second resume() does not answer again.
		await second.resume("acme", "ops");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(replies).toHaveLength(1);
		await second.close();
	});
});
