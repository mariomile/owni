// Back from a service's sign-in (ADR 0024): the code is in the fragment, like Google's.
import { api, instanceHref, state, store, toast } from "./common.js";

/** Back from a service's sign-in (ADR 0024): like Google's, the code is in the fragment. */
export async function finishConnector() {
	const params = new URLSearchParams(location.hash.slice("#/connettore?".length));
	history.replaceState(null, "", `/${instanceHref("impostazioni", ["servizi"], null)}`);
	const error = params.get("error");
	try {
		const done = await api("/api/connectors/oauth/finish", { method: "POST", body: { state: params.get("state") ?? "", ...(error ? { error } : { code: params.get("code") ?? "" }) } });
		// The connector's own instance, whatever was selected when the sign-in started.
		const inst = state.instances.find((i) => i.id === done.instanceId);
		if (inst) {
			state.instance = inst;
			store("owni.instance", inst.id);
			history.replaceState(null, "", `/${instanceHref("impostazioni", ["servizi"], inst.id)}`);
		}
		if (done.cancelled) return toast(error === "access_denied" ? "Accesso annullato: il connettore resta da collegare" : "Il servizio non ha completato l'accesso: riprova con «Collega»", true);
		const st = done.status;
		toast(st?.connected ? `Collegato: Owni ha ${st.tools.length} nuovi strumenti` : `Accesso riuscito, ma il servizio non risponde${st?.error ? `: ${st.error}` : ""}`, !st?.connected);
	} catch (e) {
		toast(e.message, true);
	}
}
