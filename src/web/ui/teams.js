// Squadre pronte (ADR 0068), opened from the Agenti page.
import { api, go, h, toast } from "./common.js";
import { refreshInstances } from "./session.js";
import { render } from "./shell.js";

/** At most this many permissions in the confirmation, the rest counted. */
const SHOWN_LINKS = 12;

/**
 * Ask before changing who may write to whom (ADR 0125): each change by name, from the server's
 * preview. Resolves true when the owner confirms.
 */
export function confirmLinks(title, lead, changes, okLabel) {
	const line = (c) => (c.allowed ? `Da ora ${c.from} potrà scrivere a ${c.to}` : `${c.from} non potrà più scrivere a ${c.to}`);
	const more = changes.length - SHOWN_LINKS;
	return new Promise((resolve) => {
		let ok = false;
		const dialog = h(
			"dialog.links-confirm",
			h("h2", title),
			h("p", lead),
			h("ul.links-list", changes.slice(0, SHOWN_LINKS).map((c) => h(`li${c.allowed ? "" : ".off"}`, line(c))), more > 0 ? h("li.muted", `e altre ${more} modifiche`) : null),
			h(
				"div.actions",
				h("button.btn.accent", { onclick: () => ((ok = true), dialog.close()) }, okLabel),
				h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
			),
		);
		dialog.addEventListener("close", () => {
			dialog.remove();
			resolve(ok);
		});
		document.body.append(dialog);
		dialog.showModal();
	});
}

/** Ready-made squadre (ADR 0068): a few agenti that go in the organigramma as a squadra, with a room for all of them. */
export async function teamsForm() {
	let listed;
	try {
		listed = await api("/api/teams");
	} catch (error) {
		return toast(error.message, true);
	}
	const { teams, available } = listed;
	if (!available) return toast("Questa installazione non crea agenti dalla console", true);
	// One squadra at a time: every button waits while one is made.
	const busy = (on) => {
		for (const b of dialog.querySelectorAll(".team button")) b.disabled = on;
	};
	const make = async (team) => {
		busy(true);
		try {
			// What it changes in who writes to whom, before any agente is made.
			const { changes } = await api("/api/teams/preview", { method: "POST", body: { team: team.key } });
			if (!(await confirmLinks(`Creare la squadra ${team.name}?`, "Gli agenti nuovi entrano nell'organigramma, e da lì vale chi può scrivere a chi:", changes, "Crea la squadra"))) return busy(false);
			const { agents, room, note } = await api("/api/teams", { method: "POST", body: { team: team.key } });
			dialog.close();
			await refreshInstances();
			toast(note ?? `Squadra ${team.name} pronta: ${agents.map((a) => a.name).join(", ")}`, note !== undefined);
			if (room) go("canali", room);
			else go("agenti");
			render();
		} catch (error) {
			busy(false);
			toast(error.message, true);
		}
	};
	const dialog = h(
		"dialog.teams-form",
		h("h2", "Squadre pronte"),
		h("p.muted", "Tre agenti con un compito ciascuno, che entrano nell'organigramma come una squadra e si chiedono aiuto tra loro, e una stanza dove li chiami tutti. Chi coordina divide il lavoro; tra gli incarichi può farne sotto-incarichi per gli altri. Dopo sono agenti come gli altri: li sposti nell'organigramma, li cambi o li elimini uno per uno."),
		h(
			"div.teams",
			teams.map((team) => {
				const button = h("button.btn.small.accent", { type: "button", onclick: () => void make(team) }, "Crea la squadra");
				return h(
					"section.team",
					h("b", team.name),
					h("p.muted.small", team.summary),
					h("ul", team.members.map((m, i) => h("li", h("span", m.name), h("small.muted", i === 0 ? `coordina · ${m.tagline}` : m.tagline)))),
					button,
				);
			}),
		),
		h("div.actions", h("button.btn.ghost", { onclick: () => dialog.close() }, "Chiudi")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}
