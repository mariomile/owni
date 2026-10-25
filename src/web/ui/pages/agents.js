// Agenti page.
import { agentHome, agentLabel, api, emptyNote, face, faceColor, go, h, head, icon, instanceHref, mount, state, store, toast } from "../common.js";
import { TONES } from "../tones.js";
import { refreshInstances, refreshSetup } from "../session.js";
import { render } from "../shell.js";

// ---------- agenti (ADR 0041) ----------
/** Starting points for a new agente: they only fill the form. */
const AGENT_TEMPLATES = [
	{ label: "Da zero", name: "", emoji: "", tagline: "", tone: "naturale", about: "" },
	{ label: "Assistente", name: "Assistente", emoji: "🙂", tagline: "Agenda, promemoria, mail e cose da fare", tone: "amichevole", about: "Aiuta una persona a organizzare la giornata: impegni, promemoria, liste, risposte alle mail." },
	{ label: "Ricercatore", name: "Ricercatore", emoji: "🔎", tagline: "Cerca, confronta e cita le fonti", tone: "conciso", about: "Fa ricerche sul web e nei file, confronta opzioni e fornitori, scrive report brevi con le fonti." },
	{ label: "Scrittore", name: "Scrittore", emoji: "✍️", tagline: "Testi, post e mail con la nostra voce", tone: "naturale", about: "Scrive e rivede testi: post, articoli, newsletter, mail. Chiede sempre a chi sono rivolti e che tono usare." },
	{ label: "Analista", name: "Analista", emoji: "📊", tagline: "Numeri, tabelle e grafici", tone: "conciso", about: "Risponde a domande su tabelle CSV ed Excel, fa i conti con i tool e prepara grafici e report." },
	{ label: "Assistenza clienti", name: "Assistenza", emoji: "💬", tagline: "Risponde ai clienti con garbo", tone: "formale", about: "Risponde alle domande dei clienti su prodotti, ordini e tempi, e passa a una persona quello che non sa." },
];


function slug(text) {
	return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

export function agentForm() {
	const name = h("input", { type: "text", placeholder: "Ricercatore", maxlength: "80", "aria-label": "Nome" });
	const emoji = h("input.emoji-input", { type: "text", placeholder: "🙂", maxlength: "16", "aria-label": "Emoji" });
	const id = h("input", { type: "text", placeholder: "ricercatore", class: "mono", maxlength: "63" });
	const tagline = h("input", { type: "text", maxlength: "120", placeholder: "Cerca, confronta e cita le fonti" });
	const tone = h("select", TONES.map(([value, label]) => h("option", { value }, label)));
	const instructions = h("textarea", { rows: 4, maxlength: "2000", placeholder: "Per chi lavora e cosa deve fare. Si aggiunge a quello che sa già fare; lascia vuoto per partire dalle istruzioni predefinite." });
	// The face comes from the ID: it changes while the name is written, and is the one the agente keeps.
	const preview = h("span.name-face", { title: "Il volto dell'agente, dal suo ID" });
	const draw = () => mount(preview, face({ id: id.value.trim() || "nuovo-agente" }, 40));
	let touched = false;
	id.addEventListener("input", () => {
		touched = true;
		draw();
	});
	name.addEventListener("input", () => {
		if (!touched) id.value = slug(name.value);
		draw();
	});
	const chips = h(
		"div.templates",
		{ role: "group", "aria-label": "Parti da" },
		AGENT_TEMPLATES.map((t, i) =>
			h(
				"button.pick",
				{
					type: "button",
					"aria-pressed": i === 0 ? "true" : "false",
					onclick: (e) => {
						for (const b of chips.querySelectorAll("button")) b.setAttribute("aria-pressed", "false");
						e.currentTarget.setAttribute("aria-pressed", "true");
						name.value = t.name;
						emoji.value = t.emoji;
						tagline.value = t.tagline;
						tone.value = t.tone;
						instructions.value = t.about;
						if (!touched) id.value = slug(t.name);
						draw();
						name.focus();
					},
				},
				t.emoji ? `${t.emoji} ${t.label}` : t.label,
			),
		),
	);
	draw();
	const create = async () => {
		try {
			const { instance } = await api("/api/instances", { method: "POST", body: { id: id.value.trim(), name: name.value.trim(), instructions: instructions.value, persona: { emoji: emoji.value, tagline: tagline.value, tone: tone.value } } });
			dialog.close();
			await refreshInstances();
			state.instance = state.instances.find((i) => i.id === instance.id) ?? state.instance;
			store("owni.instance", state.instance.id);
			toast(`Agente ${agentLabel(instance)} creato`);
			await refreshSetup();
			go("impostazioni");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog.agent-form",
		h("h2", "Nuovo agente"),
		h("p.muted", "Aggiungi un agente quando serve un compito o un insieme di accessi separato. Parte con il modello dell'agente principale; all'inizio solo tu puoi scrivergli. Dal profilo decidi materiali, capacità e accessi."),
		h("div.field", h("span", "Parti da"), chips),
		h("div.field", h("span", "Nome"), h("div.name-row", preview, emoji, name)),
		h("label.field", h("span", "Cosa fa, in una riga"), tagline),
		h("label.field", h("span", "Tono"), tone),
		h("label.field", h("span", "Chi lo usa e per cosa"), instructions),
		h("details.advanced", h("summary", "Avanzate"), h("label.field", h("span", "ID"), id, h("small", "Lo usa l'indirizzo dell'agente: minuscole, cifre, - e _. Non si cambia più."))),
		h("div.actions", h("button.btn.accent", { onclick: create }, "Crea agente"), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	name.focus();
}

/** Ready-made squadre (ADR 0068): a few agenti that ask each other, with a room for all of them. */
async function teamsForm() {
	let listed;
	try {
		listed = await api("/api/teams");
	} catch (error) {
		return toast(error.message, true);
	}
	const { teams, available } = listed;
	if (!available) return toast("Questa installazione non crea agenti dalla console", true);
	// One squadra at a time: every button waits while one is made.
	const busy = (on) => {
		for (const b of dialog.querySelectorAll(".team button")) b.disabled = on;
	};
	const make = async (team) => {
		busy(true);
		try {
			const { agents, room, note } = await api("/api/teams", { method: "POST", body: { team: team.key } });
			dialog.close();
			await refreshInstances();
			toast(note ?? `Squadra ${team.name} pronta: ${agents.map((a) => a.name).join(", ")}`, note !== undefined);
			if (room) go("canali", room);
			else go("agenti");
			render();
		} catch (error) {
			busy(false);
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog.teams-form",
		h("h2", "Squadre pronte"),
		h("p.muted", "Tre agenti con un compito ciascuno, che si chiedono aiuto tra loro, e una stanza dove li chiami tutti. Chi coordina divide il lavoro; sulla board può farne sotto-schede per gli altri. Dopo sono agenti come gli altri: li cambi o li elimini uno per uno."),
		h(
			"div.teams",
			teams.map((team) => {
				const button = h("button.btn.small.accent", { type: "button", onclick: () => void make(team) }, "Crea la squadra");
				return h(
					"section.team",
					h("b", `${team.emoji} ${team.name}`),
					h("p.muted.small", team.summary),
					h("ul", team.members.map((m, i) => h("li", h("span", `${m.emoji} ${m.name}`), h("small.muted", i === 0 ? `coordina · ${m.tagline}` : m.tagline)))),
					button,
				);
			}),
		),
		h("div.actions", h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}


export async function viewAgents(main) {
	const owner = state.me.role === "owner";
	const { agents } = await api("/api/agents");
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
	const writesTo = (a) => agents.filter((x) => x.acceptsFrom?.includes(a.id)).map((x) => x.name);
	// «Fate squadra»: every agente may ask every other one; the per-agente card in Impostazioni stays the fine control.
	const team = agents.filter((a) => !state.instances.find((i) => i.id === a.id)?.hasSegreteria);
	const together = team.length > 1 && team.every((a) => team.every((x) => x.id === a.id || a.acceptsFrom?.includes(x.id)));
	const setTeam = async (on) => {
		try {
			for (const a of team) await api(`/api/instances/${a.id}/agents`, { method: "PUT", body: { from: on ? team.filter((x) => x.id !== a.id).map((x) => x.id) : [] } });
			toast(on ? "Ora gli agenti possono chiedersi aiuto tra loro" : "Gli agenti non si scrivono più tra loro");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const teamButton = owner && team.length > 1 ? h("button.btn.ghost", { title: "Ogni agente può chiedere aiuto agli altri mentre lavora", onclick: () => setTeam(!together) }, together ? "Separa gli agenti" : "Fate squadra") : null;
	const card = (a) => {
		const el = h(
			`article.card.agent${a.id === state.instance?.id ? ".current" : ""}`,
			h("div.agent-face", face(a, 60)),
			h(
				"div.agent-body",
				h("h2", h("a.agent-profile-link", { href: agentHome(a.id) }, a.name), a.id === state.instance?.id ? h("span.tag", "aperto") : null),
				a.tagline ? h("p", a.tagline) : null,
				h("p.muted.small", [a.model?.provider === "faux" ? "Modello di prova" : a.model?.name, TONES.find(([v]) => v === a.tone)?.[1], a.channels.filter((c) => c !== "web" && c !== "agente").join(", ")].filter(Boolean).join(" · ")),
				h("p.muted.small", h("span.tag", a.busy ? `Occupato${a.busyFor === undefined ? "" : ` da ${a.busyFor < 90 ? `${a.busyFor} s` : `${Math.round(a.busyFor / 60)} min`}`}` : "Libero"), a.doing ? ` ${a.busy ? "sta lavorando su" : "scheda in corso"}: ${a.doing}` : ""),
				h("p.muted.small", [plural(a.schedules, "task", "task"), plural(a.watches, "sentinella", "sentinelle"), plural(a.memories, "ricordo", "ricordi")].join(" · ")),
				a.acceptsFrom?.length ? h("p.muted.small", `Gli scrivono: ${a.acceptsFrom.map((id) => agents.find((x) => x.id === id)?.name ?? id).join(", ")}`) : null,
				owner && writesTo(a).length ? h("p.muted.small", `Può scrivere a: ${writesTo(a).join(", ")}`) : null,
			),
			h(
				"div.agent-actions",
				a.canChat ? h("a.btn.small.accent", { href: instanceHref("chat", [], a.id) }, "Scrivi") : null,
				h("a.btn.small.ghost", { href: instanceHref("file", [], a.id) }, "Documenti"),
				owner ? h("a.btn.small.ghost", { href: instanceHref("impostazioni", ["identita"], a.id) }, "Configura") : null,
			),
		);
		// Each card glows in its agente's colour, so the faces read as a team and not as a list.
		el.style.setProperty("--glow", faceColor(a));
		return el;
	};
	mount(
		main,
		head(null, h("h1", "Agenti"), "Il tuo assistente e gli eventuali agenti con responsabilità separate. Di ognuno trovi documenti, memoria, procedure e configurazione.", owner ? h("button.btn.accent", { onclick: () => agentForm() }, icon("plus"), "Nuovo agente") : null),
		agents.length === 0 ? emptyNote("div.empty", "Nessun agente", owner ? "Crea il primo con Nuovo agente." : "Chiedi all'owner di aggiungerti a un agente.") : h("div.agents", agents.map(card)),
		owner ? h("details.card.fold.agent-team-options", h("summary", h("span.fold-glyph", icon("agenti")), h("span.fold-text", h("b", "Estendi il team quando serve"), h("small", "Squadre pronte e collaborazione tra agenti.")), h("span.fold-chevron", icon("down"))), h("div.fold-body", h("p.muted", "Una nuova conversazione non richiede un nuovo agente. Aggiungi una squadra o consenti la collaborazione quando vuoi dividere responsabilità e accessi."), h("div.actions", teamButton, h("button.btn.ghost", { title: "Più agenti già pronti a lavorare insieme", onclick: () => teamsForm() }, "Squadre pronte")))) : null,
	);
}

