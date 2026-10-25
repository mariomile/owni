// Person-facing work and automation overviews. The source APIs remain the authority on visibility.
import { api, dmHref, emptyNote, h, head, icon, instanceHref, mount, route, state } from "../common.js";

const BOARD_STATUS = { da_fare: "Da fare", in_corso: "In corso", da_rivedere: "Da rivedere", fatto: "Fatto" };
const RUN_STATUS = { queued: "In coda", running: "In corso", succeeded: "Risposta pronta", failed: "Non riuscita", cancelled: "Interrotta" };
const RUN_SOURCE = { message: "Conversazione", schedule: "Lavoro programmato", brief: "Brief del mattino", watch: "Cambiamento di pagina", automation: "Evento esterno", notice: "Avviso", agent: "Passaggio tra agenti" };
const FILTERS = [["tutti", "Tutti"], ["in_corso", "In corso"], ["attenzione", "Richiede te"], ["conclusi", "Conclusi"]];
const CHANNEL = { web: "Console", telegram: "Telegram", whatsapp: "WhatsApp" };
const PROGRAM_CHOICES = [
	["orario", "A un orario", "Una data o una frequenza, con il suo fuso orario.", "task", ["orario"], "task"],
	["pagina", "Quando cambia una pagina", "Controlla una pagina e avvisa quando cambia o supera una soglia.", "task", ["pagina"], "browser"],
	["evento", "Quando arriva un evento", "Un servizio esterno chiama l'agente con i dati dell'evento.", "automazioni", ["nuovo"], "automazioni"],
	["incarico", "Ripeti un incarico", "Crea un incarico a ogni scadenza, dopo la chiusura del precedente.", "board", ["ripeti"], "board"],
];

const clock = (at) => at ? new Date(at).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Non registrato";
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zonedClock = (at, timeZone = localZone) => `${new Date(at).toLocaleString("it-IT", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${timeZone}`;
const romeClock = (at) => `${new Date(at).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · Europe/Rome`;
const short = (value, max = 220) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const newest = (a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""));
const hostOf = (url) => { try { return new URL(url).host; } catch { return "il sito indicato nel dettaglio"; } };
const pageLabel = (url) => { try { const page = new URL(url); return `${page.host}${page.pathname === "/" ? "" : page.pathname}`; } catch { return "Pagina da controllare"; } };
const activeRun = (run) => run.status === "queued" || run.status === "running";

/** Same recipient rule as the console summary: being the owner does not take another person's review. */
export function needsBoardReview(card, viewer) {
	return card.status === "da_rivedere" && (card.work && card.work.agent === card.assignee ? card.work.personId === viewer.id : viewer.role === "owner");
}

export function runOutcome(run) {
	if (run.cancelRequestedAt && activeRun(run)) return "Interruzione in corso";
	const status = RUN_STATUS[run.status] ?? run.status;
	if (run.status !== "succeeded") return status;
	return `${status}${run.delivery === "failed" ? " · Consegna non riuscita" : run.delivery === "pending" ? " · Consegna in attesa" : run.delivery === "delivered" ? " · Consegnata" : ""}`;
}

function googleSummary(action) {
	const mail = action.mail;
	const recipients = [...(mail?.to ?? []), ...(mail?.cc ?? []).map((email) => `Cc: ${email}`)].join(", ");
	if (action.kind === "mail.send" || action.kind === "mail.draft") return {
		title: `${action.kind === "mail.send" ? "Invia la mail" : "Salva la bozza"}: ${mail?.subject ?? "Senza oggetto"}`,
		consequence: `${action.kind === "mail.send" ? "Invia una mail" : "Salva una bozza in Gmail"} per ${recipients || "i destinatari nel dettaglio"} · Account ${action.account}.${mail?.attachments?.length ? ` Con ${mail.attachments.length} allegati.` : ""}`,
	};
	const verb = { "calendar.create": "Crea l'evento", "calendar.update": "Modifica l'evento", "calendar.delete": "Cancella l'evento" }[action.kind] ?? "Modifica Google";
	return { title: `${verb}: ${action.current?.summary ?? action.event?.summary ?? "Leggi il dettaglio"}`, consequence: `${verb} su ${action.account}.${action.notify ? " Google avvisa gli invitati." : " Senza inviare avvisi agli invitati."}` };
}

/** Keep approval types and their exact targets; no approval is executed from this overview. */
export function pendingApprovalRows(groups = []) {
	return groups.flatMap((group) => {
		const inst = group.instance;
		const row = (type, item, title, consequence, extra = "") => ({ kind: "approval", id: `${type}:${inst.id}:${item.id ?? item.praticaId}`, agentId: inst.id, agentName: inst.name, type, title, consequence, detail: extra, status: "pending", statusLabel: "Decisione richiesta", attention: true, active: false, concluded: false, at: item.proposedAt ?? item.updatedAt ?? item.createdAt, href: instanceHref("approvazioni", [type, inst.id, item.id ?? item.praticaId], null), action: "Leggi e decidi" });
		return [
			...(group.proposals ?? []).filter((item) => item.status === "pending").map((item) => row("proposal", item, `Attiva lo strumento ${item.name}`, `Consente a ${inst.name} di usare custom_${item.name}${item.hosts?.length ? ` sui siti ${item.hosts.join(", ")}` : " senza accesso alla rete"}.`, short(item.description))),
			...(group.webActions ?? []).filter((item) => item.status === "pending").map((item) => row("web", item, `Invia il modulo a ${hostOf(item.action)}`, "Invia una volta il modulo con i valori mostrati nel dettaglio.", short(item.reason))),
			...(group.connectorActions ?? []).filter((item) => item.status === "pending").map((item) => row("connector", item, `${item.toolTitle || item.tool} · ${item.connectorName}`, `Esegue ${item.tool} su ${item.connectorName}.${item.destructive ? " Può cancellare o sovrascrivere dati." : ""}`, short(item.reason))),
			...(group.agentRequests ?? []).filter((item) => item.status === "pending").map((item) => row("agent", item, item.what || item.tool, `${inst.name} esegue una volta ${item.tool}, richiesto da ${item.askedBy?.name ?? "un altro agente"}, con i valori nel dettaglio.`, short(item.preview))),
			...(group.googleActions ?? []).filter((item) => item.status === "pending").map((item) => { const summary = googleSummary(item); return row("google", item, summary.title, summary.consequence, short(item.reason)); }),
			...(group.pratiche ?? []).filter((item) => item.status === "draft_ready").map((item) => row("pratica", item, `Bozza commerciale: ${item.lead?.rawSubject ?? item.lead?.company ?? item.praticaId}`, `Leggi la bozza e decidi l'invio a ${item.lead?.email ?? item.lead?.fullName ?? "il cliente indicato nel dettaglio"}.`, short(item.lead?.company))),
		];
	}).sort(newest);
}

/** Board records stay separate from executions: a reply is not an accepted assignment. */
export function workRows(board = {}, runGroups = [], viewer = {}) {
	const cards = board.cards ?? [];
	const byId = new Map(cards.map((card) => [card.id, card]));
	const agents = new Map((board.agents ?? []).map((agent) => [agent.id, agent]));
	const assignments = cards.map((card) => {
		const waiting = card.status === "fatto" ? [] : (card.after ?? []).map((id) => byId.get(id)).filter((before) => !before || before.status !== "fatto");
		const reviewIndex = (card.events ?? []).findLastIndex((event) => event.kind === "status" && event.status === "da_rivedere");
		const result = reviewIndex < 0 || !["da_rivedere", "fatto"].includes(card.status) ? undefined : card.events.slice(reviewIndex).find((event) => event.kind === "comment" && event.by.kind === "agent")?.text;
		const attention = needsBoardReview(card, viewer);
		const blockers = waiting.length ? `In attesa di ${waiting.map((before) => before ? `#${before.n}` : "un incarico non visibile").join(", ")}${card.queued ? "; poi parte da solo" : ""}.` : card.queued ? "In attesa di avvio automatico." : "";
		return { kind: "board", id: card.id, agentId: card.assignee ?? "", agentName: card.assignee ? agents.get(card.assignee)?.name ?? "Agente non disponibile" : "Non assegnato", title: `#${card.n} ${card.title}`, status: card.status, statusLabel: BOARD_STATUS[card.status] ?? card.status, attention, active: card.status === "in_corso", concluded: card.status === "fatto", at: card.updatedAt, detail: short(result ?? card.description), consequence: attention ? "Accettare il risultato chiude l'incarico. Gli invii richiedono la propria approvazione." : "", blockers, due: card.due, href: `#/board/${encodeURIComponent(card.id)}`, action: attention ? "Rivedi il risultato" : "Apri incarico" };
	});
	const executions = runGroups.flatMap(({ instance, runs = [], threads = [] }) => runs.map((run) => {
		const thread = threads.find((item) => item.id === run.threadId);
		const card = cards.find((item) => item.work?.agent === instance.id && item.work.threadId === run.threadId && item.work.personId === viewer.id);
		const problem = run.status === "failed" || run.delivery === "failed";
		// An old failed execution is an outcome, not a new decision waiting for the viewer.
		return { kind: "run", id: `${instance.id}:${run.id}`, agentId: instance.id, agentName: instance.name, title: thread?.title || (card ? `#${card.n} ${card.title}` : `${RUN_SOURCE[run.source] ?? "Esecuzione"} · ${run.id.slice(0, 8)}`), status: run.status, statusLabel: runOutcome(run), attention: false, problem, active: activeRun(run), concluded: ["succeeded", "failed", "cancelled"].includes(run.status), at: run.updatedAt ?? run.createdAt, detail: run.status === "failed" ? "L'agente non ha completato questa esecuzione. Apri la conversazione per verificare il problema." : run.delivery === "failed" ? "La risposta è pronta, ma la consegna non è riuscita. Verifica la conversazione prima di riprovare." : run.status === "cancelled" ? "Esecuzione interrotta. Le azioni già effettuate restano." : run.status === "succeeded" ? "Apri la conversazione per leggere il risultato e verificare eventuali decisioni ancora necessarie." : "Il lavoro prosegue nella tua conversazione.", sourceLabel: RUN_SOURCE[run.source] ?? run.source, href: dmHref(instance.id, run.threadId), action: problem ? "Vedi problema" : "Apri conversazione" };
	}));
	return [...assignments, ...executions].sort(newest);
}

export function matchesWorkFilter(row, filter, agentId = "") {
	if (agentId && (agentId === "__unassigned" ? row.kind !== "board" || row.agentId : row.agentId !== agentId)) return false;
	return filter === "attenzione" ? row.attention : filter === "in_corso" ? row.active : filter === "conclusi" ? row.concluded : true;
}

// Each failed read keeps its last successful snapshot, visibly marked as partial until a retry succeeds.
async function readSource(sources, key, label, url, fields, agentId = "") {
	const previous = sources.get(key);
	try {
		const data = await api(url);
		if (fields.some((field) => !Array.isArray(data[field]))) throw new Error("Risposta del server non valida");
		sources.set(key, { key, label, data, agentId });
	} catch (error) {
		// A revoked or concealed resource must disappear; only transient read failures keep a snapshot.
		const denied = key === "approvals" || [401, 403, 404].includes(error.status);
		sources.set(key, { ...(denied ? {} : previous), key, label, agentId, error: error.message ?? "Server non raggiungibile" });
	}
}

/** A failed Board read cannot retain a snapshot with an unknown or changed authorization roster. */
function invalidateBoardSnapshot(sources, previousInstances) {
	const current = sources.get("instances");
	if (current?.error || !current?.data) return;
	const visibility = (instances) => JSON.stringify(instances.map((instance) => [instance.id, Boolean(instance.canChat), Boolean(instance.isApprover), Boolean(instance.hasSegreteria)]).sort((a, b) => a[0].localeCompare(b[0])));
	if ((!previousInstances || visibility(previousInstances) !== visibility(current.data.instances)) && sources.get("board")?.error) delete sources.get("board").data;
}

function sourceErrors(sources, agentId, retry) {
	const errors = [...sources.values()].filter((source) => source.error && (!agentId || !source.agentId || source.agentId === agentId));
	return errors.length ? h("div.work-source-errors", { role: "status" }, h("p.error", "Vista parziale: alcune fonti non sono disponibili. I conteggi riguardano solo gli elementi caricati; i dati precedenti possono essere cambiati."), h("ul", errors.map((source) => h("li.small", `${source.label}: ${source.error}`))), h("button.btn.small", { type: "button", onclick: retry }, "Riprova le fonti")) : null;
}

function updateAgentOptions(select, instances, unassigned = false) {
	const previous = select.value;
	const all = new Map(instances.map((instance) => [instance.id, instance]));
	mount(select, h("option", { value: "" }, "Tutti gli agenti"), [...all.values()].sort((a, b) => a.name.localeCompare(b.name)).map((instance) => h("option", { value: instance.id }, instance.name)), unassigned ? h("option", { value: "__unassigned" }, "Non assegnati") : null);
	select.value = all.has(previous) || (unassigned && previous === "__unassigned") ? previous : "";
}

function workRow(row) {
	return h("li.task-row.work-row", h(`span.chip${row.problem ? ".bad" : row.attention ? ".warn" : row.concluded && row.status !== "failed" && row.status !== "cancelled" ? ".ok" : ""}`, row.statusLabel),
		h("div.task-text", h("b", row.title), h("small", row.agentName, row.sourceLabel ? ` · ${row.sourceLabel}` : "", row.at ? ` · ${clock(row.at)}` : ""),
			row.detail ? h("p.small.work-description", row.detail) : null, row.blockers ? h("p.small.work-blockers", row.blockers) : null,
			row.due ? h("small", `Scadenza ${row.due}`) : null, row.consequence ? h("p.small.work-consequence", row.consequence) : null),
		h("a.btn.small.ghost", { href: row.href }, row.action));
}

/** #/lavori and #/lavori/attenzione never inherit the conversation's selected agent. */
export async function viewWork(main) {
	const sources = new Map();
	let filter = route().rest[0] === "attenzione" ? "attenzione" : "tutti";
	let refreshing;
	const agent = h("select", { "aria-label": "Filtra i lavori per agente", onchange: () => draw() }, h("option", { value: "" }, "Tutti gli agenti"));
	const counts = h("p.muted.small", { role: "status", "aria-live": "polite" }, "Caricamento dei lavori…");
	const content = h("div.stack");
	const navigation = h("nav.row-gap.work-navigation", { "aria-label": "Viste dei lavori" });
	const refresh = h("button.btn.ghost", { type: "button", onclick: () => void load() }, "Aggiorna");
	const tabs = FILTERS.map(([value, label]) => h("button.chip", { type: "button", "aria-pressed": String(value === filter), onclick: () => { filter = value; draw(); } }, label));
	mount(main, head(null, "Lavori", "Gli incarichi che puoi vedere e gli esiti nelle tue conversazioni, attraverso tutti gli agenti consentiti.", h("a.btn.accent", { href: "#/board/nuovo" }, icon("plus"), "Nuovo incarico"), refresh),
		navigation, h("div.work-toolbar", h("div.row-gap.work-filters", { role: "group", "aria-label": "Stato dei lavori" }, tabs), h("label.field", h("span", "Agente"), agent)), counts, content);
	function draw() {
		if (!main.isConnected) return;
		const board = sources.get("board")?.data ?? {};
		const instances = sources.get("instances")?.data?.instances ?? [];
		const groups = sources.get("approvals")?.data?.groups ?? [];
		const runs = instances.map((instance) => ({ instance, runs: sources.get(`runs:${instance.id}`)?.data?.runs ?? [], threads: sources.get(`threads:${instance.id}`)?.data?.threads ?? [] }));
		const all = [...workRows(board, runs, state.me), ...pendingApprovalRows(groups)].sort(newest);
		const shown = all.filter((row) => matchesWorkFilter(row, filter, agent.value));
		const partial = [...sources.values()].some((source) => source.error && (!agent.value || !source.agentId || source.agentId === agent.value));
		tabs.forEach((tab, index) => { tab.setAttribute("aria-pressed", String(FILTERS[index][0] === filter)); if (FILTERS[index][0] === "attenzione") tab.textContent = `Richiede te · ${all.filter((row) => row.attention && matchesWorkFilter(row, "tutti", agent.value)).length}${partial || refreshing ? "+" : ""}`; });
		counts.textContent = `${counted(shown.filter((row) => row.kind === "board").length, "incarico", "incarichi")} · ${counted(shown.filter((row) => row.kind === "approval").length, "decisione", "decisioni")} · ${counted(shown.filter((row) => row.kind === "run").length, "esecuzione recente", "esecuzioni recenti")}${partial ? " · Dati parziali" : ""}${refreshing ? " · Aggiornamento…" : ""}`;
		const section = (kind, title, note) => { const rows = shown.filter((row) => row.kind === kind); return rows.length ? h("section.card.work-section", h("div.pad", h("h2", title), note ? h("p.small.muted", note) : null), h("ul.task-list", rows.map(workRow))) : null; };
		mount(content, sourceErrors(sources, agent.value, () => void load()),
			section("approval", "Decisioni da prendere", "Leggi il dettaglio prima di decidere: attivare uno strumento, inviare una mail e accettare un risultato hanno conseguenze diverse."),
			section("board", "Incarichi"), section("run", "Esecuzioni nelle tue conversazioni", "Fino alle ultime 100 esecuzioni per agente. Una risposta pronta va verificata nella conversazione; non chiude un incarico."),
			!shown.length && !refreshing ? emptyNote("div.card.empty", partial ? "Nessun elemento caricato per questo filtro" : filter === "attenzione" ? "Niente richiede il tuo intervento" : "Nessun lavoro per questo filtro", partial ? "Riprova le fonti per completare la vista." : filter === "tutti" ? "Affida un nuovo incarico per seguire obiettivo, agente e risultato." : "Gli altri lavori restano disponibili in Tutti.", filter === "tutti" ? h("a.btn", { href: "#/board/nuovo" }, "Nuovo incarico") : null) : null);
	}
	async function load() {
		if (refreshing) return refreshing;
		refresh.disabled = true;
		refreshing = (async () => {
			const previousInstances = sources.get("instances")?.data?.instances;
			await Promise.all([readSource(sources, "board", "Incarichi", "/api/board", ["cards", "agents"]), readSource(sources, "approvals", "Decisioni", "/api/approvals", ["groups"]), readSource(sources, "instances", "Elenco agenti", "/api/instances", ["instances"])]);
			invalidateBoardSnapshot(sources, previousInstances);
			const instances = sources.get("instances")?.data?.instances ?? [];
			const ids = new Set(instances.map((instance) => instance.id));
			for (const [key, source] of sources) if (source.agentId && !ids.has(source.agentId)) sources.delete(key);
			for (const instance of instances.filter((item) => item.hasSegreteria)) { sources.delete(`runs:${instance.id}`); sources.delete(`threads:${instance.id}`); }
			await Promise.all(instances.flatMap((instance) => instance.hasSegreteria ? [] : [readSource(sources, `runs:${instance.id}`, `Esecuzioni · ${instance.name}`, `/api/instances/${encodeURIComponent(instance.id)}/runs`, ["runs"], instance.id), readSource(sources, `threads:${instance.id}`, `Titoli delle conversazioni · ${instance.name}`, `/api/instances/${encodeURIComponent(instance.id)}/threads`, ["threads"], instance.id)]));
			updateAgentOptions(agent, instances, true);
			mount(navigation, h("a.btn.ghost", { href: "#/board" }, icon("board"), "Vista Board"), instances.filter((instance) => instance.hasSegreteria).map((instance) => h("a.btn.ghost", { href: instanceHref("segreteria", [], instance.id) }, `Pratiche · ${instance.name}`)));
		})().finally(() => { refreshing = undefined; refresh.disabled = false; draw(); });
		draw();
		return refreshing;
	}
	let live;
	state.onRun = () => { if (!live) live = setTimeout(() => { live = undefined; if (main.isConnected) void load(); }, 300); return false; };
	state.onRunsReconnect = () => { if (main.isConnected) void load(); };
	state.onBoard = () => { if (main.isConnected) void load(); };
	const timer = setInterval(() => { if (!main.isConnected) return clearInterval(timer); if (!document.hidden) void load(); }, 30_000);
	await load();
}

function watchCondition(watch) {
	const number = (value) => Number(value).toLocaleString("it-IT");
	const prices = [watch.below != null ? `sotto ${number(watch.below)}` : "", watch.above != null ? `sopra ${number(watch.above)}` : ""].filter(Boolean);
	return prices.length ? `Prezzo ${prices.join(" o ")}${watch.what ? ` vicino a «${watch.what}»` : ""}` : watch.what ? `Cambiamenti vicino a «${watch.what}»` : "Cambiamento della pagina";
}

function destination(record, viewer, automation = false) {
	const channel = CHANNEL[record.channel] ?? record.channel ?? "Console";
	const mine = automation ? record.mine : record.createdBy?.kind === "person" && record.createdBy.channel === "web" && record.createdBy.userId === viewer.id;
	return `${channel}${mine ? " · Agisce per te" : record.createdBy?.kind === "instance" ? " · Creata dall'agente" : " · Agisce per un'altra persona"}`;
}

/** Actual automation records, retaining their different scheduling and outcome models. */
export function programRows(board = {}, groups = [], viewer = {}) {
	const agents = new Map((board.agents ?? []).map((agent) => [agent.id, agent]));
	const rows = groups.flatMap(({ instance, schedules = [], watches = [], automations = [], runs = [], runsAvailable = true }) => {
		const lastOutcome = (id, types) => {
			if (!runsAvailable) return "Esiti non disponibili: riprova la fonte delle esecuzioni.";
			const run = runs.filter((item) => item.sourceId === id && types.includes(item.source)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
			return run ? `${runOutcome(run)} · ${clock(run.createdAt)}` : "Nessun esito nelle tue ultime 100 esecuzioni.";
		};
		const base = (kind, item, view) => ({ kind, id: `${instance.id}:${kind}:${item.id}`, agentId: instance.id, agentName: instance.name, at: item.createdAt, href: instanceHref(view, [], instance.id), destination: destination(item, viewer, kind === "evento") });
		return [
			...schedules.map((item) => ({ ...base("orario", item, "task"), title: item.kind === "brief" ? "Brief del mattino" : item.instruction, typeLabel: "A un orario", statusLabel: item.disabledReason ? "Ferma" : item.nextRunAt ? "Attiva" : "Terminata", problem: item.disabledReason, when: "at" in item.when ? `Una volta · ${zonedClock(item.when.at)}` : `${item.whenText ?? item.when.cron} · ${item.when.timeZone}`, last: item.lastRunAt ? zonedClock(item.lastRunAt, item.when.timeZone) : "Nessun avvio registrato", outcome: lastOutcome(item.id, ["schedule", "brief"]), next: item.disabledReason ? "Nessun avvio finché resta ferma" : item.nextRunAt ? zonedClock(item.nextRunAt, item.when.timeZone) : "Nessun altro avvio previsto" })),
			...watches.map((item) => ({ ...base("pagina", item, "task"), title: pageLabel(item.url), detail: item.what ? `Vicino a «${item.what}»` : "Controllo della pagina", typeLabel: "Quando cambia una pagina", statusLabel: item.disabledReason || !item.nextCheckAt ? "Ferma" : item.failures > 0 ? "Errori nel controllo" : "Attiva", problem: item.disabledReason ?? item.lastError, when: `Controllo ogni ${item.everyMinutes} minuti`, last: item.lastCheckAt ? `Ultimo controllo ${clock(item.lastCheckAt)}` : "Nessun controllo registrato", outcome: `${lastOutcome(item.id, ["watch"])} · ${item.notified ?? 0} notifiche registrate`, next: `${watchCondition(item)}${item.nextCheckAt && !item.disabledReason ? ` · Prossimo controllo ${clock(item.nextCheckAt)}` : " · Controlli fermi"}` })),
			...automations.map((item) => ({ ...base("evento", item, "automazioni"), title: item.name, detail: item.instruction, typeLabel: "Quando arriva un evento", statusLabel: "Configurata", when: "Su chiamata del servizio esterno", last: item.lastRunAt ? `Ultima chiamata ${clock(item.lastRunAt)}` : "Nessuna chiamata registrata", outcome: `${lastOutcome(item.id, ["automation"])} · ${item.runs ?? 0} chiamate registrate`, next: "Attende una chiamata autorizzata dal servizio esterno" })),
		];
	});
	for (const routine of board.routines ?? []) {
		const last = (board.cards ?? []).find((card) => card.id === routine.last);
		rows.push({ kind: "incarico", id: `routine:${routine.id}`, agentId: routine.assignee, agentName: agents.get(routine.assignee)?.name ?? "Agente non disponibile", title: routine.title, detail: routine.description, typeLabel: "Ripeti un incarico", statusLabel: routine.paused ? "In pausa" : routine.problem ? "Avvio da verificare" : "Attiva", problem: routine.problem, when: `${routine.whenText ?? "Ricorrenza"} · Europe/Rome`, last: last ? `Creato #${last.n} · ${clock(last.createdAt)}` : routine.last ? "Incarico precedente non presente nella vista" : "Nessun incarico precedente", outcome: last ? `#${last.n} · ${BOARD_STATUS[last.status] ?? last.status}` : "Esito dell'incarico precedente non disponibile", next: routine.paused ? "In pausa: non crea nuovi incarichi" : `${romeClock(routine.next)}${last ? last.status !== "fatto" ? ` · Attende che #${last.n} sia Fatto` : " · Il precedente è Fatto" : routine.last ? " · Crea solo quando il precedente è Fatto" : " · Primo incarico in programma"}`, destination: routine.personId === viewer.id ? "Console · Lavora con te" : "Console · Lavora con un'altra persona", href: instanceHref("board", [], routine.assignee), lastHref: last ? `#/board/${encodeURIComponent(last.id)}` : undefined, at: routine.createdAt });
	}
	return rows.sort(newest);
}

function programRow(row) {
	return h("li.task-row.work-program-row", h("div.task-text", h("small", `${row.typeLabel} · ${row.agentName}`), h("b", { title: row.title }, short(row.title, 160)), row.detail ? h("p.small.work-description", short(row.detail)) : null,
		h("small", row.when), h("small", row.destination),
		h("dl.work-program-facts", h("dt", "Configurazione"), h("dd", row.statusLabel), h("dt", "Ultimo avvio o controllo"), h("dd", row.last), h("dt", "Ultimo esito"), h("dd", row.outcome), h("dt", "Prossimo avvio o condizione"), h("dd", row.next)),
		row.problem ? h("p.error.small", row.problem) : null), h("div.row-gap", row.lastHref ? h("a.btn.ghost.small", { href: row.lastHref }, "Ultimo incarico") : null, h("a.btn.ghost.small", { href: row.href }, "Apri configurazione")));
}

/** #/programmi groups existing models and forms; opening a form never starts a job. */
export async function viewPrograms(main) {
	const sources = new Map();
	let refreshing;
	const agent = h("select", { "aria-label": "Filtra le automazioni per agente", onchange: () => draw() }, h("option", { value: "" }, "Tutti gli agenti"));
	const counts = h("p.muted.small", { role: "status", "aria-live": "polite" }, "Caricamento delle automazioni…");
	const content = h("div.stack");
	const refresh = h("button.btn.ghost", { type: "button", onclick: () => void load() }, "Aggiorna");
	function choose(choice) {
		const [, title, description, view, rest] = choice;
		const instances = sources.get("instances")?.data?.instances ?? [];
		const board = sources.get("board")?.data;
		const allowed = instances.filter((instance) => choice[0] === "incarico" ? board?.agents.some((item) => item.id === instance.id && item.canAssign) : instance.canChat);
		const select = h("select", { "aria-label": "Agente che eseguirà l'automazione" }, h("option", { value: "" }, "Scegli un agente"), allowed.map((instance) => h("option", { value: instance.id }, instance.name)));
		select.value = allowed.some((instance) => instance.id === agent.value) ? agent.value : allowed.length === 1 ? allowed[0].id : "";
		const next = h("button.btn.accent", { type: "button", disabled: !select.value || Boolean(sources.get("instances")?.error) || (choice[0] === "incarico" && Boolean(sources.get("board")?.error)), onclick: () => { if (!select.value) return; dialog.close(); window.location.hash = instanceHref(view, rest, select.value); } }, "Apri il modulo");
		select.addEventListener("change", () => { next.disabled = !select.value || Boolean(sources.get("instances")?.error) || (choice[0] === "incarico" && Boolean(sources.get("board")?.error)); });
		const dialog = h("dialog.work-program-dialog", h("h2", title), h("p", description), h("label.field", h("span", "Agente che se ne occupa"), select),
			!allowed.length ? h("p.muted", "Non hai agenti a cui puoi affidare questa automazione.") : null,
			sources.get("instances")?.error || (choice[0] === "incarico" && sources.get("board")?.error) ? h("p.error", "Aggiorna le fonti prima di scegliere un agente.") : null,
			h("p.small.muted", "Nel modulo scegli istruzione, frequenza o condizione e destinatario. L'automazione si salva solo alla conferma."), h("div.actions", next, h("button.btn.ghost", { type: "button", onclick: () => dialog.close() }, "Annulla")));
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		select.focus();
	}
	mount(main, head(null, "Automazioni", "Quando deve partire il lavoro: per orario, cambiamento di una pagina, evento esterno o incarico ricorrente.", h("a.btn.ghost", { href: "#/lavori" }, "Torna ai lavori"), refresh),
		h("section.card.pad", h("h2", "Quando deve partire?"), h("div.work-program-choices", PROGRAM_CHOICES.map((choice) => h("button.work-program-choice", { type: "button", onclick: () => choose(choice) }, icon(choice[5]), h("b", choice[1]), h("span.small.muted", choice[2]))))),
		h("div.work-toolbar", h("h2", "Automazioni configurate"), h("label.field", h("span", "Agente"), agent)), counts, h("p.small.muted", "Le configurazioni rispettano gli accessi di ogni agente. Gli esiti delle esecuzioni riguardano solo le tue conversazioni. Mettere in pausa una configurazione riguarda i prossimi avvii; le esecuzioni in corso si controllano dal lavoro."), content);
	function draw() {
		if (!main.isConnected) return;
		const instances = sources.get("instances")?.data?.instances ?? [];
		const groups = instances.map((instance) => ({ instance, schedules: sources.get(`schedules:${instance.id}`)?.data?.schedules ?? [], watches: sources.get(`watches:${instance.id}`)?.data?.watches ?? [], automations: sources.get(`automations:${instance.id}`)?.data?.automations ?? [], runs: sources.get(`runs:${instance.id}`)?.data?.runs ?? [], runsAvailable: Boolean(sources.get(`runs:${instance.id}`)?.data) && !sources.get(`runs:${instance.id}`)?.error }));
		const rows = programRows(sources.get("board")?.data ?? {}, groups, state.me).filter((row) => !agent.value || row.agentId === agent.value);
		const partial = [...sources.values()].some((source) => source.error && (!agent.value || !source.agentId || source.agentId === agent.value));
		counts.textContent = `${counted(rows.length, "automazione caricata", "automazioni caricate")}${agent.value ? ` · ${agent.selectedOptions[0]?.textContent ?? "Agente selezionato"}` : " · Tutti gli agenti"}${partial ? " · Dati parziali" : ""}${refreshing ? " · Aggiornamento…" : ""}`;
		mount(content, sourceErrors(sources, agent.value, () => void load()), rows.length ? h("div.card", h("ul.task-list", rows.map(programRow))) : !refreshing ? emptyNote("div.card.empty", partial ? "Nessuna automazione caricata" : "Nessuna automazione per questo filtro", partial ? "Riprova le fonti per completare la vista." : "Scegli quando deve partire il lavoro, poi l'agente che se ne occupa.") : null);
	}
	async function load() {
		if (refreshing) return refreshing;
		refresh.disabled = true;
		refreshing = (async () => {
			const previousInstances = sources.get("instances")?.data?.instances;
			await Promise.all([readSource(sources, "instances", "Elenco agenti", "/api/instances", ["instances"]), readSource(sources, "board", "Incarichi ricorrenti", "/api/board", ["cards", "agents"])]);
			invalidateBoardSnapshot(sources, previousInstances);
			const instances = sources.get("instances")?.data?.instances ?? [];
			const ids = new Set(instances.map((instance) => instance.id));
			for (const [key, source] of sources) if (source.agentId && !ids.has(source.agentId)) sources.delete(key);
			for (const instance of instances.filter((item) => item.hasSegreteria)) sources.delete(`runs:${instance.id}`);
			await Promise.all(instances.flatMap((instance) => (instance.hasSegreteria ? ["schedules", "watches", "automations"] : ["schedules", "watches", "automations", "runs"]).map((name) => readSource(sources, `${name}:${instance.id}`, `${{ schedules: "Orari", watches: "Pagine", automations: "Eventi", runs: "Esiti" }[name]} · ${instance.name}`, `/api/instances/${encodeURIComponent(instance.id)}/${name}`, [name], instance.id))));
			updateAgentOptions(agent, instances);
		})().finally(() => { refreshing = undefined; refresh.disabled = false; draw(); });
		draw();
		return refreshing;
	}
	state.onRunsReconnect = () => { if (main.isConnected) void load(); };
	state.onBoard = () => { if (main.isConnected) void load(); };
	const timer = setInterval(() => { if (!main.isConnected) return clearInterval(timer); if (!document.hidden) void load(); }, 30_000);
	await load();
}
