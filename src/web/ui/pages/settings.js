// Impostazioni page, with the cards for each capability and channel.
import { agentLabel, api, confirmDialog, face, go, h, head, icon, instanceHref, mount, needInstance, route, state, store, toast } from "../common.js";
import { copyBox, copyButton } from "../listen.js";
import { chatModelCache, modelFacts, subscriptionState } from "../models.js";
import { TONES } from "../tones.js";
import { refreshInstances, setupHidden } from "../session.js";
import { render } from "../shell.js";

/** A chip that follows a checkbox: on or off, without reloading the page. */
function onOff(box, on, off) {
	const chip = h("span.chip");
	const show = () => ((chip.className = box.checked ? "chip ok" : "chip"), (chip.textContent = box.checked ? on : off));
	box.addEventListener("change", show);
	show();
	return chip;
}

/**
 * A settings card that folds to one line until it is opened: what it is, whether it is on,
 * and a sentence on what it does. The page stays short; the form is one click away.
 */
function fold({ title, glyph, chip, lead }, ...body) {
	return h(
		"details.card.fold",
		h("summary", h("span.fold-glyph", icon(glyph)), h("span.fold-text", h("b", title), lead ? h("small", lead) : null), chip, h("span.fold-chevron", icon("down"))),
		h("div.fold-body", ...body),
	);
}



/** Owner: whether this instance may use people's Google accounts (its egress policy). */
function googleCard(inst, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/google`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Google consentito per questo agente" : "Google non più consentito per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Google"),
		h("p.muted", "Chi ha collegato il proprio Google (dal menu del suo account) può chiedere a questo agente di leggere la sua posta e il suo calendario, solo nelle sue conversazioni dalla console. Se il server lo permette, anche di preparare mail ed eventi: partono solo quando quella persona li approva."),
		h("label.row-gap", toggle, h("span", "Consenti Google a questo agente")),
	);
}

/** Owner: replies as voice notes, made by the server's speech service (ADR 0020). */
function speechCard(inst, host, allowed, understood) {
	const toggle = h("input", { type: "checkbox", checked: allowed, disabled: !allowed && !understood });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/speech`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} risponde a voce a chi manda un vocale` : "Risposte a voce spente per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Risposte a voce"),
		h("p.muted", `A chi le manda un vocale su Telegram o WhatsApp, Owni risponde con un vocale e con il testo. Ognuno può chiederle «rispondimi sempre a voce» o «niente vocali». La voce la fa ${host}: riceve solo il testo delle risposte da leggere, mai i vocali di chi le scrive.`),
		understood ? null : h("p.chip.warn", "Per rispondere ai vocali Owni deve prima capirli: accendi anche Messaggi vocali."),
		h("label.row-gap", toggle, h("span", "Rispondi a voce ai vocali")),
	);
}

/** Owner: pictures made on request for this instance, by the server's image service. */
function imagesCard(inst, host, maxPerDay, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/images`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} può creare immagini` : "Immagini spente per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Immagini"),
		h("p.muted", `Owni crea immagini quando gliele chiedono (un'illustrazione, un logo, un volantino) e ritocca le foto che le mandano. Le genera il servizio ${host}, che riceve la descrizione e, per un ritocco, la foto. L'immagine arriva in chat e resta tra i file. Al massimo ${maxPerDay} immagini al giorno per tutto l'account.`),
		h("label.row-gap", toggle, h("span", "Consenti le immagini a questo agente")),
	);
}

/**
 * Owner: the AI model this instance runs on (ADR 0032). Any provider Owni offers, with the
 * server's key or one the owner pastes here; a saved key never comes back to the page.
 */
function modelCard(inst, current, providers) {
	const KEY_STATE = { server: "Chiave del server", saved: "Chiave salvata", missing: "Serve una chiave" };
	const offered = providers.some((p) => p.id === current.provider);
	const provider = h(
		"select",
		// The local development model is not offered: the instance keeps it until the owner picks another.
		offered ? null : h("option", { value: current.provider, selected: "selected" }, "Modello di prova"),
		...[
			["Abbonamenti", providers.filter((p) => p.kind === "subscription")],
			["Provider con chiave API", providers.filter((p) => p.kind !== "subscription")],
		].filter(([, rows]) => rows.length).map(([label, rows]) => h("optgroup", { label }, rows.map((p) => h("option", { value: p.id, selected: p.id === current.provider ? "selected" : undefined }, p.label)))),
	);
	const filter = h("input", { type: "search", placeholder: "Cerca un modello", autocomplete: "off" });
	const model = h("select");
	const key = h("input", { type: "password", autocomplete: "off", class: "mono", "aria-describedby": `model-key-${inst.id}` });
	const hint = h("small", { id: `model-key-${inst.id}` });
	const keyRow = h("label.field", h("span", "Chiave API"), key, hint);
	const filterRow = h("label.field", h("span", "Cerca"), filter);
	const status = h("span.chip", { "aria-live": "polite" });
	const subscriptionHint = h("p.muted.small", { hidden: true });
	const problem = h("p.warn", { role: "alert", hidden: true });
	const submit = h("button.btn.accent", "Usa questo modello");
	const forget = h("button.btn.ghost", "Togli la chiave");
	let models = [];
	let asked = 0;
	const chosen = () => providers.find((p) => p.id === provider.value);
	const fill = (wanted) => {
		const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const shown = models.filter((m) => m.id === wanted || words.every((w) => `${m.name} ${m.id}`.toLowerCase().includes(w)));
		// Two models with the same name (one is a dated version) are told apart by their id.
		const names = new Map();
		for (const m of models) names.set(m.name, (names.get(m.name) ?? 0) + 1);
		mount(model, shown.map((m) => h("option", { value: m.id, selected: m.id === wanted ? "selected" : undefined }, modelLabel(m, names.get(m.name) > 1, chosen()?.kind === "subscription"))));
		submit.disabled = shown.length === 0 || (chosen()?.kind === "subscription" && !chosen()?.connected);
	};
	// The models are asked for when a provider is picked: some have hundreds. Only the last answer counts.
	const showModels = async () => {
		const p = chosen();
		const ask = ++asked;
		models = [];
		submit.disabled = true;
		problem.hidden = true;
		const keyState = p?.key ?? "server";
		const subscription = p?.kind === "subscription";
		status.textContent = p === undefined ? "Modello di prova" : subscription ? (p.connected ? "Abbonamento connesso" : "Abbonamento da collegare") : KEY_STATE[keyState];
		status.className = `chip${p === undefined || (subscription ? !p.connected : keyState === "missing") ? " warn" : " ok"}`;
		key.disabled = subscription || keyState === "server";
		key.value = "";
		key.placeholder = keyState === "server" ? "La mette chi gestisce il server" : keyState === "saved" ? "Incollane una nuova per cambiarla" : `La tua chiave ${p?.label ?? ""}`;
		hint.textContent = keyState === "server" ? "Il server ha già la chiave di questo provider." : `Resta sul server con le altre chiavi dell'account e non torna più su questa pagina. In alternativa chi gestisce il server la mette in ${p?.keyEnv}.`;
		keyRow.hidden = p === undefined || subscription;
		forget.hidden = subscription || keyState !== "saved";
		subscriptionHint.hidden = !subscription;
		subscriptionHint.textContent = p?.connected ? `Usa l'accesso locale di ${p.label} e il tuo abbonamento. Non serve una chiave API.` : "Collega prima questo abbonamento nell'elenco dei provider qui sopra.";
		filter.value = "";
		if (p === undefined) {
			models = [];
			filterRow.hidden = true;
			mount(model, h("option", { value: current.modelId }, current.modelId));
			return;
		}
		mount(model, h("option", { value: "" }, "Caricamento modelli…"));
		let answer;
		try {
			answer = await api(`/api/models/${encodeURIComponent(p.id)}`);
		} catch (error) {
			if (ask !== asked) return;
			mount(model, h("option", { value: "" }, "Modelli non disponibili"));
			problem.textContent = error.message;
			problem.hidden = false;
			return;
		}
		if (ask !== asked) return;
		models = [...answer.models].sort((a, b) => a.name.localeCompare(b.name));
		filterRow.hidden = models.length <= 20;
		fill(p.id === current.provider ? current.modelId : p.defaultModel);
	};
	provider.addEventListener("change", () => showModels().catch((error) => toast(error.message, true)));
	filter.addEventListener("input", () => fill(model.value));
	submit.addEventListener("click", async () => {
		submit.disabled = true;
		try {
			const body = { provider: provider.value, modelId: model.value, ...(key.value.trim() ? { apiKey: key.value.trim() } : {}) };
			const { model: saved } = await api(`/api/instances/${inst.id}/model`, { method: "PUT", body });
			toast(`Owni ora usa ${models.find((m) => m.id === saved.modelId)?.name ?? saved.modelId}`);
			render();
		} catch (error) {
			toast(error.message, true);
			fill(model.value);
		}
	});
	forget.addEventListener("click", () =>
		confirmDialog("Togliere la chiave?", `La chiave di ${chosen()?.label} viene cancellata dal server. Gli agenti che la usano vanno prima spostati su un altro modello.`, "Togli", async () => {
			await api(`/api/model-keys/${encodeURIComponent(provider.value)}`, { method: "DELETE" });
			toast("Chiave tolta");
			render();
		}),
	);
	const card = h(
		"div.card.pad",
		h("div.row-gap", h("h2", "Modello AI"), status),
		h("p.muted", "Scegli il provider e il modello per questo agente. Puoi usare un abbonamento connesso oppure una chiave API. Chat, file e memoria restano: anche le chat vecchie continuano con il nuovo modello."),
		h("label.field", h("span", "Provider"), provider),
		filterRow,
		h("label.field", h("span", "Modello"), model),
		keyRow,
		subscriptionHint,
		problem,
		h("div.actions", submit, forget),
	);
	card.chooseProvider = (id) => {
		provider.value = id;
		void showModels();
		provider.focus();
		card.scrollIntoView({ behavior: "smooth", block: "nearest" });
	};
	showModels().catch((error) => toast(error.message, true));
	return card;
}

/** The account's subscriptions, with the existing per-agent model and API-key editor below. */
function providersCard(inst, initial, initialModels) {
	let catalog = initial;
	let models = initialModels;
	let modelForm;
	let paintedModels;
	let busy = false;
	let pollAttempts = 0;
	let pollTimer;
	const rows = h("div.provider-list", { "aria-label": "Abbonamenti AI" });
	const modelSlot = h("div.provider-model");
	const problem = h("p.warn", { role: "alert", hidden: !initial.error }, initial.error ?? "");
	const note = h("p.muted.small");
	const detect = h("button.btn.ghost", { type: "button", onclick: () => run("/api/providers/detect", "POST") }, icon("search"), "Rileva di nuovo");
	const draw = () => {
		const subscriptions = (catalog.providers ?? []).filter((p) => p.kind === "subscription");
		note.textContent = catalog.localEnabled
			? "Gli accessi già presenti su questo computer vengono riconosciuti e collegati all'avvio. Un provider che scolleghi resta scollegato finché non lo ricolleghi."
			: "Gli abbonamenti richiedono Owni in esecuzione su questo computer con i provider locali attivi. I provider con chiave API restano disponibili.";
		detect.disabled = busy || (!catalog.localEnabled && !catalog.error);
		detect.textContent = busy ? "Rilevamento…" : "Rileva di nuovo";
		modelSlot.inert = busy;
		mount(rows, subscriptions.map((p) => {
			const status = subscriptionState(p);
			const current = models?.model.provider === p.id;
			const connecting = p.status === "connecting";
			const action = h("button.btn.ghost", { type: "button", disabled: busy || connecting || p.status === "not-installed" || p.status === "unavailable", "aria-label": `${p.connected ? "Riconnetti" : "Collega"} ${p.label}`, onclick: () => run(`/api/providers/${encodeURIComponent(p.id)}/connect`, "POST") }, connecting ? "Connessione…" : p.connected ? "Riconnetti" : "Collega");
			return h("div.provider-row", { role: "group", "aria-label": p.label },
				h("span.provider-mark", { "aria-hidden": "true" }, p.id === "claude-code" ? "✳" : ">_"),
				h("div.provider-info", h("div.row-gap", h("b", p.label), current ? h("span.provider-current", "In uso") : null), h("small.muted", p.connected ? "Accesso locale rilevato · Usa il tuo abbonamento" : connecting ? "Completa l'accesso nella pagina aperta nel browser. Questa schermata si aggiorna da sola." : p.status === "not-installed" ? `Installa ${p.label} su questo computer per collegarlo.` : p.status === "unavailable" ? "Non riesco a verificare l'accesso locale. Riprova il rilevamento." : "Collega il tuo abbonamento, senza chiave API."),
					p.error ? h("small.warn", p.error) : null,
					!p.connected && !connecting && p.installed && !p.authenticated && p.loginCommand ? h("div.provider-login", h("span.muted.small", "Premi Collega per accedere, oppure usa il terminale:"), h("code.mono", p.loginCommand), copyButton(p.loginCommand)) : null),
				h("div.provider-controls", h(`span.chip${status.tone ? `.${status.tone}` : ""}`, status.label), h("div.actions", p.connected ? h("button.btn.ghost", { type: "button", disabled: busy, onclick: () => modelForm?.chooseProvider(p.id) }, "Scegli modello") : null, action, p.connected ? h("button.btn.ghost.small", { type: "button", disabled: busy, "aria-label": `Scollega ${p.label}`, onclick: () => confirmDialog(`Scollegare ${p.label}?`, "Owni non userà più questo abbonamento. L'accesso nel terminale resta disponibile. Sposta prima gli agenti che lo usano su un altro provider.", "Scollega", () => run(`/api/providers/${encodeURIComponent(p.id)}`, "DELETE")) }, "Scollega") : null)),
			);
		}));
		if (models && models !== paintedModels) {
			modelForm = modelCard(inst, models.model, models.providers);
			modelForm.classList.remove("card", "pad");
			mount(modelSlot, anchor("modello", modelForm));
			paintedModels = models;
		} else if (!models) mount(modelSlot, h("p.warn", "Non riesco a caricare il modello di questo agente. Rileva di nuovo i provider per riprovare."));
	};
	const run = async (path, method) => {
		if (busy) return;
		clearTimeout(pollTimer);
		busy = true;
		problem.hidden = true;
		draw();
		try {
			await api(path, { method, ...(method === "POST" ? { body: {} } : {}) });
			[catalog, models] = await Promise.all([api("/api/providers"), api(`/api/instances/${inst.id}/model`)]);
			chatModelCache.clear();
		} catch (error) {
			problem.textContent = error.message;
			problem.hidden = false;
		} finally {
			busy = false;
			draw();
			pollAttempts = 0;
			schedulePoll();
		}
	};
	const card = h("section.card.pad.provider-settings",
		h("div.settings-heading", h("div", h("h2", "Provider"), h("p.muted", "Il tuo abbonamento, connesso a Owni.")), detect),
		rows, note, problem, modelSlot,
	);
	const schedulePoll = () => {
		clearTimeout(pollTimer);
		if (!(catalog.providers ?? []).some((p) => p.status === "connecting")) return;
		if (pollAttempts >= 180) {
			problem.textContent = "L'accesso è ancora in attesa. Completa la pagina nel browser, poi premi Rileva di nuovo.";
			problem.hidden = false;
			return;
		}
		pollTimer = setTimeout(async () => {
			if (!card.isConnected) return;
			pollAttempts++;
			try {
				const previous = JSON.stringify(catalog.providers);
				catalog = await api("/api/providers");
				if (previous !== JSON.stringify(catalog.providers)) models = await api(`/api/instances/${inst.id}/model`);
				draw();
			} catch (error) {
				problem.textContent = error.message;
				problem.hidden = false;
			}
			schedulePoll();
		}, 2000);
	};
	// Initialization only reads the access detected by the server; reconnecting is an explicit action.
	draw();
	requestAnimationFrame(schedulePoll);
	return card;
}

/** «Claude Sonnet 5.5 · foto · ragiona · entrata $3 · uscita $15 per M token»: what tells two models apart. */
function modelLabel(m, withId, subscription = false) {
	return `${withId ? `${m.name} (${m.id})` : m.name} · ${modelFacts(m, subscription)}`;
}

/** Owner: voice messages of this instance transcribed by the server's service. */
function voiceCard(inst, host, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/voice`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Vocali trascritti per questo agente" : "Vocali non più trascritti per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	return h(
		"div.card.pad",
		h("h2", "Messaggi vocali"),
		h("p.muted", `I vocali di Telegram e WhatsApp vengono trascritti da ${host} e arrivano a Owni come testo. Solo quelli delle persone che possono scrivere; l'audio va solo a quel servizio.`),
		h("label.row-gap", toggle, h("span", "Trascrivi i vocali di questo agente")),
	);
}

/** Owner: web search for this instance, through the server's search service (ADR 0017). */
function searchCard(inst, host, allowed, hosts) {
	const toggle = h("input", { type: "checkbox", checked: allowed });
	toggle.addEventListener("change", async () => {
		try {
			await api(`/api/instances/${inst.id}/search`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} può cercare sul web` : "Ricerca sul web spenta per questo agente");
			render();
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	});
	const everything = hosts.includes("*");
	const openAll = async () => {
		if (!confirm("Owni potrà leggere, fotografare e usare con il browser tutti i siti pubblici, non solo quelli trovati cercando. Una pagina con istruzioni nascoste potrebbe spingerla a cercare qualcosa che non deve. Continuare?")) return;
		try {
			await api(`/api/instances/${inst.id}/web`, { method: "PUT", body: { hosts: ["*"] } });
			toast("Owni può aprire tutti i siti pubblici");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	return h(
		"div.card.pad",
		h("h2", "Ricerca sul web"),
		h("p.muted", `Owni cerca notizie, prezzi, orari e tutto quello che cambia, e se glielo chiedi prepara un report di ricerca con le fonti numerate. Le ricerche vanno a ${host}, solo le parole cercate. Le pagine trovate le apre solo dai siti consentiti qui sotto.`),
		h("label.row-gap", toggle, h("span", "Consenti la ricerca a questo agente")),
		allowed && !everything
			? h("p.muted", h("span", hosts.length === 0 ? "Per ora vede solo titoli ed estratti dei risultati. " : "Delle pagine trovate apre solo quelle dei siti consentiti. "), h("button.btn.small.ghost", { onclick: openAll }, "Fai aprire tutti i siti pubblici"))
			: null,
	);
}

/** Owner: the sites this instance may read and screenshot. */
function webCard(inst, hosts) {
	const list = h("textarea", { rows: 4, class: "mono", placeholder: "comune.roma.it\nagenziaentrate.gov.it\n* (tutti i siti pubblici)", value: hosts.join("\n") });
	const save = async () => {
		try {
			const { hosts: saved } = await api(`/api/instances/${inst.id}/web`, { method: "PUT", body: { hosts: list.value.split(/[\s,]+/) } });
			toast(saved.length === 0 ? "Navigazione web spenta per questo agente" : saved.includes("*") ? "Owni può leggere tutti i siti pubblici" : `Owni può leggere ${saved.length} siti`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const chip = hosts.length === 0 ? h("span.chip", "Spenta") : hosts.includes("*") ? h("span.chip.warn", "Tutti i siti pubblici") : h("span.chip.ok", hosts.length === 1 ? "1 sito" : `${hosts.length} siti`);
	return fold(
		{ title: "Navigazione web", glyph: "browser", lead: `I siti che ${inst.name} può aprire con il suo browser.`, chip },
		h("p.muted", "I siti che Owni può leggere, fotografare e usare con il suo browser: apre le pagine, clicca, scrive nelle ricerche e nei filtri, ma non invia moduli (per quello servono le azioni sul web, con approvazione). Quello che scrive in una ricerca arriva al sito. Un dominio per riga, i sottodomini sono compresi. Meglio elencarli uno per uno: * vuol dire tutti i siti pubblici, anche quelli dove una pagina potrebbe spingere Owni a cercare qualcosa che non deve. Vuoto: nessuno."),
		h("label.field", h("span", "Siti consentiti"), list),
		h("button.btn", { onclick: save }, "Salva i siti"),
	);
}

/** Owner: forms on the allowed sites, sent only after a person approves each one (ADR 0011). */
function webActionsCard(inst, allowed) {
	const toggle = h("input", { type: "checkbox", checked: allowed || undefined });
	toggle.onchange = async () => {
		try {
			await api(`/api/instances/${inst.id}/web-actions-allowed`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Owni può chiedere di inviare moduli" : "Azioni sul web spente");
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	};
	return fold(
		{ title: "Azioni sul web", glyph: "approvazioni", lead: "Moduli inviati solo dopo un'approvazione.", chip: onOff(toggle, "Attive", "Spente") },
		h("p.muted", "Owni può chiedere di inviare un modulo di un sito consentito (un contatto, una prenotazione). Ogni invio aspetta l'approvazione di chi l'ha chiesto o di un approvatore, che vede destinazione e valori esatti; niente parte da solo."),
		h("label.row-gap", toggle, h("span", "Consenti le azioni sul web con approvazione")),
	);
}

/** Which other agenti may write to this one (ADR 0042). Each tick saves at once. */
function agentsCard(inst, settings) {
	const others = state.instances.filter((i) => i.id !== inst.id && !i.hasSegreteria);
	const allowed = new Set(settings.egress.channels.includes("agente") ? (settings.allowedUsers.agente ?? []) : []);
	const boxes = others.map((o) => {
		const box = h("input", { type: "checkbox", checked: allowed.has(o.id) || undefined });
		box.onchange = async () => {
			try {
				const from = others.filter((x, i) => boxes[i].box.checked).map((x) => x.id);
				await api(`/api/instances/${inst.id}/agents`, { method: "PUT", body: { from } });
				toast(box.checked ? `${o.name} può scrivere a ${inst.name}` : `${o.name} non può più scrivere a ${inst.name}`);
			} catch (error) {
				box.checked = !box.checked;
				toast(error.message, true);
			}
		};
		return { box, row: h("label.row-gap", box, h("span", agentLabel(o))) };
	});
	const chip = h("span.chip");
	const count = () => {
		const n = boxes.filter((b) => b.box.checked).length;
		chip.className = n ? "chip ok" : "chip";
		chip.textContent = n === 0 ? "Nessuno" : n === 1 ? "1 agente" : `${n} agenti`;
	};
	for (const b of boxes) b.box.addEventListener("change", count);
	count();
	return fold(
		{ title: "Agenti che possono scrivergli", glyph: "agenti", lead: `Chi può chiedere aiuto a ${inst.name} mentre lavora.`, chip },
		h("p.muted", `Un agente spuntato può chiedere aiuto a ${inst.name} mentre lavora: ${inst.name} risponde con i suoi strumenti e solo la memoria condivisa, e la risposta torna nella chat da cui era partita la domanda. Le conversazioni tra agenti non compaiono in chat; in Attività resta traccia di ogni messaggio. Per farli collaborare tutti insieme usa «Fate squadra» nella pagina Agenti.`),
		others.length === 0 ? h("p.muted", "Non ci sono altri agenti: creane uno dalla pagina Agenti.") : boxes.map((b) => b.row),
	);
}

/** The instance's computer (ADR 0013): a terminal with no network. */
function computerCard(inst, allowed, problem) {
	const toggle = h("input", { type: "checkbox", checked: allowed || undefined });
	toggle.onchange = async () => {
		try {
			await api(`/api/instances/${inst.id}/computer-allowed`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? "Owni può usare il suo computer" : "Computer spento");
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	};
	const reset = () =>
		confirmDialog("Azzerare il computer?", "Owni perde i file che ha nel suo computer (/work). Quelli copiati nel workspace restano.", "Azzera", async () => {
			await api(`/api/instances/${inst.id}/computer`, { method: "DELETE" });
			toast("Computer azzerato");
		});
	return h(
		"div.card.pad",
		h("h2", "Computer"),
		h("p.muted", "Owni esegue comandi in un computer suo, senza rete e senza segreti: elabora fogli e documenti, converte file, fa grafici. Usa copie dei file del workspace e rimette lì quelli che produce. Niente può uscire da quel computer, quindi i comandi non chiedono approvazione."),
		problem ? h("p.warn", `Il computer non è disponibile: ${problem}.`) : null,
		h("label.row-gap", toggle, h("span", "Consenti a Owni di usare il suo computer")),
		h("div.actions", h("button.btn.ghost", { onclick: reset }, "Azzera i file del computer")),
	);
}

/** The agente's screen through Cua (ADR 0045): a desktop of its own where it clicks and types. */
function desktopCard(inst, allowed, desktop) {
	if (!desktop.available) return h("div.card.pad", h("h2", "Schermo remoto"), h("p.muted", "Lo schermo remoto non è attivo su questo server: chiedi a chi gestisce Owni di attivarlo."));
	const toggle = h("input", { type: "checkbox", checked: allowed || undefined });
	toggle.onchange = async () => {
		try {
			await api(`/api/instances/${inst.id}/desktop-allowed`, { method: "PUT", body: { allowed: toggle.checked } });
			toast(toggle.checked ? `${inst.name} può usare il suo schermo` : "Schermo spento");
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(error.message, true);
		}
	};
	const reset = () =>
		confirmDialog("Riavviare lo schermo?", "Si chiude tutto quello che è aperto sullo schermo di questo agente. Il workspace non cambia.", "Riavvia", async () => {
			await api(`/api/instances/${inst.id}/desktop`, { method: "DELETE" });
			toast("Schermo riavviato");
		});
	const network =
		desktop.network === "internet"
			? "Arriva a internet, e il suo browser non segue l'elenco dei siti consentiti."
			: desktop.network === "none"
				? "Non ha internet: usa solo i suoi programmi."
				: "Gira altrove ed è lo stesso per tutti gli agenti che lo usano. Se arriva a internet, il suo browser non segue l'elenco dei siti consentiti.";
	const many = desktop.shared ? "" : " Se più agenti usano lo schermo insieme, quello usato meno di recente si chiude per fare posto.";
	return h(
		"div.card.pad",
		h("h2", "Schermo remoto"),
		h("p.muted", `${inst.name} ha un computer tutto suo, con un browser, dove guarda lo schermo, clicca e scrive. ${network} Quello che fa sullo schermo non chiede approvazione: prima di inviare, pagare o accedere a un account si ferma e chiede in chat.${many}`),
		desktop.problem ? h("p.warn", "Lo schermo per ora non funziona: chi gestisce Owni deve sistemarlo.") : null,
		desktop.problem ? h("details", h("summary", "Dettagli per chi gestisce Owni"), h("p.mono", desktop.problem)) : null,
		h("label.row-gap", toggle, h("span", "Consenti lo schermo a questo agente")),
		desktop.shared ? null : h("div.actions", h("button.btn.ghost", { onclick: reset }, "Riavvia lo schermo")),
	);
}

/** macOS permissions describe the host running Owni; the per-agent grant stays separate. */
function computerUseCard(inst, initialAllowed, initialDesktop) {
	let desktop = initialDesktop;
	let allowed = initialAllowed;
	let busy = false;
	const content = h("div");
	const message = h("p.muted.small", { role: "status", hidden: true });
	const problem = h("p.warn", { role: "alert", hidden: true });
	const check = h("button.btn.ghost", { type: "button", onclick: () => run() }, "Controlla di nuovo");
	const card = h("section.card.pad.computer-use-settings", h("div.settings-heading", h("div", h("h2", "Computer Use"), h("p.muted", "Lascia che Owni veda lo schermo, clicchi e scriva su questo Mac.")), check), content, message, problem);
	const draw = () => {
		check.disabled = busy;
		check.textContent = busy ? "Controllo…" : "Controlla di nuovo";
		if (desktop.kind !== "local") {
			mount(content, h("p.muted", "Il controllo di questo computer richiede l'app Owni per Mac con il servizio locale attivo. Lo schermo remoto, se disponibile, si gestisce separatamente qui sotto."));
			return;
		}
		const permissions = desktop.permissions;
		const supported = permissions?.supported === true;
		const ready = supported && permissions.screenRecording && permissions.accessibility;
		const toggle = h("input", { type: "checkbox", checked: allowed, disabled: busy || (!allowed && (!ready || !desktop.available)), "aria-describedby": "computer-use-consent" });
		toggle.addEventListener("change", async () => {
			const wanted = toggle.checked;
			toggle.disabled = true;
			problem.hidden = true;
			try {
				await api(`/api/instances/${inst.id}/desktop-allowed`, { method: "PUT", body: { allowed: wanted } });
				allowed = wanted;
				toast(allowed ? `${inst.name} può usare questo Mac` : `Computer Use disattivato per ${inst.name}`);
			} catch (error) {
				problem.textContent = error.message;
				problem.hidden = false;
			}
			draw();
		});
		const permissionRows = [
			["screenRecording", "Registrazione schermo", "Permette a Owni di vedere le finestre delle app.", "screen"],
			["accessibility", "Accessibilità", "Permette a Owni di cliccare e scrivere.", "compose"],
		].map(([id, title, text, glyph]) => {
			const granted = supported && permissions[id] === true;
			return h("div.permission-row", h("span.permission-glyph", icon(glyph)), h("div.provider-info", h("b", title), h("small.muted", text)), h("div.permission-controls", h(`span.chip${granted ? ".ok" : supported ? ".warn" : ""}`, granted ? "Consentito" : supported ? "Da consentire" : "Non disponibile"), granted ? null : h("button.btn.ghost", { type: "button", disabled: busy || !supported, "aria-label": `Consenti ${title.toLowerCase()}`, onclick: () => run(id) }, "Consenti")));
		});
		mount(content,
			h("div.computer-use-intro", h("span.computer-use-glyph", icon("screen")), h("div", h("b", "Questo Mac"), h("p.muted.small", "Owni interagisce con le app e i file di questo computer. Il computer è condiviso dagli agenti a cui dai il permesso.")), h(`span.chip${ready ? ".ok" : ".warn"}`, ready ? "Pronto" : "Da configurare")),
			!supported ? h("p.warn", permissions?.problem ?? desktop.problem ?? "Non riesco a leggere i permessi di macOS. Apri Owni sul Mac e controlla che il servizio locale sia attivo.") : null,
			h("div.permission-list", permissionRows),
			supported && permissions.problem ? h("p.warn", permissions.problem) : null,
			h("label.row-gap.computer-use-toggle", toggle, h("span", `Consenti l'uso di questo Mac a ${inst.name}`)),
			h("p.muted.small", { id: "computer-use-consent" }, ready ? "Questo consenso vale per l'agente selezionato. Puoi disattivarlo qui in qualsiasi momento." : "Consenti entrambi i permessi in Impostazioni di Sistema, poi controlla di nuovo e abilita l'agente."),
		);
	};
	const run = async (permission) => {
		if (busy) return;
		busy = true;
		problem.hidden = true;
		message.hidden = true;
		draw();
		try {
			if (permission) {
				await api("/api/desktop/permissions", { method: "POST", body: { permission } });
				message.textContent = "Completa il consenso in Impostazioni di Sistema, poi premi Controlla di nuovo. Se macOS lo richiede, riapri Owni.";
				message.hidden = false;
			}
			desktop = await api("/api/desktop");
		} catch (error) {
			problem.textContent = error.message;
			problem.hidden = false;
		} finally {
			busy = false;
			draw();
		}
	};
	draw();
	return card;
}

/** Deleting an agente (ADR 0046): what goes is said plainly, and the owner types the name to confirm. */
function deleteCard(inst) {
	const open = () => {
		const typed = h("input", { type: "text", autocomplete: "off", "aria-label": "Nome dell'agente" });
		const ok = h("button.btn.danger", { disabled: true }, "Elimina per sempre");
		typed.addEventListener("input", () => (ok.disabled = typed.value !== inst.name));
		const dialog = h(
			"dialog",
			h("h2", `Eliminare ${inst.name}?`),
			h("p", `Se ne vanno le sue conversazioni, la sua memoria, i file del suo workspace, i task programmati e le sentinelle, le richieste in attesa e i connettori. Bot Telegram, numero WhatsApp e telefono si scollegano, e il computer e lo schermo, se li ha, si spengono e si svuotano. Gli altri agenti non ricevono più messaggi da lui, e le risposte che gli dovevano ancora vanno perse. Non si può annullare.`),
			h("label.field", h("span", `Per confermare scrivi «${inst.name}»`), typed),
			h("div.actions", ok, h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
		);
		ok.onclick = async () => {
			ok.disabled = true;
			try {
				await api(`/api/instances/${inst.id}`, { method: "DELETE", body: { confirm: typed.value } });
				dialog.close();
				if (store("annie.instance") === inst.id) store("annie.instance", null);
				toast(`Agente «${inst.name}» eliminato`);
				await refreshInstances();
				go("agenti");
			} catch (error) {
				ok.disabled = false;
				toast(error.message, true);
			}
		};
		dialog.addEventListener("close", () => dialog.remove());
		document.body.append(dialog);
		dialog.showModal();
		typed.focus();
	};
	return h(
		"div.card.pad",
		h("h3.section-title", "Elimina agente"),
		h("p.muted", `Elimina ${inst.name} con tutto quello che sa e che ha: conversazioni, memoria, file e automazioni. Gli altri agenti restano come sono.`),
		h("div.actions", h("button.btn.danger", { onclick: open }, `Elimina ${inst.name}`)),
	);
}


// ---------- impostazioni ----------
export async function viewSettings(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	if (state.me.role !== "owner") {
		mount(main, head(agentLabel(inst), "Configurazione", "La configurazione dell'agente è riservata all'owner.", h("a.btn", { href: `#/agente/${encodeURIComponent(inst.id)}` }, "Torna al profilo")));
		return;
	}
	const [{ settings }, { people }, tg, wa, google, voice, search, tel, computer, speech, images, models, desktop, providers] = await Promise.all([
		api(`/api/instances/${inst.id}/settings`),
		api("/api/people"),
		api(`/api/instances/${inst.id}/telegram`).catch(() => undefined),
		api(`/api/instances/${inst.id}/whatsapp`).catch(() => undefined),
		api("/api/google").catch(() => ({ available: false })),
		api("/api/voice").catch(() => ({ available: false })),
		api("/api/search").catch(() => ({ available: false })),
		api(`/api/instances/${inst.id}/phone`).catch(() => undefined),
		api("/api/computer").catch(() => ({ available: false })),
		api("/api/speech").catch(() => ({ available: false })),
		api("/api/images").catch(() => ({ available: false })),
		api(`/api/instances/${inst.id}/model`).catch(() => undefined),
		api("/api/desktop").catch(() => ({ available: false })),
		api("/api/providers").catch((error) => ({ localEnabled: false, providers: [], error: error.message })),
	]);
	if (!main.isConnected || state.instance !== inst || state.me?.role !== "owner") return;
	const name = h("input", { type: "text", value: settings.name, maxlength: "80", "aria-label": "Nome" });
	const emoji = h("input.emoji-input", { type: "text", value: settings.persona.emoji ?? "", placeholder: "🙂", maxlength: "16", "aria-label": "Emoji" });
	const tagline = h("input", { type: "text", value: settings.persona.tagline ?? "", maxlength: "120", placeholder: "Cosa fa, in una riga" });
	const tone = h("select", TONES.map(([value, label]) => h("option", { value, selected: value === (settings.persona.tone ?? "naturale") ? "selected" : undefined }, label)));
	const instructions = h("textarea", { rows: 9, value: settings.instructions });
	const chat = new Set(settings.allowedUsers.web ?? []);
	const approve = new Set(settings.approvers.web ?? []);
	const rows = people.map((p) => {
		const c = h("input", { type: "checkbox", checked: chat.has(p.id), "aria-label": `${p.name} può scrivere` });
		const a = h("input", { type: "checkbox", checked: approve.has(p.id), "aria-label": `${p.name} approva` });
		return { p, c, a, row: h("tr", h("td", p.name, h("small.muted.person-role", p.role === "owner" ? "Owner" : "Membro", p.id === state.me.id ? " · tu" : "")), h("td", c), h("td", a)) };
	});
	const save = async () => {
		try {
			await api(`/api/instances/${inst.id}/settings`, { method: "PUT", body: { name: name.value, instructions: instructions.value, persona: { emoji: emoji.value, tagline: tagline.value, tone: tone.value }, webPeople: rows.filter((r) => r.c.checked).map((r) => r.p.id), webApprovers: rows.filter((r) => r.a.checked).map((r) => r.p.id) } });
			toast("Identità e accessi salvati");
			await refreshInstances();
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const e = settings.egress;
	const allowed = (id) => (e.connectors ?? []).includes(id);
	const modelEditor = providersCard(inst, providers, models);
	modelEditor.classList.remove("card", "pad");
	const modelDetails = fold({ title: "Cambia modello o gestisci provider", glyph: "spark", lead: "Abbonamenti, chiavi API e scelta del modello. Ogni modifica ha il suo comando." }, anchor("providers", modelEditor));
	const groups = [
		{ id: "identita", label: "Identità", glyph: "agenti", anchors: ["personalita", "elimina"], content: [
			anchor("personalita", h("div.card.pad",
				h("h2", "Identità e istruzioni"),
				h("div.field", h("span", "Nome"), h("div.name-row", h("span.name-face", face(inst, 40)), emoji, name)),
				h("label.field", h("span", "Cosa fa, in una riga"), tagline),
				h("label.field", h("span", "Tono"), tone),
				h("label.field", h("span", "Istruzioni"), instructions, h("small", "Cosa sa fare e le sue regole. Nome, ruolo e tono gli arrivano dopo queste.")),
			)),
			settings.deletable ? fold({ title: "Elimina agente", glyph: "trash", lead: "Eliminazione definitiva, con conferma del nome." }, anchor("elimina", deleteCard(inst))) : null,
		] },
		{ id: "modello", label: "Modello", glyph: "spark", anchors: ["providers"], content: [
			h("div.card.pad", h("h2", "Modello attuale"), h("p", settings.model.provider === "faux" ? "Modello di prova" : settings.model.modelId), h("p.muted", "Puoi continuare a usare l'agente con questo modello. Cambialo soltanto quando serve.")),
			modelDetails,
		] },
		{ id: "capacita", label: "Capacità", glyph: "connettori", anchors: ["computer-use", "google", "vocali", "voce", "ricerca", "immagini", "siti", "azioni-web", "agenti", "computer", "schermo"], content: [
			h("div.card.pad", h("h2", "Servizi e strumenti"), h("p.muted", "Aggiungi o modifica un servizio quando serve al lavoro dell'agente. I permessi e le approvazioni restano quelli di ogni capacità."), h("div.actions", h("a.btn", { href: instanceHref("connettori", [], inst.id) }, "Apri servizi e strumenti")), h("p.muted.small", `Connettori consentiti: ${(e.connectors ?? []).join(", ") || "nessuno"}.`)),
			google.available ? anchor("google", googleCard(inst, allowed("google"))) : null,
			voice.available ? anchor("vocali", voiceCard(inst, voice.host, allowed("voice"))) : null,
			speech.available ? anchor("voce", speechCard(inst, speech.host, allowed("speech"), voice.available && allowed("voice"))) : null,
			search.available ? anchor("ricerca", searchCard(inst, search.host, allowed("web_search"), e.web ?? [])) : null,
			images.available ? anchor("immagini", imagesCard(inst, images.host, images.maxPerDay, allowed("image_generation"))) : null,
			anchor("siti", webCard(inst, e.web ?? [])),
			anchor("azioni-web", webActionsCard(inst, allowed("web-actions"))),
			anchor("computer-use", computerUseCard(inst, allowed(desktop.connector ?? "schermo"), desktop)),
			computer.available ? anchor("computer", computerCard(inst, allowed("computer"), computer.problem)) : null,
			desktop.kind === "local" ? null : anchor("schermo", desktopCard(inst, allowed("schermo"), desktop)),
			anchor("agenti", agentsCard(inst, settings)),
		] },
		{ id: "canali", label: "Canali", glyph: "chat", anchors: ["telegram", "whatsapp", "telefono"], content: [
			h("div.card.pad", h("h2", "Dove risponde"), h("p", e.channels.map((c) => CHANNEL_NAMES[c] ?? c).join(", ") || "Nessun canale attivo"), h("p.muted", "Telegram, WhatsApp e telefono sono facoltativi. Ogni canale salva i propri accessi con il pulsante nel suo modulo.")),
			tg === undefined ? null : anchor("telegram", telegramCard(inst, tg.telegram)),
			wa === undefined ? null : anchor("whatsapp", whatsappCard(inst, wa.whatsapp)),
			tel === undefined ? null : anchor("telefono", phoneCard(inst, tel.phone)),
		] },
		{ id: "accessi", label: "Accessi", glyph: "persone", anchors: [], content: [
			h("div.card", h("div.pad", h("h2", "Chi può scrivere e approvare"), h("p.muted", "Scrivere all'agente e approvare le sue azioni sono permessi distinti. Essere owner non aggiunge automaticamente il permesso di scrivere. Questi accessi riguardano la console web; gli altri canali hanno i propri elenchi.")), h("table.ledger", h("thead", h("tr", h("th", "Persona"), h("th", "Scrive"), h("th", "Approva"))), h("tbody", rows.map((r) => r.row)))),
		] },
	];
	const requested = route().rest[0];
	let active = groups.find((group) => group.id === requested || group.anchors.includes(requested))?.id ?? "identita";
	const saveBar = h("div.card.pad.settings-save", h("p.muted.small", "Salva insieme nome, tono, istruzioni e accessi web, anche se li hai modificati in sezioni diverse."), h("button.btn.accent", { type: "button", onclick: save }, "Salva identità e accessi"));
	const independentNote = h("p.muted.small.settings-save-note", "Questa sezione salva separatamente: Usa il pulsante del singolo modulo. Gli interruttori salvano subito.");
	const panels = groups.map((group) => h("section.stack.settings-panel", { id: `settings-panel-${group.id}`, "aria-labelledby": `settings-section-${group.id}`, "data-settings-section": group.id }, group.content));
	const show = (id) => {
		active = id;
		for (const [i, panel] of panels.entries()) panel.hidden = groups[i].id !== active;
		for (const link of nav.querySelectorAll("a")) {
			if (link.dataset.settingsSection === active) link.setAttribute("aria-current", "page");
			else link.removeAttribute("aria-current");
		}
		saveBar.hidden = active !== "identita" && active !== "accessi";
		independentNote.hidden = !saveBar.hidden;
	};
	const nav = h("nav.settings-nav", { "aria-label": "Sezioni della configurazione" }, groups.map((group) => h("a", {
		id: `settings-section-${group.id}`,
		href: instanceHref("impostazioni", [group.id], inst.id),
		"data-settings-section": group.id,
		"aria-controls": `settings-panel-${group.id}`,
		onclick: (event) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			// No hashchange: the existing form nodes keep every unsaved input across sections.
			history.replaceState(null, "", instanceHref("impostazioni", [group.id], inst.id));
			show(group.id);
		},
	}, icon(group.glyph), group.label)));
	show(active);
	mount(main,
		head(agentLabel(inst), h("h1", "Configurazione"), `Configura ${inst.name} una sezione alla volta. Materiali e procedure restano nel suo profilo.`, h("a.btn.ghost", { href: `#/agente/${encodeURIComponent(inst.id)}` }, "Profilo agente"), h("button.btn.ghost", { onclick: () => (setupHidden(inst.id, false), go("inizia")) }, "Primi passi")),
		nav, saveBar, independentNote, panels,
	);
	if (requested === "modello") modelDetails.open = true;
}

/** Where people reach an agente, as they call it. */
const CHANNEL_NAMES = { web: "Console web", telegram: "Telegram", whatsapp: "WhatsApp", phone: "Telefono", mail: "Mail", agente: "Collaborazione tra agenti" };

/** A card that «Primi passi» can point at: #/impostazioni/<id> scrolls to it and makes it flash. */
function anchor(id, card) {
	card.id = `card-${id}`;
	if (route().rest[0] === id)
		requestAnimationFrame(() => {
			for (let parent = card.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
			if (card.tagName === "DETAILS") card.open = true;
			card.scrollIntoView({ behavior: "smooth", block: "start" });
			card.classList.add("flash");
		});
	return card;
}

/** The instance's Telegram bot: the token goes in once and never comes back. */
function telegramCard(inst, t) {
	const token = h("input", { type: "password", autocomplete: "off", placeholder: t.connected ? "Nuovo token (facoltativo)" : "123456789:AA…", class: "mono" });
	const list = (ids) => ids.join(", ");
	const allowed = h("input", { type: "text", class: "mono", value: list(t.allowedUsers), placeholder: "123456789, 987654321" });
	const approvers = h("input", { type: "text", class: "mono", value: list(t.approvers), placeholder: "123456789" });
	const ids = (input) => input.value.split(/[\s,]+/).filter(Boolean);
	const save = async () => {
		try {
			await api(`/api/instances/${inst.id}/telegram`, { method: "PUT", body: { ...(token.value.trim() ? { token: token.value.trim() } : {}), allowedUsers: ids(allowed), approvers: ids(approvers) } });
			toast(t.connected ? "Telegram aggiornato" : "Bot collegato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const disconnect = () =>
		confirmDialog("Scollegare il bot?", `${inst.name} smette di rispondere su Telegram. Il token viene cancellato.`, "Scollega", async () => {
			await api(`/api/instances/${inst.id}/telegram`, { method: "DELETE" });
			toast("Bot scollegato");
			render();
		});
	return fold(
		{ title: "Telegram", glyph: "plane", lead: `${inst.name} risponde in un bot tutto suo.`, chip: t.connected ? h("span.chip.ok", t.username ? `@${t.username}` : "Collegato") : h("span.chip", "Non collegato") },
		t.connected ? null : h("p.muted", "Crea un bot con @BotFather su Telegram e incolla qui il suo token. Ogni persona ammessa apre il bot e preme Start."),
		h("label.field", h("span", t.connected ? "Token" : "Token del bot"), token),
		h("label.field", h("span", "Chi può scrivere"), allowed, h("small", "ID numerici di Telegram, separati da virgole. Chi non è in elenco non riceve risposta. Per sapere il tuo ID scrivi a @userinfobot su Telegram.")),
		h("label.field", h("span", "Chi approva"), approvers, h("small", "Ricevono su Telegram le schede dei tool da approvare.")),
		h("div.actions", h("button.btn.accent", { onclick: save }, t.connected ? "Salva" : "Collega"), t.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
	);
}

/** The instance's WhatsApp number (Meta Cloud API): token and app secret go in once and never come back. */
function whatsappCard(inst, w) {
	const secret = (placeholder) => h("input", { type: "password", autocomplete: "off", class: "mono", placeholder });
	const accessToken = secret(w.connected ? "Nuovo token (facoltativo)" : "EAAG…");
	const appSecret = secret(w.connected ? "Nuovo app secret (facoltativo)" : "32 caratteri esadecimali");
	const phoneNumberId = h("input", { type: "text", class: "mono", placeholder: w.connected ? "Invariato" : "123456789012345" });
	const list = (numbers) => numbers.join(", ");
	const allowed = h("input", { type: "text", class: "mono", value: list(w.allowedUsers), placeholder: "393331234567, 393479876543" });
	const approvers = h("input", { type: "text", class: "mono", value: list(w.approvers), placeholder: "393331234567" });
	const templateName = h("input", { type: "text", class: "mono", value: w.template?.name ?? "", placeholder: "annie_aggiornamento" });
	const templateLanguage = h("input", { type: "text", class: "mono", value: w.template?.language ?? "", placeholder: "it" });
	const numbers = (input) => input.value.split(/[\s,]+/).map((n) => n.replace(/^\+/, "")).filter(Boolean);
	const save = async () => {
		try {
			const given = { accessToken: accessToken.value.trim(), phoneNumberId: phoneNumberId.value.trim(), appSecret: appSecret.value.trim() };
			// The template only when it changed: otherwise saving the people list does not need Meta.
			const changed = w.connected && (templateName.value.trim() !== (w.template?.name ?? "") || templateLanguage.value.trim() !== (w.template?.language ?? ""));
			const template = changed ? { templateName: templateName.value.trim(), templateLanguage: templateLanguage.value.trim() } : {};
			const body = { ...Object.fromEntries(Object.entries(given).filter(([, v]) => v)), ...template, allowedUsers: numbers(allowed), approvers: numbers(approvers) };
			await api(`/api/instances/${inst.id}/whatsapp`, { method: "PUT", body });
			toast(w.connected ? "WhatsApp aggiornato" : "Numero collegato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const disconnect = () =>
		confirmDialog("Scollegare WhatsApp?", `${inst.name} smette di rispondere su WhatsApp. Token e app secret vengono cancellati.`, "Scollega", async () => {
			await api(`/api/instances/${inst.id}/whatsapp`, { method: "DELETE" });
			toast("WhatsApp scollegato");
			render();
		});
	return fold(
		{ title: "WhatsApp", glyph: "chat", lead: `${inst.name} risponde su un numero WhatsApp Business.`, chip: w.connected ? h("span.chip.ok", w.number ?? "Collegato") : h("span.chip", "Non collegato") },
		w.connected ? null : h("p.muted", "Serve un numero WhatsApp Business sulla piattaforma di Meta. Da developers.facebook.com prendi il token di accesso permanente, l'ID del numero e l'app secret (guida in docs/chiavi.md)."),
		w.webhookUrl === null ? h("p.muted", "Questo server non ha un indirizzo https pubblico: WhatsApp non può mandargli i messaggi.") : null,
		h("label.field", h("span", "Token di accesso"), accessToken),
		h("label.field", h("span", "ID del numero"), phoneNumberId),
		h("label.field", h("span", "App secret"), appSecret, h("small", "Serve a controllare che i messaggi arrivino davvero da Meta.")),
		w.connected && w.webhookUrl !== null
			? h(
					"div.stack",
					h("h3.section-title", "Da incollare nell'app Meta (WhatsApp → Configurazione → Webhook)"),
					copyBox(w.webhookUrl, "Indirizzo"),
					copyBox(w.verifyToken ?? "", "Token di verifica"),
					h("small.muted", "Poi iscriviti al campo «messages»."),
				)
			: null,
		h("label.field", h("span", "Chi può scrivere"), allowed, h("small", "Numeri con prefisso internazionale, separati da virgole. Chi non è in elenco non riceve risposta.")),
		h("label.field", h("span", "Chi approva"), approvers, h("small", "Ricevono su WhatsApp le schede dei tool da approvare.")),
		w.connected
			? h(
					"div.stack",
					h("h3.section-title", "Oltre le 24 ore"),
					h("p.muted", "WhatsApp lascia scrivere liberamente solo entro 24 ore dall'ultimo messaggio della persona. Dopo, Owni tiene da parte i messaggi e li consegna appena la persona scrive. Con un template approvato da Meta (una variabile {{1}} nel testo) la avvisa subito, con un estratto."),
					h("div.grid-2", h("label.field", h("span", "Nome del template"), templateName), h("label.field", h("span", "Lingua"), templateLanguage)),
				)
			: null,
		h("div.actions", h("button.btn.accent", { onclick: save }, w.connected ? "Salva" : "Collega"), w.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
	);
}

/** The instance's phone number (Twilio, ADR 0012): Owni answers calls, one turn at a time. */
function phoneCard(inst, p) {
	const accountSid = h("input", { type: "text", class: "mono", autocomplete: "off", placeholder: p.connected ? (p.accountSid ?? "Invariato") : "AC…" });
	const authToken = h("input", { type: "password", class: "mono", autocomplete: "off", placeholder: p.connected ? "Nuovo auth token (facoltativo)" : "32 caratteri esadecimali" });
	const number = h("input", { type: "text", class: "mono", placeholder: p.connected ? (p.number ?? "Invariato") : "+390612345678" });
	const pin = h("input", { type: "password", inputmode: "numeric", autocomplete: "off", class: "mono", placeholder: p.connected ? "Nuovo codice (facoltativo)" : "Da 4 a 8 cifre" });
	const allowed = h("input", { type: "text", class: "mono", value: p.allowedUsers.join(", "), placeholder: "+393331234567, +393479876543" });
	// No "+" added here: 3331234567 would become a French number. The server asks for the prefix.
	const numbers = (input) => input.value.split(/[\s,]+/).filter(Boolean);
	const save = async () => {
		try {
			const given = { accountSid: accountSid.value.trim(), authToken: authToken.value.trim(), number: number.value.trim(), pin: pin.value.trim() };
			await api(`/api/instances/${inst.id}/phone`, { method: "PUT", body: { ...Object.fromEntries(Object.entries(given).filter(([, v]) => v)), allowedUsers: numbers(allowed) } });
			toast(p.connected ? "Telefono aggiornato" : "Numero collegato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const disconnect = () =>
		confirmDialog("Scollegare il telefono?", `${inst.name} smette di rispondere alle chiamate: il numero resta su Twilio ma rifiuta le chiamate. Le credenziali e le risposte in attesa vengono cancellate.`, "Scollega", async () => {
			await api(`/api/instances/${inst.id}/phone`, { method: "DELETE" });
			toast("Telefono scollegato");
			render();
		});
	return fold(
		{ title: "Telefono", glyph: "phone", lead: `${inst.name} risponde a voce alle chiamate.`, chip: p.connected ? h("span.chip.ok", p.number ?? "Collegato") : h("span.chip", "Non collegato") },
		p.connected ? null : h("p.muted", "Owni risponde alle chiamate su un numero Twilio, a voce, un turno alla volta. Da console.twilio.com prendi Account SID, auth token e il numero (guida in docs/chiavi.md): l'indirizzo delle chiamate lo imposta Owni."),
		p.https ? null : h("p.muted", "Questo server non ha un indirizzo https pubblico: Twilio non può chiamarlo."),
		h("label.field", h("span", "Account SID"), accountSid),
		h("label.field", h("span", "Auth token"), authToken, h("small", "Serve anche a controllare che le chiamate arrivino davvero da Twilio.")),
		h("label.field", h("span", "Numero"), number),
		h("label.field", h("span", "Codice"), pin, h("small", "Chi chiama lo digita all'inizio di ogni chiamata: il numero di chi chiama da solo si può falsificare. Dallo solo alle persone in elenco.")),
		h("label.field", h("span", "Chi può chiamare"), allowed, h("small", "Numeri con + e prefisso internazionale, separati da virgole. Le chiamate da altri numeri vengono rifiutate.")),
		h("div.actions", h("button.btn.accent", { onclick: save, disabled: !p.https && !p.connected }, p.connected ? "Salva" : "Collega"), p.connected ? h("button.btn.danger", { onclick: disconnect }, "Scollega") : null),
	);
}

