import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentFattura } from "../src/core/documents.ts";
import type { ToolContext } from "../src/core/engine.ts";
import { GoogleActionError } from "../src/core/google-actions.ts";
import { InvoiceStore } from "../src/core/invoice-store.ts";
import { createInvoiceTools, type InvoiceEvent } from "../src/core/tools/invoice-tools.ts";
import type { MailProposal as ReminderProposal, MailRequests as ReminderMail } from "../src/core/mail-requests.ts";
import type { ReadText } from "../src/core/tools/reminder-attachments.ts";
import { Workspace } from "../src/core/workspace.ts";

const NS = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";

export type Party = { name: string; vat?: string; fiscal?: string; email?: string };
type Rata = { amount: string; due?: string; iban?: string };
/** `split`: the VAT of a split-payment summary row (EsigibilitaIVA S). */
type Doc = { number: string; date: string; total: string; type?: string; currency?: string; rate?: Rata[]; split?: { taxable: string; vat: string } };
/** How the file was transmitted: a PEC, the FPA12 format and a codice ufficio for a public administration. */
type Transmission = { pec?: string; format?: "FPR12" | "FPA12"; code?: string };

export const BETA: Party = { name: "Beta Ristorazione Srl", vat: "00000520031" };
export const ALFA: Party = { name: "Alfa Forniture S.r.l.", vat: "00000510016" };
export const GAMMA: Party = { name: "Gamma Hotel S.p.A.", vat: "01234567897", email: "amministrazione@gamma.example" };
export const DELTA: Party = { name: "Delta Carni Srl", vat: "00000500157" };
export const ROSSI: Party = { name: "Mario Rossi", fiscal: "ZQXWKJ85T10A562F" };
export const COMUNE: Party = { name: "Comune di Esempio", fiscal: "80012345678" };

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function body(o: Doc): string {
	const rate = (o.rate ?? []).map((r) => {
		const due = r.due === undefined ? "" : `<DataScadenzaPagamento>${r.due}</DataScadenzaPagamento>`;
		const iban = r.iban === undefined ? "" : `<IBAN>${xmlText(r.iban)}</IBAN>`;
		return `<DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento>${due}<ImportoPagamento>${r.amount}</ImportoPagamento>${iban}</DettaglioPagamento>`;
	});
	const payment = rate.length === 0 ? "" : `<DatiPagamento><CondizioniPagamento>${rate.length > 1 ? "TP01" : "TP02"}</CondizioniPagamento>${rate.join("")}</DatiPagamento>`;
	const generali = `<TipoDocumento>${o.type ?? "TD01"}</TipoDocumento><Divisa>${o.currency ?? "EUR"}</Divisa><Data>${o.date}</Data><Numero>${xmlText(o.number)}</Numero><ImportoTotaleDocumento>${o.total}</ImportoTotaleDocumento>`;
	const line = `<NumeroLinea>1</NumeroLinea><Descrizione>Servizi</Descrizione><PrezzoUnitario>${o.total}</PrezzoUnitario><PrezzoTotale>${o.total}</PrezzoTotale><AliquotaIVA>0.00</AliquotaIVA><Natura>N2.2</Natura>`;
	const summary = o.split === undefined ? "" : `<DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>${o.split.taxable}</ImponibileImporto><Imposta>${o.split.vat}</Imposta><EsigibilitaIVA>S</EsigibilitaIVA></DatiRiepilogo>`;
	return `<FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>${generali}</DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi><DettaglioLinee>${line}</DettaglioLinee>${summary}</DatiBeniServizi>${payment}</FatturaElettronicaBody>`;
}

/** An invoice file; an email in the customer's Contatti (not in the schema, some programs write it), a PEC and the format as given. */
export function fattura(from: Party, to: Party, doc: Doc, t: Transmission | string = {}): string {
	const tr: Transmission = typeof t === "string" ? { pec: t } : t;
	const party = (p: Party) => {
		const vat = p.vat === undefined ? "" : `<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${p.vat}</IdCodice></IdFiscaleIVA>`;
		const fiscal = p.fiscal === undefined ? "" : `<CodiceFiscale>${p.fiscal}</CodiceFiscale>`;
		const contacts = p.email === undefined ? "" : `<Contatti><Email>${xmlText(p.email)}</Email></Contatti>`;
		return `<DatiAnagrafici>${vat}${fiscal}<Anagrafica><Denominazione>${xmlText(p.name)}</Denominazione></Anagrafica></DatiAnagrafici>${contacts}`;
	};
	const format = tr.format ?? "FPR12";
	const trasmissione = `<FormatoTrasmissione>${format}</FormatoTrasmissione><CodiceDestinatario>${tr.code ?? "0000000"}</CodiceDestinatario>${tr.pec === undefined ? "" : `<PECDestinatario>${tr.pec}</PECDestinatario>`}`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="${format}" xmlns:p="${NS}"><FatturaElettronicaHeader><DatiTrasmissione>${trasmissione}</DatiTrasmissione><CedentePrestatore>${party(from)}</CedentePrestatore><CessionarioCommittente>${party(to)}</CessionarioCommittente></FatturaElettronicaHeader>${body(doc)}</p:FatturaElettronica>`;
}

/** Valid IBANs (ISO 13616 mod-97), and one with a wrong check. */
export const IBAN = "IT74X0000000000000000123456";
export const IBAN_2 = "IT21X0000000000000000654321";
export const IBAN_SAVED = "IT05X0000000000100000063001";
export const IBAN_BAD = "IT75X0000000000000000123456";

/** Issued to Gamma: due Wednesday 30/09, 18 days late on Sunday 18/10. */
export const G1 = fattura(BETA, GAMMA, { number: "B-70", date: "2026-09-01", total: "1220.00", rate: [{ amount: "1220.00", due: "2026-09-30", iban: IBAN }] });
/** Issued to Gamma in two: the first due Saturday 10/10, payable Monday 12/10, so 6 days late; the second not due. */
export const G2 = fattura(BETA, GAMMA, { number: "B-71", date: "2026-09-10", total: "500.00", rate: [{ amount: "250.00", due: "2026-10-10", iban: IBAN }, { amount: "250.00", due: "2026-11-10", iban: IBAN }] });
/** Beta's credit note to Gamma. */
export const GNC = fattura(BETA, GAMMA, { number: "NC-3", date: "2026-10-05", total: "100.00", type: "TD04" });
/** Issued to Delta, due Saturday 17/10: not late until Monday 19/10 is gone. Delta has only a PEC of delivery. */
export const D1 = fattura(BETA, DELTA, { number: "B-80", date: "2026-09-17", total: "300.00", rate: [{ amount: "300.00", due: "2026-10-17" }] }, "delta@pec.example");
/** Issued to a private person: no partita IVA, no address. */
export const R1 = fattura(BETA, ROSSI, { number: "B-95", date: "2026-09-01", total: "80.00", rate: [{ amount: "80.00", due: "2026-10-01" }] });
/** Received by Beta, overdue: to pay, never reminded. */
export const RICEVUTA = fattura(ALFA, BETA, { number: "A-1", date: "2026-09-01", total: "400.00", rate: [{ amount: "400.00", due: "2026-09-30" }] });

export const FILES: Record<string, string> = { "f/g1.xml": G1, "f/g2.xml": G2, "f/gnc.xml": GNC, "f/d1.xml": D1, "f/r1.xml": R1, "f/a1.xml": RICEVUTA };

export const NOW = new Date("2026-10-18T08:00:00Z"); // Sunday
export const TUESDAY = new Date("2026-10-20T08:00:00Z");
export const ctx: ToolContext = { step: (_key, work) => work(), progress: () => {}, signal: new AbortController().signal, callId: "sol", thread: { channel: "web", threadId: "t1" } };

/** B-70's key in the register. */
export const B70 = "IT00000520031|b-70|2026-09-01|TD01";

const made: string[] = [];

/** A new directory under the system's temp; cleanTemp removes it. */
export function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "owni-solleciti-"));
	made.push(dir);
	return dir;
}

/** Remove the directories temp made: for afterEach. */
export function cleanTemp(): void {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A fake mail path: what was asked, whether it is available, the cards pending, how many it takes. */
export function fakeMail(unavailable?: string, o: { pending?: ReadonlySet<string>; capacity?: number } = {}) {
	const proposals: ReminderProposal[] = [];
	const mail: ReminderMail = {
		check: async () => unavailable,
		pending: async () => ({ invoices: o.pending ?? new Set(), quotes: new Set() }),
		propose: async (p) => {
			if (proposals.length >= (o.capacity ?? 20)) throw new GoogleActionError("troppe richieste in attesa (20): falle decidere prima");
			proposals.push(p);
			return { id: `req${String(proposals.length).padStart(9, "0")}` };
		},
	};
	return { mail, proposals };
}

/** `company`: saved with partita IVA and name (the default), with the partita IVA only ("vat"), or not saved (false). */
export function setup(files: Record<string, string> = FILES, o: { now?: Date; mail?: ReminderMail; company?: boolean | "vat"; who?: string; readText?: ReadText; pdfBudgetMs?: number } = {}) {
	const dir = temp();
	const root = join(dir, "workspace");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const store = new InvoiceStore(dir);
	if (o.company !== false) store.setCompany({ vat: "IT00000520031", ...(o.company === "vat" ? {} : { name: "Beta Ristorazione Srl" }), by: "test:u", at: NOW.toISOString() });
	const events: InvoiceEvent[] = [];
	const [tool] = createInvoiceTools({
		workspace: new Workspace(root),
		store,
		timeZone: "Europe/Rome",
		whoIs: () => o.who ?? "web:anna",
		record: async (e) => {
			events.push(e);
		},
		read: async (_name, data) => documentFattura(data),
		now: () => o.now ?? NOW,
		...(o.mail === undefined ? {} : { mail: o.mail }),
		...(o.readText === undefined ? {} : { readText: o.readText }),
		...(o.pdfBudgetMs === undefined ? {} : { pdfBudgetMs: o.pdfBudgetMs }),
	});
	if (tool === undefined) throw new Error("no tool");
	return { dir, store, events, tool, run: async (args: Record<string, unknown>, c: ToolContext = ctx) => String(await tool.execute(args, c)) };
}

const FENCE = /<<<dati dalle fatture ([0-9a-f]{12}):[^\n]*>>>\n([\s\S]*?)\n<<<fine dati dalle fatture \1>>>/g;

/** Every fence's body: what the model reads as data. */
export function inside(text: string): string {
	const all = [...text.matchAll(FENCE)].map((m) => m[2] as string);
	if (all.length === 0) throw new Error(`no fence in: ${text}`);
	return all.join("\n");
}

/** What is said outside every fence. */
export function outside(text: string): string {
	return text.replace(FENCE, "");
}
