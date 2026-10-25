// Automazioni page.
import { agentLabel, api, confirmDialog, emptyNote, fmt, h, head, icon, mount, needInstance, route, state, toast } from "../common.js";
import { copyBox } from "../listen.js";
import { refreshThreads } from "../shell.js";
import { runHistory } from "../runs.js";

// ---------- automazioni (ADR 0060) ----------
const CHANNEL_NAME = { web: "console", telegram: "Telegram", whatsapp: "WhatsApp" };

export async function viewAutomations(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const listBox = h("div.card");
	const panel = h("div.card.pad.stack", { hidden: true });
	const names = new Map();
	const remove = (a) =>
		confirmDialog(`Cancellare «${a.name}»?`, "L'indirizzo smette di funzionare: il servizio che lo chiama riceverà un errore.", "Cancella", async () => {
			await api(`/api/instances/${inst.id}/automations/${a.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			refresh();
		});
	const where = (a) => {
		if (a.channel !== "web") return `risponde su ${CHANNEL_NAME[a.channel] ?? a.channel}`;
		const t = state.threads.find((x) => x.id === a.threadId && (!x.instanceId || x.instanceId === inst.id));
		return t ? h("a", { href: `#/chat/${encodeURIComponent(t.id)}` }, `risponde in «${t.title}»`) : "risponde nella sua chat";
	};
	const runs = (a) => `${a.runs === 1 ? "1 chiamata" : `${a.runs} chiamate`}, l'ultima ${fmt.time(a.lastRunAt)}`;
	async function refresh() {
		const { automations } = await api(`/api/instances/${inst.id}/automations`);
		for (const automation of automations) names.set(automation.id, automation.name);
		mount(
			listBox,
			automations.length
				? h(
						"ul.task-list",
						automations.map((a) =>
							h(
								"li.task-row.skill-row.auto-row",
								h(`span.fold-glyph${a.runs ? ".live" : ""}`, icon("automazioni")),
								h(
									"div.task-text",
									h("b", a.name, a.runs ? null : h("span.chip", "mai chiamata")),
									h("span.skill-what", a.instruction),
									h("small", [where(a), a.runs ? runs(a) : null, a.mine ? null : a.person ? `di ${CHANNEL_NAME[a.person.channel] ?? a.person.channel} ${a.person.userId}` : null].filter(Boolean).flatMap((x, i) => (i ? [" · ", x] : [x]))),
								),
								a.canEdit ? h("div.person-actions", h("button.icon-btn.task-remove", { title: "Cancella", "aria-label": `Cancella «${a.name}»`, onclick: () => remove(a) }, icon("trash"))) : null,
							),
						),
					)
				: emptyNote("div.empty", "Nessuna automazione", `Un'automazione è un indirizzo segreto: quando un modulo, un negozio online o Stripe lo chiama, ${inst.name} lavora con i dati ricevuti e ti scrive.`),
		);
	}
	/** The address and the token, once: only a hash of the token is kept. */
	const showOnce = (a, token) => {
		const url = `${location.origin}${a.path}`;
		mount(
			panel,
			h("h2", `«${a.name}» è pronta`),
			h("p", h("b", "Copia ora il token: non si vedrà più."), " Chi lo ha fa lavorare ", inst.name, " per te, con i tuoi strumenti. Per cambiarlo cancella l'automazione e creane un'altra."),
			h("label.field", h("span", "Indirizzo (POST)"), copyBox(url, "Indirizzo")),
			h("label.field", h("span", "Token"), copyBox(token, "Token"), h("small", "Nell'intestazione Authorization: Bearer, o X-Owni-Token. Se il servizio non permette intestazioni, in fondo all'indirizzo: ?token=…")),
			h("details", h("summary", "Prova dal terminale"), copyBox(`curl -X POST ${url} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"prova": true}'`, "Comando")),
			h("div.actions", h("button.btn", { onclick: () => (panel.hidden = true) }, "Fatto, l'ho copiato")),
		);
	};
	const create = () => {
		if (!inst.canChat) return toast(`Per creare un'automazione devi poter scrivere a ${inst.name}`, true);
		const name = h("input", { type: "text", maxlength: 80, placeholder: "Es. Ordini dal sito" });
		const instruction = h("textarea", { rows: 3, maxlength: 2000, placeholder: "Es. Riassumi l'ordine e dimmi se c'è da spedire oggi" });
		const chat = h("select", h("option", { value: "" }, "Una chat nuova, con il nome dell'automazione"), state.threads.filter((t) => !t.instanceId || t.instanceId === inst.id).map((t) => h("option", { value: t.id }, t.title)));
		const save = async () => {
			if (!name.value.trim() || !instruction.value.trim()) return toast("Servono un nome e cosa deve fare", true);
			try {
				const threadId = chat.value || (await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: { title: `Automazione: ${name.value.trim()}` } })).thread.id;
				const { automation, token } = await api(`/api/instances/${inst.id}/automations`, { method: "POST", body: { name: name.value, instruction: instruction.value, threadId } });
				showOnce(automation, token);
				await refreshThreads();
				refresh();
			} catch (error) {
				toast(error.message, true);
			}
		};
		mount(
			panel,
			h("h2", "Nuovo evento esterno"),
			h("label.field", h("span", "Nome"), name),
			h("label.field", h("span", "Cosa deve fare"), instruction, h("small", `${inst.name} riceve questa istruzione con i dati della chiamata (un modulo, un ordine, un pagamento), trattati come dati e non come ordini.`)),
			h("label.field", h("span", "Dove ti risponde"), chat),
			h("div.actions", h("button.btn.accent", { onclick: save }, "Crea"), h("button.btn.ghost", { onclick: () => (panel.hidden = true) }, "Annulla")),
		);
		panel.hidden = false;
		name.focus();
	};
	await refresh();
	if (!main.isConnected || state.instance !== inst) return;
	mount(
		main,
		head(agentLabel(inst), h("h1", "Eventi esterni"), `Indirizzi segreti che fanno lavorare ${inst.name} quando un altro servizio li chiama: un modulo compilato, un ordine dal sito, un pagamento su Stripe, uno Zap. Al più 30 chiamate l'ora per automazione. Ognuno vede le sue, l'owner tutte.`, h("button.btn.accent", { onclick: create }, icon("plus"), "Nuovo evento esterno")),
		h("div.stack", panel, listBox, runHistory([inst], { sources: ["automation"], names, title: "Esiti delle tue automazioni" })),
	);
	if (route().rest[0] === "nuovo") create();
}

