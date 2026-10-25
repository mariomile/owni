// Command palette.
import { channelHref, channelName, dmHref, go, h, icon, mount, state } from "./common.js";
import { PAGES } from "./shell.js";

// ---------- command palette (⌘K) ----------
export function openPalette() {
	if (!state.me || document.querySelector("dialog.palette")) return;
	const items = PAGES.filter((p) => p.palette !== false && (!p.owner || state.me.role === "owner") && (!p.when || p.when(state.instance))).map((p) => ({ ...p, icon: p.id, to: [p.id] }));
	// Conversations by name, once something is typed: the direct messages and the canali in the rail.
	const dms = state.conversations.direct.flatMap((d) => {
		const agent = state.instances.find((i) => i.id === d.instanceId);
		return agent ? [{ label: agent.name, group: "Messaggi diretti", icon: "dm", href: dmHref(agent.id) }] : [];
	});
	const rooms = state.conversations.channels.map((c) => ({ label: channelName(c.title), group: "Canale", icon: "canali", href: channelHref(c.id) }));
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
		const talks = q === "" ? [] : [...dms, ...rooms].filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
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

