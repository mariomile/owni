/**
 * The tool `sales_invoices`: le fatture elettroniche in uscita. A draft from an accepted quote,
 * from the hours not yet billed or from the lines the person dictates (sales-invoice-draft.ts); a
 * credit note (TD04) for an invoice issued; the draft issued only after the person's yes
 * (sales-invoice-issue.ts), which gives the number, writes the FatturaPA XML in `fatture/emesse/`
 * and the courtesy PDF beside it; the list of a year with its totals. Nothing is sent to the SdI
 * and nothing is mailed: the person uploads the file, or mails it with the approval flow.
 * Another agente gets only the year's counts and totals; the audit only the op and a count.
 * Another agente's request for an invoice, in its conversation with this one, goes to this
 * agente's approvers (ADR 0108): the draft is made and its issue waits for their yes; the agente
 * that asked hears only the outcome.
 */
import type { OwniTool, ToolContext } from "../engine.ts";
import { todayIn } from "../italian-calendar.ts";
import { CREDIT_NOTE_TYPE, FIELD_LIMITS, RITENUTA_CAUSALI, STALE_DRAFT_DAYS } from "../sales-invoice-rules.ts";
import { nextSeq, type SalesBook } from "../sales-invoice-store.ts";
import { salesTotals } from "../sales-invoice-sums.ts";
import { type Address, type IssuedInvoice, invoiceNumber, isIssued, italianAddress, SALES_LIMITS, type SalesInvoice, SalesInvoiceError, salesAgentReads } from "../sales-invoices.ts";
import { isProblem } from "../text-input.ts";
import { WorkspaceError } from "../workspace.ts";
import { findQuotes, type QuoteCustomer } from "../quotes.ts";
import { findBuyer, quoteIds } from "./sales-invoice-buyer.ts";
import { readBuyerFields } from "./sales-invoice-input.ts";
import { creditNote, DRAFT_CHECKED, draft, lowNumberNote, readLastNumber } from "./sales-invoice-draft.ts";
import { dueOf, filesSay, findIssued, namedDraft, type SalesEnv, type SalesEnvOptions, type SalesStores, salesEnvOf } from "./sales-invoice-env.ts";
import { finish, issue } from "./sales-invoice-issue.ts";
import { agentListAnswer, briefLine, fenced, invoiceLines, listAnswer } from "./sales-invoice-render.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";

export type { SalesEvent } from "./sales-invoice-env.ts";

const SALES_OPS = ["draft", "credit_note", "show", "list", "issue", "finish", "remove", "settings"] as const;
type Op = (typeof SALES_OPS)[number];

/**
 * A draft's data only a person's word sets (they are saved for the next invoices too, or replace a
 * draft), and the IBAN: another agente never says where the money goes (ADR 0108).
 */
const PERSON_ONLY = ["last_number", "bollo_to_client", "ritenuta", "replace", "new_customer", "iban"] as const;

/** The stores, who is who, the audit, and (tests) the clock and the PDF maker: what builds the env (sales-invoice-env.ts salesEnvOf). */
export type SalesToolsOptions = SalesStores & {
	readonly whoIs: SalesEnvOptions["whoIs"];
	readonly record?: SalesEnvOptions["record"];
	readonly now?: SalesEnvOptions["now"];
	readonly make?: SalesEnvOptions["make"];
};

const DESCRIPTION = [
	"Le fatture elettroniche in uscita (FatturaPA), dal preventivo accettato, dalle ore da fatturare, dai DDT (fattura differita, nota di credito dopo un reso) e dagli appuntamenti fatti; emette le bozze di recurring_invoices: Owni prepares the XML file of an invoice or a credit note to a customer; she never transmits it to the SdI and never mails it by herself.",
	"What the person says → op: «fammi la fattura a Rossi per il preventivo 4» → draft with quote; «fattura a Rossi le ore non fatturate» → draft with customer and hours true (period, if said); «fattura a Rossi: consulenza 500 euro» → draft with customer and lines; «fai la fattura differita di ottobre per Rossi», «fattura i DDT di Rossi» → draft with customer, ddt true and period (the month; it bills the vendita DDTs issued and not billed, a conto visione only with kept true: prices from the listino, the others asked goods by goods and given back in prices, never invented by you); «fattura gli appuntamenti fatti da Bianchi questo mese» → draft with customer, appointments true and period (the appointments fatti and not billed, one line per service: prices from the listino, the others asked service by service and given back in prices, never invented by you; after a credit note for the wrong customer of such an invoice, «rifalla a Rossi» → draft with customer the appointments' client, appointments true and bill_to the right customer); when the tool says dictated lines are services of appointments fatti, ask the person and repeat with appointments true, or with the lines and appointments false when the work is apart; «fai una nota di credito per la fattura 12» → credit_note with invoice (lines only for a partial one; wrong_customer true when it was made to the wrong customer; then a fattura differita is redone with draft, ddt true, redo its number and the right customer); «Rossi mi ha reso 2 toner» of goods already billed → credit_note with reso (the DDT di reso), after ddt create of the reso; when the tool says dictated goods already went out with a DDT, ask the person and repeat with shipped ddt or apart; «emettila», «sì, va bene» after a draft → issue with draft and confirm true, only after the person said yes to the draft as shown; an invoice whose issue is not complete → finish with invoice; «le fatture emesse quest'anno» → list (only the invoices issued with Owni); «quanto ho fatturato quest'anno / a Rossi?» → clients (op top, or show for one customer), not this tool; «fammi vedere la fattura 12» → show; «togli la bozza» → remove; «numera le fatture come 2026/1», «l'ultima fattura che ho fatto era la 41», the bollo always on the customer, the ritenuta to companies → settings.",
	"A change to a draft («cambia il prezzo della riga 2 a 900», «sì, il bollo lo paga il cliente») → draft again with the whole request and the change, and replace with the draft's id. With quote, lines or customer replace the quote's (the quote stays linked).",
	"draft: vat (22, 10, 5, 4, or 0 with natura) and natura for every line unless a line has its own; in the forfettario nothing (no VAT, N2.2 and the dicitura by themselves); a spesa anticipata in nome e per conto del cliente → a line with advance true; ritenuta true or false only as the person answers; cassa {kind rivalsa_inps or contributo_integrativo, type TC01…TC21 for a cassa, rate}; bollo_to_client as answered; payment_days, end_of_month, method, iban; the customer's vat_number, cf, address («Via Roma 1, 20121 Milano MI»), recipient_code, pec, country only as the person says them; new_customer true only when the person says it is a customer different from the ones proposed; order {id, cig, cup} for a public office; notes; last_number: the last number the person confirms or says (to «l'ultima è la 41: questa sarà la 42, va bene?», a yes is last_number 41).",
	"An invoice that repeats every month, quarter or year to the same customer is set once with recurring_invoices, which prepares each period's draft; this tool issues it.",
	"A line may name a voce of the listino with item instead of description and price; a voce not in the listino or not clear is asked, never priced by you.",
	"When the tool asks for data, ask the person everything it lists in one message and never fill it in yourself. A fattura differita is issued by the 15th of the month after the DDTs. Repeat numbers and amounts as given, never compute them yourself.",
].join(" ");

export function createSalesInvoiceTools(options: SalesToolsOptions): OwniTool[] {
	const env: SalesEnv = salesEnvOf(options);
	const { store, timeZone, now } = env;
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const line = {
		type: "object",
		properties: {
			item: text(120, "a voce of the listino (price_list): its name as said or LS-0001; description, unit, price and VAT come from it unless the line gives them"),
			description: text(FIELD_LIMITS.descrizione, "as said"),
			quantity: { type: ["number", "string"], description: "default 1" },
			unit: text(FIELD_LIMITS.unitaMisura, "«ore», «pz»"),
			price: { type: ["number", "string"], description: "unit price, VAT excluded" },
			discount: { type: ["number", "string"], description: "percent" },
			vat: { type: ["number", "string"], description: "this line's rate, when it differs" },
			natura: text(5, "this line's nature at 0%"),
			reference: text(FIELD_LIMITS.riferimentoNormativo, "the law of a 0% line, as said"),
			advance: { type: "boolean", description: "a spesa anticipata in nome e per conto del cliente (N1): not a fee" },
		},
		additionalProperties: false,
	};
	return [
		{
			name: "sales_invoices",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...SALES_OPS] },
					customer: text(200, "draft: the customer as said, partita IVA, or card id CL-0001"),
					quote: text(30, "draft: the accepted quote's number"),
					hours: { type: "boolean", description: "draft: bill the customer's hours not yet billed" },
					period: text(40, "draft with hours: «ottobre», «T3», «anno»; default every hour not billed. With ddt: the month of the DDTs («ottobre», «mese scorso»). With appointments: «questo mese», «ottobre»; default every one done up to today"),
					ddt: { type: "boolean", description: "draft: the fattura differita, from the customer's vendita DDTs of a month not billed" },
					appointments: { type: "boolean", description: "draft: true bills the customer's appointments fatti not billed (gli appuntamenti), priced from the listino; false, with lines, when the person says the dictated work is apart from the appointments" },
					bill_to: text(200, "draft with appointments: the right customer to address the invoice to, only for appointments given back by a credit note for the wrong customer (customer stays the one the appointments are booked for)"),
					prices: {
						type: "array",
						maxItems: SALES_LIMITS.lines,
						description: "draft with ddt or appointments: the prices the person said for the goods or services the tool asked about",
						items: { type: "object", properties: { description: text(300, "the goods or the service, as the tool listed them"), unit: text(20, "only when the same goods are listed in two units"), price: { type: ["number", "string"], description: "per unit, VAT excluded" } }, required: ["description", "price"], additionalProperties: false },
					},
					kept: { type: "boolean", description: "draft with ddt: the client keeps the goods in conto visione (true: billed) or returns them (false: left out), as the person says" },
					redo: text(20, "draft with ddt: the number of the fattura differita sent to the wrong customer, redone to customer once its credit note is issued"),
					shipped: { type: "string", enum: ["ddt", "apart"], description: "draft with lines: the goods already went out with the DDT the tool named (ddt: billed as its fattura differita) or are other goods (apart), as the person says" },
					reso: text(30, "credit_note: the DDT di reso («14/2026», or the client's own DDT number) whose goods came back from a DDT already billed"),
					lines: { type: "array", maxItems: SALES_LIMITS.lines, items: line, description: "draft, credit_note: the lines" },
					vat: { type: ["number", "string"], description: "draft: VAT rate of the lines (22, 10, 5, 4, 0)" },
					natura: text(5, "draft: nature of the 0% lines (N2.2, N4, N6.3…)"),
					reference: text(FIELD_LIMITS.riferimentoNormativo, "draft: the law of the 0% lines, as said"),
					ritenuta: { anyOf: [{ type: "boolean" }, { type: "string", enum: [...RITENUTA_CAUSALI] }], description: "draft: true (causale A), the causale, or false; settings: true or false, the ritenuta on invoices to companies; only as the person says" },
					cassa: {
						type: "object",
						properties: { kind: { type: "string", enum: ["rivalsa_inps", "contributo_integrativo"] }, type: text(4, "TC01…TC21, for a cassa"), rate: { type: ["number", "string"] } },
						required: ["kind"],
						additionalProperties: false,
					},
					bollo_to_client: { type: "boolean", description: "draft, settings: the bollo charged to the customer (a line) or paid by the owner" },
					split_payment: { type: "boolean", description: "draft: scissione dei pagamenti, for a public office" },
					payment_days: { type: "integer", minimum: 0, maximum: 365 },
					end_of_month: { type: "boolean" },
					method: text(20, "bonifico (default), contanti, assegno, carta, riba, rid, pagopa"),
					iban: text(40, "default the first IBAN saved with the company"),
					vat_number: text(40, "draft: the customer's partita IVA"),
					cf: text(20, "draft: the customer's codice fiscale"),
					address: text(200, "draft: the customer's address with CAP, comune, provincia"),
					recipient_code: text(7, "draft: codice destinatario (7, or 6 for a public office)"),
					pec: text(FIELD_LIMITS.pec, "draft: the customer's PEC"),
					country: text(2, "draft: a foreign customer's country (DE, FR…)"),
					order: { type: "object", properties: { id: text(FIELD_LIMITS.idDocumento, ""), cig: text(FIELD_LIMITS.cig, ""), cup: text(FIELD_LIMITS.cup, "") }, required: ["id"], additionalProperties: false },
					notes: text(SALES_LIMITS.causale, "draft, credit_note: the causale, as said"),
					replace: text(10, "draft, credit_note: the draft id (BZ-0001) this one takes the place of"),
					invoice: text(20, "credit_note: the number of the invoice it corrects; show, finish: a number"),
					wrong_customer: { type: "boolean", description: "credit_note: the invoice went to the wrong customer" },
					new_customer: { type: "boolean", description: "draft: a customer different from the ones proposed, as the person says" },
					draft: text(10, "issue, show, remove: the draft id (BZ-0001)"),
					confirm: { type: "boolean", description: "issue: true only after the person said yes to the draft as shown" },
					year: { type: "integer", minimum: 2000, maximum: 2100, description: "list: default this year; settings: the year of last_number" },
					compact: { type: "boolean", description: "list: the brief's line only" },
					numbering: { type: "string", enum: ["plain", "year"], description: "settings: «12» or «2026/12»" },
					last_number: { type: "integer", minimum: 0, maximum: SALES_LIMITS.perYear - 1, description: "draft, settings: the number of the last invoice the person issued this year before Owni (0: none)" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!SALES_OPS.includes(args.op as Op)) return "Errore: non conosco questa operazione sulle fatture.";
				const op = args.op as Op;
				// Another agente's request is not the person's word: the year's counts and totals only.
				const agent = isAgentTurn(ctx);
				const day = todayIn(timeZone, now());
				if (agent && op === "draft" && ctx.needsPerson !== undefined) return await forApprovers(args, ctx, day);
				if (agent && !salesAgentReads(args)) {
					return "Errore: a un altro agente non preparo, non emetto e non mostro fatture: posso dare solo quante sono e i totali dell'anno. Il resto lo chiede chi ti scrive, nella sua conversazione.";
				}
				try {
					switch (op) {
						case "draft":
							return await draft(env, args, ctx, day);
						case "credit_note":
							return await creditNote(env, args, ctx, day);
						case "issue":
							return await issue(env, args, ctx, day);
						case "finish":
							return await finish(env, args, ctx, day);
						case "show":
							return show(args, day);
						case "list":
							return list(args, day, agent);
						case "remove":
							return await remove(args, ctx);
						case "settings":
							return await settings(args, ctx, day);
					}
				} catch (error) {
					if (error instanceof SalesInvoiceError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];

	/**
	 * Another agente asks for an invoice (ADR 0108): the draft is made as for a person, and its
	 * issue (the preview, the confirmed call) goes to this agente's approvers through
	 * requirePersonFor. What the draft says stays here: the model, which answers the agente, hears
	 * only that it waits or that it cannot be made. What a person alone says (the numbering, the
	 * bollo, the ritenuta, a draft to replace) is not taken from another agente.
	 */
	async function forApprovers(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const cannot = "Errore: questa fattura non la posso preparare su richiesta di un altro agente: mancano dati o qualcosa va controllato. La prepara una persona che ti segue, nella sua conversazione con te. Rispondi all'agente che te l'ha chiesta solo questo, senza dettagli della fattura.";
		if (PERSON_ONLY.some((k) => args[k] !== undefined)) return cannot;
		try {
			// A draft this call made and took back (an IBAN not the company's): not made again.
			const takenBack = `${ctx.callId}:taken-back`;
			if (env.book().calls.includes(takenBack)) return cannot;
			const flags = customerFlags(args);
			if (flags === undefined) return cannot;
			if (env.book().invoices.find((i) => i.callId === ctx.callId) === undefined) {
				if ((await draft(env, args, ctx, day, { check: true })) !== DRAFT_CHECKED) return cannot;
				await draft(env, args, ctx, day);
			}
			const made = env.book().invoices.find((i) => i.callId === ctx.callId);
			if (made === undefined || isIssued(made)) return cannot;
			// The money goes only to an IBAN saved with the company: never one from the last invoice, nor another agente's.
			const ibans = (env.company.read().company?.ibans ?? []).map(ibanKey);
			if (made.payment?.iban !== undefined && !ibans.includes(ibanKey(made.payment.iban))) {
				store.removeDraft(made.id, takenBack);
				return cannot;
			}
			if (args.method !== undefined || args.payment_days !== undefined || args.end_of_month !== undefined) flags.push("il pagamento (modo e giorni) come detto dall'altro agente");
			const warn = flags.length === 0 ? [] : [`Attenzione: non vengono dai dati salvati, li ha dati l'altro agente: ${flags.join("; ")}. Controllali prima di approvare.`];
			let asked = false;
			const answer = await issue(env, { op: "issue", draft: made.id, confirm: true }, { ...ctx, needsPerson: (what, call) => ((asked = true), ctx.needsPerson?.(what, call === undefined ? undefined : { ...call, preview: [...warn, call.preview].join("\n") })) }, day);
			return asked ? answer : cannot;
		} catch (error) {
			if (error instanceof SalesInvoiceError || error instanceof WorkspaceError) return cannot;
			throw error;
		}
	}

	/**
	 * The customer's data another agente gave, against what is saved (the client's card, the last
	 * invoice to them): one that differs from a saved one is refused (undefined); one with nothing
	 * saved, or a customer not known, is flagged for the approver.
	 */
	function customerFlags(args: Record<string, unknown>): string[] | undefined {
		const fields = readBuyerFields(args);
		if (isProblem(fields)) return undefined;
		const given: [string, string][] = (
			[
				["partita IVA", fields.vat],
				["codice fiscale", fields.cf],
				["indirizzo", fields.address],
				["codice destinatario", fields.code],
				["PEC", fields.pec],
				["paese", fields.country],
			] as const
		).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as [string, string]]));
		if (given.length === 0) return [];
		// The customer named, or the one of the quote named (its own data are saved data too).
		const quoted = typeof args.customer === "string" || args.quote === undefined ? undefined : quoteCustomerOf(String(args.quote));
		const name = typeof args.customer === "string" ? args.customer : quoted?.name;
		if (name === undefined) return undefined;
		const book = env.book();
		const clients = env.clients?.read();
		const ids = quoted === undefined ? { ...(fields.vat === undefined ? {} : { vat: fields.vat }), ...(fields.cf === undefined ? {} : { cf: fields.cf }) } : quoteIds(quoted);
		const found = findBuyer(name, clients === undefined || clients.broken ? [] : clients.cards, book.invoices, ids);
		if (found.kind === "none" && quoted === undefined) return [`un cliente nuovo, con ${given.map(([k, v]) => `${k} «${v}»`).join(", ")}`];
		if (found.kind !== "exact" && found.kind !== "none") return undefined;
		const { card, previous } = found.kind === "exact" ? found.known : {};
		const saved: Record<string, string | Address | undefined> = {
			"partita IVA": card?.vat ?? previous?.vat ?? quoted?.vat,
			"codice fiscale": card?.cf ?? previous?.cf ?? quoted?.fiscal,
			indirizzo: card?.address ?? previous?.address ?? quoted?.address,
			"codice destinatario": previous?.code,
			PEC: previous?.pec ?? card?.contacts.find((c) => c.channel === "pec" && c.email !== undefined)?.email,
			paese: previous?.address.country,
		};
		const flags: string[] = [];
		for (const [k, v] of given) {
			const had = saved[k];
			if (had === undefined) flags.push(`${k} «${v}», che non avevo`);
			else if (!sameValue(k, v, had)) return undefined;
		}
		return flags;
	}

	/** The customer of the quote `number`, when it is one: undefined otherwise (the draft says why). */
	function quoteCustomerOf(number: string): QuoteCustomer | undefined {
		const quotes = env.quotes?.read();
		if (quotes === undefined || quotes.broken) return undefined;
		const found = findQuotes(quotes.quotes, number);
		return found.length === 1 ? found[0]?.customer : undefined;
	}

	function show(args: Record<string, unknown>, day: string): string {
		const book = env.book();
		let inv: SalesInvoice;
		if (typeof args.invoice === "string" && args.draft === undefined) {
			const found = findIssued(book.invoices, args.invoice);
			if (found.length === 0) return "Errore: non trovo una fattura emessa con quel numero.";
			if (found.length > 1 && found[0]?.year !== found[1]?.year) return `Errore: c'è una fattura con quel numero in più anni (${found.map((f) => f.year).join(", ")}): dimmi l'anno.`;
			inv = found[0] as IssuedInvoice;
		} else {
			const named = namedDraft(book.invoices, args.draft, "vedere");
			if ("answer" in named) return named.answer;
			inv = named.found;
		}
		return fenced(invoiceLines(inv, salesTotals(inv), isIssued(inv) ? inv.due : dueOf(inv, day), day).join("\n"));
	}

	function list(args: Record<string, unknown>, day: string, agent: boolean): string {
		const book = env.book();
		const year = typeof args.year === "number" && Number.isInteger(args.year) ? args.year : Number(day.slice(0, 4));
		const issued = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.year === year).map((inv) => ({ inv, t: salesTotals(inv) }));
		const drafts = book.invoices.filter((i) => !isIssued(i));
		if (agent) return agentListAnswer(year, issued, drafts.length);
		if (args.compact === true) {
			const limit = new Date(now().getTime() - STALE_DRAFT_DAYS * 86_400_000).toISOString();
			const unfinished = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.finished !== true).map((i) => i.number);
			return briefLine(drafts.filter((d) => d.at < limit).length, STALE_DRAFT_DAYS, unfinished);
		}
		return listAnswer(year, issued, drafts.map((inv) => ({ inv, t: salesTotals(inv) })));
	}

	async function remove(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
		const book = env.book();
		// A call run again after it removed: the draft is gone.
		if (book.calls.includes(ctx.callId)) {
			await env.audit(ctx, "remove", 1);
			return "Fatto, la bozza è tolta: nessun numero è stato usato.";
		}
		const named = namedDraft(book.invoices, args.draft, "togliere");
		if ("answer" in named) return named.answer;
		const target = named.found;
		if (isIssued(target)) return `Errore: la ${target.type === CREDIT_NOTE_TYPE ? "nota di credito" : "fattura"} n. ${target.number} è già emessa e non si può togliere: per annullarla si fa una nota di credito.`;
		// Removed only when the person asks, in their own message (ADR 0088).
		const notPerson = requirePersonFor(ctx, `tolgo la bozza ${target.id}`);
		if (notPerson !== undefined) return notPerson;
		// Under the lock: a draft issued meanwhile by another call is never removed.
		store.removeDraft(target.id, ctx.callId);
		await env.audit(ctx, "remove", 1);
		return `Fatto, ho tolto la bozza ${target.id}: nessun numero è stato usato.`;
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, day: string): Promise<string> {
		const book = env.book();
		const thisYear = Number(day.slice(0, 4));
		if (args.numbering !== undefined && args.numbering !== "plain" && args.numbering !== "year") return "Errore: il numero si scrive come «12» o come «2026/12».";
		if (args.bollo_to_client !== undefined && typeof args.bollo_to_client !== "boolean") return "Errore: il bollo è a carico del cliente o no.";
		if (args.ritenuta !== undefined && typeof args.ritenuta !== "boolean") return "Errore: la ritenuta alle aziende è sì o no.";
		const year = typeof args.year === "number" && Number.isInteger(args.year) ? args.year : thisYear;
		const last = readLastNumber(args.last_number);
		if (typeof last === "string") return last;
		const issuedIn = (y: number) => book.invoices.some((i) => isIssued(i) && i.year === y);
		if (args.numbering === undefined && args.bollo_to_client === undefined && args.ritenuta === undefined && last === undefined) return shown(book, thisYear);
		// How the invoices are numbered, and from which number: the person's own word (ADR 0088).
		if (args.numbering !== undefined || last !== undefined) {
			const notPerson = requirePersonFor(ctx, "cambio la numerazione delle fatture");
			if (notPerson !== undefined) return notPerson;
		}
		const changesNumbering = args.numbering !== undefined && args.numbering !== (book.settings?.numbering ?? "plain");
		if (changesNumbering && issuedIn(thisYear)) return `Nel ${thisYear} ho già emesso fatture con questa numerazione: si può scegliere da gennaio, prima della prima fattura del ${thisYear + 1}. Non ho cambiato niente.`;
		if (last !== undefined && issuedIn(year)) return `Nel ${year} ho già emesso fatture, quindi la numerazione va avanti da quelle: l'ultimo numero prima di me si può correggere solo prima della prima fattura dell'anno. Non ho cambiato niente.`;
		const before = book.settings?.lastBefore?.[String(year)];
		store.update(ctx.callId, (state) => {
			if (last !== undefined && state.invoices.some((i) => isIssued(i) && i.year === year)) throw new SalesInvoiceError(`nel ${year} intanto è stata emessa una fattura: l'ultimo numero prima di me non si cambia più`);
			return {
				...state,
				settings: {
					...(state.settings ?? {}),
					...env.marker(ctx),
					...(args.numbering === undefined ? {} : { numbering: args.numbering as "plain" | "year" }),
					...(args.bollo_to_client === undefined ? {} : { bolloToClient: args.bollo_to_client as boolean }),
					...(args.ritenuta === undefined ? {} : { ritenutaToBusiness: args.ritenuta as boolean }),
					...(last === undefined ? {} : { lastBefore: { ...(state.settings?.lastBefore ?? {}), [String(year)]: last } }),
				},
			};
		});
		await env.audit(ctx, "settings", 1);
		const out = [before !== undefined && last !== undefined && before !== last ? `Corretto: l'ultima prima di me era la ${last}, parto dalla ${last + 1}.` : "Fatto, ho salvato.", shown(env.book(), thisYear)];
		if (last !== undefined) {
			const vat = env.company.read().company?.vat;
			const low = vat === undefined ? undefined : lowNumberNote(last, await filesSay(env, ctx.signal, vat, year, day), year);
			if (low !== undefined) out.push(low);
		}
		return out.join("\n");
	}
}

/** The person's choices and where the numbering stands this year. */
function shown(book: SalesBook, year: number): string {
	const s = book.settings;
	const numbering = s?.numbering ?? "plain";
	const out = [numbering === "year" ? `Le fatture sono numerate ${invoiceNumber(year, 1, "year")}, ${invoiceNumber(year, 2, "year")}… (oppure 1, 2, 3 se preferisci).` : `Le fatture sono numerate 1, 2, 3… (oppure ${invoiceNumber(year, 1, "year")} se preferisci).`];
	const lastIssued = book.invoices.filter((i): i is IssuedInvoice => isIssued(i) && i.year === year).sort((a, b) => b.seq - a.seq)[0];
	const before = s?.lastBefore?.[String(year)];
	const next = invoiceNumber(year, nextSeq(book, year), numbering);
	if (lastIssued !== undefined) out.push(`L'ultima fattura del ${year} è la n. ${lastIssued.number}: la prossima sarà la ${next}.`);
	else if (before !== undefined) out.push(before === 0 ? `Nel ${year} non avevi fatture prima di me: parto dalla ${next}.` : `Nel ${year} l'ultima fattura prima di me era la ${before}: parto dalla ${next}.`);
	out.push(`Bollo virtuale: ${s?.bolloToClient === undefined ? "lo chiedo la prima volta che serve" : s.bolloToClient ? "lo paga il cliente, come riga in fattura" : "lo paghi tu, solo dichiarato"}.`);
	out.push(`Ritenuta d'acconto alle aziende: ${s?.ritenutaToBusiness === undefined ? "da chiedere" : s.ritenutaToBusiness ? "sì" : "no"}.`);
	return out.join("\n");
}

const ibanKey = (iban: string) => iban.replace(/\s+/g, "").toUpperCase();

/** A customer's datum given, the same as the one saved: tax ids without «IT», letters in any case, an address as its parts. */
function sameValue(kind: string, given: string, saved: string | Address): boolean {
	const flat = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	if (kind === "partita IVA") return flat(given.replace(/^IT/i, "")) === flat(String(saved).replace(/^IT/i, ""));
	if (kind !== "indirizzo") return flat(given) === flat(String(saved));
	const parts = (a: Address | undefined) => (a === undefined ? undefined : flat([a.street, a.cap, a.town, a.province ?? "", a.country].join(" ")));
	const mine = parts(italianAddress(given)) ?? flat(given);
	const theirs = typeof saved === "string" ? (parts(italianAddress(saved)) ?? flat(saved)) : parts(saved);
	return mine === theirs;
}
