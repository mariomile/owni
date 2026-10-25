// Artifacts (ADR 0112): an agente's HTML pages, as a card in the conversation and live in a panel.
import { api, h, icon, toast } from "./common.js";

/** Where a version of an artifact is served, sandboxed by its own CSP. */
export const artifactUrl = (instanceId, threadId, id, version) => `/api/instances/${encodeURIComponent(instanceId)}/artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(id)}/${version}`;

/** An HTML file of the workspace, rendered sandboxed like an artifact. */
export const htmlFileUrl = (instanceId, path) => `/api/instances/${encodeURIComponent(instanceId)}/files/raw?path=${encodeURIComponent(path)}&view=1`;

export const isHtml = (path) => /\.html?$/i.test(path);

/** The card of an artifact in a transcript: its title, the version, open and download. */
export function artifactCard(instanceId, threadId, artifact, onOpen) {
	const url = artifactUrl(instanceId, threadId, artifact.id, artifact.version);
	return h(
		"div.artifact-card",
		h("span.artifact-mark", icon("artifact")),
		h("span.artifact-text", h("b", artifact.title), h("small", `Versione ${artifact.version}`)),
		h("button.btn.small", { type: "button", onclick: () => onOpen(artifact) }, "Apri"),
		h("a.icon-btn", { href: `${url}?download=1`, title: "Scarica", "aria-label": `Scarica ${artifact.title}` }, icon("install")),
	);
}

/**
 * The panel an artifact opens in, next to the conversation (full width on a phone, with a way
 * back). The page runs in a sandboxed frame, never with the console's origin: no session, no API.
 * `onShow`: called when it opens, to close the other panels; `onHide`: called when it closes.
 */
export function artifactPanel(onShow = () => {}, onHide = () => {}) {
	let open = null;
	let request = 0;
	const title = h("span.page-title", "Artifact");
	const versions = h("select.artifact-versions", { "aria-label": "Versione", hidden: true });
	const newTab = h("a.icon-btn", { target: "_blank", rel: "noopener", title: "Apri in una nuova scheda", "aria-label": "Apri in una nuova scheda" }, icon("external"));
	const download = h("a.icon-btn", { title: "Scarica", "aria-label": "Scarica" }, icon("install"));
	const frame = h("iframe.artifact-frame", { sandbox: "allow-scripts allow-modals", referrerpolicy: "no-referrer", title: "Artifact" });
	const el = h(
		"aside.browser-panel.artifact-panel",
		{ hidden: true, "aria-label": "Artifact" },
		h(
			"div.browser-head",
			h("button.icon-btn.artifact-back", { type: "button", title: "Torna alla conversazione", "aria-label": "Torna alla conversazione", onclick: () => show(false) }, icon("back")),
			icon("artifact"),
			title,
			versions,
			newTab,
			download,
			h("button.icon-btn.artifact-close", { type: "button", title: "Chiudi", "aria-label": "Chiudi l'artifact", onclick: () => show(false) }, icon("close")),
		),
		h("div.browser-view.artifact-view", frame),
	);
	const draw = (url, label, downloadUrl) => {
		title.textContent = label;
		frame.title = label;
		newTab.href = url;
		download.href = downloadUrl;
		if (frame.getAttribute("src") !== url) frame.src = url;
	};
	const pick = (version) => {
		const v = open.versions.find((x) => x.version === version) ?? open.versions.at(-1);
		const url = artifactUrl(open.instanceId, open.threadId, open.id, v.version);
		versions.value = String(v.version);
		draw(url, v.title, `${url}?download=1`);
	};
	versions.addEventListener("change", () => pick(Number(versions.value)));
	const show = (on) => {
		if (on === !el.hidden) return;
		el.hidden = !on;
		if (on) onShow();
		else {
			// A closed page stops running.
			frame.removeAttribute("src");
			open = null;
			onHide();
		}
	};
	return {
		el,
		show,
		isOpen: () => !el.hidden,
		/** An artifact of a conversation, at `artifact.version`; the other versions in the switcher. */
		async openArtifact(instanceId, threadId, artifact) {
			const mine = ++request;
			open = { instanceId, threadId, id: artifact.id, versions: [{ version: artifact.version, title: artifact.title }] };
			versions.hidden = true;
			show(true);
			pick(artifact.version);
			try {
				const { artifact: meta } = await api(`/api/instances/${encodeURIComponent(instanceId)}/artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(artifact.id)}`);
				if (mine !== request || open === null) return;
				open.versions = meta.versions;
				versions.replaceChildren(...meta.versions.map((v) => h("option", { value: String(v.version) }, `v${v.version}`)));
				versions.hidden = meta.versions.length < 2;
				versions.value = String(artifact.version);
			} catch (error) {
				toast(error.message, true);
			}
		},
		/** An HTML file of the workspace: one version, the file itself. */
		openFile(instanceId, path) {
			++request;
			open = null;
			versions.hidden = true;
			show(true);
			const raw = `/api/instances/${encodeURIComponent(instanceId)}/files/raw?path=${encodeURIComponent(path)}`;
			draw(htmlFileUrl(instanceId, path), path.split("/").pop(), raw);
		},
	};
}
