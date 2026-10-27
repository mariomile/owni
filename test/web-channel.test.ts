import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelRefused, type OutboundReaction } from "../src/channels/types.ts";
import { type WebEvent, WebChannel, chatTitle } from "../src/web/channel.ts";
import { tempDataDir } from "./helpers.ts";

describe("web channel", () => {
	it("an answer ready before the question is written down still lands after it", async () => {
		const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, tempDataDir());
		const thread = await channel.createThread("p_000000000001", "Chat");
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

	it("a thread under a command is titled in words", () => {
		expect(chatTitle("  ciao   owni ")).toBe("ciao owni");
		expect(chatTitle("/chiusura-del-mese ottobre")).toBe("Chiusura del mese ottobre");
		expect(chatTitle('/tool tool_propose {"name":"cambio_eur"}')).toBe("Tool tool_propose");
		expect(chatTitle("/modello")).toBe("Modello");
		expect(chatTitle("/ cosa")).toBe("/ cosa");
	});
});

describe("web channel: reactions (ADR 0132)", () => {
	const PERSON = "p_000000000001";
	const react = (threadId: string, messageId: string, emoji: string, key: string): OutboundReaction => ({ tenantId: "acme", instanceId: "ops", channel: "web", threadId, idempotencyKey: key, messageId, emoji });

	async function talking() {
		const dir = tempDataDir();
		const channel = new WebChannel({ tenantId: "acme", instanceId: "ops" }, dir);
		channel.onInbound(async () => {});
		const thread = await channel.createThread(PERSON, "Chat");
		const message = await channel.post(thread.id, PERSON, "grazie");
		return { channel, thread, message, dir };
	}

	it("a reaction folds onto its message in the transcript, and is no line of its own", async () => {
		const { channel, thread, message } = await talking();
		await channel.send({ tenantId: "acme", instanceId: "ops", channel: "web", threadId: thread.id, text: "prego", idempotencyKey: "reply:1" });
		await channel.react(react(thread.id, message.id, "👍", "react:1"));
		const transcript = await channel.transcript(thread.id);
		expect(transcript.map((e) => [e.from, e.text, e.reaction])).toEqual([
			["person", "grazie", "👍"],
			["owni", "prego", undefined],
		]);
	});

	it("the last reaction wins, and the same key twice is written once", async () => {
		const { channel, thread, message, dir } = await talking();
		await channel.react(react(thread.id, message.id, "👍", "react:1"));
		await channel.react(react(thread.id, message.id, "👍", "react:1"));
		const lines = (await readFile(join(dir, "web", "messages", `${thread.id}.jsonl`), "utf8")).split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(2);
		await channel.react(react(thread.id, message.id, "🔥", "react:2"));
		expect((await channel.transcript(thread.id)).map((e) => e.reaction)).toEqual(["🔥"]);
	});

	it("refuses a message that is not in the thread and a thread that is not a web one", async () => {
		const { channel, thread } = await talking();
		await expect(channel.react(react(thread.id, "m_nope", "👍", "react:1"))).rejects.toBeInstanceOf(ChannelRefused);
		await expect(channel.react(react("42", "m_1", "👍", "react:2"))).rejects.toBeInstanceOf(ChannelRefused);
		// A reaction line is no message to react to.
		const message = await channel.post(thread.id, PERSON, "ciao");
		await channel.react(react(thread.id, message.id, "👍", "react:3"));
		const lineId = `r_${createHash("sha256").update("react:3").digest("hex").slice(0, 24)}`;
		await expect(channel.react(react(thread.id, lineId, "👍", "react:4"))).rejects.toBeInstanceOf(ChannelRefused);
		expect((await channel.transcript(thread.id)).map((e) => e.reaction)).toEqual([undefined, "👍"]);
	});

	it("does not touch the thread: not its update time, not its read marker", async () => {
		const { channel, thread, message } = await talking();
		await channel.send({ tenantId: "acme", instanceId: "ops", channel: "web", threadId: thread.id, text: "prego", idempotencyKey: "reply:1" });
		const before = await channel.thread(thread.id);
		expect(Date.parse(before?.updatedAt as string)).toBeGreaterThan(Date.parse(before?.readAt as string));
		await channel.react(react(thread.id, message.id, "👍", "react:1"));
		expect(await channel.thread(thread.id)).toEqual(before);
	});

	it("tells the person with the message folded and reaction: true", async () => {
		const { channel, thread, message } = await talking();
		const events: WebEvent[] = [];
		channel.events.on(PERSON, (event: WebEvent) => events.push(event));
		await channel.react(react(thread.id, message.id, "🎉", "react:1"));
		expect(events).toEqual([{ instanceId: "ops", threadId: thread.id, entry: expect.objectContaining({ id: message.id, from: "person", text: "grazie", reaction: "🎉" }), reaction: true }]);
	});
});
