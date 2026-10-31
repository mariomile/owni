// Persone e accessi: who gets in, with which role, and what each person can do with each agente.
import { api, confirmDialog, fmt, h, head, icon, monogram, mount, state, toast } from "../common.js";
import { refreshInstances } from "../session.js";
import { render } from "../shell.js";

/**
 * What every person can do on the web console, per agente: write to it, approve its actions. Kept by
 * each agente (its settings); here it is read and changed person by person. One change at a time per
 * agente, each sending the whole lists as they are when it goes out, so quick clicks never overwrite
 * each other and a refused one, undone meanwhile, is not sent again by the next. An agente whose
 * settings do not load (gone meanwhile) is left out, the people are still there.
 */
async function webAccess() {
	const loaded = await Promise.allSettled(state.instances.map(async (inst) => {
		const { settings } = await api(`/api/instances/${inst.id}/settings`);
		return { inst, chat: new Set(settings.allowedUsers.web ?? []), approve: new Set(settings.approvers.web ?? []), saving: Promise.resolve() };
	}));
	const agents = loaded.filter((r) => r.status === "fulfilled").map((r) => r.value);
	const set = (agent, personId, kind, on) => {
		agent[kind][on ? "add" : "delete"](personId);
		agent.saving = agent.saving.catch(() => {}).then(() => api(`/api/instances/${agent.inst.id}/settings`, { method: "PUT", body: { webPeople: [...agent.chat], webApprovers: [...agent.approve] } }));
		return agent.saving;
	};
	return { agents, set };
}

// ---------- persone ----------
export async function viewPeople(main) {
	const [{ people }, access] = await Promise.all([api("/api/people"), webAccess()]);
	const names = (kind, p) => access.agents.filter((a) => a[kind].has(p.id)).map((a) => a.inst.name).join(", ");
	const summary = (p) => {
		const chat = names("chat", p);
		const approve = names("approve", p);
		if (chat || approve) return [chat ? `Scrive a ${chat}` : "Non scrive a nessun agente", approve ? ` · approva per ${approve}` : ""].join("");
		return p.role === "owner" ? "Gestisce tutto, ma non scrive a nessun agente" : "Nessun agente: non vede niente finché non gli dai un accesso";
	};
	const accessDialog = (p) => {
		const box = (agent, kind, label) => {
			const input = h("input", { type: "checkbox", checked: agent[kind].has(p.id), "aria-label": `${p.name} ${label} ${agent.inst.name}` });
			input.addEventListener("change", () => {
				const on = input.checked;
				access.set(agent, p.id, kind, on).catch((error) => {
					// Undone only if not changed again since: the later change is what was asked.
					if (input.checked === on) {
						input.checked = !on;
						agent[kind][on ? "delete" : "add"](p.id);
					}
					toast(error.message, true);
				});
			});
			return input;
		};
		const dialog = h(
			"dialog.access-dialog",
			h("h2", `Accessi di ${p.name}`),
			h("p.muted", "Scrivere a un agente e approvare le sue azioni sono permessi distinti, anche per l'owner. Valgono per la console; Telegram, WhatsApp e telefono hanno i loro elenchi nella configurazione dell'agente. Ogni modifica si salva da sola."),
			h("table.ledger", h("thead", h("tr", h("th", "Agente"), h("th", "Scrive"), h("th", "Approva"))), h("tbody", access.agents.map((a) => h("tr", h("td", a.inst.name), h("td", box(a, "chat", "scrive a")), h("td", box(a, "approve", "approva per")))))),
			h("div.actions", h("button.btn.ghost", { onclick: () => dialog.close() }, "Fatto")),
		);
		// Pending saves first, then the agents (who can chat changed) and the page, with the new summary.
		dialog.addEventListener("close", () => (dialog.remove(), void Promise.allSettled(access.agents.map((a) => a.saving)).then(refreshInstances).finally(render)));
		document.body.append(dialog);
		dialog.showModal();
	};
	const showLink = (title, link) => {
		const full = `${location.origin}${link}`;
		const input = h("input", { type: "text", value: full, readonly: true });
		const dialog = h(
			"dialog",
			h("h2", title),
			h("p", "Dallo alla persona in privato: è la sua chiave. Non verrà più mostrato."),
			h("div.link-box", input, h("button.btn", { onclick: async () => (await navigator.clipboard.writeText(full).catch(() => input.select()), toast("Link copiato")) }, "Copia")),
			h("div.actions", h("button.btn.ghost", { onclick: () => dialog.close() }, "Fatto")),
		);
		dialog.addEventListener("close", () => (dialog.remove(), render()));
		document.body.append(dialog);
		dialog.showModal();
		input.select();
	};
	const newName = h("input", { type: "text", placeholder: "Nome e cognome" });
	const role = h("select", h("option", { value: "member" }, "Membro"), h("option", { value: "owner" }, "Owner"));
	const writes = access.agents.map((agent) => ({ agent, input: h("input", { type: "checkbox", checked: access.agents.length === 1 }) }));
	mount(main, 
		head(null, h("h1", "Persone e accessi"), "Chi entra nella console e cosa può fare con ogni agente. Ognuno entra con il suo link personale; rigenerarlo chiude le sue sessioni."),
		h(
			"div.grid-2",
			h(
				"div.card",
				h(
					"ul.task-list.people-list",
					people.map((p) =>
						h(
							"li.task-row.person-row",
							monogram(p.name),
							h(
								"div.task-text",
								h("b", p.name, p.id === state.me.id ? h("span.chip", "tu") : null),
								h("small", p.role === "owner" ? "Owner" : "Membro", ` · dal ${fmt.day(p.createdAt)}`, p.twoFactor ? " · verifica in 2 passaggi" : ""),
								h("small.person-access", summary(p)),
							),
							h(
								"div.person-actions",
								access.agents.length ? h("button.btn.small", { onclick: () => accessDialog(p) }, "Accessi") : null,
								h(
									"button.btn.small.ghost",
									{
										onclick: () =>
											confirmDialog(`Nuovo link per ${p.name}?`, "Il link attuale e le sue sessioni smettono di funzionare.", "Genera", async () => {
												const { link } = await api(`/api/people/${p.id}/link`, { method: "POST" });
												showLink(`Nuovo link per ${p.name}`, link);
											}),
									},
									"Nuovo link",
								),
								p.twoFactor && p.id !== state.me.id
									? h(
											"button.btn.small.ghost",
											{
												onclick: () =>
													confirmDialog(`Togliere la verifica in due passaggi a ${p.name}?`, "Per chi ha perso il telefono: potrà entrare con il solo link e riattivarla.", "Togli", async () => {
														await api(`/api/people/${p.id}/2fa/reset`, { method: "POST" });
														render();
													}),
											},
											"Togli verifica",
										)
									: null,
								p.id !== state.me.id
									? h(
											"button.icon-btn.task-remove",
											{
												title: `Rimuovi ${p.name}`,
												"aria-label": `Rimuovi ${p.name}`,
												onclick: () =>
													confirmDialog(`Rimuovere ${p.name}?`, "Non potrà più entrare.", "Rimuovi", async () => {
														await api(`/api/people/${p.id}`, { method: "DELETE" });
														render();
													}),
											},
											icon("trash"),
										)
									: null,
							),
						),
					),
				),
			),
			h(
				"div.card.pad",
				h("h2", "Aggiungi una persona"),
				h("label.field", h("span", "Nome"), newName),
				h("label.field", h("span", "Ruolo"), role, h("small", "L'owner gestisce connettori, impostazioni e persone.")),
				writes.length ? h("fieldset.field.access-pick", h("legend", "Può scrivere a"), writes.map((w) => h("label.row-gap", w.input, h("span", w.agent.inst.name)))) : null,
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								const { person, link } = await api("/api/people", { method: "POST", body: { name: newName.value, role: role.value } });
								const failed = (await Promise.allSettled(writes.filter((w) => w.input.checked).map((w) => access.set(w.agent, person.id, "chat", true)))).some((r) => r.status === "rejected");
								if (failed) toast(`${person.name} è stato creato, ma alcuni accessi non si sono salvati: riprova da «Accessi»`, true);
								showLink(`Link di ${person.name}`, link);
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Crea e mostra il link",
				),
				h("p.muted", "Cosa approva, e gli altri agenti, li cambi poi da «Accessi» nella sua riga."),
			),
		),
	);
}

