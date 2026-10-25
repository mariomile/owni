// The person's own Google account: the section of the account dialog, and the return from Google's consent.
import { api, h, mount, toast } from "./common.js";

/** Back from Google's consent: the code is in the fragment, the session in our cookie. */
export async function finishGoogle() {
	const params = new URLSearchParams(location.hash.slice("#/google?".length));
	history.replaceState(null, "", "/#/");
	if (params.get("error")) return toast(params.get("error") === "access_denied" ? "Collegamento a Google annullato" : "Google non ha completato il collegamento: riprova", true);
	try {
		const { account } = await api("/api/google/finish", { method: "POST", body: { state: params.get("state") ?? "", code: params.get("code") ?? "" } });
		toast(`Google collegato: ${account.email}`);
	} catch (error) {
		toast(error.message, true);
	}
}

async function connectGoogle() {
	try {
		location.assign((await api("/api/google/start", { method: "POST", body: {} })).url);
	} catch (error) {
		toast(error.message, true);
	}
}

/** The person's own Google account, in the account dialog. */
export function googleSection() {
	const box = h("div.card.pad.stack");
	const draw = async () => {
		const { available, account, services, write } = await api("/api/google");
		if (!available) return box.remove();
		const what = services.length > 1 ? "la tua posta e il tuo calendario" : services[0] === "gmail" ? "la tua posta" : "il tuo calendario";
		if (account) {
			mount(box, 
				h("h3.section-title", "Google"),
				h("p", h("span.chip.ok", "Collegato"), " ", account.email),
				h("p.muted", write && account.canWrite ? `Owni legge ${what} quando glielo chiedi dalla console, o nel brief del mattino. Può preparare mail ed eventi, che partono solo quando li approvi tu.` : `Owni legge ${what} quando glielo chiedi dalla console, o nel brief del mattino. Non invia mail e non cambia eventi.`),
				write && !account.canWrite ? h("p", "Per far preparare a Owni mail ed eventi (che approvi tu), ricollega Google lasciando spuntati tutti i permessi.") : null,
				h(
					"div.actions",
					write && !account.canWrite ? h("button.btn.accent", { onclick: () => void connectGoogle() }, "Ricollega Google") : null,
					h(
						"button.btn.danger",
						{
							onclick: async () => {
								await api("/api/google", { method: "DELETE" }).catch((e) => toast(e.message, true));
								toast("Google scollegato");
								await draw();
							},
						},
						"Scollega",
					),
				),
			);
			return;
		}
		mount(box, 
			h("h3.section-title", "Google"),
			h("p", write ? `Collega Google: Owni potrà leggere ${what} quando glielo chiedi dalla console, e preparare mail ed eventi che partono solo dopo la tua approvazione.` : `Collega Google: Owni potrà leggere ${what}, solo leggere, quando glielo chiedi dalla console.`),
			h("div.actions", h("button.btn.accent", { onclick: () => void connectGoogle() }, "Collega Google")),
		);
	};
	void draw().catch(() => box.remove());
	return box;
}
