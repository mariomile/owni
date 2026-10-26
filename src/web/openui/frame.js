// One OpenUI answer (ADR 0118), drawn in a sandboxed frame with no origin of its own: no session,
// no calls to Owni, nothing sent out. It talks to the console only by messages, and only about
// what the person sees: the answer to draw, the theme, its height, and what they clicked.
(() => {
	const { React, createRoot, Renderer, openuiChatLibrary } = window.__OpenUI;
	const root = createRoot(document.getElementById("root"));
	// The console framed this page (frame-ancestors 'self'): its origin is not readable from here.
	const tell = (message) => parent.postMessage(message, "*");
	const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

	/** A form's values as name and value, in the order shown: `{form: {field: {value}}}`. */
	const fields = (state) => {
		const out = [];
		for (const form of Object.values(state ?? {})) {
			if (form === null || typeof form !== "object") continue;
			for (const [name, field] of Object.entries(form)) {
				const value = field !== null && typeof field === "object" && "value" in field ? field.value : field;
				if (value === undefined || value === null || value === "") continue;
				out.push([text(name, 80), text(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value), 500)]);
			}
		}
		return out.slice(0, 30);
	};

	const onAction = (event) => {
		const params = event.params ?? {};
		tell({
			type: "openui-action",
			kind: event.type === "open_url" ? "open_url" : "continue",
			message: text(event.humanFriendlyMessage, 500),
			fields: fields(event.formState),
			context: text(typeof params.context === "string" ? params.context : params.context === undefined ? "" : JSON.stringify(params.context), 1000),
			url: text(params.url, 2000),
		});
	};

	const draw = (source) => {
		root.render(
			React.createElement(Renderer, {
				response: source,
				library: openuiChatLibrary,
				onAction,
				// Nothing to draw (not OpenUI Lang after all): the console shows the text instead.
				onParseResult: (result) => tell({ type: result === null || result.root === null ? "openui-empty" : "openui-drawn" }),
			}),
		);
	};

	addEventListener("message", (event) => {
		if (event.source !== parent || event.data === null || typeof event.data !== "object") return;
		const { type, source, theme } = event.data;
		if (type === "openui-theme" || type === "openui-draw") {
			if (theme === "light" || theme === "dark") document.documentElement.dataset.openuiTheme = theme;
			else delete document.documentElement.dataset.openuiTheme;
		}
		if (type === "openui-draw" && typeof source === "string") draw(source);
	});

	// A link in the answer's text: popups are closed to the frame, so the console opens it, only on the web.
	document.addEventListener("click", (event) => {
		const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!link) return;
		event.preventDefault();
		tell({ type: "openui-action", kind: "open_url", url: text(link.href, 2000) });
	});

	// The height of what is drawn, not of the page: the page is never shorter than the frame, so it could only grow.
	const content = document.getElementById("root");
	new ResizeObserver(() => tell({ type: "openui-height", height: Math.ceil(content.getBoundingClientRect().height) })).observe(content);
	tell({ type: "openui-ready" });
})();
