// The person's conversations, across the agents they can actually talk to.
import { api, emptyNote, face, fmt, h, head, icon, instanceHref, mount, state } from "../common.js";

export async function viewConversations(main) {
	const person = state.me;
	const agents = state.instances.filter((agent) => agent.canChat);
	mount(main, head(null, "Conversazioni", "Le tue conversazioni, con uno o più agenti."), h("p.muted", { role: "status" }, "Carico le conversazioni…"));
	const requests = agents.map(async (agent) => {
		const { threads } = await api(`/api/instances/${encodeURIComponent(agent.id)}/threads`);
		return threads.map((thread) => ({ ...thread, kind: "chat", agent }));
	});
	requests.push(api("/api/rooms").then(({ rooms }) => rooms.map((room) => ({ ...room, kind: "room" }))));
	const results = await Promise.allSettled(requests);
	if (!main.isConnected || state.me !== person) return;
	const failed = results.some((result) => result.status === "rejected");
	const talks = results.flatMap((result) => result.status === "fulfilled" ? result.value : []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const recipient = h("select", { "aria-label": "Agente della nuova conversazione" }, agents.map((agent) => h("option", { value: agent.id, selected: agent.id === state.instance?.id }, agent.name)));
	const search = h("input", { type: "search", "aria-label": "Cerca nelle tue conversazioni", placeholder: "Cerca una conversazione…" });
	const filter = h("select", { "aria-label": "Filtra per agente" }, h("option", { value: "" }, "Tutti gli agenti"), agents.map((agent) => h("option", { value: agent.id }, agent.name)));
	const list = h("div.card");
	const draw = () => {
		const q = search.value.trim().toLocaleLowerCase("it");
		const shown = talks.filter((talk) => (!q || talk.title.toLocaleLowerCase("it").includes(q)) && (!filter.value || (talk.kind === "chat" ? talk.agent.id === filter.value : talk.agents.some((agent) => (agent.instanceId ?? agent.id) === filter.value))));
		mount(list, shown.length ? h("ul.room-list", shown.map((talk) => {
			const room = talk.kind === "room";
			const participants = room ? talk.agents : [talk.agent];
			return h("li", h("a.room-row", { href: room ? `#/stanze/${encodeURIComponent(talk.id)}` : instanceHref("chat", [talk.id], talk.agent.id) },
				h("span.room-faces", participants.slice(0, 3).map((agent) => face(agent, 30))),
				h("span.room-text", h("span.room-title", h("b", talk.title || "Nuova conversazione"), h("span.muted", participants.map((agent) => agent.name).join(", "))), room ? h("span.room-last", "Conversazione con più agenti") : null),
				h("time.room-when", { datetime: talk.updatedAt, title: fmt.time(talk.updatedAt) }, fmt.short(talk.updatedAt)),
			));
		})) : emptyNote("div.empty", q || filter.value ? "Nessuna conversazione corrisponde" : failed ? "Le conversazioni non sono tutte disponibili" : "Inizia una conversazione", "Scegli a chi scrivere e affida un primo lavoro."));
	};
	search.addEventListener("input", draw);
	filter.addEventListener("change", draw);
	const retry = () => void viewConversations(main);
	mount(main,
		head(null, "Conversazioni", "Le tue conversazioni. Il ruolo di owner non dà accesso a quelle delle altre persone."),
		agents.length ? h("div.conversation-create", h("label.field", h("span", "Scrivi a"), recipient), h("button.btn.accent", { onclick: () => { location.hash = instanceHref("chat", [], recipient.value); } }, icon("compose"), "Nuova conversazione")) : h("p.muted", "Non hai accesso alla chat di alcun agente. Chiedi all'owner di aggiungerti."),
		agents.length > 1 ? h("details.conversation-team", h("summary", "Collabora con più agenti"), h("p.muted", "Scegli chi partecipa a una nuova conversazione. Lo storico delle chat singole resta separato."), h("a.btn.ghost", { href: "#/stanze/nuova" }, "Nuova conversazione con più agenti")) : null,
		failed ? h("div.card.pad.load-warning", { role: "status" }, "Alcune conversazioni non sono state caricate. L'elenco è parziale.", h("button.btn.small", { onclick: retry }, "Riprova")) : null,
		h("div.conversation-filters", search, filter), list,
	);
	draw();
}
