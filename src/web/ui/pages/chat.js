// Chat page.
import { api, face, faceColor, fmt, go, h, icon, mount, needInstance, route, state, store, thinking, toast } from "../common.js";
import { boardNote, copyButton, listenButton } from "../listen.js";
import { connectorActionCard, googleActionCard } from "../cards.js";
import { agentCommands, commandMenu } from "../commands.js";
import { chatModelCache, chatModelChoices, chatModelList, modelAbilities, modelFacts, providerLogo } from "../models.js";
import { stepsLeftText } from "../setup.js";
import { install, installed, installOffer } from "../pwa.js";
import { refreshCounters } from "../session.js";
import { refreshThreads, renderRail } from "../shell.js";
import { conversationRuns } from "../runs.js";
import { renderMarkdown } from "../markdown.js";
import { linkPreviews, sources } from "../sources.js";

// ---------- chat ----------
/** A workspace picture shown in the page (not downloaded). */
const pictureUrl = (inst, path) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(path)}&inline=1`;

/** An answer: its markdown, and the sites it links to folded underneath. */
function reply(text) {
	const md = renderMarkdown(text);
	return h("div.body", md, sources(md));
}

/** The empty chat's starters, as on Grok: what Owni can do, each one the start of a message to finish. */
const HINTS = [
	{ icon: "search", label: "Cerca sul web", text: "Cerca sul web le ultime notizie su " },
	{ icon: "spark", label: "Ricerca approfondita", text: "Fai una ricerca approfondita su " },
	{ icon: "image", label: "Crea un'immagine", text: "Crea un'immagine di " },
	{ icon: "file", label: "Riassumi un file", text: "Riassumi in punti il file che ti carico", hint: "Aggiungi il file con la graffetta, trascinalo qui o incollalo" },
	{ icon: "task", label: "Ricordamelo", text: "Ricordami ogni lunedì alle 9 di " },
];

export async function viewChat(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	if (!inst.canChat) {
		mount(main, h("section.conversation.empty-chat", h("div.welcome", h("h2", "Chat non disponibile"), h("p", state.me.role === "owner" ? "Aggiungi te stesso alle persone che possono scrivere a questo agente, in Impostazioni." : "Non sei tra le persone che possono scrivere a questo agente."))));
		return;
	}
	const threadId = route().rest[0];
	chatModelCache.clear();
	const conversation = h("section.conversation");
	mount(main, conversation);
	if (!threadId) return landing(inst, conversation);
	// One panel at a time next to the chat, also when one opens by itself.
	const browser = browserPanel(inst, threadId, () => screen.show(false));
	const screen = screenPanel(inst, threadId, () => browser.show(false));
	mount(main, h("div.chat-split", conversation, browser.el, screen.el));
	state.unread.delete(threadId);
	renderRail();
	const { entries, model } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}`);
	if (!main.isConnected || state.instance !== inst) return;
	// Tools belong to the fixed context bar, after the conversation has loaded successfully.
	mount(main.parentElement.querySelector(".conversation-tools"), screen.toggle, browser.toggle);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	linkPreviews(transcript);
	let typing;
	let work;
	// New messages go above the agente's work in progress, which stays last, where its answer will be.
	const place = (el) => transcript.insertBefore(el, work?.el.parentNode === transcript ? work.el : null);
	// Follow the conversation while the person is at its end; leave them where they are when they scrolled up to read.
	// Only a move up lets go: the smooth scroll to the end passes through the middle too.
	let stick = true;
	let lastTop = 0;
	transcript.addEventListener("scroll", () => {
		const top = transcript.scrollTop;
		if (top < lastTop - 2) stick = false;
		if (transcript.scrollHeight - top - transcript.clientHeight < 80) stick = true;
		lastTop = top;
	}, { passive: true });
	const follow = () => { if (stick) transcript.scrollTop = transcript.scrollHeight; };
	const picture = (path) => pictureUrl(inst, path);
	// A file to download; also what a picture that does not show (deleted, not really a picture) becomes.
	const fileLink = (file) => h("a.file", { href: `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(file.path)}` }, h("span.ext", (file.path.split(".").pop() ?? "file").slice(0, 4)), h("span", h("b", file.path.split("/").pop()), file.caption ? h("div.muted", file.caption) : null));
	const show = (entry) => {
		// What the board sends the agente reads as a scheda, not as a wall of instructions the person never typed.
		const brief = entry.from === "person" ? boardNote(entry) : null;
		if (brief) {
			place(brief);
			return brief;
		}
		const shown = entry.file && /\.(png|jpe?g|webp|gif)$/i.test(entry.file.path);
		const body = shown
			? h(
					"div.picture",
					h(
					"a.pic",
					{ href: picture(entry.file.path), target: "_blank", rel: "noopener" },
					h("img", { src: picture(entry.file.path), alt: entry.file.caption ?? entry.file.path.split("/").pop(), loading: "lazy", onerror: (event) => event.target.closest(".picture").replaceWith(fileLink(entry.file)) }),
					),
					entry.file.caption ? h("div.muted", entry.file.caption) : null,
				)
			: entry.file
			? fileLink(entry.file)
			: entry.from === "owni"
			? reply(entry.text ?? "")
			: h("div.body", entry.text ?? "");
		const pictures = entry.images?.length
			? h(
					"div.pics",
					entry.images.map((path) => {
						const link = h("a", { href: picture(path), target: "_blank", rel: "noopener" });
						// A photo deleted from the workspace since: said, not a broken image.
						link.append(h("img", { src: picture(path), alt: path.split("/").pop(), loading: "lazy", onerror: () => link.replaceWith(h("span.gone", `${path.split("/").pop()} non c'è più`)) }));
						return link;
					}),
				)
			: null;
		const listen = entry.from === "owni" && entry.text ? listenButton(entry.text) : null;
		// Under an answer, on hover (always on touch): copy it, listen to it.
		const actions = entry.from === "owni" && entry.text ? h("div.msg-actions", copyButton(entry.text), listen) : null;
		// Which model wrote the reply: the chat's own, or the instance's when that could not answer.
		const by = entry.model ? h("span.by", { title: `${entry.model.provider} · ${entry.model.modelId}` }, entry.model.name ?? entry.model.modelId) : null;
		const el = h(`div.msg.${entry.from}`, h("div.meta", entry.from === "owni" ? [face(inst, 20), h("b.who", inst.name)] : null, fmt.time(entry.at), by), pictures, entry.text || entry.file || !pictures ? body : null, actions);
		place(el);
		return el;
	};
	for (const e of entries) show(e);
	// Google writes this conversation asked for: decided here, above the box, without leaving the chat.
	const asks = h("div.asks", { hidden: true });
	const drawAsks = async () => {
		const { actions } = await api(`/api/instances/${inst.id}/google-actions`).catch(() => ({ actions: [] }));
		const waiting = actions.filter((a) => a.status === "pending" && a.thread?.threadId === threadId);
		const { actions: calls } = await api(`/api/instances/${inst.id}/connector-actions`).catch(() => ({ actions: [] }));
		const asked = calls.filter((a) => a.status === "pending" && a.thread?.threadId === threadId);
		asks.hidden = waiting.length + asked.length === 0;
		const again = () => void drawAsks().then(refreshCounters);
		mount(asks, ...waiting.map((a) => googleActionCard(inst, a, again, true)), ...asked.map((a) => connectorActionCard(inst, a, again, true)));
	};
	void drawAsks();
	const stopTyping = () => {
		typing?.remove();
		typing = undefined;
	};
	const startTyping = () => {
		stopTyping();
		typing = thinking([inst]);
		place(typing);
		transcript.scrollTop = transcript.scrollHeight;
	};
	// Once durable state is known, one compact status replaces the optimistic typing indicator.
	work = conversationRuns(inst, threadId, () => {
		stopTyping();
		follow();
	});
	transcript.append(work.el);
	state.onEntry = (event) => {
		if (event.threadId !== threadId) return false;
		stopTyping();
		show(event.entry);
		if (event.entry.from === "owni") void drawAsks();
		browser.lively();
		screen.lively();
		follow();
		return true;
	};
	const box = chatBox(inst, threadId, conversation, async (text, images) => {
		browser.lively();
		screen.lively();
		const bubble = show({ from: "person", text, images, at: new Date().toISOString() });
		const listed = state.threads.find((t) => t.id === threadId && (!t.instanceId || t.instanceId === inst.id));
		if (listed && listed.title === "Nuova chat") {
			listed.title = text ? text.replace(/\s+/g, " ").slice(0, 60) : "Foto";
			renderRail();
		}
		startTyping();
		try {
			await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", body: images.length ? { text, images } : { text } });
			void work.refresh();
		} catch (error) {
			stopTyping();
			bubble.remove();
			throw error;
		}
		void refreshThreads().then(renderRail);
	}, modelPill(inst, model, async (picked) => {
		await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/model`, { method: "PUT", body: picked ? { provider: picked.provider, modelId: picked.modelId } : {} });
	}));
	conversation.append(transcript, h("div.dock", asks, box.el));
	transcript.scrollTop = transcript.scrollHeight;
	// A message written on the empty chat: sent as soon as its conversation opens.
	if (main.isConnected && store(`owni.autosend.${threadId}`) === "1") {
		store(`owni.autosend.${threadId}`, null);
		void box.submit();
	}
	// Opening a conversation to read it must not summon the phone's keyboard.
	if (!matchMedia("(pointer: coarse)").matches) box.input.focus({ preventScroll: true });
}

/**
 * The conversation's browser, next to the chat (ADR 0044): the page the agente has open with
 * web_browse, refreshed after each of its actions, and an address bar to open a page for it.
 * It opens by itself the first time the agente starts browsing in this conversation.
 */
function browserPanel(inst, threadId, onShow) {
	const base = `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/browser`;
	const seenKey = `owni.browser.${threadId}`;
	// This panel is for the signed-in person's private conversation; the API enforces its ownership.
	let version = -1;
	let wasOpen = false;
	let current = { open: false };
	let pending = false;
	let revision = 0;
	let refreshing = false;
	let profileRequest = 0;
	let profileCheckedAt = 0;
	const address = h("input.address", { type: "text", inputmode: "url", placeholder: "Indirizzo di un sito consentito", "aria-label": "Indirizzo", spellcheck: "false", autocomplete: "off" });
	const back = h("button.icon-btn", { type: "button", title: "Indietro", "aria-label": "Indietro", disabled: true }, icon("back"));
	const title = h("span.page-title", "Browser");
	// A picture gone between the question and the download (the page closed): the last one stays.
	const screen = h("img.screen", { alt: "", hidden: true, onerror: () => { version = -1; }, onclick: (event) => {
		if (pending || !current.open) return;
		// Where on the picture, as fractions of what is shown: the server places it in the page.
		const box = screen.getBoundingClientRect();
		if (box.width > 0 && box.height > 0) void go({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }, `${base}/click`);
	} });
	const emptyLead = h("p");
	const empty = h("div.browser-empty", emptyLead, h("p.muted", "Apri una pagina qui sopra e chiedigli di leggerla, oppure chiedigli di cercare qualcosa sul web."));
	const busyNote = h("span.busy-note", { hidden: true }, `${inst.name} sta usando il browser…`);
	const controlNote = h("p.browser-note", { role: "status", "aria-live": "polite" });
	const control = h("button.btn.small", { type: "button", disabled: true, onclick: () => {
		if (pending || !current.open) return;
		privateText.value = "";
		void go({}, `${base}/${current.control === "person" ? "release" : "takeover"}`);
	} }, "Prendi il controllo");
	const privateText = h("input.browser-private-text", {
		type: "password", maxlength: 1000, autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false",
		placeholder: "Testo da scrivere nella pagina", disabled: true, oninput: () => updateControls(),
	});
	const write = h("button.btn.small", { type: "submit", disabled: true }, "Scrivi nel campo");
	const keys = [
		["Tab", "Campo successivo (Tab)"], ["Shift+Tab", "Campo precedente (Shift+Tab)"], ["Enter", "Invio (Enter)"],
		["Backspace", "Cancella prima del cursore"], ["Escape", "Esc"], ["ArrowUp", "Freccia su"],
		["ArrowDown", "Freccia giù"], ["ArrowLeft", "Freccia sinistra"], ["ArrowRight", "Freccia destra"],
	];
	const key = h("select", { "aria-label": "Tasto da premere nella pagina", disabled: true }, keys.map(([value, label]) => h("option", { value }, label)));
	const press = h("button.btn.small.ghost", { type: "button", disabled: true, onclick: () => {
		if (current.control === "person") void go({ key: key.value }, `${base}/press`);
	} }, "Premi tasto");
	const human = h("div.browser-human", { hidden: true },
		h("p.browser-note", "Clicca prima sul campo della pagina in cui vuoi scrivere."),
		h("form.browser-private", { autocomplete: "off", onsubmit: (event) => {
			event.preventDefault();
			const text = privateText.value;
			// Clear before starting the request, also on failure. Never a chat message or a saved draft.
			privateText.value = "";
			updateControls();
			if (pending || current.control !== "person" || !text) return;
			void go({ text }, `${base}/type`);
		} }, h("label.browser-private-label", h("span", "Testo privato · massimo 1.000 caratteri"), privateText), write),
		h("p.browser-note", "Il testo va al campo scelto, senza passare dalla chat o dai log di Owni. Qui si cancella subito; sulla pagina può essere visibile."),
		h("div.browser-keys", key, press),
		h("p.browser-note", "Per inviare il modulo, clicca il suo pulsante nella pagina o premi Invio."),
	);
	const profileSummary = h("summary", "Accessi salvati");
	const hosts = h("p.browser-profile-hosts", "Apri il pannello per vedere i siti con cookie salvati.");
	const clear = h("button.btn.small.danger", { type: "button", onclick: async () => {
		if (pending) return;
		// Load the existing confirmation dialog only when clearing the profile.
		const { confirmDialog } = await import("../common.js");
		if (!el.isConnected || pending) return;
		confirmDialog("Esci dai siti?", `Cancella i cookie salvati per te in ${inst.name} e chiude tutti i tuoi browser di questo agente, anche nelle altre conversazioni.`, "Esci dai siti", () => void clearProfile());
	} }, "Esci dai siti");
	const profile = h("details.browser-profile", profileSummary, hosts,
		h("p.browser-note", `${inst.name} potrà usare gli accessi salvati quando le restituisci il controllo. Sono conservati solo i cookie: alcuni accessi potrebbero non restare salvati.`), clear,
	);
	const el = h(
		"aside.browser-panel",
		{ hidden: true, "aria-label": "Browser" },
		h("div.browser-head", icon("browser"), title, busyNote, h("button.icon-btn", { type: "button", title: "Chiudi", "aria-label": "Chiudi il browser", onclick: () => show(false) }, icon("close"))),
		h("form.browser-bar", { onsubmit: (event) => { event.preventDefault(); void go({ url: address.value }); } }, back, address),
		h("div.browser-control", controlNote, control),
		human,
		h("div.browser-view", screen, empty),
		profile,
		h("p.browser-note", "Solo siti consentiti e moduli semplici nella pagina principale. Login in riquadri incorporati, con passkey o moduli complessi non sono supportati. Non è un browser completo."),
	);
	const toggleLabel = h("span", "Browser");
	const toggle = h("button.browser-toggle", { type: "button", title: "Browser della conversazione", "aria-pressed": "false", onclick: () => show(el.hidden) }, icon("browser"), toggleLabel);
	const show = (on) => {
		if (on === !el.hidden) return;
		el.hidden = !on;
		toggle.setAttribute("aria-pressed", String(on));
		toggle.classList.remove("news");
		store(seenKey, "1");
		if (on) {
			onShow();
			void refresh();
			void refreshProfile();
		} else {
			privateText.value = "";
			updateControls();
		}
	};
	const narrow = () => matchMedia("(max-width: 860px)").matches;
	const updateControls = () => {
		const held = current.open && current.control === "person";
		back.disabled = pending || !current.open;
		address.disabled = pending;
		control.disabled = pending || !current.open;
		control.textContent = held ? `Restituisci ad ${inst.name}` : "Prendi il controllo";
		control.classList.toggle("ghost", held);
		const note = held ? `Hai tu il controllo. ${inst.name} non può usare il browser.`
			: current.open ? "Prendi il controllo per scrivere e inviare moduli." : "Apri una pagina per prenderne il controllo.";
		if (controlNote.textContent !== note) controlNote.textContent = note;
		human.hidden = !held;
		if (!held) privateText.value = "";
		privateText.disabled = pending || !held;
		write.disabled = pending || !held || !privateText.value;
		key.disabled = pending || !held;
		press.disabled = pending || !held;
		clear.disabled = pending;
		busyNote.hidden = !current.busy;
		busyNote.textContent = held ? "Operazione in corso…" : `${inst.name} sta usando il browser…`;
		toggleLabel.textContent = held ? "Browser · Controllo tuo" : "Browser";
		toggle.title = held ? `Hai il controllo: apri il browser per restituirlo ad ${inst.name}` : "Browser della conversazione";
		toggle.setAttribute("aria-label", toggle.title);
		el.classList.toggle("loading", pending);
		el.setAttribute("aria-busy", String(pending));
	};
	const draw = (browser, available = true) => {
		current = browser;
		updateControls();
		if (!browser.open) {
			screen.hidden = true;
			screen.removeAttribute("src");
			empty.hidden = false;
			title.textContent = "Browser";
			emptyLead.textContent = !available
				? "Il browser non è disponibile su questo server: chiedi all'operatore di installare Chromium."
				: browser.closed
				? `Il browser si è chiuso (${browser.closed}). Scrivi un indirizzo per riaprirlo.`
				: `Qui vedi il browser che ${inst.name} usa in questa conversazione, mentre lavora.`;
			version = -1;
			return;
		}
		// Chromium's own page for one that did not load: said plainly, the chat has the reason.
		const failed = browser.url.startsWith("chrome-error:");
		// A redacted address may no longer parse as a URL; it remains display text.
		let host = "Browser";
		try { host = new URL(browser.url).host || host; } catch {}
		title.textContent = failed ? "La pagina non si è aperta" : browser.title || host;
		if (document.activeElement !== address && !failed) address.value = browser.url;
		if (browser.version !== version && !el.hidden) {
			version = browser.version;
			screen.src = `${base}.png?v=${browser.version}`;
			screen.alt = `La pagina ${browser.title || browser.url}`;
			screen.hidden = false;
			empty.hidden = true;
		}
	};
	const refreshProfile = async () => {
		const request = ++profileRequest;
		profileCheckedAt = Date.now();
		try {
			const saved = await api(`${base}/profile`);
			if (request !== profileRequest) return;
			profileSummary.textContent = `Accessi salvati · ${saved.hosts.length}`;
			hosts.textContent = saved.hosts.length ? saved.hosts.join(", ") : "Nessun sito con cookie salvati.";
		} catch {
			if (request !== profileRequest) return;
			profileSummary.textContent = "Accessi salvati";
			hosts.textContent = "Non è stato possibile leggere gli accessi salvati. Riapri il pannello per riprovare.";
		}
	};
	const refresh = async () => {
		if (pending || refreshing) return;
		refreshing = true;
		const requestedAt = revision;
		try {
			const { browser, available } = await api(base);
			// A poll started before a takeover/release must never restore the old controller.
			if (requestedAt !== revision) return;
			// On a phone the panel would cover the chat: a dot on the button says it instead.
			if (browser.open && !wasOpen && el.hidden && store(seenKey) !== "1") {
				if (narrow()) toggle.classList.add("news");
				else show(true);
			}
			wasOpen = browser.open;
			draw(browser, available);
			if (!el.hidden && Date.now() - profileCheckedAt > 10_000) void refreshProfile();
		} catch {
			// A transient polling failure leaves the last view; explicit actions report their errors.
		} finally {
			refreshing = false;
		}
	};
	const go = async (body, path = base) => {
		if (pending || (body.url !== undefined && !body.url.trim())) return;
		const typing = path === `${base}/type`;
		pending = true;
		revision += 1;
		updateControls();
		try {
			const request = api(path, { method: "POST", body });
			// api serializes synchronously. Do not retain the submitted value while awaiting the response.
			if (typing) body.text = "";
			const { browser } = await request;
			draw(browser);
			address.blur();
			if (!el.hidden) void refreshProfile();
		} catch (error) {
			// Never display an echoed credential, even if a server returns one by mistake.
			toast(typing ? "Scrittura non riuscita. Clicca su un campo di testo nella pagina e riprova." : error.message, true);
		} finally {
			pending = false;
			revision += 1;
			updateControls();
			void refresh();
		}
	};
	const clearProfile = async () => {
		if (pending || !el.isConnected) return;
		pending = true;
		revision += 1;
		profileRequest += 1;
		privateText.value = "";
		updateControls();
		try {
			await api(`${base}/profile`, { method: "DELETE" });
			draw({ open: false });
			profileSummary.textContent = "Accessi salvati · 0";
			hosts.textContent = "Nessun sito con cookie salvati.";
			toast("Cookie salvati cancellati e browser chiusi.");
		} catch (error) {
			toast(error.message, true);
		} finally {
			pending = false;
			revision += 1;
			updateControls();
			void refresh();
			void refreshProfile();
		}
	};
	back.onclick = () => void go({ back: true });
	// While the chat is on screen: poll often while visible or active, rarely otherwise.
	let ticks = 0;
	let livelyUntil = 0;
	const timer = setInterval(() => {
		if (!el.isConnected) {
			privateText.value = "";
			return clearInterval(timer);
		}
		ticks += 1;
		if (document.visibilityState === "visible" && (!el.hidden || Date.now() < livelyUntil || ticks % 4 === 0)) void refresh();
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

/**
 * The agente's screen, live next to the chat (ADR 0067): the last picture it took of its screen in
 * this conversation, with what it just did. Only to watch: the agente works, the person follows.
 * The button appears once the agente has used its screen here; the panel opens by itself the first
 * time, on a wide window.
 */
function screenPanel(inst, threadId, onShow) {
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

/** The empty chat: a greeting, the box in the middle and a few ideas. Sending opens a new conversation. */
function landing(inst, conversation) {
	conversation.classList.add("empty-chat");
	// A model picked before the first message: the conversation it opens is created with it.
	let picked;
	const box = chatBox(inst, `new.${inst.id}`, conversation, async (text, images) => {
		const { thread } = await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: picked ? { model: { provider: picked.provider, modelId: picked.modelId } } : {} });
		store(`owni.draft.${thread.id}`, text);
		if (images.length) store(`owni.pending.${thread.id}`, JSON.stringify(images));
		store(`owni.autosend.${thread.id}`, "1");
		go("chat", thread.id);
	}, modelPill(inst, undefined, async (model) => {
		picked = model;
	}));
	const hour = new Date().getHours();
	const hello = hour < 5 || hour >= 18 ? "Buonasera" : "Buongiorno";
	const first = state.me.name.split(/\s+/)[0];
	conversation.style.setProperty("--glow", faceColor(inst));
	conversation.append(
		h(
			"div.welcome",
			h("div.mark", face(inst, 76)),
			h("h2", first && first !== "Owner" ? `${hello}, ${first}.` : `${hello}.`),
			h("p", state.instances.length > 1 ? `${inst.name}${inst.tagline ? `: ${inst.tagline.replace(/[.!?…]+$/, "")}` : ""}. Di cosa hai bisogno?` : "Di cosa hai bisogno?"),
			box.el,
			h(
				"div.hints.ideas",
				HINTS.map((idea) =>
					h(
						"button",
						{
							type: "button",
							onclick: () => {
								box.input.value = idea.text;
								box.input.dispatchEvent(new Event("input"));
								if (idea.hint) box.input.placeholder = idea.hint;
								box.input.focus();
								box.input.setSelectionRange(idea.text.length, idea.text.length);
							},
						},
						icon(idea.icon),
						idea.label,
					),
				),
			),
			state.setupLeft > 0 ? h("p.aside", h("a", { href: "#/inizia" }, stepsLeftText(state.setupLeft))) : null,
			state.me.role !== "owner" && installOffer && !installed() ? h("p.aside", h("button.btn.small.ghost", { onclick: install }, icon("install"), "Installa Owni come app")) : null,
		),
	);
	box.input.focus();
}

/**
 * The chat's model (ADR 0036), a pill in the message box as on Grok: the instance's, or a model of
 * a provider this person may use. `current` ({provider, modelId, name}) undefined: the instance's.
 * `save(model | undefined)` stores a choice; choices are saved one after the other, and when the
 * newest fails the pill shows the last one saved and the error is said.
 */
function modelPill(inst, current, save) {
	let chosen = current;
	let saved = current;
	let instanceModel;
	let picks = 0;
	let saving = Promise.resolve();
	// The name without what is in brackets: «Claude Sonnet 4 (Anthropic)» reads «Claude Sonnet 4»; the full name is in the tooltip.
	const short = (name) => name.replace(/\s*\([^)]*\)\s*$/, "") || name;
	const label = h("span.model-name", short(current?.name ?? "Modello"));
	const mark = h("span.model-mark");
	const pill = h("button.model-pill", { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Modello di questa chat" }, mark, label, icon("down"));
	const draw = () => {
		const shown = chosen ?? instanceModel;
		label.textContent = short(shown?.name ?? "Modello");
		mount(mark, shown?.provider ? providerLogo(shown.provider) : null);
		mark.hidden = mark.childElementCount === 0;
		pill.title = shown?.name ? `Modello di questa chat: ${shown.name}` : "Modello di questa chat";
		pill.classList.toggle("own", chosen !== undefined);
		pill.setAttribute("aria-label", `Modello di questa chat: ${shown?.name ?? "Modello"}${chosen ? "" : " (quello dell'agente)"}`);
	};
	const pick = (model) => {
		closeModelMenu();
		pill.focus();
		chosen = model;
		draw();
		const mine = ++picks;
		saving = saving.then(async () => {
			try {
				await save(model);
				saved = model;
				// An owner's pick may have allowed a provider: the list says so next time.
				chatModelCache.delete(inst.id);
			} catch (error) {
				if (mine !== picks) return;
				chosen = saved;
				draw();
				toast(error.message, true);
			}
		});
	};
	pill.addEventListener("click", () => {
		if (!closeModelMenu()) void openModelMenu(inst, pill, chosen, pick);
	});
	void chatModelChoices(inst)
		.then((choices) => {
			instanceModel = choices.instanceModel;
			draw();
		})
		.catch(() => {});
	draw();
	return pill;
}

/** The list of models under the pill: search, the instance's model, then each provider's. */
async function openModelMenu(inst, pill, chosen, pick) {
	const listId = `model-list-${Date.now()}`;
	const search = h("input", { type: "search", placeholder: "Cerca un modello", autocomplete: "off", "aria-label": "Cerca un modello", "aria-controls": listId });
	const list = h("div.model-list", { id: listId, role: "listbox", "aria-label": "Modelli" });
	const status = h("p.muted.model-empty", { role: "status" });
	const menu = h("div.model-menu", search, list, status);
	document.body.append(menu);
	pill.setAttribute("aria-expanded", "true");
	pill.setAttribute("aria-controls", listId);
	const place = () => {
		const r = pill.getBoundingClientRect();
		const view = window.visualViewport;
		const height = view?.height ?? window.innerHeight;
		const width = Math.min(320, window.innerWidth - 16);
		menu.style.width = `${width}px`;
		menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
		// Upwards from the box at the bottom of a chat; downwards when there is more room below.
		const above = r.top - 14;
		const below = height - r.bottom - 14;
		const up = above >= 280 || above >= below;
		menu.style.maxHeight = `${Math.min(420, up ? above : below)}px`;
		menu.style.bottom = up ? `${window.innerHeight - r.top + 6}px` : "";
		menu.style.top = up ? "" : `${r.bottom + 6}px`;
		menu.style.transformOrigin = up ? "bottom right" : "top right";
	};
	place();
	// On a phone the search waits for a tap: focusing it would open the keyboard over the list.
	const touch = window.matchMedia("(pointer: coarse)").matches;
	if (!touch) search.focus();
	const option = (text, note, selected, onPick, tag = null) =>
		h("button.model-option", { type: "button", role: "option", "aria-selected": selected ? "true" : "false", onclick: onPick }, h("span", h("span.model-option-name", text), note ? h("small", note) : null), tag ? h("span.model-tag", tag) : null, h("span.model-check", selected ? icon("check") : null));
	let catalogs = [];
	const fill = () => {
		const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const match = (m, p) => words.every((w) => `${m.name} ${m.id} ${p.label}`.toLowerCase().includes(w));
		const groups = catalogs.map(({ provider, models, error }, i) => {
			const shown = (models ?? []).filter((m) => match(m, provider));
			if (error === undefined && shown.length === 0) return null;
			const head = `model-group-${i}`;
			// Two models with the same name (one is a dated version) are told apart by their id.
			const names = new Map();
			for (const m of shown) names.set(m.name, (names.get(m.name) ?? 0) + 1);
			// The provider's suggested model first, then its catalog as it comes.
			const ordered = [...shown].sort((a, b) => (b.id === provider.defaultModel) - (a.id === provider.defaultModel));
			return h(
				"div",
				{ role: "group", "aria-labelledby": head },
				h("div.model-group", { id: head }, providerLogo(provider.id), h("span", provider.label, provider.allowed ? null : h("small", " · sceglierlo lo permette all'agente"))),
				error === undefined
					? ordered.map((m) => {
							// A subscription costs nothing more per message: it says so instead of a price.
							const subscription = provider.id === "claude-code" || provider.id === "codex";
							return option(names.get(m.name) > 1 ? `${m.name} (${m.id})` : m.name, subscription ? modelAbilities(m) : modelFacts(m), chosen?.provider === provider.id && chosen?.modelId === m.id, () => pick({ provider: provider.id, modelId: m.id, name: m.name }), subscription ? "Abbonamento" : null);
						})
					: h("small.model-error", "Elenco non disponibile ora"),
			);
		});
		mount(list, words.length === 0 ? option("Modello dell'agente", "lo sceglie l'owner in Impostazioni", chosen === undefined, () => pick(undefined)) : null, groups);
		status.textContent = words.length > 0 && groups.every((g) => g === null) ? "Nessun modello trovato" : "";
		status.hidden = status.textContent === "";
	};
	search.addEventListener("input", fill);
	menu.addEventListener("keydown", (e) => {
		const all = [search, ...list.querySelectorAll("button")];
		const i = all.indexOf(document.activeElement);
		if (e.key === "Escape") {
			e.preventDefault();
			closeModelMenu();
			pill.focus();
		} else if (e.key === "Tab") closeModelMenu();
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
		} else if (e.key === "Home" || e.key === "End") {
			if (document.activeElement === search) return;
			e.preventDefault();
			all[e.key === "Home" ? 1 : all.length - 1]?.focus();
		} else if (e.key === "Enter" && document.activeElement === search && search.value.trim() !== "") {
			// Enter in the search takes the first model found; with nothing typed it does nothing.
			e.preventDefault();
			list.querySelector("button")?.click();
		}
	});
	const away = (e) => {
		if (!menu.contains(e.target) && !pill.contains(e.target)) closeModelMenu();
	};
	document.addEventListener("pointerdown", away);
	window.addEventListener("resize", place);
	window.visualViewport?.addEventListener("resize", place);
	menu.cleanup = () => {
		document.removeEventListener("pointerdown", away);
		window.removeEventListener("resize", place);
		window.visualViewport?.removeEventListener("resize", place);
		pill.setAttribute("aria-expanded", "false");
		pill.removeAttribute("aria-controls");
	};
	status.textContent = "Carico i modelli…";
	try {
		const { providers } = await chatModelChoices(inst);
		// One provider that does not answer leaves the others listed.
		const settled = await Promise.allSettled(providers.map((provider) => chatModelList(inst, provider.id)));
		catalogs = providers.map((provider, i) => (settled[i].status === "fulfilled" ? { provider, models: settled[i].value } : { provider, error: settled[i].reason }));
	} catch (error) {
		status.textContent = error.message;
		return;
	}
	if (!menu.isConnected) return;
	fill();
	if (touch) list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
}

/** Closes the model list; true when one was open. */
export function closeModelMenu() {
	const menu = document.querySelector(".model-menu");
	if (!menu) return false;
	menu.cleanup?.();
	menu.remove();
	return true;
}

/**
 * The message box: text, photos waiting to go with it, files noted in it, a drop zone and a paste.
 * The draft and the photos are kept per key (a conversation, or "new") until onSend succeeds;
 * when onSend throws, they come back and the error is said.
 */
function chatBox(inst, key, dropZone, onSend, extra = null) {
	const picture = (path) => pictureUrl(inst, path);
	const draftKey = `owni.draft.${key}`;
	const input = h("textarea", { rows: 1, placeholder: `Scrivi a ${inst.name}…`, title: "Invio per inviare, Maiusc+Invio per andare a capo", "aria-label": "Messaggio", value: store(draftKey) ?? "" });
	// Photos uploaded for the next message: shown above the box until it is sent, kept with the draft.
	const pendingKey = `owni.pending.${key}`;
	const pending = (() => {
		try {
			const saved = JSON.parse(store(pendingKey) ?? "[]");
			return Array.isArray(saved) ? saved.filter((p) => typeof p === "string").slice(0, 4) : [];
		} catch {
			return [];
		}
	})();
	let uploading = 0;
	let sending = false;
	const tray = h("div.tray", { hidden: true });
	const sendButton = h("button.send", { "aria-label": "Invia", title: "Invia", onclick: () => submit() }, icon("send"));
	const ready = () => {
		sendButton.disabled = uploading > 0 || sending || (!input.value.trim() && pending.length === 0);
	};
	const drawTray = () => {
		store(pendingKey, pending.length ? JSON.stringify(pending) : null);
		tray.hidden = pending.length === 0 && uploading === 0;
		ready();
		mount(tray, 
			...pending.map((p, i) =>
				h("span.chip", h("img", { src: picture(p), alt: p.split("/").pop() }), h("button", { "aria-label": `Togli ${p.split("/").pop()}`, onclick: () => { pending.splice(i, 1); drawTray(); } }, "×")),
			),
			...Array.from({ length: uploading }, () => h("span.chip.loading", { "aria-label": "Caricamento" })),
		);
	};
	const fit = () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(220, input.scrollHeight)}px`;
	};
	const submit = async () => {
		const text = input.value.trim();
		if (uploading > 0) return toast("Aspetta che le foto finiscano di caricarsi");
		if (sending || (!text && pending.length === 0)) return;
		sending = true;
		const images = pending.splice(0);
		input.value = "";
		fit();
		drawTray();
		store(draftKey, null);
		try {
			await onSend(text, images);
		} catch (error) {
			toast(error.message, true);
			input.value = text;
			store(draftKey, text);
			pending.unshift(...images);
			fit();
		} finally {
			sending = false;
			drawTray();
		}
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void submit();
		}
	});
	input.addEventListener("input", () => {
		store(draftKey, input.value);
		fit();
		ready();
	});
	const file = h("input", { type: "file", class: "sr", multiple: true, "aria-label": "Carica un file o una foto" });
	const PICTURES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
	// From the paperclip, a drop on the chat or a paste (a screenshot): photos go with the message, other files are noted in it.
	const add = async (files) => {
		const pictures = files.filter((f) => PICTURES.includes(f.type));
		if (pending.length + pictures.length > 4) toast("Al massimo 4 foto per messaggio", true);
		const allowed = new Set(pictures.slice(0, Math.max(0, 4 - pending.length)));
		for (const f of files) {
			const isPicture = PICTURES.includes(f.type);
			if (isPicture && !allowed.has(f)) continue;
			if (isPicture) uploading += 1;
			drawTray();
			try {
				const name = f.name || `incollata.${f.type.slice("image/".length).replace("jpeg", "jpg")}`;
				const { file: saved, note } = await api(`/api/instances/${inst.id}/files/raw?name=${encodeURIComponent(name)}`, { method: "PUT", raw: f });
				if (isPicture) pending.push(saved.path);
				else {
					// The server's words for the file (a document, a recording): the same on every channel.
					input.value = `${input.value ? `${input.value}\n` : ""}${note} `;
					store(draftKey, input.value);
					fit();
					toast(`Caricato ${saved.path}`);
				}
			} catch (error) {
				toast(error.message, true);
			} finally {
				if (isPicture) uploading -= 1;
				drawTray();
			}
		}
		input.focus();
	};
	file.addEventListener("change", () => {
		const files = [...(file.files ?? [])];
		file.value = "";
		void add(files);
	});
	input.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		e.preventDefault();
		void add(files);
	});
	dropZone.addEventListener("dragover", (e) => {
		if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
	});
	dropZone.addEventListener("drop", (e) => {
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		e.preventDefault();
		void add(files);
	});
	drawTray();
	requestAnimationFrame(fit);
	const commands = commandMenu(input, () => agentCommands(inst.id), () => {
		store(draftKey, input.value);
		fit();
		ready();
	});
	const el = h("div.box", commands, tray, h("div.composer", h("label.attach", { title: "Carica un file o una foto" }, icon("attach"), h("span.sr", "File"), file), input, extra, sendButton));
	return { el, input, submit };
}

