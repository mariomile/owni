// Command palette.
import { channelHref, channelName, dmHref, go, h, icon, mount, state } from "./common.js";
import { newAgent, PAGES, setTheme } from "./shell.js";

// ---------- command palette (⌘K) ----------
export function openPalette() {
	if (!state.me || document.querySelector("dialog.palette")) return;
	const items = PAGES.filter((p) => p.palette !== false && (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance))).map((p) => ({ ...p, icon: p.id, href: p.href?.(), to: [p.id] }));
	// What can be done, not only where to go: «Scrivi a» each agente, a new incarico or agente, the theme.
	const owner = state.me.role === "owner";
	const actions = [
		{ label: "Nuovo incarico", group: "Azione", icon: "plus", to: ["board", "nuovo"], first: true },
		...(owner ? [{ label: "Nuovo agente", group: "Azione", icon: "plus", run: newAgent }] : []),
		...state.instances.filter((i) => i.canChat).map((agent) => ({ label: `Scrivi a ${agent.name}`, group: "Azione", icon: "dm", href: dmHref(agent.id) })),
		...[["auto", "Tema automatico"], ["light", "Tema chiaro"], ["dark", "Tema scuro"]].map(([mode, label]) => ({ label, group: "Azione", icon: "theme", run: () => setTheme(mode) })),
	];
	// Canali by name, once something is typed.
	const rooms = state.conversations.channels.map((c) => ({ label: channelName(c.title), group: "Canale", icon: "canali", href: channelHref(c.id) }));
	const input = h("input", { type: "text", role: "combobox", placeholder: "Vai a una sezione, scrivi a un agente, crea…", "aria-label": "Cerca una sezione, una conversazione o un'azione", "aria-controls": "palette-list", "aria-autocomplete": "list", "aria-expanded": "true", autocomplete: "off" });
	const list = h("ul", { id: "palette-list", role: "listbox", "aria-label": "Risultati" });
	let active = 0;
	let shown = items;
	// Outside the listbox, which holds only options.
	const none = h("p.none", { role: "status" });
	const dialog = h("dialog.palette", { "aria-label": "Cerca una sezione o un'azione" }, input, list, none);
	const pick = (item) => {
		dialog.close();
		dialog.remove();
		document.querySelector(".shell")?.classList.remove("open");
		if (item.run) item.run();
		else if (item.href) location.hash = item.href;
		else go(...item.to);
	};
	const draw = () => {
		const q = input.value.trim().toLowerCase();
		const talks = q === "" ? [] : rooms.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
		const matches = (i) => i.label.toLowerCase().includes(q);
		shown = [...items.filter((i) => q ? matches(i) : ["board", "approvazioni", "agenti", "gestione"].includes(i.id)), ...actions.filter((a) => q ? matches(a) : a.first), ...talks];
		active = Math.min(active, Math.max(0, shown.length - 1));
		// An id from the item itself: when the results change, so does the active descendant.
		const taken = new Set();
		const ids = shown.map((item) => {
			const slug = `${item.group ?? ""}-${item.href ?? item.label}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
			let id = `palette-option-${slug}`;
			for (let k = 2; taken.has(id); k++) id = `palette-option-${slug}-${k}`;
			taken.add(id);
			return id;
		});
		mount(list,
			...shown.map((item, n) =>
				h(
					"li",
					{
						role: "option",
						id: ids[n],
						"aria-selected": n === active ? "true" : "false",
						onclick: () => pick(item),
						onmousemove: () => {
							if (active === n) return;
							active = n;
							draw();
						},
					},
					icon(item.icon),
					h("span", item.label),
					h("span.muted", item.group),
				),
			),
		);
		mount(none, shown.length ? [] : "Niente con questo nome");
		input.setAttribute("aria-expanded", String(shown.length > 0));
		if (shown.length) input.setAttribute("aria-activedescendant", ids[active]);
		else input.removeAttribute("aria-activedescendant");
	};
	input.addEventListener("input", () => {
		active = 0;
		draw();
	});
	input.addEventListener("keydown", (e) => {
		if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length) {
			e.preventDefault();
			active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
			draw();
		} else if (e.key === "Enter" && shown[active]) {
			e.preventDefault();
			pick(shown[active]);
		}
	});
	dialog.addEventListener("close", () => dialog.remove());
	dialog.addEventListener("click", (e) => {
		if (e.target === dialog) dialog.close();
	});
	document.body.append(dialog);
	draw();
	dialog.showModal();
	input.focus();
}

window.addEventListener("keydown", (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		openPalette();
	}
});

