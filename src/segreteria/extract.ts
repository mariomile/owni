import type { InboundMail } from "../connectors/types.ts";
import type { LeadFields, MissingField, TenantSegreteriaConfig } from "../core/practice.ts";
import { extractEmailAddress } from "./classify.ts";
import { vatInMail, vatToAsk } from "./vat.ts";

const TITLE_RE = /\b(Dott\.ssa|Dott\.|Avv\.|Ing\.|Arch\.|Prof\.ssa|Prof\.|Geom\.|Rag\.)\s+/i;

/** Heuristic lead extraction for tests / faux CI (no live model). */
export function extractLead(
	mail: InboundMail,
	tenantConfig: TenantSegreteriaConfig = {},
): LeadFields {
	const email = extractEmailAddress(mail.from) ?? null;
	const fromName = mail.fromName ?? (/^([^<]+)</.exec(mail.from)?.[1]?.trim() || undefined);
	let title: LeadFields["title"] = null;
	let fullName = fromName ?? null;
	const tm = fromName ? TITLE_RE.exec(fromName) : null;
	if (tm) {
		const t = tm[1]!;
		const normalized = (t.endsWith(".") ? t : `${t}.`) as LeadFields["title"];
		const canon = ["Dott.", "Dott.ssa", "Avv.", "Ing.", "Arch.", "Prof.", "Prof.ssa", "Geom.", "Rag."] as const;
		title = canon.find((c) => c.toLowerCase() === normalized!.toLowerCase()) ?? null;
		fullName = fromName!.replace(TITLE_RE, "").trim();
	}

	const body = mail.bodyText ?? "";
	const company =
		/(?:azienda|società|ditta|ragione sociale)\s*[:\-]\s*([^\n.]+)/i.exec(body)?.[1]?.trim() ??
		/([A-Z][A-Za-z0-9 &]+ (?:Srl|S\.r\.l\.|Spa|S\.p\.A\.|Ltd|GmbH))/i.exec(body)?.[1]?.trim() ??
		null;

	const product =
		/(?:preventivo|richiedo|vorrei|interessat[oa])\s+(?:per|di|su)?\s*([^\n.]{5,80})/i.exec(body)?.[1]?.trim() ??
		/(?:prodotto|servizio)\s*[:\-]\s*([^\n.]+)/i.exec(body)?.[1]?.trim() ??
		null;

	const quantity =
		/(?:quantità|n\.?\s*pezzi|n°)\s*[:\-]?\s*(\d+[^\n.]{0,20})/i.exec(body)?.[1]?.trim() ??
		/\b(\d+)\s*(?:pezzi|unità|stampanti|macchine|mq|metri)\b/i.exec(body)?.[1]?.trim() ??
		null;

	const urgency =
		/(?:entro|scadenza|urgente|consegna)\s+([^\n.]{3,40})/i.exec(body)?.[1]?.trim() ?? null;

	const vat = vatInMail(body);

	const deliverySite =
		/(?:sede|consegna presso|installazione|indirizzo)\s*[:\-]?\s*([^\n.]{3,60})/i.exec(body)?.[1]?.trim();

	const hasBudgetMention = /budget/i.test(body);

	const lang: LeadFields["originalLanguage"] = detectLanguage(body);

	const missing: MissingField[] = [];
	if (!fullName) missing.push("fullName");
	if (!company) missing.push("company");
	if (!email) missing.push("email");
	if (!product) missing.push("productOrService");
	if (!quantity) missing.push("quantity");
	if (!deliverySite) missing.push("deliverySite");
	if (!hasBudgetMention) missing.push("budget");
	if (!urgency) missing.push("deadline");
	const vatAsk = vatToAsk(vat, tenantConfig.requireVatNumber === true, company !== null);
	if (vatAsk !== undefined) missing.push(vatAsk);

	const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);

	return {
		fullName,
		title,
		company,
		email,
		phone: /(?:tel|cell|phone)\s*[:\-]?\s*([+\d][\d\s.]{7,})/i.exec(body)?.[1]?.trim() ?? null,
		productOrService: product,
		quantity,
		urgency,
		vatNumber: vat.vatNumber,
		originalLanguage: lang,
		missingFields: missing,
		source: "email",
		rawSubject: mail.subject,
		rawSnippet: snippet,
		receivedAt: mail.receivedAt,
		mailMessageId: mail.messageId,
	};
}

function detectLanguage(text: string = ""): LeadFields["originalLanguage"] {
	const it = (text.match(/\b(il|la|di|per|che|una|sono|grazie|richiedo|preventivo)\b/gi) ?? []).length;
	const en = (text.match(/\b(the|and|for|please|quote|request|would|thanks)\b/gi) ?? []).length;
	if (it > 0 && en > 0 && Math.min(it, en) / Math.max(it, en) > 0.4) return "it+en";
	if (en > it * 1.5) return "en";
	if (it === 0 && en === 0) return "other";
	return "it";
}
