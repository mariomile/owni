import type { ViewOptions } from "./web-session.ts";

export const MAX_TYPED = 1000;
export const MAX_ELEMENTS = 80;
/** Text of one view, in characters; `from` reads on. */
export const VIEW_TEXT = 8_000;

/**
 * Before the page's own scripts: popups open in the same page, forms cannot send unless a
 * person is driving, and WebRTC, which our routing does not see, is gone.
 */
export function initScript(flag: string, humanFlag: string, privateAttr: string, privateBinding: string): string {
	return `(() => {
	${DEEP}
	const flag = ${JSON.stringify(flag)};
	const humanFlag = ${JSON.stringify(humanFlag)};
	const privateAttr = ${JSON.stringify(privateAttr)};
	const privateBinding = ${JSON.stringify(privateBinding)};
	const privateDocument = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
	Object.defineProperty(window, privateBinding + 'Document', { value: privateDocument });
	// Capture the browser's actual value before the page's oninput handler can navigate.
	// Only this event's bounded value leaves the page; old private history never enters it.
	document.addEventListener('input', (event) => {
		const e = event.target;
		if (!(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)) return;
		const edit = e.getAttribute(privateAttr);
		if (!edit || typeof window[privateBinding] !== 'function') return;
		void window[privateBinding](privateDocument, edit, String(e.value).slice(0, ${MAX_TYPED + 1})).catch(() => {});
	}, true);
	for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription"]) {
		try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch {}
	}
	window.open = (url) => { if (url) location.href = String(url); return null; };
	// The event target is the shadow host from outside a shadow root: the path has the anchor itself.
	document.addEventListener("click", (e) => {
		const a = e.composedPath().find((n) => n instanceof Element && n.matches("a[target], form[target]"));
		if (a) a.removeAttribute("target");
	}, true);
	const onSubmit = (e) => {
		const form = e.target;
		if (!(form instanceof HTMLFormElement)) return;
		form.removeAttribute("target");
		const method = ((e.submitter && e.submitter.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
		if (method !== "get" && !window[humanFlag]) { e.preventDefault(); e.stopImmediatePropagation(); window[flag] = (window[flag] || 0) + 1; }
	};
	document.addEventListener("submit", onSubmit, true);
	// A submit does not leave its shadow root: every root, open or closed, listens for itself.
	const watched = new WeakSet();
	const watch = (root) => { if (!watched.has(root)) { watched.add(root); root.addEventListener("submit", onSubmit, true); } };
	const attach = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function (init) { const root = attach.call(this, init); watch(root); return root; };
	// Roots the parser made (declarative shadow DOM) never went through attachShadow.
	document.addEventListener("DOMContentLoaded", () => { for (const h of deep("*")) if (h.shadowRoot) watch(h.shadowRoot); });
})();`;
}

/** Most nodes one lookup visits: a bigger page is cut short, and a lookup that needs the whole page to decide fails closed. */
const MAX_NODES = 100_000;

/**
 * Page-script helper, put in front of every script that looks elements up: the elements matching
 * `selector` in the document and in open shadow roots (web components), in order, at most `max`.
 * The walk itself stops after MAX_NODES nodes, and says so (`over` on the result). Closed roots
 * cannot be reached and iframes are not entered. Playwright's own selectors pierce open shadow
 * roots, so a numbered element is found again by the same marker.
 */
export const DEEP = `const deep = (selector, max = Infinity) => {
		const out = [];
		let left = ${MAX_NODES};
		const walk = (root) => {
			const tree = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
			for (let e = tree.nextNode(); e; e = tree.nextNode()) {
				if (out.length >= max) return;
				if (--left < 0) { out.over = true; return; }
				if (e.matches(selector)) out.push(e);
				if (e.shadowRoot) walk(e.shadowRoot);
			}
		};
		walk(document);
		return out;
	};`;

/**
 * Numbers the visible elements one can act on, under a fresh random attribute, fields and
 * buttons first, then the page's main part, then the rest; and reads the text. Extraction is
 * bounded, with enough overlap for host-side redaction before the final view limits.
 */
export function snapshotScript(attr: string, old: string | undefined, flag: string, options: ViewOptions, padding: number): string {
	return `(() => {
	${DEEP}
	const attr = ${JSON.stringify(attr)};
	const old = ${JSON.stringify(old ?? "")};
	const flag = ${JSON.stringify(flag)};
	const find = ${JSON.stringify((options.find ?? "").toLowerCase().slice(0, 100))};
	const from = ${Math.max(0, Math.floor(options.from ?? 0))};
	// Capture enough overlap to recognize a whole private value before the host cuts the view.
	// Only its maximum length enters the page; old private values never do.
	const padding = ${padding};
	const cut = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n + padding);
	if (old) for (const e of deep("[" + old + "]")) e.removeAttribute(old);
	const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [onclick]";
	const textOf = (root, id) => { const e = root.getElementById(id); return e ? cut(e.innerText, 80) : ""; };
	const labelOf = (e, tag, type, field) => {
		const by = e.getAttribute("aria-labelledby");
		const named = by ? by.split(/\\s+/).slice(0, 5).map((id) => textOf(e.getRootNode(), id)).join(" ") : "";
		const own = e.labels && e.labels.length ? Array.from(e.labels).slice(0, 3).map((l) => cut(l.innerText, 80)).join(" ") : "";
		const img = e.querySelector ? e.querySelector("img[alt]") : null;
		const svg = e.querySelector ? e.querySelector("svg title") : null;
		const button = tag === "input" && /^(submit|button|reset)$/.test(type) ? e.value : "";
		return cut(e.getAttribute("aria-label") || named || own || (field ? "" : cut(e.innerText, 200)) || button || e.getAttribute("placeholder") || e.getAttribute("title") || (img && img.getAttribute("alt")) || (svg && svg.textContent) || e.getAttribute("name"), 80);
	};
	// closest() stops at a shadow root: go on from its host.
	const inMain = (e) => { for (let n = e; n; n = n.parentElement || n.getRootNode().host) if (n.matches("main, article, [role=main]")) return true; return false; };
	const found = [];
	const seen = new Set();
	let scanned = 0;
	const list = deep(selector, 3001);
	for (const e of list) {
		if (++scanned > 3000) break;
		const box = e.getBoundingClientRect();
		if (box.width === 0 || box.height === 0 || e.disabled) continue;
		const style = getComputedStyle(e);
		if (style.visibility === "hidden" || style.display === "none") continue;
		const tag = e.tagName.toLowerCase();
		const type = cut(e.getAttribute("type"), 20).toLowerCase();
		const role = cut(e.getAttribute("role"), 20).toLowerCase();
		const field = tag === "input" || tag === "textarea" || tag === "select";
		const label = labelOf(e, tag, type, field);
		const href = tag === "a" ? cut(e.href, 300) : "";
		if (tag === "a") {
			if (seen.has(href + " " + label)) continue;
			seen.add(href + " " + label);
		}
		if (find && !(label + " " + href).toLowerCase().includes(find)) continue;
		const options = tag === "select" ? Array.from(e.options).slice(0, 15).map((o) => ({ text: cut(o.text, 40), value: cut(o.value, 40), different: o.value !== o.text })) : [];
		const optionCount = tag === "select" ? e.options.length : 0;
		const value = field && type !== "password" && type !== "file" ? cut(tag === "select" && e.selectedOptions[0] ? e.selectedOptions[0].text : e.value, 80) : "";
		const checked = type === "checkbox" || type === "radio" ? !!e.checked : e.getAttribute("aria-checked") === "true";
		const priority = field || tag === "button" || role === "button" ? 0 : inMain(e) ? 1 : 2;
		found.push({ e, index: scanned, priority, info: { tag, type, role, label, href, options, optionCount, value, checked } });
	}
	const shown = found.slice().sort((a, b) => a.priority - b.priority || a.index - b.index).slice(0, ${MAX_ELEMENTS}).sort((a, b) => a.index - b.index);
	shown.forEach((f, i) => f.e.setAttribute(attr, String(i + 1)));
	// body.innerText stops at shadow roots: what they show is appended.
	const shadow = deep("*").filter((h) => h.shadowRoot).flatMap((h) => Array.from(h.shadowRoot.children).filter((c) => c.getClientRects().length).map((c) => String(c.innerText)));
	const all = document.body ? [String(document.body.innerText), ...shadow].join("\\n") : "";
	const blocked = Number(window[flag]) || 0;
	window[flag] = 0;
	return {
		elements: shown.map((f) => f.info),
		more: found.length - shown.length,
		scannedAll: scanned <= 3000 && !list.over,
		text: all.slice(Math.max(0, from - padding), from + ${VIEW_TEXT} + padding),
		textLength: all.length,
		frames: deep("iframe[src]", 5).map((f) => cut(f.src, 200)),
		postForms: deep("form", 50).filter((f) => cut(f.getAttribute("method"), 10).toLowerCase() === "post").length,
		blockedForms: blocked,
	};
})()`;
}
