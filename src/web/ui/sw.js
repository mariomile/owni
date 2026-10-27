// Owni's service worker: the console opens from the home screen and without network shows its
// shell. Only the shell is kept (page, script, style, fonts, icons): never /api, never anything a
// person wrote or received. Network first, so a new version is used as soon as it is online.
// The kept shell is one release, whole: the server names CACHE after the files it serves, so a new
// release installs a new worker that fetches every file afresh, and nothing is kept one file at a time.
// A page drawn by new scripts with an older stylesheet comes out broken (the Mac app at 0.12.0).
const CACHE = "owni-shell-__SHELL_VERSION__";
/** Addresses that are never the shell, also when opened as a page (a file link, a login with Google). */
const NOT_SHELL = /^\/(api|oauth|hooks|login|openui)(\/|$)/;
const SHELL = ["/", "/account.js", "/agent-materials.js", "/agent-panel.js", "/app.js", "/artifacts.js", "/browser-panel.js", "/cards.js", "/commands.js", "/common.js", "/connectors.js", "/google.js", "/listen.js", "/login.js", "/models.js", "/markdown.js", "/openui.js", "/sources.js", "/palette.js", "/pwa.js", "/runs.js", "/screen-panel.js", "/session.js", "/setup.js", "/shell.js", "/signin.js", "/threads.js", "/tones.js", "/pages/activity.js", "/pages/agents.js", "/pages/approvals.js", "/pages/automations.js", "/pages/board.js", "/pages/chat.js", "/pages/org.js", "/pages/people.js", "/pages/rooms.js", "/pages/settings.js", "/pages/start.js", "/pages/tasks.js", "/app.css", "/icon.svg", "/manifest.webmanifest", "/fonts/archivo-latin.woff2", "/fonts/archivo-latin-ext.woff2", "/fonts/monaspace-neon-latin-400.woff2", "/fonts/monaspace-neon-latin-500.woff2", "/pages/work.js"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
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
	// Offline: the page from the shell (it says it is offline), the files of the same release with it.
	event.respondWith(fetch(request).catch(() => caches.match(navigation ? "/" : url.pathname, { cacheName: CACHE }).then((hit) => hit ?? Response.error())));
});
