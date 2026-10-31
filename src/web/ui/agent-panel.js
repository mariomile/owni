// The agente's panel (ADR 0114): who it is and what it has, next to a conversation. Its
// configuration stays on its own page, for the owner.
import { agentStatus, api, channelName, confirmDialog, dmHref, emptyNote, face, fmt, h, icon, instanceHref, mount, state, toast } from "./common.js";
import { filesSection, memorySection, skillsSection } from "./agent-materials.js";
import { activeRun, runText } from "./runs.js";

/** The sections of the panel, in order; the id is the last part of `#/dm/<agente>/info/<id>`. */
export const AGENT_SECTIONS = [
	["attivita", "Attività"],
	["artifact", "Artifact"],
	["routine", "Routine"],
	["memoria", "Memoria"],
	["documenti", "Documenti"],
	["procedure", "Procedure"],
];

/** How many rows a list shows before «Mostra tutti». */
const FOLD = 6;

/** A list that shows its first rows, and the rest on request. */
export function folded(rows, empty) {
	if (rows.length === 0) return empty;
	const list = h("ul.task-list", rows.slice(0, FOLD));
	if (rows.length <= FOLD) return list;
	const more = h("button.btn.ghost.small.agent-more", { type: "button", onclick: () => { mount(list, rows); more.remove(); } }, `Mostra tutti (${rows.length})`);
	return [list, more];
}

/** Where an artifact was made, as the rail names it. */
export function madeIn(where) {
	if (where?.kind === "dm") return "Messaggi diretti";
	if (where?.kind === "thread") return `Thread «${where.title}»`;
	if (where?.kind === "chat") return `«${where.title}»`;
	if (where?.kind === "channel") return where.title ? `${channelName(where.title)}${where.inThread ? " · thread" : ""}` : "Un canale";
	return "";
}

/** One routine of the agente, said in a line: what it is, when, and whether it is running. */
export function routineRows(inst, { schedules = [], watches = [], automations = [], routines = [] }, changed) {
	const act = (label, cls, onclick) => h(`button.btn.small${cls}`, { type: "button", onclick }, label);
	const call = async (path, method, done) => {
		try {
			await api(`/api/instances/${inst.id}/${path}`, { method });
			toast(done);
			changed();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const ask = (title, text, ok, path, done) => () => confirmDialog(title, text, ok, () => void call(path, "DELETE", done));
	const host = (url) => { try { const page = new URL(url); return `${page.host}${page.pathname === "/" ? "" : page.pathname}`; } catch { return url; } };
	const row = (glyph, title, line, problem, ...actions) => h("li.task-row.agent-routine", h("span.fold-glyph", icon(glyph)), h("div.task-text", h("b", { title }, title), h("small", line), problem ? h("small.error", problem) : null), h("div.person-actions", actions));
	return [
		...schedules.map((s) => {
			const title = s.kind === "brief" ? "Brief del mattino" : s.instruction;
			const when = "at" in s.when ? "Una volta" : s.whenText ? s.whenText[0].toUpperCase() + s.whenText.slice(1) : `${s.when.cron} (${s.when.timeZone})`;
			const status = s.disabledReason ? "ferma" : s.nextRunAt ? `prossima ${fmt.time(s.nextRunAt)}` : "terminata";
			return row("task", title, `${when} · ${status}`, s.disabledReason, act("Elimina", ".ghost.task-remove", ask("Eliminare questo orario?", title, "Elimina", `schedules/${s.id}`, "Orario eliminato")));
		}),
		...watches.map((w) => {
			const stopped = w.disabledReason || !w.nextCheckAt;
			return row("search", host(w.url), `Controlla ogni ${w.everyMinutes} min${w.what ? `, vicino a «${w.what}»` : ""} · ${stopped ? "ferma" : w.failures > 0 ? "errori nel controllo" : "attiva"}`, w.disabledReason ?? w.lastError,
				w.disabledReason || w.failures > 0 ? act("Riattiva", "", () => void call(`watches/${w.id}/resume`, "POST", "Sentinella riattivata")) : null,
				act("Elimina", ".ghost.task-remove", ask("Eliminare questa sentinella?", host(w.url), "Elimina", `watches/${w.id}`, "Sentinella eliminata")));
		}),
		...automations.map((a) => row("automazioni", a.name, `Quando arriva un evento esterno · ${a.runs === 1 ? "1 chiamata" : `${a.runs ?? 0} chiamate`}`, null,
			act("Elimina", ".ghost.task-remove", ask(`Cancellare «${a.name}»?`, "L'indirizzo smette di funzionare: il servizio che lo chiama riceverà un errore.", "Cancella", `automations/${a.id}`, "Automazione cancellata")))),
		...routines.map((r) => row("board", r.title, `${r.whenText ?? "Incarico ricorrente"} · ${r.paused ? "in pausa" : r.problem ? "avvio da verificare" : "attiva"}`, r.problem, h("a.btn.small.ghost", { href: instanceHref("board", [], inst.id) }, "Apri"))),
	];
}

/**
 * The panel of `inst`, next to a conversation (full width on a phone, with a way back).
 * `onShow`/`onHide`: it opened or closed, for the page to close the other panels and keep its address.
 * `openArtifact(threadId, artifact)` and `openFile(path)`: a page opens in the page's artifact panel.
 * `computer`: in a conversation, the agente's computer there (screen-panel.js), its last tab.
 */
export function agentPanel(inst, { onShow = () => {}, onHide = () => {}, openArtifact, openFile, computer } = {}) {
	let current = "attivita";
	/** The section on screen: a load that ends after another tab opened shows nothing. */
	let shown;
	const status = h("p.agent-panel-status.muted.small");
	const body = h("div.agent-panel-body");
	const named = computer ? [...AGENT_SECTIONS, ["computer", "Computer"]] : AGENT_SECTIONS;
	const tabs = named.map(([id, label]) => h("button.agent-tab", { type: "button", role: "tab", "data-section": id, "aria-selected": "false", onclick: () => select(id) }, label));
	const el = h(
		"aside.browser-panel.agent-panel",
		{ hidden: true, "aria-label": inst.name },
		h(
			"div.browser-head",
			h("button.icon-btn.agent-back", { type: "button", title: "Torna alla conversazione", "aria-label": "Torna alla conversazione", onclick: () => show(false) }, icon("back")),
			h("span.agent-head-gap"),
			state.me?.role === "owner" ? h("a.icon-btn", { href: instanceHref("impostazioni", [], inst.id), title: `Configura ${inst.name}`, "aria-label": `Configura ${inst.name}` }, icon("impostazioni")) : null,
			h("button.icon-btn.agent-close", { type: "button", title: "Chiudi", "aria-label": `Chiudi ${inst.name}`, onclick: () => show(false) }, icon("close")),
		),
		// Who it is, large and centred, as in Grok Bot.
		h("div.agent-hero", face(inst, 72), h("h2.page-title", inst.name), inst.tagline ? h("p.agent-panel-tagline", inst.tagline) : null, status),
		h("div.agent-tabs", { role: "tablist", "aria-label": `Sezioni di ${inst.name}` }, tabs),
		body,
	);
	const sections = {
		attivita: async (box) => {
			const { runs } = await api(`/api/instances/${inst.id}/runs`);
			const ordered = [...runs.filter(activeRun), ...runs.filter((run) => !activeRun(run))];
			mount(box, folded(ordered.map((run) => {
				const said = runText(run);
				return h("li.task-row.run-row", h(`span.chip${run.status === "failed" ? ".bad" : run.status === "succeeded" ? ".ok" : ""}`, said.status), h("div.task-text", h("b", said.source), h("small", fmt.time(run.createdAt))), h("a.btn.ghost.small", { href: dmHref(inst.id, run.threadId) }, "Apri"));
			}), emptyNote("div.empty", "Ancora niente", `Quando ${inst.name} lavora per te, da una chat, un orario o un'automazione, lo vedi qui.`)));
		},
		artifact: async (box) => {
			const { artifacts } = await api(`/api/instances/${inst.id}/artifacts`);
			mount(box, folded(artifacts.map((a) => h("li.task-row.agent-artifact",
				h("span.artifact-mark", icon("artifact")),
				h("div.task-text", h("b", a.title), h("small", [madeIn(a.where), `v${a.version}`, fmt.time(a.at)].filter(Boolean).join(" · "))),
				h("button.btn.small", { type: "button", onclick: () => openArtifact?.(a.threadId, { id: a.id, version: a.version, title: a.title }) }, "Apri"),
			)), emptyNote("div.empty", "Nessun artifact", `Chiedi a ${inst.name} una pagina: un report, una tabella, una presentazione. Le sue pagine restano qui.`)));
		},
		routine: async (box) => {
			const [schedules, watches, automations, board] = await Promise.all([
				api(`/api/instances/${inst.id}/schedules`).then((r) => r.schedules).catch(() => []),
				api(`/api/instances/${inst.id}/watches`).then((r) => r.watches).catch(() => []),
				api(`/api/instances/${inst.id}/automations`).then((r) => r.automations).catch(() => []),
				api("/api/board").catch(() => ({})),
			]);
			const routines = (board.routines ?? []).filter((r) => r.assignee === inst.id);
			const rows = routineRows(inst, { schedules, watches, automations, routines }, () => void load(box, "routine"));
			mount(box,
				h("div.agent-section-bar", h("p.muted.small", `Quando ${inst.name} lavora da solo: a un orario, quando cambia una pagina, a un evento o con un incarico che si ripete.`), h("a.btn.small", { href: "#/programmi" }, icon("plus"), "Nuova")),
				h("div.card", folded(rows, emptyNote("div.empty", "Nessuna routine", `Scrivi a ${inst.name} «ogni lunedì alle 9…», oppure creane una da Automazioni.`))));
		},
		memoria: (box) => memorySection(inst, box),
		documenti: (box) => filesSection(inst, box, (path) => openFile?.(path)),
		procedure: (box) => skillsSection(inst, box),
		...(computer ? { computer: (box) => mount(box, computer.el) } : {}),
	};
	const load = async (box, id) => {
		try {
			await sections[id](box);
		} catch (error) {
			if (box === shown) mount(box, h("p.error", error.message));
		}
	};
	const select = (id) => {
		current = sections[id] ? id : "attivita";
		for (const tab of tabs) {
			tab.setAttribute("aria-selected", String(tab.dataset.section === current));
			if (tab.dataset.section === current) tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		}
		computer?.visible(current === "computer");
		const box = h("div.agent-section", { role: "tabpanel", "aria-label": named.find(([s]) => s === current)?.[1] }, h("p.muted.small", "Caricamento…"));
		mount(body, box);
		shown = box;
		void load(box, current);
		if (!el.hidden) onShow(current);
	};
	/** What the agente is doing now, for this person. */
	const drawStatus = async () => {
		const { agents } = await api("/api/agents").catch(() => ({ agents: [] }));
		const now = agents.find((a) => a.id === inst.id);
		mount(status, agentStatus(now));
	};
	const show = (on, section) => {
		if (!on) {
			if (el.hidden) return;
			el.hidden = true;
			shown = undefined;
			computer?.visible(false);
			mount(body);
			return onHide();
		}
		const opening = el.hidden;
		el.hidden = false;
		if (opening || (section && section !== current)) select(section ?? current);
		else onShow(current);
		if (opening) void drawStatus();
	};
	return { el, show, isOpen: () => !el.hidden, section: () => current };
}
