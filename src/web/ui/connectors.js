// The services an agente is connected to (ADR 0114: a section of its configuration).
import { api, confirmDialog, emptyNote, h, icon, monogram, mount, toast } from "./common.js";
import { render } from "./shell.js";

// ---------- connettori ----------
/** Opens the service's sign-in page, or says the connector works already. */
async function signInConnector(path, name) {
	const result = await api(path, { method: "POST", body: {} });
	if (result.url) {
		// Only a web page: a service never sends the console to another kind of address.
		if (!/^https?:\/\//.test(result.url)) throw new Error(`${name}: pagina di accesso non valida`);
		return location.assign(result.url);
	}
	toast(result.status?.connected ? `${name} collegato: ${result.status.tools.length} strumenti` : `${name} aggiunto${result.status?.error ? `, ma non collegato: ${result.status.error}` : ""}`, !result.status?.connected);
	render();
}

const AUTH_LABEL = { oauth: "Accedi con il tuo account", token: "Serve un token", none: "Pubblico, senza account" };
const CATALOG_GROUPS = [
	["lavoro", "Lavoro"],
	["pagamenti", "Pagamenti"],
	["conoscenza", "Documentazione"],
	["sviluppo", "Per sviluppatori"],
];

/** Whether the services can send the owner back here: https, or this computer. */
function returnWorks(redirectUrl) {
	if (!redirectUrl) return false;
	const u = new URL(redirectUrl);
	return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** The well-known servers not added yet, each one click away, by group. */
function catalogGallery(inst, catalog, oauth, redirectUrl, added) {
	const left = catalog.filter((e) => !added.has(e.id) && (e.auth !== "oauth" || oauth));
	if (left.length === 0) return null;
	const add = async (e, button) => {
		if (e.auth === "token") return tokenDialog(inst, e, false);
		button.disabled = true;
		try {
			await signInConnector(`/api/instances/${inst.id}/connectors/catalog/${e.id}`, e.name);
		} catch (error) {
			toast(error.message, true);
			button.disabled = false;
		}
	};
	const card = (e) => {
		const button = h("button.btn.small.accent", { onclick: () => void add(e, button) }, e.auth === "oauth" ? "Accedi e aggiungi" : "Aggiungi");
		return h("div.card.pad", h("div.catalog-name", monogram(e.name), h("h2", e.name)), h("span.chip", AUTH_LABEL[e.auth]), h("p.muted", e.description), h("div.go", button));
	};
	return h(
		"section.catalog",
		h("h2", "Aggiungi in un clic"),
		h("p.muted", "Servizi noti con un collegamento ufficiale per gli assistenti. Premi «Accedi e aggiungi»: entri con il tuo account sulla pagina del servizio e torni qui. L'accesso resta sul server di Owni, mai nel browser."),
		oauth && !returnWorks(redirectUrl) ? h("p.chip.warn", "Questo server non ha un indirizzo https (OWNI_PUBLIC_URL): molti servizi rifiutano di rimandarti qui dopo l'accesso.") : null,
		CATALOG_GROUPS.map(([group, label]) => {
			const items = left.filter((e) => e.category === group);
			return items.length ? h("div.stack", h("h3.section-title", label), h("div.gallery", items.map(card))) : null;
		}),
	);
}

/** A token for a one-click connector: to add it, or to change the one it has. */
function tokenDialog(inst, e, replace) {
	const token = h("input", { type: "password", placeholder: "Incolla qui il token", autocomplete: "off" });
	const save = async () => {
		try {
			const { status } = await api(`/api/instances/${inst.id}/connectors/catalog/${e.id}`, { method: "POST", body: { token: token.value, ...(replace ? { replace: true } : {}) } });
			dialog.close();
			toast(status?.connected ? `${e.name} collegato: ${status.tools.length} strumenti` : `${e.name} salvato, ma non collegato${status?.error ? `: ${status.error}` : ""}`, !status?.connected);
			render();
		} catch (error) {
			toast(error.message, true);
		}
	};
	token.addEventListener("keydown", (ev) => ev.key === "Enter" && void save());
	const dialog = h(
		"dialog",
		h("h2", replace ? `Nuovo token per ${e.name}` : `Collega ${e.name}`),
		h("p.muted", e.tokenHelp ?? ""),
		h("label.field", h("span", "Token"), token, h("small", "Resta sul server di Owni e non si vede più. Si usa solo per questo agente.")),
		h("div.actions", h("button.btn.accent", { onclick: () => void save() }, "Salva e collega"), h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla")),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	token.focus();
}

/** The services `inst` is connected to, and the ones it can be: the «Servizi» section of its configuration. */
export async function connectorsBody(inst) {
	const [{ connectors }, { catalog, oauth, redirectUrl }] = await Promise.all([api(`/api/instances/${inst.id}/connectors`), api("/api/connector-catalog")]);
	const cards = connectors.map((c) => {
		const st = c.status;
		const oauthConnector = c.transport.type === "http" && c.transport.auth === "oauth";
		const tokenEntry = catalog.find((e) => e.id === c.id && e.auth === "token" && c.transport.type === "http" && Object.keys(c.transport.headerSecrets ?? {}).length > 0);
		const chip = !c.enabled
			? h("span.chip", "Spento")
			: !c.allowed
				? h("span.chip.warn", "Non consentito")
				: st?.connected
					? h("span.chip.ok", `${st.tools.length} strumenti`)
					: st?.signIn
						? h("span.chip.warn", "Da collegare")
						: h("span.chip.bad", "Non collegato");
		return h(
			"div.card.pad.stack",
			h("div.row-gap", h("h2", c.name), chip),
			h("div.mono.muted", c.transport.type === "http" ? c.transport.url : c.transport.type === "api" ? c.transport.baseUrl : `${c.transport.command} ${(c.transport.args ?? []).join(" ")}`),
			c.transport.type === "api" ? h("p.muted", API_AUTH_WORDS[c.transport.auth?.kind ?? "none"]) : null,
			st?.error ? h("p.chip.bad", st.error) : null,
			st?.tools?.length ? h("p.mono", st.tools.join("  ")) : null,
			!st?.connected
				? null
				: c.approval === "none"
					? h("p.muted", "Approvazione spenta: Owni usa tutti gli strumenti senza chiedere.")
					: c.transport.type === "api"
						? h("p.muted", "Legge subito; prima di creare, modificare o cancellare chiede l'approvazione.")
					: !st.approval?.length
						? h("p.muted", "Tutti gli strumenti leggono soltanto: Owni li usa senza chiedere.")
						: st.approval.length === st.tools.length
							? h("p.muted", "Tutti gli strumenti chiedono l'approvazione prima di agire.")
							: h("p.muted", `Chiedono l'approvazione prima di agire: ${st.approval.map((t) => t.replace(`${c.id}__`, "")).join(", ")}.`),
			st?.left ? h("p.muted", `Il servizio ha altri ${st.left} strumenti: Owni usa i primi ${st.tools.length}, per non confondere il modello.`) : null,
			h(
				"div.row-gap",
				oauthConnector && oauth && !st?.connected && c.enabled && c.allowed
					? h("button.btn.small.accent", { onclick: () => void signInConnector(`/api/instances/${inst.id}/connectors/${c.id}/sign-in`, c.name).catch((error) => toast(error.message, true)) }, "Collega")
					: null,
				tokenEntry ? h(`button.btn.small${st?.badToken ? ".accent" : ".ghost"}`, { onclick: () => tokenDialog(inst, tokenEntry, true) }, "Cambia token") : null,
				h("button.btn.small.ghost", { onclick: () => connectorForm(inst, c) }, "Modifica"),
				h(
					"button.btn.small.danger",
					{
						onclick: () =>
							confirmDialog(
								`Rimuovere ${c.name}?`,
								oauthConnector ? "Owni perde i suoi strumenti e il suo accesso al servizio viene cancellato." : tokenEntry ? "Owni perde i suoi strumenti e il token viene cancellato." : "Owni perde i suoi strumenti, e le chiavi salvate per questo agente vengono cancellate.",
								"Rimuovi",
								async () => {
									await api(`/api/instances/${inst.id}/connectors/${c.id}`, { method: "DELETE" });
									render();
								},
							),
					},
					"Rimuovi",
				),
			),
		);
	});
	return [
		h("div.card.pad", h("h2", "Servizi collegati"), h("p.muted", `Collegano ${inst.name} agli strumenti che usate già. Ognuno raggiunge solo il suo servizio, e solo se consentito. Le chiavi sono di ${inst.name}: un altro agente collegato allo stesso servizio ha le sue.`), h("div.actions", h("button.btn.accent", { onclick: () => connectorForm(inst) }, icon("plus"), "Nuovo connettore"))),
		connectors.length ? h("div.grid-2", cards) : emptyNote("div.card.empty", "Nessun connettore", "Scegline uno qui sotto, oppure aggiungi con «Nuovo connettore» un server MCP o l'API di un servizio con la sua chiave."),
		catalogGallery(inst, catalog, oauth, redirectUrl, new Set(connectors.map((c) => c.id))),
	];
}

/** How an API's key goes, as the owner reads it. */
const API_AUTH_WORDS = {
	bearer: "Entra con un token (Authorization: Bearer).",
	header: "Entra con una chiave in un header.",
	query: "Entra con una chiave nell'indirizzo.",
	none: "Senza chiave.",
};

function connectorForm(inst, existing) {
	const t = existing?.transport;
	const id = h("input", { type: "text", value: existing?.id ?? "", placeholder: "crm", class: "mono", disabled: existing ? true : undefined });
	const name = h("input", { type: "text", value: existing?.name ?? "", placeholder: "CRM aziendale" });
	const type = h(
		"select",
		h("option", { value: "http" }, "Server MCP (HTTP)"),
		h("option", { value: "stdio", selected: t?.type === "stdio" ? "selected" : undefined }, "Server MCP locale (stdio)"),
		h("option", { value: "api", selected: t?.type === "api" ? "selected" : undefined }, "API con chiave (HTTP)"),
	);
	const baseUrl = h("input", { type: "url", value: t?.type === "api" ? t.baseUrl : "", placeholder: "https://api.example.com/v1" });
	const authKind = h(
		"select",
		[
			["bearer", "Token (Authorization: Bearer)"],
			["header", "Chiave in un header"],
			["query", "Chiave nell'indirizzo"],
			["none", "Nessuna chiave"],
		].map(([value, label]) => h("option", { value, selected: (t?.type === "api" ? (t.auth?.kind ?? "none") : "bearer") === value ? "selected" : undefined }, label)),
	);
	const authName = h("input", { type: "text", value: t?.type === "api" && t.auth && "name" in t.auth ? t.auth.name : "", placeholder: "X-API-Key", class: "mono" });
	const key = h("input", { type: "password", autocomplete: "off", placeholder: t?.type === "api" && t.secret ? "Lascia vuoto per tenere quella salvata" : "Incolla qui la chiave" });
	const notes = h("textarea", { rows: 4, maxlength: 2000, placeholder: "GET /clienti?q=… cerca un cliente; POST /fatture crea una fattura (campi: cliente, righe, data)…" }, t?.type === "api" ? (t.notes ?? "") : "");
	const url = h("input", { type: "url", value: t?.type === "http" ? t.url : "", placeholder: "https://mcp.example.com/mcp" });
	const command = h("input", { type: "text", value: t?.type === "stdio" ? [t.command, ...(t.args ?? [])].join(" ") : "", placeholder: "npx -y @modelcontextprotocol/server-filesystem /dati", class: "mono" });
	const secretName = h("input", { type: "text", placeholder: t?.type === "stdio" ? "API_KEY" : "authorization", class: "mono" });
	const secretValue = h("input", { type: "password", placeholder: "Valore (salvato nel secret store, mai mostrato)" });
	const allowed = h("input", { type: "checkbox", checked: existing ? existing.allowed : true });
	const enabled = h("input", { type: "checkbox", checked: existing ? existing.enabled : true });
	const askBox = h("input", { type: "checkbox", checked: existing?.approval !== "none" });
	const oauthBox = h("input", { type: "checkbox", checked: t?.type === "http" && t.auth === "oauth" });
	const box = h("div");
	const secretRow = h("div.field", h("span", "Header o variabile segreta (opzionale)"), h("div.row-gap", secretName, secretValue));
	const apiFields = () => {
		const named = authKind.value === "header" || authKind.value === "query";
		authName.placeholder = authKind.value === "query" ? "api_key" : "X-API-Key";
		return h(
			"div.stack",
			h("label.field", h("span", "Indirizzo base"), baseUrl, h("small", "Owni chiama solo indirizzi sotto questo, e solo questo servizio.")),
			h("label.field", h("span", "Accesso"), authKind),
			named ? h("label.field", h("span", authKind.value === "query" ? "Nome del parametro" : "Nome dell'header"), authName) : null,
			authKind.value === "none" ? null : h("label.field", h("span", "Chiave"), key, h("small", `Resta sul server di Owni, non si vede più e non arriva mai al modello. È solo di ${inst.name}.`)),
			h("label.field", h("span", "Cosa sa fare (per l'agente)"), notes, h("small", "Gli indirizzi principali e a cosa servono, come nella documentazione del servizio. Owni legge subito; per scrivere chiede l'approvazione.")),
		);
	};
	const draw = () => {
		mount(
			box,
			type.value === "http"
				? h("div.stack", h("label.field", h("span", "URL"), url), h("label.row-gap", oauthBox, h("span", "Accesso con l'account del servizio (OAuth)")))
				: type.value === "api"
					? apiFields()
					: h("label.field", h("span", "Comando"), command, h("small", "Gira sul server di Owni: solo comandi di cui ti fidi.")),
		);
		secretRow.hidden = type.value === "api";
	};
	type.addEventListener("change", draw);
	authKind.addEventListener("change", draw);
	draw();
	const dialog = h(
		"dialog",
		h("h2", existing ? `Modifica ${existing.name}` : "Nuovo connettore"),
		h("label.field", h("span", "ID"), id, h("small", "lettere minuscole, cifre, trattini")),
		h("label.field", h("span", "Nome"), name),
		h("label.field", h("span", "Tipo"), type),
		box,
		secretRow,
		h("label.row-gap", allowed, h("span", "Consenti nella egress policy")),
		h("label.row-gap", enabled, h("span", "Acceso")),
		h("label.row-gap", askBox, h("span", "Chiedi l'approvazione prima delle azioni che cambiano qualcosa")),
		h("small.muted", "Consigliato. Per creare, modificare o cancellare, Owni chiede il via libera a chi ha fatto la richiesta o a un approvatore; gli strumenti che il servizio indica come di sola lettura li usa da sola (per un'API: le richieste GET). Se un server MCP non lo indica, chiede per tutti. Spegnilo solo per un servizio di cui ti fidi del tutto."),
		h(
			"div.actions",
			h(
				"button.btn.accent",
				{
					onclick: async () => {
						const cid = id.value.trim();
						try {
							const secrets = {};
							if (type.value !== "api" && secretName.value.trim() && secretValue.value) {
								// Named after this agente: another one with a connector of the same ID keeps its own.
								const secret = `connector.${cid}.${inst.id}.${secretName.value.trim().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
								await api(`/api/instances/${inst.id}/secrets/${encodeURIComponent(secret)}`, { method: "PUT", body: { value: secretValue.value } });
								secrets[secretName.value.trim()] = secret;
							}
							const prev = existing?.transport ?? {};
							const transport =
								type.value === "http"
									? { type: "http", url: url.value.trim(), headerSecrets: { ...(prev.type === "http" ? prev.headerSecrets : {}), ...secrets }, ...(oauthBox.checked ? { auth: "oauth" } : {}) }
									: type.value === "api"
										? { type: "api", baseUrl: baseUrl.value.trim(), ...(authKind.value === "none" ? {} : { auth: { kind: authKind.value, ...(authKind.value === "bearer" ? {} : { name: authName.value.trim() }) } }), notes: notes.value }
										: (() => {
												const [cmd, ...args] = command.value.trim().split(/\s+/);
												return { type: "stdio", command: cmd, args, envSecrets: { ...(prev.type === "stdio" ? prev.envSecrets : {}), ...secrets } };
											})();
							const { status } = await api(`/api/instances/${inst.id}/connectors/${encodeURIComponent(cid)}`, { method: "PUT", body: { name: name.value.trim() || cid, transport, ...(type.value === "api" && key.value.trim() ? { key: key.value.trim() } : {}), enabled: enabled.checked, allowed: allowed.checked, ...(askBox.checked ? {} : { approval: "none" }) } });
							dialog.close();
							if (type.value === "http" && oauthBox.checked && status?.signIn && allowed.checked && enabled.checked) return await signInConnector(`/api/instances/${inst.id}/connectors/${encodeURIComponent(cid)}/sign-in`, name.value.trim() || cid);
							toast(status?.connected ? `Collegato: ${status.tools.length} tool` : `Salvato${status?.error ? `, ma non collegato: ${status.error}` : ""}`, !status?.connected);
							render();
						} catch (error) {
							toast(error.message, true);
						}
					},
				},
				"Salva e collega",
			),
			h("button.btn.ghost", { onclick: () => dialog.close() }, "Annulla"),
		),
	);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}

