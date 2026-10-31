// The agente's computer, live next to the chat.
import { api, face, fmt, h, icon, store } from "./common.js";

/**
 * The agente's computer, live next to the chat (ADR 0067, 0135): the last picture it took of its
 * screen in this conversation, with what it just did, or the computer asleep before it has used it
 * here. Only to watch: the agente works, the person follows. The button is there while the agente
 * has the screen; the panel opens by itself the first time it uses it here, on a wide window.
 */
export function screenPanel(inst, threadId, onShow) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/screen`;
	const seenKey = `owni.screen.${threadId}`;
	let version = -1;
	// A picture gone between the question and the download (the screen reset): asked again next time.
	const picture = h("img.screen", { alt: "", hidden: true, onerror: () => { version = -1; } });
	const asleep = h("div.computer-asleep", h("span.computer-face", face(inst, 52, "asleep"), h("span.zz", { "aria-hidden": "true" }, h("span", "z"), h("span", "z"))), h("p", "Il computer dorme"));
	const what = h("p.browser-note", { hidden: true });
	const when = h("span.busy-note");
	const el = h(
		"aside.browser-panel.computer-panel",
		{ hidden: true, "aria-label": "Computer" },
		h("div.browser-head", icon("screen"), h("span.page-title", "Computer"), when, h("button.icon-btn", { type: "button", title: "Chiudi", "aria-label": "Chiudi il computer", onclick: () => show(false) }, icon("close"))),
		h("figure.computer-view", h("div.computer-screen", picture, asleep), h("figcaption", `Lo schermo di ${inst.name}`)),
		what,
		h("p.browser-note", "Qui guardi soltanto. Prima di inviare, pagare o accedere a un account si ferma e te lo chiede in chat."),
	);
	const toggle = h("button.browser-toggle", { type: "button", hidden: true, title: `Il computer di ${inst.name}`, "aria-pressed": "false", onclick: () => show(el.hidden) }, icon("screen"), h("span", "Computer"));
	const show = (on) => {
		if (on === !el.hidden) return;
		el.hidden = !on;
		toggle.setAttribute("aria-pressed", String(on));
		if (on) {
			toggle.classList.remove("news");
			store(seenKey, "1");
			onShow();
			void refresh();
		}
	};
	const refresh = async () => {
		const answer = await api(base).catch(() => undefined);
		if (answer === undefined) return;
		const { screen, on } = answer;
		off = !on && screen === null;
		// No screen for this agente, and nothing seen here: no button, no panel.
		if (off) {
			show(false);
			toggle.hidden = true;
			return;
		}
		toggle.hidden = false;
		// The screen on, not used here yet (or any more: the screen reset, Owni restarted): asleep.
		if (screen === null) {
			picture.hidden = true;
			what.hidden = true;
			asleep.hidden = false;
			toggle.classList.remove("news");
			when.textContent = "";
			version = -1;
			return;
		}
		if (store(seenKey) !== "1" && el.hidden) {
			if (matchMedia("(max-width: 860px)").matches) toggle.classList.add("news");
			else show(true);
		}
		when.textContent = fmt.time(screen.at);
		what.textContent = screen.action ?? "Ha guardato lo schermo.";
		what.hidden = false;
		if (screen.version !== version && !el.hidden) {
			version = screen.version;
			picture.src = `${base}.png?v=${screen.version}`;
			picture.alt = `Lo schermo di ${inst.name}: ${what.textContent}`;
			picture.hidden = false;
			asleep.hidden = true;
		}
	};
	// Often while the panel is open or the conversation is moving, rarely otherwise; never for an
	// agente without the screen. A picture only after a change.
	let ticks = 0;
	let livelyUntil = 0;
	let off = false;
	const timer = setInterval(() => {
		if (!el.isConnected) return clearInterval(timer);
		ticks += 1;
		if (document.visibilityState === "visible" && !off && (!el.hidden || Date.now() < livelyUntil || ticks % 5 === 0)) void refresh();
	}, 2000);
	void refresh();
	return {
		el,
		toggle,
		show,
		lively: () => {
			livelyUntil = Date.now() + 120_000;
		},
	};
}
