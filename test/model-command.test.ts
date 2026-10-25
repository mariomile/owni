import { describe, expect, it } from "vitest";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../src/channels/types.ts";
import { ChatModels } from "../src/core/chat-models.ts";
import type { ModelInfo } from "../src/core/model-providers.ts";
import { modelApiKeySecret } from "../src/core/secrets.ts";
import { connectChannel } from "../src/gateway.ts";
import { modelCommandArgument } from "../src/model-command.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const model = (id: string, name: string): ModelInfo => ({ id, name, images: true, reasoning: false, contextWindow: 1_000_000, inputUsd: 0.3, outputUsd: 2.5 });
const CATALOG: Record<string, readonly ModelInfo[]> = {
	faux: [model("owni-dev", "Owni di prova")],
	google: [model("gemini-3.5-pro", "Gemini 3.5 Pro"), model("gemini-3.5-flash", "Gemini 3.5 Flash")],
	openai: [model("gpt-5.5", "GPT-5.5")],
};

function chatChannel(): ChannelAdapter & { sent: OutboundMessage[]; say: (text: string, userId?: string) => Promise<void> } {
	const sent: OutboundMessage[] = [];
	let inbound: ((message: InboundMessage) => Promise<void>) | undefined;
	let n = 0;
	return {
		name: "test",
		sent,
		start: async () => {},
		stop: async () => {},
		onInbound: (handler) => {
			inbound = handler;
		},
		send: async (message) => {
			sent.push(message);
		},
		say: async (text, userId = "u") => {
			n += 1;
			await inbound?.({ tenantId: "acme", instanceId: "ops", channel: "test", threadId: "t1", userId, text, messageId: `m${n}` });
		},
	};
}

async function setup(options: { models?: boolean } = {}) {
	const { runtime } = await runtimeWithInstance({ egress: { modelProviders: ["faux", "google"], channels: ["test"] } });
	// Keys for google (allowed) and openai (not allowed for this instance).
	await runtime.secrets("acme").set(modelApiKeySecret("google"), "g-key");
	await runtime.secrets("acme").set(modelApiKeySecret("openai"), "o-key");
	const channel = chatChannel();
	const chats = new ChatModels(runtime, "acme", { models: (p) => CATALOG[p] ?? [], serverModelKeys: [] });
	connectChannel(runtime, channel, { tenantId: "acme", instanceId: "ops" }, () => {}, options.models === false ? {} : { models: chats });
	const last = async () => {
		await waitFor(() => channel.sent.length > 0);
		return (channel.sent.splice(0).at(-1) as OutboundMessage).text;
	};
	return { runtime, channel, last };
}

describe("the /modello command", () => {
	it("recognizes the command, also with a bot's name, and nothing else", () => {
		expect(modelCommandArgument("/modello")).toBe("");
		expect(modelCommandArgument(" /Model  gemini pro ")).toBe("gemini pro");
		expect(modelCommandArgument("/modello@OwniBot google")).toBe("google");
		expect(modelCommandArgument("/modellone")).toBeUndefined();
		expect(modelCommandArgument("che /modello usi?")).toBeUndefined();
	});

	it("shows the chat's model and the providers it may use, not the ones the owner did not allow", async () => {
		const { channel, last } = await setup();
		await channel.say("/modello");
		const text = await last();
		expect(text).toContain("modello dell'istanza, Owni di prova");
		expect(text).toContain("Google (Gemini)");
		expect(text).not.toContain("OpenAI");
	});

	it("gives the chat a model by name, lists the matches when there are several, and goes back to the instance's", async () => {
		const { runtime, channel, last } = await setup();
		await channel.say("/modello gemini");
		const list = await last();
		expect(list).toContain("/modello google gemini-3.5-pro");
		expect(list).toContain("/modello google gemini-3.5-flash");
		expect(await runtime.chatModel("acme", "ops", "test", "t1")).toBeUndefined();

		await channel.say("/modello gemini pro");
		expect(await last()).toContain("usa Gemini 3.5 Pro, di Google (Gemini)");
		expect(await runtime.chatModel("acme", "ops", "test", "t1")).toEqual({ provider: "google", modelId: "gemini-3.5-pro" });
		const audit = await runtime.audit("acme").read();
		expect(audit.find((e) => e.type === "chat.model.updated")).toMatchObject({ channel: "test", threadId: "t1", by: "test:u", modelProvider: "google" });

		await channel.say("/modello istanza");
		expect(await last()).toContain("torna al modello dell'istanza");
		expect(await runtime.chatModel("acme", "ops", "test", "t1")).toBeUndefined();
	});

	it("takes a provider alone as its suggested model, and an exact id", async () => {
		const { runtime, channel, last } = await setup();
		await channel.say("/modello google");
		expect(await last()).toContain("Gemini 3.5 Flash");
		expect(await runtime.chatModel("acme", "ops", "test", "t1")).toEqual({ provider: "google", modelId: "gemini-3.5-flash" });
		await channel.say("/modello gemini-3.5-pro");
		expect(await last()).toContain("Gemini 3.5 Pro");
		expect(await runtime.chatModel("acme", "ops", "test", "t1")).toEqual({ provider: "google", modelId: "gemini-3.5-pro" });
	});

	it("never widens the providers: a member cannot pick one the owner did not allow", async () => {
		const { runtime, channel, last } = await setup();
		await channel.say("/modello gpt");
		expect(await last()).toContain("Non trovo");
		expect((await runtime.registry.getInstance("acme", "ops")).egress.modelProviders).toEqual(["faux", "google"]);
	});

	it("leaves a stranger's command to the core, which refuses it", async () => {
		const { runtime, channel } = await setup();
		await channel.say("/modello gemini pro", "stranger");
		const audit = await runtime.audit("acme").read();
		expect(audit.some((e) => e.type === "user.denied" && e.userId === "stranger")).toBe(true);
		expect(channel.sent).toEqual([]);
		expect(await runtime.chatModel("acme", "ops", "test", "t1")).toBeUndefined();
	});

	it("is a plain message on a channel without the command", async () => {
		const { channel, last } = await setup({ models: false });
		await channel.say("/modello");
		// The local model echoes what it got.
		expect(await last()).toContain("/modello");
	});
});
