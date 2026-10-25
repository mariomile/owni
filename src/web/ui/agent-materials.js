// An agente's materials (ADR 0114): its memory, documents and procedures, as sections of its panel.
import { api, confirmDialog, emptyNote, fmt, h, icon, mount, state, toast } from "./common.js";
import { isHtml } from "./artifacts.js";

// ---------- memoria ----------
/** What the agente remembers of the person and what holds for everyone, into `box`. */
export async function memorySection(inst, box) {
	const redraw = () => memorySection(inst, box);
	const { mine, shared, canEditShared } = await api(`/api/instances/${inst.id}/memory`);
	const forget = (m) =>
		confirmDialog("Dimenticare questa memoria?", m.text, "Dimentica", async () => {
			await api(`/api/instances/${inst.id}/memory/${m.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			void redraw();
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
		// In archivio: a detail the agente looks up when it helps, not one sent with every message.
		const archived = h("button.memory-archive-toggle", { type: "button", "aria-pressed": "false", title: "Un dettaglio che serve ogni tanto, non in ogni conversazione" }, icon("file"), "In archivio");
		archived.addEventListener("click", () => archived.setAttribute("aria-pressed", archived.getAttribute("aria-pressed") === "true" ? "false" : "true"));
		const remember = h("button.send", { type: "button", "aria-label": "Ricorda", title: "Ricorda", disabled: true }, icon("send"));
		const save = async () => {
			if (!text.value.trim()) return;
			const toArchive = archived.getAttribute("aria-pressed") === "true";
			try {
				await api(`/api/instances/${inst.id}/memory`, { method: "POST", body: { text: text.value, shared: isShared, archived: toArchive } });
				toast(toArchive ? `In archivio: ${inst.name} lo cerca quando serve` : `${inst.name} se lo ricorderà`);
				void redraw();
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
	mount(
		box,
		h("p.muted.small", `Quello che ${inst.name} ricorda di te lo vedi solo tu; le memorie condivise le vede chiunque gli scriva.`),
		h("div.card.memory-card", h("div.pad.memory-head", h("h2", "Su di te"), mine.length ? h("span.muted", String(mine.length)) : null), list(mine, true, `${inst.name} non ricorda ancora niente di te. Puoi scrivere «ricordati che…» in chat, o aggiungerlo qui.`), add(false)),
		h("div.card.memory-card", h("div.pad.memory-head", h("h2", "Condivise"), shared.length ? h("span.muted", String(shared.length)) : null), list(shared, canEditShared, `Ancora nessuna. Quello che scrivi qui lo sa chiunque scriva a ${inst.name}.`), canEditShared ? add(true) : h("p.muted.pad", "Solo l'owner aggiunge o toglie memorie condivise.")),
	);
}

// ---------- documenti ----------
/** What a file is, from its name: the label and the colour of its tile. */
const FILE_KINDS = [
	[/\.(pdf)$/i, "pdf"],
	[/\.(docx?|odt|rtf|pages)$/i, "doc"],
	[/\.(xlsx?|ods|csv|numbers)$/i, "sheet"],
	[/\.(pptx?|odp|key)$/i, "slide"],
	[/\.(jpe?g|png|gif|webp|heic)$/i, "image"],
	[/\.(mp3|m4a|ogg|oga|opus|wav|webm)$/i, "audio"],
	[/\.(xml|json|ya?ml|html?|js|ts|py|sh)$/i, "code"],
	[/\.(md|txt)$/i, "text"],
];
const fileKind = (name) => FILE_KINDS.find(([re]) => re.test(name))?.[1] ?? "other";
const fileExt = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "file").toUpperCase();

/** The agente's workspace into `box`; files dropped on it go up. `openFile(path)`: an HTML page, rendered. */
export async function filesSection(inst, box, openFile) {
	const redraw = () => filesSection(inst, box, openFile);
	const { files } = await api(`/api/instances/${inst.id}/files`);
	const send = async (list) => {
		let done = 0;
		for (const f of list) {
			try {
				await api(`/api/instances/${inst.id}/files/raw?name=${encodeURIComponent(f.name)}`, { method: "PUT", raw: f });
				done += 1;
			} catch (error) {
				toast(`${f.name}: ${error.message}`, true);
			}
		}
		if (done) toast(done === 1 ? `Caricato ${list[0].name}` : `Caricati ${done} file`);
		void redraw();
	};
	const upload = h("input", { type: "file", class: "sr", multiple: true });
	upload.addEventListener("change", () => upload.files?.length && send([...upload.files]));
	const raw = (f) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(f.path)}`;
	const tile = (f, name) => {
		const kind = fileKind(name);
		const tileBox = h(`span.file-kind.k-${kind}`, h("span", fileExt(name)));
		if (kind !== "image") return tileBox;
		// The picture itself when the server says its bytes are one (never SVG); the label otherwise.
		const img = h("img", { src: `${raw(f)}&inline=1`, alt: "", loading: "lazy" });
		img.addEventListener("load", () => tileBox.classList.add("thumb"));
		img.addEventListener("error", () => img.remove());
		tileBox.append(img);
		return tileBox;
	};
	const remove = (f) =>
		confirmDialog(`Eliminare ${f.path}?`, `Il file sparisce dal workspace di ${inst.name}.`, "Elimina", async () => {
			await api(`/api/instances/${inst.id}/files?path=${encodeURIComponent(f.path)}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			void redraw();
		});
	const row = (f) => {
		const name = f.path.split("/").at(-1);
		return h(
			"li.task-row.file-row",
			tile(f, name),
			h("div.task-text", h("b", h("a", { href: raw(f), download: name }, name)), h("small", `${fmt.bytes(f.size)} · ${fmt.time(f.modifiedAt)}`)),
			h(
				"div.person-actions",
				isHtml(name) ? h("button.btn.small", { type: "button", "aria-label": `Apri ${name}`, onclick: () => openFile(f.path) }, "Apri") : null,
				h("a.icon-btn", { href: raw(f), download: name, title: "Scarica", "aria-label": `Scarica ${name}` }, icon("install")),
				state.me.role === "owner" ? h("button.icon-btn.task-remove", { title: "Elimina", "aria-label": `Elimina ${f.path}`, onclick: () => remove(f) }, icon("trash")) : null,
			),
		);
	};
	// One group per folder, the newest file first; the files at the top of the workspace come first.
	const folders = new Map();
	for (const f of [...files].sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))) {
		const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
		folders.set(dir, [...(folders.get(dir) ?? []), f]);
	}
	const groups = [...folders].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
	const total = files.reduce((n, f) => n + f.size, 0);
	mount(
		box,
		h("div.agent-section-bar", h("p.muted.small", `${files.length === 1 ? "1 file" : `${files.length} file`}, ${fmt.bytes(total)}. Puoi trascinarli qui.`), h("label.btn.small", icon("upload"), "Carica", upload)),
		h(
			"div.card.files",
			files.length
				? groups.map(([dir, list]) => h("section.file-folder", h("h3", h("span.mono", dir ? `${dir}/` : "/"), h("span", list.length)), h("ul.task-list", list.map(row))))
				: emptyNote("div.empty", "Nessun file", `Caricane uno, trascinalo qui, o chiedi a ${inst.name} di preparare un report.`),
		),
	);
	// Files dropped on the section go up like the button's; the listeners are set once per box.
	if (box.dataset.drop) return;
	box.dataset.drop = "1";
	let depth = 0;
	const dragging = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
	box.addEventListener("dragenter", (e) => {
		if (!dragging(e)) return;
		e.preventDefault();
		depth += 1;
		box.classList.add("dropping");
	});
	box.addEventListener("dragover", (e) => dragging(e) && e.preventDefault());
	box.addEventListener("dragleave", () => {
		depth = Math.max(0, depth - 1);
		if (!depth) box.classList.remove("dropping");
	});
	box.addEventListener("drop", (e) => {
		if (!dragging(e)) return;
		e.preventDefault();
		depth = 0;
		box.classList.remove("dropping");
		const list = [...(e.dataTransfer?.files ?? [])];
		if (list.length) void send(list);
	});
}

// ---------- procedure (ADR 0059) ----------
/** «Chiusura del mese» → «chiusura-del-mese», as the server names it; only a preview of the command. */
const skillSlug = (name) =>
	name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** The agente's procedures and the person's drafts into `box`; a new one or a change opens in a dialog. */
export async function skillsSection(inst, box) {
	const redraw = () => skillsSection(inst, box);
	const { skills, drafts } = await api(`/api/instances/${inst.id}/skills`);
	const save = async (body, done) => {
		try {
			const { skill, replaced } = await api(`/api/instances/${inst.id}/skills`, { method: "PUT", body });
			toast(replaced ? `Procedura /${skill.name} aggiornata` : `Procedura /${skill.name} salvata`);
			done?.();
			void redraw();
		} catch (error) {
			toast(error.message, true);
		}
	};
	/** The form for a new procedure or one to change; a SKILL.md pasted or uploaded fills it. */
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
		const close = () => dialog.close();
		const dialog = h(
			"dialog.skill-dialog",
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
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
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
			void redraw();
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
				s.canEdit && !draft ? h("button.icon-btn", { title: "Modifica", "aria-label": `Modifica /${s.name}`, onclick: () => edit(s) }, icon("edit")) : null,
				draft ? null : h("button.icon-btn", { title: "Scarica il SKILL.md", "aria-label": `Scarica il SKILL.md di /${s.name}`, onclick: () => exportMd(s) }, icon("install")),
				s.canEdit ? h("button.icon-btn.task-remove", { title: draft ? "Scarta la bozza" : "Cancella", "aria-label": `${draft ? "Scarta la bozza" : "Cancella"} /${s.name}`, onclick: () => remove(s, draft) }, icon("trash")) : null,
			),
		);
	mount(
		box,
		h("div.agent-section-bar", h("p.muted.small", `Il nome è il comando: /chiusura-del-mese la lancia da qui, da Telegram e da WhatsApp. Ognuno cambia le sue, l'owner tutte.`), h("button.btn.small", { onclick: () => edit() }, icon("plus"), "Nuova")),
		drafts.length
			? h("div.card", h("div.pad", h("h2", "Le tue bozze"), h("p.muted", `Le ha scritte ${inst.name} in chat. Non sono attive finché non le attivi tu, qui o scrivendo /attiva-skill.`)), h("ul.task-list", drafts.map((d) => row(d, true))))
			: null,
		h(
			"div.card",
			skills.length
				? h("ul.task-list", skills.map((s) => row(s, false)))
				: emptyNote("div.empty", "Nessuna procedura", `Spiega a ${inst.name} come fai una cosa e chiedigli di salvarla come procedura, oppure creala qui.`),
		),
	);
}
