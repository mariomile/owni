// The agente's computer, the «Computer» tab of its panel next to the chat.
import { api, face, fmt, h, icon, store } from "./common.js";

/**
 * The agente's computer in a conversation (ADR 0067, 0135), shown in the «Computer» tab of its
 * panel, as in Grok Bot: the last picture it took of its screen here, with what it just did, or the
 * computer asleep (before it has used it here, or with the screen off). Only to watch.
 * `open()`: show the tab; called by the «Computer» button and, on a wide window, the first time the
 * agente uses its screen here. `visible(on)`: the tab is on screen or not, for the pictures.
 */
export function computerView(inst, threadId, open) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/screen`;
	const seenKey = `owni.screen.${threadId}`;
	let version = -1;
	let shown = false;
	// A picture gone between the question and the download (the screen reset): asked again next time.
	const picture = h("img.screen", { alt: "", hidden: true, onerror: () => { version = -1; } });
	const asleep = h("div.computer-asleep", h("span.computer-face", face(inst, 52, "asleep"), h("span.zz", { "aria-hidden": "true" }, h("span", "z"), h("span", "z"))), h("p", "Il computer dorme"));
	const when = h("span");
	const what = h("p.browser-note", { hidden: true });
	const offNote = h("p.browser-note", { hidden: true }, `Lo schermo di ${inst.name} è spento: l'owner lo accende nella sua configurazione.`);
	const el = h(
		"div.computer",
		h("figure.computer-view", h("div.computer-screen", picture, asleep), h("figcaption", `Lo schermo di ${inst.name}`, when)),
		what,
		offNote,
		h("p.browser-note", "Qui guardi soltanto. Prima di inviare, pagare o accedere a un account si ferma e te lo chiede in chat."),
	);
	const toggle = h("button.browser-toggle", { type: "button", title: `Il computer di ${inst.name}`, "aria-pressed": "false", onclick: () => open() }, icon("screen"), h("span", "Computer"));
	const sleep = () => {
		picture.hidden = true;
		what.hidden = true;
		asleep.hidden = false;
		toggle.classList.remove("news");
		when.textContent = "";
		version = -1;
	};
	const refresh = async () => {
		const answer = await api(base).catch(() => undefined);
		// The conversation gone while asking: nothing to open or draw.
		if (answer === undefined || !toggle.isConnected) return;
		const { screen, on } = answer;
		off = !on && screen === null;
		offNote.hidden = !off;
		// Not used here yet, or any more (the screen reset, Owni restarted), or no screen: asleep.
		if (screen === null) return sleep();
		if (store(seenKey) !== "1" && !shown) {
			if (matchMedia("(max-width: 860px)").matches) toggle.classList.add("news");
			else open();
		}
		when.textContent = ` · ${fmt.time(screen.at)}`;
		what.textContent = screen.action ?? "Ha guardato lo schermo.";
		what.hidden = false;
		if (screen.version !== version && shown) {
			version = screen.version;
			picture.src = `${base}.png?v=${screen.version}`;
			picture.alt = `Lo schermo di ${inst.name}: ${what.textContent}`;
			picture.hidden = false;
			asleep.hidden = true;
		}
	};
	const visible = (on) => {
		if (on === shown) return;
		shown = on;
		toggle.setAttribute("aria-pressed", String(on));
		if (on) {
			toggle.classList.remove("news");
			store(seenKey, "1");
			void refresh();
		}
	};
	// Often while the tab is on screen or the conversation is moving, rarely otherwise; for an
	// agente without the screen only while the tab is on screen. A picture only after a change.
	let ticks = 0;
	let livelyUntil = 0;
	let off = false;
	const timer = setInterval(() => {
		if (!toggle.isConnected && !el.isConnected) return clearInterval(timer);
		ticks += 1;
		if (document.visibilityState === "visible" && (shown || (!off && (Date.now() < livelyUntil || ticks % 5 === 0)))) void refresh();
	}, 2000);
	void refresh();
	return {
		el,
		toggle,
		visible,
		lively: () => {
			livelyUntil = Date.now() + 120_000;
		},
	};
}
