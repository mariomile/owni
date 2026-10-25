import { api, emptyNote, face, faceColor, fmt, h, icon, mount, state, store, toast } from "./common.js";

const STATUS = { queued: "In coda", running: "In corso", succeeded: "Risposta pronta", failed: "Non riuscita", cancelled: "Interrotta" };
const SOURCE = { message: "Chat", schedule: "Task programmato", brief: "Brief", watch: "Sentinella", automation: "Automazione", notice: "Avviso", agent: "Passaggio tra agenti" };
const PROGRESS = { model: "Preparo la risposta", tool_start: "Eseguo un'azione", tool_progress: "L'azione è in corso", tool_end: "Azione terminata", retry: "Riprovo la richiesta al modello" };
const TOOL_ACTION = { web_search: "Cerco sul web", web_browse: "Consulto una pagina", web_read: "Leggo una pagina", memory_search: "Consulto la memoria", skill_read: "Consulto una procedura", file_read: "Leggo un documento" };
const stepText = (step) => ["tool_start", "tool_progress"].includes(step.kind) && TOOL_ACTION[step.toolName] || PROGRESS[step.kind] || "Lavoro in corso";
export const activeRun = (run) => run.status === "queued" || run.status === "running";
const clock = (at) => new Date(at).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const label = (run) => run.cancelRequestedAt && activeRun(run) ? "Interruzione in corso…" : STATUS[run.status] ?? run.status;

function details(run, compact = false) {
	const progress = (run.progress ?? []).filter((step) => !compact || step.kind !== "model");
	return h("details.run-details", h("summary", compact ? "Attività" : `Passaggi${progress.length ? ` · ${progress.length}` : ""}`),
		progress.length ? h("ol.run-steps", progress.map((step) => h("li", h("time", fmt.time(step.at)), h("span", stepText(step))))) : h("p.muted", "Nessun passaggio registrato."),
		!compact && run.error ? h("p.error", "L'agente non ha completato il lavoro. Apri la conversazione per riprovare.") : null,
		!compact && run.status === "succeeded" && run.delivery === "failed" ? h("p.error", "La risposta è pronta, ma la consegna non è riuscita.") : null,
		!compact && run.status === "succeeded" && run.delivery === "pending" ? h("p.muted", "La consegna della risposta è ancora in attesa.") : null);
}

/** The run's progress as a task list: one task per action, done once the next begins or it ends. */
function tasks(run) {
	const list = [];
	for (const step of run.progress ?? []) {
		const open = list.at(-1);
		if (step.kind === "tool_start" || step.kind === "retry") {
			if (open) open.done = true;
			list.push({ text: stepText(step), done: false });
		} else if (step.kind === "tool_progress" && (!open || open.done)) list.push({ text: stepText(step), done: false });
		else if (step.kind === "tool_end" && open) open.done = true;
	}
	if (!activeRun(run)) for (const task of list) task.done = true;
	return list;
}

/** «8 s», «1 min 04 s»: how long the agente has been at it. */
function elapsed(from) {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 1000));
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Real persisted state replaces the guess based on the last chat bubble. While the agente works it
 * sits where its answer will appear: its face in a turning halo, what it is doing now, the actions
 * done so far as a list that fills in, and how long it has taken.
 */
export function conversationRuns(inst, threadId, changed = () => {}) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}`;
	const el = h("section.run-control", { hidden: true, "aria-label": "Lavoro nella conversazione" });
	el.style?.setProperty("--glow", faceColor(inst));
	const orb = h("span.orb", { "aria-hidden": "true" }, face(inst, 22, "thinking"));
	const text = h("span.run-status", { role: "status", "aria-live": "polite" });
	const time = h("small.run-time", { "aria-hidden": "true" });
	const stop = h("button.btn.ghost.small", { type: "button", title: "Interrompi il lavoro e i messaggi in coda di questa chat. Le azioni già completate restano.", onclick: () => void cancel() }, icon("stop"), "Interrompi");
	const steps = h("div.run-body");
	const note = h("p.run-note", { hidden: true });
	const refreshButton = h("button.btn.ghost.small", { type: "button", onclick: () => void refresh() }, "Aggiorna stato");
	mount(el, h("div.run-control-head", orb, text, time, stop, refreshButton), note, steps);
	let runs = [];
	let refreshing;
	let dirty = false;
	let stopping = false;
	// What was on screen: a new status fades in, only new tasks rise into the list.
	let shownText = "";
	let shownRun;
	let shownTasks = 0;
	let since;
	const draw = () => {
		const active = runs.filter(activeRun);
		const latest = active.find((run) => run.status === "running") ?? active[0] ?? runs[0];
		const settled = latest?.status === "succeeded" && !["failed", "pending"].includes(latest.delivery);
		el.hidden = !latest || settled;
		refreshButton.hidden = true;
		stop.hidden = active.length === 0;
		stop.disabled = stopping;
		mount(stop, icon("stop"), active.some((run) => run.cancelRequestedAt) && !stopping ? "Riprova interruzione" : "Interrompi");
		if (latest) {
			const last = latest.progress?.at(-1);
			const current = latest.cancelRequestedAt && active.length ? "Interruzione in corso…" : latest.status === "queued" ? "In attesa di iniziare" : last ? stepText(last) : "Preparo la risposta";
			el.setAttribute("data-state", active.length ? latest.status : latest.status === "succeeded" ? `delivery-${latest.delivery}` : latest.status);
			const words = settled ? "" : active.length ? `${current}${active.length > 1 ? ` · ${active.length - 1} in coda` : ""}` : latest.status === "succeeded" ? latest.delivery === "failed" ? "Consegna non riuscita" : "Consegna in attesa" : latest.status === "failed" ? "Risposta non completata" : "Lavoro interrotto";
			text.textContent = words;
			if (words !== shownText && words && !calm()) text.animate?.([{ opacity: 0, filter: "blur(4px)", transform: "translateY(3px)" }, { opacity: 1, filter: "blur(0)", transform: "none" }], { duration: 360, easing: "cubic-bezier(.22, 1, .36, 1)" });
			shownText = words;
			orb.hidden = !active.length;
			since = active.length ? latest.startedAt ?? latest.createdAt : undefined;
			time.textContent = since ? elapsed(since) : "";
			note.textContent = active.length ? "" : latest.status === "failed" ? "Puoi riprovare con un nuovo messaggio." : latest.status === "cancelled" ? "Le azioni già completate restano." : latest.delivery === "failed" ? "La risposta è pronta, ma la consegna non è riuscita." : latest.delivery === "pending" ? "La risposta è pronta. La consegna non è ancora confermata." : "";
			note.hidden = !note.textContent || settled;
			const list = tasks(latest);
			if (latest.id !== shownRun) shownTasks = 0;
			shownRun = latest.id;
			if (active.length && list.length) {
				// The last few actions, live: the newest is the one under way.
				const hiddenCount = Math.max(0, list.length - 5);
				mount(steps, h("ol.run-tasks", hiddenCount ? h("li.run-task.more", `${hiddenCount} ${hiddenCount === 1 ? "azione" : "azioni"} prima`) : null,
					list.slice(hiddenCount).map((task, i) => h(`li.run-task${task.done ? ".done" : ".now"}${hiddenCount + i >= shownTasks && shownTasks > 0 ? ".enter" : ""}`,
						h("span.task-mark", { "aria-hidden": "true" }, task.done ? icon("check") : null), h("span", task.text)))));
				shownTasks = list.length;
			} else {
				// Over and still on screen (failed, stopped, not delivered): the whole log, folded.
				const expanded = steps.querySelector("details")?.open;
				const activity = !settled && !active.length && latest.progress?.some((step) => step.kind !== "model") ? details(latest, true) : null;
				if (activity) activity.open = Boolean(expanded);
				mount(steps, activity);
			}
		} else {
			note.hidden = true;
			orb.hidden = true;
			since = undefined;
			mount(steps);
		}
		changed(active.length > 0);
	};
	const update = (run) => {
		if (run.instanceId !== inst.id || run.threadId !== threadId) return false;
		const old = runs.find((row) => row.id === run.id);
		if (old && old.updatedAt > run.updatedAt) return true;
		const all = [run, ...runs.filter((row) => row.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		runs = [...all.filter(activeRun), ...all.filter((row) => !activeRun(row)).slice(0, 50)];
		draw();
		return true;
	};
	async function refresh() {
		dirty = true;
		if (refreshing) return refreshing;
		refreshing = (async () => {
			do {
				dirty = false;
				try {
					const result = await api(`${base}/runs`);
					// Events received during the read may be newer than its snapshot.
					for (const run of result.runs) update(run);
					draw();
				} catch (error) {
					el.hidden = false;
					el.setAttribute("data-state", "unavailable");
					text.textContent = "Stato del lavoro non disponibile";
					note.textContent = "Aggiorna lo stato per verificare se il lavoro è ancora in corso.";
					note.hidden = false;
					refreshButton.hidden = false;
				}
			} while (dirty);
		})().finally(() => { refreshing = undefined; if (dirty) return refresh(); });
		return refreshing;
	}
	async function cancel() {
		if (stopping) return;
		stopping = true;
		draw();
		try {
			const result = await api(`${base}/stop`, { method: "POST" });
			for (const run of result.runs) update(run);
			await refresh();
		} catch (error) {
			toast(error.message, true);
		} finally { stopping = false; draw(); }
	}
	// Reconnect reads durable state to cover events missed while offline.
	state.onRun = update;
	state.onRunsReconnect = () => void refresh();
	const timer = setInterval(() => {
		if (!el.isConnected) return clearInterval(timer);
		if (document.visibilityState === "visible") void refresh();
	}, 15_000);
	const ticker = setInterval(() => {
		if (!el.isConnected) return clearInterval(ticker);
		if (since) time.textContent = elapsed(since);
	}, 1000);
	void refresh();
	return { el, refresh };
}

/** One outcome history shared by activity, tasks and webhook automations. */
export function runHistory(instances, { sources, names = new Map(), title = "Le tue esecuzioni" } = {}) {
	const list = h("div", h("p.muted", "Caricamento…"));
	const refreshButton = h("button.btn.ghost.small", { type: "button", onclick: () => void refresh() }, "Aggiorna");
	const el = h("section.card.pad.run-history", h("div.run-control-head", h("h2", title), refreshButton),
		h("p.muted", "Il lavoro nelle tue conversazioni della console. «Risposta pronta» indica che l'agente ha risposto: apri la chat per verificare il risultato e le approvazioni ancora necessarie."), list);
	let refreshing;
	let dirty = false;
	async function refresh() {
		dirty = true;
		if (refreshing) return refreshing;
		refreshButton.disabled = true;
		refreshing = (async () => {
			do {
			dirty = false;
			const query = sources ? `?sources=${encodeURIComponent(sources.join(","))}` : "";
			const results = await Promise.allSettled(instances.map(async (inst) => ({ inst, ...(await api(`/api/instances/${inst.id}/runs${query}`)) })));
			const failures = results.filter((result) => result.status === "rejected").length;
			const rows = results.filter((result) => result.status === "fulfilled").flatMap(({ value }) => value.runs.map((run) => ({ run, inst: value.inst })))
				.filter(({ run }) => !sources || sources.includes(run.source)).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)).slice(0, 100);
			mount(list,
				failures ? h("p.error", `Non è stato possibile caricare lo storico di ${failures} agenti. Riprova con Aggiorna.`) : null,
				rows.length ? h("ul.task-list", rows.map(({ run, inst }) => h("li.task-row.run-row",
					h(`span.chip${run.status === "failed" ? ".bad" : run.status === "succeeded" ? ".ok" : ""}`, label(run)),
					h("div.task-text", h("b", names.get(run.sourceId) ?? SOURCE[run.source] ?? "Esecuzione", " · ", inst.name), h("small", clock(run.createdAt)), details(run)),
					h("a.btn.ghost.small", { href: `#/chat/${encodeURIComponent(run.threadId)}`, onclick: () => { state.instance = inst; store("owni.instance", inst.id); } }, "Apri chat"))))
					: failures ? null : emptyNote("div.empty", "Nessuna esecuzione", "Quando un agente lavora per te, da una chat, un task o un'automazione, l'esito compare qui."));
			} while (dirty);
		})().finally(() => { refreshing = undefined; refreshButton.disabled = false; if (dirty) return refresh(); });
		return refreshing;
	}
	let liveTimer;
	state.onRun = () => {
		if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = undefined; if (el.isConnected) void refresh(); }, 250);
		return false;
	};
	state.onRunsReconnect = () => void refresh();
	void refresh();
	return el;
}
