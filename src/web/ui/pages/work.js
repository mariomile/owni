// The automation overview, across agenti. The source APIs remain the authority on visibility.
import { api, emptyNote, h, head, icon, instanceHref, mount, state } from "../common.js";

const BOARD_STATUS = { da_fare: "Da fare", in_corso: "In corso", da_rivedere: "Da rivedere", fatto: "Fatto" };
const RUN_STATUS = { queued: "In coda", running: "In corso", succeeded: "Risposta pronta", failed: "Non riuscita", cancelled: "Interrotta" };
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
const pageLabel = (url) => { try { const page = new URL(url); return `${page.host}${page.pathname === "/" ? "" : page.pathname}`; } catch { return "Pagina da controllare"; } };
const activeRun = (run) => run.status === "queued" || run.status === "running";

export function runOutcome(run) {
	if (run.cancelRequestedAt && activeRun(run)) return "Interruzione in corso";
	const status = RUN_STATUS[run.status] ?? run.status;
	if (run.status !== "succeeded") return status;
	return `${status}${run.delivery === "failed" ? " · Consegna non riuscita" : run.delivery === "pending" ? " · Consegna in attesa" : run.delivery === "delivered" ? " · Consegnata" : ""}`;
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
	mount(main, head(null, "Automazioni", "Quando deve partire il lavoro: per orario, cambiamento di una pagina, evento esterno o incarico ricorrente.", refresh),
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
