/**
 * The tool `staff`: il personale of a small business (not Owni's users: HR data only). The
 * people with their usual week, their dates and what they are entitled to (staff-people.ts);
 * their absences (ferie, permesso, malattia, altro from a closed list: added, changed, cancelled
 * only on the person's own word; an overlap refused and said, but a malattia in the ferie offers
 * to shorten them, with a check); the shifts of a week from the usual week less absences and
 * closures, with the hours nobody covers; who works on a day; ferie and permessi left (an
 * estimate: the consulente del lavoro has the official figure); the month for the consulente, day
 * by day (CSV, PDF or Word in personale/, never sent). An absence, or the time off the shift, of a
 * person who is a resource of the appointments blocks it there; the appointments an absence falls
 * on are listed. Health data: of a malattia only the dates and the certificate's protocol (digits),
 * never a diagnosis, and no free text that looks like one. The shifts' file and the brief say
 * «assente», never why; another agente gets counts only; the audit the op and a count. Names,
 * reasons, notes and protocols: in the fence.
 */
import { createHash } from "node:crypto";
import type { AppointmentSettings } from "../appointments.ts";
import { localNow, type Span } from "../appointment-slots.ts";
import type { AppointmentStore } from "../appointment-store.ts";
import { makeDocumentFile } from "../document-reader.ts";
import { DocumentError } from "../documents.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { addDays, daysBetween, MONTH_NAMES, weekdayOf } from "../italian-calendar.ts";
import { italianDate } from "../italian-format.ts";
import type { MadeDocument, MakeInput } from "../make-document.ts";
import type { Marker } from "../marker.ts";
import { PeriodError, readPeriod } from "../periods.ts";
import { type Absence, type AbsenceKind, absenceId, ALTRO_REASONS, decimalWords, employed, HALVES, type Half, hoursWords, isActive, KINDS, looksHealth, overlaps, type Person, spanOf, STAFF_LIMITS, StaffError, type StaffSettings } from "../staff.ts";
import { type Balance, balancesOf } from "../staff-balances.ts";
import { festivoOn, monthDetail, monthEnd } from "../staff-month.ts";
import { absenceDays, closedOn, coverageGaps, dayOf, type FerieRule, permessoMinutes, skippedIn, type StaffDay } from "../staff-shifts.ts";
import { STAFF_BROKEN, type StaffBook, type StaffStore } from "../staff-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { absenceNamed, dayHours, isAnswer, minutesOfHours, personSaid, protocolSaid, rangeSaid, reasonSaid, staffDay, staffDayNoted, staffTime } from "./staff-input.ts";
import { type Answer, closeAsk, createPeopleOps, HEALTH_FIELD, type Now } from "./staff-people.ts";
import { absenceRow, absenceWords, dayWords, fencedStaff, monthCsv, monthMarkdown, monthRow, personDayRow, plainDay, shiftsCsv, shiftsMarkdown, spansWords } from "./staff-render.ts";

export const STAFF_OPS = ["person", "archive", "delete", "absence", "change", "cancel", "extra", "shift", "who", "shifts", "balance", "absences", "summary", "export", "settings"] as const;
export type StaffOp = (typeof STAFF_OPS)[number];

/** What was done, for the audit: the op and how many, never names, kinds or days. */
export type StaffEvent = { readonly type: "staff.used"; readonly op: StaffOp | "brief"; readonly count: number };

export type StaffToolsOptions = {
	readonly workspace: Workspace;
	readonly store: StaffStore;
	/** The appointments: the business's hours and closures, and those an absence falls on. */
	readonly appointments?: Pick<AppointmentStore, "read">;
	/** The business's time zone (Europe/Rome). */
	readonly timeZone: string;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: StaffEvent) => Promise<void>;
	/** Tests: the clock and the document maker. */
	readonly now?: () => Date;
	readonly make?: (input: MakeInput) => Promise<MadeDocument>;
};

const DESCRIPTION = [
	"Il personale di una piccola attività (non gli utenti di Owni né gli appuntamenti con i clienti, che sono appointments; «chiudo per ferie» è la chiusura dell'attività, appointments settings): le persone che ci lavorano (non gli utenti di Owni), il loro orario di solito, ferie, permessi, malattia, i turni, il riepilogo per la consulente del lavoro. Not the appointments with clients (appointments), not the agents of the board, not the people who use Owni. «chiudo per ferie dal 10 al 20 agosto» is the business closing: appointments settings, not staff.",
	"What the person says → op: «Giulia è in ferie dal 3 al 14 agosto» → absence with person, kind ferie, from, to (half mattina/pomeriggio for half a day); «Marco domani ha un permesso dalle 15» → absence kind permesso, from, start (end when said); «Marco è in malattia da oggi» → absence kind malattia, from (to only when said; protocol only the certificate's number: never a diagnosis, never ask for one); lutto, congedo parentale, «malattia del figlio» (reason congedo malattia figlio), matrimoniale, L.104 (by the day, or by the hour with start and end), donazione sangue, studio, sindacale, non retribuito → kind altro with reason from that list. «sposta le ferie di Giulia» → change; «annulla il permesso di Marco» → cancel (with on, the day). «Marco ieri ha fatto 2 ore in più» → extra with person, date, hours. «sabato Giulia fa 9-13» → shift with person, date, hours («riposo» for a day off). These only on the person's own word.",
	"«chi lavora sabato?» → who with date; «fammi i turni della prossima settimana» → shifts with date (a day of that week); «quante ferie le restano a Giulia?» → balance with person (an estimate: say so); «chi è in ferie ad agosto?» → absences with period; «mandami il riepilogo ore di ottobre per la consulente del lavoro» → summary with month, then export what summary (CSV and PDF in personale/): never sent; offer google_mail_send with the file (it asks its approval). Turni as a file → export what shifts.",
	"«assumo Luca da lunedì, 20 ore, mattina» → person with person (a first name is enough), from (the first day), weekly_hours, week as said: Owni asks what is missing. person: «Giulia Verdi, commessa, 40 ore, lun-ven 9-13 e 14-18, 26 giorni di ferie e 72 ore di permessi; le restano 12 giorni di ferie» → person with name, role (a short job title), weekly_hours, week (one line), ferie_days, rol_hours, ferie_left, rol_left (as_of: the day of that balance); resource: her name in the appointments («nessuna» takes it off); name: a new full name; new true for a new person («assumo», «è arrivata», a name like another's): without it, a name with nothing else said is only looked up. «Luca non lavora più da noi da venerdì» → archive with person and from (the first day he does not work: the last is the day before); «il suo ultimo giorno è venerdì» → archive with person and to. Ferie or a permesso on days more than a week ago said without the year: Owni asks if they are already taken; on «sì, già fatte» repeat with past true. Deleting a person (delete) shows a proposal: only after the person's yes repeat with confirm true and the check. A malattia in the ferie: Owni proposes to shorten them; on the yes repeat with confirm true and the check.",
	"settings: monthly true when ferie and permessi accrue month by month; ferie_week 5 or 6 (the days a week ferie are counted on). summary of the brief: who with compact true. Never say a reference (PE-…, AS-…) to the person: name the person.",
].join(" ");

const AGENT_NOTE = "A un altro agente do solo i conteggi: chi e perché no.";
const BRIEF_NOTHING = "Personale: niente da segnalare.";
const BRIEF_BROKEN = "Personale: il file non si legge, guarda il runbook.";
const HEALTH_REASON = "Il motivo non lo scrivo da nessuna parte, è un dato sanitario: mi basta il numero di protocollo del certificato, quando ce l'hai, che serve alla consulente.";
const BAD_PROTOCOL = "Questo non sembra un numero di protocollo (sono solo cifre): non l'ho salvato. Quando hai il certificato, dimmi il numero.";
const elides = (day: string) => day.slice(8, 10) === "08" || day.slice(8, 10) === "11";
const monthOfDay = (day: string) => MONTH_NAMES[Number(day.slice(5, 7)) - 1] as string;
const dayMonth = (day: string) => `${Number(day.slice(8, 10))} ${monthOfDay(day)}`;
/** Ferie or a permesso said without the year, read more than a week back: asked, never guessed. «Il 2-5 giugno è già passato: …». */
function pastAsk(kind: "ferie" | "permesso", from: string, to: string): string {
	const the = elides(from) ? "L'" : "Il ";
	const when = from === to ? `${the}${dayMonth(from)}` : from.slice(0, 7) === to.slice(0, 7) ? `${the}${Number(from.slice(8, 10))}-${dayMonth(to)}` : `Il periodo ${elides(from) ? "dall'" : "dal "}${dayMonth(from)} ${elides(to) ? "all'" : "al "}${dayMonth(to)}`;
	const what = kind === "ferie" ? "le segno come ferie già fatte" : "lo segno come permesso già fatto";
	return `${when} è già passato: ${what}, o intendi ${monthOfDay(from)} ${Number(from.slice(0, 4)) + 1}?`;
}
/** A note said now: short (a file may hold up to STAFF_LIMITS.note, from before). */
const NOTE_SAID = 80;
const PROTOCOL_ASK = "Quando hai il certificato, dimmi il numero di protocollo: serve alla consulente.";
const NO_ABSENCE_NOTE = "Le note sulle assenze non le scrivo: bastano il tipo, i giorni e, per le altre assenze, il motivo dalla lista.";
const ESTIMATE = "stima: il dato ufficiale ce l'ha la consulente";
const REASONS = ALTRO_REASONS.filter((r) => r !== "altro").join(", ");

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));
const absentCount = (n: number) => (n === 0 ? "nessuno assente" : n1(n, "un assente", "# assenti"));

export function createStaffTools(options: StaffToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const make = options.make ?? ((input: MakeInput) => makeDocumentFile(input));
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: StaffEvent["op"], count: number) => {
		await ctx.step(`audit-${op}`, async () => {
			await options.record?.({ type: "staff.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const hours = (): AppointmentSettings | undefined => {
		const b = options.appointments?.read();
		return b === undefined || b.broken ? undefined : b.settings;
	};
	const data = (b: StaffBook): StaffDay => {
		const settings = hours();
		return { people: b.people, absences: b.absences, shifts: b.shifts, ...(settings === undefined ? {} : { settings }) };
	};
	const ruleOf = (b: StaffBook): FerieRule => {
		const settings = hours();
		return { six: b.settings?.ferieWeek === 6, shifts: b.shifts, ...(settings === undefined ? {} : { settings }) };
	};
	const offOn = (b: StaffBook, day: string) => dayOf(data(b), day).people.filter((p) => p.off !== undefined);
	const people = createPeopleOps({ store, marker, hours });

	/** Another agente: counts only, no names, no kinds. */
	function agentCounts(b: StaffBook, at: Now): string {
		return `Personale: oggi ${absentCount(offOn(b, at.day).length)}, domani ${absentCount(offOn(b, addDays(at.day, 1)).length)}. ${AGENT_NOTE}`;
	}

	/** A short note said with a shift or extra hours (at most NOTE_SAID characters): kept unless it looks like health data. */
	function noteSaid(raw: unknown, notes: string[]): string | undefined | { error: string } {
		if (raw === undefined) return undefined;
		const n = cleanText(raw, STAFF_LIMITS.note, "la nota");
		if (isProblem(n)) return { error: `Errore: ${n.problem}.` };
		if (n === undefined) return undefined;
		if (n.length > NOTE_SAID) return { error: `Errore: la nota è lunga: tienila in poche parole (al più ${NOTE_SAID} caratteri), come «copre la collega».` };
		if (looksHealth(n)) {
			notes.push(HEALTH_FIELD("La nota"));
			return undefined;
		}
		return n;
	}

	/** The absence as said, checked: kind, days, times, protocol, reason (no free note: an old one is dropped on a change). Notes for the answer (the health ones, a year read). */
	function absenceSaid(args: Record<string, unknown>, p: Person, at: Now, base?: Absence): { absence: Omit<Absence, "id" | "callId" | "by" | "at">; notes: string[] } | string {
		const kind = (args.kind ?? base?.kind) as AbsenceKind;
		if (!KINDS.includes(kind)) return `Errore: l'assenza è ferie, permesso, malattia o altro (${REASONS}).`;
		const notes: string[] = [];
		const out: Record<string, unknown> = { person: p.id, kind };
		const changedDays = args.from !== undefined || args.to !== undefined;
		const kindChanged = base !== undefined && kind !== base.kind;
		const byHour = kind === "permesso" || (kind === "altro" && (args.start !== undefined || (!kindChanged && !changedDays && base?.start !== undefined)));
		if (byHour) {
			const read = staffDayNoted(args.from ?? base?.from ?? "oggi", at.day, "nearest");
			if (isAnswer(read)) return read.answer;
			if (read.note !== undefined) notes.push(read.note);
			const day = read.day;
			if (kind === "permesso" && read.yearless === true && args.past !== true && day < addDays(at.day, -7)) return pastAsk(kind, day, day);
			const start = args.start !== undefined ? staffTime(args.start) : kindChanged ? undefined : base?.start;
			if (start === undefined) return `Errore: dimmi da che ora è ${kind === "permesso" ? "il permesso" : "l'assenza"}.`;
			if (isAnswer(start)) return start.answer;
			const end = args.end !== undefined ? staffTime(args.end) : kindChanged ? undefined : base?.end;
			if (end !== undefined && isAnswer(end)) return end.answer;
			if (end !== undefined && end <= start) return "Errore: finisce prima di cominciare: dimmi le ore di nuovo.";
			if (end === undefined && (p.week?.[String(weekdayOf(day))] ?? []).length === 0) return "Errore: quel giorno non ha un orario di solito: dimmi fino a che ora.";
			Object.assign(out, { from: day, to: day, start, ...(end === undefined ? {} : { end }) });
		} else {
			// The start of a malattia without its year is past: it has begun.
			const keep = !changedDays && base !== undefined && !(kindChanged && base.to === undefined && kind !== "malattia");
			const r = keep ? { from: base.from, ...(base.to === undefined ? {} : { to: base.to }), notes: [] as string[] } : rangeSaid(args.from ?? base?.from, args.to ?? (kind === "malattia" || base === undefined ? undefined : (base.to ?? args.from ?? base.from)), at.day, kind === "malattia", kind === "malattia" ? "recent" : "nearest");
			if (isAnswer(r)) return r.answer;
			if (kind === "ferie" && !keep && r.yearless === true && args.past !== true && r.from < addDays(at.day, -7)) return pastAsk(kind, r.from, r.to ?? r.from);
			notes.push(...r.notes);
			Object.assign(out, { from: r.from, ...(r.to === undefined ? {} : { to: r.to }) });
			// A half day stays only on ferie of the same days: a kind or days changed drop it.
			const half = args.half ?? (changedDays || kindChanged ? undefined : base?.half);
			if (half !== undefined) {
				if (kind !== "ferie" || !HALVES.includes(half as Half) || r.to !== r.from) return "Errore: la mezza giornata è di ferie, di un giorno solo: mattina o pomeriggio.";
				out.half = half;
			}
		}
		if (kind === "malattia") {
			// Health data: the certificate's protocol only (digits), no reason, no note.
			const prot = args.protocol !== undefined ? protocolSaid(args.protocol) : kindChanged ? undefined : base?.protocol;
			if (prot === "bad") notes.push(BAD_PROTOCOL);
			else if (prot !== undefined) out.protocol = prot;
			if (args.reason !== undefined || args.note !== undefined) notes.push(HEALTH_REASON);
		} else {
			if (kind === "altro") {
				if (args.reason !== undefined) {
					const reason = reasonSaid(args.reason);
					if (reason === "health") return `Errore: il motivo sembra un dato sanitario, e non lo scrivo da nessuna parte. Se è una malattia, segnala come malattia (mi basta il protocollo del certificato); se è un'altra assenza, dimmi di che tipo: ${REASONS}.`;
					if (reason === "unknown") return `Errore: il motivo di un'altra assenza è uno di questi: ${REASONS}, oppure altro. Dimmi quale.`;
					out.reason = reason;
				} else if (!kindChanged && base?.reason !== undefined) out.reason = base.reason;
				else out.reason = "altro";
			} else if (args.reason !== undefined) notes.push(`Il motivo lo tengo solo per le altre assenze (${REASONS}): per ferie e permessi non serve.`);
			if (args.note !== undefined) notes.push(NO_ABSENCE_NOTE);
			if (args.protocol !== undefined) notes.push("Il numero di protocollo vale solo per la malattia: non l'ho salvato.");
		}
		return { absence: out as Omit<Absence, "id" | "callId" | "by" | "at">, notes };
	}

	/** The appointments of the person's resource the absence falls on: listed, with the offer to move them. */
	function appointmentsHit(p: Person, a: Pick<Absence, "from" | "to" | "half" | "start" | "end">, today: string): string[] {
		if (p.resource === undefined || options.appointments === undefined) return [];
		const ab = options.appointments.read();
		if (ab.broken) return ["Attenzione: gli appuntamenti non si leggono, quindi non so se l'assenza ne tocca qualcuno."];
		const span = spanOf(a);
		const last = a.to ?? addDays(today, 60);
		const hit = ab.appointments.filter((x) => x.status === "booked" && x.resource?.toLowerCase() === p.resource?.toLowerCase() && x.day >= a.from && x.day <= last && x.day >= today).filter((x) => {
			const s = Number(x.start.slice(0, 2)) * 60 + Number(x.start.slice(3, 5));
			return x.day !== a.from && x.day !== a.to ? span.from === 0 && span.to === 24 * 60 : s < span.to && span.from < s + x.minutes;
		});
		if (hit.length === 0) return [];
		return [`Attenzione: in quei giorni ${n1(hit.length, "c'è un appuntamento", "ci sono # appuntamenti")} con questa persona (nel riquadro). Vuoi che ${hit.length === 1 ? "lo sposti" : "li sposti"}? Dimmi a quando, o con chi, uno per uno.`, fencedStaff(hit.slice(0, STAFF_LIMITS.shown).map((x) => `${italianDate(x.day)} ${x.start} ${x.client.name} (rif. ${x.id})`).join("\n"))];
	}

	/** «Sono 9 giorni di ferie (lun-ven; Ferragosto non conta); restano circa 12 giorni (stima: …).» */
	function countWords(p: Person, a: Absence, b: StaffBook, at: Now): string[] {
		if (a.kind !== "ferie" && a.kind !== "permesso" && a.kind !== "altro") return [];
		const rule = ruleOf(b);
		// What is left is this year's: an absence of another year says only its days.
		const thisYear = a.from.slice(0, 4) === at.day.slice(0, 4);
		const bal = balancesOf(p, b.absences, b.shifts, at.day, b.settings?.monthly === true, hours(), rule);
		if (a.kind === "permesso" || (a.kind === "altro" && a.start !== undefined)) {
			const m = permessoMinutes(p, a, b.shifts, hours());
			const left = a.kind === "permesso" && thisYear && bal.permessi.left !== undefined ? `; restano circa ${hoursWords(bal.permessi.left)} ore di permessi (${ESTIMATE})` : "";
			return [`${m === 60 ? "È" : "Sono"} ${hoursWords(m)} ${m === 60 ? "ora" : "ore"}${a.kind === "permesso" ? " di permesso" : ""}${left}.`];
		}
		const days = absenceDays(p, a, a.from, a.to ?? a.from, at.day, rule);
		const skipped = skippedIn(p, a, rule);
		const why = [rule.six ? "lun-sab" : "lun-ven", ...(skipped.holidays.length === 0 ? [] : [`${skipped.holidays.join(" e ")} non ${skipped.holidays.length === 1 ? "conta" : "contano"}`]), ...(skipped.closures === 0 ? [] : [n1(skipped.closures, "il giorno di chiusura non conta", "i # giorni di chiusura non contano")]), ...(skipped.off === 0 ? [] : [n1(skipped.off, "il giorno di riposo detto a parte non conta", "i # giorni di riposo detti a parte non contano")])];
		const left = a.kind === "ferie" && thisYear && bal.ferie.left !== undefined ? `; restano circa ${decimalWords(bal.ferie.left)} giorni (${ESTIMATE})` : "";
		return [`${days === 100 ? "È" : "Sono"} ${decimalWords(days)} ${days === 100 ? "giorno" : "giorni"}${a.kind === "ferie" ? " di ferie" : ""} (${why.join("; ")})${left}.`, ...(a.kind === "ferie" && b.settings?.ferieWeek === undefined ? ["Se il vostro contratto conta anche il sabato, dimmelo."] : [])];
	}

	/** A malattia in some ferie: shorten them (or cancel those after its start) and save it, with a check. */
	async function sickInFerie(args: Record<string, unknown>, ctx: ToolContext, p: Person, said: { absence: Omit<Absence, "id" | "callId" | "by" | "at">; notes: string[] }, ferie: Absence[], at: Now): Promise<Answer> {
		const sick = said.absence;
		const check = hash(["sick-in-ferie", p.id, sick, ferie.map((f) => [f.id, f.from, f.to, f.changed?.at ?? ""])]);
		const plans = ferie.map((f) => (f.from < sick.from ? { f, to: addDays(sick.from, -1) } : { f, to: undefined }));
		const words = (done: boolean) => plans.map(({ f, to }) => (to === undefined ? `${done ? "ho annullato" : "annullo"} le ferie ${absenceWords(f, at.day).replace(/^ferie /, "")}` : `${done ? "ho accorciato" : "accorcio"} le ferie ${absenceWords(f, at.day).replace(/^ferie /, "")} a ${plainDay(to, at.day)}`));
		const say = words(false);
		const after = sick.to !== undefined && ferie.some((f) => (f.to ?? f.from) > (sick.to as string));
		const ask = [
			`La persona nel riquadro è in ferie in quei giorni: la malattia interrompe le ferie. ${capital(say.join(", "))} e segno la malattia da ${plainDay(sick.from, at.day)}? I giorni di ferie non goduti tornano nel suo saldo.${after ? " Se dopo la malattia torna in ferie, quelle le segni di nuovo." : ""}`,
			fencedStaff(ferie.map((f) => absenceRow(f, p, at.day)).join("\n")),
			`Se chi ti scrive dice di sì, ripeti con la conferma e il controllo ${check}.`,
		].join("\n");
		if (args.confirm !== true) return { text: ask, count: 0 };
		const given = typeof args.check === "string" ? args.check.trim().toLowerCase() : "";
		if (given !== check) return { text: `Errore: il controllo non torna: non ho cambiato niente.\n${ask}`, count: 0 };
		const by = marker(ctx);
		await ctx.step("absence", async () => {
			store.update(ctx.callId, (state) => {
				const ids = new Set(ferie.map((f) => f.id));
				const now = state.absences.filter((x) => isActive(x) && x.person === p.id && overlaps(x, sick));
				if (now.length !== ferie.length || now.some((x) => !ids.has(x.id) || x.kind !== "ferie")) throw new StaffError("intanto le assenze di questa persona sono cambiate: non ho segnato niente. Chiedi di nuovo");
				const absences = state.absences.map((x) => {
					const plan = plans.find((q) => q.f.id === x.id);
					if (plan === undefined) return x;
					if (plan.to === undefined) return { ...x, cancelled: { ...by, call: ctx.callId } };
					const { half: _h, ...rest } = x;
					return { ...rest, to: plan.to, ...(x.half !== undefined && plan.to === x.from ? { half: x.half } : {}), changed: { ...by, call: ctx.callId } } as Absence;
				});
				if (absences.length >= STAFF_LIMITS.absences) throw new StaffError("le assenze sono troppe per salvarne altre");
				return { ...state, nextAbsence: state.nextAbsence + 1, absences: [...absences, { id: absenceId(state.nextAbsence), ...sick, callId: ctx.callId, ...by } as Absence] };
			});
			return true;
		});
		const saved = store.read().absences.find((x) => x.callId === ctx.callId) as Absence;
		return { text: [`Fatto: ${words(true).join(", ")} e ho segnato ${absenceWords(saved, at.day)}, per la persona nel riquadro. I giorni di ferie non goduti tornano nel suo saldo.`, fencedStaff(absenceRow(saved, p, at.day)), ...said.notes, ...appointmentsHit(p, saved, at.day)].join("\n"), count: 1 };
	}

	async function absence(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const mine = b.absences.find((a) => a.callId === ctx.callId);
		if (mine !== undefined) return { text: `Fatto: ho segnato ${absenceWords(mine, at.day)}.`, count: 1 };
		const refused = requirePersonFor(ctx, "segno l'assenza");
		if (refused !== undefined) return { text: refused, count: 0 };
		const whoP = personSaid(args.person, b.people);
		if (isAnswer(whoP)) return { text: whoP.answer, count: 0 };
		if (whoP.close === true) return { text: closeAsk(whoP.person), count: 0 };
		const p = whoP.person;
		const said = absenceSaid(args, p, at);
		if (typeof said === "string") return { text: said, count: 0 };
		const clashes = b.absences.filter((x) => isActive(x) && x.person === p.id && overlaps(x, said.absence));
		if (said.absence.kind === "malattia" && clashes.length > 0 && clashes.every((x) => x.kind === "ferie")) return sickInFerie(args, ctx, p, said, clashes, at);
		// A malattia over ferie and something else: the ferie it could shorten, the rest blocks; say which.
		const blocking = said.absence.kind === "malattia" ? clashes.filter((x) => x.kind !== "ferie") : clashes;
		const clash = blocking[0];
		if (clash !== undefined && blocking.length < clashes.length)
			return { text: [`Non l'ho segnata: le ferie di quei giorni le accorcerei, ma c'è anche un'altra assenza che le blocca (${absenceWords(clash, at.day)}), e quella la malattia non la cambia da sola. Annulla o cambia prima quella (nel riquadro), poi ripeti la malattia e ti propongo come accorciare le ferie.`, fencedStaff(blocking.map((x) => absenceRow(x, p, at.day)).join("\n"))].join("\n"), count: 0 };
		if (clash !== undefined) return { text: [`Non l'ho segnata: si sovrappone a un'assenza già segnata (${absenceWords(clash, at.day)}). Se è cambiata, cambia quella.`, fencedStaff(absenceRow(clash, p, at.day))].join("\n"), count: 0 };
		const by = marker(ctx);
		await ctx.step("absence", async () => {
			store.update(ctx.callId, (state) => {
				if (state.absences.length >= STAFF_LIMITS.absences) throw new StaffError("le assenze sono troppe per salvarne altre");
				const again = state.absences.find((x) => isActive(x) && x.person === p.id && overlaps(x, said.absence));
				if (again !== undefined) throw new StaffError("intanto è stata segnata un'altra assenza negli stessi giorni: non l'ho segnata");
				const made = { id: absenceId(state.nextAbsence), ...said.absence, callId: ctx.callId, ...by } as Absence;
				return { ...state, nextAbsence: state.nextAbsence + 1, absences: [...state.absences, made] };
			});
			return true;
		});
		const after = store.read();
		const saved = after.absences.find((x) => x.callId === ctx.callId) as Absence;
		return {
			text: [`Segnato: ${absenceWords(saved, at.day)}, per la persona nel riquadro.`, fencedStaff(absenceRow(saved, p, at.day)), ...said.notes, ...countWords(p, saved, after, at), ...appointmentsHit(p, saved, at.day)].join("\n"),
			count: 1,
		};
	}

	async function change(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now, cancel: boolean): Promise<Answer> {
		const done = b.absences.find((a) => (cancel ? a.cancelled?.call : a.changed?.call) === ctx.callId);
		if (done !== undefined) return { text: cancel ? `Fatto: ho annullato ${absenceWords(done, at.day)}.` : `Fatto: ora è ${absenceWords(done, at.day)}.`, count: 1 };
		const refused = requirePersonFor(ctx, cancel ? "annullo l'assenza" : "cambio l'assenza");
		if (refused !== undefined) return { text: refused, count: 0 };
		const named = absenceNamed(args, b.absences, b.people, at.day);
		if (isAnswer(named)) return { text: named.answer, count: 0 };
		if (named.close === true) return { text: closeAsk(named.person), count: 0 };
		const a = named.absence;
		const by = marker(ctx);
		const gone = "intanto questa assenza è stata annullata: non ho cambiato niente";
		if (cancel) {
			await ctx.step("cancel", async () => {
				store.update(ctx.callId, (state) => {
					const x = state.absences.find((y) => y.id === a.id);
					if (x === undefined || !isActive(x)) throw new StaffError(gone);
					return { ...state, absences: state.absences.map((y) => (y.id === a.id ? { ...y, cancelled: { ...by, call: ctx.callId } } : y)) };
				});
				return true;
			});
			return { text: [`Fatto: ho annullato ${absenceWords(a, at.day)} della persona nel riquadro. Resta nello storico come annullata.`, fencedStaff(named.person.name)].join("\n"), count: 1 };
		}
		const said = absenceSaid(args, named.person, at, a);
		if (typeof said === "string") return { text: said, count: 0 };
		const clash = b.absences.find((x) => x.id !== a.id && isActive(x) && x.person === a.person && overlaps(x, said.absence));
		if (clash !== undefined) return { text: [`Non l'ho cambiata: si sovrapporrebbe a un'altra assenza già segnata (${absenceWords(clash, at.day)}).`, fencedStaff(absenceRow(clash, named.person, at.day))].join("\n"), count: 0 };
		await ctx.step("change", async () => {
			store.update(ctx.callId, (state) => {
				const x = state.absences.find((y) => y.id === a.id);
				if (x === undefined || !isActive(x)) throw new StaffError(gone);
				const again = state.absences.find((y) => y.id !== a.id && isActive(y) && y.person === a.person && overlaps(y, said.absence));
				if (again !== undefined) throw new StaffError("intanto è stata segnata un'altra assenza negli stessi giorni: non l'ho cambiata");
				return { ...state, absences: state.absences.map((y) => (y.id === a.id ? ({ id: y.id, ...said.absence, callId: y.callId, by: y.by, at: y.at, changed: { ...by, call: ctx.callId } } as Absence) : y)) };
			});
			return true;
		});
		const after = store.read();
		const saved = after.absences.find((x) => x.id === a.id) as Absence;
		// The brief asks only the end; the protocol is asked here, in the owner's own chat.
		const protocolAsk = saved.kind === "malattia" && saved.protocol === undefined && !said.notes.includes(BAD_PROTOCOL) ? [PROTOCOL_ASK] : [];
		return { text: [`Fatto: ora è ${absenceWords(saved, at.day)}, per la persona nel riquadro.`, fencedStaff(absenceRow(saved, named.person, at.day)), ...said.notes, ...protocolAsk, ...countWords(named.person, saved, after, at), ...appointmentsHit(named.person, saved, at.day)].join("\n"), count: 1 };
	}

	/** «(domenica)», «(festivo: Natale)». */
	const festivoWords = (day: string) => {
		const f = festivoOn(day);
		return f === undefined ? "" : f === "domenica" ? " (domenica)" : ` (festivo: ${f})`;
	};

	async function extra(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "segno le ore in più");
		if (refused !== undefined) return { text: refused, count: 0 };
		const whoP = personSaid(args.person, b.people);
		if (isAnswer(whoP)) return { text: whoP.answer, count: 0 };
		if (whoP.close === true) return { text: closeAsk(whoP.person), count: 0 };
		// Extra hours are done: a day without its year is past.
		const read = staffDayNoted(args.date ?? "oggi", at.day, "past");
		if (isAnswer(read)) return { text: read.answer, count: 0 };
		const day = read.day;
		if (day > at.day) return { text: "Errore: le ore in più si segnano quando sono fatte: dimmi un giorno passato o oggi.", count: 0 };
		const minutes = minutesOfHours(args.hours);
		if (isAnswer(minutes)) return { text: minutes.answer, count: 0 };
		if (minutes > STAFF_LIMITS.extraMinutes) return { text: "Errore: sono troppe ore in più per un giorno solo.", count: 0 };
		const notes: string[] = [];
		const note = noteSaid(args.note, notes);
		if (typeof note === "object") return { text: note.error, count: 0 };
		const by = marker(ctx);
		await ctx.step("extra", async () => {
			store.update(ctx.callId, (state) => {
				if (state.extras.length >= STAFF_LIMITS.extras) throw new StaffError("le ore in più segnate sono troppe per salvarne altre");
				return { ...state, extras: [...state.extras, { person: whoP.person.id, day, minutes, callId: ctx.callId, ...(note === undefined ? {} : { note }), ...by }] };
			});
			return true;
		});
		const when = dayWords(day, at.day);
		// «domenica 13 settembre» says it already.
		const festivo = festivoOn(day) === "domenica" && when.startsWith("domenica") ? "" : festivoWords(day);
		const marked = festivoOn(day) !== undefined;
		return {
			text: [`Fatto: ho segnato ${hoursWords(minutes)} ${minutes === 60 ? "ora" : "ore"} in più ${when}${festivo} per la persona nel riquadro. Vanno nel riepilogo del mese per la consulente${marked ? ", segnate come lavoro di domenica o festivo" : ""}.`, fencedStaff(whoP.person.name), ...(read.note === undefined ? [] : [read.note]), ...notes].join("\n"),
			count: 1,
		};
	}

	async function shift(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "cambio i turni");
		if (refused !== undefined) return { text: refused, count: 0 };
		const whoP = personSaid(args.person, b.people);
		if (isAnswer(whoP)) return { text: whoP.answer, count: 0 };
		if (whoP.close === true) return { text: closeAsk(whoP.person), count: 0 };
		const read = staffDayNoted(args.date, at.day, "nearest");
		if (isAnswer(read)) return { text: read.answer, count: 0 };
		const day = read.day;
		const h = dayHours(args.hours);
		if (isAnswer(h)) return { text: h.answer, count: 0 };
		const notes: string[] = [];
		const note = noteSaid(args.note, notes);
		if (typeof note === "object") return { text: note.error, count: 0 };
		const by = marker(ctx);
		await ctx.step("shift", async () => {
			store.update(ctx.callId, (state) => {
				const rest = state.shifts.filter((s) => !(s.person === whoP.person.id && s.day === day));
				if (rest.length >= STAFF_LIMITS.shifts) throw new StaffError("i turni cambiati sono troppi per salvarne altri");
				return { ...state, shifts: [...rest, { person: whoP.person.id, day, hours: h, ...(note === undefined ? {} : { note }), ...by }] };
			});
			return true;
		});
		const spans = h.map((o) => ({ from: Number(o.from.slice(0, 2)) * 60 + Number(o.from.slice(3)), to: o.to === "24:00" ? 1440 : Number(o.to.slice(0, 2)) * 60 + Number(o.to.slice(3)) }));
		return { text: [`Fatto: ${dayWords(day, at.day)} la persona nel riquadro ${h.length === 0 ? "è di riposo" : `lavora ${spansWords(spans)}`}, al posto dell'orario di solito.`, fencedStaff(whoP.person.name), ...(read.note === undefined ? [] : [read.note]), ...notes].join("\n"), count: 1 };
	}

	function gapWords(gaps: readonly Span[]): string {
		return gaps.length === 0 ? "" : `; scoperto ${spansWords(gaps)}`;
	}

	/** «è festa (Immacolata Concezione) e siete chiusi», «siete chiusi (chiusura negli appuntamenti)». */
	function closedWords(day: string): string {
		const c = closedOn(hours(), day);
		if (c.holiday !== undefined) return `è festa (${c.holiday}) e siete chiusi`;
		if (c.open?.why === "closure") return "siete chiusi (la chiusura è nelle impostazioni degli appuntamenti)";
		return "siete chiusi";
	}

	function whoOn(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		const day = staffDay(args.date ?? "oggi", at.day, "nearest");
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		const d = dayOf(data(b), day);
		const when = capital(dayWords(day, at.day));
		const on = d.people.filter((p) => p.hours.length > 0);
		if (d.closed && on.length === 0) return { text: `${when} ${closedWords(day)}: non lavora nessuno. Se qualcuno lavora lo stesso, dimmi il suo turno di quel giorno.`, count: 0 };
		const off = d.people.filter((p) => p.off !== undefined);
		const gaps = coverageGaps(data(b), day);
		const head = `${when} ${on.length === 0 ? "non lavora nessuno" : `${n1(on.length, "lavora una persona", "lavorano # persone")}`}${off.length === 0 ? "" : `, ${n1(off.length, "una è assente", "# sono assenti")}`}${gapWords(gaps)}. Chi e quando è nel riquadro.`;
		return { text: [head, fencedStaff(d.people.filter((p) => p.hours.length > 0 || p.off !== undefined).map((p) => personDayRow(p, true)).join("\n") || "nessuno")].join("\n"), count: on.length };
	}

	function weekDays(args: Record<string, unknown>, at: Now): string[] | string {
		const day = args.date === undefined ? addDays(mondayOf(at.day), 7) : staffDay(args.date, at.day, "nearest");
		if (isAnswer(day)) return day.answer;
		const monday = mondayOf(day);
		return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
	}

	function shifts(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		if (b.people.length === 0) return { text: "Non ho ancora nessuno del personale: dimmi chi lavora con te, con il suo orario di solito.", count: 0 };
		const days = weekDays(args, at);
		if (typeof days === "string") return { text: days, count: 0 };
		const lines: string[] = [];
		const rows: string[] = [];
		let gapsAll = 0;
		for (const day of days) {
			const d = dayOf(data(b), day);
			const gaps = coverageGaps(data(b), day);
			gapsAll += gaps.length;
			const on = d.people.filter((p) => p.hours.length > 0).length;
			const off = d.people.filter((p) => p.off !== undefined).length;
			const closed = d.closed && on === 0;
			lines.push(`• ${capital(plainDay(day, at.day))}: ${closed ? "chiuso" : `${n1(on, "una persona al lavoro", "# persone al lavoro")}${off === 0 ? "" : `, ${n1(off, "un'assenza", "# assenze")}`}${gapWords(gaps)}`}`);
			if (!closed) rows.push(`${capital(plainDay(day, at.day))}: ${d.people.map((p) => personDayRow(p, true)).join("; ")}`);
		}
		const hoursNote = hours()?.week === undefined ? ["Non conosco gli orari di apertura (sono nelle impostazioni degli appuntamenti), quindi non vedo le ore scoperte."] : gapsAll > 0 ? ["Nelle ore scoperte il negozio è aperto e non c'è nessuno: vuoi cambiare un turno?"] : [];
		return { text: [`I turni dal ${italianDate(days[0] as string)} al ${italianDate(days[6] as string)}, dall'orario di solito meno le assenze e le chiusure:`, ...lines, "Chi e quando è nel riquadro.", fencedStaff(rows.join("\n")), ...hoursNote, "Se vuoi il file (PDF, Word o CSV), lo preparo in personale/: lì le assenze sono solo «assente», senza il perché."].join("\n"), count: days.length };
	}

	/** «Giulia Verdi: ferie, ne restano circa 12 giorni su 26 (5 in programma); permessi (ROL ed ex festività insieme), circa 68 ore su 72». */
	function balanceLine(p: Person, b: StaffBook, at: Now): string {
		const bal = balancesOf(p, b.absences, b.shifts, at.day, b.settings?.monthly === true, hours(), ruleOf(b));
		const basis = bal.fromOpening ? ` dal saldo del ${italianDate(p.opening?.day ?? at.day)}` : bal.months !== undefined ? ` (${bal.months} mesi su 12 in forza)` : bal.monthly ? " maturate fin qui" : "";
		const part = (x: Balance, n: (v: number) => string, unit: string, what: string, usedWord: string, missing: string) => {
			const used = [x.taken > 0 ? `${usedWord} ${n(x.taken)}` : undefined, x.planned > 0 ? `in programma ${n(x.planned)}` : undefined].filter((y) => y !== undefined);
			if (x.left === undefined) return `${what}: quante gliene spettano non me l'hai detto (${missing})${used.length === 0 ? "" : `; ${used.join(", ")} ${unit}`}`;
			return `${what}, ne restano circa ${n(x.left)} ${unit} su ${n(x.entitled ?? 0)}${basis}${used.length === 0 ? "" : ` (${used.join(", ")})`}`;
		};
		return `${p.name}: ${part(bal.ferie, decimalWords, "giorni", "ferie", "godute", "dimmi i giorni l'anno, o quanti gliene restano oggi")}; ${part(bal.permessi, hoursWords, "ore", "permessi (ROL ed ex festività insieme)", "usate", "dimmi le ore l'anno, o quante gliene restano oggi")}`;
	}

	function balance(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		let list = b.people.filter((p) => p.to === undefined || p.to >= `${at.day.slice(0, 4)}-01-01`);
		if (args.person !== undefined) {
			const w = personSaid(args.person, b.people);
			if (isAnswer(w)) return { text: w.answer, count: 0 };
			if (w.close === true) return { text: closeAsk(w.person), count: 0 };
			list = [w.person];
		}
		if (list.length === 0) return { text: "Non ho ancora nessuno del personale.", count: 0 };
		const how = b.settings?.monthly === true ? "maturazione mese per mese" : "saldo annuo, senza maturazione mensile";
		return { text: [`Ferie e permessi del ${at.day.slice(0, 4)}, nel riquadro: una stima (${how}; senza i residui degli anni prima, se non me li hai detti). Il dato ufficiale ce l'ha la consulente del lavoro.`, fencedStaff(list.map((p) => balanceLine(p, b, at)).join("\n"))].join("\n"), count: list.length };
	}

	function absences(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		let from = at.day;
		let to = addDays(at.day, 366);
		let label = "da oggi in poi";
		if (args.period !== undefined) {
			try {
				const p = readPeriod(String(args.period), at.day, { ahead: true });
				from = p.from;
				to = p.to;
				label = p.label;
			} catch (error) {
				if (error instanceof PeriodError) return { text: `Errore: ${error.message}.`, count: 0 };
				throw error;
			}
		}
		let list = b.absences.filter((a) => isActive(a) && a.from <= to && (a.to ?? "9999-12-31") >= from);
		if (args.person !== undefined) {
			const w = personSaid(args.person, b.people);
			if (isAnswer(w)) return { text: w.answer, count: 0 };
			list = list.filter((a) => a.person === w.person.id);
		}
		if (args.kind !== undefined && KINDS.includes(args.kind as AbsenceKind)) list = list.filter((a) => a.kind === args.kind);
		if (list.length === 0) return { text: `Nessuna assenza segnata, ${label}.`, count: 0 };
		list = [...list].sort((a, b2) => a.from.localeCompare(b2.from));
		return { text: [`${n1(list.length, "Un'assenza", "# assenze")}, ${label}: chi e quando nel riquadro.`, fencedStaff(list.slice(0, STAFF_LIMITS.shown).map((a) => absenceRow(a, b.people.find((p) => p.id === a.person), at.day)).join("\n"))].join("\n"), count: list.length };
	}

	function monthOf(args: Record<string, unknown>, at: Now): { from: string; label: string; month: string } | string {
		try {
			const p = readPeriod(String(args.month ?? "mese scorso"), at.day);
			if (p.kind !== "month") return "Errore: il riepilogo è di un mese: dimmi quale, come «ottobre».";
			if (p.from > at.day) return "Errore: quel mese non è ancora cominciato: il riepilogo si fa sui giorni passati.";
			const name = MONTH_NAMES[Number(p.from.slice(5, 7)) - 1] as string;
			return { from: p.from, label: p.label, month: p.from.slice(0, 4) === at.day.slice(0, 4) ? name : p.label };
		} catch (error) {
			if (error instanceof PeriodError) return `Errore: ${error.message}.`;
			throw error;
		}
	}

	const FOR_HER = "Il riepilogo ha dati sanitari (le malattie, con il protocollo): è solo per la consulente del lavoro, non per la bacheca né per altri.";

	function summary(args: Record<string, unknown>, b: StaffBook, at: Now): Answer {
		if (b.people.length === 0) return { text: "Non ho ancora nessuno del personale.", count: 0 };
		const m = monthOf(args, at);
		if (typeof m === "string") return { text: m, count: 0 };
		const months = monthDetail(data(b), b.extras, m.from, at.day, ruleOf(b));
		const open = monthEnd(m.from) > at.day;
		return {
			text: [
				`Il riepilogo di ${m.month} per la consulente è pronto, giorno per giorno: presenze dai turni previsti (non sono timbrature), ferie, permessi, malattie con il protocollo e le ore in più che mi hai detto.${open ? ` Il mese non è finito: arriva fino a oggi, ${plainDay(at.day, at.day)}.` : ""} Per persona, nel riquadro:`,
				fencedStaff(months.map(monthRow).join("\n") || "nessuno in forza nel mese"),
				FOR_HER,
				"Se vuoi, preparo il file (CSV e PDF, o Word) in personale/; poi, se me lo chiedi, la mail alla consulente con google_mail_send, che parte solo dopo la tua approvazione.",
			].join("\n"),
			count: months.length,
		};
	}

	async function exportFile(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		const what = args.what ?? "shifts";
		if (what !== "shifts" && what !== "summary") return { text: "Errore: il file è dei turni o del riepilogo del mese.", count: 0 };
		const format = args.format ?? "pdf";
		if (format !== "pdf" && format !== "docx" && format !== "csv") return { text: "Errore: il file è PDF, Word o CSV.", count: 0 };
		const refused = requirePersonFor(ctx, "preparo il file del personale");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (b.people.length === 0) return { text: "Non ho ancora nessuno del personale.", count: 0 };
		const business = hours()?.business;
		const files: { stem: string; ext: string; body: () => Promise<Uint8Array | string> }[] = [];
		if (what === "shifts") {
			const days = weekDays(args, at);
			if (typeof days === "string") return { text: days, count: 0 };
			const week = days.map((day) => ({ day, ...dayOf(data(b), day), gaps: coverageGaps(data(b), day) }));
			const stem = `personale/turni-dal-${days[0]}`;
			if (format === "csv") files.push({ stem, ext: ".csv", body: async () => shiftsCsv(week) });
			else files.push({ stem, ext: `.${format}`, body: async () => (await make({ format, text: shiftsMarkdown(week, business, at.day), name: "Turni", pictures: [], now: now().getTime() })).data });
		} else {
			const m = monthOf(args, at);
			if (typeof m === "string") return { text: m, count: 0 };
			const months = monthDetail(data(b), b.extras, m.from, at.day, ruleOf(b));
			const until = monthEnd(m.from) > at.day ? at.day : undefined;
			const stem = `personale/riepilogo-${m.from.slice(0, 7)}`;
			files.push({ stem, ext: ".csv", body: async () => monthCsv(months) });
			if (format !== "csv") files.push({ stem, ext: `.${format}`, body: async () => (await make({ format, text: monthMarkdown(months, m.label, business, until), name: "Riepilogo del personale", pictures: [], now: now().getTime() })).data });
		}
		try {
			const written: string[] = [];
			for (const [i, f] of files.entries()) {
				const path = await ctx.step(`path-${i}`, async () => freePath(workspace, f.stem, f.ext));
				written.push(await ctx.step(`write-${i}`, async () => (await workspace.write(path, await f.body())).path));
			}
			const mail = what === "summary" ? ` ${FOR_HER} Per mandarlo alla consulente posso preparare la mail con google_mail_send, con il file in allegato: parte solo dopo la tua approvazione.` : "";
			return { text: [`Ecco ${what === "summary" ? "il riepilogo del mese" : "i turni della settimana"}: ${written.length === 1 ? "il file è" : "i file sono"} nel riquadro. Non l'ho mandato a nessuno; se vuoi te lo mando qui con file_send.${mail}`, fencedStaff(written.join("\n"))].join("\n"), count: written.length };
		} catch (error) {
			if (error instanceof WorkspaceError || error instanceof DocumentError) return { text: `Errore: non sono riuscita a fare il file (${error.message}).`, count: 0 };
			throw error;
		}
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, b: StaffBook): Promise<Answer> {
		const words = (s: StaffSettings | undefined) => `Ferie e permessi: ${s?.monthly === true ? "maturano mese per mese" : "saldo annuo, senza maturazione mensile"}. Le ferie si contano su ${s?.ferieWeek === 6 ? "6 giorni a settimana (lun-sab)" : `5 giorni a settimana (lun-ven)${s?.ferieWeek === undefined ? ", se non mi dici altro" : ""}`}.`;
		if (args.monthly === undefined && args.ferie_week === undefined) return { text: words(b.settings), count: 0 };
		if (args.monthly !== undefined && typeof args.monthly !== "boolean") return { text: "Errore: la maturazione mensile è sì o no.", count: 0 };
		const week = args.ferie_week === undefined ? undefined : Number(args.ferie_week);
		if (week !== undefined && week !== 5 && week !== 6) return { text: "Errore: la settimana delle ferie è di 5 giorni (lun-ven) o di 6 (lun-sab).", count: 0 };
		const refused = requirePersonFor(ctx, "cambio le impostazioni del personale");
		if (refused !== undefined) return { text: refused, count: 0 };
		const by = marker(ctx);
		await ctx.step("settings", async () => {
			store.update(ctx.callId, (state) => {
				const monthly = args.monthly === undefined ? state.settings?.monthly === true : args.monthly === true;
				const ferieWeek = week ?? state.settings?.ferieWeek;
				return { ...state, settings: { ...(monthly ? { monthly: true as const } : {}), ...(ferieWeek === undefined ? {} : { ferieWeek: ferieWeek as 5 | 6 }), ...by } };
			});
			return true;
		});
		return { text: `Fatto, ho salvato. ${words(store.read().settings)}`, count: 1 };
	}

	/** The brief's line, once a day: who is off today and tomorrow, absences starting this week, tomorrow's gaps, never why; once ever, an open malattia of 3 days or more. */
	async function brief(ctx: ToolContext, b: StaffBook, at: Now): Promise<string> {
		if (b.people.length === 0) return BRIEF_NOTHING;
		const open = b.absences.filter((a) => isActive(a) && a.kind === "malattia" && a.to === undefined && daysBetween(a.from, at.day) >= 2 && b.people.some((p) => p.id === a.person));
		const said = await ctx.step("brief-claim", async () => store.claim(ctx.callId, at.day, ["day", ...open.map((a) => `once:open-${a.id}`)]));
		if (!said.includes("day")) return BRIEF_NOTHING;
		const ask = open.filter((a) => said.includes(`once:open-${a.id}`));
		const tomorrow = addDays(at.day, 1);
		const today = offOn(b, at.day);
		const next = offOn(b, tomorrow);
		const sunday = addDays(mondayOf(at.day), 6);
		const starting = b.absences.filter((a) => isActive(a) && a.from > tomorrow && a.from <= sunday && b.people.some((p) => p.id === a.person && employed(p, a.from)));
		const gaps = coverageGaps(data(b), tomorrow);
		if (today.length + next.length + starting.length + gaps.length + ask.length === 0) return BRIEF_NOTHING;
		const name = (id: string) => b.people.find((p) => p.id === id)?.name ?? "?";
		const rows = [
			...today.map((p) => `Oggi: ${personDayRow(p, false)}`),
			...next.map((p) => `Domani: ${personDayRow(p, false)}`),
			...starting.map((a) => `In settimana: ${name(a.person)}: ${absenceWords({ ...a, kind: "altro" }, at.day)}`),
			// Never «malattia» here: the brief may be read by anyone near the owner. The protocol is asked in the owner's chat, when they answer.
			...ask.map((a) => `${name(a.person)} è assente da ${plainDay(a.from, at.day)}, fine non detta: sai fino a quando?`),
		];
		const parts = [
			...(today.length === 0 ? [] : [`oggi ${n1(today.length, "un assente", "# assenti")}`]),
			...(next.length === 0 ? [] : [`domani ${n1(next.length, "un assente", "# assenti")}`]),
			...(starting.length === 0 ? [] : [`${n1(starting.length, "un'assenza comincia", "# assenze cominciano")} più avanti in settimana`]),
			...(gaps.length === 0 ? [] : [`domani scoperto ${spansWords(gaps)}`]),
			...(ask.length === 0 ? [] : [n1(ask.length, "una domanda su un'assenza senza fine", "# domande su assenze senza fine")]),
		];
		await audit(ctx, "brief", rows.length);
		return [`Personale: ${parts.join("; ")}.`, ...(rows.length === 0 ? [] : [fencedStaff(rows.join("\n"))])].join("\n");
	}

	async function run(op: StaffOp, args: Record<string, unknown>, ctx: ToolContext, b: StaffBook, at: Now): Promise<Answer> {
		switch (op) {
			case "person":
				return people.person(args, ctx, b, at);
			case "archive":
				return people.archive(args, ctx, b, at);
			case "delete":
				return people.remove(args, ctx, b);
			case "absence":
				return absence(args, ctx, b, at);
			case "change":
				return change(args, ctx, b, at, false);
			case "cancel":
				return change(args, ctx, b, at, true);
			case "extra":
				return extra(args, ctx, b, at);
			case "shift":
				return shift(args, ctx, b, at);
			case "who":
				return whoOn(args, b, at);
			case "shifts":
				return shifts(args, b, at);
			case "balance":
				return balance(args, b, at);
			case "absences":
				return absences(args, b, at);
			case "summary":
				return summary(args, b, at);
			case "export":
				return exportFile(args, ctx, b, at);
			case "settings":
				return settings(args, ctx, b);
		}
	}

	return [
		{
			name: "staff",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...STAFF_OPS] },
					person: text(STAFF_LIMITS.name, "the person as said (a name, a first name), or PE-0001; person: the name of a new one (a first name is enough to start)"),
					name: text(STAFF_LIMITS.name, "person: a new full name (the surname said later)"),
					new: { type: "boolean", description: "person: a new person, even if the name is like another's" },
					past: { type: "boolean", description: "absence: ferie or a permesso already taken, said without the year on days more than a week ago (after Owni asked)" },
					kind: { type: "string", enum: [...KINDS], description: "absence: ferie, permesso, malattia, altro (with reason); absences: only this kind" },
					from: text(40, "absence, change: the first day («domani», «3 agosto», «da oggi», «lunedì scorso»); permesso: its day; person: the first day of work; archive: the first day no longer at work"),
					to: text(40, "absence, change: the last day (a malattia only when said); person, archive: the last day of work"),
					half: { type: "string", enum: [...HALVES], description: "absence: ferie of half a day" },
					start: text(20, "absence permesso (or altro by the hour, as L.104): from what time («15»)"),
					end: text(20, "absence permesso or altro: to what time (default the end of the shift)"),
					protocol: text(60, "absence malattia: the INPS certificate's protocol number only (digits), when said; never a diagnosis"),
					reason: text(60, `absence altro: one of ${ALTRO_REASONS.join(", ")} («malattia del figlio» is congedo malattia figlio)`),
					note: text(STAFF_LIMITS.note, "extra, shift: a short note, a few words; never health data. Absences take no note"),
					absence: text(10, "change, cancel: the reference AS-0001 (never said to the person)"),
					on: text(40, "change, cancel: a day of the absence"),
					date: text(40, "who: the day (default today); shifts, export: a day of the week (default next week); shift: the day; extra: the day (default today)"),
					hours: { type: ["string", "number"], description: "extra: how many hours («2», «1,5», «45 minuti»); shift: the day's hours («9-13 e 15-19», «riposo»)" },
					period: text(40, "absences: «agosto», «questo mese»; default from today on"),
					month: text(40, "summary, export summary: the month («ottobre»; default last month)"),
					what: { type: "string", enum: ["shifts", "summary"], description: "export: the week of shifts, or the month's summary" },
					format: { type: "string", enum: ["pdf", "docx", "csv"], description: "export: the file (summary: the CSV always, plus PDF or Word)" },
					role: text(STAFF_LIMITS.role, "person: a short job title («commessa»)"),
					weekly_hours: { type: ["string", "number"], description: "person: contract hours a week" },
					week: text(200, "person: the usual hours in one line («lun-ven 9-13 e 14-18; sab 9-13»), or as said («mattina»: Owni asks)"),
					ferie_days: { type: ["string", "number"], description: "person: ferie days a year" },
					rol_hours: { type: ["string", "number"], description: "person: permessi (ROL and ex festività) hours a year" },
					ferie_left: { type: ["string", "number"], description: "person: ferie days left, as the owner says" },
					rol_left: { type: ["string", "number"], description: "person: permessi hours left, as the owner says" },
					as_of: text(40, "person: the day of that balance (default today)"),
					resource: text(STAFF_LIMITS.resource, "person: the resource of the appointments this person is («nessuna» to take it off)"),
					monthly: { type: "boolean", description: "settings: ferie and permessi accrue month by month" },
					ferie_week: { type: "integer", enum: [5, 6], description: "settings: the days a week ferie are counted on" },
					confirm: { type: "boolean", description: "delete, absence (a malattia in the ferie): after the person's yes to the proposal" },
					check: text(16, "delete, absence: the check the proposal gave"),
					compact: { type: "boolean", description: "who: the brief's line only" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!STAFF_OPS.includes(args.op as StaffOp)) return "Errore: non conosco questa operazione sul personale.";
				const op = args.op as StaffOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				const at = localNow(timeZone, now());
				try {
					const b = store.read();
					if (b.broken) return op === "who" && args.compact === true ? BRIEF_BROKEN : `Errore: ${STAFF_BROKEN}.`;
					// Staff data: another agente gets counts only, never names or kinds.
					if (isAgentTurn(ctx)) return agentCounts(b, at);
					if (op === "who" && args.compact === true) return await brief(ctx, b, at);
					const answer = await run(op, args, ctx, b, at);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof StaffError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}
