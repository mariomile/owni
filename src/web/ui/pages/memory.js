// Memory page.
import { agentLabel, api, confirmDialog, fmt, h, head, icon, mount, needInstance, state, toast } from "../common.js";
import { render } from "../shell.js";

// ---------- memoria ----------
export async function viewMemory(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { mine, shared, canEditShared } = await api(`/api/instances/${inst.id}/memory`);
	const forget = (m) =>
		confirmDialog("Dimenticare questa memoria?", m.text, "Dimentica", async () => {
			await api(`/api/instances/${inst.id}/memory/${m.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			render();
		});
	const rows = (memories, editable) =>
		memories.map((m) =>
			h(
				"li.task-row",
				h("div.task-text", h("b", m.text), h("small", `${m.source === "owni" ? `ricordata da ${inst.name}` : "aggiunta a mano"} · ${fmt.time(m.createdAt)}`)),
				editable ? h("button.icon-btn.task-remove", { title: "Dimentica", "aria-label": `Dimentica: ${m.text}`, onclick: () => forget(m) }, icon("trash")) : null,
			),
		);
	/** The essential memories, sent with every message; the archivio (ADR 0062) folded, with a filter, since it holds up to 1000. */
	const list = (memories, editable, empty) => {
		const essential = memories.filter((m) => !m.archived);
		const archived = memories.filter((m) => m.archived).reverse();
		const archive = () => {
			const body = h("ul.task-list.memory-list", rows(archived, editable));
			const filter = h("input", { type: "search", placeholder: "Cerca nell'archivio" });
			filter.addEventListener("input", () => {
				const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
				mount(body, rows(archived.filter((m) => words.every((w) => m.text.toLowerCase().includes(w))), editable));
			});
			return h(
				"details.memory-archive",
				h("summary", h("span.fold-glyph", icon("file")), h("span.fold-text", h("b", "In archivio"), h("small", `${archived.length === 1 ? "1 memoria" : `${archived.length} memorie`} che ${inst.name} cerca quando servono`)), h("span.fold-chevron", icon("down"))),
				archived.length > 8 ? h("div.memory-filter", filter) : null,
				body,
			);
		};
		return [
			essential.length ? h("ul.task-list.memory-list", rows(essential, editable)) : h("p.memory-empty", empty),
			archived.length ? archive() : null,
		];
	};
	const add = (isShared) => {
		const label = isShared ? "Una cosa che vale per tutti" : "Una cosa su di te";
		const text = h("textarea", { rows: 1, maxlength: 500, "aria-label": label, placeholder: isShared ? "Es. L'ufficio è chiuso dal 10 al 25 agosto" : "Es. Preferisco risposte brevi, in punti" });
		// In archivio: a detail Owni looks up when it helps, not one sent with every message.
		const archived = h("button.memory-archive-toggle", { type: "button", "aria-pressed": "false", title: "Un dettaglio che serve ogni tanto, non in ogni conversazione" }, icon("file"), "In archivio");
		archived.addEventListener("click", () => archived.setAttribute("aria-pressed", archived.getAttribute("aria-pressed") === "true" ? "false" : "true"));
		const remember = h("button.send", { type: "button", "aria-label": "Ricorda", title: "Ricorda", disabled: true }, icon("send"));
		const save = async () => {
			if (!text.value.trim()) return;
			const toArchive = archived.getAttribute("aria-pressed") === "true";
			try {
				await api(`/api/instances/${inst.id}/memory`, { method: "POST", body: { text: text.value, shared: isShared, archived: toArchive } });
				toast(toArchive ? `In archivio: ${inst.name} lo cerca quando serve` : `${inst.name} se lo ricorderà`);
				render();
			} catch (error) {
				toast(error.message, true);
			}
		};
		text.addEventListener("input", () => {
			remember.disabled = !text.value.trim();
			text.style.setProperty("height", "auto");
			text.style.setProperty("height", `${text.scrollHeight}px`);
		});
		text.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void save();
			}
		});
		remember.addEventListener("click", () => void save());
		return h("div.memory-add", text, h("div.memory-add-bar", archived, remember));
	};
	mount(main, 
		head(agentLabel(inst), h("h1", "Memoria"), `Quello che ${inst.name} ricorda di te tra una conversazione e l'altra, e le cose che valgono per tutti. Lo vede solo chi ne è il soggetto; quelle condivise le vede chiunque scriva a ${inst.name}.`),
		h(
			"div.grid-2",
			h("div.card.memory-card", h("div.pad.memory-head", h("h2", "Su di te"), mine.length ? h("span.muted", String(mine.length)) : null), list(mine, true, `${inst.name} non ricorda ancora niente di te. Puoi scrivere «ricordati che…» in chat, o aggiungerlo qui.`), add(false)),
			h("div.card.memory-card", h("div.pad.memory-head", h("h2", "Condivise"), shared.length ? h("span.muted", String(shared.length)) : null), list(shared, canEditShared, `Ancora nessuna. Quello che scrivi qui lo sa chiunque scriva a ${inst.name}.`), canEditShared ? add(true) : h("p.muted.pad", "Solo l'owner aggiunge o toglie memorie condivise.")),
		),
	);
}

