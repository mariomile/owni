// Approvals page, with the connector and Google action cards.
import { api, emptyNote, fmt, h, head, icon, instanceHref, mount, route, state, toast } from "../common.js";
import { agentRequestCard, askedByNote, connectorActionCard, decideWith, decisionCard, googleActionCard } from "../cards.js";
import { refreshCounters } from "../session.js";
import { render, renderRail } from "../shell.js";

// ---------- approvazioni ----------
/** A proposed tool's name as a title: «cambio_eur» reads «Cambio eur». */
function toolTitle(name) {
	const words = name.replace(/[_-]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function viewApprovals(main) {
	const person = state.me;
	mount(main, head(null, "Autorizzazioni", "Le azioni che aspettano una tua decisione, fra gli agenti a cui hai accesso."), h("p.muted", { role: "status" }, "Carico le richieste…"));
	let inbox;
	try {
		inbox = await api("/api/approvals");
	} catch (error) {
		if (!main.isConnected || state.me !== person) return;
		mount(main, head(null, "Autorizzazioni", "Non sono riuscita a caricare tutte le richieste."), h("div.card.pad", { role: "alert" }, h("p", error.message), h("p.muted", "Questo non significa che non ci sia niente da autorizzare."), h("button.btn", { onclick: () => void viewApprovals(main) }, "Riprova")));
		return;
	}
	if (!main.isConnected || state.me !== person) return;
	const groups = inbox.groups.map(approvalGroup);
	state.pendingApprovals = inbox.pendingApprovals;
	renderRail();
	mount(main, head(null, "Autorizzazioni", "Controlla agente e conseguenza prima di decidere. Autorizzare un'azione è diverso da accettare il risultato di un incarico."),
		h("div.stack", groups.flatMap((group) => group.pending), inbox.pendingApprovals ? null : emptyNote("div.card.empty", "Niente da autorizzare", "Qui compaiono le azioni che puoi decidere, per tutti gli agenti consentiti."), groups.some((group) => group.decided.length) ? h("details.approval-history", h("summary", "Decisioni precedenti"), h("div.stack", groups.flatMap((group) => group.decided))) : null),
	);
	const [type, instanceId, id] = route().rest;
	if (type && instanceId && id) {
		const target = [...main.querySelectorAll("[data-approval]")].find((el) => el.dataset.approval === `${type}:${instanceId}:${id}`);
		if (target) {
			target.closest("details")?.setAttribute("open", "");
			target.setAttribute("tabindex", "-1");
			target.focus();
			target.scrollIntoView({ block: "start" });
		} else main.prepend(h("p.load-warning", { role: "status" }, "La richiesta non è più in attesa oppure non è disponibile. L'elenco mostra le richieste attuali."));
	}
}

/** After a decision the card has folded away: counters and the page are read again. */
const redraw = () => void refreshCounters().finally(render);

function approvalGroup(group) {
	const inst = group.instance;
	const proposals = group.proposals;
	const pending = proposals.filter((p) => p.status === "pending");
	const decided = proposals.filter((p) => p.status !== "pending").reverse().slice(0, 20);
	const mark = (type, item, el) => {
		el.dataset.approval = `${type}:${inst.id}:${item.id ?? item.praticaId}`;
		el.querySelector("header > div")?.append(h("small.dossier-meta", inst.name));
		return el;
	};
	const card = (p) => {
		const el = h(
			"article.card.pad.dossier",
			h("header", h("div", h("h2", toolTitle(p.name)), h("small.dossier-meta", `Strumento nuovo · ${fmt.time(p.proposedAt)}`)), p.status === "pending" ? h("span.chip.accent", "In attesa") : null),
			h("p", p.description),
			h("div.reach", h("span", "Si chiama"), h("span.chip.mono", `custom_${p.name}`), h("span", "e può raggiungere"), p.hosts.length ? p.hosts.map((x) => h("span.chip.mono", x)) : h("span.chip.ok", "Nessun sito: niente rete")),
			h("details", { open: p.status === "pending" ? true : undefined }, h("summary", `Codice · ${p.code.split("\n").length} righe`), h("pre.code", p.code)),
			h("details", h("summary", "Argomenti (JSON Schema)"), h("pre.code", JSON.stringify(p.parameters, null, 2))),
			p.status !== "pending" ? h(`div.stamp.${p.status === "approved" ? "ok" : "bad"}`, p.status === "approved" ? "Approvato" : "Rifiutato") : null,
			p.decidedAt ? h("p.mono.muted", `Deciso il ${fmt.time(p.decidedAt)}`) : null,
		);
		if (p.status === "pending" && inst.isApprover) {
			const decide = (decision, event) => decideWith(el, event.currentTarget, async () => {
				await api(`/api/instances/${inst.id}/proposals/${p.id}/decision`, { method: "POST", body: { decision } });
				toast(decision === "approved" ? "Strumento approvato" : "Strumento rifiutato");
			}, redraw);
			el.append(h("div.actions", h("button.btn.accent", { onclick: (e) => decide("approved", e) }, icon("check"), "Approva"), h("button.btn.danger", { onclick: (e) => decide("rejected", e) }, "Rifiuta"), h("span.muted", "Approvato, gira isolato e raggiunge solo gli host dichiarati.")));
		}
		return decisionCard(el, inst, p.status === "pending");
	};
	const actions = group.webActions;
	const ACTION_STAMP = { done: ["ok", "Inviato"], failed: ["bad", "Non inviato"], rejected: ["bad", "Rifiutato"], expired: ["bad", "Scaduto"], uncertain: ["bad", "Esito incerto"], running: ["ok", "In invio"] };
	const actionCard = (a) => {
		const el = h(
			"article.card.pad.dossier",
			h("header", h("div", h("h2", `${inst.name} vuole inviare un modulo a `, h("span.mono", new URL(a.action).host)), h("small.dossier-meta", `Modulo da inviare · ${fmt.time(a.proposedAt)}`)), a.status === "pending" ? h("span.chip.accent", "In attesa") : null),
			askedByNote(a.askedBy),
			h("p", a.reason),
			h("p", h("b", "Pagina: "), h("span.mono", a.pageUrl)),
			h("p", h("b", "Invio a: "), h("span.mono", a.action)),
			h("p.muted", "Cosa parte (tranne i campi nascosti del sito, come i token di sicurezza):"),
			h("table.ledger", h("tbody", a.shown.map(([k, v]) => h("tr", h("td.mono", k), h("td", h("pre.code", v)))))),
			a.result ? h("details", h("summary", "Risposta del sito"), h("pre.code", a.result.error ?? `${a.result.status} ${a.result.url}\n${a.result.title}\n\n${a.result.text}`)) : null,
			a.status !== "pending" && ACTION_STAMP[a.status] ? h(`div.stamp.${ACTION_STAMP[a.status][0]}`, ACTION_STAMP[a.status][1]) : null,
		);
		if (a.status === "pending") {
			const decide = (decision, event) => decideWith(el, event.currentTarget, async () => {
				const { action } = await api(`/api/instances/${inst.id}/web-actions/${a.id}/decision`, { method: "POST", body: { decision } });
				toast(action.status === "done" ? "Modulo inviato" : action.status === "rejected" ? "Richiesta rifiutata" : action.status === "failed" ? "Il modulo non è partito: vedi la risposta" : action.status === "uncertain" ? "Esito incerto: controlla sul sito" : `Richiesta ${action.status}`, action.status === "failed" || action.status === "uncertain");
			}, redraw);
			el.append(h("div.actions", h("button.btn.accent", { onclick: (e) => decide("approved", e) }, "Invia"), h("button.btn.danger", { onclick: (e) => decide("rejected", e) }, "Rifiuta"), h("span.muted", "Il modulo parte una volta sola, con questi valori. Se nel frattempo il sito lo cambia, non parte.")));
		}
		return decisionCard(el, inst, a.status === "pending");
	};
	const pendingActions = actions.filter((a) => a.status === "pending");
	const decidedActions = actions.filter((a) => a.status !== "pending").reverse();
	const connectorActions = group.connectorActions;
	const afterConnector = redraw;
	const pendingConnector = connectorActions.filter((a) => a.status === "pending").map((a) => mark("connector", a, connectorActionCard(inst, a, afterConnector)));
	const decidedConnector = connectorActions.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => mark("connector", a, connectorActionCard(inst, a, afterConnector)));
	const agentRequests = group.agentRequests;
	const pendingAgent = agentRequests.filter((a) => a.status === "pending").map((a) => mark("agent", a, agentRequestCard(inst, a, afterConnector)));
	const decidedAgent = agentRequests.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => mark("agent", a, agentRequestCard(inst, a, afterConnector)));
	const googleActions = group.googleActions;
	const afterGoogle = redraw;
	const pendingGoogle = googleActions.filter((a) => a.status === "pending").map((a) => mark("google", a, googleActionCard(inst, a, afterGoogle)));
	const decidedGoogle = googleActions.filter((a) => a.status !== "pending").reverse().slice(0, 20).map((a) => mark("google", a, googleActionCard(inst, a, afterGoogle)));
	const practices = group.pratiche.filter((practice) => practice.status === "draft_ready").map((practice) => mark("pratica", practice, h("article.card.pad.dossier",
		h("header", h("div", h("h2", practice.lead.rawSubject || "Risposta commerciale da autorizzare"), h("small.dossier-meta", "Pratica commerciale · Invio da autorizzare"))),
		h("p", practice.lead.fullName ?? practice.lead.company ?? practice.lead.email ?? "Richiesta commerciale"),
		h("a.btn", { href: instanceHref("segreteria", [practice.praticaId], inst.id) }, "Apri la pratica e controlla la bozza"),
	)));
	return {
		pending: [...practices, ...pendingGoogle, ...pendingConnector, ...pendingAgent, ...pendingActions.map((a) => mark("web", a, actionCard(a))), ...pending.map((p) => mark("proposal", p, card(p)))],
		decided: [...decidedGoogle, ...decidedConnector, ...decidedAgent, ...decidedActions.slice(0, 20).map((a) => mark("web", a, actionCard(a))), ...decided.map((p) => mark("proposal", p, card(p)))],
	};
}
