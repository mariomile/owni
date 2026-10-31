// The steps of «Primi passi»: which are left, as the counters and the chat's hint show them.
import { appleTouch, installed, installOffer } from "./pwa.js";

/** Install is possible here: the browser offered it, or Safari's Share menu on iPhone and iPad. */
const canInstall = () => installOffer !== undefined || appleTouch;

/**
 * The steps of «Primi passi», from what the server checked and what this browser knows. `own`: the
 * owner can take it from here (some browsers cannot install).
 */
export function setupSteps(setup) {
	const can = setup.can ?? {};
	return [
		{ id: "model", own: true, done: setup.model, title: "Collega il tuo provider AI", text: setup.model ? "Owni usa un modello AI vero: puoi cambiarlo quando vuoi." : "Owni riconosce Claude Code e Codex già connessi su questo computer e usa il tuo abbonamento. Puoi anche scegliere un altro provider e aggiungere la sua chiave API.", go: ["impostazioni", "providers"] },
		...(can.computerUse ? [{ id: "computerUse", own: true, done: setup.computerUse, title: "Abilita Computer Use", text: "Consenti Registrazione schermo e Accessibilità in macOS, poi scegli se questo agente può vedere lo schermo, cliccare e scrivere su questo Mac.", go: ["impostazioni", "computer-use"] }] : []),
		{ id: "instructions", own: true, done: setup.instructions, title: "Dille chi è e cosa fa", text: "Due righe su di te o sulla tua azienda, il tono e cosa deve fare. Puoi partire da un esempio: vengono aggiunte a quello che Owni sa già fare, e le cambi quando vuoi in Impostazioni." },
		{ id: "tried", own: true, done: setup.tried, title: "Scrivile qualcosa", text: `Una domanda, una foto, un file da riassumere: vedi subito come risponde.${setup.model ? "" : " Con il modello di prova la risposta ripete quello che scrivi."}` },
		{ id: "channel", own: true, done: setup.channel, title: "Usala dal telefono", text: `Collega Telegram o WhatsApp e mettiti tra chi può scriverle: le scrivi, le mandi ${can.transcription ? "vocali e " : ""}foto${can.transcription && can.speech ? ", ti risponde anche a voce" : ""}, e ti avvisa lei.`, go: ["impostazioni", "telegram"] },
		{ id: "web", own: true, done: setup.web, title: "Lasciala cercare sul web", text: can.search ? "Accendi la ricerca e scegli i siti che può aprire: notizie, prezzi, orari aggiornati, report di ricerca con le fonti." : "Scegli i siti che può aprire: notizie, prezzi, orari aggiornati.", go: ["impostazioni", can.search ? "ricerca" : "siti"] },
		...(can.images ? [{ id: "images", own: true, done: setup.images, title: "Fatti creare un'immagine", text: "Accendi le immagini: un logo, un volantino, una foto ritoccata, chiesti a parole in chat.", go: ["impostazioni", "immagini"] }] : []),
		{ id: "connectors", own: true, done: setup.connectors, title: "Collega i tuoi strumenti", text: "Notion, Linear, Jira, Stripe, GitHub e altri in un clic: entri con il tuo account e Owni può cercare, leggere e aggiornare lì dentro.", go: ["impostazioni", "servizi"] },
		{ id: "people", own: true, done: setup.people, title: "Invita il tuo team", text: "Aggiungi le persone in Persone e accessi e scegli a quali agenti scrivono. Ognuno ha le sue chat e la sua memoria; tu decidi chi approva le azioni delicate.", go: ["persone"] },
		{ id: "app", own: canInstall(), done: installed(), title: "Installa la console come app", text: "Owni sulla schermata Home o sul desktop, a schermo intero, come un'app." },
	];
}

/** Steps left that the owner can take from the console: what the counters show. */
export function setupLeft(setup) {
	return setupSteps(setup).filter((s) => ["model", "tried"].includes(s.id) && !s.done && s.own).length;
}

export function stepsLeftText(n) {
	return n === 1 ? "Completa il primo utilizzo" : "Collega il modello e prova il tuo assistente";
}
