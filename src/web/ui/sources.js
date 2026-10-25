// Sources under a reply: the sites a rendered answer links to, as host chips and a folded list.
import { h } from "./common.js";

const host = (href) => new URL(href).hostname.replace(/^www\./, "");

/** The letter tile that stands in for a site's icon: external favicons are blocked by the CSP. */
const mark = (name) => h("span.source-mark", { "aria-hidden": "true" }, name.charAt(0).toUpperCase());

/** Rewrites bare-URL and numbered links as host chips; returns the folded source list, or null. */
export function sources(root) {
	const seen = new Map();
	for (const link of root.querySelectorAll("a[href^='http']")) {
		let name;
		try {
			name = host(link.href);
		} catch {
			continue;
		}
		const label = link.textContent.trim();
		if (label === link.getAttribute("href") || label === link.href || /^\[?\d{1,2}\]?$/.test(label)) {
			link.textContent = name;
			link.classList.add("cite");
		}
		if (!seen.has(name)) seen.set(name, { href: link.href, title: link.title || (link.classList.contains("cite") ? "" : label) });
	}
	if (!seen.size) return null;
	const list = [...seen];
	return h(
		"details.sources",
		h("summary", h("span.source-stack", list.slice(0, 4).map(([name]) => mark(name))), list.length === 1 ? "1 fonte" : `${list.length} fonti`),
		h("ol.source-list", list.map(([name, { href, title }]) => h("li", h("a", { href, target: "_blank", rel: "noopener noreferrer" }, mark(name), h("span", h("b", title || name), h("small", name)))))),
	);
}

// One floating preview for every link in the chat, on precise pointers only.
let preview;
let timer;
function hide() {
	clearTimeout(timer);
	preview?.classList.remove("on");
}
export function linkPreviews(scroller) {
	if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
	preview ??= document.body.appendChild(h("div.link-preview", { role: "tooltip" }));
	scroller.addEventListener("scroll", hide, { passive: true });
	scroller.addEventListener("pointerout", (event) => {
		const link = event.target.closest?.(".markdown a[href^='http'], .source-list a");
		if (link && !link.contains(event.relatedTarget)) hide();
	});
	scroller.addEventListener("pointerover", (event) => {
		const link = event.target.closest?.(".markdown a[href^='http'], .source-list a");
		if (!link) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			let url;
			try {
				url = new URL(link.href);
			} catch {
				return;
			}
			const name = url.hostname.replace(/^www\./, "");
			let path = url.pathname + url.search;
			try {
				path = decodeURIComponent(path);
			} catch {}
			path = path.replace(/\/$/, "");
			preview.replaceChildren(mark(name), h("span", h("b", name), path ? h("small", path) : null));
			const box = link.getBoundingClientRect();
			const below = box.top < 120;
			preview.style.setProperty("--x", `${Math.round(Math.min(Math.max(box.left + box.width / 2, 160), innerWidth - 160))}px`);
			preview.style.setProperty("--y", `${Math.round(below ? box.bottom + 8 : box.top - 8)}px`);
			preview.classList.toggle("below", below);
			preview.classList.add("on");
		}, 350);
	});
}
