// Segreteria page.
import { api, confirmDialog, emptyNote, fmt, go, h, head, mount, needInstance, route, state, toast } from "../common.js";
import { render } from "../shell.js";

// ---------- segreteria ----------
const STATUS = {
	draft_ready: ["Da approvare", "accent"],
	awaiting_edit: ["In modifica", "warn"],
	approved: ["Invio in corso", "warn"],
	sent: ["Inviata", "ok"],
	discarded: ["Scartata", ""],
	failed: ["Problema", "bad"],
	classified_skip: ["Non commerciale / spam", ""],
	received: ["Ricevuta", ""],
	lead_upserted: ["Ricevuta", ""],
	logged: ["Registrata", ""],
};
/** What the draft asks the customer for (MissingField), as the owner reads it. */
const MISSING = {
	fullName: "nome",
	company: "azienda",
	email: "email",
	productOrService: "richiesta",
	quantity: "quantità",
	deliverySite: "luogo di consegna",
	vatNumber: "P.IVA",
	vatNumberInvalid: "P.IVA da ricontrollare",
	budget: "budget",
	deadline: "scadenza",
};

export async function viewSegreteria(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const selected = route().rest[0];
	const waiting = (p) => p.status === "draft_ready" || p.status === "awaiting_edit" || p.status === "failed";
	// Waiting for a decision first, then the rest; newest first within each.
	const pratiche = (await api(`/api/instances/${inst.id}/pratiche`)).pratiche.sort((a, b) => Number(waiting(b)) - Number(waiting(a)));
	const open = pratiche.filter(waiting).length;
	const list = h("div.card.list");
	for (const p of pratiche) {
		const [label, tone] = STATUS[p.status] ?? [p.status, ""];
		list.append(
			h(
				"button",
				{ "aria-current": p.praticaId === selected ? "true" : undefined, onclick: () => go("segreteria", p.praticaId) },
				h("div.who-line", h("b", p.lead.fullName ?? p.lead.company ?? p.lead.email ?? "Sconosciuto"), h(`span.chip${tone ? `.${tone}` : ""}`, label)),
				h("div.subj", p.lead.rawSubject),
				h("div.mono.muted", `#${p.praticaId.slice(0, 8)} · ${fmt.time(p.lead.receivedAt)}`),
			),
		);
	}
	const detail = h("div");
	mount(main, 
		head(inst.name, h("h1", "Segreteria commerciale"), `${open} ${open === 1 ? "pratica aspetta" : "pratiche aspettano"} la tua decisione. Nessuna mail parte senza Approva.`),
		pratiche.length ? h("div.pratiche", list, detail) : emptyNote("div.card.empty", "Ancora nessuna richiesta", "Le richieste di preventivo arrivate per email compariranno qui e su Telegram."),
	);
	const p = pratiche.find((x) => x.praticaId === selected) ?? pratiche[0];
	if (p) renderPratica(detail, inst, p);
}

function renderPratica(detail, inst, p) {
	const lead = p.lead;
	const [label, tone] = STATUS[p.status] ?? [p.status, ""];
	const act = async (action, extra = {}) => {
		try {
			const { result } = await api(`/api/instances/${inst.id}/pratiche/${p.praticaId}/action`, { method: "POST", body: { action, draftVersion: p.draftVersion, requestId: crypto.randomUUID(), ...extra } });
			if (result.kind === "ignored") toast(result.reason === "stale_version" ? "La bozza è cambiata nel frattempo: ricarico." : "Azione già eseguita o non più valida.", true);
			else toast(action === "approve" ? (result.sent ? "Mail inviata" : "Fatto") : action === "discard" ? "Pratica scartata" : "Bozza aggiornata");
		} catch (error) {
			toast(error.message, true);
		}
		render();
	};
	const editing = h("div.stack", { hidden: true });
	const editText = h("textarea", { rows: 4, placeholder: "Come vuoi cambiare la bozza? (oppure incolla il testo intero)" });
	editing.append(h("label.field", h("span", "Modifica"), editText), h("div.row-gap", h("button.btn", { onclick: () => editText.value.trim() && act("edit", { text: editText.value }) }, "Aggiorna bozza"), h("button.btn.ghost", { onclick: () => (editing.hidden = true) }, "Annulla")));
	const canAct = inst.isApprover && (p.status === "draft_ready" || p.status === "failed" || p.status === "awaiting_edit" || (p.status === "classified_skip" && p.classification === "spam"));
	const rows = [
		["Nome", [lead.title, lead.fullName].filter(Boolean).join(" ") || "—"],
		["Azienda", lead.company ?? "—"],
		["Email", lead.email ?? "—"],
		["Telefono", lead.phone ?? "—"],
		["Richiesta", lead.productOrService ?? "—"],
		["Quantità", lead.quantity ?? "—"],
		["Tempi", lead.urgency ?? "—"],
		["Dati mancanti", p.missingFields.length ? p.missingFields.map((f) => MISSING[f] ?? f).join(", ") : "nessuno"],
	];
	if (lead.notes) rows.push(["Note", lead.notes]);
	mount(detail, 
		h(
			"div.stack",
			h(
				"div.card.pad",
				h("div.row-gap", h(`span.chip${tone ? `.${tone}` : ""}`, label), h("span.mono.muted", `Pratica #${p.praticaId.slice(0, 8)} · bozza v${p.draftVersion}`)),
				h("h2", lead.rawSubject),
				h("dl.lead", rows.map(([k, v]) => [h("dt", k), h("dd", v)])),
			),
			p.draftBody ? h("div.letter", h("div.subject", `Oggetto: ${p.draftSubject}`), p.draftBody) : emptyNote("div.card.empty", "Nessuna bozza", p.classification === "spam" ? "Probabilmente spam. Approva per trattarla come richiesta: verrà preparata una bozza da approvare." : "Questa mail non richiede una risposta."),
			canAct
				? h(
						"div.actions",
						h(
							"button.btn.accent",
							{
								onclick: () => {
									if (p.status === "classified_skip") return act("approve");
									confirmDialog(`Inviare la mail a ${lead.email}?`, "La bozza mostrata parte così com'è, nello stesso thread della richiesta.", "Invia la mail", () => act("approve"));
								},
							},
							p.status === "classified_skip" ? "È una richiesta vera" : "Approva e invia",
						),
						p.draftBody ? h("button.btn.ghost", { onclick: () => ((editing.hidden = false), editText.focus()) }, "Modifica") : null,
						h("button.btn.danger", { onclick: () => act("discard") }, "Scarta"),
					)
				: !inst.isApprover
					? h("p.muted", "Solo gli approvatori di questo agente possono decidere.")
					: null,
			editing,
		),
	);
}

