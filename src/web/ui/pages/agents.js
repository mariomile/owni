// Agenti page.
import { agentHome, agentStatus, api, dmHref, emptyNote, face, faceColor, h, head, icon, instanceHref, mount, sessionSignal, state, store, toast } from "../common.js";
import { TONES } from "../tones.js";
import { refreshInstances, refreshSetup } from "../session.js";
import { render } from "../shell.js";

// ---------- agenti (ADR 0041) ----------
/** Starting points for a new agente: they only fill the form. */
const AGENT_TEMPLATES = [
	{ label: "Da zero", name: "", tagline: "", tone: "naturale", about: "" },
	{ label: "Assistente", name: "Assistente", tagline: "Agenda, promemoria, mail e cose da fare", tone: "amichevole", about: "Aiuta una persona a organizzare la giornata: impegni, promemoria, risposte alle mail." },
	{ label: "Ricercatore", name: "Ricercatore", tagline: "Cerca, confronta e cita le fonti", tone: "conciso", about: "Fa ricerche sul web e nei file, confronta opzioni e fornitori, scrive report brevi con le fonti." },
	{ label: "Scrittore", name: "Scrittore", tagline: "Testi, post e mail con la nostra voce", tone: "naturale", about: "Scrive e rivede testi: post, articoli, newsletter, mail. Chiede sempre a chi sono rivolti e che tono usare." },
	{ label: "Analista", name: "Analista", tagline: "Numeri, tabelle e grafici", tone: "conciso", about: "Risponde a domande su tabelle CSV ed Excel, fa i conti con i tool e prepara grafici e report." },
	{ label: "Assistenza clienti", name: "Assistenza", tagline: "Risponde ai clienti con garbo", tone: "formale", about: "Risponde alle domande dei clienti su prodotti, ordini e tempi, e passa a una persona quello che non sa." },
];


function slug(text) {
	return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

export function agentForm() {
	const name = h("input", { type: "text", placeholder: "Ricercatore", maxlength: "80", "aria-label": "Nome" });
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
						tagline.value = t.tagline;
						tone.value = t.tone;
						instructions.value = t.about;
						if (!touched) id.value = slug(t.name);
						draw();
						name.focus();
					},
				},
				t.label,
			),
		),
	);
	draw();
	const create = async () => {
		try {
			const signal = sessionSignal();
			const { instance } = await api("/api/instances", { method: "POST", body: { id: id.value.trim(), name: name.value.trim(), instructions: instructions.value, persona: { tagline: tagline.value, tone: tone.value } } });
			dialog.close();
			await refreshInstances();
			// The counters swallow a cancelled read: refreshInstances returns even when the person left meanwhile.
			if (signal.aborted) return;
			state.instance = state.instances.find((i) => i.id === instance.id) ?? state.instance;
			store("owni.instance", state.instance.id);
			// Straight into its conversation: the first thing to do with a new agente is to write to it.
			toast(`Agente ${instance.name} creato`, false, { label: "Configura", href: instanceHref("impostazioni", ["identita"], instance.id) });
			await refreshSetup();
			location.hash = dmHref(instance.id);
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
		h("div.field", h("span", "Nome"), h("div.name-row", preview, name)),
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

export async function viewAgents(main) {
	const owner = state.me.role === "owner";
	const { agents } = await api("/api/agents");
	// Only what there is: a count of zero says nothing.
	const counts = (a) => [[a.schedules + a.watches, "automazione", "automazioni"], [a.memories, "ricordo", "ricordi"]].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
	const writesTo = (a) => agents.filter((x) => x.acceptsFrom?.includes(a.id)).map((x) => x.name);
	const card = (a) => {
		const el = h(
			`article.card.agent${a.id === state.instance?.id ? ".current" : ""}`,
			h("div.agent-face", face(a, 60)),
			h(
				"div.agent-body",
				h("h2", h("a.agent-profile-link", { href: agentHome(a.id) }, a.name), a.id === state.instance?.id ? h("span.tag", "aperto") : null),
				a.tagline ? h("p", a.tagline) : null,
				h("p.muted.small", [a.model?.provider === "faux" ? "Modello di prova" : a.model?.name, TONES.find(([v]) => v === a.tone)?.[1], a.channels.filter((c) => c !== "web" && c !== "agente").join(", ")].filter(Boolean).join(" · ")),
				h("p.small", agentStatus(a)),
				counts(a).length ? h("p.muted.small", counts(a).join(" · ")) : null,
				a.acceptsFrom?.length ? h("p.muted.small", `Gli scrivono: ${a.acceptsFrom.map((id) => agents.find((x) => x.id === id)?.name ?? id).join(", ")}`) : null,
				owner && writesTo(a).length ? h("p.muted.small", `Può scrivere a: ${writesTo(a).join(", ")}`) : null,
			),
			h(
				"div.agent-actions",
				// One thing to do with an agente: write to it. Its name opens the details.
				a.canChat ? h("a.btn.small.accent", { href: dmHref(a.id) }, "Scrivi") : null,
				owner ? h("a.quiet-link", { href: instanceHref("impostazioni", ["identita"], a.id) }, "Configura") : null,
			),
		);
		// Each card glows in its agente's colour, so the faces read as a team and not as a list.
		el.style.setProperty("--glow", faceColor(a));
		return el;
	};
	mount(
		main,
		head(
			null,
			h("h1", "Agenti"),
			owner ? ["Il tuo assistente e gli agenti con responsabilità separate. Ruoli e chi scrive a chi sono nell'", h("a", { href: "#/organigramma" }, "organigramma"), "."] : "Il tuo assistente e gli agenti con responsabilità separate.",
			owner ? h("button.btn.accent", { onclick: () => agentForm() }, icon("plus"), "Nuovo agente") : null,
		),
		agents.length === 0 ? emptyNote("div.empty", "Nessun agente", owner ? "Crea il primo con Nuovo agente." : "Chiedi all'owner di aggiungerti a un agente.") : h("div.agents", agents.map(card)),
	);
}

