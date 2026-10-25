// Cards for what an agente asks to do through a connector or Google: shown in Approvazioni and in the chat.
import { api, face, faceColor, fmt, h, icon, toast } from "./common.js";

/**
 * An approval card, finished the same way for every kind: the face of the agente asking,
 * and, while it waits, an edge in that agente's colour.
 */
export function decisionCard(el, inst, pending, size = 32) {
	el.querySelector("header")?.prepend(h("span.dossier-face", face(inst, size)));
	el.classList.toggle("pending", pending);
	el.style.setProperty("--glow", faceColor(inst));
	return el;
}

/**
 * A decision from the card's own buttons: the one pressed shows it is working and both wait; once
 * decided the card folds away, then the list is drawn again. On failure the buttons come back.
 */
export async function decideWith(el, button, request, after) {
	const buttons = [...el.querySelectorAll(".actions button")];
	for (const b of buttons) b.disabled = true;
	button.classList.add("busy");
	button.setAttribute("aria-busy", "true");
	try {
		await request();
	} catch (error) {
		for (const b of buttons) b.disabled = false;
		button.classList.remove("busy");
		button.removeAttribute("aria-busy");
		toast(error.message, true);
		return;
	}
	if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
		const height = el.offsetHeight;
		await el.animate([{ opacity: 1, height: `${height}px`, filter: "blur(0)" }, { opacity: 0, height: "0px", paddingBlock: "0px", filter: "blur(3px)" }], { duration: 320, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" }).finished.catch(() => {});
	}
	after();
}

const CONNECTOR_STAMP = { done: ["ok", "Fatto"], failed: ["bad", "Non riuscito"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In corso"] };

/** A call to a connected service waiting for a person: why, what, with which values, whole; approve runs it once. */
export function connectorActionCard(inst, a, after, compact = false) {
	const el = h(
		"article.card.pad.dossier",
		h("header", h("div", h("h2", a.reason), h("small.dossier-meta", `${a.connectorName} · ${fmt.time(a.proposedAt)}`)), a.status === "pending" ? h(a.destructive ? "span.chip.bad" : "span.chip.accent", a.destructive ? "Può cancellare o sovrascrivere" : "In attesa") : null),
		askedByNote(a.askedBy),
		h("p", h("b", "Azione: "), a.toolTitle, " ", h("span.mono.muted", a.tool)),
		a.shown.length ? h("table.ledger", h("tbody", a.shown.map(([k, v]) => h("tr", h("td.mono", k), h("td", h("pre.code", v)))))) : h("p.muted", "Nessun dato."),
		a.result ? h("details", h("summary", "Dettagli"), h("pre.code", a.result.error ?? a.result.text)) : null,
		a.status !== "pending" && CONNECTOR_STAMP[a.status] ? h(`div.stamp.${CONNECTOR_STAMP[a.status][0]}`, CONNECTOR_STAMP[a.status][1]) : null,
	);
	if (a.status === "pending") {
		const decide = (decision, event) => decideWith(el, event.currentTarget, async () => {
			const { action } = await api(`/api/instances/${inst.id}/connector-actions/${a.id}/decision`, { method: "POST", body: { decision } });
			toast(action.status === "done" ? `Fatto su ${a.connectorName}` : action.status === "rejected" ? "Richiesta rifiutata" : action.status === "failed" ? "Non è stata fatta: vedi i dettagli" : action.status === "uncertain" ? `Esito incerto: controlla su ${a.connectorName}` : action.status === "expired" ? "La richiesta era scaduta" : `Richiesta ${action.status}`, action.status !== "done" && action.status !== "rejected");
		}, after);
		el.append(h("div.actions", h("button.btn.accent", { onclick: (e) => decide("approved", e) }, icon("check"), "Approva"), h("button.btn.danger", { onclick: (e) => decide("rejected", e) }, "Rifiuta"), compact ? null : h("span.muted", `Se la approvi, Owni la fa una volta sola, con questi valori, su ${a.connectorName}.`)));
	}
	return decisionCard(el, inst, a.status === "pending", compact ? 26 : 32);
}

/** Which agente asked, and its words shown as a quote: a request to read, never an approval (ADR 0108). */
export function askedByNote(askedBy) {
	if (!askedBy) return null;
	return h("div", h("p", h("b", "La chiede l'agente "), `«${askedBy.name}»`, askedBy.request ? ", con le sue parole:" : "."), askedBy.request ? h("blockquote", h("pre.code", askedBy.request)) : null);
}

/** A step another agente asked for, waiting for one of this agente's approvers: approve runs exactly that call, once. */
export function agentRequestCard(inst, a, after) {
	const el = h(
		"article.card.pad.dossier",
		h("header", h("div", h("h2", `Richiesta dell'agente «${a.askedBy.name}»`), h("small.dossier-meta", `${inst.name} · ${fmt.time(a.proposedAt)}`)), a.status === "pending" ? h("span.chip.accent", "In attesa") : null),
		askedByNote(a.askedBy),
		h("p", h("b", "Azione: "), a.what, " ", h("span.mono.muted", a.tool)),
		a.shown.length ? h("table.ledger", h("tbody", a.shown.map(([k, v]) => h("tr", h("td.mono", k), h("td", h("pre.code", v)))))) : h("p.muted", "Nessun dato."),
		a.preview ? h("div", h("p", h("b", "Cosa scriverei:")), h("pre.code", a.preview)) : null,
		a.result ? h("details", h("summary", "Dettagli"), h("pre.code", a.result.error ?? a.result.text)) : null,
		a.status !== "pending" && CONNECTOR_STAMP[a.status] ? h(`div.stamp.${CONNECTOR_STAMP[a.status][0]}`, CONNECTOR_STAMP[a.status][1]) : null,
	);
	if (a.status === "pending") {
		const decide = (decision, event) => decideWith(el, event.currentTarget, async () => {
			const { request } = await api(`/api/instances/${inst.id}/agent-requests/${a.id}/decision`, { method: "POST", body: { decision } });
			toast(request.status === "done" ? "Fatto" : request.status === "rejected" ? "Richiesta rifiutata" : request.status === "failed" ? "Non è stata fatta: vedi i dettagli" : request.status === "uncertain" ? "Esito incerto: controlla prima di rifarla" : request.status === "expired" ? "La richiesta era scaduta" : `Richiesta ${request.status}`, request.status !== "done" && request.status !== "rejected");
		}, after);
		el.append(h("div.actions", h("button.btn.accent", { onclick: (e) => decide("approved", e) }, icon("check"), "Approva"), h("button.btn.danger", { onclick: (e) => decide("rejected", e) }, "Rifiuta"), h("span.muted", `Se la approvi, ${inst.name} la fa una volta sola, con questi valori; l'esito torna a «${a.askedBy.name}».`)));
	}
	return decisionCard(el, inst, a.status === "pending");
}

// ---------- Google: scrivere con approvazione ----------
const GOOGLE_KIND = {
	"mail.send": ["Mail", "Invia la mail", "Mail inviata"],
	"mail.draft": ["Bozza in Gmail", "Salva la bozza", "Bozza salvata in Gmail"],
	"calendar.create": ["Nuovo evento", "Crea l'evento", "Evento creato"],
	"calendar.update": ["Modifica di un evento", "Modifica l'evento", "Evento modificato"],
	"calendar.delete": ["Evento da cancellare", "Cancella l'evento", "Evento cancellato"],
};
const GOOGLE_STAMP = { done: ["ok", "Fatto"], failed: ["bad", "Non riuscito"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In corso"] };

/** The day before (YYYY-MM-DD): Google ends an all-day event on the day after the last one. */
function dayBefore(date) {
	return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** An event time as Google takes it, for reading: "gio 16 ott, 10:00" as in the calendar, or the day. */
function eventWhen(t, end = false) {
	if (!t) return "";
	let text = typeof t === "string" ? t : (t.date ?? t.dateTime ?? "");
	const allDay = /^\d{4}-\d{2}-\d{2}$/.test(text);
	if (allDay && end) text = dayBefore(text);
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(text);
	if (!m) return text;
	const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
	return m[4] ? `${day}, ${m[4]}:${m[5]}` : day;
}

/** Start → end, the end's day left out when it is the same; all day said once. */
function eventSpan(start, end) {
	const a = eventWhen(start);
	const b = eventWhen(end, true);
	const allDay = !a.includes(":");
	if (allDay) return a === b ? `${a}, tutto il giorno` : `da ${a} a ${b}, tutto il giorno`;
	const [dayA] = a.split(", ");
	return b.startsWith(`${dayA}, `) ? `${a} → ${b.slice(dayA.length + 2)}` : `${a} → ${b}`;
}

function googleTitle(a) {
	const to = a.mail?.to.join(", ");
	return {
		"mail.send": a.mail?.inReplyTo ? `Rispondere a ${to}` : `Inviare una mail a ${to}`,
		"mail.draft": `Salvare una bozza per ${to}`,
		"calendar.create": `Creare «${a.event?.summary ?? ""}»`,
		"calendar.update": `Modificare «${a.current?.summary ?? ""}»`,
		"calendar.delete": `Cancellare «${a.current?.summary ?? ""}»`,
	}[a.kind] ?? "Richiesta";
}

/**
 * A write to the person's Google account, as they decide it: everything that will happen, word
 * for word. `compact` in the chat, above the box.
 */
export function googleActionCard(inst, a, after, compact = false) {
	const [kind, verb, doneWord] = GOOGLE_KIND[a.kind] ?? ["Richiesta", "Approva", "Fatto"];
	const attached = a.mail?.attachments?.length ?? 0;
	const kicker = [kind, attached === 1 ? "1 allegato" : attached ? `${attached} allegati` : null, fmt.time(a.proposedAt)].filter(Boolean).join(" · ");
	const rows = [];
	const row = (label, value) => value && rows.push(h("tr", h("td", label), h("td", value)));
	if (a.mail) {
		row("Da", a.account);
		const answered = a.mail.inReplyTo;
		if (answered) row("In risposta a", `${answered.from} · «${answered.subject}»${answered.date ? ` · ${answered.date}` : ""}`);
		row("A", a.mail.to.join(", "));
		if (answered?.replyToDiffers) row("Attenzione", "chi ha scritto chiede di rispondere a un altro indirizzo: controlla il destinatario");
		row("Cc", a.mail.cc.join(", "));
		row("Oggetto", a.mail.subject);
		const files = a.mail.attachments ?? [];
		// Whole paths: what leaves the workspace, as the server checked it (ADR 0056).
		row(files.length === 1 ? "Allegato" : "Allegati", files.length ? files.map((f) => h("div", `${f.path} (${fmt.bytes(f.size)})`)) : null);
	} else {
		const e = a.event ?? {};
		const c = a.current;
		row("Calendario", a.account);
		if (c) row(a.kind === "calendar.delete" ? "Evento" : "Evento attuale", `${c.summary} · ${eventSpan(c.start, c.end)}`);
		if (c?.occurrence) row("Ricorrente", "cambia solo questa occorrenza");
		if (c?.series) row("Ricorrente", "cambia tutta la serie");
		if (a.kind === "calendar.create") row("Titolo", e.summary);
		else row("Nuovo titolo", e.summary);
		if (e.start) row(a.kind === "calendar.update" ? "Nuovo orario" : "Quando", eventSpan(e.start, e.end));
		row("Luogo", e.location);
		row("Descrizione", e.description);
		const before = c?.attendees ?? [];
		if (e.attendees) {
			const added = e.attendees.filter((x) => !before.includes(x));
			const removed = before.filter((x) => !e.attendees.includes(x));
			if (a.kind === "calendar.create") row("Invitati", e.attendees.join(", "));
			else {
				row("Invitati aggiunti", added.join(", "));
				row("Invitati tolti", removed.join(", "));
			}
		} else if (before.length) row("Invitati", before.join(", "));
		if (before.length || e.attendees?.length) row("Avvisi", a.notify ? "Google scrive agli invitati" : "gli invitati non vengono avvisati");
	}
	const expires = new Date(Date.parse(a.proposedAt) + 24 * 3600_000).toISOString();
	const el = h(
		`article.card.pad.dossier.google-ask${compact ? ".compact" : ""}`,
		h("header", h("div", h("h2", googleTitle(a)), h("small.dossier-meta", kicker)), a.status === "pending" ? h("span.chip.accent", "Da approvare") : null),
		a.reason ? h("p.muted", a.reason) : null,
		h("table.ledger.fields", h("tbody", rows)),
		a.mail ? (compact && a.mail.body.length > 600 ? h("details", h("summary", "Testo della mail"), h("pre.letter", a.mail.body)) : h("pre.letter", a.mail.body)) : null,
		a.result?.error ? h("p.muted", a.result.error) : null,
		a.result?.link?.startsWith("https://www.google.com/calendar/") ? h("p", h("a", { href: a.result.link, target: "_blank", rel: "noopener" }, "Apri in Google Calendar")) : null,
		a.status !== "pending" && GOOGLE_STAMP[a.status] ? h(`div.stamp.${GOOGLE_STAMP[a.status][0]}`, GOOGLE_STAMP[a.status][1]) : null,
	);
	if (a.status === "pending") {
		const decide = (decision, event) => decideWith(el, event.currentTarget, async () => {
			const { action } = await api(`/api/instances/${inst.id}/google-actions/${a.id}/decision`, { method: "POST", body: { decision } });
			const words = { done: doneWord, rejected: "Richiesta rifiutata", failed: "Non è riuscito: vedi il motivo", uncertain: "Esito incerto: controlla in Google", expired: "Richiesta scaduta", running: "In corso" };
			toast(words[action.status] ?? "Richiesta decisa", action.status === "failed" || action.status === "uncertain");
		}, after);
		el.append(h("div.actions", h(`button.btn${a.kind === "calendar.delete" ? ".danger" : ".accent"}`, { onclick: (e) => decide("approved", e) }, a.kind === "calendar.delete" ? null : icon("check"), verb), h("button.btn.ghost", { onclick: (e) => decide("rejected", e) }, "Rifiuta"), h("span.muted", `Una volta sola, esattamente così. Scade ${fmt.time(expires)}.`)));
	}
	return decisionCard(el, inst, a.status === "pending", compact ? 26 : 32);
}

