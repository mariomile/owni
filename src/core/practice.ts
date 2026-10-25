import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { writeFileAtomic } from "./atomic-file.ts";

/** Lifecycle of one commercial "pratica" (quote request). */
export type PraticaStatus =
	| "received"
	| "classified_skip"
	| "lead_upserted"
	| "draft_ready"
	| "awaiting_edit"
	| "approved"
	| "sent"
	| "discarded"
	| "failed"
	| "logged";

/**
 * What the draft asks the customer for. vatNumberInvalid: a VAT number was given but fails the
 * formal check (tax-ids.ts, offline): asked to double-check it, and never kept as vatNumber.
 */
export type MissingField =
	| "fullName"
	| "company"
	| "email"
	| "productOrService"
	| "quantity"
	| "deliverySite"
	| "vatNumber"
	| "vatNumberInvalid"
	| "budget"
	| "deadline";

export type LeadTitle =
	| "Dott."
	| "Dott.ssa"
	| "Avv."
	| "Ing."
	| "Arch."
	| "Prof."
	| "Prof.ssa"
	| "Geom."
	| "Rag.";

export type LeadFields = {
	readonly fullName?: string | null;
	readonly title?: LeadTitle | null;
	readonly company?: string | null;
	readonly email: string | null;
	readonly phone?: string | null;
	readonly productOrService: string | null;
	readonly quantity?: string | null;
	readonly urgency?: string | null;
	/** Only a number that passes the formal check, normalized (Italian: 11 digits; foreign: with its prefix). */
	readonly vatNumber?: string | null;
	readonly originalLanguage?: "it" | "en" | "it+en" | "other";
	readonly missingFields: readonly MissingField[];
	readonly source: "email";
	readonly rawSubject: string;
	readonly rawSnippet: string;
	readonly receivedAt: string;
	readonly mailMessageId: string;
	readonly ownerUserId?: string;
	readonly notes?: string;
};

export type MailClassification =
	| "richiesta_preventivo"
	| "spam"
	| "risposta_thread"
	| "non_commerciale";

export type FlowAction =
	| "create"
	| "create_skip"
	| "attach_to_existing"
	| "noop_duplicate"
	| "log_only"
	| "notify_only";

/** Per-tenant product config (instance / tenant). Default: requireVatNumber false. */
export type TenantSegreteriaConfig = {
	readonly requireVatNumber?: boolean;
};

export type Pratica = {
	readonly praticaId: string;
	readonly tenantId: string;
	readonly instanceId: string;
	status: PraticaStatus;
	readonly mailMessageId: string;
	mailThreadId?: string;
	inReplyToPraticaId?: string;
	lead: LeadFields;
	missingFields: MissingField[];
	crmLeadId?: string;
	draftSubject: string;
	draftBody: string;
	draftVersion: number;
	approvedBy?: string;
	approvedAt?: string;
	sentMessageId?: string;
	/** Replies sent for earlier draft versions in the same thread, oldest first. */
	sentHistory?: string[];
	/**
	 * Channel ID of the Approva tap that started the current send. A tap redelivered after
	 * a crash carries the same ID and must not send again.
	 */
	approveActionId?: string;
	/** Who tapped Modifica, and when: their next text is the edit. */
	editingBy?: string;
	editingSince?: string;
	/** The mail this pratica was last built from (needed to force a spam mail into a quote). */
	mail?: {
		readonly messageId: string;
		readonly threadId?: string;
		readonly from: string;
		readonly fromName?: string;
		readonly subject: string;
		readonly bodyText: string;
		readonly receivedAt: string;
	};
	classification?: MailClassification;
	flowAction?: FlowAction;
	lastError?: { code: string; message: string; at: string };
	updatedAt: string;
	createdAt: string;
};

export function shortPraticaId(praticaId: string): string {
	return praticaId.slice(0, 8);
}

export function newPraticaId(): string {
	return randomBytes(8).toString("hex");
}

/**
 * Durable pratica store under the instance directory (atomic JSON, like the outbox).
 * Keyed by praticaId; also indexes mailMessageId → praticaId for ingress idempotency.
 */
export class PracticeStore {
	constructor(private readonly instanceDir: string) {}

	private dir(): string {
		return join(this.instanceDir, "pratiche");
	}

	private path(praticaId: string): string {
		return join(this.dir(), `${praticaId}.json`);
	}

	private indexPath(): string {
		return join(this.dir(), "_by-mail.json");
	}

	async ensure(): Promise<void> {
		await mkdir(this.dir(), { recursive: true });
	}

	async get(praticaId: string): Promise<Pratica | undefined> {
		try {
			const raw = await readFile(this.path(praticaId), "utf8");
			return JSON.parse(raw) as Pratica;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	}

	async findByMailMessageId(mailMessageId: string): Promise<Pratica | undefined> {
		const index = await this.readIndex();
		const id = index[mailMessageId];
		if (id === undefined) return undefined;
		return this.get(id);
	}

	async save(pratica: Pratica): Promise<void> {
		await this.ensure();
		pratica.updatedAt = new Date().toISOString();
		await writeFileAtomic(this.path(pratica.praticaId), `${JSON.stringify(pratica, null, "\t")}\n`);
		const index = await this.readIndex();
		index[pratica.mailMessageId] = pratica.praticaId;
		await writeFileAtomic(this.indexPath(), `${JSON.stringify(index, null, "\t")}\n`);
	}

	async list(): Promise<Pratica[]> {
		await this.ensure();
		const names = await readdir(this.dir());
		const out: Pratica[] = [];
		for (const name of names) {
			if (!name.endsWith(".json") || name.startsWith("_")) continue;
			const p = await this.get(name.replace(/\.json$/, ""));
			if (p) out.push(p);
		}
		return out;
	}

	private async readIndex(): Promise<Record<string, string>> {
		try {
			const raw = await readFile(this.indexPath(), "utf8");
			return JSON.parse(raw) as Record<string, string>;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
	}
}

/** Idempotent callback key: pratica + draft version + action. */
export function callbackData(praticaId: string, draftVersion: number, action: "approve" | "edit" | "discard"): string {
	return `owni:${praticaId}:${draftVersion}:${action}`;
}

export function parseCallbackData(data: string): { praticaId: string; draftVersion: number; action: "approve" | "edit" | "discard" } | undefined {
	const m = /^owni:([a-f0-9]+):(\d+):(approve|edit|discard)$/.exec(data);
	if (!m) return undefined;
	return { praticaId: m[1]!, draftVersion: Number(m[2]), action: m[3] as "approve" | "edit" | "discard" };
}

export function hashIdempotency(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}
