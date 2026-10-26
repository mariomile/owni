import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ChecksConfig = {
	prices: {
		forbiddenPatterns: string[];
		alsoForbidden: string[];
	};
	register: {
		leiMarkersRequired: { minMatches: number; patterns: string[] };
		tuMarkersForbidden: string[];
	};
	registerEn?: {
		requiredAny: string[];
		forbidden: string[];
	};
	mustAsk: {
		keywords: Record<string, string[]>;
	};
	mustNotMention?: { rule?: string };
	pii: {
		forbiddenPatterns: Record<string, string>;
	};
};

export type DraftCheckInput = {
	subject: string;
	body: string;
	language?: "it" | "en";
	mustAsk?: readonly string[];
	mustNotAskVatNumber?: boolean;
	mustNotInventPrices?: boolean;
	allowedAmounts?: readonly string[];
	mustNotMention?: readonly string[];
	mustMention?: readonly string[];
	mustListItemsAsBullets?: boolean;
	requestCount?: number;
	expectedSalutationContains?: string;
	customerEmail?: string | null;
	piiCheck?: boolean;
};

export type CheckFailure = { check: string; detail: string };

export async function loadChecks(evalsRoot: string): Promise<ChecksConfig> {
	return JSON.parse(await readFile(join(evalsRoot, "checks.json"), "utf8")) as ChecksConfig;
}


function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Short tokens (ti, Ciao) use word boundaries so "fusti " does not match "ti ". */
function mentionsForbidden(hay: string, mention: string): boolean {
	const core = mention.trim();
	if (core.length <= 4) {
		return new RegExp(`(^|[^\\p{L}])${escapeRegExp(core)}([^\\p{L}]|$)`, "iu").test(hay);
	}
	return hay.toLowerCase().includes(mention.toLowerCase());
}

export function runDeterministicChecks(cfg: ChecksConfig, draft: DraftCheckInput): CheckFailure[] {
	const fails: CheckFailure[] = [];
	const bodyNoQuotes = draft.body
		.split("\n")
		.filter((l) => !l.trimStart().startsWith(">"))
		.join("\n");
	const hay = `${draft.subject}\n${bodyNoQuotes}`;

	if (draft.mustNotInventPrices !== false) {
		let scrubbed = hay;
		for (const amt of draft.allowedAmounts ?? []) {
			scrubbed = scrubbed.split(amt).join("");
		}
		for (const pat of cfg.prices.forbiddenPatterns) {
			if (new RegExp(pat, "iu").test(scrubbed)) {
				fails.push({ check: "prices", detail: `forbidden pattern /${pat}/` });
			}
		}
		for (const word of cfg.prices.alsoForbidden) {
			if (scrubbed.toLowerCase().includes(word.toLowerCase())) {
				fails.push({ check: "prices", detail: `forbidden phrase "${word}"` });
			}
		}
	}

	const lang = draft.language ?? "it";
	if (lang === "it") {
		const leiHits = cfg.register.leiMarkersRequired.patterns.reduce((n, pat) => {
			const m = hay.match(new RegExp(pat, "giu"));
			return n + (m?.length ?? 0);
		}, 0);
		if (leiHits < cfg.register.leiMarkersRequired.minMatches) {
			fails.push({ check: "register", detail: `lei markers ${leiHits} < ${cfg.register.leiMarkersRequired.minMatches}` });
		}
		for (const pat of cfg.register.tuMarkersForbidden) {
			if (new RegExp(pat, "iu").test(hay)) {
				fails.push({ check: "register", detail: `tu marker /${pat}/` });
			}
		}
	} else if (lang === "en" && cfg.registerEn) {
		const any = cfg.registerEn.requiredAny.some((pat) => new RegExp(pat, "imu").test(hay));
		if (!any) fails.push({ check: "registerEn", detail: "missing formal EN markers" });
		for (const pat of cfg.registerEn.forbidden) {
			if (new RegExp(pat, "iu").test(hay)) fails.push({ check: "registerEn", detail: `forbidden /${pat}/` });
		}
	}

	for (const field of draft.mustAsk ?? []) {
		const kws = cfg.mustAsk.keywords[field] ?? [];
		const sentences = hay.split(/(?<=[?])|\n/).filter((s) => /\?|può indicarci|potrebbe indicarci|ci indichi|ci comunichi|ci conferm|could you|please/i.test(s));
		const hit = sentences.some((s) => kws.some((k) => s.toLowerCase().includes(k.toLowerCase())));
		if (!hit) fails.push({ check: "mustAsk", detail: `missing question for ${field}` });
	}

	if (draft.mustNotAskVatNumber) {
		const kws = cfg.mustAsk.keywords.vatNumber ?? [];
		// Asking to re-check a number the customer volunteered (vatNumberInvalid) is not asking for one.
		const recheck = draft.mustAsk?.includes("vatNumberInvalid") ? (cfg.mustAsk.keywords.vatNumberInvalid ?? []) : [];
		const sentences = hay.split(/(?<=[?])|\n/).filter((s) => /\?/.test(s) && !recheck.some((k) => s.toLowerCase().includes(k.toLowerCase())));
		if (sentences.some((s) => kws.some((k) => s.toLowerCase().includes(k.toLowerCase())))) {
			fails.push({ check: "mustAsk", detail: "mustNotAskVatNumber violated" });
		}
	}

	if (draft.mustListItemsAsBullets && (draft.requestCount ?? 0) > 1) {
		const bullets = draft.body.split("\n").filter((l) => /^\s*([-•*]|\d+[.)])\s+/.test(l));
		if (bullets.length < (draft.requestCount ?? 0)) {
			fails.push({ check: "multiRequest", detail: `bullets ${bullets.length} < ${draft.requestCount}` });
		}
		if (!/priorit|preferenz|da quale (?:voce|prodotto) partire|which item/i.test(draft.body)) {
			fails.push({ check: "multiRequest", detail: "missing priority question" });
		}
	}

	for (const m of draft.mustMention ?? []) {
		if (!hay.toLowerCase().includes(m.toLowerCase())) {
			fails.push({ check: "mustMention", detail: m });
		}
	}
	for (const m of draft.mustNotMention ?? []) {
		if (mentionsForbidden(hay, m)) {
			fails.push({ check: "mustNotMention", detail: m });
		}
	}

	if (draft.expectedSalutationContains) {
		const head = draft.body.split("\n").slice(0, 2).join(" ");
		if (!head.toLowerCase().includes(draft.expectedSalutationContains.toLowerCase())) {
			fails.push({ check: "salutation", detail: draft.expectedSalutationContains });
		}
	}

	if (draft.piiCheck !== false) {
		const pats = cfg.pii.forbiddenPatterns;
		for (const [name, pat] of Object.entries(pats)) {
			if (name === "customerEmail") continue;
			if (new RegExp(pat, "iu").test(hay)) {
				fails.push({ check: "pii", detail: name });
			}
		}
		if (draft.customerEmail && hay.toLowerCase().includes(draft.customerEmail.toLowerCase())) {
			fails.push({ check: "pii", detail: "customerEmail" });
		}
	}

	return fails;
}
