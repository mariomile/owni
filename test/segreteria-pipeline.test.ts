import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCrmAdapter } from "../src/connectors/crm-fake.ts";
import { FakeMailAdapter } from "../src/connectors/mail-fake.ts";
import { AuditLog } from "../src/core/audit.ts";
import { tenantId as tid } from "../src/core/ids.ts";
import { FAUX_MODEL_ROLES } from "../src/core/model-routing.ts";
import { callbackData, PracticeStore } from "../src/core/practice.ts";
import { UsageLedger } from "../src/core/usage.ts";
import { type CallbackDeps, handleEditMessage, handleTelegramCallback, recoverAfterCrash } from "../src/segreteria/callbacks.ts";
import { forceQuote, type PipelineDeps, processInboundMail } from "../src/segreteria/pipeline.ts";
import type { InboundMail } from "../src/connectors/types.ts";

function harness() {
	const dataDir = mkdtempSync(join(tmpdir(), "owni-seg-"));
	const tenantId = "acme";
	const instanceId = "segreteria";
	const practices = new PracticeStore(join(dataDir, tenantId, "instances", instanceId));
	const mail = new FakeMailAdapter();
	const crm = new FakeCrmAdapter();
	const audit = new AuditLog(dataDir, tid("acme"));
	const usage = new UsageLedger(join(dataDir, tenantId));
	const notifications: Array<{ text: string; buttons: readonly string[]; praticaId: string }> = [];
	const notify = async (msg: { text: string; buttons: readonly string[]; praticaId: string; draftVersion: number }) => {
		notifications.push(msg);
	};
	const deps: PipelineDeps = {
		tenantId,
		instanceId,
		practices,
		mail,
		crm,
		audit,
		usage,
		roles: FAUX_MODEL_ROLES,
		notify,
	};
	const cb: CallbackDeps = {
		tenantId,
		instanceId,
		practices,
		mail,
		crm,
		audit,
		allowedUserIds: new Set(["7"]),
		notify,
	};
	return { deps, cb, mail, crm, audit, practices, notifications, usage, dataDir };
}

const sampleMail = (over: Partial<InboundMail> = {}): InboundMail => ({
	messageId: "m1",
	from: "Marta Bianchi <marta.bianchi@acme.example>",
	fromName: "Marta Bianchi",
	subject: "Richiesta preventivo stampante",
	bodyText: "Buongiorno, chiedo preventivo per 2 stampanti UV. Sede Milano. Grazie.",
	receivedAt: "2026-10-15T12:00:00.000Z",
	...over,
});

describe("segreteria pipeline", () => {
	it("never sends before Approva (gate)", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		expect(r.sends).toBe(0);
		expect(h.mail.sent).toHaveLength(0);
		expect(r.pratica.status).toBe("draft_ready");
		expect(h.notifications.at(-1)?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
	});

	it("Approva sends exactly once; second Approva is idempotent", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		const data = callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve");
		const a1 = await handleTelegramCallback(h.cb, { userId: "7", callbackData: data });
		expect(a1.kind).toBe("handled");
		expect(h.mail.sent).toHaveLength(1);
		const a2 = await handleTelegramCallback(h.cb, { userId: "7", callbackData: data });
		expect(h.mail.sent).toHaveLength(1);
		expect(a2.kind).toBe("handled");
	});

	it("a CRM failure after the mail went out keeps the pratica sent and says the CRM was not updated", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		h.crm.updateLeadStatus = async () => {
			throw new Error("CRM timeout");
		};
		h.notifications.length = 0;
		const res = await handleTelegramCallback(h.cb, { userId: "7", callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve") });
		expect(res).toMatchObject({ kind: "handled", sent: true });
		expect(h.mail.sent).toHaveLength(1);
		const after = await h.practices.get(r.pratica.praticaId);
		expect(after?.status).toBe("sent");
		expect(after?.lastError?.code).toBe("crm_update_failed");
		const texts = h.notifications.map((n) => n.text).join("\n---\n");
		expect(texts).toContain("Inviata");
		expect(texts).toContain("CRM non aggiornato");
		expect(texts).not.toContain("Invio non riuscito");
		expect(h.notifications.every((n) => n.buttons.length === 0)).toBe(true);
	});

	it("a CRM failure on Scarta still discards and tells the sales person", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		h.crm.updateLeadStatus = async () => {
			throw new Error("CRM timeout");
		};
		await handleTelegramCallback(h.cb, { userId: "7", callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "discard") });
		expect((await h.practices.get(r.pratica.praticaId))?.status).toBe("discarded");
		expect(h.notifications.at(-1)?.text).toContain("CRM non aggiornato");
	});

	it("a tap redelivered after a crash mid-send never sends again; a fresh tap on the recovery card does", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		const data = callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve");
		// Crash after Gmail accepted the mail and before the pratica was saved as sent.
		h.mail.sendReply = async () => {
			throw new Error("process killed");
		};
		await handleTelegramCallback(h.cb, { userId: "7", callbackData: data, actionId: "tap-1" }).catch(() => {});
		const crashed = (await h.practices.get(r.pratica.praticaId))!;
		crashed.status = "approved";
		delete crashed.lastError;
		await h.practices.save(crashed);
		const real = new FakeMailAdapter();
		h.cb.mail = real;
		const again = await handleTelegramCallback(h.cb, { userId: "7", callbackData: data, actionId: "tap-1" });
		expect(again).toEqual({ kind: "ignored", reason: "redelivered" });
		expect(real.sent).toHaveLength(0);
		const fresh = await handleTelegramCallback(h.cb, { userId: "7", callbackData: data, actionId: "tap-2" });
		expect(fresh).toMatchObject({ kind: "handled", sent: true });
		expect(real.sent).toHaveLength(1);
	});

	it("a crash before the draft is ready leaves no pratica: the mail is read again from the start", async () => {
		const h = harness();
		const record = h.usage.record.bind(h.usage);
		let killed = false;
		h.usage.record = async (rec, audit) => {
			if (rec.role === "draft" && !killed) {
				killed = true;
				throw new Error("process killed");
			}
			return record(rec, audit);
		};
		await expect(processInboundMail(h.deps, sampleMail())).rejects.toThrow("process killed");
		expect(await h.practices.findByMailMessageId("m1")).toBeUndefined();
		const r = await processInboundMail(h.deps, sampleMail());
		expect(r.action).toBe("create");
		expect(r.pratica.status).toBe("draft_ready");
		expect(h.notifications.at(-1)?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
	});

	it("a reply in the thread of a sent pratica gets a new draft that can be sent", async () => {
		const h = harness();
		const first = await processInboundMail(h.deps, sampleMail({ messageId: "m1", threadId: "t1" }));
		await handleTelegramCallback(h.cb, { userId: "7", callbackData: callbackData(first.pratica.praticaId, 1, "approve"), actionId: "a1" });
		const follow = await processInboundMail(h.deps, sampleMail({ messageId: "m2", threadId: "t1", bodyText: "Ecco i dati: 3 stampanti, consegna a Milano." }));
		expect(follow.action).toBe("attach_to_existing");
		expect(follow.pratica.sentMessageId).toBeUndefined();
		expect(follow.pratica.sentHistory).toEqual(["sent-1"]);
		const res = await handleTelegramCallback(h.cb, { userId: "7", callbackData: callbackData(follow.pratica.praticaId, follow.pratica.draftVersion, "approve"), actionId: "a2" });
		expect(res).toMatchObject({ kind: "handled", sent: true });
		expect(h.mail.sent.map((s) => s.inReplyToMessageId)).toEqual(["m1", "m2"]);
	});

	it("Approva on a spam card builds a draft and shows it; nothing is sent until that draft is approved", async () => {
		const h = harness();
		h.deps.classify = () => "spam";
		const r = await processInboundMail(h.deps, sampleMail());
		expect(r.pratica.status).toBe("classified_skip");
		h.cb.forceExtract = async (p) => {
			await forceQuote({ ...h.deps, classify: undefined }, p);
		};
		const forced = await handleTelegramCallback(h.cb, { userId: "7", callbackData: callbackData(r.pratica.praticaId, 0, "approve"), actionId: "s1" });
		expect(forced).toMatchObject({ kind: "handled", sent: false });
		expect(h.mail.sent).toHaveLength(0);
		const after = (await h.practices.get(r.pratica.praticaId))!;
		expect(after).toMatchObject({ status: "draft_ready", classification: "richiesta_preventivo", draftVersion: 1 });
		expect(after.lead.email).toBe("marta.bianchi@acme.example");
		expect(h.notifications.at(-1)?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
		await handleTelegramCallback(h.cb, { userId: "7", callbackData: callbackData(after.praticaId, 1, "approve"), actionId: "s2" });
		expect(h.mail.sent).toHaveLength(1);
	});

	it("Scarta does not send", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		const data = callbackData(r.pratica.praticaId, r.pratica.draftVersion, "discard");
		await handleTelegramCallback(h.cb, { userId: "7", callbackData: data });
		expect(h.mail.sent).toHaveLength(0);
		expect((await h.practices.get(r.pratica.praticaId))?.status).toBe("discarded");
	});

	it("Modifica then text bumps draftVersion; annulla modifica does not", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		const v1 = r.pratica.draftVersion;
		await handleTelegramCallback(h.cb, {
			userId: "7",
			callbackData: callbackData(r.pratica.praticaId, v1, "edit"),
		});
		await handleEditMessage(h.cb, { userId: "7", praticaId: r.pratica.praticaId, text: "Togli la domanda sul budget." });
		const after = await h.practices.get(r.pratica.praticaId);
		expect(after?.draftVersion).toBe(v1 + 1);
		await handleTelegramCallback(h.cb, {
			userId: "7",
			callbackData: callbackData(after!.praticaId, after!.draftVersion, "edit"),
		});
		await handleEditMessage(h.cb, { userId: "7", praticaId: r.pratica.praticaId, text: "annulla modifica" });
		const cancelled = await h.practices.get(r.pratica.praticaId);
		expect(cancelled?.draftVersion).toBe(after!.draftVersion);
		expect(cancelled?.status).toBe("draft_ready");
	});

	it("crash after approve re-proposes buttons; no silent send", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		const p = (await h.practices.get(r.pratica.praticaId))!;
		p.status = "approved";
		p.approvedBy = "7";
		p.approvedAt = new Date().toISOString();
		await h.practices.save(p);
		h.notifications.length = 0;
		await recoverAfterCrash(h.cb, p.praticaId);
		expect(h.mail.sent).toHaveLength(0);
		expect(h.notifications[0]?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
		expect(h.notifications[0]?.text).toContain("Invio non completato");
	});

	it("send_email tool replaySafe is false", async () => {
		const { createMailTools } = await import("../src/core/tools/mail-tools.ts");
		const h = harness();
		const tools = createMailTools({
			tenantId: "acme",
			mail: h.mail,
			practices: h.practices,
			maySend: async () => true,
		});
		expect(tools.find((t) => t.name === "send_email")?.replaySafe).toBe(false);
	});

	it("A8: non-allowlisted tap ignored and audited on open pratica", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		const before = (await h.practices.get(r.pratica.praticaId))!.status;
		const res = await handleTelegramCallback(h.cb, {
			userId: "999",
			callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve"),
		});
		expect(res).toEqual({ kind: "ignored", reason: "not_allowlisted" });
		expect(h.mail.sent).toHaveLength(0);
		expect((await h.practices.get(r.pratica.praticaId))?.status).toBe(before);
		const events = await h.audit.read();
		expect(events.some((e) => e.type === "user.denied")).toBe(true);
	});

	it("A8: non-allowlisted tap ignored on closed pratica", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		await handleTelegramCallback(h.cb, {
			userId: "7",
			callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "discard"),
		});
		const res = await handleTelegramCallback(h.cb, {
			userId: "999",
			callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve"),
		});
		expect(res.kind).toBe("ignored");
		expect((await h.practices.get(r.pratica.praticaId))?.status).toBe("discarded");
	});

	it("A2: invalid sender → no lead, notice without buttons, status failed", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail({ from: "not-an-email", fromName: "X" }));
		expect(r.action).toBe("log_only");
		expect(r.crmUpserts).toBe(0);
		expect(h.crm.upsertCalls).toBe(0);
		expect(r.pratica.status).toBe("failed");
		expect(h.notifications.at(-1)?.buttons).toEqual([]);
		expect(h.notifications.at(-1)?.text).toContain("mittente non valido");
	});

	it("A4: non_commerciale → no lead, no buttons", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail({
			subject: "Problema con la fattura",
			bodyText: "Buongiorno, ho un problema con la fattura di settembre.",
		}));
		expect(r.pratica.classification).toBe("non_commerciale");
		expect(h.crm.upsertCalls).toBe(0);
		expect(h.notifications.at(-1)?.buttons).toEqual([]);
		expect(h.notifications.at(-1)?.text).toContain("non commerciale");
	});

	it("A5: new request on same thread updates same lead and new draft", async () => {
		const h = harness();
		const first = await processInboundMail(h.deps, sampleMail({ messageId: "m1", threadId: "t1" }));
		await handleTelegramCallback(h.cb, {
			userId: "7",
			callbackData: callbackData(first.pratica.praticaId, first.pratica.draftVersion, "approve"),
		});
		const second = await processInboundMail(
			h.deps,
			sampleMail({
				messageId: "m2",
				threadId: "t1",
				subject: "Re: Richiesta preventivo stampante",
				bodyText: "Aggiungo anche 1 plotter A0. Grazie.",
				inReplyTo: "m1",
			}),
		);
		expect(second.action).toBe("attach_to_existing");
		expect(second.pratica.praticaId).toBe(first.pratica.praticaId);
		expect(second.pratica.draftVersion).toBeGreaterThan(first.pratica.draftVersion);
		expect(h.notifications.at(-1)?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
		expect(h.notifications.at(-1)?.text).toContain("Nuova richiesta sul thread");
		const list = await h.practices.list();
		expect(list).toHaveLength(1);
	});

	it("ingress idempotency: same mailMessageId → noop_duplicate", async () => {
		const h = harness();
		const a = await processInboundMail(h.deps, sampleMail());
		const b = await processInboundMail(h.deps, sampleMail());
		expect(b.action).toBe("noop_duplicate");
		expect(b.pratica.praticaId).toBe(a.pratica.praticaId);
		expect(h.crm.upsertCalls).toBe(1);
	});

	it("failed send keeps buttons for retry Approva", async () => {
		const h = harness();
		const r = await processInboundMail(h.deps, sampleMail());
		h.mail.failNextSend = true;
		await handleTelegramCallback(h.cb, {
			userId: "7",
			callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve"),
		});
		expect(h.mail.sent).toHaveLength(0);
		expect(h.notifications.at(-1)?.buttons).toEqual(["Approva", "Modifica", "Scarta"]);
		expect(h.notifications.at(-1)?.text).toContain("Invio non riuscito");
		await handleTelegramCallback(h.cb, {
			userId: "7",
			callbackData: callbackData(r.pratica.praticaId, r.pratica.draftVersion, "approve"),
		});
		expect(h.mail.sent).toHaveLength(1);
	});
});
