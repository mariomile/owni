import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import { connectChannel } from "../src/gateway.ts";
import { type Skill, skillMenuEntry } from "../src/core/skills.ts";
import { MODEL_COMMAND } from "../src/model-command.ts";
import { runtimeWithInstance, waitFor } from "./helpers.ts";

const TOKEN = "123456:TEST-TOKEN";
const AT = "2026-10-22T00:00:00.000Z";
const skill = (name: string, description = "Quando serve"): Skill => ({ name, description, body: "passi", createdBy: "web:1", createdAt: AT, updatedAt: AT });

describe("skill commands in the Telegram menu", () => {
	it("is what setMyCommands receives when the bot starts", async () => {
		const calls: { method: string; body: Record<string, unknown> }[] = [];
		const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			if (method === "getUpdates") await new Promise((resolve) => setTimeout(resolve, 10));
			return Response.json({ ok: true, result: method === "getUpdates" ? [] : true });
		}) as unknown as typeof fetch;
		const commands = [MODEL_COMMAND, skillMenuEntry(skill("chiusura-del-mese", "Quando chiedono di chiudere il mese"))];
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api, retryDelayMs: 1, commands });
		await adapter.start();
		await adapter.stop();
		expect(calls[0]).toEqual({
			method: "setMyCommands",
			body: { commands: [MODEL_COMMAND, { command: "chiusura_del_mese", description: "Quando chiedono di chiudere il mese" }] },
		});
	});

	it("a tapped command reaches the agent as a request to use that skill", async () => {
		const { runtime } = await runtimeWithInstance({ egress: { modelProviders: ["faux"], channels: ["telegram"] } });
		runtime.skills("acme", "ops").save({ name: "Chiusura del mese", description: "Quando chiedono di chiudere il mese", body: "1. Fatture scadute\n2. Spese del mese", by: "web:1" }, () => true);
		const sentTexts: string[] = [];
		const updates = [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 7 }, text: "/chiusura_del_mese@OwniBot ottobre" } }];
		const api = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const method = String(url).slice(String(url).lastIndexOf("/") + 1);
			const body = JSON.parse(String(init?.body)) as { text?: string };
			if (method === "sendMessage") {
				sentTexts.push(body.text ?? "");
				return Response.json({ ok: true, result: { message_id: sentTexts.length } });
			}
			return Response.json({ ok: true, result: method === "getUpdates" ? updates.splice(0) : true });
		}) as unknown as typeof fetch;
		const adapter = new TelegramAdapter({ token: TOKEN, tenantId: "acme", instanceId: "ops", fetch: api });
		connectChannel(runtime, adapter, { tenantId: "acme", instanceId: "ops" });
		await adapter.pollOnce();
		await waitFor(() => sentTexts.length > 0);
		expect(sentTexts[0]).toContain("/chiusura_del_mese@OwniBot ottobre");
		expect(sentTexts[0]).toContain("[Skill «chiusura-del-mese»]");
		expect(sentTexts[0]).toContain("2. Spese del mese");
		await runtime.close();
	});
});
