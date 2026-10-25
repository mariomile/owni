/**
 * The tool `appointments`: gli appuntamenti of a service business (parrucchiere, estetista,
 * studio, officina, consulente). Booked when the business is open, inside its hours, not over
 * another appointment of the same resource: on a clash the nearest free times are proposed and
 * nothing is booked, unless the person says «fissalo lo stesso» (force); a client or a service only
 * close to what was said, or a service whose duration is not known (30 minutes taken), is proposed
 * with a check first. Moved, disdetto, non presentato and fatto only on the person's own word, with
 * a check when the client is only close to the name said; nothing is deleted. The free times, the
 * day or the week, a client's history, the messages for the clients (reminders and confirmations,
 * with a WhatsApp link: never sent by Owni), the settings, the CSV. The brief's line once a day.
 * Billing is sales_invoices' (sales-appointments.ts). Another agente gets counts only; the audit
 * only the op and a count. Clients, services, notes, contacts, links: in the fence.
 */
import { createHash } from "node:crypto";
import { type Appointment, APPOINTMENT_LIMITS, AppointmentError, type AppointmentSettings, appointmentId, type BookedService, clockOf, DEFAULT_MINUTES, DEFAULT_SLOT, endOf, minutesOf, timeOf } from "../appointments.ts";
import { type Block, fits, type Fit, type FitInput, freeSlots, gapsOf, localNow, nearestFree, openOn, type Span } from "../appointment-slots.ts";
import { APPOINTMENTS_BROKEN, type AppointmentBook, type AppointmentStore } from "../appointment-store.ts";
import type { ClientStore } from "../client-store.ts";
import type { OwniTool, ToolContext } from "../engine.ts";
import { n1 } from "../format-words.ts";
import { addDays, daysBetween, weekdayOf } from "../italian-calendar.ts";
import { italianLongDate, italianWeekday } from "../italian-format.ts";
import type { Marker } from "../marker.ts";
import { spellingKey } from "../name-keys.ts";
import type { PriceListStore } from "../price-list-store.ts";
import { cleanText, isProblem } from "../text-input.ts";
import { isAgentTurn, requirePersonFor } from "../turn-origin.ts";
import { freePath, type Workspace, WorkspaceError } from "../workspace.ts";
import { appointmentNamed, clientSaid, daySaid, isAnswer, isWeekdayWord, minutesSaid, type Named, resourceSaid, servicesSaid, timeOnDay, timeSaid, windowSaid } from "./appointment-input.ts";
import { appointmentRow, appointmentsCsv, closedWords, dayWords, durationWords, fencedAppointments, mobileOf, reminderText, servicesWords, shortDay, spanWords, waLink, whenWords } from "./appointment-render.ts";
import { settingsSaid, settingsWords } from "./appointment-settings.ts";

export const APPOINTMENT_OPS = ["book", "move", "cancel", "no_show", "done", "free_slots", "agenda", "history", "reminders", "settings", "export"] as const;
export type AppointmentOp = (typeof APPOINTMENT_OPS)[number];

/** What was done, for the audit: the op and how many, never clients, services or times. */
export type AppointmentEvent = { readonly type: "appointments.used"; readonly op: AppointmentOp | "brief"; readonly count: number };

export type AppointmentToolsOptions = {
	readonly workspace: Workspace;
	readonly store: AppointmentStore;
	readonly clients?: Pick<ClientStore, "read">;
	readonly priceList?: Pick<PriceListStore, "read">;
	/** The business's time zone (Europe/Rome): today, and the hour already gone. */
	readonly timeZone: string;
	/** Google Calendar can be written here (google_calendar_create): only then it is offered. */
	readonly calendar?: boolean;
	readonly whoIs: (thread: { channel: string; threadId: string }) => string | undefined;
	readonly record?: (event: AppointmentEvent) => Promise<void>;
	/** What the staff blocks of the resources on a day (il personale: absences, time off the shift): never forced. */
	readonly absences?: (day: string) => readonly Block[];
	/** Whether the staff's file does not read: a booking says so, once, since then no absence is seen. */
	readonly staffBroken?: () => boolean;
	/** Tests: the clock. */
	readonly now?: () => Date;
};

const DESCRIPTION = [
	"Gli appuntamenti dei clienti di un'attività di servizi (parrucchiere, estetista, studio, officina, consulente); i promemoria ai clienti per domani sono appointments reminders, non schedule_create; le scadenze fiscali sono fiscal_agenda; «cosa ho domani?» è appointments agenda, più google_calendar_events se ha il calendario Google; «chiudo per ferie» è appointments settings; fatturarli è sales_invoices: chi viene, per cosa, quando, con quale risorsa (una persona, una poltrona, un ponte). Not the fiscal deadlines (fiscal_agenda), not the board's scadenze, not Owni's own reminders (schedule_create), not the person's Google calendar (google_calendar_events).",
	"What the person says → op: «fissa la signora Rossi giovedì alle 15 per taglio e piega» → book with client as said (the title too), services [as said], date, time as said («15», «15:30», «alle 3 e mezza», «mezzogiorno»: Owni reads morning or afternoon from the opening hours, or asks); resource, notes, minutes when said. When Owni is not sure of the client, of a service, or does not know how long a service lasts, book shows the proposal with a check: show it, and only after the person's yes repeat with confirm true and that check. On a clash, out of hours or closed, book books nothing and gives the nearest free times: offer those; only when the person says «fissalo lo stesso» repeat with force true and force_check (the check the refusal gave). After a booking, offer the confirmation message (reminders with client, date and confirmation true).",
	"«sposta Rossi a venerdì stessa ora» → move with client and date (time only when said: otherwise the same); «Rossi ha disdetto» → cancel; «Rossi non si è presentata» → no_show; «Rossi è fatta», «tutti fatti» (yesterday's too, with date) → done (all true with date); these only on the person's own word, and with confirm and check when Owni asks «intendi questo appuntamento?». «quando ho un'ora libera giovedì pomeriggio?» → free_slots with date, window, minutes (or services); «cosa ho domani?», «la settimana» → agenda with date (week true); if the person also has Google Calendar, add their own events (google_calendar_events); into their Google calendar only when they ask, with google_calendar_create. «com'è andata con Rossi?», «cosa fa di solito Bianchi?» → history with client.",
	"«fammi i promemoria per domani», «fammi il messaggio di promemoria per gli appuntamenti di domani» are the messages to the clients → reminders (date default tomorrow), not Owni's own reminders (schedule_create): the texts, the WhatsApp links for the mobiles and the emails from the cards are in the fence; Owni never sends them: the person taps the link and sends, or for an email offer google_mail_send (it asks its approval). «fattura gli appuntamenti fatti da Bianchi questo mese» is sales_invoices (draft with customer, appointments true, period), not this tool.",
	"settings: «siamo aperti mar-sab 9-13 e 14:30-19, chiusi domenica e lunedì» → hours as that one line (or [{days, open}]); «chiusi dal 10 al 20 agosto per ferie» → closure_from, closure_to, closure_note; «il taglio dura 30 minuti, il colore un'ora e mezza» → services [{name, minutes}]; «le poltrone sono Marco e Giulia» → resources; «il salone si chiama Salone Anna» → business; «aperti anche nei festivi» → holidays_open; «gli appuntamenti ogni mezz'ora» → slot. «fammi il file degli appuntamenti» → export, then file_send. summary of the brief: agenda with compact true.",
	"Never say an appointment's reference (AP-…) to the person: name it by its client and time.",
].join(" ");

const AGENT_REFUSAL = "Gli appuntamenti dicono clienti, servizi e orari: a un altro agente do solo quanti sono. Li fissa e li cambia chi ti scrive, nella sua conversazione.";
const BRIEF_NOTHING = "Appuntamenti: niente da segnalare.";
const BRIEF_BROKEN = "Appuntamenti: il file non si legge, guarda il runbook.";
const FORCE_OFFER = "Se vuoi fissarlo lo stesso, dimmi «fissalo lo stesso».";
const STAFF_BROKEN = "Attenzione: il file del personale non si legge, quindi non so se chi fa l'appuntamento è assente o di riposo.";
const HOURS_NOTE = "Non conosco ancora gli orari di apertura, quindi non ho controllato che tu sia aperto: dimmeli in una riga, come «mar-sab 9-13 e 14-19, chiuso domenica e lunedì».";
const READ_OPS: readonly AppointmentOp[] = ["agenda", "free_slots", "history", "reminders"];
const ORDINALS = ["prima", "seconda", "terza", "quarta", "quinta", "sesta", "settima", "ottava", "nona", "decima"];

type Answer = { text: string; count: number };
type Now = { readonly day: string; readonly minutes: number };

/** A booking as proposed: what the check is given on. */
type Proposed = { readonly client: Appointment["client"]; readonly services: readonly BookedService[]; readonly day: string; readonly start: string; readonly minutes: number; readonly resource?: string; readonly notes?: string; readonly force?: true };

const capital = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
const clientKey = (c: Appointment["client"]) => c.card ?? `n:${spellingKey(c.name)}`;
const byTime = (a: Appointment, b: Appointment) => a.day.localeCompare(b.day) || minutesOf(a.start) - minutesOf(b.start);
const started = (a: Appointment, now: Now) => a.day < now.day || (a.day === now.day && minutesOf(a.start) <= now.minutes);
const dateOnly = (day: string) => italianLongDate(day).replace(/ \d{4}$/, "");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const orList = (items: readonly string[]) => (items.length === 1 ? (items[0] as string) : `${items.slice(0, -1).join(", ")} o ${items.at(-1) as string}`);
const andList = (items: readonly string[]) => (items.length === 1 ? (items[0] as string) : `${items.slice(0, -1).join(", ")} e ${items.at(-1) as string}`);

/** The services with the duration said: one takes it all; with more, the last takes what the others leave. */
function withMinutes(services: readonly BookedService[], total: number): BookedService[] | string {
	if (services.length === 1) return [{ ...(services[0] as BookedService), minutes: total }];
	const before = services.slice(0, -1).reduce((n, s) => n + s.minutes, 0);
	if (total - before < 5) return "Errore: con più servizi, la durata detta è meno di quanto durano gli altri: dimmi la durata di tutto l'appuntamento, o fissali a parte.";
	return [...services.slice(0, -1), { ...(services.at(-1) as BookedService), minutes: total - before }];
}

/** «Orari liberi vicini: giovedì 22 alle 14:45, alle 15:30 o alle 16; venerdì 23 alle 9. Quale preferisci?»; with resources, each one's in the fence. */
function proposalsText(list: readonly { day: string; start: number; resource?: string }[], today: string): string[] {
	if (list.length === 0) return ["Nei prossimi 14 giorni non trovo un orario libero così: dimmi un altro giorno."];
	const days = [...new Set(list.map((p) => p.day))].sort();
	const parts = days.map((d) => `${shortDay(d, today)} ${orList(list.filter((p) => p.day === d).map((p) => p.start).sort((a, b) => a - b).map((t) => `alle ${clockOf(t)}`))}`);
	const out = [`Orari liberi vicini: ${parts.join("; ")}. Quale preferisci?`];
	if (list.some((p) => p.resource !== undefined)) out.push("Con chi, nel riquadro:", fencedAppointments(list.map((p) => `• ${shortDay(p.day, today)} alle ${clockOf(p.start)}: ${p.resource ?? ""}`).join("\n")));
	return out;
}

/** «dalle 14 alle 17:30 (c'è posto per un'ora fino alle 16:30) e dalle 18 alle 19»: the free windows a run of start times makes. */
function windowsWords(starts: readonly number[], step: number, minutes: number): string {
	const runs: [number, number][] = [];
	for (const s of [...starts].sort((a, b) => a - b)) {
		const last = runs.at(-1);
		if (last !== undefined && s - last[1] === step) last[1] = s;
		else runs.push([s, s]);
	}
	return andList(runs.map(([a, b]) => `dalle ${clockOf(a)} alle ${clockOf(b + minutes)}${b > a ? ` (c'è posto per ${durationWords(minutes)} fino alle ${clockOf(b)})` : ""}`));
}

/** «Libero: 9-10, 11-13»; with resources, each one's in the fence. */
function gapsWords(settings: AppointmentSettings | undefined, appointments: readonly Appointment[], day: string, after: number): string[] {
	const keep = (g: Span) => g.to > after;
	const resources = settings?.resources ?? [];
	const clip = (g: Span): Span => ({ from: Math.max(g.from, Math.ceil(after / (settings?.slot ?? DEFAULT_SLOT)) * (settings?.slot ?? DEFAULT_SLOT)), to: g.to });
	if (resources.length === 0) {
		const gaps = gapsOf(settings, appointments, day).filter(keep).map(clip).filter((g) => g.to > g.from);
		return gaps.length === 0 ? [] : [`Libero: ${gaps.map(spanWords).join(", ")}.`];
	}
	const rows = resources.flatMap((r) => {
		const gaps = gapsOf(settings, appointments, day, r).filter(keep).map(clip).filter((g) => g.to > g.from);
		return gaps.length === 0 ? [] : [`${r} ${gaps.map(spanWords).join(", ")}`];
	});
	return rows.length === 0 ? [] : ["Libero per risorsa, nel riquadro.", fencedAppointments(`Libero: ${rows.join("; ")}`)];
}

export function createAppointmentTools(options: AppointmentToolsOptions): OwniTool[] {
	const { store, workspace, timeZone } = options;
	const now = options.now ?? (() => new Date());
	const who = (ctx: ToolContext) => (ctx.thread === undefined ? "owni" : (options.whoIs(ctx.thread) ?? `${ctx.thread.channel}:${ctx.thread.threadId}`));
	const marker = (ctx: ToolContext): Marker => ({ by: who(ctx), at: now().toISOString() });
	const audit = async (ctx: ToolContext, op: AppointmentEvent["op"], count: number) => {
		await ctx.step(`audit-${op}`, async () => {
			await options.record?.({ type: "appointments.used", op, count });
			return true;
		});
	};
	const text = (max: number, description: string) => ({ type: "string", maxLength: max, description });
	const cards = () => {
		const b = options.clients?.read();
		return b === undefined || b.broken ? [] : b.cards;
	};
	const voci = () => {
		const b = options.priceList?.read();
		return b === undefined || b.broken ? [] : b.items;
	};
	const blocked = options.absences === undefined ? {} : { blocked: options.absences };
	const checkOf = (p: Proposed) => hash([p.client, p.services, p.day, p.start, p.minutes, p.resource ?? "", p.notes ?? "", p.force === true]);

	/** The client's «non presentato», oldest first. */
	const noShows = (b: AppointmentBook, c: Appointment["client"]) => b.appointments.filter((a) => clientKey(a.client) === clientKey(c) && a.status === "no_show").sort(byTime);

	/** The day and time said, read on the day: a bare weekday that is today with the time gone means next week, said. */
	function whenSaid(args: Record<string, unknown>, settings: AppointmentSettings | undefined, at: Now, fallbackDay?: string, fallbackStart?: number): { day: string; minutes: number; notes: string[] } | string {
		const day0 = args.date === undefined ? fallbackDay : daySaid(args.date, at.day);
		if (day0 === undefined) return "Errore: dimmi il giorno dell'appuntamento. Per vedere quando è libero, chiedimi gli orari liberi.";
		if (isAnswer(day0)) return day0.answer;
		if (args.time === undefined && fallbackStart === undefined) return "Errore: dimmi a che ora. Per vedere quando è libero, chiedimi gli orari liberi.";
		const t = args.time === undefined ? undefined : timeSaid(args.time);
		if (t !== undefined && isAnswer(t)) return t.answer;
		const read = (day: string) => (t === undefined ? { minutes: fallbackStart as number } : timeOnDay(t, settings, day));
		let day = day0;
		let r = read(day);
		if (isAnswer(r)) return r.answer;
		const notes: string[] = [];
		if (isWeekdayWord(args.date) && day === at.day && r.minutes < at.minutes) {
			day = addDays(day, 7);
			r = read(day);
			if (isAnswer(r)) return r.answer;
			const wd = italianWeekday(day);
			notes.push(`${capital(wd)} l'ho inteso come ${wd} ${wd === "domenica" ? "prossima" : "prossimo"}, ${dateOnly(day)}: oggi alle ${clockOf(r.minutes)} è già passato.`);
		}
		if (r.note !== undefined) notes.push(r.note);
		return { day, minutes: r.minutes, notes };
	}

	/**
	 * The resource's person is not there (absent, of rest, off the shift, not on the staff): never
	 * forced, no «fissalo lo stesso», and never why. Another resource at the same hour first, then
	 * the same resource's nearest times.
	 */
	function absentRefusal(fit: Exclude<Fit, { ok: true }>, input: FitInput, today: string, verb: string): string {
		const blk = fit.block;
		const when = shortDay(input.day, today);
		const span = blk === undefined ? "" : blk.from > 0 && blk.to < 24 * 60 ? ` dalle ${clockOf(blk.from)} alle ${clockOf(blk.to)}` : blk.from > 0 ? ` dalle ${clockOf(blk.from)}` : blk.to < 24 * 60 ? ` fino alle ${clockOf(blk.to)}` : "";
		const head =
			blk?.why === "rest"
				? `${weekdayOf(input.day) === 0 ? "La" : "Il"} ${italianWeekday(input.day)} la risorsa nel riquadro è di riposo`
				: blk?.why === "out"
					? `${capital(when)} la risorsa nel riquadro non è nel personale`
					: blk?.why === "off"
						? `${capital(when)}${span} la risorsa nel riquadro non è di turno`
						: `${capital(when)}${span} la risorsa nel riquadro non c'è`;
		const proposals: { day: string; start: number; resource?: string }[] = [];
		if (input.resource !== undefined) {
			const other = fits({ ...input, resource: undefined, force: false });
			if (other.ok && other.resource !== undefined && other.resource.toLowerCase() !== input.resource.toLowerCase()) proposals.push({ day: input.day, start: input.start, resource: other.resource });
		}
		proposals.push(...nearestFree({ ...input, force: false }, APPOINTMENT_LIMITS.proposals - proposals.length));
		const after = blk?.why === "rest" || blk?.why === "off" ? "Se invece quel giorno lavora, segna il suo turno nel personale." : blk?.why === "out" ? "Se lavora con voi, aggiorna le sue date nel personale." : "Se invece ci sarà, annulla prima la sua assenza nel personale.";
		return [`${head}: con questa risorsa ${verb}.`, ...(fit.resource === undefined ? [] : [fencedAppointments(fit.resource)]), ...proposalsText(proposals, today), after].join("\n");
	}

	/** Why it does not fit, and the nearest free times: nothing is booked (or moved). */
	function refusal(fit: Exclude<Fit, { ok: true }>, input: FitInput, b: AppointmentBook, today: string, verb: string, forceCheck?: string): string {
		if (fit.why === "past") return "Quell'ora è già passata: dimmi un altro giorno o un'altra ora.";
		if (fit.why === "absent") return absentRefusal(fit, input, today, verb);
		const open = fit.open ?? openOn(input.settings, input.day);
		const lines: string[] = [];
		if (fit.why === "closed") lines.push(`${capital(closedWords(open, input.day))}: ${verb}.`);
		else if (fit.why === "outside" && fit.room !== undefined) {
			const end = input.start + input.minutes;
			lines.push(`Alle ${clockOf(input.start)} c'è posto solo fino alle ${clockOf(fit.room.until)}: l'appuntamento dura ${durationWords(input.minutes)} e finirebbe alle ${clockOf(end)}, ${fit.room.pause ? "nella pausa" : "dopo la chiusura"}. ${capital(verb)}.`);
		} else if (fit.why === "outside") lines.push(`A quell'ora sei chiuso (${shortDay(input.day, today)} sei aperto ${open.spans.map(spanWords).join(" e ")}): ${verb}.`);
		else {
			const other = b.appointments.find((a) => a.id === fit.with);
			const many = (input.settings?.resources ?? []).length > 0;
			lines.push(`A quell'ora c'è già un appuntamento${many ? " per ogni risorsa che può farlo" : ""}${other === undefined ? "" : `, dalle ${clockOf(minutesOf(other.start))} alle ${clockOf(minutesOf(other.start) + other.minutes)} (chi è nel riquadro)`}: ${verb}.`);
			if (other !== undefined) lines.push(fencedAppointments(appointmentRow(other)));
		}
		return [
			...lines,
			...proposalsText(nearestFree({ ...input, force: false }), today),
			fit.why === "overlap" ? "Se vuoi sovrapporlo, dimmi «fissalo lo stesso»." : FORCE_OFFER,
			...(forceCheck === undefined ? [] : [`Solo se chi ti scrive dice «fissalo lo stesso», ripeti con fissalo lo stesso e il controllo ${forceCheck}.`]),
		].join("\n");
	}

	/** The check a refusal gives, bound to what was refused and why: «fissalo lo stesso» only after it was shown. */
	const forceCheckOf = (what: unknown, fit: Exclude<Fit, { ok: true }>) => hash(["force", what, fit.why, fit.with ?? ""]);

	/** «fissalo lo stesso»: the fit without force; a refusal (or a check that does not match) stops it. */
	function forced(input: FitInput, args: Record<string, unknown>, what: unknown, b: AppointmentBook, today: string, verb: string): Fit | string {
		const plain = fits({ ...input, force: false });
		if (plain.ok || input.force !== true || plain.why === "past" || plain.why === "absent") return plain;
		const check = forceCheckOf(what, plain);
		const given = typeof args.force_check === "string" ? args.force_check.trim().toLowerCase() : "";
		if (given === check) return fits(input);
		return [`Errore: lo fisso lo stesso solo dopo aver mostrato perché non si può: ${verb}.`, refusal(plain, input, b, today, verb, check)].join("\n");
	}

	/** The check on an appointment named by a name only close to the client's: «intendi questo appuntamento?». */
	function closeCheck(op: string, named: Named, args: Record<string, unknown>, extra: unknown, today: string): string | undefined {
		if (named.close !== true) return undefined;
		const a = named.appointment;
		const check = hash([op, a.id, a.day, a.start, a.status, extra]);
		const ask = ["Intendi questo appuntamento? Il cliente non si chiama esattamente come è stato detto: è nel riquadro.", fencedAppointments(appointmentRow(a, true)), `${capital(whenWords(a.day, a.start, today))}. Se chi ti scrive dice di sì, ripeti con la conferma e il controllo ${check}.`].join("\n");
		if (args.confirm !== true) return ask;
		const given = typeof args.check === "string" ? args.check.trim().toLowerCase() : "";
		if (given !== check) return `Errore: il controllo non torna: non ho cambiato niente.\n${ask}`;
		return undefined;
	}

	function bookedAnswer(a: Appointment, b: AppointmentBook, today: string, notes: readonly string[]): string {
		const missed = noShows(b, a.client);
		const last = missed.at(-1);
		return [
			`Fatto: ho fissato l'appuntamento ${dayWords(a.day, today)} dalle ${clockOf(minutesOf(a.start))} alle ${clockOf(minutesOf(a.start) + a.minutes)}. Chi e per cosa è nel riquadro.`,
			fencedAppointments([appointmentRow(a), ...(options.calendar === true ? [`Per il calendario: inizio ${a.day}T${a.start}, fine ${a.day}T${endOf(a)} (${timeZone})`] : [])].join("\n")),
			...notes,
			...(missed.length >= 3 && last !== undefined ? [`Attenzione: questo cliente non si è presentato ${missed.length} volte (l'ultima il ${dateOnly(last.day)}).`] : []),
			"Vuoi mandare al cliente un messaggio di conferma? Lo preparo io, con il link per WhatsApp se ha il cellulare nella scheda.",
			...(options.calendar === true ? ["Se lo vuoi anche nel tuo calendario Google, lo aggiungo con google_calendar_create (inizio e fine nel riquadro)."] : []),
		].join("\n");
	}

	/**
	 * Said once a day (claimed together: a call claims once, so one claim for both), on a call that
	 * books or moves: the missing opening hours (only on a booking), the staff file not read.
	 */
	async function onceNotes(ctx: ToolContext, settings: AppointmentSettings | undefined, today: string, booking: boolean): Promise<string[]> {
		const wanted = [...(booking && settings?.week === undefined ? ["hours"] : []), ...(options.staffBroken?.() === true ? ["staff-broken"] : [])];
		if (wanted.length === 0) return [];
		const said = await ctx.step("once-notes", async () => store.claim(ctx.callId, today, wanted));
		return [...(said.includes("hours") ? [HOURS_NOTE] : []), ...(said.includes("staff-broken") ? [STAFF_BROKEN] : [])];
	}

	async function book(args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const today = at.day;
		// The same call again: the appointment it booked, before anything is checked again.
		const mine = b.appointments.find((a) => a.callId === ctx.callId);
		if (mine !== undefined) return { text: bookedAnswer(mine, b, today, []), count: 1 };
		const settings = b.settings;
		if (args.force !== undefined && typeof args.force !== "boolean") return { text: "Errore: fissalo lo stesso è sì o no.", count: 0 };
		const force = args.force === true;
		if (force) {
			const refused = requirePersonFor(ctx, "fisso l'appuntamento sovrapposto o fuori orario");
			if (refused !== undefined) return { text: refused, count: 0 };
		}
		const client = clientSaid(args.client, cards(), b.appointments);
		if (isAnswer(client)) return { text: client.answer, count: 0 };
		const sv = servicesSaid(args.services, settings, voci());
		if (isAnswer(sv)) return { text: sv.answer, count: 0 };
		const said = minutesSaid(args.minutes);
		if (isAnswer(said)) return { text: said.answer, count: 0 };
		let services: readonly BookedService[] = sv.services;
		let assumed = sv.assumed;
		if (said !== undefined) {
			const w = withMinutes(services, said);
			if (typeof w === "string") return { text: w, count: 0 };
			services = w;
			assumed = [];
		}
		const minutes = services.reduce((n, s) => n + s.minutes, 0);
		const when = whenSaid(args, settings, at);
		if (typeof when === "string") return { text: when, count: 0 };
		const { day } = when;
		const resource = resourceSaid(args.resource, settings);
		if (isAnswer(resource)) return { text: resource.answer, count: 0 };
		const notes = cleanText(args.notes, APPOINTMENT_LIMITS.notes, "le note", true);
		if (isProblem(notes)) return { text: `Errore: ${notes.problem}.`, count: 0 };
		if (when.minutes + minutes > 24 * 60) return { text: "Errore: l'appuntamento finirebbe dopo mezzanotte: dimmi un'ora prima.", count: 0 };
		const input: FitInput = { settings, appointments: b.appointments, day, start: when.minutes, minutes, ...(resource === undefined ? {} : { resource }), ...(sv.needs === undefined ? {} : { needs: sv.needs }), now: at, force, ...blocked };
		const what = ["book", client.client, services, day, when.minutes, minutes, resource ?? ""];
		const fit = forced(input, args, what, b, today, "non ho fissato niente");
		if (typeof fit === "string") return { text: [fit, ...when.notes].join("\n"), count: 0 };
		if (!fit.ok) return { text: [refusal(fit, input, b, today, "non ho fissato niente", fit.why === "past" ? undefined : forceCheckOf(what, fit)), ...when.notes].join("\n"), count: 0 };
		const p: Proposed = { client: client.client, services, day, start: timeOf(when.minutes), minutes, ...(fit.resource === undefined ? {} : { resource: fit.resource }), ...(notes === undefined ? {} : { notes }), ...(force ? { force: true as const } : {}) };
		const why: string[] = [];
		if (client.close === true) why.push("il cliente l'ho preso dalla scheda con il nome più vicino a come è stato detto");
		if (sv.guess.length > 0) why.push(n1(sv.guess.length, "un servizio l'ho preso dalla voce del listino più vicina a come è stato detto", "# servizi li ho presi dalle voci del listino più vicine a come sono stati detti"));
		if (assumed.length > 0) why.push(`non so quanto ${n1(assumed.length, "dura un servizio: ho contato", "durano # servizi: ho contato")} ${DEFAULT_MINUTES} minuti (si può dire la durata, e la salvo per le prossime volte)`);
		if (why.length > 0 && args.confirm !== true) {
			const preview: Appointment = { id: "AP-0000", status: "booked", ...p, callId: "x", by: "x", at: "x" };
			return {
				text: [`Fisserei questo appuntamento, ${dayWords(day, today)} dalle ${clockOf(when.minutes)} alle ${clockOf(when.minutes + minutes)}, come nel riquadro. Controlla con chi ti scrive: ${why.join("; ")}.`, fencedAppointments(appointmentRow(preview).replace(/ \(rif\. AP-0000\)$/, "")), ...when.notes, `Va bene così? Se chi ti scrive dice di sì, ripeti con la conferma e il controllo ${checkOf(p)}.`].join("\n"),
				count: 0,
			};
		}
		const refused = requirePersonFor(ctx, "fisso l'appuntamento");
		if (refused !== undefined) return { text: refused, count: 0 };
		if (why.length > 0) {
			const check = typeof args.check === "string" ? args.check.trim().toLowerCase() : undefined;
			if (check === undefined || !/^[0-9a-f]{16}$/.test(check)) return { text: "Errore: per fissare l'appuntamento serve il controllo della proposta: chiedi prima la proposta, mostrala a chi ti scrive e, con il suo sì, ripeti con il controllo che ti ho dato.", count: 0 };
			if (checkOf(p) !== check) return { text: "Errore: la proposta è cambiata da quando l'hai mostrata: non ho fissato niente. Chiedi di nuovo la proposta.", count: 0 };
		}
		const by = marker(ctx);
		const { force: _f, ...saved } = p;
		const id = await ctx.step("book", async () => {
			store.update(ctx.callId, (state) => {
				if (state.appointments.length >= APPOINTMENT_LIMITS.appointments) throw new AppointmentError("gli appuntamenti sono troppi per salvarne altri");
				// Under the lock: another booking in between takes the time first.
				const again = fits({ ...input, appointments: state.appointments, ...(p.resource === undefined ? {} : { resource: p.resource }) });
				if (!again.ok) throw new AppointmentError("intanto quell'ora è stata presa da un altro appuntamento: non ho fissato niente. Chiedimi di nuovo gli orari liberi");
				const made: Appointment = { id: appointmentId(state.nextAppointment), status: "booked", ...saved, callId: ctx.callId, ...by };
				return { ...state, nextAppointment: state.nextAppointment + 1, appointments: [...state.appointments, made] };
			});
			return store.read().appointments.find((a) => a.callId === ctx.callId)?.id ?? "";
		});
		const after = store.read();
		const made = after.appointments.find((a) => a.id === id);
		if (made === undefined) return { text: "Errore: l'appuntamento non risulta salvato.", count: 0 };
		const extra = [
			...(client.fresh === true ? ["Il cliente non è tra le schede né tra gli appuntamenti: l'ho scritto come detto. Se vuoi, gli faccio la scheda con il cellulare, per i messaggi."] : []),
			...(force ? ["L'ho fissato lo stesso, come mi hai detto, anche se si sovrappone o è fuori orario."] : []),
			...when.notes,
			...(await onceNotes(ctx, settings, today, true)),
		];
		return { text: bookedAnswer(made, after, today, extra), count: 1 };
	}

	function movedAnswer(after: Appointment, today: string, notes: readonly string[]): string {
		const [fromDay, fromStart] = (after.moved?.from ?? `${after.day} ${after.start}`).split(" ") as [string, string];
		return [
			`Fatto: ho spostato l'appuntamento da ${whenWords(fromDay, fromStart, today)} a ${whenWords(after.day, after.start, today)} (fino alle ${clockOf(minutesOf(after.start) + after.minutes)}). Chi e per cosa è nel riquadro.`,
			fencedAppointments(appointmentRow(after)),
			...notes,
			"Vuoi mandare al cliente il messaggio con il nuovo orario? Lo preparo io.",
			...(options.calendar === true ? ["Se era anche nel calendario Google, va spostato anche lì."] : []),
		].join("\n");
	}

	async function move(args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const refused = requirePersonFor(ctx, "sposto l'appuntamento");
		if (refused !== undefined) return { text: refused, count: 0 };
		const mine = b.appointments.find((a) => a.moved?.call === ctx.callId);
		if (mine !== undefined) return { text: movedAnswer(mine, at.day, []), count: 1 };
		const named = appointmentNamed(args, b.appointments, cards(), at.day, (x) => x.status === "booked");
		if (isAnswer(named)) return { text: named.answer, count: 0 };
		const a = named.appointment;
		if (args.date === undefined && args.time === undefined && args.resource === undefined) return { text: "Errore: dimmi il giorno o l'ora nuovi.", count: 0 };
		const force = args.force === true;
		const when = whenSaid(args, b.settings, at, a.day, minutesOf(a.start));
		if (typeof when === "string") return { text: when, count: 0 };
		const resource = args.resource === undefined ? a.resource : resourceSaid(args.resource, b.settings);
		if (isAnswer(resource)) return { text: resource.answer, count: 0 };
		const ask = closeCheck("move", named, args, [when.day, when.minutes, resource ?? "", force], at.day);
		if (ask !== undefined) return { text: ask, count: 0 };
		if (when.day === a.day && timeOf(when.minutes) === a.start && resource === a.resource) return { text: `L'appuntamento è già ${whenWords(a.day, a.start, at.day)}: non ho cambiato niente.`, count: 0 };
		if (when.minutes + a.minutes > 24 * 60) return { text: "Errore: l'appuntamento finirebbe dopo mezzanotte: dimmi un'ora prima.", count: 0 };
		const input: FitInput = { settings: b.settings, appointments: b.appointments, day: when.day, start: when.minutes, minutes: a.minutes, ...(resource === undefined ? {} : { resource }), except: a.id, now: at, force, ...blocked };
		const what = ["move", a.id, when.day, when.minutes, resource ?? ""];
		const fit = forced(input, args, what, b, at.day, "non l'ho spostato");
		if (typeof fit === "string") return { text: [fit, ...when.notes].join("\n"), count: 0 };
		if (!fit.ok) return { text: [refusal(fit, input, b, at.day, "non l'ho spostato", fit.why === "past" ? undefined : forceCheckOf(what, fit)), ...when.notes].join("\n"), count: 0 };
		const by = marker(ctx);
		await ctx.step("move", async () => {
			store.update(ctx.callId, (state) => {
				const now_ = state.appointments.find((x) => x.id === a.id);
				if (now_ === undefined || now_.status !== "booked") throw new AppointmentError("intanto quell'appuntamento è stato chiuso o disdetto: non l'ho spostato");
				const again = fits({ ...input, appointments: state.appointments, ...(fit.resource === undefined ? {} : { resource: fit.resource }) });
				if (!again.ok) throw new AppointmentError("intanto quell'ora è stata presa da un altro appuntamento: non l'ho spostato");
				const { resource: _r, ...rest } = now_;
				const moved: Appointment = { ...rest, day: when.day, start: timeOf(when.minutes), ...(fit.resource === undefined ? {} : { resource: fit.resource }), moved: { ...by, from: `${now_.day} ${now_.start}`, call: ctx.callId } };
				return { ...state, appointments: state.appointments.map((x) => (x.id === a.id ? moved : x)) };
			});
			return true;
		});
		const after = store.read().appointments.find((x) => x.id === a.id) as Appointment;
		return { text: movedAnswer(after, at.day, [...when.notes, ...(await onceNotes(ctx, b.settings, at.day, false))]), count: 1 };
	}

	function closedAnswer(op: "cancel" | "no_show" | "done", after: readonly Appointment[], b: AppointmentBook, today: string): string {
		const first = after[0] as Appointment;
		if (after.length > 1) return [`Fatto: ho segnato come fatti ${after.length} appuntamenti ${dayWords(first.day, today)}. Sono nel riquadro.`, fencedAppointments(after.map((a) => appointmentRow(a)).join("\n"))].join("\n");
		const when = whenWords(first.day, first.start, today);
		if (op === "cancel") return [`Fatto: ho segnato come disdetto l'appuntamento di ${when}. Resta nello storico del cliente, e quell'ora è di nuovo libera.`, fencedAppointments(appointmentRow(first)), ...(options.calendar === true ? ["Se era anche nel calendario Google, va tolto anche lì."] : [])].join("\n");
		if (op === "done") return [`Fatto: ho segnato come fatto l'appuntamento di ${when}.`, fencedAppointments(appointmentRow(first))].join("\n");
		const missed = noShows(b, first.client);
		const n = Math.max(1, missed.findIndex((a) => a.id === first.id) + 1 || missed.length);
		const previous = missed.filter((a) => byTime(a, first) < 0).at(-1);
		const which = n === 1 ? "È la prima volta che non si presenta." : `È la ${ORDINALS[n - 1] ?? `${n}ª`} volta che non si presenta${previous === undefined ? "" : ` (l'ultima il ${dateOnly(previous.day)})`}.`;
		return [`Fatto: ho segnato che il cliente non si è presentato all'appuntamento di ${when}. Resta nello storico. ${which}${n >= 3 ? " Se vuoi, quando lo rifissi te lo ricordo." : ""}`, fencedAppointments(appointmentRow(first))].join("\n");
	}

	/** Disdetto, non presentato, fatto: the person's word, the record kept. */
	async function close(op: "cancel" | "no_show" | "done", args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const status = op === "cancel" ? "cancelled" : op;
		const refused = requirePersonFor(ctx, op === "cancel" ? "segno l'appuntamento come disdetto" : op === "no_show" ? "segno che il cliente non si è presentato" : "segno l'appuntamento come fatto");
		if (refused !== undefined) return { text: refused, count: 0 };
		const mine = b.appointments.filter((a) => a.closed?.call === ctx.callId).sort(byTime);
		if (mine.length > 0) return { text: closedAnswer(op, mine, b, at.day), count: mine.length };
		let targets: Appointment[];
		if (op === "done" && args.all === true) {
			const day = daySaid(args.date ?? "oggi", at.day);
			if (isAnswer(day)) return { text: day.answer, count: 0 };
			if (day > at.day) return { text: "Errore: si segnano come fatti solo gli appuntamenti già cominciati.", count: 0 };
			targets = b.appointments.filter((a) => a.day === day && a.status === "booked" && started(a, at));
			if (targets.length === 0) return { text: `Nessun appuntamento ancora «fissato» ${day === at.day ? "di oggi già cominciato" : `del ${dayWords(day, at.day)}`}: non ho segnato niente.`, count: 0 };
		} else {
			// Fatto and non presentato only once begun, by name or by reference alike.
			const named = appointmentNamed(args, b.appointments, cards(), at.day, (x) => x.status === "booked" && (op === "cancel" || started(x, at)), op !== "cancel");
			if (isAnswer(named)) return { text: op === "cancel" ? named.answer : `${named.answer}\nSi segna come fatto, o non presentato, solo un appuntamento ancora «fissato» e già cominciato.`, count: 0 };
			const ask = closeCheck(op, named, args, null, at.day);
			if (ask !== undefined) return { text: ask, count: 0 };
			targets = [named.appointment];
		}
		const ids = targets.map((t) => t.id);
		const by = marker(ctx);
		await ctx.step(op, async () => {
			store.update(ctx.callId, (state) => {
				const gone = ids.filter((id) => state.appointments.find((x) => x.id === id)?.status !== "booked");
				if (gone.length > 0) throw new AppointmentError("intanto l'appuntamento è stato già segnato o disdetto: non ho cambiato niente");
				return { ...state, appointments: state.appointments.map((x) => (ids.includes(x.id) ? { ...x, status, closed: { ...by, call: ctx.callId } } : x)) };
			});
			return true;
		});
		const book_ = store.read();
		const after = book_.appointments.filter((x) => ids.includes(x.id)).sort(byTime);
		return { text: closedAnswer(op, after, book_, at.day), count: after.length };
	}

	/** The days from `date` (today) to `to_date`, at most 14. */
	function daysSaid(args: Record<string, unknown>, today: string, first: string, week: boolean): string[] | string {
		const from = daySaid(args.date ?? first, today);
		if (isAnswer(from)) return from.answer;
		const to = args.to_date !== undefined ? daySaid(args.to_date, from) : week ? addDays(from, 6) : from;
		if (isAnswer(to)) return to.answer;
		if (to < from) return "Errore: l'ultimo giorno viene prima del primo.";
		if (daysBetween(from, to) >= APPOINTMENT_LIMITS.ahead) return `Errore: guardo al più ${APPOINTMENT_LIMITS.ahead} giorni alla volta.`;
		const out: string[] = [];
		for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
		return out;
	}

	function freeTimes(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const settings = b.settings;
		if (settings?.week === undefined) return { text: `Non so ancora gli orari di apertura, quindi non so dire quando sei libero. ${HOURS_NOTE.replace(/^.*?: /, "Dimmeli ")}`, count: 0 };
		const days = daysSaid(args, at.day, "oggi", args.week === true);
		if (typeof days === "string") return { text: days, count: 0 };
		const window = windowSaid(args.window);
		if (isAnswer(window)) return { text: window.answer, count: 0 };
		const windowWord = typeof args.window === "string" && window !== undefined ? ` ${args.window.trim().toLowerCase().replace(/^(?:di |la |il )/, "")}` : "";
		let minutes = minutesSaid(args.minutes);
		if (isAnswer(minutes)) return { text: minutes.answer, count: 0 };
		let needs: readonly string[] | undefined;
		const notes: string[] = [];
		if (minutes === undefined && args.services !== undefined) {
			const sv = servicesSaid(args.services, settings, voci());
			if (isAnswer(sv)) return { text: sv.answer, count: 0 };
			minutes = sv.services.reduce((n, s) => n + s.minutes, 0);
			needs = sv.needs;
			if (sv.assumed.length > 0) notes.push(`Non so quanto ${n1(sv.assumed.length, "dura un servizio: ho contato", "durano # servizi: ho contato")} ${DEFAULT_MINUTES} minuti.`);
		}
		if (minutes === undefined) {
			minutes = DEFAULT_MINUTES;
			notes.push(`Non mi hai detto quanto deve durare: ho cercato ${DEFAULT_MINUTES} minuti.`);
		}
		const resource = resourceSaid(args.resource, settings);
		if (isAnswer(resource)) return { text: resource.answer, count: 0 };
		const step = settings.slot ?? DEFAULT_SLOT;
		const plain: string[] = [];
		const byResource: string[] = [];
		for (const day of days) {
			if (day < at.day) continue;
			const label = `${capital(shortDay(day, at.day))}${windowWord}`;
			const open = openOn(settings, day);
			if (open.spans.length === 0) {
				if (days.length === 1) plain.push(`${capital(closedWords(open, day))}.`);
				continue;
			}
			const slots = freeSlots({ settings, appointments: b.appointments, day, minutes, ...(resource === undefined ? {} : { resource }), ...(needs === undefined ? {} : { needs }), now: at, ...blocked, ...(window === undefined ? {} : { from: window.from, to: window.to }) });
			if (slots.length === 0) {
				if (days.length === 1) plain.push(`${label} non c'è posto per ${durationWords(minutes)}.`);
				continue;
			}
			const lanes = [...new Set(slots.map((s) => s.resource))];
			if (lanes.length === 1 && lanes[0] === undefined) plain.push(`${label} sei libero ${windowsWords(slots.map((s) => s.start), step, minutes)}.`);
			else for (const lane of lanes) byResource.push(`• ${label}, ${lane ?? ""}: ${windowsWords(slots.filter((s) => s.resource === lane).map((s) => s.start), step, minutes)}`);
		}
		if (plain.length === 0 && byResource.length === 0) plain.push(`Nessun posto per ${durationWords(minutes)} in quei giorni${windowWord === "" ? "" : ` (${windowWord.trim()})`}.`);
		return { text: [...plain, ...(byResource.length === 0 ? [] : ["Dove c'è posto, per risorsa, è nel riquadro.", fencedAppointments(byResource.join("\n"))]), ...notes].join("\n"), count: 0 };
	}

	function agenda(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const days = daysSaid(args, at.day, "oggi", args.week === true);
		if (typeof days === "string") return { text: days, count: 0 };
		const out: string[] = [];
		const rows: string[] = [];
		let count = 0;
		for (const day of days) {
			const list = b.appointments.filter((a) => a.day === day && (a.status === "booked" || a.status === "done")).sort(byTime);
			const cancelled = b.appointments.filter((a) => a.day === day && (a.status === "cancelled" || a.status === "no_show")).length;
			const open = openOn(b.settings, day);
			count += list.length;
			const closed = open.known && open.spans.length === 0 ? ` (${closedWords(open, day)})` : "";
			const last = list.at(-1);
			out.push(`• ${capital(dayWords(day, at.day))}: ${list.length === 0 ? "nessun appuntamento" : n1(list.length, "un appuntamento", "# appuntamenti")}${last !== undefined ? `, dalle ${clockOf(minutesOf((list[0] as Appointment).start))} alle ${clockOf(minutesOf(last.start) + last.minutes)}` : ""}${cancelled > 0 ? `; ${n1(cancelled, "uno disdetto o non presentato", "# disdetti o non presentati")}` : ""}${closed}`);
			if (days.length === 1 && open.known && open.spans.length > 0) out.push(...gapsWords(b.settings, b.appointments, day, day > at.day ? 0 : at.minutes).map((l, i) => (i === 0 ? `  ${l}` : l)));
			if (list.length > 0) rows.push(...(days.length > 1 ? [capital(dayWords(day, at.day))] : []), ...list.map((a) => appointmentRow(a)));
		}
		return { text: [...out, ...(rows.length === 0 ? [] : ["Chi e per cosa è nel riquadro.", fencedAppointments(rows.join("\n"))])].join("\n"), count };
	}

	async function brief(ctx: ToolContext, b: AppointmentBook, at: Now): Promise<string> {
		const today = b.appointments.filter((a) => a.day === at.day && a.status === "booked").sort(byTime);
		const yesterday = addDays(at.day, -1);
		const open = b.appointments.filter((a) => a.day === yesterday && a.status === "booked");
		const wanted = [...(today.length > 0 ? [`today:${at.day}`] : []), ...(open.length > 0 ? [`open:${yesterday}`] : [])];
		const said = wanted.length === 0 ? [] : await ctx.step("claim", async () => store.claim(ctx.callId, at.day, wanted));
		if (said.length === 0) return BRIEF_NOTHING;
		await audit(ctx, "brief", said.length);
		const out: string[] = [];
		if (said.includes(`today:${at.day}`)) {
			const first = today[0] as Appointment;
			const gaps = b.settings?.week === undefined ? [] : gapsWords(b.settings, b.appointments, at.day, 0);
			out.push(`Appuntamenti di oggi: ${today.length}, il primo alle ${clockOf(minutesOf(first.start))} (chi e per cosa nel riquadro).`, fencedAppointments(appointmentRow(first)), ...gaps);
		}
		if (said.includes(`open:${yesterday}`)) out.push(open.length === 1 ? "Ieri un appuntamento è ancora da segnare: dimmi «fatto», oppure se non è venuto." : `Ieri ${open.length} appuntamenti sono ancora da segnare: dimmi «tutti fatti», oppure chi non è venuto.`);
		return out.join("\n");
	}

	function history(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const c = clientSaid(args.client, cards(), b.appointments);
		if (isAnswer(c)) return { text: c.answer, count: 0 };
		if (c.close === true) return { text: ["Intendi questo cliente? Non si chiama esattamente così:", fencedAppointments(c.client.name), "Chiedi a chi ti scrive se è lui, e ripeti con il nome scritto come qui."].join("\n"), count: 0 };
		const mine = b.appointments.filter((a) => clientKey(a.client) === clientKey(c.client)).sort(byTime);
		if (mine.length === 0) return { text: ["Non trovo appuntamenti per questo cliente.", fencedAppointments(c.client.name)].join("\n"), count: 0 };
		const done = mine.filter((a) => a.status === "done");
		const noShow = mine.filter((a) => a.status === "no_show").length;
		const cancelled = mine.filter((a) => a.status === "cancelled").length;
		const next = mine.filter((a) => a.status === "booked" && !started(a, at));
		const usual = new Map<string, number>();
		for (const a of done) usual.set(servicesWords(a), (usual.get(servicesWords(a)) ?? 0) + 1);
		const top = [...usual.entries()].sort((x, y) => y[1] - x[1])[0];
		const lines = [
			`Cliente: ${mine.at(-1)?.client.name ?? c.client.name}`,
			...(top !== undefined && done.length >= 2 ? [`Di solito fa: ${top[0]} (${top[1]} volte su ${done.length})`] : []),
			"Ultime visite:",
			...(done.length === 0 ? ["nessuna"] : done.slice(-5).reverse().map((a) => appointmentRow(a, true))),
			...(next.length === 0 ? [] : ["Prossimi:", ...next.slice(0, 5).map((a) => appointmentRow(a, true))]),
			...(noShow + cancelled === 0 ? [] : ["Disdetti e non presentati:", ...mine.filter((a) => a.status === "no_show" || a.status === "cancelled").slice(-5).reverse().map((a) => appointmentRow(a, true))]),
		];
		const head = `${n1(done.length, "Una visita fatta", "# visite fatte")}, ${n1(noShow, "un «non presentato»", "# «non presentato»")}, ${n1(cancelled, "una disdetta", "# disdette")}${next.length === 0 ? ", nessun appuntamento in programma" : `; il prossimo è ${whenWords((next[0] as Appointment).day, (next[0] as Appointment).start, at.day)}`}.${top !== undefined && done.length >= 2 ? " Cosa fa di solito è nel riquadro." : ""}`;
		return { text: [head, fencedAppointments(lines.join("\n"))].join("\n"), count: 0 };
	}

	function reminders(args: Record<string, unknown>, b: AppointmentBook, at: Now): Answer {
		const confirm = args.confirmation === true;
		// A confirmation is one client's: never every appointment to come.
		if (confirm && (typeof args.client !== "string" || args.client.trim() === "")) return { text: "Errore: il messaggio di conferma è per un cliente: dimmi per quale.", count: 0 };
		const day = daySaid(args.date ?? (confirm ? "oggi" : "domani"), at.day);
		if (isAnswer(day)) return { text: day.answer, count: 0 };
		if (day < at.day) return { text: "Errore: i messaggi si fanno per oggi o per i prossimi giorni.", count: 0 };
		let list = b.appointments.filter((a) => a.status === "booked" && !started(a, at) && (confirm && args.date === undefined ? a.day >= day : a.day === day)).sort(byTime);
		if (args.client !== undefined) {
			const c = clientSaid(args.client, cards(), b.appointments);
			if (isAnswer(c)) return { text: c.answer, count: 0 };
			list = list.filter((a) => clientKey(a.client) === clientKey(c.client));
			// A confirmation: the client's next appointment, whatever its day.
			if (confirm && args.date === undefined) list = list.filter((a) => a.day === list[0]?.day);
		}
		if (list.length === 0) return { text: `${args.client === undefined ? `Per ${dayWords(day, at.day)} non ci sono appuntamenti fissati` : "Non trovo un appuntamento fissato così per questo cliente"}: nessun messaggio da preparare.`, count: 0 };
		const groups = new Map<string, Appointment[]>();
		for (const a of list) groups.set(`${a.day}|${clientKey(a.client)}`, [...(groups.get(`${a.day}|${clientKey(a.client)}`) ?? []), a]);
		const all = cards();
		let links = 0;
		let landlines = 0;
		let mails = 0;
		let nothing = 0;
		const blocks: string[] = [];
		for (const g of groups.values()) {
			const first = g[0] as Appointment;
			const card = first.client.card === undefined ? undefined : all.find((x) => x.id === first.client.card);
			const email = card?.contacts.find((x) => x.email !== undefined)?.email;
			const phone = card?.contacts.find((x) => x.phone !== undefined && mobileOf(x.phone) !== undefined)?.phone ?? card?.contacts.find((x) => x.phone !== undefined)?.phone;
			const mobile = phone === undefined ? undefined : mobileOf(phone);
			const message = reminderText(g, at.day, b.settings?.business, confirm);
			if (mobile !== undefined) links += 1;
			else if (phone !== undefined) landlines += 1;
			if (email !== undefined) mails += 1;
			if (phone === undefined && email === undefined) nothing += 1;
			blocks.push([`Per: ${first.client.name}${phone === undefined ? "" : `, telefono ${phone}`}${email === undefined ? "" : `, email ${email}`}`, message, ...(mobile === undefined ? [] : [`WhatsApp: ${waLink(mobile, message)}`])].join("\n"));
		}
		const n = groups.size;
		const kind = confirm ? n1(n, "il messaggio di conferma", "# messaggi di conferma") : n1(n, "un promemoria", "# promemoria");
		const when = confirm ? "" : ` per ${day === addDays(at.day, 1) ? "domani" : dayWords(day, at.day)}`;
		const lines = [`Ho preparato ${kind}${when}, nel riquadro. Non mando niente da sola.`, fencedAppointments(blocks.join("\n\n"))];
		if (links > 0) lines.push(`Per ${n1(links, "un cliente con il cellulare", "# clienti con il cellulare")} c'è il link: lo tocchi e WhatsApp apre il messaggio già scritto, poi lo mandi tu.`);
		if (landlines > 0) lines.push(`${n1(landlines, "Un numero nella scheda non sembra un cellulare", "# numeri nelle schede non sembrano cellulari")}: niente link, si chiama o si manda il testo a mano.`);
		if (mails > 0) lines.push(`${n1(mails, "Un cliente ha", "# clienti hanno")} l'email nella scheda: posso preparare la mail con google_mail_send, che parte solo dopo la tua approvazione.`);
		if (nothing > 0) lines.push(`${n1(nothing, "Un cliente non ha", "# clienti non hanno")} né il numero né l'email nella scheda: vuoi che ${nothing === 1 ? "glielo aggiunga" : "li aggiunga"}? Intanto il testo si copia e si manda da WhatsApp, SMS o mail.`);
		if (b.settings?.business === undefined) lines.push("Se mi dici il nome dell'attività, lo metto nei messaggi.");
		return { text: lines.join("\n"), count: n };
	}

	async function settings(args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		const by = marker(ctx);
		const next = settingsSaid(args, b.settings, voci(), at.day, by);
		if (next === undefined) return { text: settingsWords(b.settings, at.day), count: 0 };
		if (isAnswer(next)) return { text: next.answer, count: 0 };
		const refused = requirePersonFor(ctx, "cambio gli orari e le impostazioni degli appuntamenti");
		if (refused !== undefined) return { text: refused, count: 0 };
		await ctx.step("settings", async () => {
			store.update(ctx.callId, (state) => {
				// Under the lock: what was said, over the settings as saved now.
				const again = settingsSaid(args, state.settings, voci(), at.day, by);
				if (again === undefined) return state;
				if (isAnswer(again)) throw new AppointmentError(again.answer.replace(/^Errore: /, "").replace(/\.$/, ""));
				return { ...state, settings: again };
			});
			return true;
		});
		const saved = store.read().settings;
		// The appointments booked where now it is closed: said, never moved by Owni.
		const clash = b.appointments.filter((a) => a.status === "booked" && a.day >= at.day && !fitsOpen(saved, a));
		return {
			text: [
				"Fatto, ho salvato.",
				settingsWords(saved, at.day),
				...(clash.length === 0 ? [] : [`Attenzione: ${n1(clash.length, "un appuntamento fissato cade", "# appuntamenti fissati cadono")} quando ora sei chiuso (nel riquadro): ${clash.length === 1 ? "va spostato o disdetto" : "vanno spostati o disdetti"}. Vuoi che prepari un messaggio per avvisarli e proporre un'altra data?`, fencedAppointments(clash.map((a) => appointmentRow(a, true)).join("\n"))]),
			].join("\n"),
			count: 1,
		};
	}

	async function exportCsv(ctx: ToolContext, b: AppointmentBook, day: string): Promise<Answer> {
		const refused = requirePersonFor(ctx, "faccio il file degli appuntamenti");
		if (refused !== undefined) return { text: refused, count: 0 };
		const all = b.appointments;
		if (all.length === 0) return { text: "Non c'è ancora nessun appuntamento da mettere nel file.", count: 0 };
		const path = await ctx.step("path", async () => freePath(workspace, `appuntamenti/appuntamenti-al-${day}`, ".csv"));
		const written = await ctx.step("write", async () => (await workspace.write(path, appointmentsCsv(all))).path);
		return { text: [`Salvato il file degli appuntamenti: ${n1(all.length, "un appuntamento", "# appuntamenti")}, uno per riga, con lo stato (separatore «;», si apre con Excel). Il percorso è nel riquadro; mandalo con file_send se chi ti scrive lo vuole.`, fencedAppointments(written)].join("\n"), count: all.length };
	}

	function agentCounts(b: AppointmentBook, at: Now): string {
		const on = (day: string) => b.appointments.filter((a) => a.day === day && a.status === "booked").length;
		return `Appuntamenti: oggi ${on(at.day)}, domani ${on(addDays(at.day, 1))}. A un altro agente do solo i conteggi: clienti e servizi no.`;
	}

	async function run(op: AppointmentOp, args: Record<string, unknown>, ctx: ToolContext, b: AppointmentBook, at: Now): Promise<Answer> {
		switch (op) {
			case "book":
				return book(args, ctx, b, at);
			case "move":
				return move(args, ctx, b, at);
			case "cancel":
			case "no_show":
			case "done":
				return close(op, args, ctx, b, at);
			case "free_slots":
				return freeTimes(args, b, at);
			case "agenda":
				return agenda(args, b, at);
			case "history":
				return history(args, b, at);
			case "reminders":
				return reminders(args, b, at);
			case "settings":
				return settings(args, ctx, b, at);
			case "export":
				return exportCsv(ctx, b, at.day);
		}
	}

	const durationSchema = {
		type: "object",
		properties: { name: text(APPOINTMENT_LIMITS.service, "the service, as said (a voce of the listino when there is one)"), minutes: { type: ["integer", "string"], description: "how long it lasts: 30, «1h30»" }, needs: { type: "array", maxItems: APPOINTMENT_LIMITS.resources, items: text(APPOINTMENT_LIMITS.resource, "a resource"), description: "the resources that may do it" } },
		required: ["name", "minutes"],
		additionalProperties: false,
	};

	return [
		{
			name: "appointments",
			description: DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					op: { type: "string", enum: [...APPOINTMENT_OPS] },
					client: text(APPOINTMENT_LIMITS.name, "book, history: the client as said, with the title («la signora Rossi»), or card id CL-0001; move, cancel, no_show, done: whose appointment; reminders: only this client's"),
					services: { type: "array", maxItems: 50, items: { anyOf: [text(APPOINTMENT_LIMITS.service, "book, free_slots: a service as said («taglio»)"), durationSchema] }, description: "book, free_slots: the services as said, each a string; settings: how long each service lasts, each {name, minutes, needs}" },
					date: text(40, "book: the day («giovedì», «domani», 22/10); move: the new day; agenda, free_slots: the first day (default today); reminders: default tomorrow; done with all: the day («ieri»)"),
					time: text(20, "book: the time as said («15», «15:30», «alle 3 e mezza», «mezzogiorno»); move: the new time (default the same)"),
					minutes: { type: ["integer", "string"], description: "book: the duration when said (default the services'); free_slots: how long («un'ora», 45)" },
					resource: text(APPOINTMENT_LIMITS.resource, "book, move, free_slots: the resource as said («Marco», «poltrona 2»)"),
					notes: text(APPOINTMENT_LIMITS.notes, "book: notes as said"),
					force: { type: "boolean", description: "book, move: true only when the person said «fissalo lo stesso» after the clash or the closed time was shown, with force_check" },
					force_check: text(16, "book, move with force: the check the refusal gave"),
					appointment: text(10, "move, cancel, no_show, done: the reference AP-0001 (never said to the person)"),
					from_date: text(40, "move, cancel, no_show, done: the day of the appointment, when the client has more than one"),
					to_date: text(40, "agenda, free_slots: the last day (at most 14 days)"),
					week: { type: "boolean", description: "agenda, free_slots: seven days from date" },
					window: text(20, "free_slots: mattina, pomeriggio, sera"),
					all: { type: "boolean", description: "done: every appointment of the day already begun" },
					confirm: { type: "boolean", description: "book: true only after the person's yes to the proposal; move, cancel, no_show, done: after the yes to «intendi questo appuntamento?»" },
					check: text(20, "with confirm: the check given with the proposal"),
					confirmation: { type: "boolean", description: "reminders: the confirmation message of a new appointment (client required) instead of the reminder" },
					compact: { type: "boolean", description: "agenda: the brief's line only" },
					business: text(APPOINTMENT_LIMITS.business, "settings: the business's name, for the messages"),
					hours: {
						anyOf: [
							text(200, "«mar-sab 9-13 e 14-19; chiuso domenica e lunedì»"),
							{ type: "array", maxItems: 7, items: { type: "object", properties: { days: text(40, "«lun-ven», «sabato»"), open: text(60, "«9-13, 14:30-19» or «chiuso»") }, required: ["days", "open"], additionalProperties: false } },
						],
						description: "settings: the opening hours by weekday, with the pauses and the closed days",
					},
					closure_from: text(40, "settings: a closure's first day (ferie)"),
					closure_to: text(40, "settings: a closure's last day"),
					closure_note: text(120, "settings: why («ferie»)"),
					closure_remove: text(40, "settings: a day of the closure to take off"),
					holidays_open: { type: "boolean", description: "settings: open on the national holidays (default closed)" },
					slot: { type: "integer", enum: [5, 10, 15, 20, 30, 60], description: "settings: appointments start every so many minutes (default 15)" },
					resources: { type: "array", maxItems: APPOINTMENT_LIMITS.resources, items: text(APPOINTMENT_LIMITS.resource, "a resource"), description: "settings: every resource (people, chairs, lifts), the whole list" },
				},
				required: ["op"],
				additionalProperties: false,
			},
			replaySafe: true,
			async execute(args, ctx) {
				if (!APPOINTMENT_OPS.includes(args.op as AppointmentOp)) return "Errore: non conosco questa operazione sugli appuntamenti.";
				const op = args.op as AppointmentOp;
				if (args.compact !== undefined && typeof args.compact !== "boolean") return "Errore: compact è sì o no.";
				// Appointments name clients, services and times: another agente gets counts only.
				if (isAgentTurn(ctx) && !READ_OPS.includes(op)) return AGENT_REFUSAL;
				const at = localNow(timeZone, now());
				try {
					const b = store.read();
					if (b.broken) return op === "agenda" && args.compact === true ? BRIEF_BROKEN : `Errore: ${APPOINTMENTS_BROKEN}.`;
					if (isAgentTurn(ctx)) return agentCounts(b, at);
					if (op === "agenda" && args.compact === true) return await brief(ctx, b, at);
					const answer = await run(op, args, ctx, b, at);
					if (!answer.text.startsWith("Errore") && answer.count > 0) await audit(ctx, op, answer.count);
					return answer.text;
				} catch (error) {
					if (error instanceof AppointmentError) return `Errore: ${error.message}.`;
					if (error instanceof WorkspaceError) return `Errore: ${error.message}`;
					throw error;
				}
			},
		},
	];
}

/** Whether a booked appointment still falls in the openings. */
function fitsOpen(settings: AppointmentSettings | undefined, a: Appointment): boolean {
	const start = minutesOf(a.start);
	return openOn(settings, a.day).spans.some((s) => s.from <= start && start + a.minutes <= s.to);
}
