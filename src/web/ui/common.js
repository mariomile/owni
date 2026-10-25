// Helpers, API client, state and routing shared by every page of the console.

export const $app = document.getElementById("app");

const $toasts = document.getElementById("toasts");

/**
 * el.replaceChildren with h()'s rules: null, false and undefined add nothing (not the text "null"),
 * and lists are flattened, so views can pass optional parts and sections as they are.
 */
export function mount(el, ...children) {
	el.replaceChildren(...children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false));
}

/** h("div.card.pad", { onclick }, "text", child) — safe DOM builder. */
export function h(spec, attrs, ...children) {
	const [tag, ...classes] = spec.split(".");
	const el = document.createElement(tag || "div");
	if (classes.length) el.className = classes.join(" ");
	if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
		children.unshift(attrs);
		attrs = undefined;
	}
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "class") el.className += ` ${v}`;
		else if (k === "value") el.value = v;
		else if (k === "checked") el.checked = Boolean(v);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const child of children.flat(Infinity)) {
		if (child === undefined || child === null || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return el;
}

const ICONS = {
	inizia: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
	install: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
	upload: ["M12 21V9", "m7 14 5-5 5 5", "M5 3h14"],
	image: ["M4 5h16v14H4Z", "m4 16 5-5 4 4 3-3 4 4", "M15 9h.01"],
	spark: ["M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7Z", "M19 15c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z"],
	listen: ["M4 9v6h4l5 4V5L8 9H4Z", "M16.5 8.5a5 5 0 0 1 0 7", "M19 6a8.5 8.5 0 0 1 0 12"],
	stop: ["M7 7h10v10H7Z"],
	chat: ["M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12Z"],
	dm: ["M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12Z"],
	canali: ["M10 4 8 20M16 4l-2 16M5 9h15M4 15h15"],
	thread: ["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 6 6v4"],
	board: ["M4 5h4v14H4Z", "M10 5h4v9h-4Z", "M16 5h4v6h-4Z"],
	agenti: ["M8 4h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z", "M9.5 9.5h.01M14.5 9.5h.01", "M9 20h6", "M12 16v4"],
	segreteria: ["M3 13h5l1.5 2.5h5L16 13h5", "M5.5 5h13L21 13v6H3v-6Z"],
	approvazioni: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "m8.5 12.5 2.5 2.5 4.5-5"],
	task: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7.5V12l3 2"],
	file: ["M14 3H6v18h12V7Z", "M14 3v4h4"],
	memoria: ["M12 4a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5.2V16a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-1.8A3 3 0 0 0 16 9V8a4 4 0 0 0-4-4Z", "M12 4v16"],
	automazioni: ["M13 3 5 14h6l-1 7 8-11h-6Z"],
	stanze: ["M8 10h.01M12 10h.01M16 10h.01", "M21 11a8 8 0 0 1-11.5 7.2L4 20l1.4-4.6A8 8 0 1 1 21 11Z"],
	skill: ["M5 4h10l4 4v12H5Z", "M9 12h6M9 16h4", "M14 4v4h4"],
	connettori: ["M9 3v5M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0Z", "M12 17v4"],
	impostazioni: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M15 5v4M9 15v4"],
	persone: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M2.5 21a6.5 6.5 0 0 1 13 0", "M16 3.6a4 4 0 0 1 0 6.8", "M18.5 14.5A6.5 6.5 0 0 1 21.5 21"],
	attivita: ["M3 12h4l3-8 4 16 3-8h4"],
	lavori: ["M4 5h16v15H4Z", "M8 3v4M16 3v4M8 11h8M8 15h5"],
	programmi: ["M13 3 5 14h6l-1 7 8-11h-6Z"],
	agente: ["M8 4h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z", "M9.5 9.5h.01M14.5 9.5h.01", "M9 20h6"],
	gestione: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M15 5v4M9 15v4"],
	search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
	theme: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 3v18", "M12 7h4.5M12 11h6M12 15h5.5"],
	logout: ["M14 4h5v16h-5", "M9.5 8 5.5 12l4 4", "M5.5 12H15"],
	menu: ["M4 7h16M4 12h16M4 17h16"],
	plus: ["M12 5v14M5 12h14"],
	down: ["m6 9 6 6 6-6"],
	chevron: ["m9 6 6 6-6 6"],
	check: ["m5 12.5 4.5 4.5L19 7"],
	alert: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7.5v5.5", "M12 16.5h.01"],
	compose: ["M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6", "M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"],
	sidebar: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M9.5 4v16"],
	attach: ["m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"],
	send: ["M12 19V5", "m6 11 6-6 6 6"],
	more: ["M6 12h.01M12 12h.01M18 12h.01"],
	account: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0"],
	screen: ["M3 4h18v12H3Z", "M8 20h8", "M12 16v4"],
	browser: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M3 12h18", "M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z"],
	back: ["M19 12H5", "m11 6-6 6 6 6"],
	close: ["M6 6l12 12M18 6 6 18"],
	copy: ["M9 9h10v10H9Z", "M5 15V5h10"],
	edit: ["M4 20h4L19 9l-4-4L4 16v4Z", "m13.5 6.5 4 4"],
	trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13", "M10 11v6M14 11v6"],
	plane: ["M21 3 3 10.5l7 2.5 2.5 7Z", "m10 13 4.5-4.5"],
	phone: ["M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4Z"],
};

/** Inline stroke icon from the fixed table above (no markup from outside). */
export function icon(name) {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) svg.setAttribute(k, v);
	for (const d of ICONS[name] ?? []) {
		const path = document.createElementNS(NS, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

// ---------- agent faces ----------
// Every agente has a face drawn from its id: one family (a soft body, two eyes), told apart by
// colour, shape and one small detail. The face is also how an agente shows it is thinking.
const FACE_COLORS = ["#ff8a65", "#f6c344", "#9be15d", "#3ed6b0", "#5cb8ff", "#8f82ff", "#ff7ab6", "#e2c9a0"];
const FACE_SHAPES = {
	round: { body: ["circle", { cx: 24, cy: 26, r: 17 }], top: 9, eyes: 25 },
	square: { body: ["rect", { x: 7, y: 9, width: 34, height: 34, rx: 12 }], top: 9, eyes: 25 },
	egg: { body: ["path", { d: "M24 8c10 0 17 7.5 17 18S33.5 43 24 43 7 36.5 7 26 14 8 24 8Z" }], top: 8, eyes: 25 },
	wide: { body: ["rect", { x: 5, y: 13, width: 38, height: 29, rx: 14.5 }], top: 13, eyes: 27 },
};

function faceSeed(id) {
	let n = 2166136261;
	for (const c of String(id)) n = Math.imul(n ^ c.codePointAt(0), 16777619);
	// Mixed once more, so ids that differ only at the end still land far apart.
	n = Math.imul(n ^ (n >>> 16), 2246822507);
	n = Math.imul(n ^ (n >>> 13), 3266489909);
	return (n ^ (n >>> 16)) >>> 0;
}

/** The look of an agente: the same id always gives the same face. Owni, the first, stays in the console's own black and white (--face-mono). */
function faceLook(agent) {
	const id = agent?.id ?? agent?.instanceId ?? agent?.name ?? "owni";
	// One hash per trait, so that the traits do not move together.
	const pick = (trait, list) => list[faceSeed(`${id}:${trait}`) % list.length];
	const owni = id === "owni";
	return {
		color: owni ? "var(--face-mono)" : pick("color", FACE_COLORS),
		eye: owni ? "var(--face-mono-eye)" : "#111",
		shape: owni ? "round" : pick("shape", Object.keys(FACE_SHAPES)),
		eyes: owni ? "tall" : pick("eyes", ["dot", "tall", "wide"]),
		extra: owni ? "none" : pick("extra", ["none", "antenna", "cheeks", "brow"]),
		delay: faceSeed(id) % 5000,
	};
}

/** The colour as a CSS value, for what surrounds a face (the glow behind the empty chat). */
export function faceColor(agent) {
	return faceLook(agent).color;
}

/** face(agent, 28) or face(agent, 72, "thinking"): an inline SVG, decorative (the name is always written next to it). */
export function face(agent, size = 28, mood = "idle") {
	const NS = "http://www.w3.org/2000/svg";
	// paint: colours set through CSSOM (the page's CSP refuses style attributes), so Owni's CSS variable works too.
	const el = (tag, attrs = {}, paint = {}) => {
		const node = document.createElementNS(NS, tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
		for (const [k, v] of Object.entries(paint)) node.style.setProperty(k, v);
		return node;
	};
	const look = faceLook(agent);
	const shape = FACE_SHAPES[look.shape];
	const svg = el("svg", { viewBox: "0 0 48 48", width: size, height: size, "aria-hidden": "true", class: `face ${mood}` });
	svg.style.setProperty("--blink-delay", `${look.delay}ms`);
	const shade = "face-shade";
	const defs = el("defs");
	const grad = el("linearGradient", { id: shade, x1: 0, y1: 0, x2: 0, y2: 1 });
	grad.append(el("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": "0.38" }), el("stop", { offset: "0.55", "stop-color": "#fff", "stop-opacity": "0" }));
	defs.append(grad);
	const body = el("g", { class: "face-body" });
	if (look.extra === "antenna") body.append(el("path", { d: `M24 ${shape.top}V${shape.top - 5}`, "stroke-width": 2.4, "stroke-linecap": "round" }, { stroke: look.color }), el("circle", { cx: 24, cy: shape.top - 5.5, r: 2.6 }, { fill: look.color }));
	const [tag, attrs] = shape.body;
	body.append(el(tag, attrs, { fill: look.color }), el(tag, { ...attrs, fill: `url(#${shade})` }), el(tag, { ...attrs, fill: "none", stroke: "rgba(0,0,0,0.08)", "stroke-width": 1 }));
	const y = shape.eyes;
	if (look.extra === "cheeks") body.append(el("circle", { cx: 13.5, cy: y + 7, r: 2.8, fill: "#ff4f73", opacity: 0.5 }), el("circle", { cx: 34.5, cy: y + 7, r: 2.8, fill: "#ff4f73", opacity: 0.5 }));
	if (look.extra === "brow") body.append(el("path", { d: `M14 ${y - 7}q3-2 6 0M28 ${y - 7}q3-2 6 0`, stroke: "#141414", "stroke-width": 1.8, fill: "none", "stroke-linecap": "round", opacity: 0.7 }));
	const eyes = el("g", { class: "face-eyes" });
	for (const x of [17.5, 30.5]) {
		const eye = { fill: look.eye };
		if (look.eyes === "dot") eyes.append(el("circle", { cx: x, cy: y, r: 3.3 }, eye));
		else if (look.eyes === "tall") eyes.append(el("ellipse", { cx: x, cy: y, rx: 2.7, ry: 4.1 }, eye));
		else eyes.append(el("ellipse", { cx: x, cy: y, rx: 3.8, ry: 3 }, eye));
		eyes.append(el("circle", { cx: x + 1, cy: y - 1.4, r: 1, fill: "#fff", opacity: 0.9, class: "glint" }));
	}
	body.append(eyes);
	svg.append(defs, body);
	return svg;
}

/** What stands in for an answer on its way: the faces of who may answer, looking around. */
export function thinking(agents) {
	const who = agents.length === 1 ? `${agents[0].name} sta pensando` : "Stanno pensando";
	// One agente thinks inside a turning halo of its colour, the same one its work shows once it starts.
	const el = h("div.thinking", { role: "status", "aria-label": who }, h(`span.faces${agents.length === 1 ? ".orb" : ""}`, agents.slice(0, 3).map((a) => face(a, agents.length === 1 ? 22 : 26, "thinking"))), h("span.thinking-text", `${who}…`));
	el.style.setProperty("--glow", faceLook(agents[0]).color);
	return el;
}

/** An empty page or list: the agente's face waiting, what is missing, and how to fill it. */
export function emptyNote(tag, title, ...text) {
	return h(tag, h("span.empty-mark", { "aria-hidden": "true" }, face(state.instance ?? { id: "owni" }, 40)), h("b", title), ...text);
}

/** A tile with a service's first letter, in a colour of its own: the catalog has no logos. */
export function monogram(name) {
	const tile = h("span.monogram", { "aria-hidden": "true" }, name.slice(0, 1).toUpperCase());
	tile.style.setProperty("--tile", FACE_COLORS[faceSeed(name) % FACE_COLORS.length]);
	return tile;
}

// ---------- toasts ----------
// A stack: the newest in front, the older ones tucked behind it. Pointing at the stack spreads it
// out and holds every timer; a swipe sends one away.
let toastsOpen = false;

function layoutToasts() {
	const shown = [...$toasts.children].filter((t) => !t.classList.contains("out")).reverse();
	let y = 0;
	shown.forEach((t, i) => {
		t.style.setProperty("--y", `${-(toastsOpen ? y : i * 10)}px`);
		t.style.setProperty("--s", toastsOpen ? "1" : String(1 - Math.min(i, 3) * 0.05));
		t.style.setProperty("--z", String(shown.length - i));
		t.classList.toggle("buried", !toastsOpen && i >= 3);
		y += t.offsetHeight + 8;
	});
	$toasts.style.setProperty("--h", `${toastsOpen ? Math.max(0, y - 8) : (shown[0]?.offsetHeight ?? 0) + Math.min(shown.length - 1, 2) * 10}px`);
}

function holdToasts(open) {
	if (toastsOpen === open) return;
	toastsOpen = open;
	$toasts.classList.toggle("open", open);
	for (const t of $toasts.children) open ? t.hold?.() : t.go?.();
	layoutToasts();
}
$toasts?.addEventListener("pointerenter", () => holdToasts(true));
$toasts?.addEventListener("pointerleave", () => holdToasts(false));

export function toast(text, bad = false) {
	const t = h(`div.toast${bad ? ".bad" : ""}`, bad ? { role: "alert" } : {}, icon(bad ? "alert" : "check"), h("span", text));
	// An error is usually longer and says what to do: it stays longer.
	let left = bad ? 9000 : 4200;
	let started = 0;
	let timer;
	const close = () => {
		clearTimeout(timer);
		if (t.classList.contains("out")) return;
		t.classList.add("out");
		layoutToasts();
		setTimeout(() => {
			t.remove();
			layoutToasts();
			if (!$toasts.children.length) holdToasts(false);
		}, 280);
	};
	t.close = close;
	t.go = () => {
		started = Date.now();
		timer = setTimeout(close, left);
	};
	t.hold = () => {
		clearTimeout(timer);
		left = Math.max(1200, left - (Date.now() - started));
	};
	// Swiped down or sideways past a short distance, it goes; less than that, it springs back.
	let from;
	const offset = (dx, dy) => {
		t.style.setProperty("--dx", `${dx}px`);
		t.style.setProperty("--dy", `${dy}px`);
	};
	t.addEventListener("pointerdown", (e) => {
		from = { x: e.clientX, y: e.clientY };
		t.setPointerCapture(e.pointerId);
		t.classList.add("dragging");
	});
	t.addEventListener("pointermove", (e) => {
		if (from) offset(e.clientX - from.x, Math.max(0, e.clientY - from.y));
	});
	const release = (e) => {
		if (!from) return;
		const dx = e.clientX - from.x;
		const dy = e.clientY - from.y;
		from = undefined;
		t.classList.remove("dragging");
		if (Math.abs(dx) > 64 || dy > 36) close();
		else offset(0, 0);
	};
	t.addEventListener("pointerup", release);
	t.addEventListener("pointercancel", release);
	$toasts.append(t);
	if (!toastsOpen) t.go();
	// Beyond a handful the oldest leaves, so the stack never grows into a wall.
	const live = [...$toasts.children].filter((x) => !x.classList.contains("out"));
	if (live.length > 5) live[0].close?.();
	layoutToasts();
}

export class ApiError extends Error {
	constructor(status, message, data = {}) {
		super(message);
		this.status = status;
		this.data = data;
	}
}

export async function api(path, { method = "GET", body, raw } = {}) {
	const res = await fetch(path, {
		method,
		headers: { "x-owni": "1", ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}) },
		body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
		credentials: "same-origin",
	});
	const data = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : {};
	if (res.status === 401 && !path.startsWith("/api/login")) {
		state.me = undefined;
		// The session shows the login: this module imports nothing.
		window.dispatchEvent(new Event("owni:unauthorized"));
		throw new ApiError(401, data.error ?? "Accesso richiesto");
	}
	if (!res.ok) throw new ApiError(res.status, data.error ?? `Errore ${res.status}`, data);
	return data;
}

/** «1,2», «84»: Italian, at most one decimal. */
const decimal = (n) => n.toLocaleString("it-IT", { maximumFractionDigits: n >= 10 ? 0 : 1 });

export const fmt = {
	time: (iso) => (iso ? new Date(iso).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"),
	day: (iso) => (iso ? new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "—"),
	bytes: (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${decimal(n / 1024)} KB` : `${decimal(n / 1048576)} MB`),
	/** When, as a chat list says it: the time today, the day otherwise. */
	short: (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : fmt.day(iso)),
	usd: (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`,
	/** A time ahead, the way it is said: «oggi alle 18:00», «domani alle 9:00», «lun 26 ott alle 9:00». */
	soon: (iso) => {
		const at = new Date(iso);
		const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
		const time = at.toLocaleTimeString("it-IT", { hour: "numeric", minute: "2-digit" });
		const day = days === 0 ? "oggi" : days === 1 ? "domani" : at.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
		return `${day} alle ${time}`;
	},
};

/** Reads with one argument, writes with two; null removes the key. */
export function store(key, value) {
	try {
		if (value === undefined) return localStorage.getItem(key) ?? undefined;
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		return undefined;
	}
}

// ---------- state ----------
export const state = {
	me: undefined,
	instances: [],
	instance: undefined,
	usage: undefined,
	pendingApprovals: 0,
	/** Schede waiting for this person's review (ADR 0051). */
	boardReview: 0,
	/** The rail's conversations (ADR 0112): a direct one per agente the person can write to, the general one first, and their canali. */
	conversations: { direct: [], channels: [] },
	/** Steps of «Primi passi» still to do, for the owner; 0 when done or put away. */
	setupLeft: 0,
	events: undefined,
	onEntry: undefined,
	onRun: undefined,
	onRunsReconnect: undefined,
	onBoard: undefined,
};

export function route() {
	const hash = location.hash.replace(/^#\/?/, "");
	const question = hash.indexOf("?");
	const path = question < 0 ? hash : hash.slice(0, question);
	const params = new URLSearchParams(question < 0 ? "" : hash.slice(question + 1));
	const [view, ...rest] = path.split("/");
	const decode = (part) => { try { return decodeURIComponent(part); } catch { return part; } };
	return { view: view || "dm", rest: rest.map(decode), instanceId: params.get("agent") ?? undefined, params };
}

const AGENT_VIEWS = new Set(["file", "memoria", "skill", "task", "automazioni", "impostazioni", "connettori", "segreteria", "inizia"]);

/** A link carries its agent: opening it later never borrows another agent from the browser. */
export function instanceHref(view, rest = [], instanceId = state.instance?.id) {
	const path = `#/${[view, ...rest].map(encodeURIComponent).join("/")}`;
	return instanceId ? `${path}?agent=${encodeURIComponent(instanceId)}` : path;
}

/** The person's direct conversation with an agente, or a thread in it (ADR 0112). */
export function dmHref(instanceId, threadId) {
	return `#/dm/${encodeURIComponent(instanceId)}${threadId ? `/t/${encodeURIComponent(threadId)}` : ""}`;
}

/** Where an address from before the canali goes now (ADR 0112): a chat opens in its agente's direct messages. */
export function movedHref({ view, rest, instanceId }) {
	if (view === "chat") return instanceId ? dmHref(instanceId, rest[0]) : "#/";
	return undefined;
}

/** Where an agent's own page is: its configuration for the owner, its documents for everyone else. */
export function agentHome(instanceId = state.instance?.id) {
	if (!instanceId) return "#/agenti";
	return instanceHref(state.me?.role === "owner" ? "impostazioni" : "file", [], instanceId);
}

/** Only an agent already returned for this person may become the current context. */
export function selectInstance(id) {
	const instance = state.instances.find((i) => i.id === id);
	if (!instance) return false;
	if (state.instance !== instance) {
		state.instance = instance;
		state.setup = undefined;
		state.setupLeft = 0;
	}
	store("owni.instance", id);
	return true;
}

export function go(view, ...rest) {
	location.hash = instanceHref(view, rest, AGENT_VIEWS.has(view) ? state.instance?.id : null);
}


export function head(parent, title, text, ...actions) {
	// An agent's pages get a path back to its chat; app-level pages pass no parent.
	const here = (title instanceof Node ? title.textContent : title).trim();
	return h(
		"div.head",
		parent ? h("nav.crumbs", { "aria-label": "Percorso" }, h("a", { href: agentHome() }, parent), here ? [icon("chevron"), h("span.here", { "aria-current": "page" }, here)] : null) : null,
		h("div.head-title", title instanceof Node ? title : h("h1", title), text ? h("p", text) : null),
		actions.length ? h("div.row-gap.head-actions", actions) : null,
	);
}

export function initials(name) {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}


export function needInstance(main) {
	if (state.instance) return false;
	mount(main, emptyNote("div.empty", "Nessun agente", "Non hai ancora accesso a nessun agente. Chiedi all'owner di aggiungerti."));
	return true;
}


export function confirmDialog(title, text, okLabel, onOk) {
	const dialog = h(
		"dialog",
		h("h2", title),
		h("p", text),
		h(
			"div.actions",
			h(
				"button.btn.accent",
				{
					onclick: () => {
						dialog.close();
						onOk();
					},
				},
				okLabel,
			),
			h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
		),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}


/** «🔎 Ricercatore», or the name alone. */
export function agentLabel(agent) {
	return agent.emoji ? `${agent.emoji} ${agent.name}` : agent.name;
}

