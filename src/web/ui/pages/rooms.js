// Stanze pages.
import { api, confirmDialog, emptyNote, face, faceColor, fmt, go, h, head, icon, mount, route, state, store, thinking, toast } from "../common.js";
import { agentCommands, commandMenu } from "../commands.js";

// ---------- stanze (ADR 0063) ----------
export async function viewRooms(main) {
	const roomId = route().rest[0] === "nuova" ? undefined : route().rest[0];
	if (roomId) return viewRoom(main, roomId);
	const { rooms } = await api("/api/rooms");
	const chatty = state.instances.filter((i) => i.canChat);
	const form = h("div.card.pad.stack", { hidden: true });
	const create = () => {
		const title = h("input", { type: "text", maxlength: 80, placeholder: "Es. Bando regionale" });
		const boxes = chatty.map((i) => ({ id: i.id, box: h("input", { type: "checkbox" }), label: `${i.emoji ? `${i.emoji} ` : ""}${i.name}` }));
		const save = async () => {
			const agents = boxes.filter((b) => b.box.checked).map((b) => b.id);
			if (agents.length < 2) return toast("Scegli almeno due agenti", true);
			try {
				const { room } = await api("/api/rooms", { method: "POST", body: { title: title.value, agents } });
				go("stanze", room.id);
			} catch (error) {
				toast(error.message, true);
			}
		};
		mount(
			form,
			h("h2", "Nuova conversazione con più agenti"),
			h("label.field", h("span", "Nome"), title, h("small", "Se lo lasci vuoto, la stanza prende i nomi degli agenti.")),
			h("div.field", h("span", "Agenti (da 2 a 5)"), boxes.map((b) => h("label.row-gap", b.box, h("span", b.label)))),
			h("div.actions", h("button.btn.accent", { onclick: save }, "Crea"), h("button.btn.ghost", { onclick: () => (form.hidden = true) }, "Annulla")),
		);
		form.hidden = false;
		title.focus();
	};
	const names = (r) => r.agents.map((a) => `${a.emoji ? `${a.emoji} ` : ""}${a.name}`).join(", ");
	mount(
		main,
		head(null, h("h1", "Conversazioni con più agenti"), "Una conversazione con più agenti insieme. Scrivi @nome per chiamarne uno, @tutti per tutti; senza nome risponde l'ultimo che ha parlato. Un agente può chiamare in causa un altro. Le stanze sono solo tue.", chatty.length > 1 ? h("button.btn.accent", { onclick: create }, icon("plus"), "Nuova conversazione con più agenti") : null),
		h(
			"div.stack",
			form,
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
										{ href: `#/stanze/${encodeURIComponent(r.id)}` },
										// The faces of who is in it, overlapping like a group chat.
										h("span.room-faces", r.agents.slice(0, 3).map((a) => face(a, 30))),
										h("span.room-text", h("span.room-title", h("b", r.title), h("span.muted", names(r))), r.last ? h("span.room-last", h("b", `${r.last.who}: `), r.last.text) : null),
										h("time.room-when", { datetime: r.updatedAt, title: fmt.time(r.updatedAt) }, fmt.short(r.updatedAt)),
									),
								),
							),
						)
					: emptyNote("div.empty", "Nessuna stanza", "Per esempio il ricercatore trova un bando, l'agente delle vendite prepara l'offerta e il contabile fa i conti, tutti nella stessa conversazione."),
			),
		),
	);
	if (route().rest[0] === "nuova" && chatty.length > 1) create();
}

async function viewRoom(main, roomId) {
	const { room, entries } = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
	if (!main.isConnected) return;
	const agentOf = (id) => room.agents.find((a) => a.instanceId === id);
	const transcript = h("div.transcript", { role: "log", "aria-live": "polite" });
	const fileLink = (instanceId, file) => h("a.file", { href: `/api/instances/${encodeURIComponent(instanceId)}/files/raw?path=${encodeURIComponent(file.path)}` }, h("span.ext", (file.path.split(".").pop() ?? "file").slice(0, 4)), h("span", h("b", file.path.split("/").pop()), file.caption ? h("div.muted", file.caption) : null));
	const typing = thinking(room.agents.filter((a) => a.present));
	const show = (entry) => {
		if (entry.from === "note") return transcript.append(h("div.room-note", entry.text));
		if (entry.from === "person") return transcript.append(h("div.msg.person", h("div.meta", fmt.time(entry.at)), h("div.body", entry.text)));
		const agent = agentOf(entry.instanceId);
		const by = entry.model ? h("span.by", { title: `${entry.model.provider} · ${entry.model.modelId}` }, entry.model.name ?? entry.model.modelId) : null;
		// Each agente's name in the colour of its face, so that who is speaking reads at a glance.
		const who = h("b.who", `${agent?.emoji ? `${agent.emoji} ` : ""}${agent?.name ?? entry.instanceId}`);
		who.style.setProperty("--agent", faceColor(agent ?? { id: entry.instanceId }));
		transcript.append(h("div.msg.annie", h("div.meta", face(agent ?? { id: entry.instanceId }, 20), who, h("span", fmt.time(entry.at)), by), entry.file ? fileLink(entry.instanceId, entry.file) : h("div.body", entry.text ?? "")));
	};
	for (const e of entries) show(e);
	state.onRoom = (event) => {
		if (event.roomId !== roomId) return false;
		if (event.entry.from === "person") return true;
		// An answer ends the wait; one that calls another agente starts the next on the server.
		typing.remove();
		show(event.entry);
		transcript.scrollTop = transcript.scrollHeight;
		return true;
	};
	const present = room.agents.filter((a) => a.present);
	// What was being written stays, like in a chat, until it is sent.
	const draftKey = `annie.draft.room.${roomId}`;
	const input = h("textarea", { rows: 1, placeholder: `Scrivi alla stanza, @${present[0]?.handle ?? "nome"} per chiamare un agente…`, "aria-label": "Messaggio", value: store(draftKey) ?? "" });
	const send = h("button.send", { "aria-label": "Invia", disabled: true }, icon("send"));
	const fit = () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
		send.disabled = !input.value.trim();
		store(draftKey, input.value.trim() ? input.value : null);
	};
	const submit = async () => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		fit();
		show({ from: "person", text, at: new Date().toISOString() });
		transcript.scrollTop = transcript.scrollHeight;
		try {
			await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", body: { text } });
			// The dots stay until an agente answers.
			transcript.append(typing);
			transcript.scrollTop = transcript.scrollHeight;
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
	send.addEventListener("click", () => void submit());
	// One tap to call an agente: its @name at the start of the message.
	const call = (a) => {
		const handle = `@${a.handle} `;
		if (!input.value.includes(handle.trim())) input.value = `${handle}${input.value}`;
		input.focus();
		fit();
	};
	const chips = h("div.room-agents", room.agents.map((a) => h(`button.chip${a.present ? "" : ".gone"}`, { onclick: () => call(a), disabled: !a.present, title: a.present ? `Chiama ${a.name}` : `${a.name} non è più disponibile` }, face(a, 18), `${a.emoji ? `${a.emoji} ` : ""}${a.name}`)), h("button.chip", { onclick: () => ((input.value = `@tutti ${input.value}`), input.focus(), fit()) }, "@tutti"));
	const remove = () =>
		confirmDialog(`Cancellare la stanza «${room.title}»?`, "La conversazione sparisce per te. Gli agenti non ne terranno traccia nelle loro chat.", "Cancella", async () => {
			try {
				await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
				go("stanze");
			} catch (error) {
				toast(error.message, true);
			}
		});
	const header = h(
		"div.room-head",
		h("a.icon-btn", { href: "#/stanze", "aria-label": "Tutte le stanze" }, icon("back")),
		h("span.room-faces", room.agents.slice(0, 3).map((a) => face(a, 26))),
		h("div.room-head-text", h("b", room.title), h("small", room.agents.map((a) => (a.present ? a.name : `${a.name} (non c'è più)`)).join(", "))),
		h("button.icon-btn.room-remove", { onclick: remove, title: "Cancella la stanza", "aria-label": `Cancella la stanza «${room.title}»` }, icon("trash")),
	);
	if (entries.length === 0) transcript.append(h("div.room-note", `Nella stanza: ${room.agents.map((a) => a.name).join(", ")}. Scrivi @nome per chiamarne uno, @tutti per tutti.`));
	// Each agente's skills, with its @name: picked from here, a skill reaches the agente that has it.
	const commands = commandMenu(
		input,
		async () => {
			const lists = await Promise.all(present.map((a) => agentCommands(a.instanceId, `@${a.handle} `).then((list) => list.map((c) => ({ ...c, note: `${a.name} · ${c.note}` })))));
			return lists.flat();
		},
		fit,
	);
	mount(main, h("section.conversation", header, transcript, h("div.dock", chips, h("div.box", commands, h("div.composer", input, send)))));
	fit();
	transcript.scrollTop = transcript.scrollHeight;
	input.focus();
}

