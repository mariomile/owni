// Account (two-factor).
import { adoptPerson, api, h, mount, toast } from "./common.js";
import { codeInput } from "./login.js";
import { googleSection } from "./google.js";
import { renderRail } from "./shell.js";

// ---------- account (two-factor) ----------
export function accountDialog() {
	const body = h("div");
	const dialog = h("dialog", h("h2", "Il tuo account"), googleSection(), body);
	const draw = async () => {
		const me = (await api("/api/me")).person;
		adoptPerson(me);
		if (me.twoFactor) {
			const code = codeInput();
			mount(body, 
				h("p", h("span.chip.ok", "Verifica in due passaggi attiva"), " Per entrare servono il tuo link e il codice dell'app."),
				h("label.field", h("span", "Per disattivarla, scrivi un codice"), code),
				h(
					"div.actions",
					h(
						"button.btn.danger",
						{
							onclick: async () => {
								try {
									await api("/api/me/2fa/disable", { method: "POST", body: { code: code.value } });
									toast("Verifica in due passaggi disattivata");
									await draw();
								} catch (error) {
									toast(error.message, true);
								}
							},
						},
						"Disattiva",
					),
					h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi"),
				),
			);
			return;
		}
		mount(body, 
			h("p", "Con la verifica in due passaggi, per entrare servono il tuo link e un codice dall'app di autenticazione del telefono (Google Authenticator, 1Password, Authy…). Se qualcuno ti ruba il link, da solo non basta."),
			h(
				"div.actions",
				h(
					"button.btn.accent",
					{
						onclick: async () => {
							try {
								const { secret, uri } = await api("/api/me/2fa/setup", { method: "POST", body: {} });
								const code = codeInput();
								mount(body, 
									h("p", "1. Nell'app di autenticazione aggiungi un account con questa chiave (o apri il link dal telefono):"),
									h("div.secret-key.mono", secret.match(/.{1,4}/g).join(" ")),
									h("p", h("a", { href: uri }, "Apri nell'app di autenticazione")),
									h("label.field", h("span", "2. Scrivi il codice che l'app mostra"), code),
									h(
										"div.actions",
										h(
											"button.btn.accent",
											{
												onclick: async () => {
													try {
														await api("/api/me/2fa/enable", { method: "POST", body: { code: code.value } });
														toast("Verifica in due passaggi attiva");
														await draw();
													} catch (error) {
														toast(error.message, true);
													}
												},
											},
											"Attiva",
										),
										h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
									),
								);
								code.focus();
							} catch (error) {
								toast(error.message, true);
							}
						},
					},
					"Attiva la verifica in due passaggi",
				),
				h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi"),
			),
		);
	};
	dialog.addEventListener("close", () => (dialog.remove(), renderRail()));
	document.body.append(dialog);
	dialog.showModal();
	void draw().catch((error) => toast(error.message, true));
}

