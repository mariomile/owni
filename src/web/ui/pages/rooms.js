// Canali pages.
import { api, channelHref, channelName, confirmDialog, emptyNote, face, faceColor, fmt, go, h, head, icon, initials, mount, route, state, store, thinking, toast } from "../common.js";
import { agentCommands, commandMenu } from "../commands.js";
import { renderMarkdown } from "../markdown.js";
import { copyButton, listenButton } from "../listen.js";
import { refreshConversations, render, renderRail, windowDrag } from "../shell.js";
import { artifactCard, artifactPanel, isHtml } from "../artifacts.js";

// ---------- canali (ADR 0063, 0113) ----------
export async function viewRooms(main) {
	const { rest } = route();
	if (rest[0] && rest[0] !== "nuova") return viewRoom(main, rest[0], rest[1] === "t" ? rest[2] : undefined);
	const { rooms } = await api("/api/rooms");
	const chatty = state.instances.filter((i) => i.canChat);
	const create = () =>
		channelDialog("Nuovo canale", "", [], "Crea", async (title, agents) => {
			const { room } = await api("/api/rooms", { method: "POST", body: { title, agents } });
			await refreshConversations();
			go("canali", room.id);
		});
	const names = (r) => r.agents.map((a) => `${a.emoji ? `${a.emoji} ` : ""}${a.name}`).join(", ");
	mount(
		main,
		head(null, h("h1", "Canali"), "Tu e alcuni agenti nella stessa conversazione. Scrivi @nome per chiamarne uno, @tutti per tutti; senza nome risponde l'ultimo che ha parlato. Un agente può chiamare in causa un altro. I canali sono solo tuoi.", chatty.length > 1 ? h("button.btn.accent", { onclick: create }, icon("plus"), "Nuovo canale") : null),
		h(
			"div.card",
			rooms.length
				? h(
						"ul.room-list",
						rooms.map((r) =>
							h(
								"li",
								h(
									"a.room-row",
									{ href: channelHref(r.id) },
									// The faces of who is in it, overlapping like a group chat.
									h("span.room-faces", r.agents.slice(0, 3).map((a) => face(a, 30))),
									h("span.room-text", h("span.room-title", h("b", channelName(r.title)), h("span.muted", names(r))), r.last ? h("span.room-last", h("b", `${r.last.who}: `), r.last.text) : null),
									h("time.room-when", { datetime: r.updatedAt, title: fmt.time(r.updatedAt) }, fmt.short(r.updatedAt)),
								),
							),
						),
					)
				: emptyNote("div.empty", "Nessun canale", "Per esempio il ricercatore trova un bando, l'agente delle vendite prepara l'offerta e il contabile fa i conti, tutti nello stesso canale."),
		),
	);
	if (rest[0] === "nuova" && chatty.length > 1) create();
}

/** The name and the agenti (2 to 5) of a canale: to make one, or to change it. */
function channelDialog(title, name, chosen, okLabel, onSave) {
	const chatty = state.instances.filter((i) => i.canChat);
	const input = h("input", { type: "text", maxlength: 80, placeholder: "Es. Bando regionale", value: name });
	const boxes = chatty.map((i) => ({ id: i.id, box: h("input", { type: "checkbox", checked: chosen.includes(i.id) }), label: `${i.emoji ? `${i.emoji} ` : ""}${i.name}` }));
	const save = async () => {
		const agents = boxes.filter((b) => b.box.checked).map((b) => b.id);
		if (agents.length < 2) return toast("Scegli almeno due agenti", true);
		try {
			await onSave(input.value, agents);
			dialog.close();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog",
		h("h2", title),
		h("label.field", h("span", "Nome"), input, h("small", "Se lo lasci vuoto, il canale prende i nomi degli agenti.")),
		h("div.field", h("span", "Agenti (da 2 a 5)"), boxes.map((b) => h("label.row-gap", b.box, h("span", b.label)))),
		h("div.actions", h("button.btn.accent", { onclick: save }, okLabel), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	input.focus();
}

/** The person had the canale or thread on screen: the rail stops showing it unread. */
function markRead(roomId) {
	return api(`/api/rooms/${encodeURIComponent(roomId)}/read`, { method: "POST", body: {} })
		.then(refreshConversations)
		.then(renderRail)
		.catch(() => {});
}

/** The artifact panel of the canale on screen (ADR 0112): an agente's HTML pages open there. */
let artifacts;
const fileLink = (instanceId, file) => h("a.file", { href: `/api/instances/${encodeURIComponent(instanceId)}/files/raw?path=${encodeURIComponent(file.path)}` }, h("span.ext", (file.path.split(".").pop() ?? "file").slice(0, 4)), h("span", h("b", file.path.split("/").pop()), file.caption ? h("div.muted", file.caption) : null));

/** A message of a canale or of a thread. `answer`: in the canale, the button that opens its thread; `slot`: where its replies are counted. */
/** A file an agente sent; an HTML page also opens rendered in the panel, the link still downloads it. */
const fileCard = (instanceId, file) => (isHtml(file.path) ? h("div.file-open", fileLink(instanceId, file), h("button.btn.small", { type: "button", onclick: () => void artifacts?.openFile(instanceId, file.path) }, "Apri")) : fileLink(instanceId, file));

function roomMessage(room, entry, answer, slot) {
	if (entry.from === "note") return h("div.room-note", entry.text);
	if (entry.from === "person") return h("div.msg.person", h("div.meta", fmt.time(entry.at)), h("div.body", entry.text), answer ? h("div.msg-actions", answer) : null, slot);
	const agent = room.agents.find((a) => a.instanceId === entry.instanceId);
	const by = entry.model ? h("span.by", { title: `${entry.model.provider} · ${entry.model.modelId}` }, entry.model.name ?? entry.model.modelId) : null;
	// Each agente's name in the colour of its face, so that who is speaking reads at a glance.
	const who = h("b.who", `${agent?.emoji ? `${agent.emoji} ` : ""}${agent?.name ?? entry.instanceId}`);
	who.style.setProperty("--agent", faceColor(agent ?? { id: entry.instanceId }));
	const actions = entry.text || answer ? h("div.msg-actions", entry.text ? [copyButton(entry.text), listenButton(entry.text)] : null, answer) : null;
	return h("div.msg.owni", h("div.meta", face(agent ?? { id: entry.instanceId }, 20), who, h("span", fmt.time(entry.at)), by), entry.artifact ? artifactCard(entry.instanceId, entry.artifact.threadId, entry.artifact, (a) => void artifacts?.openArtifact(entry.instanceId, entry.artifact.threadId, a))
		: entry.file ? fileCard(entry.instanceId, entry.file)
		: h("div.body", renderMarkdown(entry.text ?? "")), actions, slot);
}

/** Under a message with a thread: who answered, how many replies, the last one. Nothing when none yet. */
function threadSummary(room, thread, open) {
	if (!thread || thread.count === 0) return null;
	const who = thread.who.map((w) => (w === "person" ? h("span.avatar.mini", { "aria-hidden": "true" }, initials(state.me.name)) : face(room.agents.find((a) => a.instanceId === w) ?? { id: w }, 18)));
	const count = thread.count === 1 ? "1 risposta" : `${thread.count} risposte`;
	return h(
		"button.thread-summary",
		{ type: "button", "aria-label": `${count}${thread.unread ? ", non lette" : ""}: apri il thread`, onclick: open },
		h("span.who", who),
		h("b", count),
		thread.lastAt ? h("span.muted", `ultima ${fmt.time(thread.lastAt)}`) : null,
		thread.unread ? h("span.dot", { "aria-hidden": "true" }) : null,
	);
}

/**
 * The box of a canale or a thread: @nome chips for its agenti, their skills, a message that goes to
 * the agenti it calls. `send(text)` posts it; the box keeps the draft until it is sent.
 */
function roomBox(room, send) {
	const present = room.agents.filter((a) => a.present);
	const draftKey = `owni.draft.room.${room.id}`;
	const input = h("textarea", { rows: 1, placeholder: `Scrivi, @${present[0]?.handle ?? "nome"} per chiamare un agente…`, "aria-label": "Messaggio", value: store(draftKey) ?? "" });
	const button = h("button.send", { "aria-label": "Invia", disabled: true }, icon("send"));
	const fit = () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
		button.disabled = !input.value.trim();
		store(draftKey, input.value.trim() ? input.value : null);
	};
	const submit = async () => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		fit();
		try {
			await send(text);
		} catch (error) {
			input.value = text;
			fit();
			toast(error.message, true);
		}
	};
	input.addEventListener("input", fit);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void submit();
		}
	});
	button.addEventListener("click", () => void submit());
	// One tap to call an agente: its @name at the start of the message.
	const call = (a) => {
		const handle = `@${a.handle} `;
		if (!input.value.includes(handle.trim())) input.value = `${handle}${input.value}`;
		input.focus();
		fit();
	};
	const chips = h("div.room-agents", room.agents.map((a) => h(`button.chip${a.present ? "" : ".gone"}`, { onclick: () => call(a), disabled: !a.present, title: a.present ? `Chiama ${a.name}` : `${a.name} non è più disponibile` }, face(a, 18), `${a.emoji ? `${a.emoji} ` : ""}${a.name}`)), h("button.chip", { onclick: () => ((input.value = `@tutti ${input.value}`), input.focus(), fit()) }, "@tutti"));
	// Each agente's skills, with its @name: picked from here, a skill reaches the agente that has it.
	const commands = commandMenu(
		input,
		async () => {
			const lists = await Promise.all(present.map((a) => agentCommands(a.instanceId, `@${a.handle} `).then((list) => list.map((c) => ({ ...c, note: `${a.name} · ${c.note}` })))));
			return lists.flat();
		},
		fit,
	);
	const el = h("div.dock", chips, h("div.box", commands, h("div.composer", input, button)));
	return { el, input, fit };
}

async function viewRoom(main, roomId, openId) {
	const { room, entries } = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
	if (!main.isConnected) return;
	void markRead(roomId);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	const typing = thinking(room.agents.filter((a) => a.present));
	// One panel at a time next to the canale: a thread or a page.
	const panel = threadPanel(room, () => void refreshSummaries(), () => artifacts.show(false));
	artifacts = artifactPanel(() => panel.close());
	/** The replies under each message, as the server counts them now. */
	const slots = new Map();
	const children = new Set(entries.flatMap((e) => (e.thread ? [e.thread.id] : [])));
	const openThread = (entry) => void panel.open(entry, slots.get(entry.id)?.threadId);
	const draw = (entry) => {
		if (entry.from === "note" || entry.id === undefined) return roomMessage(room, entry);
		// Under every message: answer it in a thread (ADR 0113), and the thread's replies so far.
		const answer = h("button.listen.reply-thread", { type: "button", title: "Rispondi nel thread", "aria-label": "Rispondi nel thread", onclick: () => openThread(entry) }, icon("thread"));
		const slot = h("div.thread-slot", threadSummary(room, entry.thread, () => openThread(entry)));
		slots.set(entry.id, { el: slot, threadId: entry.thread?.id });
		return roomMessage(room, entry, answer, slot);
	};
	const show = (entry) => transcript.insertBefore(draw(entry), typing.parentNode === transcript ? typing : null);
	const refreshSummaries = async () => {
		const { entries: now } = await api(`/api/rooms/${encodeURIComponent(roomId)}`).catch(() => ({ entries: [] }));
		for (const entry of now) {
			const slot = slots.get(entry.id);
			if (!entry.thread || !slot) continue;
			children.add(entry.thread.id);
			slot.threadId = entry.thread.id;
			mount(slot.el, threadSummary(room, entry.thread, () => openThread(entry)));
		}
	};
	for (const e of entries) show(e);
	state.onRoom = (event) => {
		if (event.roomId === roomId) {
			if (event.entry.from === "person") return true;
			// An answer ends the wait; one that calls another agente starts the next on the server.
			typing.remove();
			show(event.entry);
			// A new page opens by itself when the place next to the canale is free; on a phone it would cover it.
			if (event.entry.artifact && panel.el.hidden && !matchMedia("(max-width: 860px)").matches) void artifacts.openArtifact(event.entry.instanceId, event.entry.artifact.threadId, event.entry.artifact);
			transcript.scrollTop = transcript.scrollHeight;
			void markRead(roomId);
			return true;
		}
		if (panel.onEntry(event)) return true;
		// A reply in a thread not on screen: counted under its message.
		if (event.parent === roomId || children.has(event.roomId)) {
			void refreshSummaries().then(refreshConversations).then(renderRail);
			return true;
		}
		return false;
	};
	const box = roomBox(room, async (text) => {
		const bubble = transcript.insertBefore(roomMessage(room, { from: "person", text, at: new Date().toISOString() }), null);
		transcript.scrollTop = transcript.scrollHeight;
		try {
			const { entry } = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", body: { text } });
			// The message as written down, so a thread can start under it.
			bubble.replaceWith(draw(entry));
		} catch (error) {
			bubble.remove();
			throw error;
		}
		// The dots stay until an agente answers.
		transcript.append(typing);
		transcript.scrollTop = transcript.scrollHeight;
	});
	const edit = () =>
		channelDialog("Modifica il canale", room.title, room.agents.map((a) => a.instanceId), "Salva", async (title, agents) => {
			await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "PATCH", body: { title, agents } });
			await refreshConversations();
			// Drawn again with its new name and agenti.
			render();
		});
	const remove = () =>
		confirmDialog(`Cancellare il canale ${channelName(room.title)}?`, "Il canale e i suoi thread spariscono per te. Gli agenti non ne terranno traccia nelle loro chat.", "Cancella", async () => {
			try {
				await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
				await refreshConversations();
				location.hash = "#/";
			} catch (error) {
				toast(error.message, true);
			}
		});
	const header = h(
		"div.room-head",
		windowDrag(),
		h("span.room-faces", room.agents.slice(0, 3).map((a) => face(a, 26))),
		h("div.room-head-text", h("b", channelName(room.title)), h("small", room.agents.map((a) => (a.present ? a.name : `${a.name} (non c'è più)`)).join(", "))),
		h("button.icon-btn", { onclick: edit, title: "Modifica nome e agenti", "aria-label": `Modifica il canale ${channelName(room.title)}` }, icon("edit")),
		h("button.icon-btn.room-remove", { onclick: remove, title: "Cancella il canale", "aria-label": `Cancella il canale ${channelName(room.title)}` }, icon("trash")),
	);
	if (entries.length === 0) transcript.append(h("div.room-note", `Nel canale: ${room.agents.map((a) => a.name).join(", ")}. Scrivi @nome per chiamarne uno, @tutti per tutti.`));
	mount(main, h("div.chat-split", h("section.conversation", header, transcript, box.el), panel.el, artifacts.el));
	box.fit();
	transcript.scrollTop = transcript.scrollHeight;
	if (openId !== undefined) {
		const root = entries.find((e) => e.thread?.id === openId);
		if (root) return void panel.open(root, openId);
		history.replaceState(null, "", channelHref(roomId));
		toast("Questo thread non c'è più", true);
	}
	if (!matchMedia("(pointer: coarse)").matches) box.input.focus({ preventScroll: true });
}

/**
 * A thread under one message of a canale (ADR 0113), in the place next to the conversation the
 * browser uses in the direct messages: the message, its replies and a box to answer, with the agenti
 * of the canale. The thread is made on the first open.
 */
function threadPanel(channel, onChange, onShow) {
	const list = h("div.thread-list", { role: "log", "aria-live": "polite" });
	const dock = h("div.thread-dock");
	const el = h(
		"aside.browser-panel.thread-panel",
		{ hidden: true, "aria-label": "Thread" },
		h(
			"div.browser-head",
			h("button.icon-btn.thread-back", { type: "button", title: "Torna al canale", "aria-label": "Torna al canale", onclick: () => close() }, icon("back")),
			icon("thread"),
			h("span.page-title", "Thread"),
			h("button.icon-btn.thread-close", { type: "button", title: "Chiudi", "aria-label": "Chiudi il thread", onclick: () => close() }, icon("close")),
		),
		list,
		dock,
	);
	let current;
	let shown;
	let typing;
	let opening = 0;
	let said = 0;
	let count;
	const counted = (more) => {
		said += more;
		if (count) count.textContent = said === 1 ? "1 risposta" : said ? `${said} risposte` : "Nessuna risposta, per ora";
	};
	const follow = () => { list.scrollTop = list.scrollHeight; };
	const put = (node) => list.insertBefore(node, typing?.parentNode === list ? typing : null);
	/** Closed: the address is the canale's again. */
	const close = () => {
		if (el.hidden) return;
		el.hidden = true;
		current = undefined;
		typing?.remove();
		mount(dock);
		if (route().rest[1] === "t") history.pushState(null, "", channelHref(channel.id));
	};
	const open = async (root, threadId) => {
		const mine = ++opening;
		try {
			const id = threadId ?? (await api(`/api/rooms/${encodeURIComponent(channel.id)}/threads`, { method: "POST", body: { parent: root.id } })).room.id;
			const { room, entries } = await api(`/api/rooms/${encodeURIComponent(id)}`);
			if (mine !== opening || !el.isConnected) return;
			onShow();
			typing?.remove();
			current = id;
			shown = room;
			el.hidden = false;
			mount(list, roomMessage(channel, root));
			said = entries.filter((e) => e.from !== "note").length;
			count = h("div.thread-count");
			list.append(count);
			counted(0);
			for (const entry of entries) put(roomMessage(room, entry));
			typing = thinking(room.agents.filter((a) => a.present));
			const box = roomBox(room, async (text) => {
				const bubble = put(roomMessage(room, { from: "person", text, at: new Date().toISOString() }));
				follow();
				try {
					await api(`/api/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: { text } });
				} catch (error) {
					bubble.remove();
					throw error;
				}
				counted(1);
				list.append(typing);
				follow();
				onChange();
			});
			mount(dock, box.el);
			box.fit();
			if (route().rest[2] !== id) history.pushState(null, "", channelHref(channel.id, id));
			// Read first, then the summary under the message: else it would still say unread.
			void markRead(id).then(onChange);
			follow();
			if (!matchMedia("(pointer: coarse)").matches) box.input.focus({ preventScroll: true });
		} catch (error) {
			if (mine === opening) toast(error.message, true);
		}
	};
	/** A reply in the thread on screen: shown here and read. */
	const onEntry = (event) => {
		if (current === undefined || event.roomId !== current) return false;
		if (event.entry.from === "person") return true;
		typing?.remove();
		put(roomMessage(shown, event.entry));
		if (event.entry.from !== "note") counted(1);
		follow();
		void markRead(current).then(onChange);
		return true;
	};
	return { el, open, close, onEntry };
}
