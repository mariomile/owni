// Shell: sidebar, account menu, theme.
import { accountDialog } from "./account.js";
import { $app, agentHome, api, ApiError, channelHref, channelName, dmHref, emptyNote, face, fmt, go, h, icon, initials, instanceHref, mount, movedHref, route, selectInstance, state, store, toast } from "./common.js";
import { renderLogin } from "./login.js";
import { viewActivity } from "./pages/activity.js";
import { agentForm, viewAgents } from "./pages/agents.js";
import { viewApprovals } from "./pages/approvals.js";
import { viewAutomations } from "./pages/automations.js";
import { viewBoard } from "./pages/board.js";
import { closeModelMenu, viewDm } from "./pages/chat.js";
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
import { viewPrograms, viewWork } from "./pages/work.js";
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
	{ id: "lavori", label: "Lavori", group: "Lavoro", workspace: "work", sidebar: true, view: viewWork },
	{ id: "dm", label: "Messaggi diretti", group: "Lavoro", workspace: "conversations", palette: false, view: viewDm },
	{ id: "canali", label: "Canali", group: "Lavoro", workspace: "conversations", when: () => state.instances.filter((i) => i.canChat).length > 1, view: viewRooms },
	{ id: "board", label: "Board degli incarichi", group: "Lavoro", workspace: "work", view: viewBoard },
	{ id: "programmi", label: "Automazioni", group: "Lavoro", workspace: "work", view: viewPrograms },
	{ id: "segreteria", label: "Pratiche commerciali", group: "Lavoro", workspace: "work", when: (i) => i?.hasSegreteria, view: viewSegreteria },
	{ id: "approvazioni", label: "Autorizzazioni", group: "Lavoro", workspace: "work", view: viewApprovals },
	{ id: "task", label: "Orari e pagine da controllare", group: "Lavoro", workspace: "work", view: viewTasks },
	{ id: "automazioni", label: "Eventi esterni", group: "Lavoro", workspace: "work", view: viewAutomations },
	{ id: "agenti", label: "Agenti", group: "Gestione", workspace: "agents", view: viewAgents },
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

/** On the Mac app, which has no title bar, a band that moves the window (docs/desktop.md). */
const windowDrag = () => document.documentElement.dataset.desktop === "mac" ? { "data-tauri-drag-region": "deep" } : {};

function workspaceNav(item) {
	const { view } = route();
	const link = (label, href, active) => h("a", { href, "aria-current": active ? "page" : undefined }, label);
	if (item.workspace === "work") return h("nav.workspace-nav", { "aria-label": "Lavori", ...windowDrag() },
		link("Incarichi", "#/lavori", view === "lavori" && !route().rest[0]),
		link("Richiede te", "#/lavori/attenzione", view === "approvazioni" || (view === "lavori" && route().rest[0] === "attenzione")),
		link("Automazioni", "#/programmi", ["programmi", "task", "automazioni"].includes(view)),
		state.instances.some((i) => i.hasSegreteria) ? link("Pratiche", instanceHref("segreteria", [], state.instances.find((i) => i.hasSegreteria)?.id), view === "segreteria") : null,
	);
	if (item.workspace === "agents" && state.instance) return h("nav.workspace-nav", { "aria-label": `Materiali e configurazione di ${state.instance.name}`, ...windowDrag() },
		link("Documenti", instanceHref("file"), view === "file"), link("Memoria", instanceHref("memoria"), view === "memoria"), link("Procedure", instanceHref("skill"), view === "skill"),
		state.me.role === "owner" ? link("Configurazione", instanceHref("impostazioni"), ["impostazioni", "connettori", "inizia"].includes(view)) : null,
	);
	if (item.id === "dm") {
		const inst = state.instance;
		const who = h("a.agent-context", { href: agentHome(inst?.id) }, inst ? face(inst, 20) : null, h("span.agent-context-label", inst?.name ?? "Il tuo assistente"));
		return h("div.conversation-context", windowDrag(), who, h("div.conversation-context-actions", h("div.conversation-tools", { role: "group", "aria-label": "Strumenti della conversazione" })));
	}
	return null;
}

/** Where `#/` opens: the direct conversation with the general agente, or the first one the person can write to. */
function homeAgent() {
	return state.instances.find((i) => i.main && i.canChat) ?? state.instances.find((i) => i.canChat);
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
	// The old agent profile address goes where that agent's page now lives.
	if (view === "agente") return void (location.replace(agentHome(current.rest[0])));
	const moved = movedHref(current);
	if (moved) return void location.replace(moved);
	const item = PAGES.find((p) => p.id === view) ?? PAGES.find((p) => p.id === "dm");
	if (item.owner && state.me.role !== "owner") return void (location.hash = "#/");
	// A direct conversation names its agente in the address; `#/` is the general agente's.
	const requested = item.id === "dm" ? (view === "dm" ? current.rest[0] : undefined) ?? homeAgent()?.id : current.instanceId;
	const previous = state.instance;
	const unavailable = requested && !selectInstance(requested);
	if (previous !== state.instance) void refreshSetup().then(() => { if (document.getElementById("rail")) renderRail(); });
	closeMenu();
	closeModelMenu();
	const chat = item.id === "dm" || (item.id === "canali" && current.rest[0] && current.rest[0] !== "nuova");
	const main = h("main", { id: "main", class: chat ? "is-chat" : "is-page" });
	const content = h(chat ? "div.page-content.chat-content" : "div.page-content");
	mount(main, workspaceNav(item), content);
	const shell = h(
		`div.shell${store("owni.rail") === "closed" ? ".collapsed" : ""}`,
		h("header.topbar", windowDrag(), h("button.icon-btn.rail-menu", {
			"aria-label": "Apri la barra laterale", "aria-controls": "rail", "aria-expanded": "false",
			onclick: () => { shell.classList.toggle("open"); syncRailControls(); },
		}, icon("menu")), h("b.topbar-brand", "Owni"), h("button.icon-btn", { "aria-label": "Cerca", title: "Cerca", onclick: openPalette }, icon("search"))),
		h("div.scrim", { onclick: closeRailOnPhone }), h("aside.rail", { id: "rail" }), main,
	);
	mount($app, shell);
	renderRail();
	void refreshConversations().then(renderRail);
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

/** The rail's direct conversations and canali, with what is unread (ADR 0113). */
let conversationsRead = 0;
export async function refreshConversations() {
	const read = ++conversationsRead;
	const person = state.me;
	if (!person) return;
	// A failed read keeps the last known list: an unavailable source does not empty the rail.
	const conversations = await api("/api/conversations").catch(() => undefined);
	if (conversations === undefined || state.me !== person || read !== conversationsRead) return;
	state.conversations = conversations;
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
	// The rail like a team chat (ADR 0113): the canali, then a direct conversation per agente.
	const row = (href, current, unread, mark, name, label) =>
		h(`a${unread ? ".unread" : ""}`, { href, "aria-current": current ? "page" : undefined, "aria-label": `${label}${unread ? ", non letto" : ""}`, title: label, onclick: closeRailOnPhone }, mark, h("span.label", name), unread ? h("span.dot", { "aria-hidden": "true" }) : null);
	const { direct, channels } = state.conversations;
	const canCreate = state.instances.filter((i) => i.canChat).length > 1;
	const canali = canCreate || channels.length
		? h("nav.rail-list", { "aria-label": "Canali" },
			h("div.rail-group", h("span.label", "Canali"), canCreate ? h("a.icon-btn.small", { href: "#/canali/nuova", "aria-label": "Nuovo canale", title: "Nuovo canale", onclick: closeRailOnPhone }, icon("plus")) : null),
			channels.map((c) => row(channelHref(c.id), view === "canali" && rest[0] === c.id, c.unread, icon("canali"), channelName(c.title).slice(1), `Canale ${channelName(c.title)}`)))
		: null;
	const here = view === "dm" ? rest[0] ?? homeAgent()?.id : undefined;
	const agents = direct.flatMap((d) => {
		const agent = state.instances.find((i) => i.id === d.instanceId);
		return agent ? [row(dmHref(agent.id), here === agent.id, d.unread, face(agent, 20), agent.name, `Messaggi diretti con ${agent.name}`)] : [];
	});
	const dms = agents.length ? h("nav.rail-list", { "aria-label": "Messaggi diretti" }, h("div.rail-group", h("span.label", "Messaggi diretti")), agents) : null;
	mount(
		rail,
		h(
			"div.rail-top",
			windowDrag(),
			h("a.brand", { href: "#/", "aria-label": "Owni", title: "Owni", onclick: closeRailOnPhone }, h("img", { src: "/icon.svg", alt: "", width: "22", height: "22" }), h("b", "Owni")),
			h("button.icon-btn.collapse", { "aria-label": "Chiudi la barra laterale", "aria-controls": "rail", "aria-expanded": "true", title: "Chiudi la barra laterale", onclick: toggleRail }, icon("sidebar")),
		),
		h(
			"div.rail-actions",
			h("button.rail-btn", { onclick: openPalette, "aria-label": "Vai a una sezione", title: "Cerca" }, icon("search"), h("span.label", "Cerca"), h("kbd", navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K")),
		),
		h(
			"div.rail-scroll",
			nav,
			h("a.rail-btn.attention-link", { href: "#/lavori/attenzione", onclick: closeRailOnPhone, title: "Richiede te" }, icon("approvazioni"), h("span.label", "Richiede te"), state.pendingApprovals + state.boardReview ? h("span.count", String(state.pendingApprovals + state.boardReview)) : null),
			canali,
			dms,
			h("nav.sections.rail-management", { "aria-label": "Gestione" }, h("a", { href: state.instances.length === 1 ? agentHome(state.instances[0].id) : "#/agenti", onclick: closeRailOnPhone, title: "Agenti" }, icon("agenti"), h("span.label", state.instances.length === 1 ? "Il tuo assistente" : "Agenti")), h("a", { href: "#/gestione", onclick: closeRailOnPhone, title: "Account e gestione" }, icon("gestione"), h("span.label", "Account e gestione"))),
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

