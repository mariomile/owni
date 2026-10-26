// Read replies aloud and copy them, used by chat and board.
import { fmt, h, icon, toast } from "./common.js";

// ---------- ascolta ----------
/**
 * A reply read aloud by a voice installed on this device: only local voices, so the text never
 * leaves it (some browsers' voices are online services). No local voice in the page's language:
 * no button. Read sentence by sentence, since some browsers stop a long utterance midway.
 */
const listening = { button: undefined, voice: undefined };

function localVoice() {
	if (!("speechSynthesis" in window)) return undefined;
	listening.voice ??= window.speechSynthesis.getVoices().find((v) => v.localService && v.lang?.toLowerCase().startsWith("it"));
	return listening.voice;
}
// Chrome lists its voices only after a while: buttons drawn before that appear on the next render.
if ("speechSynthesis" in window) window.speechSynthesis.addEventListener?.("voiceschanged", () => (listening.voice = undefined));
window.addEventListener("hashchange", () => stopReading());

function stopReading() {
	if (!("speechSynthesis" in window)) return;
	window.speechSynthesis.cancel();
	listening.button?.replaceChildren(icon("listen"));
	listening.button?.setAttribute("aria-label", "Ascolta");
	listening.button?.setAttribute("aria-pressed", "false");
	listening.button = undefined;
}

/** What is said: the same rules as the voice notes on Telegram and WhatsApp (src/channels/speech.ts). */
function speakable(text) {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, "$1")
		.replace(/\bhttps?:\/\/\S+/g, "link")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
		.replace(/\|/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/** Copies an answer as plain text; the icon turns into a tick for a moment. */
/**
 * A message the board posted for the agente: «[Scheda #N dalla board] titolo» becomes a card with the
 * instructions folded away, «[Scheda #N] Vai avanti da solo…» a quiet line. Anything else: null.
 */
export function boardNote(entry) {
	const text = entry.text ?? "";
	const handed = /^\[Scheda #(\d+) dalla board\] (.+)(?:\n\n([\s\S]*))?$/.exec(text);
	if (handed) {
		const [, n, title, rest] = handed;
		return h(
			"div.msg.person.brief",
			h("div.meta", fmt.time(entry.at)),
			h(
				"div.brief-card",
				h("a.brief-head", { href: "#/board" }, h("span.fold-glyph", icon("board")), h("span.brief-text", h("small", `Incarico #${n}`), h("b", title))),
				rest ? h("details.brief-more", h("summary", h("span", "Cosa chiede l'incarico"), h("span.fold-chevron", icon("down"))), h("div.body", rest)) : null,
			),
		);
	}
	const goOn = /^\[Scheda #(\d+)\] Vai avanti da solo/.exec(text);
	if (goOn) return h("div.msg.board-step", { title: text }, icon("board"), h("span", `Incarico #${goOn[1]}: va avanti da solo`), h("span.when", fmt.time(entry.at)));
	return null;
}

export function copyButton(text) {
	const button = h("button.listen", { type: "button", "aria-label": "Copia", title: "Copia" }, icon("copy"));
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.replaceChildren(icon("check"));
			button.setAttribute("aria-label", "Copiato");
			setTimeout(() => {
				button.replaceChildren(icon("copy"));
				button.setAttribute("aria-label", "Copia");
			}, 1400);
		} catch {
			toast("Il browser non ha permesso di copiare", true);
		}
	});
	return button;
}

export function listenButton(text) {
	if (!localVoice()) return null;
	const button = h("button.listen", { type: "button", "aria-label": "Ascolta", "aria-pressed": "false", title: "Ascolta" }, icon("listen"));
	button.addEventListener("click", () => {
		const again = listening.button === button;
		stopReading();
		if (again) return;
		const voice = localVoice();
		const sentences = (speakable(text).match(/[^.!?\n]+[.!?]*[»"')\]]*\s*/g) ?? []).filter((x) => /[\p{L}\p{N}]/u.test(x));
		if (!voice || sentences.length === 0) return;
		listening.button = button;
		button.replaceChildren(icon("stop"));
		button.setAttribute("aria-label", "Ferma");
		button.setAttribute("aria-pressed", "true");
		sentences.forEach((sentence, i) => {
			const utterance = new SpeechSynthesisUtterance(sentence.trim());
			utterance.voice = voice;
			utterance.lang = voice.lang;
			if (i === sentences.length - 1) utterance.onend = () => listening.button === button && stopReading();
			utterance.onerror = () => listening.button === button && stopReading();
			window.speechSynthesis.speak(utterance);
		});
	});
	return button;
}

/** A value to copy into another service's dashboard. */
export function copyBox(value, what) {
	const input = h("input", { type: "text", class: "mono", readonly: true, value });
	return h("div.link-box", input, h("button.btn.ghost", { onclick: async () => (await navigator.clipboard.writeText(value).catch(() => input.select()), toast(`${what} copiato`)) }, "Copia"));
}
