// Attività e spesa page.
import { api, emptyNote, fmt, h, head, icon, mount, state } from "../common.js";
import { runHistory } from "../runs.js";

// ---------- attività ----------
const money = new Intl.NumberFormat("it-IT", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Where an audit event comes from, by the first part of its type: a label, an icon, the prefixes it covers. */
const AUDIT_GROUPS = [
	["Messaggi", "chat", ["message", "reply", "draft", "outbox", "mail", "notice", "tap"]],
	["Accessi e persone", "persone", ["web", "person", "user", "tenant", "cell", "team", "instance"]],
	["Board", "board", ["board", "card"]],
	["Connettori", "connettori", ["connector", "connector_action", "google", "google_action", "telegram", "whatsapp", "phone", "secret"]],
	["Modello e spesa", "attivita", ["cost", "model"]],
	["Strumenti", "skill", []],
];
const auditGroup = (type) => AUDIT_GROUPS.find(([, , prefixes]) => prefixes.includes(type.split(".")[0])) ?? AUDIT_GROUPS.at(-1);
/** What an audit event means, in words. A type missing here keeps its technical name. */
const AUDIT_SAY = {
	"agent.run.stopped": "Lavoro interrotto",
	"web.login": "Accesso alla console",
	"web.login_denied": "Accesso rifiutato",
	"web.upload": "File caricato",
	"web.download": "File scaricato",
	"web.browser.opened": "Browser aperto",
	"web.browser.clicked": "Clic nel browser",
	"web.browser.file_refused": "Caricamento di un file rifiutato nel browser",
	"web.browser.takeover": "Controllo del browser alla persona",
	"web.browser.released": "Controllo del browser restituito a Owni",
	"web.browser.form_sent": "Modulo inviato dalla persona",
	"web.browser.profile_cleared": "Accessi ai siti rimossi",
	"web.hosts_changed": "Siti consentiti cambiati",
	"web.instance_created": "Agente creato",
	"web.instance_deleted": "Agente eliminato",
	"instance.created": "Agente creato",
	"instance.deleted": "Agente eliminato",
	"instance.opened": "Agente avviato",
	"instance.resumed": "Agente ripreso dopo un riavvio",
	"instance.updated": "Impostazioni dell'agente cambiate",
	"instance.model.updated": "Modello dell'agente cambiato",
	"instance.model_provider.allowed": "Fornitore del modello consentito",
	"instance.egress.updated": "Siti consentiti cambiati",
	"instance.allowlist.updated": "Chi può scrivere è cambiato",
	"chat.model.updated": "Modello della chat cambiato",
	"tenant.created": "Spazio creato",
	"person.created": "Persona aggiunta",
	"person.removed": "Persona tolta",
	"person.link_rotated": "Nuovo link di accesso",
	"team.created": "Squadra creata",
	"user.denied": "Messaggio da chi non può scrivere",
	"message.received": "Messaggio ricevuto",
	"reply.emitted": "Risposta scritta",
	"reply.delivered": "Risposta consegnata",
	"reply.refused": "Risposta trattenuta",
	"reply.retry_scheduled": "Nuovo tentativo di consegna",
	"reply.retries_exhausted": "Risposta non consegnata",
	"tap.redelivered": "Messaggio riconsegnato",
	"notice.submitted": "Avviso inviato",
	"draft.fallback": "Bozza di riserva",
	"outbox.pruned": "Coda di invio ripulita",
	"mail.failed": "Mail non partita",
	"mail.invalid_sender": "Mail da un mittente non valido",
	"agent.message.sent": "Messaggio a un altro agente",
	"room.created": "Canale creato",
	"room.updated": "Canale modificato",
	"room.deleted": "Canale eliminato",
	"brief.enabled": "Brief del mattino acceso",
	"brief.disabled": "Brief del mattino spento",
	"schedule.fired": "Task eseguito",
	"watch.created": "Sentinella creata",
	"watch.deleted": "Sentinella eliminata",
	"watch.fired": "Sentinella scattata",
	"automation.created": "Automazione creata",
	"automation.deleted": "Automazione eliminata",
	"automation.fired": "Automazione chiamata",
	"automation.limited": "Automazione fermata dal limite",
	"board.card_created": "Incarico creato",
	"board.card_changed": "Incarico modificato",
	"board.card_started": "Incarico preso in carico",
	"board.card_deleted": "Incarico eliminato",
	"board.card_approved_from_chat": "Incarico approvato dalla chat",
	"board.routine_created": "Incarico ricorrente creato",
	"board.routine_changed": "Incarico ricorrente cambiato",
	"board.routine_deleted": "Incarico ricorrente eliminato",
	"card.recovered": "Incarico ripreso dopo un riavvio",
	"connector.saved": "Connettore salvato",
	"connector.connected": "Connettore collegato",
	"connector.authorized": "Connettore autorizzato",
	"connector.removed": "Connettore tolto",
	"connector.failed": "Connettore non raggiungibile",
	"connector.sign_in_cancelled": "Accesso al connettore annullato",
	"connector_action.approved": "Azione su un connettore approvata",
	"connector_action.uncertain": "Azione su un connettore dall'esito incerto",
	"google.connected": "Google collegato",
	"google.disconnected": "Google scollegato",
	"google.allowed": "Google consentito",
	"google_action.approved": "Azione su Google approvata",
	"google_action.uncertain": "Azione su Google dall'esito incerto",
	"telegram.connected": "Telegram collegato",
	"telegram.disconnected": "Telegram scollegato",
	"whatsapp.connected": "WhatsApp collegato",
	"whatsapp.disconnected": "WhatsApp scollegato",
	"phone.connected": "Numero di telefono collegato",
	"phone.disconnected": "Numero di telefono scollegato",
	"secret.set": "Chiave salvata",
	"secret.deleted": "Chiave tolta",
	"cost.warn": "Spesa oltre la soglia di avviso",
	"cost.denied": "Tetto di spesa raggiunto",
	"model.failed": "Il modello non ha risposto",
	"egress.denied": "Sito non consentito bloccato",
	"skill.saved": "Skill salvata",
	"skill.deleted": "Skill eliminata",
	"skill.used": "Skill usata",
	"skill.read": "Skill letta",
	"skill.activated": "Skill attivata",
	"memory.saved": "Memoria salvata",
	"memory.forgotten": "Memoria dimenticata",
	"web_search.ran": "Ricerca sul web",
	"web_search.allowed": "Ricerca sul web consentita",
	"research.gathered": "Fonti raccolte per una ricerca",
	"research.reported": "Ricerca approfondita consegnata",
	"image.generated": "Immagine creata",
	"images.allowed": "Immagini consentite",
	"weather.ran": "Meteo chiesto",
	"recording.transcribed": "Registrazione trascritta",
	"voice.allowed": "Chiamate consentite",
	"speech.allowed": "Risposte a voce consentite",
	"web_action.approved": "Modulo approvato",
	"web_action.rejected": "Modulo rifiutato",
	"web_action.uncertain": "Modulo dall'esito incerto",
	"web_actions.allowed": "Moduli sul web consentiti",
	"computer.ran": "Comando sul computer",
	"computer.failed": "Comando sul computer non riuscito",
	"computer.reset": "Computer azzerato",
	"computer.allowed": "Computer consentito",
	"desktop.action": "Azione sullo schermo",
	"desktop.failed": "Azione sullo schermo non riuscita",
	"desktop.reset": "Schermo azzerato",
	"desktop.allowed": "Schermo consentito",
	"agents.allowed": "Agenti consentiti",
};
/** Detail keys in words; ids of people and agents become their names, empty counters drop out. */
const AUDIT_KEYS = { personId: "chi", instanceId: "agente", modelProvider: "modello", provider: "modello", model: "modello", cron: "orario", reason: "motivo", host: "sito", tool: "strumento", name: "nome", title: "titolo", channel: "canale", error: "errore", count: "quanti", card: "scheda", allowedModelProviders: "provider consentiti", allowedChannels: "canali consentiti", modelProviders: "provider", channels: "canali", instanceName: "agente", role: "ruolo", from: "da", to: "a" };

/** An event that went wrong or was stopped reads in red. */
const AUDIT_BAD = /\.(failed|denied|refused|uncertain|rejected|retries_exhausted|invalid_sender|update_failed|login_denied)$/;

/**
 * The audit as a day-by-day log: filter by where events come from, read the details as name and value,
 * and only the latest few rows until asked for more (the page holds up to 200).
 */
function auditLog(events, raw, names) {
	// Internal ids, counters and sizes stay in the tooltip; people and agents show by name.
	const quiet = (k, v) => v === "" || v === "0" || v === "false" || ((/Id$|^id$/.test(k) || k === "chars" || k === "status") && !names.has(v)) || (k === "attempts" && v === "1");
	const details = (e) =>
		raw(e)
			.filter(([k, v]) => !quiet(k, v))
			.map(([k, v]) => (names.has(v) ? ["", names.get(v)] : k === "bytes" ? ["", fmt.bytes(Number(v))] : k === "path" ? ["", v] : [AUDIT_KEYS[k] ?? k, v]));
	const PAGE = 40;
	let group = null;
	let shown = PAGE;
	const list = h("div.audit-days");
	const more = h("button.btn.ghost.small", { type: "button", onclick: () => ((shown += PAGE), draw()) });
	const dayOf = (iso) => {
		const at = new Date(iso);
		const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
		return days === 0 ? "Oggi" : days === 1 ? "Ieri" : at.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
	};
	const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "");
	const row = ([e, times, last]) => {
		const [, glyph] = auditGroup(e.type);
		const pairs = details(e);
		const at = e.ts ?? e.at;
		const span = times > 1 && clock(last) !== clock(at) ? `${clock(last)}–${clock(at)}` : clock(at);
		return h(
			`li.task-row.audit-row${AUDIT_BAD.test(e.type) ? ".bad" : ""}`,
			{ title: [e.type, ...raw(e).map(([k, v]) => `${k}: ${v}`)].join("\n") },
			h("span.fold-glyph", icon(glyph)),
			h(
				"div.task-text",
				h("b", AUDIT_SAY[e.type] ?? h("span.mono", e.type), times > 1 ? h("span.audit-times", `×${times}`) : null),
				pairs.length ? h("small.audit-pairs", pairs.map(([k, v]) => h("span", k ? h("i", k) : null, v.length > 60 ? `${v.slice(0, 60)}…` : v))) : null,
			),
			h("time.audit-when", { datetime: at }, span),
		);
	};
	const draw = () => {
		const picked = group === null ? events : events.filter((e) => auditGroup(e.type)[0] === group);
		// The same event again and again (every login, every retry) is one row with a count.
		const rows = [];
		for (const e of picked) {
			const key = JSON.stringify([e.type, details(e), dayOf(e.ts ?? e.at)]);
			if (rows.at(-1)?.[3] === key) {
				rows.at(-1)[1]++;
				rows.at(-1)[2] = e.ts ?? e.at;
			} else rows.push([e, 1, e.ts ?? e.at, key]);
		}
		const days = [];
		for (const r of rows.slice(0, shown)) {
			const day = dayOf(r[0].ts ?? r[0].at);
			if (days.at(-1)?.[0] !== day) days.push([day, []]);
			days.at(-1)[1].push(r);
		}
		mount(list, days.map(([day, items]) => h("section.audit-day", h("h3", day), h("ul.task-list", items.map(row)))));
		more.hidden = rows.length <= shown;
		more.textContent = `Mostra altri ${Math.min(PAGE, rows.length - shown)}`;
	};
	const counts = new Map();
	for (const e of events) counts.set(auditGroup(e.type)[0], (counts.get(auditGroup(e.type)[0]) ?? 0) + 1);
	const chips = h(
		"div.choices.audit-filter",
		{ role: "group", "aria-label": "Quali eventi" },
		[[null, events.length], ...AUDIT_GROUPS.filter(([name]) => counts.has(name)).map(([name]) => [name, counts.get(name)])].map(([name, n]) =>
			h(
				"button",
				{
					type: "button",
					"aria-pressed": name === group ? "true" : "false",
					onclick: (e) => {
						group = name;
						shown = PAGE;
						for (const b of chips.children) b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false");
						draw();
					},
				},
				`${name ?? "Tutti"} · ${n}`,
			),
		),
	);
	draw();
	return h("div.audit", chips, list, h("div.audit-more", more));
}

export async function viewActivity(main) {
	const { usage } = await api("/api/usage");
	const owner = state.me.role === "owner";
	const audit = owner ? (await api("/api/audit?limit=200")).events : [];
	const { people } = owner ? await api("/api/people").catch(() => ({ people: [] })) : { people: [] };
	const names = new Map([...state.instances.map((i) => [i.id, i.name]), ...people.map((p) => [p.id, p.name])]);
	const share = Math.min(1, usage.todayUsd / usage.hardUsd);
	const details = (e) => {
		const { at: _at, ts: _ts, type: _type, tenantId: _tenant, ...rest } = e;
		return Object.entries(rest).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
	};
	mount(main, 
		head(null, h("h1", "Attività e spesa"), "Quanto hanno speso oggi gli agenti in modelli AI, e cosa è successo."),
		h(
			"div.stack",
			runHistory(state.instances),
			h(
				"div.card.pad",
				h("h3.section-title", "Oggi"),
				h("div.row-gap", h("span", h("b", money.format(usage.todayUsd))), h("span.muted", `soglia di avviso ${money.format(usage.softUsd)} · tetto ${money.format(usage.hardUsd)}`)),
				h("div.spend", h("div.bar", h(`i${share >= 1 ? ".bad" : usage.todayUsd >= usage.softUsd ? ".warn" : ""}`, { "data-w": share }))),
				h("p.muted", "Oltre il tetto Owni smette di chiamare il modello fino a domani; l'invio di bozze già approvate continua."),
			),
			owner
				? h(
						"div.card",
						audit.length
							? auditLog(audit, details, names)
							: emptyNote("div.empty", "Nessun evento"),
					)
				: h("div.card.empty", "L'audit completo è visibile all'owner."),
		),
	);
	const bar = main.querySelector(".spend .bar i");
	if (bar) requestAnimationFrame(() => (bar.style.width = `${Math.max(2, Number(bar.dataset.w) * 100)}%`));
}

