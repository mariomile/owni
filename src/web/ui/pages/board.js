// Board page.
import { api, confirmDialog, face, fmt, go, h, head, icon, mount, route, instanceHref, state, store, toast } from "../common.js";
import { refreshInstances, refreshSetup } from "../session.js";
import { render } from "../shell.js";

// ---------- board (ADR 0050) ----------
const BOARD_COLUMNS = [
	["da_fare", "Da fare"],
	["in_corso", "In corso"],
	["da_rivedere", "Da rivedere"],
	["fatto", "Fatto"],
];
const REPEATS = [
	["", "No, una volta sola"],
	["giorno", "Ogni giorno"],
	["feriali", "Dal lunedì al venerdì"],
	["settimana", "Ogni settimana"],
	["mese", "Ogni mese"],
];
/** «lunedì 20 ott, 09:00»: when a scheda that comes back is made next. */
function whenNext(iso) {
	return new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const WEEKDAYS = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
/** A scheda's scadenza (ADR 0073), counted in Rome's days: { days, text, level } with level late, soon or later. */
function dueInfo(due) {
	const part = (type) => parts.find((p) => p.type === type).value;
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
	const today = `${part("year")}-${part("month")}-${part("day")}`;
	const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
	// The year only when it is not this one.
	const label = new Date(`${due}T12:00:00Z`).toLocaleDateString("it-IT", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(due.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }) });
	const text = days < 0 ? (days === -1 ? "in ritardo di un giorno" : `in ritardo di ${-days} giorni`) : days === 0 ? "scade oggi" : days === 1 ? "scade domani" : `scade ${label}`;
	return { days, text, label, level: days < 0 ? "late" : days <= 1 ? "soon" : "later" };
}
const PRIORITIES = [
	["bassa", "Bassa"],
	["normale", "Normale"],
	["alta", "Alta"],
];

export async function viewBoard(main) {
	const data = await api("/api/board");
	const agentOf = (id) => data.agents.find((a) => a.id === id);
	const who = (actor) => (actor.kind === "agent" ? (agentOf(actor.id)?.name ?? "un agente") : actor.id === state.me.id ? "Tu" : (data.people[actor.id] ?? "una persona"));
	// The assignee's face; it looks around while the scheda is being worked on.
	const faceOf = (id, mood) => {
		const a = agentOf(id);
		return a ? face(a, 20, mood) : null;
	};
	const save = async (card, body, done) => {
		try {
			await api(`/api/board/${card.id}`, { method: "PUT", body });
			if (done) toast(done);
			render();
			return true;
		} catch (error) {
			toast(error.message, true);
			return false;
		}
	};
	// Sotto-schede (ADR 0066): one level, shown under the scheda they are part of.
	const parentOf = (c) => (c.parent ? data.cards.find((x) => x.id === c.parent) : undefined);
	const childrenOf = (c) => data.cards.filter((x) => x.parent === c.id).sort((a, b) => a.n - b.n);
	// Schede that come after others (ADR 0076): those it still waits for, of the ones shown here.
	const beforeOf = (c) => (c.after ?? []).map((id) => data.cards.find((x) => x.id === id)).filter(Boolean);
	const waitsOn = (c) => (c.status === "fatto" ? [] : beforeOf(c).filter((x) => x.status !== "fatto"));
	const nums = (cards) => cards.map((x) => `#${x.n}`).join(", ");
	// What the agente said when it moved the scheda to «Da rivedere»: the result to review, not a line of the history.
	const resultOf = (c) => {
		if (c.status !== "da_rivedere" && c.status !== "fatto") return undefined;
		const moved = c.events.findLastIndex((e) => e.kind === "status" && e.status === "da_rivedere");
		return moved < 0 ? undefined : c.events.slice(moved).find((e) => e.kind === "comment" && e.by.kind === "agent");
	};
	const whenDone = (cards) => (cards.length === 1 ? `quando #${cards[0].n} è fatta` : cards.length ? `quando ${nums(cards)} sono fatte` : "quando le schede prima sono fatte");
	const started = (card) => (card.queued ? `Parte da sola ${whenDone(waitsOn(card))}` : `${agentOf(card.assignee)?.name ?? "L'agente"} ci sta lavorando`);
	const aloneLabel = `Lavora da solo fino alla fine, senza aspettare le tue risposte (al massimo ${data.auto.replies} risposte o ${data.auto.hours} ore, poi va in «Da rivedere»)`;
	// Dragged to another column (ADR 0051): the same moves as the buttons of the scheda.
	const moveTo = async (c, status) => {
		if (status === c.status) return;
		if (status === "in_corso" && c.status === "da_fare") {
			if (!c.assignee || !agentOf(c.assignee)?.canAssign) return toast("Affidala prima a un agente a cui puoi scrivere", true);
			try {
				const { card } = await api(`/api/board/${c.id}/start`, { method: "POST" });
				toast(started(card));
				render();
			} catch (error) {
				toast(error.message, true);
			}
			return;
		}
		// Sent back from review: with what to change, written in the scheda.
		if (status === "in_corso" && c.status === "da_rivedere") return cardDialog(c, true);
		await save(c, { status }, `Scheda #${c.n} in «${BOARD_COLUMNS.find(([v]) => v === status)[1]}»`);
	};
	const tile = (c) =>
		h(
			// A div, not a button: Firefox does not drag buttons.
			`div.board-card${c.priority === "alta" ? ".alta" : ""}`,
			{
				role: "button",
				tabindex: "0",
				draggable: "true",
				onclick: () => cardDialog(c),
				onkeydown: (e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					cardDialog(c);
				},
				ondragstart: (e) => {
					e.dataTransfer.setData("text/x-scheda", c.id);
					e.dataTransfer.effectAllowed = "move";
					e.currentTarget.classList.add("dragging");
				},
				ondragend: (e) => e.currentTarget.classList.remove("dragging"),
			},
			h("span.board-title", h("span.muted.mono", `#${c.n} `), c.title),
			c.parent && parentOf(c) ? h("span.muted.small", `parte di #${parentOf(c).n}`) : null,
			c.status === "da_rivedere" && resultOf(c) ? h("span.board-result-snip", resultOf(c).text) : null,
			h(
				"span.board-meta",
				c.assignee ? [faceOf(c.assignee, c.status === "in_corso" ? "thinking" : "idle"), h("span", agentOf(c.assignee)?.name ?? "agente eliminato")] : h("span.muted", "Non assegnata"),
				c.priority === "normale" ? null : h("span.tag", `priorità ${c.priority}`),
				waitsOn(c).length ? h("span.tag.board-after", { title: c.queued ? `Parte da sola ${whenDone(waitsOn(c))}` : `Viene dopo ${nums(waitsOn(c))}` }, `${c.queued ? "parte " : ""}dopo ${nums(waitsOn(c))}`) : null,
				c.checklist?.length ? h(`span.tag.board-checks${c.checklist.every((i) => i.done) ? ".all" : ""}`, { title: "Lista di controllo" }, `☑ ${c.checklist.filter((i) => i.done).length}/${c.checklist.length}`) : null,
				c.due && c.status !== "fatto" ? h(`span.tag.board-due.${dueInfo(c.due).level}`, { title: `Scadenza: ${dueInfo(c.due).label}` }, dueInfo(c.due).text) : null,
				c.auto && c.status === "in_corso" ? h("span.tag", { title: `Lavora da solo: risposta ${c.auto.rounds} di ${data.auto.replies}` }, "da solo") : null,
			),
		);
	// Cerca e filtri: what is shown, remembered on this browser (`owni.board.filter`).
	const filter = (() => {
		try {
			const f = JSON.parse(store("owni.board.filter") ?? "{}");
			return { q: typeof f.q === "string" ? f.q : "", agent: typeof f.agent === "string" ? f.agent : "", mine: f.mine === true, due: f.due === true };
		} catch {
			return { q: "", agent: "", mine: false, due: false };
		}
	})();
	const plain = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
	const passes = (c) => {
		if (filter.agent === "-" ? c.assignee : filter.agent && c.assignee !== filter.agent) return false;
		if (filter.mine && !((c.createdBy.kind === "person" && c.createdBy.id === state.me.id) || c.work?.personId === state.me.id)) return false;
		if (filter.due && !(c.due && c.status !== "fatto" && dueInfo(c.due).days <= 1)) return false;
		const words = plain(filter.q).split(/\s+/).filter(Boolean);
		const text = plain(`#${c.n} ${c.title} ${c.description}`);
		return words.every((w) => text.includes(w));
	};
	const filtering = () => Boolean(filter.q.trim() || filter.agent || filter.mine || filter.due);
	const lanes = () => h(
		"div.board",
		BOARD_COLUMNS.map(([status, label]) => {
			const cards = data.cards.filter((c) => c.status === status && passes(c)).sort((a, b) => (status === "fatto" ? b.updatedAt.localeCompare(a.updatedAt) : (b.priority === "alta") - (a.priority === "alta") || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.n - b.n));
			const col = h(
				`section.board-col.${status}`,
				{
					"aria-label": label,
					ondragover: (e) => {
						if (!e.dataTransfer.types.includes("text/x-scheda")) return;
						e.preventDefault();
						col.classList.add("drop");
					},
					ondragleave: (e) => {
						if (!col.contains(e.relatedTarget)) col.classList.remove("drop");
					},
					ondrop: (e) => {
						e.preventDefault();
						col.classList.remove("drop");
						const card = data.cards.find((x) => x.id === e.dataTransfer.getData("text/x-scheda"));
						if (card) void moveTo(card, status);
					},
				},
				h("h2", h("span.board-col-name", h("i.board-dot", { "aria-hidden": "true" }), label), h("span.board-count", String(cards.length))),
				cards.length ? cards.map(tile) : h("p.muted.small", filtering() ? "Nessuna scheda con questi filtri" : status === "da_rivedere" ? "Qui arrivano le schede finite dagli agenti, da approvare." : "Nessuna scheda"),
			);
			return col;
		}),
	);
	let columns = lanes();
	const search = h("input", { type: "search", value: filter.q, placeholder: "Cerca nelle schede", "aria-label": "Cerca nelle schede" });
	const agentFilter = h(
		"select",
		{ "aria-label": "Agente" },
		h("option", { value: "" }, "Tutti gli agenti"),
		h("option", { value: "-", selected: filter.agent === "-" ? "selected" : undefined }, "Non assegnate"),
		data.agents.map((a) => h("option", { value: a.id, selected: filter.agent === a.id ? "selected" : undefined }, a.emoji ? `${a.emoji} ${a.name}` : a.name)),
	);
	const toggleChip = (key, label) => {
		const b = h("button.chip.board-chip", { type: "button", "aria-pressed": String(filter[key]) }, label);
		b.onclick = () => {
			filter[key] = !filter[key];
			b.setAttribute("aria-pressed", String(filter[key]));
			redraw();
		};
		return b;
	};
	const mineChip = toggleChip("mine", "Mie");
	const dueChip = toggleChip("due", "In ritardo o in scadenza");
	const count = h("span.muted.small.board-filter-count");
	const clear = h("button.btn.small.ghost", { type: "button" }, "Azzera");
	const redraw = () => {
		store("owni.board.filter", filtering() ? JSON.stringify(filter) : null);
		const next = lanes();
		columns.replaceWith(next);
		columns = next;
		const shownCount = data.cards.filter(passes).length;
		count.textContent = filtering() ? `${shownCount} di ${data.cards.length}` : "";
		clear.hidden = !filtering();
	};
	search.addEventListener("input", () => {
		filter.q = search.value;
		redraw();
	});
	agentFilter.addEventListener("change", () => {
		filter.agent = agentFilter.value;
		redraw();
	});
	clear.onclick = () => {
		Object.assign(filter, { q: "", agent: "", mine: false, due: false });
		search.value = "";
		agentFilter.value = "";
		mineChip.setAttribute("aria-pressed", "false");
		dueChip.setAttribute("aria-pressed", "false");
		redraw();
	};
	const filters = data.cards.length ? h("div.board-filters", { role: "search" }, search, agentFilter, mineChip, dueChip, count, clear) : null;

	// One scheda: what it asks, who has it, what happened, and the moves a person makes.
	const cardDialog = (c, sendBack = false) => {
		const mine = c.work?.personId === state.me.id;
		const assignable = data.agents.filter((a) => a.canAssign || a.id === c.assignee);
		const assignee = h("select", { "aria-label": "Assegnata a" }, h("option", { value: "" }, "Nessuno"), assignable.map((a) => h("option", { value: a.id, selected: a.id === c.assignee ? "selected" : undefined }, a.emoji ? `${a.emoji} ${a.name}` : a.name)));
		// «In corso» comes from Avvia, which hands the scheda to the agente; not from a list.
		const status = h(
			"select",
			{ "aria-label": "Colonna" },
			BOARD_COLUMNS.filter(([v]) => v !== "in_corso" || c.status !== "da_fare").map(([v, l]) => h("option", { value: v, selected: v === c.status ? "selected" : undefined }, l)),
		);
		const due = h("input", { type: "date", value: c.due ?? "", "aria-label": "Scadenza" });
		const after = h("input", { type: "text", value: nums(beforeOf(c)), placeholder: "Es. #3, #5", "aria-label": "Viene dopo le schede" });
		const comment = h("textarea", { rows: 2, placeholder: c.status === "da_rivedere" ? "Cosa va cambiato, se la rimandi indietro" : mine && c.status === "in_corso" ? "Arriva anche all'agente, nella conversazione" : "Un commento" });
		const events = c.events.filter((e) => e.kind !== "edited" || e.due !== undefined || e.after !== undefined).slice(-30);
		// Lista di controllo (ADR 0075): each tick is saved at once.
		const checkList = h("ul.board-checklist");
		let checksChanged = false;
		const checkInput = h("input", { type: "text", maxlength: 200, placeholder: "Aggiungi un passo", "aria-label": "Aggiungi un passo alla lista" });
		const sendCheck = async (check) => {
			try {
				const { card } = await api(`/api/board/${c.id}`, { method: "PUT", body: { check } });
				c = card;
				checksChanged = true;
				drawChecks();
				return true;
			} catch (error) {
				toast(error.message, true);
				return false;
			}
		};
		const drawChecks = () => {
			const items = c.checklist ?? [];
			checkCount.textContent = items.length ? `${items.filter((i) => i.done).length} di ${items.length}` : "";
			checkList.replaceChildren(
				...items.map((item) =>
					h(
						`li${item.done ? ".done" : ""}`,
						h("label", h("input", { type: "checkbox", checked: item.done, onchange: (e) => void sendCheck({ item: item.id, done: e.currentTarget.checked }) }), h("span", item.text)),
						h("button.icon-btn.small", { type: "button", title: "Togli dalla lista", "aria-label": `Togli «${item.text}»`, onclick: () => void sendCheck({ item: item.id, remove: true }) }, icon("close")),
					),
				),
			);
		};
		const checkCount = h("span.muted.small");
		// Without a list, one quiet button: the box opens when asked.
		const checksBox = h("div.board-checks-box", { hidden: !c.checklist?.length }, h("div.board-checks-head", h("span", "Lista di controllo"), checkCount), checkList, h("div.board-check-add", checkInput, h("button.btn.small", { type: "button", onclick: () => void addCheck() }, "Aggiungi")));
		const checksOpen = h(
			"button.btn.small.ghost.board-checks-open",
			{
				type: "button",
				hidden: Boolean(c.checklist?.length),
				onclick: () => {
					checksBox.hidden = false;
					checksOpen.hidden = true;
					checkInput.focus();
				},
			},
			icon("plus"),
			"Lista di controllo",
		);
		const addCheck = async () => {
			if (!checkInput.value.trim()) return;
			if (await sendCheck({ add: checkInput.value })) checkInput.value = "";
			checkInput.focus();
		};
		checkInput.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			void addCheck();
		});
		drawChecks();
		// The cronologia as a timeline: what happened, who and when at the side.
		const line = (e) =>
			h(
				`li.ev-${e.kind}`,
				h("span.ev-dot", { "aria-hidden": "true" }),
				h(
					"div.ev-text",
					e.kind === "created"
						? "ha creato la scheda"
						: e.kind === "status"
							? `l'ha spostata in «${BOARD_COLUMNS.find(([v]) => v === e.status)?.[1] ?? e.status}»`
							: e.kind === "assigned"
								? e.assignee
									? `l'ha assegnata a ${agentOf(e.assignee)?.name ?? "un agente"}`
									: `ha tolto l'assegnazione${e.text ? ` (${e.text})` : ""}`
								: e.kind === "check"
									? e.removed
										? `ha tolto dalla lista «${e.text}»`
										: e.done === true
											? `ha spuntato «${e.text}»`
											: e.done === false
												? `ha tolto la spunta a «${e.text}»`
												: `ha aggiunto alla lista «${e.text}»`
									: e.kind === "edited" && e.after
										? e.after.length
											? `ha messo che viene dopo ${e.after.map((n) => `#${n}`).join(", ")}`
											: "ha tolto le schede da aspettare"
									: e.kind === "edited"
									? e.due
										? `ha messo la scadenza a ${dueInfo(e.due).label}`
										: "ha tolto la scadenza"
									: e.text,
				),
				h("span.ev-when", h("b", who(e.by)), " · ", h("time", { datetime: e.at }, fmt.time(e.at))),
			);
		const dialog = h("dialog.board-dialog");
		const act = (body, done) => async () => {
			if (await save(c, body, done)) dialog.close();
		};
		const withComment = (body) => (comment.value.trim() ? { ...body, comment: comment.value } : body);
		const openThread = async () => {
			dialog.close();
			// An agente created after this page was loaded is not in the list yet.
			store("owni.instance", c.work.agent);
			await refreshInstances();
			if (state.instance?.id !== c.work.agent) {
				if (state.instance) store("owni.instance", state.instance.id);
				return toast("Non puoi più scrivere a questo agente", true);
			}
			state.threads = [];
			void refreshSetup();
			go("chat", c.work.threadId);
		};
		const moves = [];
		// «Esegui da solo» (ADR 0061): the agente goes on without waiting for answers, then to review.
		const alone = h("input", { type: "checkbox", checked: c.auto !== undefined });
		const aloneRow = h("label.board-alone", alone, h("span", aloneLabel));
		if (c.status === "da_rivedere") {
			moves.push(h("button.btn.accent", { onclick: act(withComment({ status: "fatto" }), `Risultato dell’incarico #${c.n} accettato`) }, icon("check"), "Accetta risultato"));
			moves.push(
				h(
					"button.btn",
					{
						onclick: () => {
							if (!comment.value.trim()) {
								comment.focus();
								return toast("Scrivi cosa va cambiato", true);
							}
							void act({ status: "in_corso", comment: comment.value }, mine ? `Scheda #${c.n} rimandata a ${agentOf(c.assignee)?.name ?? "l'agente"}` : `Scheda #${c.n} rimandata in «Da fare»: premi Avvia per lavorarci con l'agente`)();
						},
					},
					"Rimanda indietro",
				),
			);
		}
		// Already started while it waits (ADR 0076): nothing to press.
		if (c.status === "da_fare" && c.assignee && agentOf(c.assignee)?.canAssign && !c.queued)
			moves.push(
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								const { card } = await api(`/api/board/${c.id}/start`, { method: "POST", body: { auto: alone.checked } });
								dialog.close();
								toast(started(card));
								render();
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Avvia",
				),
			);
		if (mine && c.work.agent === c.assignee && c.status !== "da_fare") moves.push(h("button.btn.ghost", { onclick: openThread }, "Apri la conversazione"));
		const startable = c.status === "da_fare" && c.assignee && agentOf(c.assignee)?.canAssign && !c.queued;
		const working = mine && c.work.agent === c.assignee && c.status === "in_corso";
		if (working)
			alone.addEventListener("change", async () => {
				if (!(await save(c, { auto: alone.checked }, alone.checked ? `${agentOf(c.assignee)?.name ?? "L'agente"} va avanti da solo` : "Ora l'agente aspetta le tue risposte"))) alone.checked = !alone.checked;
			});
		const canDelete = state.me.role === "owner" || (c.createdBy.kind === "person" && c.createdBy.id === state.me.id);
		const parent = parentOf(c);
		const children = childrenOf(c);
		// Chi segue cosa (ADR 0110), for the owner: shown only when the scheda is linked to some record.
		const subjectsBox = state.me.role === "owner" ? h("section.board-subjects") : null;
		if (subjectsBox)
			api(`/api/board/${c.id}/subjects`)
				.then(({ linked, others }) => {
					if (!linked.length) return;
					const item = (e) => h("li", `${e.agent}: ${e.kind} ${e.id}`, e.card && e.card !== c.n ? h("span.muted.small", ` · scheda #${e.card}`) : null);
					subjectsBox.append(
						h("h3", "Chi segue cosa"),
						h("ul", linked.map(item)),
						others.length ? h("p.small", "Lo stesso cliente o fornitore lo segue anche:") : h("p.muted.small", "Nessun altro agente segue lo stesso cliente o fornitore."),
						others.length ? h("ul", others.map(item)) : null,
					);
				})
				.catch(() => {});
		// Without what is not there: append would write «null».
		const parts = [
			h(
				"div.board-dialog-head",
				h(`span.board-state.${c.status}`, h("span.board-dot"), BOARD_COLUMNS.find(([v]) => v === c.status)?.[1] ?? c.status),
				c.priority === "normale" ? null : h(`span.tag${c.priority === "alta" ? ".alta" : ""}`, `priorità ${c.priority}`),
			),
			h("h2", c.title),
			h("small.dossier-meta", `#${c.n} · creata da ${c.createdBy.kind === "person" && c.createdBy.id === state.me.id ? "te" : who(c.createdBy)} il ${fmt.day(c.createdAt)}`),
			c.description ? h("p.board-desc", c.description) : null,
			resultOf(c) ? h("div.board-result", h("span.small", `Il risultato di ${who(resultOf(c).by)}, ${fmt.time(resultOf(c).at)}`), h("p", resultOf(c).text)) : null,
			checksBox,
			checksOpen,
			parent ? h("p.small", "Fa parte di ", h("a", { href: "#", onclick: (e) => (e.preventDefault(), dialog.close(), cardDialog(parent)) }, `#${parent.n} ${parent.title}`)) : null,
			children.length
				? h(
						"div.board-children",
						h("span.muted.small", `Sotto-schede: ${children.filter((x) => x.status === "fatto").length} di ${children.length} fatte`),
						h(
							"ul",
							children.map((x) =>
								h(
									"li",
									h("a", { href: "#", onclick: (e) => (e.preventDefault(), dialog.close(), cardDialog(x)) }, `#${x.n} ${x.title}`),
									h("span.muted.small", ` · ${BOARD_COLUMNS.find(([v]) => v === x.status)[1]}${x.assignee ? ` · ${agentOf(x.assignee)?.name ?? "agente eliminato"}` : ""}`),
								),
							),
						),
					)
				: null,
			h("div.board-fields", h("label.field", h("span", "Assegnata a"), assignee), h("label.field", h("span", "Colonna"), status), c.status === "fatto" ? null : h("label.field", h("span", "Scadenza"), due), c.status === "fatto" ? null : h("label.field", h("span", "Viene dopo"), after)),
			waitsOn(c).length
				? h(
						"p.small.board-after-line",
						"Aspetta ",
						waitsOn(c).flatMap((x, i) => [i ? ", " : "", h("a", { href: "#", onclick: (e) => (e.preventDefault(), dialog.close(), cardDialog(x)) }, `#${x.n} ${x.title}`)]),
						c.queued ? `: poi parte da sola con ${c.queued.personId === state.me.id ? "te" : (data.people[c.queued.personId] ?? "chi l'ha avviata")}.` : c.status === "da_fare" && c.assignee ? ": se premi Avvia, parte da sola appena sono fatte." : ".",
					)
				: null,
			c.due && c.status !== "fatto" ? h(`p.small.board-due-line.${dueInfo(c.due).level}`, `${dueInfo(c.due).text[0].toUpperCase()}${dueInfo(c.due).text.slice(1)}.`) : null,
			moves.length ? h("div.actions", moves) : null,
			startable || working ? aloneRow : null,
			working && c.auto ? h("p.muted.small", `Risposte senza di te: ${c.auto.rounds} di ${data.auto.replies}.`) : null,
			subjectsBox,
			events.length ? h("section.board-history", h("h3", "Cronologia"), h("ul.board-events", events.map(line))) : null,
			h("label.field", h("span", "Commento"), comment),
			h(
				"div.actions",
				h(
					"button.btn",
					{
						onclick: () => {
							const body = withComment({});
							if (assignee.value !== (c.assignee ?? "")) body.assignee = assignee.value;
							if (status.value !== c.status) body.status = status.value;
							// A date half typed reads as empty: it would take the scadenza off.
							if (due.validity.badInput) return toast("La scadenza non è una data completa", true);
							if (c.status !== "fatto" && due.value !== (c.due ?? "")) body.due = due.value || null;
							const wanted = after.value.match(/\d+/g) ?? [];
							if (c.status !== "fatto" && wanted.join() !== beforeOf(c).map((x) => String(x.n)).join()) body.after = wanted.length ? wanted : null;
							if (Object.keys(body).length === 0) return dialog.close();
							void act(body, "Scheda aggiornata")();
						},
					},
					"Salva",
				),
				h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi"),
				canDelete
					? h(
							"button.icon-btn.board-delete",
							{
								title: "Elimina la scheda",
								"aria-label": `Elimina la scheda #${c.n}`,
								onclick: async () => {
									if (!confirm(`Eliminare la scheda #${c.n}?`)) return;
									try {
										await api(`/api/board/${c.id}`, { method: "DELETE" });
										dialog.close();
										toast("Scheda eliminata");
										render();
									} catch (error) {
										toast(error.message, true);
									}
								},
							},
							icon("trash"),
						)
					: null,
			),
		];
		dialog.append(...parts.filter((x) => x !== null));
		dialog.addEventListener("close", () => {
			dialog.remove();
			// Ticks saved while open: the board shows the new count.
			if (checksChanged) render();
		});
		document.body.append(dialog);
		dialog.showModal();
		// Opened to read: no field takes the focus, and the keyboard opens no menu on the phone.
		dialog.tabIndex = -1;
		dialog.focus();
		if (sendBack) {
			comment.focus();
			toast("Scrivi cosa va cambiato e premi Rimanda indietro");
		}
	};

	const newCard = (intent) => {
		const title = h("input.board-new-title", { type: "text", maxlength: 120, placeholder: "Titolo dell’incarico", "aria-label": "Titolo" });
		const description = h("textarea.board-new-desc", { rows: 4, placeholder: "Cosa fare e quando è finito: l'agente vede solo questo", "aria-label": "Descrizione" });
		const assignee = h("select", h("option", { value: "" }, "Nessuno, per ora"), data.agents.filter((a) => a.canAssign).map((a) => h("option", { value: a.id }, a.emoji ? `${a.emoji} ${a.name}` : a.name)));
		if (route().instanceId && data.agents.some((a) => a.id === route().instanceId && a.canAssign)) assignee.value = route().instanceId;
		const priority = h("select", PRIORITIES.map(([v, l]) => h("option", { value: v, selected: v === "normale" ? "selected" : undefined }, l)));
		const due = h("input", { type: "date", "aria-label": "Scadenza" });
		const parents = data.cards.filter((x) => !x.parent && x.status !== "fatto").sort((a, b) => a.n - b.n);
		const parent = h("select", h("option", { value: "" }, "Nessuna"), parents.map((x) => h("option", { value: x.id }, `#${x.n} ${x.title}`)));
		const opens = data.cards.filter((x) => x.status !== "fatto").sort((a, b) => a.n - b.n);
		const after = h("select", h("option", { value: "" }, "Nessuna, parte subito"), opens.map((x) => h("option", { value: x.id }, `#${x.n} ${x.title}`)));
		const alone = h("input", { type: "checkbox" });
		const aloneRow = h("label.board-alone", { hidden: true }, alone, h("span", aloneLabel));
		// «Si ripete» (ADR 0069): only for a scheda handed to an agente.
		const every = h("select", REPEATS.map(([v, l]) => h("option", { value: v }, l)));
		const time = h("input", { type: "time", value: "09:00", step: "300", "aria-label": "Ora" });
		const weekday = h("select", { "aria-label": "Giorno" }, WEEKDAYS.map((d, i) => h("option", { value: String(i + 1) }, d)));
		const monthday = h("select", { "aria-label": "Giorno del mese" }, Array.from({ length: 28 }, (_, i) => h("option", { value: String(i + 1) }, `il ${i + 1}`)));
		const repeatWhen = h("div.board-repeat-when", { hidden: true }, weekday, monthday, h("span", "alle"), time);
		const repeatRow = h("div.field", { hidden: true }, h("span", "Si ripete"), h("div.board-repeat", every, repeatWhen));
		const drawRepeat = () => {
			repeatWhen.hidden = !every.value;
			weekday.hidden = every.value !== "settimana";
			monthday.hidden = every.value !== "mese";
			ok.textContent = every.value ? "Programma" : "Crea";
			// A scheda that repeats has no date, parent or order of its own.
			more.hidden = Boolean(every.value);
		};
		every.addEventListener("change", drawRepeat);
		assignee.addEventListener("change", () => {
			aloneRow.hidden = !assignee.value;
			repeatRow.hidden = !assignee.value;
			if (!assignee.value) every.value = "";
			drawRepeat();
		});
		const ok = h("button.btn.accent", "Crea");
		const parentRow = parents.length ? h("label.field", h("span", "Fa parte di"), parent) : null;
		const dueRow = h("label.field", h("span", "Scadenza"), due);
		const afterRow = opens.length ? h("label.field", h("span", "Viene dopo la scheda"), after) : null;
		// What most schede do not need folds away: a date, a parent, one to wait for.
		const more = h(
			"details.board-new-more",
			h("summary", h("span", `Scadenza${parentRow ? (afterRow ? ", sotto-scheda" : " e sotto-scheda") : ""}${afterRow ? " e ordine" : ""}`), h("small", "facoltativi"), h("span.fold-chevron", icon("down"))),
			h("div.board-fields", dueRow, parentRow),
			afterRow,
		);
		const dialog = h(
			"dialog.board-dialog.board-new",
			h("h2", "Nuovo incarico"),
			title,
			description,
			h("div.board-fields", h("label.field", h("span", "Affida a"), assignee), h("label.field", h("span", "Priorità"), priority)),
			repeatRow,
			more,
			h("p.muted.small", "Se la affidi a un agente, ci lavora subito in una conversazione con te e la sposta in «Da rivedere» quando ha finito. Se si ripete, ogni volta nasce una scheda nuova che parte con te, come se premessi Avvia."),
			aloneRow,
			h("div.actions", ok, h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
		);
		ok.onclick = async () => {
			ok.disabled = true;
			try {
				if (every.value) {
					const repeat = { every: every.value, time: time.value, ...(every.value === "settimana" ? { day: Number(weekday.value) } : every.value === "mese" ? { day: Number(monthday.value) } : {}) };
					const { routine } = await api("/api/board", { method: "POST", body: { title: title.value, description: description.value, priority: priority.value, assignee: assignee.value, auto: alone.checked, repeat } });
					dialog.close();
					toast(`Si ripete ${routine.whenText}: la prima volta ${whenNext(routine.next)}`);
					render();
					return;
				}
				if (due.validity.badInput) throw new Error("La scadenza non è una data completa");
				const { card } = await api("/api/board", { method: "POST", body: { title: title.value, description: description.value, priority: priority.value, ...(assignee.value ? { assignee: assignee.value, auto: alone.checked } : {}), ...(parent.value ? { parent: parent.value } : {}), ...(due.value ? { due: due.value } : {}), ...(after.value ? { after: [after.value] } : {}) } });
				dialog.close();
				toast(card.status === "in_corso" ? `Scheda #${card.n} affidata a ${agentOf(card.assignee)?.name}` : card.queued ? `Scheda #${card.n}: ${started(card).toLowerCase()}` : `Scheda #${card.n} creata`);
				render();
			} catch (error) {
				ok.disabled = false;
				toast(error.message, true);
			}
		};
		// ⌘↵ / Ctrl↵ creates it from anywhere in the form.
		dialog.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !ok.disabled) {
				e.preventDefault();
				ok.click();
			}
		});
		dialog.addEventListener("close", () => dialog.remove());
		if (assignee.value) { aloneRow.hidden = false; repeatRow.hidden = false; }
		if (intent === "ripeti" && assignee.value) { every.value = "settimana"; drawRepeat(); }
		document.body.append(dialog);
		dialog.showModal();
		title.focus();
	};

	// Schede that come back (ADR 0069): who set them sees them above the columns, and pauses or removes them.
	const routineRow = (r) => {
		const agent = agentOf(r.assignee);
		const toggle = async () => {
			try {
				await api(`/api/board/routines/${r.id}`, { method: "PUT", body: { paused: !r.paused } });
				toast(r.paused ? "Riparte alla prossima volta" : "In pausa: non nascono schede finché non la riprendi");
				render();
			} catch (error) {
				toast(error.message, true);
			}
		};
		const remove = () =>
			confirmDialog("Non ripeterla più?", `«${r.title}» non crea più schede. Quelle già create restano sulla board.`, "Togli", () =>
				api(`/api/board/routines/${r.id}`, { method: "DELETE" })
					.then(() => {
						toast("Non si ripete più");
						render();
					})
					.catch((error) => toast(error.message, true)),
			);
		const last = r.last ? data.cards.find((c) => c.id === r.last) : undefined;
		return h(
			`li.board-routine${r.paused ? ".paused" : ""}`,
			faceOf(r.assignee),
			h(
				"div",
				h("b", r.title),
				h(
					"p.muted.small",
					[agent ? agent.name : "agente non disponibile", r.whenText, r.personId === state.me.id ? null : `impostata da ${data.people[r.personId] ?? "una persona"}`, r.paused ? "in pausa" : `la prossima ${whenNext(r.next)}`, r.auto ? "da solo" : null, last ? `ultima #${last.n}` : null].filter(Boolean).join(" · "),
				),
				r.problem ? h("p.small.board-routine-problem", `L'ultima volta non è partita: ${r.problem}.`) : null,
			),
			h("div.row-gap", h("button.btn.small.ghost", { onclick: toggle }, r.paused ? "Riprendi" : "Pausa"), h("button.btn.small.ghost", { onclick: remove }, "Togli")),
		);
	};
	const routines = data.routines?.length ? h("details.board-routines", { open: store("owni.board.routines") !== "0" ? "" : undefined, ontoggle: (e) => store("owni.board.routines", e.currentTarget.open ? "1" : "0") }, h("summary", `Si ripetono (${data.routines.length})`), h("ul", data.routines.map(routineRow))) : null;
	mount(
		main,
		head(null, h("h1", "Board degli incarichi"), "Le cose da fare, affidate agli agenti. L'agente ci lavora in una conversazione con chi gliel'ha affidata e la sposta in «Da rivedere»; poi una persona la chiude, o la rimanda indietro con un commento. Puoi anche chiedere in chat: «mettilo in board per Ricercatore», e avviarla da qui.", h("button.btn.accent", { onclick: newCard }, icon("plus"), "Nuovo incarico")),
		routines,
		filters,
		columns,
	);
	if (filters) redraw();
	const intent = route().rest[0];
	if (main.isConnected && intent) {
		if (intent === "nuovo" || intent === "ripeti") {
			history.replaceState(null, "", instanceHref("board", [], route().instanceId ?? null));
			newCard(intent);
		} else {
			const card = data.cards.find((c) => c.id === intent);
			if (card) {
				history.replaceState(null, "", instanceHref("board", [], route().instanceId ?? null));
				cardDialog(card);
			}
			else main.prepend(h("p.load-warning", { role: "status" }, "L'incarico non è disponibile. Qui trovi quelli a cui hai accesso."));
		}
	}
	// The agenti move schede while the page is open: it follows them, unless a scheda is open.
	const look = (d) => JSON.stringify([d.cards.map((c) => [c.id, c.updatedAt]), (d.routines ?? []).map((r) => [r.id, r.next, r.problem, r.paused, r.last])]);
	const shown = look(data);
	const timer = setInterval(async () => {
		if (!main.isConnected) return clearInterval(timer);
		if (document.querySelector("dialog[open]") || document.hidden || document.activeElement === search) return;
		try {
			const next = await api("/api/board");
			if (main.isConnected && look(next) !== shown) render();
		} catch {
			/* next round */
		}
	}, 10_000);
}

/** Every agente with its face, what it does and what runs by itself. */
