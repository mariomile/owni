// Skill page.
import { agentLabel, api, confirmDialog, emptyNote, fmt, h, head, icon, mount, needInstance, state, toast } from "../common.js";
import { render } from "../shell.js";

// ---------- skill (ADR 0059) ----------
/** «Chiusura del mese» → «chiusura-del-mese», as the server names it; only a preview of the command. */
const skillSlug = (name) =>
	name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export async function viewSkills(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const { skills, drafts } = await api(`/api/instances/${inst.id}/skills`);
	const editor = h("div.card.pad.stack", { hidden: true });
	const save = async (body, done) => {
		try {
			const { skill, replaced } = await api(`/api/instances/${inst.id}/skills`, { method: "PUT", body });
			toast(replaced ? `Skill /${skill.name} aggiornata` : `Skill /${skill.name} salvata`);
			done?.();
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	/** The form for a new skill or one to change; a SKILL.md pasted or uploaded fills it. */
	const edit = (skill) => {
		const name = h("input", { type: "text", maxlength: 32, value: skill?.name ?? "", placeholder: "Es. Chiusura del mese", readonly: Boolean(skill) });
		const command = h("small");
		const showCommand = () => (command.textContent = name.value.trim() ? `Si lancia con /${skillSlug(name.value)}` : "Il nome diventa il comando, da console, Telegram e WhatsApp.");
		name.addEventListener("input", showCommand);
		showCommand();
		const description = h("textarea", { rows: 2, maxlength: 1024, placeholder: "Quando usarla, in una riga. Es. Quando chiedo di chiudere il mese" }, skill?.description ?? "");
		const body = h("textarea", { rows: 10, maxlength: 20000, placeholder: "I passi, in Markdown.\n1. Guarda le fatture scadute\n2. Poi le spese del mese\n3. Scrivimi il riepilogo" }, skill?.body ?? "");
		const pasted = h("textarea", { rows: 6, placeholder: "---\nname: chiusura-del-mese\ndescription: Quando chiedo di chiudere il mese\n---\n\n1. …" });
		const file = h("input", { type: "file", accept: ".md,text/markdown,text/plain", hidden: true });
		file.addEventListener("change", async () => {
			const f = file.files?.[0];
			if (f) pasted.value = await f.text();
		});
		const close = () => (editor.hidden = true);
		mount(
			editor,
			h("h2", skill ? `Modifica /${skill.name}` : "Nuova procedura"),
			h("label.field", h("span", "Nome"), name, command),
			h("label.field", h("span", "Quando usarla"), description, h("small", `${inst.name} vede questa riga in ogni conversazione e apre i passi quando un compito corrisponde.`)),
			h("label.field", h("span", "Passi"), body),
			h("div.actions", h("button.btn.accent", { onclick: () => save({ name: skill?.name ?? name.value, description: description.value, body: body.value }, close) }, "Salva"), h("button.btn.ghost", { onclick: close }, "Annulla")),
			skill
				? null
				: h(
						"details",
						h("summary", "Oppure importa un SKILL.md"),
						h("label.field", h("span", "Incolla il file, o caricalo"), pasted),
						h("div.actions", h("button.btn", { onclick: () => (pasted.value.trim() ? save({ skillMd: pasted.value }, close) : toast("Incolla prima un SKILL.md", true)) }, "Importa"), h("label.btn.ghost", "Carica un file", file)),
					),
		);
		editor.hidden = false;
		editor.scrollIntoView({ behavior: "smooth", block: "start" });
		(skill ? description : name).focus();
	};
	const exportMd = (s) => {
		const link = h("a", { href: URL.createObjectURL(new Blob([s.skillMd], { type: "text/markdown" })), download: "SKILL.md" });
		link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	};
	const remove = (s, draft) =>
		confirmDialog(draft ? `Scartare la bozza «${s.name}»?` : `Cancellare /${s.name}?`, draft ? "La bozza sparisce: non era ancora attiva." : `${inst.name} non la userà più, e il comando smette di funzionare.`, draft ? "Scarta" : "Cancella", async () => {
			await api(`/api/instances/${inst.id}/skills/${encodeURIComponent(s.name)}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			render();
		});
	const by = (s) => (s.mine ? "tua" : s.createdBy ? `di ${s.createdBy.replace(/^web:/, "console ")}` : null);
	const row = (s, draft) =>
		h(
			"li.task-row.skill-row",
			h("span.fold-glyph", icon("skill")),
			h("div.task-text", h("b", h("span.mono", `/${s.name}`), draft ? h("span.chip.warn", "bozza") : null), h("span.skill-what", s.description), h("small", [by(s), `aggiornata ${fmt.time(s.updatedAt)}`].filter(Boolean).join(" · "))),
			h(
				"div.person-actions",
				draft ? h("button.btn.small.accent", { onclick: () => save({ name: s.name, description: s.description, body: s.body }) }, "Attiva") : null,
				s.canEdit && !draft ? h("button.btn.small.ghost.skill-edit", { title: "Modifica", "aria-label": `Modifica /${s.name}`, onclick: () => edit(s) }, icon("edit"), h("span", "Modifica")) : null,
				draft ? null : h("button.icon-btn", { title: "Scarica il SKILL.md", "aria-label": `Scarica il SKILL.md di /${s.name}`, onclick: () => exportMd(s) }, icon("install")),
				s.canEdit ? h("button.icon-btn.task-remove", { title: draft ? "Scarta la bozza" : "Cancella", "aria-label": `${draft ? "Scarta la bozza" : "Cancella"} /${s.name}`, onclick: () => remove(s, draft) }, icon("trash")) : null,
			),
		);
	mount(
		main,
		head(agentLabel(inst), h("h1", "Procedure"), `Procedure con un nome che ${inst.name} apre quando servono. Il nome è il comando: /chiusura-del-mese ottobre la lancia da qui, da Telegram e da WhatsApp. Le vede chi scrive a ${inst.name}; ognuno cambia le sue, l'owner tutte.`, h("button.btn.accent", { onclick: () => edit() }, icon("plus"), "Nuova procedura")),
		h(
			"div.stack",
			editor,
			drafts.length
				? h("div.card", h("div.pad", h("h2", "Le tue bozze"), h("p.muted", `Le ha scritte ${inst.name} in chat. Non sono attive finché non le attivi tu, qui o scrivendo /attiva-skill.`)), h("ul.task-list", drafts.map((d) => row(d, true))))
				: null,
			h(
				"div.card",
				skills.length
					? h("ul.task-list", skills.map((s) => row(s, false)))
					: emptyNote("div.empty", "Nessuna skill", `Spiega a ${inst.name} come fai una cosa e chiedile di salvarla come skill, oppure creala qui.`),
			),
		),
	);
}

