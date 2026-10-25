// File page.
import { agentLabel, api, confirmDialog, emptyNote, fmt, h, head, icon, mount, needInstance, state, toast } from "../common.js";
import { render } from "../shell.js";

// ---------- file ----------
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

export async function viewFiles(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
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
		render();
	};
	const upload = h("input", { type: "file", class: "sr", multiple: true });
	upload.addEventListener("change", () => upload.files?.length && send([...upload.files]));
	const raw = (f) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(f.path)}`;
	const tile = (f, name) => {
		const kind = fileKind(name);
		const box = h(`span.file-kind.k-${kind}`, h("span", fileExt(name)));
		if (kind !== "image") return box;
		// The picture itself when the server says its bytes are one (never SVG); the label otherwise.
		const img = h("img", { src: `${raw(f)}&inline=1`, alt: "", loading: "lazy" });
		img.addEventListener("load", () => box.classList.add("thumb"));
		img.addEventListener("error", () => img.remove());
		box.append(img);
		return box;
	};
	const remove = (f) =>
		confirmDialog(`Eliminare ${f.path}?`, `Il file sparisce dal workspace di ${inst.name}.`, "Elimina", async () => {
			await api(`/api/instances/${inst.id}/files?path=${encodeURIComponent(f.path)}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
			render();
		});
	const row = (f) => {
		const name = f.path.split("/").at(-1);
		return h(
			"li.task-row.file-row",
			tile(f, name),
			h("div.task-text", h("b", h("a", { href: raw(f), download: name }, name)), h("small", `${fmt.bytes(f.size)} · ${fmt.time(f.modifiedAt)}`)),
			h(
				"div.person-actions",
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
	const drop = h("div.file-drop", { "aria-hidden": "true" }, h("span.fold-glyph", icon("upload")), h("b", "Lascia qui i file"), h("small", `Finiscono nel workspace di ${inst.name}, in uploads.`));
	mount(
		main,
		head(agentLabel(inst), h("h1", "Documenti e file"), `Il workspace di ${inst.name}: i file che crea e quelli che riceve (legge anche PDF, Word, Excel e PowerPoint). ${files.length === 1 ? "1 file" : `${files.length} file`}, ${fmt.bytes(total)}. Puoi anche trascinarli qui.`, h("label.btn.accent", icon("upload"), "Carica file", upload)),
		h(
			"div.card.files",
			files.length
				? groups.map(([dir, list]) => h("section.file-folder", h("h3", h("span.mono", dir ? `${dir}/` : "/"), h("span", list.length)), h("ul.task-list", list.map(row))))
				: emptyNote("div.empty", "Nessun file", `Caricane uno, trascinalo qui, o chiedi a ${inst.name} di preparare un report.`),
		),
		drop,
	);
	// Files dropped anywhere on the page go up like the button's.
	let depth = 0;
	const dragging = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
	main.addEventListener("dragenter", (e) => {
		if (!dragging(e)) return;
		e.preventDefault();
		depth += 1;
		main.classList.add("dropping");
	});
	main.addEventListener("dragover", (e) => dragging(e) && e.preventDefault());
	main.addEventListener("dragleave", () => {
		depth = Math.max(0, depth - 1);
		if (!depth) main.classList.remove("dropping");
	});
	main.addEventListener("drop", (e) => {
		if (!dragging(e)) return;
		e.preventDefault();
		depth = 0;
		main.classList.remove("dropping");
		const list = [...(e.dataTransfer?.files ?? [])];
		if (list.length) send(list);
	});
}

