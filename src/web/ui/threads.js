// Threads (ADR 0113), as the direct chat and the canali share them: the read mark, the summary under a message, the panel next to the conversation.
import { api, fmt, h, icon, initials, mount, route, state, toast, whenSeen } from "./common.js";
import { fillComposer } from "./openui.js";
import { refreshConversations, renderRail } from "./shell.js";

/** The person had the conversation on screen: the rail stops showing it unread. `key`: what was seen; `url`: the read mark. */
export function markRead(key, url) {
	return whenSeen(key, () => api(url, { method: "POST", body: {} }))
		.then(refreshConversations)
		.then(renderRail)
		.catch(() => {});
}

/** The signed-in person's mark, among the avatars of a thread. */
export const meAvatar = () => h("span.avatar.mini", { "aria-hidden": "true" }, initials(state.me.name));

/** Under a message with a thread: who answered, how many replies, the last one. Nothing when none yet. `avatar(who)`: one answerer's mark. */
export function threadSummary(thread, avatar, open) {
	if (!thread || thread.count === 0) return null;
	const count = thread.count === 1 ? "1 risposta" : `${thread.count} risposte`;
	return h(
		"button.thread-summary",
		{ type: "button", "aria-label": `${count}${thread.unread ? ", non lette" : ""}: apri il thread`, onclick: open },
		h("span.who", thread.who.map(avatar)),
		h("b", count),
		thread.lastAt ? h("span.muted", `ultima ${fmt.time(thread.lastAt)}`) : null,
		thread.unread ? h("span.dot", { "aria-hidden": "true" }) : null,
	);
}

/**
 * A thread under one message, in the place next to the conversation the browser and the screen use:
 * the message, its replies and a box to answer. The thread is made on the first open. The page says
 * what is its own:
 * - `back`: the label of the way back; `home()`, `at(id)`: the addresses of the conversation and of the thread;
 * - `read(id)`: marks the thread read;
 * - `load(root, threadId)`: makes the thread if needed and fetches it: `{ id, entries, said, title?, counted }`;
 * - `drawRoot(root, put)`, `draw(entry, put, id)`: put a message in the list, `put(node)` giving back the node;
 * - `box(id, ctx)`: the box to answer, `ctx` holding the panel's list, `put`, `follow`, `counted`, `stopTyping` and `typing` (to set).
 * It gives back `current()`, the thread on screen, and the helpers the page's `onEntry` needs.
 */
export function threadPanel(page, onShow, onChange) {
	const title = h("span.page-title", "Thread");
	const list = h("div.thread-list", { role: "log", "aria-live": "polite" });
	const dock = h("div.thread-dock");
	// A click in an interactive answer of the open thread: written in its box.
	let input = null;
	list.addEventListener("openui-action", (event) => input && fillComposer(input, event.detail.text));
	const el = h(
		"aside.browser-panel.thread-panel",
		{ hidden: true, "aria-label": "Thread" },
		h(
			"div.browser-head",
			h("button.icon-btn.thread-back", { type: "button", title: page.back, "aria-label": page.back, onclick: () => show(false) }, icon("back")),
			icon("thread"),
			title,
			h("button.icon-btn.thread-close", { type: "button", title: "Chiudi", "aria-label": "Chiudi il thread", onclick: () => show(false) }, icon("close")),
		),
		list,
		dock,
	);
	let current;
	let typing;
	let opening = 0;
	// Under the message, how many replies the thread has.
	let said = 0;
	let count;
	const counted = (more) => {
		said += more;
		if (count) count.textContent = said === 1 ? "1 risposta" : said ? `${said} risposte` : "Nessuna risposta, per ora";
	};
	const follow = () => { list.scrollTop = list.scrollHeight; };
	const stopTyping = () => typing?.remove();
	const put = (node) => list.insertBefore(node, typing?.parentNode === list ? typing : null);
	const ctx = {
		list,
		put,
		follow,
		counted,
		stopTyping,
		get typing() { return typing; },
		set typing(node) { typing = node; },
	};
	/** Closed: the address is the conversation's again. */
	const show = (on) => {
		if (on || el.hidden) return;
		el.hidden = true;
		current = undefined;
		// An open still on its way stays closed.
		opening++;
		stopTyping();
		mount(dock);
		if (route().rest[1] === "t") history.pushState(null, "", page.home());
	};
	const open = async (root, threadId) => {
		const mine = ++opening;
		try {
			const view = await page.load(root, threadId);
			const { id } = view;
			if (mine !== opening || !el.isConnected) return;
			onShow();
			stopTyping();
			current = id;
			el.hidden = false;
			title.textContent = view.title ?? "Thread";
			mount(list);
			// Under a message of the conversation: that message first. A chat from before starts with its own.
			said = view.said;
			count = view.counted ? h("div.thread-count") : undefined;
			if (count) {
				page.drawRoot(root, put);
				list.append(count);
				counted(0);
			}
			for (const entry of view.entries) page.draw(entry, put, id);
			const box = page.box(id, ctx);
			mount(dock, box.el);
			input = box.input;
			box.fit?.();
			if (route().rest[2] !== id) history.pushState(null, "", page.at(id));
			// Read first, then the summary under the message: else it would still say unread.
			void page.read(id).then(onChange);
			follow();
			if (!matchMedia("(pointer: coarse)").matches) box.input.focus({ preventScroll: true });
		} catch (error) {
			if (mine === opening) toast(error.message, true);
		}
	};
	return { el, show, open, current: () => current, put, follow, counted, stopTyping };
}
