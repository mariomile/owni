/**
 * The tool `ddt`: i DDT in uscita. A draft for a client (the lines of the listino or free text,
 * how many, no prices); issued only after the person's yes, when it takes its number of the year
 * (with the day said: today, tomorrow) and moves the magazzino (ddt-stock.ts); a reso finds the DDT
 * it comes back from, or is recorded with the client's own DDT; annulled after a yes on what it
 * was, with the goods put back when they never left; its PDF or Word in `ddt/`, never sent; the
 * list, what is still to bill, the CSV, the numbering (ddt-list.ts). The fattura differita that
 * bills them is sales_invoices' (sales-ddt-source.ts). A draft's id never reaches the person: it
 * stays in the fence, for the model. Another agente gets counts only; the audit only the op and a count.
 */
import { createHash } from "node:crypto";
import type { ClientStore } from "../client-store.ts";
import { type Ddt, DDT_LIMITS, DDT_OPS, DdtError, ddtId, type DdtLine, type DdtOp, type IssuedDdt, isIssuedDdt, isRecordedReso, TRANSPORT_WORDS, UNLOADING } from "../ddt.ts";
import { DDT_BROKEN, type DdtStore, nextDdtSeq } from "../ddt-store.ts";
import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import type { InvoiceStore } from "../invoice-store.ts";
import type { Company } from "../invoices.ts";
import { addDays, todayIn } from "../italian-calendar.ts";
import { italianLongDate } from "../italian-format.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import type { PriceListStore } from "../price-list-store.ts";
import type { SalesInvoiceStore } from "../sales-invoice-store.ts";
import { StockError } from "../stock.ts";
import type { StockLink } from "../stock-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { causaleSaid, type ClientSaid, clientSaid, ddtNamed, issueDaySaid, issueDayWords, type LineSaid, linesSaid, ofClient, packagesSaid, resoSourceOf, theirSaid, transportSaid, weightSaid } from "./ddt-input.ts";
import { agentCounts, briefData, list, type Loaded, status, target } from "./ddt-list.ts";
import { briefAnswer, ddtBlock, ddtCsv, ddtMarkdown, ddtTitle, fencedDdt, lineQty } from "./ddt-render.ts";
import { completeStock, stockPreview, unloaded, unstock } from "./ddt-stock.ts";
import { fileSlug } from "./quote-input.ts";
import { clientKey, ddtInvoicesOf, ddtWords, returnsOf } from "./sales-ddt.ts";

/** What was done, for the audit: the op and how many, never clients, lines or numbers. */
export type DdtEvent = { readonly type: "ddt.used"; readonly op: DdtOp | "brief"; readonly count: number };

export type DdtToolsOptions = {
	readonly workspace: Workspace;
	readonly store: DdtStore;
	/** The fatture in uscita, read only: the customers invoiced, and which DDTs a draft holds or an invoice billed. */
	readonly sales?: Pick<SalesInvoiceStore, "read">;
	readonly clients?: Pick<ClientStore, "read">;
	readonly priceList?: Pick<PriceListStore, "read">;
	/** Il magazzino: a DDT issued unloads (or a reso puts back), once per DDT and line. */
	readonly stock?: StockLink;
	/** The company, for the document's letterhead. */
	readonly company?: Pick<InvoiceStore, "read">;
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: DdtEvent) => Promise<void>;
	/** Tests: the clock and the document maker (default: the document worker). */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

const DESCRIPTION = [
	"I DDT in uscita (documenti di trasporto), emesso scarica il magazzino da solo (un reso già fatturato è sales_invoices credit_note, la fattura differita sales_invoices con ddt): the goods the person ships to a client, with no prices. Owni never sends a DDT: the person prints it or sends it.",
	"What the person says → op: «fammi il DDT per Rossi: 10 risme e 2 toner» → create with client and lines [{item (a voce of the listino as said) or description (free text), quantity, unit}]; causale vendita unless said (conto visione, reso, riparazione, omaggio, comodato, lavorazione); transport mittente (the person), destinatario (the client) or vettore with carrier; destination when not the client's address; aspect, packages, weight when said. When Owni is not sure of the client, of a voce or of the DDT a reso comes from, create first shows the draft with a check: show it, and only after the person's yes repeat with confirm true and that check.",
	"«Rossi mi ha reso 2 toner»: if that goods is not billed yet, create with causale reso (of: the DDT it comes back from, else Owni finds the latest with that goods); when the client brought their own DDT, their_number and their_date (recorded, no number of ours); if it is billed already, after the reso sales_invoices credit_note with reso. «lo porta il corriere BRT» → change with transport vettore and carrier.",
	"«aggiungi 2 toner al DDT» → change (ddt or client; lines quantity 0 takes one off) while it is a draft; «emettilo», «sì» after the draft → issue with confirm true, only after the person said yes to what issue showed (it takes the number and unloads the magazzino: those goods are not unloaded again by hand); «con la data di domani» → issue with date; «annulla il DDT 12» → cancel: it shows the DDT first with a check; with the person's yes repeat with confirm true, the check and left (whether the goods left anyway: false puts them back in the magazzino; the number stays used); «stampa il DDT», «fammi il PDF del DDT 12» → document (format pdf or docx), then offer file_send; «quali DDT non ho ancora fatturato?» → list with unbilled true (client, month when said); «a che punto è il DDT 12?» → status; «fammi il file dei DDT» → export, then file_send; «numera i DDT come 12», «l'ultimo DDT che ho fatto era il 40» → settings (numbering, last_number).",
	"«fai la fattura differita di ottobre per Rossi» is sales_invoices (draft with ddt true and the month), not this tool. summary of the brief: list with compact true. Never say a draft's reference (DT-…) to the person: name a draft by its client and day. Repeat quantities as given, never compute them yourself.",
].join(" ");

const AGENT_REFUSAL = "I DDT dicono clienti, merce e indirizzi: a un altro agente do solo quanti sono. Li prepara e li emette chi ti scrive, nella sua conversazione.";

/** A draft as proposed: its client, lines and fields, with the check the person's yes is given on; `source`: the DDT a reso was tied to by Owni. */
type Proposed = { readonly said: ClientSaid; readonly lines: readonly LineSaid[]; readonly fields: Omit<Ddt, "id" | "status" | "day" | "client" | "lines" | "callId" | "by" | "at">; readonly source?: IssuedDdt };

type Answer = { text: string; count: number };

const OMAGGIO_NOTE = "È un omaggio: niente fattura al cliente, ma per l'IVA di solito serve un'autofattura. Chiedi al commercialista come la vuole.";
const PRINT_NOTE = "Il DDT deve viaggiare con la merce: vuoi il PDF da stampare (due copie, una resta a te firmata)? Non lo mando a nessuno da sola.";

export function createDdtTools(options: DdtToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const make = options.make ?? ((input: MakeInput) => makeDocumentFile(input));
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: DdtEvent["op"], count: number) => {
		await ctx.step(`audit-${op}`, async () => {
			await options.record?.({ type: "ddt.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });

	function load(): Loaded | string {
		const book = store.read();
		if (book.broken) return `Errore: ${DDT_BROKEN}.`;
		const sales = options.sales?.read();
		const invoices = sales === undefined || sales.broken ? [] : sales.invoices;
		const list_ = options.priceList?.read();
		return { book, invoices, links: ddtInvoicesOf(invoices), returns: returnsOf(book.ddts), voci: list_ === undefined || list_.broken ? [] : list_.items };
	}

	const cards = () => {
		const b = options.clients?.read();
		return b === undefined || b.broken ? [] : b.cards;
	};

	/** The DDT a reso comes back from, as it must still be: ours, issued, unloading, the same client. The answer otherwise. */
	function sourceProblem(loaded: Loaded, of: string, client: Ddt["client"]): string | undefined {
		const from = loaded.book.ddts.find((d) => d.id === of);
		if (from === undefined || !isIssuedDdt(from) || from.status !== "issued" || !UNLOADING.includes(from.causale)) return "Errore: il reso torna da un DDT emesso che ha scaricato la merce (vendita, omaggio o conto visione), non annullato: quel DDT non lo è.";
		if (clientKey(from.client) !== clientKey(client)) return [`Il DDT n. ${from.number} è di un altro cliente: il reso torna da un DDT dello stesso cliente.`, fencedDdt(from.client.name)].join("\n");
		return undefined;
	}

	/** The fields said besides the client and the lines (create: from nothing; change: over the draft's). */
	function fieldsSaid(args: Record<string, unknown>, loaded: Loaded, client: Ddt["client"], day: string, was?: Ddt): Proposed["fields"] | string {
		const causale = causaleSaid(args.causale);
		if (typeof causale === "object") return causale.answer;
		const transport = transportSaid(args.transport, args.carrier, was?.transport);
		if (typeof transport === "string") return transport;
		const destination = cleanText(args.destination, DDT_LIMITS.destination, "la destinazione");
		if (isProblem(destination)) return `Errore: ${destination.problem}.`;
		const aspect = cleanText(args.aspect, DDT_LIMITS.aspect, "l'aspetto dei beni");
		if (isProblem(aspect)) return `Errore: ${aspect.problem}.`;
		const notes = cleanText(args.notes, DDT_LIMITS.notes, "le note", true);
		if (isProblem(notes)) return `Errore: ${notes.problem}.`;
		const packages = packagesSaid(args.packages);
		if (typeof packages === "string") return packages;
		const weight = weightSaid(args.weight);
		if (typeof weight === "object") return weight.answer;
		const theirs = theirSaid(args.their_number, args.their_date, day);
		if (theirs !== undefined && "answer" in theirs) return theirs.answer;
		const c = causale ?? was?.causale ?? "vendita";
		let of = was?.of;
		if (args.of !== undefined) {
			if (c !== "reso") return "Errore: il DDT da cui torna la merce si dice solo per un reso.";
			const from = ddtNamed(args.of, loaded.book.ddts);
			if (typeof from === "string" || from === undefined) return from ?? "Errore: dimmi da quale DDT torna la merce.";
			const problem = sourceProblem(loaded, from.id, client);
			if (problem !== undefined) return problem;
			of = from.id;
		}
		if (theirs !== undefined && c !== "reso") return "Errore: il DDT del cliente si registra solo per un reso.";
		const their = theirs ?? (c === "reso" ? was?.theirs : undefined);
		if (c !== "reso") of = undefined;
		return {
			causale: c,
			...(transport === undefined ? {} : { transport }),
			...((destination ?? was?.destination) === undefined ? {} : { destination: (destination ?? was?.destination) as string }),
			...((aspect ?? was?.aspect) === undefined ? {} : { aspect: (aspect ?? was?.aspect) as string }),
			...((notes ?? was?.notes) === undefined ? {} : { notes: (notes ?? was?.notes) as string }),
			...((packages ?? was?.packages) === undefined ? {} : { packages: (packages ?? was?.packages) as number }),
			...((weight ?? was?.weight) === undefined ? {} : { weight: (weight ?? was?.weight) as string }),
			...(of === undefined ? {} : { of }),
			...(their === undefined ? {} : { theirs: their }),
		};
	}

	const numbered = (lines: readonly LineSaid[]): DdtLine[] => lines.map(({ guess: _, free: _f, ...l }, i) => ({ ...l, n: i + 1 }));

	const checkOf = (p: Proposed) => createHash("sha256").update(JSON.stringify([p.said.client, p.lines.map((l) => [l.description, l.qty, l.unit ?? "", l.item ?? ""]), p.fields])).digest("hex").slice(0, 16);

	/** What to say the draft lacks before it can be issued (who carries it: the client's last choice proposed), and what a reso without its DDT does not do. */
	function missingNotes(d: Pick<Ddt, "transport" | "causale" | "of" | "theirs" | "client">, loaded: Loaded): string[] {
		const out: string[] = [];
		if (d.theirs === undefined && d.transport === undefined) {
			const last = ofClient(loaded.book.ddts, d.client).find((x) => x.status === "issued" && x.transport !== undefined)?.transport;
			if (last === undefined) out.push("Prima di emetterlo mi serve chi fa il trasporto: tu, il cliente o un corriere (con il suo nome). Chiedilo a chi ti scrive.");
			else out.push([`Prima di emetterlo mi serve chi fa il trasporto. Come l'ultima volta, ${TRANSPORT_WORDS[last.by]}${last.carrier === undefined ? "" : " (nel riquadro)"}? Chiedilo a chi ti scrive.`, ...(last.carrier === undefined ? [] : [fencedDdt(last.carrier)])].join("\n"));
		} else if (d.transport?.by === "vettore" && d.transport.carrier === undefined) out.push("Prima di emetterlo mi serve il nome del corriere che fa il trasporto. Chiedilo a chi ti scrive.");
		if (d.causale === "reso" && d.of === undefined) out.push("È un reso: se mi dici da quale DDT torna la merce, quando lo emetti la rimetto in magazzino; senza, non la rimetto.");
		return out;
	}

	const freeNote = (lines: readonly LineSaid[]): string[] => {
		const free = lines.filter((l) => l.free === true).length;
		return free === 0 ? [] : [`${n1(free, "Una voce non è nel listino: l'ho scritta", "# voci non sono nel listino: le ho scritte")} come descrizione libera, come nel riquadro (senza voce non si scarica dal magazzino).`];
	};

	function proposalText(p: Proposed, loaded: Loaded, first = ""): string {
		const preview: Ddt = { id: "DT-0000", status: "draft", day: "2000-01-01", client: p.said.client, lines: numbered(p.lines), callId: "x", by: "x", at: "x", ...p.fields };
		const why: string[] = [];
		if (p.said.fresh === true) why.push("il cliente non è tra le schede né tra i clienti fatturati: lo scrivo come detto");
		if (p.said.form === true) why.push("il cliente ha lo stesso nome a meno della forma societaria");
		const guessed = p.lines.filter((l) => l.guess === true).length;
		if (guessed > 0) why.push(n1(guessed, "una voce del listino l'ho presa dal nome più vicino a come è stata detta", "# voci del listino le ho prese dal nome più vicino a come sono state dette"));
		if (p.source !== undefined) why.push(`il reso l'ho legato all'ultimo DDT di questo cliente con questa merce, il ${ddtWords({ number: p.source.number, date: p.source.day })}`);
		const block = ddtBlock(preview, undefined, loaded.book.ddts).split("\n").slice(1).join("\n");
		return [
			`${first}Preparerei questa bozza di DDT, come nel riquadro. Controlla con chi ti scrive: ${why.join("; ")}.`,
			fencedDdt(`Bozza del DDT\n${block}`),
			...freeNote(p.lines),
			...missingNotes(preview, loaded),
			`Va bene così? Se chi ti scrive dice di sì, ripeti con la conferma e il controllo ${checkOf(p)}. Il numero il DDT lo prende quando lo emetti.`,
		].join("\n");
	}

	async function create(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<Answer> {
		const said = clientSaid(args.client, cards(), loaded.invoices, loaded.book.ddts);
		if (typeof said === "string") return { text: said, count: 0 };
		const lines = linesSaid(args.lines, loaded.voci);
		if (typeof lines === "string") return { text: lines, count: 0 };
		let fields = fieldsSaid(args, loaded, said.client, day);
		if (typeof fields === "string") return { text: fields, count: 0 };
		// A reso with no DDT said: the latest of the client's with those goods, proposed.
		let source: IssuedDdt | undefined;
		if (fields.causale === "reso" && fields.of === undefined) {
			source = resoSourceOf(loaded.book.ddts, said.client, lines);
			if (source !== undefined) fields = { ...fields, of: source.id };
		}
		const p: Proposed = { said, lines, fields, ...(source === undefined ? {} : { source }) };
		// The client and the lines dictated, each found by its very name: the draft is made at once (a draft moves nothing).
		const dictated = said.form !== true && said.fresh !== true && lines.every((l) => l.guess !== true) && source === undefined;
		if (!dictated && args.confirm !== true) return { text: proposalText(p, loaded), count: 0 };
		const refused = requirePersonFor(ctx, "preparo il DDT");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (!dictated) {
			const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
			if (check === undefined || !/^[0-9a-f]{16}$/.test(check)) return { text: "Errore: per preparare il DDT serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
			if (checkOf(p) !== check) return { text: proposalText(p, loaded, "La proposta è cambiata da quando l'hai mostrata: non ho preparato niente. Ecco quella nuova.\n"), count: 0 };
		}
		const by = marker(ctx);
		const made_ = fields;
		const id = await ctx.step("create", async () => {
			store.update(ctx.callId, (state) => {
				if (state.ddts.length >= DDT_LIMITS.ddts) throw new DdtError("i DDT sono troppi per salvarne altri");
				const made: Ddt = { id: ddtId(state.nextDdt), status: "draft", day, client: said.client, lines: numbered(lines), callId: ctx.callId, ...made_, ...by };
				return { ...state, nextDdt: state.nextDdt + 1, ddts: [...state.ddts, made] };
			});
			return store.read().ddts.find((d) => d.callId === ctx.callId)?.id ?? "";
		});
		const made = store.read().ddts.find((d) => d.id === id);
		if (made === undefined) return { text: "Errore: la bozza del DDT non risulta salvata.", count: 0 };
		const head =
			made.theirs !== undefined
				? "Fatto: ho preparato il reso con il DDT del cliente, come nel riquadro. Non prende un nostro numero: quando chi ti scrive dice di registrarlo, rimetto la merce in magazzino."
				: `Fatto: ho preparato la bozza del DDT, come nel riquadro${args.causale === undefined ? ", con causale vendita" : ""}. Non ha ancora un numero: lo prende quando lo emetti, e allora ${made.causale === "reso" ? "rimetto la merce in magazzino" : "scarico il magazzino"}.`;
		const tail = made.theirs !== undefined ? [] : ["Quando chi ti scrive dice di emetterlo, ti mostro cosa muove nel magazzino e lo emetto dopo il suo sì."];
		return { text: [head, fencedDdt(ddtBlock(made, loaded.links, loaded.book.ddts)), ...freeNote(lines), ...missingNotes(made, loaded), ...tail].join("\n"), count: 1 };
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<Answer> {
		const d = target(args, loaded, (x) => x.status === "draft", "in bozza");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status !== "draft") return { text: `Il ${ddtTitle(d)} è ${d.status === "cancelled" ? "annullato" : "già emesso"}: si cambia solo una bozza. Per altra merce, ne preparo uno nuovo.`, count: 0 };
		const said = args.lines === undefined ? [] : linesSaid(args.lines, loaded.voci, true);
		if (typeof said === "string") return { text: said, count: 0 };
		const fields = fieldsSaid(args, loaded, d.client, day, d);
		if (typeof fields === "string") return { text: fields, count: 0 };
		const refused = requirePersonFor(ctx, `cambio la ${ddtTitle(d)}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		let lines: DdtLine[] = [...d.lines];
		const same = (a: Pick<DdtLine, "item" | "description">, b: Pick<DdtLine, "item" | "description">) => (a.item !== undefined && a.item === b.item) || (a.item === undefined && b.item === undefined && a.description.toLowerCase() === b.description.toLowerCase());
		for (const l of said) {
			const at = lines.findIndex((x) => same(x, l));
			if (l.qty === "0") {
				if (at >= 0) lines.splice(at, 1);
				continue;
			}
			const { guess: _, free: _f, ...rest } = l;
			if (at >= 0) lines[at] = { ...rest, n: (lines[at] as DdtLine).n };
			else lines.push({ ...rest, n: 0 });
		}
		if (lines.length === 0) return { text: "Così la bozza resterebbe senza righe: se non serve più, chi ti scrive può dirmi di annullarla.", count: 0 };
		lines = lines.map((l, i) => ({ ...l, n: i + 1 }));
		const by = marker(ctx);
		await ctx.step("change", async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.ddts.find((x) => x.id === d.id);
				if (cur === undefined || cur.status !== "draft") throw new DdtError("la bozza del DDT intanto non è più una bozza: non l'ho cambiata");
				const { transport: _t, destination: _d, aspect: _a, notes: _n, packages: _p, weight: _w, of: _o, theirs: _th, ...base } = cur;
				const next: Ddt = { ...base, ...fields, lines, edited: by };
				return { ...state, ddts: state.ddts.map((x) => (x.id === d.id ? next : x)) };
			});
			return true;
		});
		const after = store.read().ddts.find((x) => x.id === d.id) as Ddt;
		return { text: ["Fatto: ho cambiato la bozza del DDT, ora è così.", fencedDdt(ddtBlock(after, loaded.links, loaded.book.ddts)), ...freeNote(said), ...missingNotes(after, loaded)].join("\n"), count: 1 };
	}

	async function issue(args: Record<string, unknown>, ctx: ToolContext, given: Loaded, day: string): Promise<Answer> {
		let loaded = given;
		// A call run again after it issued: the same DDT, completed.
		const mine = loaded.book.ddts.find((d) => d.issueCall === ctx.callId && d.status !== "draft");
		if (mine !== undefined) return issuedAnswer(mine, ctx, loaded);
		const d = target(args, loaded, (x) => x.status === "draft" || (x.status === "issued" && x.stocked !== true), "da emettere");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status === "cancelled") return { text: `${capital(ddtTitle(d))}: è annullato, non si emette.`, count: 0 };
		if (d.status === "issued") {
			if (d.stocked === true) return { text: `Il ${ddtTitle(d)} è già ${isIssuedDdt(d) ? "emesso" : "registrato"}.`, count: 0 };
			const refused = requirePersonFor(ctx, isIssuedDdt(d) ? `completo l'emissione del DDT n. ${d.number}` : "completo la registrazione del reso");
			if (refused !== undefined) return { text: refused, count: 0 };
			return issuedAnswer(d, ctx, loaded);
		}
		const missing = missingNotes(d, loaded).filter((m) => !m.startsWith("È un reso"));
		if (missing.length > 0) return { text: missing.join("\n"), count: 0 };
		if (args.confirm !== undefined && typeof args.confirm !== "boolean") return { text: "Errore: la conferma è sì o no.", count: 0 };
		// A reso's DDT as it must still be: issued, not annulled, the same client.
		if (d.of !== undefined) {
			const problem = sourceProblem(loaded, d.of, d.client);
			if (problem !== undefined) return { text: `${problem} Cambia la bozza del reso prima di emetterlo.`, count: 0 };
		}
		if (d.theirs !== undefined) return recordReso(d, args, ctx, loaded);
		const when = issueDaySaid(args.date, day);
		if (typeof when === "object") return { text: when.answer, count: 0 };
		const year = Number(when.slice(0, 4));
		// The numbering follows the dates: an annulled DDT keeps its date on record, but no longer blocks.
		const later = loaded.book.ddts.find((x) => isIssuedDdt(x) && x.status === "issued" && x.year === year && x.day > when);
		if (later !== undefined && isIssuedDdt(later)) return { text: `C'è già il DDT n. ${later.number} del ${italianLongDate(later.day)}: la numerazione segue le date, quindi questo DDT non può avere una data prima di quella.`, count: 0 };
		// A date after tomorrow only when no other draft waits: it would keep them from today's date.
		const ahead = when > day;
		const waiting = loaded.book.ddts.filter((x) => x.status === "draft" && x.id !== d.id).length;
		if (when > addDays(day, 1) && waiting > 0) return { text: `Con una data dopo domani, fino al ${italianLongDate(when)} non potresti emettere ${n1(waiting, "l'altra bozza di DDT", "le altre # bozze di DDT")} con la data di oggi. Emetti prima ${waiting === 1 ? "quella" : "quelle"}, oppure usa al più la data di domani.`, count: 0 };
		// The first DDT of the year with Owni: the last number the person reached before, asked as the invoices ask it; written only with the yes.
		const last = args.last_number;
		if (last !== undefined && (typeof last !== "number" || !Number.isInteger(last) || last < 0 || last >= DDT_LIMITS.perYear)) return { text: "Errore: il numero dell'ultimo DDT è un numero intero, 0 se non ce n'è nessuno.", count: 0 };
		const issuedIn = (y: number) => loaded.book.ddts.some((x) => isIssuedDdt(x) && x.year === y);
		const allLastYear = when.slice(5, 7) === "01" && issuedIn(year - 1) && (loaded.book.settings?.lastBefore?.[String(year - 1)] ?? 0) === 0;
		if (last === undefined && !issuedIn(year) && loaded.book.settings?.lastBefore?.[String(year)] === undefined && !allLastYear) return { text: `È il primo DDT che emetti con me nel ${year}: qual è il numero dell'ultimo DDT che hai fatto quest'anno? Se nessuno, parto da 1. Chiedilo a chi ti scrive, poi rifai con la sua risposta (prima di emettere ti mostro il DDT).`, count: 0 };
		if (last !== undefined && issuedIn(year)) return { text: `Nel ${year} ho già emesso DDT, quindi la numerazione va avanti da quelli.`, count: 0 };
		const settings = last === undefined ? loaded.book.settings : { by: "x", at: "x", ...(loaded.book.settings ?? {}), lastBefore: { ...(loaded.book.settings?.lastBefore ?? {}), [String(year)]: last as number } };
		const next = nextDdtSeq({ next: loaded.book.next, ...(settings === undefined ? {} : { settings }) }, year);
		const numberNow = loaded.book.settings?.numbering === "plain" ? String(next) : `${next}/${year}`;
		if (args.confirm !== true) {
			return {
				text: [
					`Lo emetto ${issueDayWords(when, day)}: prende il numero ${numberNow}. Una volta emesso non si cancella più, si può solo annullare (e il numero resta).`,
					fencedDdt(ddtBlock(d, loaded.links, loaded.book.ddts)),
					...stockPreview(options.stock, d, when, marker(ctx)),
					...(ahead ? [`Dopo questo, fino al ${italianLongDate(when).replace(/ \d{4}$/, "")} non potrai emettere DDT con una data precedente.`] : []),
					...missingNotes(d, loaded),
					`Ripeti a chi ti scrive i dati del riquadro e chiedi conferma: lo emetto solo dopo il suo sì${last === undefined ? "" : ", ripetendo anche l'ultimo numero che ha detto"}${args.date === undefined ? "" : " e la stessa data"}.`,
				].join("\n"),
				count: 0,
			};
		}
		// The yes is a person's own message, never a notice, a schedule or another agente (ADR 0088).
		const refused = requirePersonFor(ctx, "emetto il DDT");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (last !== undefined) {
			const by = marker(ctx);
			await ctx.step("first", async () => {
				store.update(`${ctx.callId}:first`, (state) => {
					if (state.ddts.some((x) => isIssuedDdt(x) && x.year === year)) return state;
					return { ...state, settings: { ...(state.settings ?? {}), ...by, lastBefore: { ...(state.settings?.lastBefore ?? {}), [String(year)]: last as number } } };
				});
				return true;
			});
			loaded = { ...loaded, book: store.read() };
		}
		const id = await ctx.step("issue", async () => store.issue(d.id, ctx.callId, when, marker(ctx)).id);
		const issued = store.read().ddts.find((x): x is IssuedDdt => x.id === id && isIssuedDdt(x));
		if (issued === undefined) return { text: "Errore: il DDT non risulta emesso.", count: 0 };
		return issuedAnswer(issued, ctx, loaded);
	}

	/** A reso with the client's own DDT: recorded after the yes, no number of ours. */
	async function recordReso(d: Ddt, args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded): Promise<Answer> {
		const their = d.theirs as NonNullable<Ddt["theirs"]>;
		if (args.confirm !== true) {
			return {
				text: [`Registro questo reso con il DDT del cliente n. ${their.number} del ${italianLongDate(their.date)} (nel riquadro): non prende un nostro numero.`, fencedDdt(ddtBlock(d, loaded.links, loaded.book.ddts)), ...stockPreview(options.stock, d, their.date, marker(ctx)), ...missingNotes(d, loaded), "Ripeti a chi ti scrive i dati del riquadro e chiedi conferma: lo registro solo dopo il suo sì."].join("\n"),
				count: 0,
			};
		}
		const refused = requirePersonFor(ctx, "registro il reso");
		if (refused !== undefined) return { text: refused, count: 0 };
		const id = await ctx.step("issue", async () => store.record(d.id, ctx.callId, marker(ctx)).id);
		const recorded = store.read().ddts.find((x) => x.id === id);
		if (recorded === undefined || !isRecordedReso(recorded)) return { text: "Errore: il reso non risulta registrato.", count: 0 };
		return issuedAnswer(recorded, ctx, loaded);
	}

	/** A reso of a DDT billed already: the credit note it needs, offered. */
	function resoNotes(d: Ddt, loaded: Loaded): string[] {
		if (d.causale !== "reso" || d.of === undefined) return [];
		const src = loaded.book.ddts.find((x) => x.id === d.of);
		if (src === undefined || !isIssuedDdt(src)) return [];
		const billed = src.billed?.number ?? loaded.links.issued.get(src.id);
		const goods = d.lines.map((l) => `${lineQty(l)} di ${l.description}`).join(", ");
		if (billed === undefined) return [`Il reso lo tolgo dalla fattura differita del DDT n. ${src.number}, quando la fai: non serve una nota di credito.`];
		return [fencedDdt(`Il DDT n. ${src.number} è già fatturato (fattura n. ${billed}): per ${goods} resi serve una nota di credito.`), "Vuoi che la prepari? È la nota di credito di quella fattura per questo reso."];
	}

	async function issuedAnswer(d: Ddt, ctx: ToolContext, loaded: Loaded): Promise<Answer> {
		// Counted once: on the run that completes the issue, never on a run after it.
		const before = store.read().ddts.find((x) => x.id === d.id)?.stocked === true;
		const done = await completeStock(store, options.stock, d, ctx, marker(ctx));
		const after = store.read().ddts.find((x) => x.id === d.id) ?? d;
		const ours = isIssuedDdt(after);
		const out = [`Fatto: ho ${ours ? "emesso" : "registrato"} il ${ddtTitle(after)}, come nel riquadro.`, fencedDdt(ddtBlock(after, loaded.links, loaded.book.ddts)), ...done.notes];
		if (done.done) {
			if (after.causale === "vendita") out.push("Quando fai la fattura differita del mese, questo DDT ci entra da solo; va emessa entro il 15 del mese dopo.");
			if (after.causale === "omaggio") out.push(OMAGGIO_NOTE);
			if (after.causale === "conto_visione") out.push("È in conto visione: se il cliente tiene la merce, la fatturo con la fattura differita del mese (te lo chiedo); se la rende, si fa un DDT di reso.");
			out.push(...resoNotes(after, loaded));
			if (ours) out.push(PRINT_NOTE);
		}
		return { text: out.join("\n"), count: done.done && !before ? 1 : 0 };
	}

	const cancelCheck = (d: Ddt) => createHash("sha256").update(JSON.stringify([d.id, d.number ?? d.theirs?.number ?? "", d.status, d.day])).digest("hex").slice(0, 16);

	async function cancel(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<Answer> {
		const d = target(args, loaded, (x) => x.status !== "cancelled", "aperto");
		if (typeof d === "string") return { text: d, count: 0 };
		// The same call run again after a stop between the annulment and the magazzino: the goods put back all the same, once.
		if (d.status === "cancelled" && d.cancelCall === ctx.callId && d.left === false) return { text: [`Annullato il ${ddtTitle(d)}.`, ...(await unstock(options.stock, d, day, ctx, marker(ctx)))].join(" "), count: 0 };
		if (d.status === "cancelled") return { text: `${capital(ddtTitle(d))}: è già annullato.`, count: 0 };
		const billed = d.billed?.number ?? loaded.links.issued.get(d.id);
		if (billed !== undefined) return { text: `Il ${ddtTitle(d)} è già fatturato con la fattura n. ${billed}: non si annulla. Se la merce è tornata, si fa un DDT di reso; per la fattura, una nota di credito.`, count: 0 };
		if (loaded.links.draft.has(d.id)) return { text: `Il ${ddtTitle(d)} è in una bozza di fattura: prima va tolta quella bozza (o rifatta senza questo DDT), poi lo annullo.`, count: 0 };
		if (d.status === "draft") {
			const refused = requirePersonFor(ctx, `annullo la ${ddtTitle(d)}`);
			if (refused !== undefined) return { text: refused, count: 0 };
			await cancelled(d, ctx);
			return { text: `Annullata la ${ddtTitle(d)}: nessun numero è stato usato.`, count: 1 };
		}
		const moved = d.causale !== "reso" && unloaded(options.stock, d);
		const goods = `${d.client.name}: ${d.lines.map((l) => `${lineQty(l)} di ${l.description}`).join(", ")}`;
		const which = isIssuedDdt(d) ? `il DDT n. ${d.number} ${italianLongDate(d.day).replace(/ \d{4}$/, "").replace(/^/, "del ")}` : `il ${ddtTitle(d)}`;
		if (args.confirm !== true) {
			return {
				text: [
					`Annullo ${which} (cliente e merce nel riquadro)?${isIssuedDdt(d) ? ` Il numero ${d.seq} non si potrà più usare.` : ""}${moved ? " La merce è partita lo stesso?" : ""}`,
					fencedDdt(goods),
					`Chiedilo a chi ti scrive: con il suo sì ripeti con la conferma e il controllo ${cancelCheck(d)}${moved ? ", dicendo se la merce è partita (se non è partita, la rimetto in magazzino)" : ""}.`,
				].join("\n"),
				count: 0,
			};
		}
		const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
		if (check !== cancelCheck(d)) return { text: "Errore: per annullare un DDT emesso serve il controllo che ti ho dato mostrandolo: chiedi prima l'annullamento senza conferma, mostralo a chi ti scrive e, con il suo sì, ripeti con quel controllo.", count: 0 };
		if (moved && typeof args.left !== "boolean") return { text: "Prima di annullarlo mi serve sapere se la merce è partita lo stesso: se non è partita, la rimetto in magazzino. Chiedilo a chi ti scrive.", count: 0 };
		const refused = requirePersonFor(ctx, isIssuedDdt(d) ? `annullo il DDT n. ${d.number}` : "annullo il reso registrato");
		if (refused !== undefined) return { text: refused, count: 0 };
		await cancelled(d, ctx, moved ? (args.left as boolean) : undefined);
		const out = [isIssuedDdt(d) ? `Annullato il DDT n. ${d.number}: resta nell'elenco come annullato, con il suo numero, che non si usa più.` : "Annullato il reso registrato: resta nell'elenco come annullato."];
		if (moved && args.left === false) out.push(...(await unstock(options.stock, d, day, ctx, marker(ctx))));
		else if (moved) out.push("La merce è partita lo stesso: il magazzino resta com'è.");
		if (d.causale === "reso" && options.stock?.read().moves.some((m) => m.sale?.invoice === d.id) === true) out.push("La merce di questo reso era stata rimessa in magazzino: se non è tornata davvero, va corretto con un conteggio del magazzino. Non lo cambio da sola.");
		return { text: out.join(" "), count: 1 };
	}

	async function cancelled(d: Ddt, ctx: ToolContext, left?: boolean): Promise<void> {
		const by = marker(ctx);
		await ctx.step("cancel", async () => {
			store.update(ctx.callId, (state) => {
				const cur = state.ddts.find((x) => x.id === d.id);
				if (cur === undefined || cur.status === "cancelled") return state;
				return { ...state, ddts: state.ddts.map((x) => (x.id === d.id ? { ...cur, status: "cancelled" as const, cancelled: by, cancelCall: ctx.callId, ...(left === undefined ? {} : { left }) } : x)) };
			});
			return true;
		});
	}

	async function document(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded): Promise<Answer> {
		const d = target(args, loaded, (x) => x.status === "issued" && isIssuedDdt(x), "emesso");
		if (typeof d === "string") return { text: d, count: 0 };
		if (d.status === "cancelled") return { text: `${capital(ddtTitle(d))}: è annullato, non ne faccio il documento.`, count: 0 };
		if (isRecordedReso(d)) return { text: "Questo reso è registrato con il DDT del cliente: il documento è il suo, non ne faccio uno nostro.", count: 0 };
		if (!isIssuedDdt(d)) return { text: "Il DDT è ancora una bozza: prima va emesso (prende il numero), poi lo stampo. Vuoi che te lo mostri per emetterlo?", count: 0 };
		const format = args.format === undefined ? "pdf" : args.format;
		if (format !== "pdf" && format !== "docx") return { text: "Errore: il documento è PDF o Word.", count: 0 };
		const refused = requirePersonFor(ctx, `faccio il documento del DDT n. ${d.number}`);
		if (refused !== undefined) return { text: refused, count: 0 };
		const book = options.company?.read();
		const company: Partial<Company> = book === undefined || book.broken ? {} : (book.company ?? {});
		const ext = `.${format}`;
		try {
			// The file made before is written again only when it is one of ours, under ddt/.
			const mine = d.file !== undefined && d.file.endsWith(ext) && /^ddt\/[^/\\]+$/.test(d.file) && !d.file.includes("..");
			const slug = fileSlug(d.client.name);
			const path = await ctx.step("path", async () => (mine ? (d.file as string) : await freePath(workspace, `ddt/DDT-${d.number.replace("/", "-")}${slug === "" ? "" : `-${slug}`}`, ext)));
			const made = await ctx.step("file", async () => {
				const doc = await make({ format, text: ddtMarkdown(d, company), name: `DDT ${d.number}`, pictures: [], now: now().getTime() });
				return { path: (await workspace.write(path, doc.data)).path, notes: [...doc.notes] };
			});
			await ctx.step("record", async () => {
				store.update(ctx.callId, (state) => ({ ...state, ddts: state.ddts.map((x) => (x.id === d.id ? { ...x, file: made.path.slice(0, DDT_LIMITS.file) } : x)) }));
				return true;
			});
			const bare = company.name === undefined ? ["Non ho i dati della tua azienda, quindi il documento è senza intestazione: dimmi ragione sociale, indirizzo e partita IVA e li salvo, poi lo rifaccio."] : [];
			return { text: [`Ecco il ${format === "pdf" ? "PDF" : "documento Word"} del DDT n. ${d.number}: il file è nel riquadro. Non l'ho mandato a nessuno; se vuoi te lo mando qui. Va stampato in due copie: una viaggia con la merce, l'altra resta a te, firmata.`, fencedDdt(`File: ${made.path}`), ...bare, ...made.notes].join("\n"), count: 1 };
		} catch (error) {
			if (error instanceof WorkspaceError || error instanceof DocumentError) return { text: `Errore: non sono riuscita a fare il documento del DDT (${error.message}).`, count: 0 };
			throw error;
		}
	}

	async function exportCsv(ctx: ToolContext, loaded: Loaded, day: string): Promise<Answer> {
		const all = loaded.book.ddts;
		if (all.length === 0) return { text: "Non c'è ancora nessun DDT da mettere nel file.", count: 0 };
		const path = await ctx.step("path", async () => freePath(workspace, `ddt/ddt-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, ddtCsv(all, loaded.links))).path);
		return { text: [`Salvato il file dei DDT: ${n1(all.length, "un DDT", "# DDT")}, una riga per voce, con lo stato (separatore «;», decimali con la virgola, si apre con Excel). Il percorso è nel riquadro; mandalo con file_send se chi ti scrive lo vuole.`, fencedDdt(written)].join("\n"), count: all.length };
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<Answer> {
		const thisYear = Number(day.slice(0, 4));
		if (args.numbering !== undefined && args.numbering !== "plain" && args.numbering !== "year") return { text: "Errore: il numero del DDT si scrive come «12/2026» o come «12».", count: 0 };
		const year = typeof args.year === "number" && Number.isInteger(args.year) ? args.year : thisYear;
		const last = args.last_number;
		if (last !== undefined && (typeof last !== "number" || !Number.isInteger(last) || last < 0 || last >= DDT_LIMITS.perYear)) return { text: "Errore: il numero dell'ultimo DDT è un numero intero, 0 se non ce n'è nessuno.", count: 0 };
		const shownNow = (book: Loaded["book"]) => {
			const numbering = book.settings?.numbering;
			const next = nextDdtSeq(book, thisYear);
			return `I DDT sono numerati ${numbering === "plain" ? "1, 2, 3… (oppure 1/2026, 2/2026 se preferisci)" : `1/${thisYear}, 2/${thisYear}… (oppure 1, 2, 3 se preferisci)`}: il prossimo sarà il ${numbering === "plain" ? String(next) : `${next}/${thisYear}`}.`;
		};
		if (args.numbering === undefined && last === undefined) return { text: shownNow(loaded.book), count: 0 };
		// How the DDTs are numbered, and from which number: the person's own word (ADR 0088).
		const refused = requirePersonFor(ctx, "cambio la numerazione dei DDT");
		if (refused !== undefined) return { text: refused, count: 0 };
		const issuedIn = (y: number) => loaded.book.ddts.some((d) => isIssuedDdt(d) && d.year === y);
		if (args.numbering !== undefined && args.numbering !== (loaded.book.settings?.numbering ?? "year") && issuedIn(thisYear)) return { text: `Nel ${thisYear} ho già emesso DDT con questa numerazione: si può cambiare da gennaio, prima del primo DDT del ${thisYear + 1}. Non ho cambiato niente.`, count: 0 };
		if (last !== undefined && issuedIn(year)) return { text: `Nel ${year} ho già emesso DDT, quindi la numerazione va avanti da quelli: l'ultimo numero prima di me si può dire solo prima del primo DDT dell'anno. Non ho cambiato niente.`, count: 0 };
		const by = marker(ctx);
		await ctx.step("settings", async () => {
			store.update(ctx.callId, (state) => {
				if (last !== undefined && state.ddts.some((d) => isIssuedDdt(d) && d.year === year)) throw new DdtError(`nel ${year} intanto è stato emesso un DDT: l'ultimo numero prima di me non si cambia più`);
				return { ...state, settings: { ...(state.settings ?? {}), ...by, ...(args.numbering === undefined ? {} : { numbering: args.numbering as "plain" | "year" }), ...(last === undefined ? {} : { lastBefore: { ...(state.settings?.lastBefore ?? {}), [String(year)]: last as number } }) } };
			});
			return true;
		});
		return { text: `Fatto, ho salvato. ${shownNow(store.read())}`, count: 1 };
	}

	async function brief(ctx: ToolContext, loaded: Loaded, day: string): Promise<string> {
		const { months, stale } = briefData(loaded, day, now());
		const wanted = [...months.map((m) => `unbilled:${m.month}`), ...(stale > 0 ? ["stale"] : [])];
		const said = wanted.length === 0 ? [] : await ctx.step("claim", async () => store.claim(ctx.callId, day, wanted));
		if (said.length > 0) await audit(ctx, "brief", said.length);
		return briefAnswer(
			months.filter((m) => said.includes(`unbilled:${m.month}`)),
			said.includes("stale") ? stale : 0,
			day,
		);
	}

	async function run(op: DdtOp, args: Record<string, unknown>, ctx: ToolContext, loaded: Loaded, day: string): Promise<Answer> {
		switch (op) {
			case "create":
				return create(args, ctx, loaded, day);
			case "change":
				return change(args, ctx, loaded, day);
			case "issue":
				return issue(args, ctx, loaded, day);
			case "cancel":
				return cancel(args, ctx, loaded, day);
			case "document":
				return document(args, ctx, loaded);
			case "list":
				return list(args, loaded, day);
			case "status":
				return status(args, loaded);
			case "export":
				return exportCsv(ctx, loaded, day);
			case "settings":
				return settings(args, ctx, loaded, day);
		}
	}

	const lineSchema = {
		type: "object",
		properties: {
			item: text(120, "a voce of the listino, as said or LS-0001"),
			description: text(DDT_LIMITS.description, "free text, when it is not a voce of the listino"),
			quantity: { type: ["number", "string"], description: "how many; 0 takes the line off (change)" },
			unit: text(DDT_LIMITS.unit, "«risme», «pz», «kg»; default the voce's"),
		},
		required: ["quantity"],
		additionalProperties: false,
	};

	return [
		{
			name: "ddt",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...DDT_OPS] },
					client: text(DDT_LIMITS.name, "create: the client as said, partita IVA, or card id CL-0001; change, issue, cancel, document, status, list: whose DDT"),
					ddt: text(30, "change, issue, cancel, document, status: the DDT's number («12/2026», «12») or the draft's reference (DT-0001, never said to the person)"),
					lines: { type: "array", maxItems: DDT_LIMITS.lines, items: lineSchema, description: "create: the goods; change: the lines to set" },
					causale: text(30, "vendita (default), conto visione, reso, riparazione, omaggio, comodato, lavorazione"),
					of: text(30, "create, change with causale reso: the DDT the goods come back from (default: the client's latest with those goods, proposed)"),
					their_number: text(20, "create, change with causale reso: the number of the client's own DDT the goods came back with"),
					their_date: text(40, "create, change with causale reso: the date of the client's own DDT"),
					transport: { type: "string", enum: ["mittente", "destinatario", "vettore"], description: "who carries the goods: the person (mittente), the client (destinatario), a carrier (vettore)" },
					carrier: text(DDT_LIMITS.carrier, "the carrier's name, with transport vettore"),
					destination: text(DDT_LIMITS.destination, "where the goods go, when not the client's address"),
					aspect: text(DDT_LIMITS.aspect, "aspetto esteriore dei beni («scatole», «pallet»)"),
					packages: { type: ["integer", "string"], description: "numero colli" },
					weight: { type: ["number", "string"], description: "peso in kg" },
					notes: text(DDT_LIMITS.notes, "notes on the DDT"),
					date: text(40, "issue: the DDT's date as said («domani», «20/10»); default today"),
					confirm: { type: "boolean", description: "create, cancel: true only after the person's yes to the proposal; issue: true only after the person's yes to what was shown" },
					check: text(20, "create, cancel with confirm: the check given with the proposal"),
					left: { type: "boolean", description: "cancel of an issued DDT: whether the goods left anyway (false: they are put back in the magazzino)" },
					format: { type: "string", enum: ["pdf", "docx"], description: "document: PDF (default) or Word" },
					unbilled: { type: "boolean", description: "list: only the DDTs not invoiced yet" },
					month: text(7, "list: the month, as 2026-10"),
					all: { type: "boolean", description: "list: every DDT, the annulled ones and the past years too" },
					compact: { type: "boolean", description: "list: the brief's line only" },
					numbering: { type: "string", enum: ["plain", "year"], description: "settings: «12» or «12/2026» (default)" },
					last_number: { type: "integer", minimum: 0, maximum: DDT_LIMITS.perYear - 1, description: "settings, issue: the number of the last DDT the person made this year before Owni (0: none), as the person says it; with issue, again with the confirm" },
					year: { type: "integer", minimum: 2000, maximum: 2100, description: "settings: the year of last_number" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!DDT_OPS.includes(args.op as DdtOp)) return "Errore: non conosco questa operazione sui DDT.";
				const op = args.op as DdtOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				// DDTs name clients, goods and addresses: another agente gets counts only.
				if (isAgentTurn(ctx) && !["list", "status"].includes(op)) return AGENT_REFUSAL;
				const day = todayIn(timeZone, now());
				try {
					const loaded = load();
					if (typeof loaded === "string") return loaded;
					if (isAgentTurn(ctx)) return agentCounts(loaded);
					if (op === "list" && args.compact === true) return await brief(ctx, loaded, day);
					const answer = await run(op, args, ctx, loaded, day);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof DdtError) return `Errore: ${error.message}.`;
					if (error instanceof StockError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}

const capital = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
