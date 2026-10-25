import type { OwniTool } from "../engine.ts";
import { hashIdempotency, type PracticeStore } from "../practice.ts";
import type { CrmAdapter } from "../../connectors/types.ts";

/** CRM tools: upsert is replaySafe with idempotency key = mailMessageId. */
export function createCrmTools(options: {
	tenantId: string;
	crm: CrmAdapter;
	practices: PracticeStore;
}): OwniTool[] {
	const { tenantId, crm, practices } = options;

	const upsertLead: OwniTool = {
		name: "crm_upsert_lead",
		description: "Create or update a CRM lead for a pratica (idempotent on mailMessageId).",
		parameters: {
			type: "object",
			properties: { praticaId: { type: "string" } },
			required: ["praticaId"],
			additionalProperties: false,
		},
		replaySafe: true,
		async execute(args, ctx) {
			const praticaId = String(args.praticaId);
			return ctx.step(`crm_upsert:${praticaId}`, async () => {
				const pratica = await practices.get(praticaId);
				if (!pratica) return JSON.stringify({ ok: false, error: "pratica_not_found" });
				if (!pratica.lead.email) {
					return JSON.stringify({ ok: false, error: "invalid_sender_no_email" });
				}
				const key = hashIdempotency("crm", pratica.mailMessageId);
				try {
					const result = await crm.upsertLead(
						tenantId,
						{
							fullName: pratica.lead.fullName,
							title: pratica.lead.title,
							company: pratica.lead.company,
							email: pratica.lead.email,
							phone: pratica.lead.phone,
							productOrService: pratica.lead.productOrService,
							vatNumber: pratica.lead.vatNumber,
							originalLanguage: pratica.lead.originalLanguage,
							missingFields: pratica.lead.missingFields,
							rawSubject: pratica.lead.rawSubject,
							mailMessageId: pratica.mailMessageId,
						},
						key,
					);
					pratica.crmLeadId = result.crmLeadId;
					if (pratica.status === "received" || pratica.status === "classified_skip") {
						pratica.status = "lead_upserted";
					}
					await practices.save(pratica);
					return JSON.stringify({ ok: true, ...result });
				} catch (err) {
					return JSON.stringify({
						ok: false,
						error: "crm_unavailable",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			});
		},
	};

	return [upsertLead];
}
