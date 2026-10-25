// Command palette.
import { api, go, h, icon, instanceHref, mount, state } from "./common.js";
import { PAGES } from "./shell.js";

// ---------- command palette (⌘K) ----------
export function openPalette() {
	if (!state.me || document.querySelector("dialog.palette")) return;
	const items = PAGES.filter((p) => p.palette !== false && (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance))).map((p) => ({ ...p, icon: p.id, to: [p.id] }));
	// Conversations by title, once something is typed: this agente's chats, and the stanze (loaded now).
	const chats = state.threads.map((t) => ({ label: t.title, group: t.agent?.name ?? "Conversazione", icon: "chat", href: instanceHref("chat", [t.id], t.instanceId ?? state.instance?.id) }));
	let rooms = [];
	if (PAGES.find((p) => p.id === "stanze")?.when()) {
		void api("/api/rooms")
			.then(({ rooms: list }) => {
				rooms = list.map((r) => ({ label: r.title, group: "Stanza", icon: "stanze", to: ["stanze", r.id] }));
				if (dialog.open) draw();
			})
			.catch(() => {});
	}
	const input = h("input", { type: "text", placeholder: "Vai a una sezione o a una conversazione…", "aria-label": "Cerca una sezione o una conversazione", autocomplete: "off" });
	const list = h("ul", { role: "listbox" });
	let active = 0;
	let shown = items;
	const dialog = h("dialog.palette", input, list);
	const pick = (item) => {
		dialog.close();
		dialog.remove();
		document.querySelector(".shell")?.classList.remove("open");
		if (item.href) location.hash = item.href;
		else go(...item.to);
	};
	const draw = () => {
		const q = input.value.trim().toLowerCase();
		const talks = q === "" ? [] : [...rooms, ...chats].filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
		shown = [...items.filter((i) => q ? i.label.toLowerCase().includes(q) : ["lavori", "agenti", "gestione"].includes(i.id)), ...talks];
		active = Math.min(active, Math.max(0, shown.length - 1));
		mount(list, 
			...shown.map((item, n) =>
				h(
					"li",
					{
						role: "option",
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
			...(shown.length ? [] : [h("li.none", "Niente con questo nome")]),
		);
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

