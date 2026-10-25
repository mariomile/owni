// The selected agent's overview and the entrances to its existing resources.
import { agentLabel, api, emptyNote, face, h, head, icon, instanceHref, mount, needInstance, state } from "../common.js";

const CHANNEL_NAMES = { web: "Console web", telegram: "Telegram", whatsapp: "WhatsApp", phone: "Telefono", mail: "Mail", agente: "Collaborazione tra agenti" };

export async function viewAgentProfile(main) {
	if (needInstance(main)) return;
	// The shell resolves #/agente/<id> against visible instances before calling this view.
	const inst = state.instance;
	const owner = state.me.role === "owner";
	const { agents } = await api("/api/agents");
	if (!main.isConnected || state.instance !== inst) return;
	const agent = agents.find((entry) => entry.id === inst.id);
	if (!agent) {
		mount(main, emptyNote("div.empty", "Agente non disponibile", "Non hai più accesso a questo agente. Torna all'elenco degli agenti."), h("a.btn", { href: "#/agenti" }, "Apri agenti"));
		return;
	}
	const link = (label, view, rest = [], glyph = "chevron") => h("a.btn.ghost", { href: instanceHref(view, rest, inst.id) }, icon(glyph), label);
	const configure = (label, section) => link(label, "impostazioni", [section], "impostazioni");
	const amount = (count, one, many) => `${count} ${count === 1 ? one : many}`;
	const automationCount = (agent.schedules ?? 0) + (agent.watches ?? 0);
	mount(main,
		head(null, h("h1", agentLabel(agent)), agent.tagline ?? "Il tuo assistente: Scrivigli quando vuoi affidargli un lavoro.", h("a.btn.ghost", { href: "#/agenti" }, icon("back"), "Agenti"), agent.canChat ? link("Scrivi all'agente", "chat", [], "chat") : null),
		h("section.card.pad.agent-overview", { "aria-labelledby": "agent-overview-title" },
			h("div.row-gap", face(agent, 60), h("div", h("h2", { id: "agent-overview-title" }, "Panoramica"), h(`span.chip${agent.busy ? ".warn" : ""}`, agent.busy ? "Sta lavorando" : "Libero"))),
			agent.doing ? h("p", `${agent.busy ? "Al lavoro su" : "Incarico in corso"}: ${agent.doing}`) : h("p.muted", "Nessun incarico in corso segnalato."),
			h("p.muted.small", [agent.model?.provider === "faux" ? "Modello di prova" : agent.model?.name, amount(automationCount, "automazione", "automazioni"), amount(agent.memories ?? 0, "ricordo accessibile", "ricordi accessibili")].filter(Boolean).join(" · ")),
			!agent.canChat ? h("p.muted", "Il tuo accesso attuale non consente di scrivere a questo agente dalla console.") : null,
			h("div.actions", link("Segui i lavori", "lavori", [], "board")),
		),
		h("div.grid-2.agent-profile-sections",
			h("section.card.pad.stack", { "aria-labelledby": "agent-materials-title" }, h("h2", { id: "agent-materials-title" }, "Materiali"),
				h("div", h("h3.section-title", "Documenti"), h("p.muted", "File ricevuti e risultati prodotti nel workspace dell'agente."), link("Apri documenti", "file", [], "file")),
				h("div", h("h3.section-title", "Memoria personale"), h("p.muted", "Quello che ricorda su di te. Le memorie delle altre persone restano private."), link("Apri memoria personale", "memoria", [], "memoria")),
				h("div", h("h3.section-title", "Memoria condivisa"), h("p.muted", `Fatti disponibili a chi usa questo agente. ${owner ? "Puoi aggiungerli e modificarli nella sezione Condivise." : "Solo l'owner aggiunge o toglie queste memorie."}`), link("Apri memoria condivisa", "memoria", [], "memoria")),
			),
			h("section.card.pad.stack", { "aria-labelledby": "agent-procedures-title" }, h("h2", { id: "agent-procedures-title" }, "Procedure"), h("p.muted", "Come svolgere un'attività: Le skill esistenti, i loro comandi e le tue bozze. Ogni persona conserva i propri diritti di modifica e attivazione."), h("div.actions", link("Apri procedure", "skill", [], "skill"))),
			h("section.card.pad.stack", { "aria-labelledby": "agent-capabilities-title" }, h("h2", { id: "agent-capabilities-title" }, "Capacità"), h("p.muted", "Servizi e strumenti, browser, computer e collaborazione. Ogni capacità mantiene i propri permessi e le approvazioni previste."), h("p.muted.small", `Canali attivi: ${(agent.channels ?? []).map((channel) => CHANNEL_NAMES[channel] ?? channel).join(", ") || "nessuno"}.`),
				owner ? h("div.actions", link("Servizi e strumenti", "connettori", [], "connettori"), configure("Browser e computer", "capacita"), configure("Canali", "canali"), configure("Collaborazione", "agenti")) : h("p.muted.small", "Chiedi all'owner per aggiungere una capacità o cambiare i canali."),
			),
			h("section.card.pad.stack", { "aria-labelledby": "agent-configuration-title" }, h("h2", { id: "agent-configuration-title" }, "Configurazione"), h("p.muted", "Identità e istruzioni, modello, persone che possono scrivere e approvare."),
				owner ? h("div.actions", configure("Identità e istruzioni", "identita"), configure("Modello", "modello"), configure("Persone e accessi", "accessi")) : h("p.muted.small", "La configurazione è riservata all'owner. Materiali, memoria personale e procedure restano raggiungibili da questo profilo."),
			),
		),
	);
}
