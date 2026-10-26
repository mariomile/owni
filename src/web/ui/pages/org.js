// Organigramma page (ADR 0117): squadre, roles, responsabilità, and who writes to whom.
import { agentHome, api, confirmDialog, emptyNote, face, faceColor, h, head, icon, mount, toast } from "../common.js";
import { render } from "../shell.js";
import { teamsForm } from "../teams.js";

/** A squadra's ID from its name, free among the others: «Vendite» → vendite, vendite-2… */
function teamId(name, teams) {
	const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "squadra";
	let id = base;
	for (let n = 2; teams.some((t) => t.id === id); n += 1) id = `${base}-${n}`;
	return id;
}

const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names.join(""));

export async function viewOrg(main) {
	const [view, { agents: live }] = await Promise.all([api("/api/org"), api("/api/agents")]);
	const { org, version, saved, agents, accepts } = view;
	const name = (id) => agents.find((a) => a.id === id)?.name ?? id;
	const info = (id) => live.find((a) => a.id === id) ?? { id, name: name(id) };
	// Only its own rows: an agente called «constructor» is not Object's.
	const place = (id) => (Object.hasOwn(org.agents, id) ? org.agents[id] : { owns: [] });

	/** Save the whole organigramma, then draw the page again from what the server kept. */
	const save = async (next, done) => {
		try {
			await api("/api/org", { method: "PUT", body: { org: next, version } });
			toast(done);
			render();
			return true;
		} catch (error) {
			toast(error.message, true);
			// Changed meanwhile: draw what is there now.
			if (error.status === 409) {
				for (const d of document.querySelectorAll("dialog.org-dialog")) d.close();
				render();
			}
			return false;
		}
	};

	/** The organigramma with one agente moved out of its squadra: if it coordinated it, nobody does. */
	const leaving = (teams, id) => teams.map((t) => (t.lead === id && place(id).team === t.id ? { id: t.id, name: t.name, purpose: t.purpose } : t));

	const agentDialog = (id) => {
		const p = place(id);
		const role = h("input", { type: "text", maxlength: "60", value: p.role ?? "", placeholder: "Responsabile vendite" });
		const team = h("select", h("option", { value: "" }, "Nessuna squadra"), org.teams.map((t) => h("option", { value: t.id, selected: t.id === p.team || undefined }, t.name)));
		const above = h(
			"select",
			h("option", { value: "" }, "Nessuno: risponde alle persone"),
			agents.filter((a) => a.id !== id).map((a) => h("option", { value: a.id, selected: a.id === p.reportsTo || undefined }, a.name)),
		);
		const owns = h("textarea", { rows: 4, placeholder: "Preventivi in attesa\nSolleciti di pagamento" });
		owns.value = p.owns.join("\n");
		const open = h("input", { type: "checkbox", checked: p.open || undefined });
		const submit = async () => {
			const next = { role: role.value, team: team.value || undefined, reportsTo: above.value || undefined, owns: owns.value.split("\n"), open: open.checked };
			const teams = next.team === p.team ? org.teams : leaving(org.teams, id);
			if (await save({ teams, agents: { ...org.agents, [id]: next } }, `${name(id)}: organigramma aggiornato`)) dialog.close();
		};
		const dialog = h(
			"dialog.org-dialog",
			h("h2", name(id)),
			h("p.muted", "Il suo posto nell'azienda: lo legge prima di ogni richiesta, e decide con chi parla."),
			h("label.field", h("span", "Ruolo"), role),
			h("label.field", h("span", "Squadra"), team),
			h("label.field", h("span", "Risponde a"), above),
			h("label.field", h("span", "Responsabilità"), owns, h("small", "Una per riga, fino a 10. Gli altri agenti le vedono e gli passano quello che è suo.")),
			h("label.row-gap", open, h("span", "A disposizione di tutti: ogni agente può chiedergli aiuto")),
			h("div.actions", h("button.btn.accent", { onclick: submit }, "Salva"), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
		);
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		role.focus();
	};

	const teamDialog = (current) => {
		const title = h("input", { type: "text", maxlength: "40", value: current?.name ?? "", placeholder: "Vendite" });
		const purpose = h("input", { type: "text", maxlength: "200", value: current?.purpose ?? "", placeholder: "Clienti nuovi e preventivi" });
		const lead = h("select");
		// Who the owner picked, «Nessuno» included: ticking a member does not bring the old one back.
		let chosen = current?.lead ?? "";
		lead.addEventListener("change", () => {
			chosen = lead.value;
		});
		const boxes = agents.map((a) => {
			const elsewhere = place(a.id).team !== undefined && place(a.id).team !== current?.id ? org.teams.find((t) => t.id === place(a.id).team)?.name : undefined;
			const box = h("input", { type: "checkbox", checked: (current !== undefined && place(a.id).team === current.id) || undefined });
			box.addEventListener("change", leads);
			return { a, box, row: h("label.row-gap", box, h("span", a.name), elsewhere ? h("small.muted", `ora in ${elsewhere}`) : null) };
		});
		function leads() {
			mount(lead, h("option", { value: "" }, "Nessuno"), boxes.filter((b) => b.box.checked).map((b) => h("option", { value: b.a.id, selected: b.a.id === chosen || undefined }, b.a.name)));
		}
		leads();
		const submit = async () => {
			const id = current?.id ?? teamId(title.value.trim(), org.teams);
			const members = new Set(boxes.filter((b) => b.box.checked).map((b) => b.a.id));
			const placed = { ...org.agents };
			let teams = org.teams;
			for (const a of agents) {
				const was = place(a.id);
				if (members.has(a.id) && was.team !== id) {
					teams = leaving(teams, a.id);
					placed[a.id] = { ...was, team: id };
				} else if (!members.has(a.id) && was.team === id) placed[a.id] = { ...was, team: undefined };
			}
			const row = { id, name: title.value, purpose: purpose.value, lead: lead.value || undefined };
			teams = current === undefined ? [...teams, row] : teams.map((t) => (t.id === id ? row : t));
			if (await save({ teams, agents: placed }, current === undefined ? `Squadra ${title.value.trim()} creata` : `Squadra ${title.value.trim()} aggiornata`)) dialog.close();
		};
		const remove = () =>
			confirmDialog(`Togliere la squadra ${current.name}?`, "Gli agenti restano, senza squadra: chi può scrivere a chi si ricalcola.", "Togli", async () => {
				const placed = Object.fromEntries(Object.entries(org.agents).map(([id, p]) => [id, p.team === current.id ? { ...p, team: undefined } : p]));
				if (await save({ teams: org.teams.filter((t) => t.id !== current.id), agents: placed }, `Squadra ${current.name} tolta`)) dialog.close();
			});
		const dialog = h(
			"dialog.org-dialog",
			h("h2", current === undefined ? "Nuova squadra" : current.name),
			h("p.muted", "Chi è nella stessa squadra si scrive. Chi coordina riceve le richieste, divide il lavoro e parla con chi coordina le altre squadre."),
			h("label.field", h("span", "Nome"), title),
			h("label.field", h("span", "A cosa serve"), purpose),
			h("div.field", h("span", "Chi ne fa parte"), agents.length === 0 ? h("p.muted", "Non ci sono agenti.") : h("div.org-members", boxes.map((b) => b.row))),
			h("label.field", h("span", "Chi la coordina"), lead),
			h(
				"div.actions",
				h("button.btn.accent", { onclick: submit }, current === undefined ? "Crea la squadra" : "Salva"),
				h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
				current === undefined ? null : h("button.btn.danger", { onclick: remove }, "Togli la squadra"),
			),
		);
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		title.focus();
	};

	const card = (id, leads) => {
		const a = info(id);
		const p = place(id);
		const below = agents.filter((x) => place(x.id).reportsTo === id).map((x) => x.name);
		const writesTo = agents.filter((x) => x.id !== id && accepts[x.id]?.includes(id)).map((x) => x.name);
		const el = h(
			`article.card.org-agent${leads ? ".lead" : ""}`,
			h("div.org-face", face(a, 44)),
			h(
				"div.org-body",
				h("h3", h("a", { href: agentHome(id) }, a.name), leads ? h("span.tag", "coordina") : null, p.open ? h("span.tag", "a disposizione di tutti") : null),
				// A ready-made squadra names each agente after its role: said once.
				p.role === a.name ? null : h("p.org-role", p.role ?? h("span.muted", "Nessun ruolo")),
				p.owns.length ? h("ul.org-owns", p.owns.map((o) => h("li", o))) : null,
				h("p.muted.small", p.reportsTo ? `Risponde a ${name(p.reportsTo)}` : "Risponde alle persone", below.length ? ` · Rispondono a lui: ${list(below)}` : ""),
				h("p.muted.small", writesTo.length ? `Può scrivere a ${list(writesTo)}` : "Non scrive ad altri agenti"),
				a.busy || a.doing ? h("p.muted.small", h("span.tag", a.busy ? "Occupato" : "Libero"), a.doing ? ` ${a.doing}` : "") : null,
			),
			h("button.btn.small.ghost", { onclick: () => agentDialog(id), "aria-label": `Modifica il posto di ${a.name}` }, "Modifica"),
		);
		el.style.setProperty("--glow", faceColor(a));
		return el;
	};

	const inTeam = (t) => agents.filter((a) => place(a.id).team === t.id).sort((x, y) => (x.id === t.lead ? -1 : y.id === t.lead ? 1 : 0));
	const loose = agents.filter((a) => place(a.id).team === undefined || !org.teams.some((t) => t.id === place(a.id).team));
	mount(
		main,
		head(
			null,
			h("h1", "Organigramma"),
			"Chi fa cosa tra gli agenti, chi coordina e chi risponde a chi. Da qui decidi anche chi può scrivere a chi: ogni agente lo sa e passa agli altri quello che è loro.",
			h("button.btn.accent", { onclick: () => teamDialog() }, icon("plus"), "Nuova squadra"),
			h("button.btn.ghost", { onclick: () => teamsForm() }, "Squadre pronte"),
		),
		saved ? null : h("p.card.pad.org-first", "Finché non salvi l'organigramma, gli agenti si scrivono come deciso finora. Al primo salvataggio, anche creando una squadra pronta, vale solo l'organigramma."),
		agents.length === 0
			? emptyNote("div.empty", "Nessun agente", "Crea un agente o una squadra pronta per cominciare.")
			: h(
					"div.org",
					org.teams.map((t) =>
						h(
							"section.org-team",
							h(
								"header.org-team-head",
								h("div", h("h2", t.name), t.purpose ? h("p.muted", t.purpose) : null, t.lead ? null : h("p.muted.small", "Nessuno la coordina")),
								h("button.btn.small.ghost", { onclick: () => teamDialog(t) }, "Modifica"),
							),
							inTeam(t).length ? h("div.org-agents", inTeam(t).map((a) => card(a.id, a.id === t.lead))) : h("p.muted", "Nessun agente: aggiungili da Modifica."),
						),
					),
					loose.length
						? h("section.org-team.loose", h("header.org-team-head", h("div", h("h2", org.teams.length ? "Senza squadra" : "Agenti"), h("p.muted", "Parlano solo con chi gli sta sopra o sotto, e con chi è a disposizione di tutti."))), h("div.org-agents", loose.map((a) => card(a.id, false))))
						: null,
				),
	);
}
