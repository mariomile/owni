// The console as an app on the phone: install offer, service worker, offline bar.
import { state, store, toast } from "./common.js";
import { render, renderRail } from "./shell.js";

// ---------- app on the phone (PWA) ----------
/** The browser's install offer, kept for the «Installa» button; undefined where there is none (iOS, already installed). */
export let installOffer;
window.addEventListener("beforeinstallprompt", (event) => {
	event.preventDefault();
	installOffer = event;
	// The browser offers it again: the app was removed, whatever this browser remembered.
	if (store("owni.app") === "installed") store("owni.app", "removed");
	if (state.me) renderRail();
});
window.addEventListener("appinstalled", () => {
	installOffer = undefined;
	store("owni.app", "installed");
	if (state.me) render();
});
// Only on https or on this machine: elsewhere browsers refuse it, and the console works the same.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
const offlineBar = () => {
	const bar = document.getElementById("offline");
	if (bar) bar.hidden = navigator.onLine;
};
window.addEventListener("online", offlineBar);
window.addEventListener("offline", offlineBar);
offlineBar();

/** Running as the installed app, or installed from this browser (Safari never says so: there it is only known inside the app). */
export function installed() {
	return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true || store("owni.app") === "installed";
}

/** iPhone and iPad, which install only from Safari's Share menu (iPadOS says it is a Mac, but has touch). */
export const appleTouch = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const phone = /iphone|ipod|android.*mobile/i.test(navigator.userAgent);

export async function install() {
	if (!installOffer) return;
	installOffer.prompt();
	const { outcome } = await installOffer.userChoice;
	installOffer = undefined;
	if (outcome === "accepted") {
		store("owni.app", "installed");
		toast(phone ? "Owni è sulla schermata Home" : "Owni è installata come app");
	}
	render();
}

