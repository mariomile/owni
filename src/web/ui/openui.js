// OpenUI answers in the chat (ADR 0118): a ```openui-lang block drawn as a live interface in a
// sandboxed frame. The frame has no origin of its own: it gets the block and the theme by message,
// and sends back only its height and what the person clicked, written in their box for them to send.
import { h } from "./common.js";

/** Each frame's block and what to show instead if it draws nothing. */
const blocks = new WeakMap();
let listening = false;

const theme = () => document.documentElement.dataset.theme ?? "";
const frames = () => document.querySelectorAll("iframe.openui-frame");

/** A ```openui-lang block: `fallback()` builds the plain code block, shown if the frame draws nothing. */
export function openuiBlock(source, fallback) {
	listen();
	const frame = h("iframe.openui-frame", { src: "/openui/frame", sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: "Risposta interattiva" });
	const box = h("div.openui", frame);
	blocks.set(frame, { source, fallback, box });
	// A frame that never says it drew (the bundle failed, a browser refused its scripts): the code, not an empty box.
	setTimeout(() => {
		if (box.isConnected && !box.classList.contains("drawn")) box.replaceWith(fallback());
	}, 15000);
	return box;
}

/** A click's words go in the person's box, after what they were writing: they read them, then send. */
export function fillComposer(input, text) {
	input.value = input.value.trim() ? `${input.value.trimEnd()}\n\n${text}` : text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.focus({ preventScroll: true });
	input.setSelectionRange(input.value.length, input.value.length);
}

/** What a click in the frame says on the person's behalf: the button's words, the form, the context. */
export function actionText(action) {
	const line = (value) => (typeof value === "string" ? value.trim() : "");
	const fields = Array.isArray(action.fields) ? action.fields.filter((f) => Array.isArray(f) && line(f[0]) && line(f[1])).map(([name, value]) => `- ${line(name)}: ${line(value)}`) : [];
	return [line(action.message), ...fields, line(action.context)].filter(Boolean).join("\n").slice(0, 4000);
}

function listen() {
	if (listening) return;
	listening = true;
	addEventListener("message", (event) => {
		const frame = [...frames()].find((f) => f.contentWindow === event.source);
		const block = frame && blocks.get(frame);
		const data = event.data;
		if (!block || data === null || typeof data !== "object") return;
		if (data.type === "openui-ready") frame.contentWindow.postMessage({ type: "openui-draw", source: block.source, theme: theme() }, "*");
		else if (data.type === "openui-height" && Number.isFinite(data.height)) frame.style.height = `${Math.min(Math.max(data.height, 24), 4000)}px`;
		else if (data.type === "openui-drawn") block.box.classList.add("drawn");
		else if (data.type === "openui-empty") block.box.replaceWith(block.fallback());
		else if (data.type === "openui-action" && data.kind === "open_url") openUrl(data.url);
		else if (data.type === "openui-action") {
			const text = actionText(data);
			if (text) block.box.dispatchEvent(new CustomEvent("openui-action", { bubbles: true, detail: { text } }));
		}
	});
	// The theme changed in Impostazioni: every frame follows.
	new MutationObserver(() => {
		for (const frame of frames()) frame.contentWindow?.postMessage({ type: "openui-theme", theme: theme() }, "*");
	}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/** A link from the frame opens in a new tab, only on the web: no other schemes, no access back to Owni. */
function openUrl(url) {
	let target;
	try {
		target = new URL(url);
	} catch {
		return;
	}
	if (target.protocol === "https:" || target.protocol === "http:") window.open(target.href, "_blank", "noopener,noreferrer");
}
