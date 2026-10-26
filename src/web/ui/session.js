// Starting the app: who is signed in, the agents, the counters, the live events.
import { $app, api, ApiError, emptyNote, h, mount, route, state, store, toast } from "./common.js";
import { renderCode, renderLogin } from "./login.js";
import { finishGoogle } from "./google.js";
import { setupLeft } from "./setup.js";
import { finishConnector } from "./signin.js";
import { refreshConversations, render, renderRail } from "./shell.js";

// ---------- boot ----------
// api() says a session is gone with this event (common.js imports nothing): show the login.
let counterTimer;
window.addEventListener("owni:unauthorized", () => {
	state.me = undefined;
	clearInterval(counterTimer);
	renderLogin();
});

export async function boot() {
	applyTheme();
	if (location.pathname === "/login") {
		const token = location.hash.slice(1);
		history.replaceState(null, "", "/");
		if (token) {
			try {
				await api("/api/login", { method: "POST", body: { token } });
			} catch (error) {
				if (error.data?.twoFactor) return renderCode(token);
				return renderLogin(error.message);
			}
		}
	}
	await enter();
}

/** With a session: load who this is and the instances, then show the console. */
export async function enter() {
	try {
		state.me = (await api("/api/me")).person;
		await refreshInstances();
	} catch (error) {
		// No network, or the server not answering (a restart, a cell waking up): say so and try again by itself.
		if (!(error instanceof ApiError) || error.status >= 500) unreachable();
		return;
	}
	if (location.hash.startsWith("#/google?")) await finishGoogle();
	if (location.hash.startsWith("#/connettore?")) await finishConnector();
	connectEvents();
	window.addEventListener("hashchange", renderRoute);
	render();
	clearInterval(counterTimer);
	counterTimer = setInterval(() => {
		if (state.me && document.visibilityState === "visible") void refreshCounters();
	}, 30_000);
	// After the first paint: the steps never hold the console up.
	await refreshSetup();
	// Start with the assistant. Optional channels, devices and team setup stay contextual.
	render();
}

/** A page-owned modal must not survive leaving its route, including browser Back. */
function renderRoute() {
	for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
	render();
}

/** The server cannot be reached: a screen that retries by itself, and a button to retry now. */
function unreachable() {
	let timer;
	const retry = () => {
		clearTimeout(timer);
		window.removeEventListener("online", retry);
		mount($app, emptyNote("div.empty", "Riprovo…"));
		void enter();
	};
	mount(
		$app,
		h(
			"div.empty",
			h("b", navigator.onLine ? "Non riesco a raggiungere Owni" : "Sei offline"),
			navigator.onLine ? "Il server non risponde: riprovo da sola tra qualche secondo." : "Owni si riapre da sola appena torna la rete.",
			h("p", h("button.btn", { onclick: retry }, "Riprova")),
		),
	);
	window.addEventListener("online", retry, { once: true });
	timer = setTimeout(retry, 10_000);
}

export async function refreshInstances() {
	state.instances = (await api("/api/instances")).instances;
	const saved = store("owni.instance");
	state.instance = state.instances.find((i) => i.id === saved) ?? state.instances[0];
	await refreshCounters();
}

/** How many «Primi passi» are left, for the owner of the current instance. */
export async function refreshSetup() {
	state.setupLeft = 0;
	state.setup = undefined;
	if (state.me?.role !== "owner" || !state.instance || setupHidden(state.instance.id)) return;
	try {
		const { setup } = await api(`/api/instances/${state.instance.id}/setup`);
		state.setup = setup;
		state.setupLeft = setupLeft(setup);
	} catch {
		/* not shown */
	}
}

/** «Primi passi» put away, per instance, in this browser: read with one argument, set with two. */
export function setupHidden(instanceId, hide) {
	let ids = [];
	try {
		ids = JSON.parse(store("owni.setup.hidden") ?? "[]");
	} catch {
		/* an older value: start again */
	}
	if (!Array.isArray(ids)) ids = [];
	if (hide === undefined) return ids.includes(instanceId);
	store("owni.setup.hidden", JSON.stringify(hide ? [...new Set([...ids, instanceId])] : ids.filter((id) => id !== instanceId)));
}

let counterRefresh;
let countersChanged = false;

/** Coalesce simultaneous live events, but read again if something changed during the request. */
export function refreshCounters() {
	countersChanged = true;
	if (counterRefresh) return counterRefresh;
	counterRefresh = (async () => {
		do {
			countersChanged = false;
			const person = state.me;
			if (!person) break;
			try {
				const summary = await api("/api/console-summary");
				// A late response from a previous login must not overwrite this person's counters.
				if (state.me !== person) continue;
				state.usage = summary.usage;
				state.pendingApprovals = summary.pendingApprovals;
				state.boardReview = summary.boardReview;
				renderRail();
			} catch {
				// Keep the last known counts: an unavailable source does not mean zero decisions.
			}
		} while (countersChanged);
	})().finally(() => {
		counterRefresh = undefined;
		// An event can arrive after the loop finishes but before this cleanup runs.
		if (countersChanged) return refreshCounters();
	});
	return counterRefresh;
}

function connectEvents() {
	state.events?.close();
	const es = new EventSource("/api/events");
	es.addEventListener("run", (e) => state.onRun?.(JSON.parse(e.data).run));
	es.addEventListener("open", () => state.onRunsReconnect?.());
	es.addEventListener("entry", (e) => {
		const event = JSON.parse(e.data);
		// A reply can carry news for the counters (a tool proposed, a task created).
		void refreshCounters();
		// The rail says what is unread (ADR 0113); a reply nobody has on screen is also announced.
		if (state.onEntry?.(event)) return;
		toast("Nuova risposta di Owni");
		void refreshConversations().then(renderRail);
	});
	es.addEventListener("room", (e) => {
		const event = JSON.parse(e.data);
		if (state.onRoom?.(event)) return;
		if (event.entry.from === "agent") toast("Nuova risposta in un canale");
		void refreshConversations().then(renderRail);
	});
	es.addEventListener("board", (e) => {
		const event = JSON.parse(e.data);
		void refreshCounters();
		if (route().view === "programmi") return state.onBoard?.(event);
		if (["board", "approvazioni"].includes(route().view) && !document.querySelector("dialog[open]")) return render();
		toast(event.kind === "due" ? `Incarico #${event.n} ${event.text}: ${event.title}` : event.kind === "started" ? `Incarico #${event.n} partito da solo: ${event.title}` : `Incarico #${event.n} da rivedere: ${event.title}`);
	});
	state.events = es;
}

export function applyTheme(next) {
	if (next) store("owni.theme", next);
	const theme = store("owni.theme");
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
}

