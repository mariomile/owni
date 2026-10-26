// The agente's screen, live next to the chat.
import { api, fmt, h, icon, store } from "./common.js";

/**
 * The agente's screen, live next to the chat (ADR 0067): the last picture it took of its screen in
 * this conversation, with what it just did. Only to watch: the agente works, the person follows.
 * The button appears once the agente has used its screen here; the panel opens by itself the first
 * time, on a wide window.
 */
export function screenPanel(inst, threadId, onShow) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/screen`;
	const seenKey = `owni.screen.${threadId}`;
	let version = -1;
	// A picture gone between the question and the download (the screen reset): asked again next time.
	const picture = h("img.screen", { alt: "", hidden: true, onerror: () => { version = -1; } });
	const what = h("p.browser-note");
	const when = h("span.busy-note");
	const el = h(
		"aside.browser-panel",
		{ hidden: true, "aria-label": "Schermo" },
		h("div.browser-head", icon("screen"), h("span.page-title", `Lo schermo di ${inst.name}`), when, h("button.icon-btn", { type: "button", title: "Chiudi", "aria-label": "Chiudi lo schermo", onclick: () => show(false) }, icon("close"))),
		h("div.browser-view", picture),
		what,
		h("p.browser-note", "Qui guardi soltanto. Prima di inviare, pagare o accedere a un account si ferma e te lo chiede in chat."),
	);
	const toggle = h("button.browser-toggle", { type: "button", hidden: true, title: "Lo schermo dell'agente", "aria-pressed": "false", onclick: () => show(el.hidden) }, icon("screen"), h("span", "Schermo"));
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
		// Nothing seen (yet, or any more: the screen reset, Owni restarted): no button, no panel.
		if (screen === null) {
			show(false);
			toggle.hidden = true;
			picture.hidden = true;
			version = -1;
			return;
		}
		if (toggle.hidden) {
			toggle.hidden = false;
			if (store(seenKey) !== "1") {
				if (matchMedia("(max-width: 860px)").matches) toggle.classList.add("news");
				else show(true);
			}
		}
		when.textContent = fmt.time(screen.at);
		what.textContent = screen.action ?? "Ha guardato lo schermo.";
		if (screen.version !== version && !el.hidden) {
			version = screen.version;
			picture.src = `${base}.png?v=${screen.version}`;
			picture.alt = `Lo schermo di ${inst.name}: ${what.textContent}`;
			picture.hidden = false;
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
