/**
 * Nightly eval of the segreteria with the real models (spec §7.2). For each case it runs
 * what production runs, processInboundMail with a fake mailbox and CRM: Haiku reads the
 * mail, Sonnet drafts the reply under the CI checks, with the production fallbacks.
 * Then it measures:
 *   - classification against the gold (accuracy, and no spam taken for a quote request);
 *   - extraction: micro-F1 over the lead fields and exact-match leads;
 *   - the drafts: deterministic checks with the gold constraints, template fallbacks;
 *   - quality: Sonnet as judge with rubrics/draft_rubric.md.
 * Writes last-report/judge.json and exits 1 when a gate fails.
 *
 * PR CI never runs this. Without OWNI_JUDGE_MODEL_KEY (an Anthropic key) it skips.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InboundMail } from "../../src/connectors/types.ts";
import { createPiCompletionClient } from "../../src/core/adapters/pi-durable-completion.ts";
import type { ModelClient } from "../../src/core/completion.ts";
import { EgressDenied } from "../../src/core/errors.ts";
import { DEFAULT_MODEL_ROLES } from "../../src/core/model-routing.ts";
import { loadChecks, runDeterministicChecks } from "../../src/segreteria/checks.ts";
import { FakeCrmAdapter } from "../../src/connectors/crm-fake.ts";
import { FakeMailAdapter } from "../../src/connectors/mail-fake.ts";
import { AuditLog } from "../../src/core/audit.ts";
import { tenantId } from "../../src/core/ids.ts";
import { PracticeStore } from "../../src/core/practice.ts";
import { estimateUsd, UsageLedger } from "../../src/core/usage.ts";
import { parseJsonObject } from "../../src/segreteria/model.ts";
import { processInboundMail } from "../../src/segreteria/pipeline.ts";
import { compareLead, type FieldCounts, hardFail, type JudgeVerdict, meanScore, microF1, parseVerdict } from "./metrics.ts";

const key = process.env.OWNI_JUDGE_MODEL_KEY;
if (!key) {
	console.log("eval:segreteria:judge skipped (no OWNI_JUDGE_MODEL_KEY)");
	process.exit(0);
}

const GATES = { classificationAccuracy: 0.95, microF1: 0.85, exactMatch: 0.6, judgeMean: 3.5, maxTemplateFallbackShare: 0.1 };
const root = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

type CaseRow = { id: string; email: { messageId: string; threadId?: string; from: string; fromName?: string; subject: string; body?: string; bodyText?: string; receivedAt: string; inReplyTo?: string } };
type GoldRow = {
	id: string;
	classification: string;
	lead: Record<string, unknown> | null;
	requests?: (string | { productOrService?: string })[];
	draft: null | {
		language?: "it" | "en";
		mustAsk?: string[];
		mustNotAskVatNumber?: boolean;
		mustNotInventPrices?: boolean;
		allowedAmounts?: string[];
		mustMention?: string[];
		mustNotMention?: string[];
		mustListItemsAsBullets?: boolean;
		expectedSalutationContains?: string;
		piiCheck?: boolean;
	};
	tenantConfig?: { requireVatNumber?: boolean };
	flow?: { praticaAction?: string };
};

const jsonl = async <T>(path: string): Promise<T[]> =>
	(await readFile(path, "utf8"))
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as T);

const cases = (await jsonl<CaseRow>(join(root, "dataset/cases.jsonl"))).filter((c) => only.length === 0 || only.some((o) => c.id.startsWith(o)));
const gold = new Map((await jsonl<GoldRow>(join(root, "gold/labels.jsonl"))).map((g) => [g.id, g]));
const checks = await loadChecks(root);
const rubric = await readFile(join(root, "rubrics/draft_rubric.md"), "utf8");

const client: ModelClient = createPiCompletionClient({
	apiKey: async (provider) => (provider === "anthropic" ? key : undefined),
	assertAllowed: (provider) => {
		if (provider !== "anthropic") throw new EgressDenied("model_provider", provider);
	},
});
const { draft: sonnet } = DEFAULT_MODEL_ROLES;
// One ledger for the run, caps out of the way; the judge's own calls are counted apart.
const usage = new UsageLedger(await mkdtemp(join(tmpdir(), "owni-judge-usage-")), { softUsdPerDay: 1e9, hardUsdPerDay: 1e9 });
let judgeUsd = 0;

const JUDGE_SYSTEM = `You are a strict reviewer of reply drafts written for an Italian SME's sales team. Apply this rubric exactly and return ONLY the JSON object it describes, no prose, no code fences.\n\n${rubric}`;

type CaseResult = {
	id: string;
	droppedBeforeModel?: boolean;
	classification: { gold: string; predicted: string; ok: boolean };
	extraction?: { counts: FieldCounts; exact: boolean; mismatches: string[]; missingFields: { gold: string[]; predicted: string[] } };
	draft?: { source: "model" | "template"; checkFailures: { check: string; detail: string }[]; verdict?: JudgeVerdict; judgeError?: string; subject: string; body: string };
	error?: string;
};

async function runCase(c: CaseRow): Promise<CaseResult> {
	const g = gold.get(c.id);
	if (g === undefined) throw new Error(`missing gold for ${c.id}`);
	const mail: InboundMail = {
		messageId: c.email.messageId,
		...(c.email.threadId === undefined ? {} : { threadId: c.email.threadId }),
		from: c.email.from,
		...(c.email.fromName === undefined ? {} : { fromName: c.email.fromName }),
		subject: c.email.subject,
		bodyText: c.email.bodyText ?? c.email.body ?? "",
		receivedAt: c.email.receivedAt,
		...(c.email.inReplyTo === undefined ? {} : { inReplyTo: c.email.inReplyTo }),
	};
	// What production runs: the whole pipeline, with a fake mailbox and CRM.
	const dir = await mkdtemp(join(tmpdir(), "owni-judge-"));
	const audit = new AuditLog(dir, tenantId("judge"));
	const notifications: string[] = [];
	const result0 = await processInboundMail(
		{
			tenantId: "judge",
			instanceId: "segreteria",
			practices: new PracticeStore(join(dir, "instance")),
			mail: new FakeMailAdapter(),
			crm: new FakeCrmAdapter(),
			audit,
			usage,
			roles: DEFAULT_MODEL_ROLES,
			model: { client, checks },
			...(g.tenantConfig === undefined ? {} : { tenantConfig: g.tenantConfig }),
			notify: async (n) => {
				notifications.push(n.text);
			},
		},
		mail,
	);
	const pratica = result0.pratica;
	const events = await audit.read();
	if (events.some((e) => e.type === "model.failed")) throw new Error(`model failed: ${events.filter((e) => e.type === "model.failed").map((e) => e.error).join("; ")}`);
	// Invalid senders are dropped before any model call: not a classification result.
	if (result0.action === "log_only") return { id: c.id, droppedBeforeModel: true, classification: { gold: g.classification, predicted: "dropped", ok: g.flow?.praticaAction === "log_only" } };

	const predicted = pratica.classification ?? "richiesta_preventivo";
	const result: CaseResult = { id: c.id, classification: { gold: g.classification, predicted, ok: predicted === g.classification } };
	if (g.lead !== null && pratica.status === "draft_ready") {
		result.extraction = {
			...compareLead(pratica.lead as unknown as Record<string, unknown>, g.lead),
			missingFields: { gold: [...((g.lead.missingFields as string[]) ?? [])].sort(), predicted: [...pratica.missingFields].sort() },
		};
	}
	if (g.draft === null || pratica.status !== "draft_ready") return result;

	const fallback = events.some((e) => e.type === "draft.fallback");
	const requestCount = g.requests?.length ?? 0;
	const checkFailures = runDeterministicChecks(checks, {
		subject: pratica.draftSubject,
		body: pratica.draftBody,
		language: g.draft.language ?? (pratica.lead.originalLanguage === "en" ? "en" : "it"),
		mustAsk: g.draft.mustAsk,
		mustNotAskVatNumber: g.draft.mustNotAskVatNumber,
		mustNotInventPrices: g.draft.mustNotInventPrices ?? true,
		allowedAmounts: g.draft.allowedAmounts,
		mustMention: g.draft.mustMention,
		mustNotMention: g.draft.mustNotMention,
		mustListItemsAsBullets: g.draft.mustListItemsAsBullets,
		requestCount,
		expectedSalutationContains: g.draft.expectedSalutationContains,
		customerEmail: (g.lead?.email as string | null) ?? null,
		piiCheck: g.draft.piiCheck ?? true,
	});
	result.draft = { source: fallback ? "template" : "model", checkFailures, subject: pratica.draftSubject, body: pratica.draftBody };
	try {
		const answer = await client.complete({
			model: sonnet,
			system: JUDGE_SYSTEM,
			user: `Original email:\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.bodyText}\n\nGold expectations for the draft:\n${JSON.stringify({ ...g.draft, requests: g.requests, lead: g.lead }, null, 2)}\n\nDraft to review:\nSubject: ${pratica.draftSubject}\n\n${pratica.draftBody}`,
			maxTokens: 800,
		});
		judgeUsd += answer.costUsd ?? estimateUsd(sonnet.modelId, answer.inputTokens, answer.outputTokens);
		result.draft.verdict = parseVerdict(parseJsonObject(answer.text));
	} catch (error) {
		result.draft.judgeError = error instanceof Error ? error.message : String(error);
	}
	return result;
}

/** A few cases at a time: keeps well inside the API rate limits. */
async function runAll(rows: CaseRow[], concurrency = 4): Promise<CaseResult[]> {
	const results: CaseResult[] = new Array(rows.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < rows.length) {
				const index = next++;
				const row = rows[index] as CaseRow;
				try {
					results[index] = await runCase(row);
				} catch (error) {
					results[index] = { id: row.id, classification: { gold: "", predicted: "", ok: false }, error: error instanceof Error ? error.message : String(error) };
				}
				process.stderr.write(".");
			}
		}),
	);
	process.stderr.write("\n");
	return results;
}

const results = await runAll(cases);
const scored = results.filter((r) => r.error === undefined && r.droppedBeforeModel !== true);
const extractions = scored.flatMap((r) => (r.extraction === undefined ? [] : [r.extraction]));
const drafts = scored.flatMap((r) => (r.draft === undefined ? [] : [{ id: r.id, ...r.draft }]));
const verdicts = drafts.flatMap((d) => (d.verdict === undefined ? [] : [{ id: d.id, verdict: d.verdict }]));

const summary = {
	cases: results.length,
	errors: results.filter((r) => r.error !== undefined).map((r) => ({ id: r.id, error: r.error })),
	classificationAccuracy: scored.length === 0 ? 0 : scored.filter((r) => r.classification.ok).length / scored.length,
	// Spam read as a quote or a thread reply would both produce a draft and a CRM lead.
	spamTakenForQuote: scored.filter((r) => r.classification.gold === "spam" && r.classification.predicted !== "spam" && r.classification.predicted !== "non_commerciale").map((r) => r.id),
	droppedBeforeModel: results.filter((r) => r.droppedBeforeModel === true).map((r) => ({ id: r.id, expected: r.classification.ok })),
	microF1: microF1(extractions.map((e) => e.counts)),
	exactMatch: extractions.length === 0 ? 0 : extractions.filter((e) => e.exact).length / extractions.length,
	missingFieldsExact: extractions.length === 0 ? 0 : extractions.filter((e) => e.missingFields.gold.join() === e.missingFields.predicted.join()).length / extractions.length,
	draftCheckFailures: drafts.filter((d) => d.checkFailures.length > 0).map((d) => ({ id: d.id, failures: d.checkFailures })),
	templateFallbacks: drafts.filter((d) => d.source === "template").map((d) => d.id),
	judgeMean: verdicts.length === 0 ? 0 : verdicts.reduce((n, v) => n + meanScore(v.verdict), 0) / verdicts.length,
	judgeHardFails: verdicts.filter((v) => hardFail(v.verdict)).map((v) => ({ id: v.id, scores: v.verdict.scores, rationale: v.verdict.rationale })),
	judgeErrors: drafts.filter((d) => d.judgeError !== undefined).map((d) => ({ id: d.id, error: d.judgeError })),
	costUsd: Number(((await usage.todaySpent()) + judgeUsd).toFixed(4)),
};

const failedGates = [
	summary.errors.length > 0 && `${summary.errors.length} case(s) errored`,
	summary.classificationAccuracy < GATES.classificationAccuracy && `classification accuracy ${summary.classificationAccuracy.toFixed(2)} < ${GATES.classificationAccuracy}`,
	summary.spamTakenForQuote.length > 0 && `spam taken for a quote: ${summary.spamTakenForQuote.join(", ")}`,
	summary.microF1 < GATES.microF1 && `extraction micro-F1 ${summary.microF1.toFixed(2)} < ${GATES.microF1}`,
	summary.exactMatch < GATES.exactMatch && `exact-match leads ${summary.exactMatch.toFixed(2)} < ${GATES.exactMatch}`,
	summary.draftCheckFailures.length > 0 && `${summary.draftCheckFailures.length} draft(s) fail the deterministic checks`,
	drafts.length > 0 && summary.templateFallbacks.length / drafts.length > GATES.maxTemplateFallbackShare &&
		`${summary.templateFallbacks.length}/${drafts.length} drafts fell back to the template (model drafts failing the checks)`,
	summary.droppedBeforeModel.some((d) => !d.expected) && "a valid sender was dropped before the model",
	summary.judgeMean < GATES.judgeMean && `judge mean ${summary.judgeMean.toFixed(2)} < ${GATES.judgeMean}`,
	summary.judgeHardFails.length > 0 && `${summary.judgeHardFails.length} draft(s) with factual/noHallucination/pii = 1`,
	summary.judgeErrors.length > 0 && `${summary.judgeErrors.length} verdict(s) unreadable`,
].filter((g): g is string => typeof g === "string");

const outDir = join(root, "last-report");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "judge.json"), `${JSON.stringify({ at: new Date().toISOString(), gates: GATES, failedGates, summary, results }, null, "\t")}\n`);

console.log(
	`eval:segreteria:judge cases=${summary.cases} classification=${summary.classificationAccuracy.toFixed(2)} microF1=${summary.microF1.toFixed(2)} ` +
		`exact=${summary.exactMatch.toFixed(2)} judge=${summary.judgeMean.toFixed(2)} fallbacks=${summary.templateFallbacks.length} cost=$${summary.costUsd}`,
);
if (failedGates.length > 0) {
	console.error(`gates failed:\n- ${failedGates.join("\n- ")}\nDetails: evals/segreteria/last-report/judge.json`);
	process.exit(1);
}
console.log("ok");
