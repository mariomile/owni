// Shell: sidebar, account menu, theme.
import { accountDialog } from "./account.js";
import { $app, api, ApiError, emptyNote, face, fmt, go, h, icon, initials, instanceHref, mount, route, selectInstance, state, store, toast } from "./common.js";
import { renderLogin } from "./login.js";
import { viewActivity } from "./pages/activity.js";
import { agentForm, viewAgents } from "./pages/agents.js";
import { viewApprovals } from "./pages/approvals.js";
import { viewAutomations } from "./pages/automations.js";
import { viewBoard } from "./pages/board.js";
import { closeModelMenu, viewChat } from "./pages/chat.js";
import { viewConnectors } from "./pages/connectors.js";
import { viewFiles } from "./pages/files.js";
import { viewMemory } from "./pages/memory.js";
import { viewPeople } from "./pages/people.js";
import { viewRooms } from "./pages/rooms.js";
import { viewSegreteria } from "./pages/segreteria.js";
import { viewSettings } from "./pages/settings.js";
import { viewSkills } from "./pages/skills.js";
import { viewStart } from "./pages/start.js";
import { viewTasks } from "./pages/tasks.js";
import { viewConversations } from "./pages/conversations.js";
import { viewPrograms, viewWork } from "./pages/work.js";
import { viewAgentProfile } from "./pages/agent-profile.js";
import { openPalette } from "./palette.js";
import { install, installed, installOffer } from "./pwa.js";
import { applyTheme, refreshSetup } from "./session.js";

// ---------- shell ----------
/**
 * Every page of the console, in the order of the sidebar and of the command palette. `sidebar`: reached
 * from the sidebar (the rest sits in the account menu). `owner`: only for the owner. `when(instance)`:
 * shown only then. `count()`: the number beside it. A new page is its file in pages/, one row here and
 * one line in sw.js.
 */
export const PAGES = [
	{ id: "conversazioni", label: "Conversazioni", group: "Lavoro", workspace: "conversations", sidebar: true, view: viewConversations },
	{ id: "lavori", label: "Lavori", group: "Lavoro", workspace: "work", sidebar: true, view: viewWork },
	{ id: "chat", label: "Nuova conversazione", group: "Lavoro", workspace: "conversations", view: viewChat },
	{ id: "stanze", label: "Conversazioni con più agenti", group: "Lavoro", workspace: "conversations", when: () => state.instances.filter((i) => i.canChat).length > 1, view: viewRooms },
	{ id: "board", label: "Board degli incarichi", group: "Lavoro", workspace: "work", view: viewBoard },
	{ id: "programmi", label: "Automazioni", group: "Lavoro", workspace: "work", view: viewPrograms },
	{ id: "segreteria", label: "Pratiche commerciali", group: "Lavoro", workspace: "work", when: (i) => i?.hasSegreteria, view: viewSegreteria },
	{ id: "approvazioni", label: "Autorizzazioni", group: "Lavoro", workspace: "work", view: viewApprovals },
	{ id: "task", label: "Orari e pagine da controllare", group: "Lavoro", workspace: "work", view: viewTasks },
	{ id: "automazioni", label: "Eventi esterni", group: "Lavoro", workspace: "work", view: viewAutomations },
	{ id: "agenti", label: "Agenti", group: "Gestione", workspace: "agents", view: viewAgents },
	{ id: "agente", label: "Il tuo assistente", group: "Gestione", workspace: "agents", palette: false, view: viewAgentProfile },
	{ id: "file", label: "Documenti dell'agente", group: "Materiali", workspace: "agents", view: viewFiles },
	{ id: "memoria", label: "Memoria personale e condivisa", group: "Materiali", workspace: "agents", view: viewMemory },
	{ id: "skill", label: "Procedure", group: "Materiali", workspace: "agents", view: viewSkills },
	{ id: "connettori", label: "Servizi collegati", group: "Gestione", workspace: "agents", owner: true, view: viewConnectors },
	{ id: "impostazioni", label: "Configurazione dell'agente", group: "Gestione", workspace: "agents", owner: true, view: viewSettings },
	{ id: "inizia", label: "Primi passi", group: "Gestione", workspace: "agents", owner: true, view: viewStart },
	{ id: "gestione", label: "Gestione", group: "Gestione", workspace: "management", view: viewManagement },
	{ id: "persone", label: "Persone e accessi", group: "Gestione", workspace: "management", owner: true, view: viewPeople },
	{ id: "attivita", label: "Attività e spesa", group: "Gestione", workspace: "management", view: viewActivity },
];

function workspaceNav(item) {
	const { view } = route();
	const link = (label, href, active) => h("a", { href, "aria-current": active ? "page" : undefined }, label);
	if (item.workspace === "work") return h("nav.workspace-nav", { "aria-label": "Lavori" },
		link("Incarichi", "#/lavori", view === "lavori" && !route().rest[0]),
		link("Richiede te", "#/lavori/attenzione", view === "approvazioni" || (view === "lavori" && route().rest[0] === "attenzione")),
		link("Automazioni", "#/programmi", ["programmi", "task", "automazioni"].includes(view)),
		state.instances.some((i) => i.hasSegreteria) ? link("Pratiche", instanceHref("segreteria", [], state.instances.find((i) => i.hasSegreteria)?.id), view === "segreteria") : null,
	);
	if (item.workspace === "agents" && state.instance) return h("nav.workspace-nav", { "aria-label": `Materiali e configurazione di ${state.instance.name}` },
		link(state.instance.name, `#/agente/${encodeURIComponent(state.instance.id)}`, view === "agente"),
		link("Documenti", instanceHref("file"), view === "file"), link("Memoria", instanceHref("memoria"), view === "memoria"), link("Procedure", instanceHref("skill"), view === "skill"),
		state.me.role === "owner" ? link("Configurazione", instanceHref("impostazioni"), ["impostazioni", "connettori", "inizia"].includes(view)) : null,
	);
	if (view === "chat") {
		const inst = state.instance;
		const choices = state.instances.filter((i) => i.canChat);
		const who = route().rest[0]
			? h("a.agent-context", { href: inst ? `#/agente/${encodeURIComponent(inst.id)}` : "#/agenti" }, inst ? face(inst, 20) : null, h("span.agent-context-label", `Conversazione con ${inst?.name ?? "l'agente"}`))
			: h("label.chat-recipient", h("span", "Scrivi a"), choices.length > 1 ? h("select", { "aria-label": "Agente della nuova conversazione", value: inst?.id, onchange: (event) => { location.hash = instanceHref("chat", [], event.target.value); } }, choices.map((i) => h("option", { value: i.id, selected: i.id === inst?.id }, i.name))) : h("a", { href: inst ? `#/agente/${encodeURIComponent(inst.id)}` : "#/agenti" }, inst?.name ?? "Il tuo assistente"));
		return h("div.conversation-context", who, h("div.conversation-context-actions", h("div.conversation-tools", { role: "group", "aria-label": "Strumenti della conversazione" }), h("a.btn.small.ghost.conversation-list-link", { href: "#/conversazioni", "aria-label": "Le tue conversazioni", title: "Le tue conversazioni" }, icon("chat"), h("span", "Le tue conversazioni"))));
	}
	return null;
}

async function viewManagement(main) {
	const owner = state.me.role === "owner";
	mount(main, h("div.head", h("div.head-title", h("h1", "Account e gestione"), h("p", "Le tue impostazioni personali e la gestione dell'installazione sono separate."))),
		h("div.card.pad.stack", h("h2", "Il mio account"), h("p.muted", "Collegamenti personali e verifica in due passaggi."), h("button.btn", { onclick: accountDialog }, "Apri il tuo account")),
		owner ? h("section.management-links", h("h2", "Installazione"), h("a.card.pad", { href: "#/persone" }, "Persone e accessi"), h("a.card.pad", { href: instanceHref("impostazioni", ["providers"]) }, "Provider disponibili"), h("a.card.pad", { href: "#/attivita" }, "Consumi e registro delle attività")) : h("a.btn.ghost", { href: "#/attivita" }, "Le tue esecuzioni e i consumi"),
	);
}

const railPhone = matchMedia("(max-width: 860px)");
railPhone.addEventListener("change", syncRailControls);

export function render() {
	if (!state.me) return renderLogin();
	const current = route();
	const { view } = current;
	const requested = view === "agente" ? current.rest[0] : current.instanceId;
	const previous = state.instance;
	const unavailable = requested && !selectInstance(requested);
	if (view === "chat" && !current.rest[0] && !requested && !state.instance?.canChat) {
		const first = state.instances.find((i) => i.canChat);
		if (first) selectInstance(first.id);
	}
	const item = PAGES.find((p) => p.id === view) ?? PAGES.find((p) => p.id === "chat");
	if (item.owner && state.me.role !== "owner") return go("chat");
	if (previous !== state.instance) void refreshSetup().then(() => { if (document.getElementById("rail")) renderRail(); });
	closeMenu();
	closeModelMenu();
	const chat = item.id === "chat" || (item.id === "stanze" && current.rest[0] && current.rest[0] !== "nuova");
	const main = h("main", { id: "main", class: chat ? "is-chat" : "is-page" });
	const content = h(chat ? "div.page-content.chat-content" : "div.page-content");
	mount(main, workspaceNav(item), content);
	const shell = h(
		`div.shell${store("owni.rail") === "closed" ? ".collapsed" : ""}`,
		h("header.topbar", h("button.icon-btn.rail-menu", {
			"aria-label": "Apri la barra laterale", "aria-controls": "rail", "aria-expanded": "false",
			onclick: () => { shell.classList.toggle("open"); syncRailControls(); },
		}, icon("menu")), h("b.topbar-brand", "Owni"), h("button.icon-btn", { "aria-label": "Nuova conversazione", title: "Nuova conversazione", onclick: () => go("chat") }, icon("compose"))),
		h("div.scrim", { onclick: closeRailOnPhone }), h("aside.rail", { id: "rail" }), main,
	);
	mount($app, shell);
	renderRail();
	void refreshThreads().then(renderRail);
	state.onEntry = undefined;
	state.onRoom = undefined;
	state.onRun = undefined;
	state.onRunsReconnect = undefined;
	state.onBoard = undefined;
	if (unavailable) return mount(content, emptyNote("div.empty", "Agente non disponibile", "Scegli un agente a cui hai accesso."), h("a.btn", { href: "#/agenti" }, "Apri gli agenti"));
	item.view(content).catch((error) => {
		if (!content.isConnected || error instanceof ApiError && error.status === 401) return;
		mount(content, emptyNote("div.empty", "Non riesco a caricare questa sezione", error.message), h("button.btn", { onclick: render }, "Riprova"));
	});
}

function toggleRail() {
	const shell = document.querySelector(".shell");
	if (!shell) return;
	shell.classList.toggle("collapsed");
	store("owni.rail", shell.classList.contains("collapsed") ? "closed" : "open");
	syncRailControls();
}

/** The same desktop control expands the icon rail; the phone keeps its full overlay. */
function syncRailControls() {
	const shell = document.querySelector(".shell");
	if (!shell) return;
	const expanded = !shell.classList.contains("collapsed");
	const toggle = shell.querySelector(".rail .collapse");
	if (toggle) {
		const label = expanded ? "Chiudi la barra laterale" : "Apri la barra laterale";
		toggle.setAttribute("aria-expanded", String(expanded));
		toggle.setAttribute("aria-label", label);
		toggle.setAttribute("title", label);
	}
	const menu = shell.querySelector(".rail-menu");
	const open = shell.classList.contains("open");
	if (menu) {
		menu.setAttribute("aria-expanded", String(open));
		menu.setAttribute("aria-label", open ? "Chiudi la barra laterale" : "Apri la barra laterale");
	}
	const rail = shell.querySelector(".rail");
	if (rail) rail.inert = railPhone.matches && !open;
}

/** The current instance's conversations, for the sidebar; none for someone who cannot chat there. */
let threadRead = 0;
export async function refreshThreads() {
	const read = ++threadRead;
	const person = state.me;
	if (!person) return;
	const agents = state.instances.filter((i) => i.canChat);
	const results = await Promise.allSettled(agents.map(async (agent) => {
		const { threads } = await api(`/api/instances/${encodeURIComponent(agent.id)}/threads`);
		return threads.map((thread) => ({ ...thread, instanceId: agent.id, agent }));
	}));
	if (state.me !== person || read !== threadRead) return;
	const allowed = new Set(state.instances.filter((i) => i.canChat).map((i) => i.id));
	state.threads = results.flatMap((result, i) => !allowed.has(agents[i].id) ? [] : result.status === "fulfilled" ? result.value : [401, 403, 404].includes(result.reason?.status) ? [] : state.threads.filter((thread) => thread.instanceId === agents[i].id));
	state.threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Today, yesterday, this week, older: how the sidebar groups conversations. */
function threadGroup(at, now = new Date()) {
	const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((day(now) - day(new Date(at))) / 86_400_000);
	return days <= 0 ? "Oggi" : days === 1 ? "Ieri" : days < 7 ? "Ultimi 7 giorni" : days < 30 ? "Ultimi 30 giorni" : "Più vecchie";
}

function closeRailOnPhone() {
	document.querySelector(".shell")?.classList.remove("open");
	syncRailControls();
}

export function renderRail() {
	const rail = document.getElementById("rail");
	if (!rail || !state.me) return;
	const scrollTop = rail.querySelector(".rail-scroll")?.scrollTop ?? 0;
	const { view, rest } = route();
	const items = PAGES.filter((p) => p.sidebar && (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance)));
	const nav = h("nav.sections", { "aria-label": "Sezioni" });
	for (const item of items) {
		const count = item.count?.() ?? 0;
		const label = count > 0 ? `${item.label} (${count})` : item.label;
		nav.append(h("a", { href: `#/${item.id}`, "aria-current": PAGES.find((p) => p.id === view)?.workspace === item.workspace ? "page" : undefined, "aria-label": label, title: label, onclick: closeRailOnPhone }, icon(item.id), h("span.label", item.label), count > 0 ? h("span.count", { "aria-hidden": "true" }, String(count)) : null));
	}
	const past = h("nav.history", { "aria-label": "Conversazioni" });
	let group;
	for (const t of (state.threads ?? []).slice(0, 24)) {
		const g = threadGroup(t.updatedAt);
		if (g !== group) {
			group = g;
			past.append(h("div.group", g));
		}
		const agent = t.agent ?? state.instances.find((i) => i.id === t.instanceId) ?? state.instance;
		const current = view === "chat" && rest[0] === t.id && (!t.instanceId || t.instanceId === state.instance?.id);
		const label = `${agent?.name ?? "Agente"} · ${t.title}`;
		const unread = state.unread.has(t.id);
		past.append(
			h(
				"a",
				{ href: instanceHref("chat", [t.id], agent?.id), "aria-current": current ? "page" : undefined, "aria-label": `${label}${unread ? ", non letto" : ""}`, title: label, onclick: closeRailOnPhone },
				face(agent, 24),
				h("span.thread-text", h("span.name", agent?.name ?? "Agente"), h("span.title", t.title)),
				unread ? h("span.dot", { "aria-hidden": "true" }) : null,
			),
		);
	}
	mount(
		rail,
		h(
			"div.rail-top",
			h("a.brand", { href: "#/chat", "aria-label": "Owni", title: "Owni", onclick: closeRailOnPhone }, h("img", { src: "/icon.svg", alt: "", width: "22", height: "22" }), h("b", "Owni")),
			h("button.icon-btn.collapse", { "aria-label": "Chiudi la barra laterale", "aria-controls": "rail", "aria-expanded": "true", title: "Chiudi la barra laterale", onclick: toggleRail }, icon("sidebar")),
		),
		h(
			"div.rail-actions",
			h("a.rail-btn", { href: "#/chat", "aria-current": view === "chat" && !rest[0] ? "page" : undefined, "aria-label": "Nuova chat", title: "Nuova chat", onclick: closeRailOnPhone }, icon("compose"), h("span.label", "Nuova chat")),
			h("button.rail-btn", { onclick: openPalette, "aria-label": "Vai a una sezione", title: "Cerca" }, icon("search"), h("span.label", "Cerca"), h("kbd", navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
		),
		h(
			"div.rail-scroll",
			nav,
			h("a.rail-btn.attention-link", { href: "#/lavori/attenzione", onclick: closeRailOnPhone, title: "Richiede te" }, icon("approvazioni"), h("span.label", "Richiede te"), state.pendingApprovals + state.boardReview ? h("span.count", String(state.pendingApprovals + state.boardReview)) : null),
			past.childElementCount ? past : null,
			h("nav.sections.rail-management", { "aria-label": "Gestione" }, h("a", { href: state.instances.length === 1 ? `#/agente/${encodeURIComponent(state.instances[0].id)}` : "#/agenti", onclick: closeRailOnPhone, title: "Agenti" }, icon("agenti"), h("span.label", state.instances.length === 1 ? "Il tuo assistente" : "Agenti")), h("a", { href: "#/gestione", onclick: closeRailOnPhone, title: "Account e gestione" }, icon("gestione"), h("span.label", "Account e gestione"))),
		),
		h(
			"div.rail-foot",
			h(
				"button.who-id",
				{ onclick: openMenu, "aria-haspopup": "menu", "aria-expanded": document.querySelector(".menu") ? "true" : "false", "aria-label": `Account e gestione, ${state.me.name}`, title: "Account e gestione" },
				h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)),
				h("span.who-text", h("span.name", state.me.name), h("span.role", state.instance?.name ?? (state.me.role === "owner" ? "Owner" : "Membro"))),
				icon("more"),
			),
		),
	);
	rail.querySelector(".rail-foot").before(rail.querySelector(".rail-management"));
	rail.querySelector(".rail-scroll").scrollTop = scrollTop;
	syncRailControls();
}

/** The account menu: spend, management sections, account, theme, exit. */
function openMenu() {
	if (closeMenu()) return;
	// The sidebar is drawn again on every reply: always the button that is on the page now.
	const anchor = () => document.querySelector("button.who-id");
	const owner = state.me.role === "owner";
	const u = state.usage;
	const share = u ? Math.min(1, u.todayUsd / u.hardUsd) : 0;
	const { view } = route();
	const entry = (iconName, label, action, current) =>
		h(
			"button",
			{
				role: "menuitem",
				"aria-current": current ? "page" : undefined,
				onclick: () => {
					closeMenu();
					closeRailOnPhone();
					action();
				},
			},
			icon(iconName),
			h("span", label),
		);
	const section = (id) => {
		const item = PAGES.find((p) => p.id === id);
		return !item.owner || owner ? entry(id, item.label, () => go(id), view === id) : null;
	};
	const menu = h(
		"div.menu",
		h("div.menu-head", h("span.avatar", { "aria-hidden": "true" }, initials(state.me.name)), h("div", h("div.name", state.me.name), h("div.role", `${owner ? "Owner" : "Membro"}${state.me.twoFactor ? " · verifica attiva" : ""}`))),
		u
			? h(
					"div.spend",
					h("div.row", h("span", "Spesa di oggi"), h("b.mono", fmt.usd(u.todayUsd))),
					h("div.bar", h(`i${share >= 1 ? ".bad" : u.todayUsd >= u.softUsd ? ".warn" : ""}`, { "data-w": share })),
					h("div.row", h("span.muted", `soglia ${fmt.usd(u.softUsd)}`), h("span.muted", `tetto ${fmt.usd(u.hardUsd)}`)),
				)
			: null,
		h(
			"div",
			{ role: "menu", "aria-label": "Account e gestione" },
			h("hr", { role: "separator" }),
			section("gestione"),
			section("agenti"),
			owner ? entry("plus", "Nuovo agente", () => agentForm()) : null,
			installOffer && !installed() ? entry("install", "Installa l'app", install) : null,
			h("hr", { role: "separator" }),
			entry("account", "Il tuo account", accountDialog),
			entry("theme", "Tema chiaro/scuro", cycleTheme),
			entry("logout", "Esci", async () => {
				await api("/api/logout", { method: "POST" }).catch(() => {});
				state.me = undefined;
				renderLogin();
			}),
		),
	);
	document.body.append(menu);
	const bar = menu.querySelector(".spend .bar i");
	if (bar) bar.style.width = `${Math.max(2, Number(bar.dataset.w) * 100)}%`;
	const r = anchor().getBoundingClientRect();
	menu.style.left = `${Math.max(8, r.left)}px`;
	menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
	anchor().setAttribute("aria-expanded", "true");
	menu.querySelector("button")?.focus();
	// The button toggles by itself: a press on it is not «away».
	const away = (e) => {
		if (!menu.contains(e.target) && !e.target.closest?.("button.who-id")) closeMenu();
	};
	const keys = (e) => {
		if (!menu.contains(document.activeElement)) return;
		if (e.key === "Escape") {
			e.preventDefault();
			closeMenu();
			anchor()?.focus();
		} else if (e.key === "Tab") closeMenu();
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const all = [...menu.querySelectorAll("button")];
			const i = all.indexOf(document.activeElement);
			all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
		}
	};
	document.addEventListener("pointerdown", away);
	document.addEventListener("keydown", keys);
	menu.cleanup = () => {
		document.removeEventListener("pointerdown", away);
		document.removeEventListener("keydown", keys);
		anchor()?.setAttribute("aria-expanded", "false");
	};
}

/** Closes the account menu; true when one was open. */
export function closeMenu() {
	const menu = document.querySelector(".menu");
	if (!menu) return false;
	menu.cleanup?.();
	menu.remove();
	return true;
}

function cycleTheme() {
	const current = store("owni.theme") ?? "auto";
	const next = current === "auto" ? "dark" : current === "dark" ? "light" : "auto";
	applyTheme(next);
	toast(next === "auto" ? "Tema: come il sistema" : next === "dark" ? "Tema scuro" : "Tema chiaro");
}

