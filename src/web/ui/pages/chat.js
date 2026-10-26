// Chat page.
import { agentInfoHref, api, batched, channelHref, dmHref, face, faceColor, fmt, h, icon, instanceHref, mount, needInstance, route, state, store, thinking, toast } from "../common.js";
import { boardNote, copyButton, listenButton } from "../listen.js";
import { connectorActionCard, googleActionCard } from "../cards.js";
import { agentCommands, commandMenu } from "../commands.js";
import { chatModelCache, modelPill } from "../models.js";
import { browserPanel } from "../browser-panel.js";
import { screenPanel } from "../screen-panel.js";
import { markRead, meAvatar, threadPanel, threadSummary } from "../threads.js";
import { stepsLeftText } from "../setup.js";
import { install, installed, installOffer } from "../pwa.js";
import { refreshCounters } from "../session.js";
import { conversationRuns } from "../runs.js";
import { renderMarkdown } from "../markdown.js";
import { fillComposer } from "../openui.js";
import { linkPreviews, sources } from "../sources.js";
import { artifactCard, artifactPanel, isHtml } from "../artifacts.js";
import { agentPanel } from "../agent-panel.js";

// ---------- chat ----------
/** A workspace picture shown in the page (not downloaded). */
const pictureUrl = (inst, path) => `/api/instances/${inst.id}/files/raw?path=${encodeURIComponent(path)}&inline=1`;

/** How many messages a conversation draws at first; earlier ones are loaded on request. */
const PAGE = 60;
/** The browser sizes a textarea to its text by itself (CSS field-sizing); older WebKit needs the height measured. */
const FIELD_SIZING = CSS.supports("field-sizing", "content");

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

/**
 * The person's direct conversation with an agente (ADR 0113): one, continuous, made with the first
 * message. Empty, it is the welcome. The chats from before it show in it as messages with replies.
 */
export async function viewDm(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
	if (!inst.canChat) {
		const owner = state.me.role === "owner";
		const note = h("section.conversation.empty-chat", h("div.welcome", h("h2", "Chat non disponibile"), owner
			? h("p", "Aggiungi te stesso alle persone che possono scrivere a questo agente, in ", h("a", { href: instanceHref("impostazioni", ["accessi"], inst.id) }, "Configurazione"), ". Documenti, memoria e procedure sono nel ", h("a", { href: agentInfoHref(inst.id) }, "suo pannello"), ".")
			: h("p", "Non sei tra le persone che possono scrivere a questo agente.")));
		if (!owner) return void mount(main, note);
		// The owner keeps the agente's panel (ADR 0114), next to the note.
		const { agent, artifact } = agentSide(inst);
		mount(main, h("div.chat-split", note, agent.el, artifact.el));
		const { rest } = route();
		if (rest[1] === "info") agent.show(true, rest[2]);
		return;
	}
	chatModelCache.clear();
	let { thread, entries, model } = await api(`/api/instances/${inst.id}/dm`);
	if (!main.isConnected || state.instance !== inst) return;
	// `#/dm/<agente>/t/<thread>`: a thread open next to the conversation.
	// `#/dm/<agente>/info/<sezione>`: the agente's panel open next to it (ADR 0114).
	const { rest } = route();
	const open = rest[1] === "t" ? rest[2] : undefined;
	const info = rest[1] === "info";
	if (entries.length === 0) {
		const view = landing(inst, main, thread, model);
		if (info) view.agent.show(true, rest[2]);
		if (open !== undefined) await elsewhere(inst, main, open, thread?.id);
		return;
	}
	// Only chats from before so far: the conversation that goes on under them.
	thread ??= (await api(`/api/instances/${inst.id}/dm`, { method: "POST", body: {} })).thread;
	if (!main.isConnected || state.instance !== inst) return;
	const view = conversationView(inst, main, thread, entries, model);
	if (info) view.agent.show(true, rest[2]);
	if (open === undefined) return;
	const root = entries.find((e) => e.thread?.id === open);
	if (root !== undefined) return void view.openThread(root, open);
	await elsewhere(inst, main, open, thread.id);
}

/**
 * A thread in the address that is not one of the conversation's. A link from the work done (a run, a
 * scheda) may name the agente's place in a canale, or a chat nothing was written in yet: the canale,
 * or just the conversation. Not there at all (another person's, deleted): said.
 */
async function elsewhere(inst, main, open, dmId) {
	history.replaceState(null, "", dmHref(inst.id));
	if (open === dmId) return;
	const there = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(open)}`).catch(() => undefined);
	if (!main.isConnected) return;
	if (there === undefined) return toast("Questo thread non c'è più", true);
	if (there.thread.room === undefined) return;
	const { room } = await api(`/api/rooms/${encodeURIComponent(there.thread.room)}`).catch(() => ({}));
	if (main.isConnected && room !== undefined) location.replace(room.parent ? channelHref(room.parent.roomId, room.id) : channelHref(room.id));
}

/** The person had the conversation on screen: the rail stops showing it unread. */
const read = (inst, threadId) => markRead(`${inst.id}/${threadId}`, `/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/read`);

/**
 * The agente's panel and the artifact panel its pages open in, next to a conversation, with the
 * address kept: `#/dm/<agente>/info/<sezione>` while it is open. A page opened from the panel goes
 * back to it when closed. `others()`: the page's other panels, closed when one of these opens.
 */
function agentSide(inst, others = () => []) {
	const context = document.querySelector(".agent-context");
	let fromPanel = false;
	let switching = false;
	const only = (keep) => {
		switching = true;
		for (const panel of [agent, artifact, ...others()]) if (panel !== keep) panel.show(false);
		switching = false;
	};
	const agent = agentPanel(inst, {
		onShow: (section) => {
			only(agent);
			context?.setAttribute("aria-expanded", "true");
			const href = agentInfoHref(inst.id, section);
			if (location.hash !== href) history[route().rest[1] === "info" ? "replaceState" : "pushState"](null, "", href);
		},
		// Closed by the person: a step of its own, so Back opens it again, as for a thread. Closed
		// because another panel opened: that panel writes the address.
		onHide: () => {
			context?.setAttribute("aria-expanded", "false");
			if (route().rest[1] === "info") history[switching ? "replaceState" : "pushState"](null, "", dmHref(inst.id));
		},
		openArtifact: (threadId, page) => { void artifact.openArtifact(inst.id, threadId, page); fromPanel = true; },
		openFile: (path) => { artifact.openFile(inst.id, path); fromPanel = true; },
	});
	const artifact = artifactPanel(() => { fromPanel = false; only(artifact); }, () => {
		if (fromPanel && !switching) agent.show(true);
		fromPanel = false;
	});
	// The agente's name over the conversation opens its panel, and closes it.
	if (context) {
		context.setAttribute("aria-controls", "agent-panel");
		context.setAttribute("aria-expanded", "false");
		context.onclick = (event) => {
			if (event.metaKey || event.ctrlKey || event.shiftKey) return;
			event.preventDefault();
			agent.show(!agent.isOpen());
		};
	}
	agent.el.id = "agent-panel";
	return { agent, artifact, only };
}

function conversationView(inst, main, thread, entries, model) {
	const threadId = thread.id;
	const conversation = h("section.conversation");
	// One panel at a time next to the chat, also when one opens by itself.
	const { agent, artifact, only } = agentSide(inst, () => [browser, screen, replies]);
	const browser = browserPanel(inst, threadId, () => only(browser));
	const screen = screenPanel(inst, threadId, () => only(screen));
	const replies = chatThreads(inst, (entry, into, where) => show(entry, into, false, where), () => only(replies), () => void refreshSummaries());
	mount(main, h("div.chat-split", conversation, browser.el, screen.el, replies.el, agent.el, artifact.el));
	read(inst, threadId);
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
	// An HTML page the agente sent opens rendered in the panel, like an artifact; the link still downloads it.
	const fileCard = (file) => (isHtml(file.path) ? h("div.file-open", fileLink(file), h("button.btn.small", { type: "button", onclick: () => artifact.openFile(inst.id, file.path) }, "Apri")) : fileLink(file));
	// `into`: where the message goes, the conversation by default or the thread panel; `where`: the
	// thread it was written in, whose artifacts it shows.
	const show = (entry, into = place, here = into === place, where = entry.threadId ?? threadId) => {
		// What the board sends the agente reads as a scheda, not as a wall of instructions the person never typed.
		const brief = entry.from === "person" ? boardNote(entry) : null;
		if (brief) {
			into(brief);
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
			: entry.artifact
			? artifactCard(inst.id, where, entry.artifact, (a) => void artifact.openArtifact(inst.id, where, a))
			: entry.file
			? fileCard(entry.file)
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
		// In the conversation, under every message: answer it in a thread (ADR 0113), and the thread's replies so far.
		const threaded = here && entry.id !== undefined;
		const answer = threaded ? h("button.listen.reply-thread", { type: "button", title: "Rispondi nel thread", "aria-label": "Rispondi nel thread", onclick: () => void replies.open(entry, entry.thread?.id) }, icon("thread")) : null;
		// Under an answer, on hover (always on touch): copy it, listen to it.
		const actions = entry.from === "owni" && entry.text ? h("div.msg-actions", copyButton(entry.text), listen, answer) : answer ? h("div.msg-actions", answer) : null;
		// Which model wrote the reply: the chat's own, or the instance's when that could not answer.
		const by = entry.model ? h("span.by", { title: `${entry.model.provider} · ${entry.model.modelId}` }, entry.model.name ?? entry.model.modelId) : null;
		const slot = threaded ? h("div.thread-slot", summary(inst, entry, () => void replies.open(entry, entry.thread?.id))) : null;
		if (slot) summaries.set(entry.id, slot);
		const el = h(`div.msg.${entry.from}`, h("div.meta", entry.from === "owni" ? [face(inst, 20), h("b.who", inst.name)] : null, fmt.time(entry.at), by), pictures, entry.text || entry.file || !pictures ? body : null, actions, slot);
		into(el);
		return el;
	};
	/** The replies under each message, as the server counts them now. */
	const summaries = new Map();
	const known = new Set(entries.flatMap((e) => (e.thread ? [e.thread.id] : [])));
	const refreshSummaries = batched(async () => {
		const { entries: now } = await api(`/api/instances/${inst.id}/dm`).catch(() => ({ entries: [] }));
		for (const entry of now) {
			const slot = summaries.get(entry.id);
			if (!entry.thread || !slot) continue;
			known.add(entry.thread.id);
			mount(slot, summary(inst, entry, () => void replies.open(entry, entry.thread.id)));
			// Its reply button opens the same thread from now on.
			const button = slot.parentElement?.querySelector(".reply-thread");
			if (button) button.onclick = () => void replies.open(entry, entry.thread.id);
		}
	});
	// The last PAGE messages; the earlier ones come on request, above, without moving what is being read.
	let from = Math.max(0, entries.length - PAGE);
	const older = h("button.btn.small.older", { type: "button", hidden: from === 0, onclick: () => {
		const before = transcript.scrollHeight;
		const anchor = older.nextSibling;
		const start = Math.max(0, from - PAGE);
		for (const e of entries.slice(start, from)) show(e, (el) => transcript.insertBefore(el, anchor));
		from = start;
		older.hidden = from === 0;
		transcript.scrollTo({ top: transcript.scrollTop + transcript.scrollHeight - before, behavior: "instant" });
	} }, "Carica messaggi precedenti");
	transcript.append(older);
	for (const e of entries.slice(from)) show(e);
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
		if (event.threadId !== threadId) {
			if (replies.onEntry(event)) return true;
			// A reply in a thread not on screen: counted under its message, and announced.
			if (event.instanceId === inst.id && known.has(event.threadId)) void refreshSummaries();
			return false;
		}
		stopTyping();
		show(event.entry);
		// A new page or version opens by itself while the conversation is on screen, unless a thread,
		// the browser or the screen is open there; on a phone it would cover the chat. The card opens it.
		const busy = [browser.el, screen.el, replies.el, agent.el].some((panel) => !panel.hidden);
		if (event.entry.artifact && !busy && !matchMedia("(max-width: 860px)").matches) void artifact.openArtifact(inst.id, threadId, event.entry.artifact);
		if (event.entry.from === "owni") void drawAsks();
		browser.lively();
		screen.lively();
		follow();
		read(inst, threadId);
		return true;
	};
	const box = chatBox(inst, threadId, conversation, async (text, images) => {
		browser.lively();
		screen.lively();
		const bubble = show({ from: "person", text, images, at: new Date().toISOString() });
		startTyping();
		try {
			const { entry } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", body: images.length ? { text, images } : { text } });
			// The message as written down, so a thread can start under it.
			show(entry, (el) => bubble.replaceWith(el), true);
			void work.refresh();
		} catch (error) {
			stopTyping();
			bubble.remove();
			throw error;
		}
	}, modelPill(inst, model, async (picked) => {
		await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(threadId)}/model`, { method: "PUT", body: picked ? { provider: picked.provider, modelId: picked.modelId } : {} });
	}));
	conversation.append(transcript, h("div.dock", asks, box.el));
	transcript.addEventListener("openui-action", (event) => fillComposer(box.input, event.detail.text));
	transcript.scrollTop = transcript.scrollHeight;
	// A message written on the empty chat: sent as soon as its conversation opens.
	if (main.isConnected && store(`owni.autosend.${threadId}`) === "1") {
		store(`owni.autosend.${threadId}`, null);
		void box.submit();
	}
	// Opening a conversation to read it must not summon the phone's keyboard.
	if (!matchMedia("(pointer: coarse)").matches) box.input.focus({ preventScroll: true });
	return { openThread: replies.open, agent };
}

/** Under a message with a thread: who answered, how many replies, the last one. Nothing when none yet. */
const summary = (inst, entry, open) => threadSummary(entry.thread, (w) => (w === "owni" ? face(inst, 18) : meAvatar()), open);

/**
 * A thread under one message (ADR 0113): the message, its replies and a box to answer. The thread is
 * made on the first open; a chat from before opens here whole. `render(entry, into, where)` draws a
 * message the conversation's way, `where` being the thread it is in.
 */
function chatThreads(inst, render, onShow, onChange) {
	const panel = threadPanel({
		back: "Torna alla conversazione",
		home: () => dmHref(inst.id),
		at: (id) => dmHref(inst.id, id),
		read: (id) => read(inst, id),
		load: async (root, threadId) => {
			const id = threadId ?? (await api(`/api/instances/${inst.id}/threads`, { method: "POST", body: { parent: root.id } })).thread.id;
			const { thread, entries } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(id)}`);
			return { id, entries, said: entries.length, counted: Boolean(thread.parent), title: thread.parent ? undefined : thread.title };
		},
		drawRoot: (root, put) => render(root, put),
		draw: (entry, put, id) => render(entry, put, id),
		box: (id, ctx) => chatBox(inst, id, panel.el, async (text, images) => {
			const bubble = render({ from: "person", text, images, at: new Date().toISOString() }, ctx.put);
			ctx.stopTyping();
			ctx.typing = thinking([inst]);
			ctx.list.append(ctx.typing);
			ctx.follow();
			try {
				const { entry } = await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(id)}/messages`, { method: "POST", body: images.length ? { text, images } : { text } });
				render(entry, (node) => bubble.replaceWith(node), id);
				ctx.counted(1);
				onChange();
			} catch (error) {
				ctx.stopTyping();
				bubble.remove();
				throw error;
			}
		}),
	}, onShow, onChange);
	/** A reply in the thread on screen: shown here and read. */
	const onEntry = (event) => {
		const current = panel.current();
		if (current === undefined || event.threadId !== current) return false;
		panel.stopTyping();
		render(event.entry, panel.put, current);
		panel.counted(1);
		panel.follow();
		void read(inst, current).then(onChange);
		return true;
	};
	return { ...panel, onEntry };
}

/**
 * The empty direct conversation: a greeting, the box in the middle and a few ideas. The first message
 * makes the conversation (with the model picked here) and is sent as soon as it shows.
 */
function landing(inst, main, thread, model) {
	const conversation = h("section.conversation.empty-chat");
	const { agent, artifact } = agentSide(inst);
	mount(main, h("div.chat-split", conversation, agent.el, artifact.el));
	let picked = model;
	const box = chatBox(inst, `new.${inst.id}`, conversation, async (text, images) => {
		const made = thread ?? (await api(`/api/instances/${inst.id}/dm`, { method: "POST", body: picked ? { model: { provider: picked.provider, modelId: picked.modelId } } : {} })).thread;
		store(`owni.draft.${made.id}`, text);
		if (images.length) store(`owni.pending.${made.id}`, JSON.stringify(images));
		store(`owni.autosend.${made.id}`, "1");
		if (!main.isConnected) return;
		const view = conversationView(inst, main, made, [], picked);
		if (agent.isOpen()) view.agent.show(true, agent.section());
	}, modelPill(inst, model, async (choice) => {
		picked = choice;
		if (thread) await api(`/api/instances/${inst.id}/threads/${encodeURIComponent(thread.id)}/model`, { method: "PUT", body: choice ? { provider: choice.provider, modelId: choice.modelId } : {} });
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
			state.setupLeft > 0 && state.setup && !state.setup.model && !state.setup.tried ? h("p.aside", h("a", { href: "#/inizia" }, stepsLeftText(state.setupLeft))) : null,
			state.me.role !== "owner" && installOffer && !installed() ? h("p.aside", h("button.btn.small.ghost", { onclick: install }, icon("install"), "Installa Owni come app")) : null,
		),
	);
	box.input.focus();
	return { agent };
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
	// field-sizing grows the box by itself; the height is measured only where it is missing.
	const fit = () => {
		if (FIELD_SIZING) return;
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

