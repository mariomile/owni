import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { FakeCrmAdapter } from "../src/connectors/crm-fake.ts";
import { FakeMailAdapter } from "../src/connectors/mail-fake.ts";
import type { InboundMail } from "../src/connectors/types.ts";
import { createPiCompletionClient } from "../src/core/adapters/pi-durable-completion.ts";
import { AuditLog } from "../src/core/audit.ts";
import type { CompletionRequest, ModelClient } from "../src/core/completion.ts";
import { EgressDenied } from "../src/core/errors.ts";
import { tenantId as tid } from "../src/core/ids.ts";
import { DEFAULT_MODEL_ROLES } from "../src/core/model-routing.ts";
import { PracticeStore } from "../src/core/practice.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { loadChecks } from "../src/segreteria/checks.ts";
import { amountsIn, analyzeMail, draftReply, parseJsonObject } from "../src/segreteria/model.ts";
import { processInboundMail } from "../src/segreteria/pipeline.ts";

const checks = await loadChecks(join(import.meta.dirname, "..", "evals", "segreteria"));
const haiku = DEFAULT_MODEL_ROLES.extract;
const sonnet = DEFAULT_MODEL_ROLES.draft;

/** A model client that answers from a script, in order, and records each request. */
function scripted(answers: (string | Error)[]): ModelClient & { requests: CompletionRequest[] } {
	const requests: CompletionRequest[] = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			const next = answers.shift();
			if (next === undefined) throw new Error("script exhausted");
			if (next instanceof Error) throw next;
			return { text: next, inputTokens: 1000, outputTokens: 250 };
		},
	};
}

const mail = (over: Partial<InboundMail> = {}): InboundMail => ({
	messageId: "m1",
	threadId: "t1",
	from: "Dott.ssa Irene Basile <irene.basile@ristorante.example>",
	fromName: "Dott.ssa Irene Basile",
	subject: "Preventivo forno",
	bodyText: "Buongiorno, per il Ristorante Basile Srl ci serve un forno a convezione. Budget massimo 12.000 €. Tel 333 1234567.",
	receivedAt: "2026-10-15T09:00:00.000Z",
	...over,
});

const analysisJson = JSON.stringify({
	classification: "richiesta_preventivo",
	fullName: "Irene Basile",
	title: "Dott.ssa",
	company: "Ristorante Basile Srl",
	phone: "333 1234567",
	email: "attacker@evil.example",
	productOrService: "forno a convezione",
	requests: ["forno a convezione"],
	quantity: null,
	deliverySite: null,
	budget: "12.000 €",
	deadline: null,
	vatNumber: null,
	originalLanguage: "it",
	notes: null,
	missing: ["quantity", "deliverySite", "budget"],
});

const goodDraft = JSON.stringify({
	subject: "Re: Preventivo forno",
	body: "Gentile Dott.ssa Basile,\n\nLa ringraziamo per la richiesta per Ristorante Basile Srl relativa al forno a convezione, con budget massimo di 12.000 €.\n\nPer prepararle un preventivo accurato, può indicarci la quantità richiesta? Può indicarci anche la sede di installazione?\n\nRestiamo a disposizione e Le invieremo il preventivo appena ricevuti i dati.\nCordiali saluti\n[Nome commerciale] · [Azienda]",
});

describe("mail analysis with a model", () => {
	it("takes fields from the model, the address from the From header, and asks only what a quote needs", async () => {
		const client = scripted([`Ecco il JSON:\n\`\`\`json\n${analysisJson}\n\`\`\``]);
		const result = await analyzeMail(client, haiku, mail());
		expect(result.classification).toBe("richiesta_preventivo");
		expect(result.requests).toEqual(["forno a convezione"]);
		expect(result.lead).toMatchObject({
			fullName: "Irene Basile",
			title: "Dott.ssa",
			company: "Ristorante Basile Srl",
			email: "irene.basile@ristorante.example",
			productOrService: "forno a convezione",
			urgency: null,
			originalLanguage: "it",
			rawSubject: "Preventivo forno",
			mailMessageId: "m1",
		});
		// Never budget, deadline or company; VAT only when the tenant requires it.
		expect(result.lead.missingFields).toEqual(["quantity", "deliverySite"]);
		expect(client.requests[0]?.model).toEqual(haiku);
		expect(client.requests[0]?.user).toContain("From: Dott.ssa Irene Basile <irene.basile@ristorante.example>");

		const withVat = await analyzeMail(scripted([analysisJson]), haiku, mail(), { requireVatNumber: true });
		expect(withVat.lead.missingFields).toEqual(["quantity", "deliverySite", "vatNumber"]);
	});

	it("drops values outside the allowed sets instead of trusting them", async () => {
		const odd = JSON.stringify({ classification: "urgentissimo", title: "Cav.", originalLanguage: "fr", fullName: "", requests: [1, " "], missing: [] });
		const result = await analyzeMail(scripted([odd]), haiku, mail({ fromName: "Irene" }));
		expect(result.classification).toBe("richiesta_preventivo");
		expect(result.lead.title).toBeNull();
		expect(result.lead.originalLanguage).toBe("it");
		expect(result.lead.fullName).toBe("Irene");
		expect(result.requests).toEqual([]);
		expect(result.lead.missingFields).toEqual(["productOrService"]);
	});

	it("rejects answers without a JSON object", () => {
		expect(() => parseJsonObject("non lo so")).toThrow("no JSON object");
		expect(() => parseJsonObject("[1,2]")).toThrow();
		expect(amountsIn("Budget 12.000 € o € 500, oppure 5000 euro")).toEqual(["12.000 €", "€ 500", "5000 euro"]);
	});
});

describe("draft with a model", () => {
	const lead = async () => (await analyzeMail(scripted([analysisJson]), haiku, mail())).lead;

	it("accepts a draft that passes the CI checks, and may repeat the customer's own amount", async () => {
		const client = scripted([goodDraft]);
		const draft = await draftReply(client, sonnet, { mail: mail(), lead: await lead(), requests: ["forno a convezione"], checks });
		expect(draft).toMatchObject({ source: "model", failures: [], language: "it", subject: "Re: Preventivo forno" });
		expect(client.requests).toHaveLength(1);
		expect(client.requests[0]?.user).toContain("Missing items to ask about: quantity, delivery or installation site");
	});

	it("retries once with the failures, then uses the template, which always passes", async () => {
		const priced = JSON.stringify({ subject: "Re: Preventivo forno", body: "Ciao Irene, il forno costa 9.900 € con sconto del 10%. Ti chiamo al 333 1234567." });
		const fixed = scripted([priced, goodDraft]);
		const second = await draftReply(fixed, sonnet, { mail: mail(), lead: await lead(), requests: [], checks });
		expect(second.source).toBe("model");
		expect(fixed.requests[1]?.user).toMatch(/failed these checks.*prices.*register/s);

		const stubborn = scripted([priced, "niente JSON"]);
		const fallback = await draftReply(stubborn, sonnet, { mail: mail(), lead: await lead(), requests: [], checks });
		expect(fallback.source).toBe("template");
		expect(fallback.failures).toEqual([{ check: "format", detail: "no JSON object in model output" }]);
		expect(fallback.body).toContain("Gentile Dott.ssa Basile");
		expect(fallback.body).not.toMatch(/9\.900|sconto/);
	});
});

function pipelineHarness(client: ModelClient) {
	const dataDir = mkdtempSync(join(tmpdir(), "owni-segm-"));
	const notifications: { text: string; buttons: readonly string[] }[] = [];
	const audit = new AuditLog(dataDir, tid("acme"));
	const crm = new FakeCrmAdapter();
	const usage = new UsageLedger(join(dataDir, "acme"));
	const deps = {
		tenantId: "acme",
		instanceId: "segreteria",
		practices: new PracticeStore(join(dataDir, "acme", "instances", "segreteria")),
		mail: new FakeMailAdapter(),
		crm,
		audit,
		usage,
		roles: DEFAULT_MODEL_ROLES,
		model: { client, checks },
		notify: async (msg: { text: string; buttons: readonly string[] }) => {
			notifications.push(msg);
		},
	};
	return { deps, notifications, audit, crm, usage };
}

describe("pipeline with a model", () => {
	it("uses Haiku to read and Sonnet to draft, records the real tokens, sends nothing", async () => {
		const client = scripted([analysisJson, goodDraft]);
		const h = pipelineHarness(client);
		const result = await processInboundMail(h.deps, mail());
		expect(client.requests.map((r) => r.model.modelId)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
		expect(result).toMatchObject({ action: "create", crmUpserts: 1, sends: 0 });
		expect(result.pratica).toMatchObject({ status: "draft_ready", draftVersion: 1, missingFields: ["quantity", "deliverySite"] });
		expect(result.pratica.draftBody).toContain("Gentile Dott.ssa Basile");
		expect(h.notifications.at(-1)?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
		const today = await h.usage.todaySpent();
		// 2 calls × (1000 in, 250 out): Haiku 0.1/0.5 and Sonnet 2/10 USD per million tokens.
		expect(today).toBeCloseTo((1000 * 0.1 + 250 * 0.5 + 1000 * 2 + 250 * 10) / 1e6, 8);
	});

	it("a model that is down falls back to the heuristics and says so in the audit and on the card", async () => {
		const client = scripted([new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED")]);
		const h = pipelineHarness(client);
		const result = await processInboundMail(h.deps, mail());
		expect(result.pratica.status).toBe("draft_ready");
		expect(result.pratica.draftBody).toContain("Gentile");
		const failed = (await h.audit.read()).filter((e) => e.type === "model.failed");
		expect(failed.map((e) => e.role)).toEqual(["extract", "draft"]);
		expect(h.notifications.at(-1)?.text).toContain("Bozza standard: il modello non ha risposto.");
	});
});

describe("Pi completion client", () => {
	it("returns the text and usage, only for allowed providers, with the tenant's key", async () => {
		const keys: string[] = [];
		const client = createPiCompletionClient({
			apiKey: async (provider) => {
				keys.push(provider);
				return "tenant-key";
			},
			assertAllowed: (provider) => {
				if (provider !== "faux") throw new EgressDenied("model_provider", provider);
			},
			createProvider: () => {
				const faux = fauxProvider({ provider: "faux", models: [{ id: "owni-dev", name: "dev" }] });
				faux.setResponses([fauxAssistantMessage('{"ok":true}')]);
				return faux.provider;
			},
		});
		const result = await client.complete({ model: { provider: "faux", modelId: "owni-dev" }, system: "s", user: "u", maxTokens: 100 });
		expect(result.text).toBe('{"ok":true}');
		expect(result.inputTokens).toBeGreaterThanOrEqual(0);
		await expect(client.complete({ model: { provider: "anthropic", modelId: "claude-haiku-5-5" }, system: "s", user: "u", maxTokens: 10 })).rejects.toThrow(EgressDenied);
		await expect(client.complete({ model: { provider: "faux", modelId: "nope" }, system: "s", user: "u", maxTokens: 10 })).rejects.toThrow("Unknown model faux/nope");
	});
});
