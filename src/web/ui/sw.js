// Owni's service worker: the console opens from the home screen and without network shows its
// shell. Only the shell is kept (page, script, style, fonts, icons): never /api, never anything a
// person wrote or received. Network first, so a new version is used as soon as it is online.
// Bump CACHE when the shell list changes; the page itself is refreshed on every visit online.
const CACHE = "owni-shell-v20";
/** Addresses that are never the shell, also when opened as a page (a file link, a login with Google). */
const NOT_SHELL = /^\/(api|oauth|hooks|login|openui)(\/|$)/;
const SHELL = ["/", "/account.js", "/agent-materials.js", "/agent-panel.js", "/app.js", "/artifacts.js", "/browser-panel.js", "/cards.js", "/commands.js", "/common.js", "/connectors.js", "/google.js", "/listen.js", "/login.js", "/models.js", "/markdown.js", "/openui.js", "/sources.js", "/palette.js", "/pwa.js", "/runs.js", "/screen-panel.js", "/session.js", "/setup.js", "/shell.js", "/signin.js", "/threads.js", "/tones.js", "/pages/activity.js", "/pages/agents.js", "/pages/approvals.js", "/pages/automations.js", "/pages/board.js", "/pages/chat.js", "/pages/org.js", "/pages/people.js", "/pages/rooms.js", "/pages/settings.js", "/pages/start.js", "/pages/tasks.js", "/app.css", "/icon.svg", "/manifest.webmanifest", "/fonts/archivo-latin.woff2", "/fonts/archivo-latin-ext.woff2", "/fonts/monaspace-neon-latin-400.woff2", "/fonts/monaspace-neon-latin-500.woff2", "/pages/work.js"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (NOT_SHELL.test(url.pathname)) return;
	const navigation = request.mode === "navigate";
	if (!navigation && !SHELL.includes(url.pathname)) return;
	event.respondWith(
		fetch(request)
			.then((response) => {
				// The page is kept as "/" (whatever #/view it was opened on), the files under their own address.
				if (response.ok && response.type === "basic" && (!navigation || url.pathname === "/")) {
					const copy = response.clone();
					void caches.open(CACHE).then((cache) => cache.put(navigation ? "/" : request, copy));
				}
				return response;
			})
			// Offline: the page from the shell (it says it is offline), the files as last seen.
			.catch(() => caches.match(navigation ? "/" : request).then((hit) => hit ?? Response.error())),
	);
});
