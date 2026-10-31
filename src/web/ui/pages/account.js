// Account page: what is yours (Google, two-factor) and, for the owner, the installation.
import { adoptPerson, api, h, head, instanceHref, mount, state, toast } from "../common.js";
import { codeInput } from "../login.js";
import { googleSection } from "../google.js";
import { renderRail } from "../shell.js";

/** One page for everyone: the person's own settings, then what the owner manages. */
export async function viewAccount(main) {
	const owner = state.me.role === "owner";
	const link = (href, title, text) => h("a.card.pad.account-link", { href }, h("b", title), h("small.muted", text));
	mount(
		main,
		head(null, "Account", `${state.me.name} · ${owner ? "Owner" : "Membro"}`),
		h("section.stack", h("h2.section-title", "Il tuo account"), googleSection(), twoFactorSection()),
		h(
			"section.stack.account-links",
			h("h2.section-title", owner ? "Installazione" : "Attività"),
			owner
				? [
						link("#/persone", "Persone e accessi", "Chi entra, con che ruolo, a quali agenti scrive e cosa approva."),
						link(instanceHref("impostazioni", ["providers"]), "Provider disponibili", "Abbonamenti e chiavi dei modelli."),
						link("#/attivita", "Consumi e registro delle attività", "Spesa e cronologia di tutte le esecuzioni."),
					]
				: link("#/attivita", "Le tue esecuzioni e i consumi", "Cosa hanno fatto gli agenti per te e quanto è costato."),
		),
	);
}

/** Two-factor sign-in with an authenticator app: turn it on, or off with a code. */
function twoFactorSection() {
	const box = h("div.card.pad.stack", { "data-account": "2fa" });
	const run = (path, body, done) => async () => {
		try {
			await api(path, { method: "POST", body });
			toast(done);
			await draw();
		} catch (error) {
			toast(error.message, true);
		}
	};
	const draw = async () => {
		const me = (await api("/api/me")).person;
		adoptPerson(me);
		renderRail();
		const title = h("h3.section-title", "Verifica in due passaggi");
		if (me.twoFactor) {
			const code = codeInput();
			mount(box, title,
				h("p", h("span.chip.ok", "Attiva"), " Per entrare servono il tuo link e il codice dell'app."),
				h("label.field", h("span", "Per disattivarla, scrivi un codice"), code),
				h("div.actions", h("button.btn.danger", { onclick: () => run("/api/me/2fa/disable", { code: code.value }, "Verifica in due passaggi disattivata")() }, "Disattiva")),
			);
			return;
		}
		mount(box, title,
			h("p", "Per entrare servono il tuo link e un codice dall'app di autenticazione del telefono (Google Authenticator, 1Password, Authy…). Se qualcuno ti ruba il link, da solo non basta."),
			h("div.actions", h("button.btn.accent", { onclick: () => void setup() }, "Attiva")),
		);
	};
	const setup = async () => {
		try {
			const { secret, uri } = await api("/api/me/2fa/setup", { method: "POST", body: {} });
			const code = codeInput();
			mount(box, h("h3.section-title", "Verifica in due passaggi"),
				h("p", "1. Nell'app di autenticazione aggiungi un account con questa chiave (o apri il link dal telefono):"),
				h("div.secret-key.mono", secret.match(/.{1,4}/g).join(" ")),
				h("p", h("a", { href: uri }, "Apri nell'app di autenticazione")),
				h("label.field", h("span", "2. Scrivi il codice che l'app mostra"), code),
				h("div.actions",
					h("button.btn.accent", { onclick: () => run("/api/me/2fa/enable", { code: code.value }, "Verifica in due passaggi attiva")() }, "Attiva"),
					h("button.btn.ghost", { onclick: () => void draw() }, "Annulla"),
				),
			);
			code.focus();
		} catch (error) {
			toast(error.message, true);
		}
	};
	void draw().catch((error) => toast(error.message, true));
	return box;
}
