// The conversation's browser, next to the chat.
import { api, h, icon, store, toast } from "./common.js";

/**
 * The conversation's browser, next to the chat (ADR 0044): the page the agente has open with
 * web_browse, refreshed after each of its actions, and an address bar to open a page for it.
 * It opens by itself the first time the agente starts browsing in this conversation.
 */
export function browserPanel(inst, threadId, onShow) {
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
