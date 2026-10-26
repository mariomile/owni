// Task page, with sentinelle and the morning brief.
import { api, dmHref, emptyNote, fmt, h, head, icon, mount, needInstance, route, state, toast } from "../common.js";
import { render } from "../shell.js";
import { runHistory } from "../runs.js";

// ---------- task ----------
export async function viewTasks(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	const [{ schedules }, { watches }, threads, briefState] = await Promise.all([
		api(`/api/instances/${inst.id}/schedules`),
		api(`/api/instances/${inst.id}/watches`),
		inst.canChat ? api(`/api/instances/${inst.id}/threads`).then((r) => r.threads) : Promise.resolve([]),
		api(`/api/instances/${inst.id}/brief`).catch(() => undefined),
	]);
	if (!main.isConnected || state.instance !== inst) return;
	const remove = (s) =>
		h(
			"button.icon-btn.task-remove",
			{
				title: "Elimina il task",
				"aria-label": "Elimina il task",
				onclick: async () => {
					await api(`/api/instances/${inst.id}/schedules/${s.id}`, { method: "DELETE" });
					toast("Task eliminato");
					render();
				},
			},
			icon("trash"),
		);
	const when = (s) => ("at" in s.when ? "Una volta" : s.whenText ? s.whenText[0].toUpperCase() + s.whenText.slice(1) : h("span.mono", `${s.when.cron} (${s.when.timeZone})`));
	const table = h(
		"ul.task-list",
		schedules.map((s) =>
			h(
				"li.task-row",
				h("span.fold-glyph", icon("task")),
				h(
					"div.task-text",
					h("b", s.kind === "brief" ? "Brief del mattino" : s.instruction),
					h("small", when(s), " · ", s.nextRunAt ? `prossima ${fmt.soon(s.nextRunAt)}` : "finito", s.createdBy.kind === "instance" ? ` · creato da ${inst.name}` : ""),
				),
				remove(s),
			),
		),
	);
	let mode = "cron";
	const instruction = h("textarea", { rows: 2, placeholder: "Es. Riassumi le email di ieri e dimmi cosa richiede una risposta" });
	const at = h("input", { type: "datetime-local" });
	const cron = h("input", { type: "text", value: "0 9 * * 1-5", class: "mono" });
	// A chat of its own by default: the results do not end up in whatever chat was last open.
	const thread = h("select", threadOptions(inst, threads));
	const whenBox = h("div");
	// The usual schedules are one click; the cron is there for the rest.
	const custom = h("label.field", { hidden: true }, h("span", "Ripetizione (cron, fuso Europe/Rome)"), cron, h("small", "minuto ora giorno mese giorno-settimana"));
	const presets = h(
		"div.choices",
		{ role: "group", "aria-label": "Quando si ripete" },
		[
			["Giorni feriali 9:00", "0 9 * * 1-5"],
			["Ogni lunedì 8:30", "30 8 * * 1"],
			["Ogni giorno 18:00", "0 18 * * *"],
			["Primo del mese 9:00", "0 9 1 * *"],
			["Personalizzata", null],
		].map(([label, value]) =>
			h(
				"button",
				{
					type: "button",
					"aria-pressed": value === cron.value ? "true" : "false",
					onclick: (e) => {
						for (const b of presets.children) b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false");
						custom.hidden = value !== null;
						if (value === null) cron.focus();
						else cron.value = value;
					},
				},
				label,
			),
		),
	);
	const drawWhen = () => mount(whenBox, mode === "cron" ? [presets, custom] : h("label.field", h("span", "Data e ora"), at));
	const seg = h(
		"div.seg",
		[
			["cron", "Si ripete"],
			["once", "Una volta"],
		].map(([value, label]) =>
			h(
				"button",
				{
					type: "button",
					"aria-pressed": value === mode ? "true" : "false",
					onclick: (e) => {
						mode = value;
						for (const b of seg.children) b.setAttribute("aria-pressed", b === e.currentTarget ? "true" : "false");
						drawWhen();
					},
				},
				label,
			),
		),
	);
	drawWhen();
	const create = async () => {
		try {
			// Checked here, before a new chat is opened for it.
			if (!instruction.value.trim()) throw new Error("Scrivi cosa deve fare");
			if (mode === "cron" ? !cron.value.trim() : !at.value) throw new Error("Scegli quando");
			const title = instruction.value.trim().replace(/\s+/g, " ");
			const threadId = thread.value || (await api(`/api/instances/${inst.id}/dm`, { method: "POST", body: {} })).thread.id;
			const body = { instruction: instruction.value, threadId, ...(mode === "cron" ? { cron: cron.value } : { at: at.value ? new Date(at.value).toISOString() : "" }) };
			await api(`/api/instances/${inst.id}/schedules`, { method: "POST", body });
			toast("Task programmato");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const intent = route().rest[0];
	const scheduled = h("div.grid-2",
		h("div.card", schedules.length ? table : emptyNote("div.empty", "Nessuna istruzione programmata", `Programmane una qui, oppure chiedilo a ${inst.name} in chat.`)),
		h("div.card.pad", h("h2", "Programma un'istruzione"), inst.canChat
			? [h("label.field", h("span", "Cosa deve fare"), instruction), h("div.field", h("span", "Quando"), seg), whenBox, h("label.field", h("span", "Risultato nella chat"), thread), h("button.btn.accent", { onclick: create }, "Programma")]
			: h("p.muted", `Per programmare un'istruzione devi poter scrivere a ${inst.name}: il risultato arriva in una chat.`)),
	);
	mount(main,
		head(inst.name, h("h1", intent === "pagina" ? "Controlla una pagina" : intent === "orario" ? "A un orario" : "Orari e pagine da controllare"), `Scegli cosa deve fare ${inst.name} e dove ricevere il risultato.`),
		intent !== "pagina" && inst.canChat && briefState ? h("details.setup-optional", h("summary", "Parti dal brief del mattino"), briefCard(inst, briefState)) : null,
		intent !== "pagina" ? scheduled : null,
		intent !== "orario" ? watchSection(inst, watches, threads) : null,
		runHistory([inst], { sources: intent === "pagina" ? ["watch"] : intent === "orario" ? ["schedule", "brief"] : ["schedule", "brief", "watch"], names: new Map([...schedules.map((s) => [s.id, s.kind === "brief" ? "Brief del mattino" : s.instruction.slice(0, 100)]), ...watches.map((w) => [w.id, w.name ?? "Controllo pagina"])]), title: "Esiti delle tue automazioni" }),
	);
	if (intent === "orario" || intent === "pagina") {
		const target = intent === "orario" ? instruction : main.querySelector('input[type="url"]');
		target?.focus();
		target?.scrollIntoView({ block: "center" });
	}
}

/** Sentinelle: pages Owni checks by itself, writing to a chat when they change or a price crosses a threshold. */
/** Where a result is written: the direct conversation, or one of the chats from before it. */
function threadOptions(inst, threads) {
	return [h("option", { value: "" }, `I messaggi diretti con ${inst.name}`), threads.filter((t) => !t.dm).map((t) => h("option", { value: t.id }, t.title))];
}

function watchSection(inst, watches, threads) {
	const num = (n) => Number(n).toLocaleString("it-IT", { maximumFractionDigits: 2 });
	const condition = (w) => {
		const after = w.what ? ` dopo «${w.what}»` : "";
		if (w.below != null && w.above != null) return `Prezzo${after} sotto ${num(w.below)} o sopra ${num(w.above)}`;
		if (w.below != null) return `Prezzo${after} sotto ${num(w.below)}`;
		if (w.above != null) return `Prezzo${after} sopra ${num(w.above)}`;
		return w.what ? `Cambiamenti vicino a «${w.what}»` : "Qualsiasi cambiamento della pagina";
	};
	const status = (w) => {
		if (w.disabledReason) return h("span.chip.bad", "ferma");
		if (w.failures > 0) return h("span.chip.warn", `errore ${w.failures}×`);
		return h("span.chip.ok", "attiva");
	};
	const host = (url) => {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	};
	const act = (label, path, method, done, cls = "") =>
		h(
			`button.btn.small${cls}`,
			{
				onclick: async () => {
					try {
						await api(`/api/instances/${inst.id}/watches/${path}`, { method });
						toast(done);
						render();
					} catch (error) {
						toast(error.message, true);
					}
				},
			},
			label,
		);
	const often = (m) => (m < 60 ? `ogni ${m} minuti` : m === 60 ? "ogni ora" : m < 1440 ? `ogni ${m / 60} ore` : "ogni giorno");
	const table = h(
		"ul.task-list",
		watches.map((w) =>
			h(
				"li.task-row",
				h("span.fold-glyph", icon("browser")),
				h(
					"div.task-text",
					h("b", h("a", { href: w.url, target: "_blank", rel: "noopener noreferrer" }, host(w.url)), " ", status(w)),
					h("small", condition(w), w.last?.side === "missing" ? " · prezzo non visibile ora" : w.last?.price != null ? ` · ora ${num(w.last.price)}` : ""),
					h("small", `${often(w.everyMinutes)[0].toUpperCase()}${often(w.everyMinutes).slice(1)} · `, w.lastCheckAt ? `ultimo controllo ${fmt.time(w.lastCheckAt)}` : "primo controllo in arrivo", w.createdBy.kind === "instance" ? ` · creata da ${inst.name}` : ""),
					w.disabledReason ? h("small.bad", `Ferma: ${w.disabledReason}`) : w.lastError ? h("small", `Ultimo errore: ${w.lastError}`) : null,
				),
				h("div.row-gap", w.disabledReason || w.failures > 0 ? act("Riattiva", `${w.id}/resume`, "POST", "Sentinella riattivata") : null, act("Elimina", w.id, "DELETE", "Sentinella eliminata", ".ghost.task-remove")),
			),
		),
	);
	const url = h("input", { type: "url", placeholder: "https://negozio.it/prodotto" });
	const what = h("input", { type: "text", placeholder: "Es. Prezzo, Disponibilità, il nome del prodotto", maxlength: 200 });
	const below = h("input", { type: "text", inputmode: "decimal", placeholder: "Es. 49,90" });
	const above = h("input", { type: "text", inputmode: "decimal", placeholder: "Es. 120" });
	const every = h(
		"select",
		[
			[30, "Ogni 30 minuti"],
			[60, "Ogni ora"],
			[180, "Ogni 3 ore"],
			[720, "Ogni 12 ore"],
			[1440, "Ogni giorno"],
		].map(([value, label]) => h("option", { value, ...(value === 60 ? { selected: true } : {}) }, label)),
	);
	const thread = h("select", threadOptions(inst, threads));
	const create = async () => {
		try {
			// Checked here, before a new chat is opened for it.
			if (!/^https?:\/\/\S+\.\S+/.test(url.value.trim())) throw new Error("Scrivi l'indirizzo della pagina, con https://");
			const page = url.value.trim().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
			const threadId = thread.value || (await api(`/api/instances/${inst.id}/dm`, { method: "POST", body: {} })).thread.id;
			const { watch } = await api(`/api/instances/${inst.id}/watches`, { method: "POST", body: { url: url.value, what: what.value, below: below.value, above: above.value, everyMinutes: Number(every.value), threadId } });
			const now = watch.last?.price != null ? ` Prezzo adesso: ${num(watch.last.price)}.` : "";
			toast(watch.below != null || watch.above != null ? `Sentinella attiva: ti scrivo quando il prezzo passa la soglia.${now}` : "Sentinella attiva: ti scrivo quando cambia.");
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	return [
		h("h2.subhead", "Pagine controllate"),
		h(
			"div.grid-2",
			h("div.card", watches.length ? table : emptyNote("div.empty", "Nessuna sentinella", "Owni controlla una pagina da sola e ti scrive quando cambia o quando un prezzo scende. Creane una qui accanto, oppure chiedi in chat: «avvisami quando questo scende sotto 50 €».")),
			h(
				"div.card.pad",
				h("h2", "Nuovo controllo"),
				inst.canChat
					? [
							h("label.field", h("span", "Pagina da controllare"), url),
							h("label.field", h("span", "Cosa guardare"), what, h("small", "La frase subito prima di quello che ti interessa. Senza frase Owni guarda tutta la pagina.")),
							h("div.grid-2", h("label.field", h("span", "Avvisami se il prezzo è sotto"), below), h("label.field", h("span", "o sopra"), above)),
							h("label.field", h("span", "Quanto spesso"), every),
							h("label.field", h("span", "Avvisi nella chat"), thread),
							h("button.btn.accent", { onclick: create }, "Attiva"),
						]
					: h("p.muted", `Per attivare una sentinella devi poter scrivere a ${inst.name}: gli avvisi arrivano in una chat.`),
			),
		),
	];
}

/** The person's brief del mattino: on, off, and at what time. */
function briefCard(inst, { brief, google }) {
	const time = h("input", { type: "time", value: brief?.time ?? "07:30", class: "mono" });
	const weekdays = h("input", { type: "checkbox", checked: brief ? brief.weekdaysOnly !== false : true });
	const save = async () => {
		try {
			await api(`/api/instances/${inst.id}/brief`, { method: "PUT", body: { time: time.value, weekdaysOnly: weekdays.checked } });
			toast(brief ? "Brief aggiornato" : `Brief attivo: ogni mattina alle ${time.value}`);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const off = async () => {
		await api(`/api/instances/${inst.id}/brief`, { method: "DELETE" }).catch((e) => toast(e.message, true));
		toast("Brief disattivato");
		render();
	};
	const hint = !google.available
		? "Google non è configurato su questo server: il brief userà solo quello che Owni ricorda di te."
		: !google.connected
			? "Collega Google dal menu del tuo account per avere calendario e mail nel brief."
			: !google.allowed
				? "Hai collegato Google, ma questo agente non lo può usare: l'owner lo attiva in Impostazioni."
				: "Calendario di oggi, mail non lette che chiedono una risposta, e quello che Owni ricorda di te. Solo lettura.";
	return h(
		"div.card.pad.brief",
		h("div.row-gap", h("h2", "Brief del mattino"), brief ? h("span.chip.ok", "Attivo") : null),
		h("p.muted", hint),
		h(
			"div.row-gap",
			h("label.field.inline", h("span", "Ora"), time),
			h("label.row-gap", weekdays, h("span", "Solo giorni feriali")),
			h("button.btn.accent", { onclick: save }, brief ? "Aggiorna" : "Attiva"),
			brief ? h("button.btn.ghost", { onclick: () => (location.hash = dmHref(inst.id, brief.threadId)) }, "Apri la chat del brief") : null,
			brief ? h("button.btn.danger", { onclick: off }, "Disattiva") : null,
		),
	);
}

