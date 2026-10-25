// Connettori page.
import { agentLabel, api, confirmDialog, emptyNote, h, head, icon, monogram, mount, needInstance, state, store, toast } from "../common.js";
import { render } from "../shell.js";

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

export async function viewConnectors(main) {
	if (needInstance(main)) return;
	const inst = state.instance;
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
			h("div.mono.muted", c.transport.type === "http" ? c.transport.url : `${c.transport.command} ${(c.transport.args ?? []).join(" ")}`),
			st?.error ? h("p.chip.bad", st.error) : null,
			st?.tools?.length ? h("p.mono", st.tools.join("  ")) : null,
			!st?.connected
				? null
				: c.approval === "none"
					? h("p.muted", "Approvazione spenta: Owni usa tutti gli strumenti senza chiedere.")
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
								oauthConnector ? "Owni perde i suoi strumenti e il suo accesso al servizio viene cancellato." : tokenEntry ? "Owni perde i suoi strumenti e il token viene cancellato." : "Owni perde i suoi strumenti. I valori segreti restano salvati sul server.",
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
	mount(main, 
		head(agentLabel(inst), h("h1", "Connettori"), `Collegano ${inst.name} agli strumenti che usate già. Ognuno raggiunge solo il suo servizio, e solo se consentito.`, h("button.btn.accent", { onclick: () => connectorForm(inst) }, icon("plus"), "Nuovo connettore")),
		connectors.length ? h("div.grid-2", cards) : emptyNote("div.card.empty", "Nessun connettore", "Scegline uno qui sotto, oppure aggiungi un altro server MCP (HTTP o locale) con «Nuovo connettore»."),
		catalogGallery(inst, catalog, oauth, redirectUrl, new Set(connectors.map((c) => c.id))),
	);
}

function connectorForm(inst, existing) {
	const t = existing?.transport;
	const id = h("input", { type: "text", value: existing?.id ?? "", placeholder: "crm", class: "mono", disabled: existing ? true : undefined });
	const name = h("input", { type: "text", value: existing?.name ?? "", placeholder: "CRM aziendale" });
	const type = h("select", h("option", { value: "http" }, "HTTP (Streamable HTTP)"), h("option", { value: "stdio", selected: t?.type === "stdio" ? "selected" : undefined }, "Locale (stdio)"));
	const url = h("input", { type: "url", value: t?.type === "http" ? t.url : "", placeholder: "https://mcp.example.com/mcp" });
	const command = h("input", { type: "text", value: t?.type === "stdio" ? [t.command, ...(t.args ?? [])].join(" ") : "", placeholder: "npx -y @modelcontextprotocol/server-filesystem /dati", class: "mono" });
	const secretName = h("input", { type: "text", placeholder: t?.type === "stdio" ? "API_KEY" : "authorization", class: "mono" });
	const secretValue = h("input", { type: "password", placeholder: "Valore (salvato nel secret store, mai mostrato)" });
	const allowed = h("input", { type: "checkbox", checked: existing ? existing.allowed : true });
	const enabled = h("input", { type: "checkbox", checked: existing ? existing.enabled : true });
	const askBox = h("input", { type: "checkbox", checked: existing?.approval !== "none" });
	const oauthBox = h("input", { type: "checkbox", checked: t?.type === "http" && t.auth === "oauth" });
	const box = h("div");
	const draw = () =>
		mount(
			box,
			type.value === "http"
				? h("div.stack", h("label.field", h("span", "URL"), url), h("label.row-gap", oauthBox, h("span", "Accesso con l'account del servizio (OAuth)")))
				: h("label.field", h("span", "Comando"), command, h("small", "Gira sul server di Owni: solo comandi di cui ti fidi.")),
		);
	type.addEventListener("change", draw);
	draw();
	const dialog = h(
		"dialog",
		h("h2", existing ? `Modifica ${existing.name}` : "Nuovo connettore"),
		h("label.field", h("span", "ID"), id, h("small", "lettere minuscole, cifre, trattini")),
		h("label.field", h("span", "Nome"), name),
		h("label.field", h("span", "Tipo"), type),
		box,
		h("div.field", h("span", type.value === "stdio" ? "Variabile segreta (opzionale)" : "Header segreto (opzionale)"), h("div.row-gap", secretName, secretValue)),
		h("label.row-gap", allowed, h("span", "Consenti nella egress policy")),
		h("label.row-gap", enabled, h("span", "Acceso")),
		h("label.row-gap", askBox, h("span", "Chiedi l'approvazione prima delle azioni che cambiano qualcosa")),
		h("small.muted", "Consigliato. Per creare, modificare o cancellare, Owni chiede il via libera a chi ha fatto la richiesta o a un approvatore; gli strumenti che il servizio indica come di sola lettura li usa da sola. Se il servizio non lo indica, chiede per tutti. Spegnilo solo per un servizio di cui ti fidi del tutto."),
		h(
			"div.actions",
			h(
				"button.btn.accent",
				{
					onclick: async () => {
						const cid = id.value.trim();
						try {
							const secrets = {};
							if (secretName.value.trim() && secretValue.value) {
								const key = `connector.${cid}.${secretName.value.trim().replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
								await api(`/api/instances/${inst.id}/secrets/${encodeURIComponent(key)}`, { method: "PUT", body: { value: secretValue.value } });
								secrets[secretName.value.trim()] = key;
							}
							const prev = existing?.transport ?? {};
							const transport =
								type.value === "http"
									? { type: "http", url: url.value.trim(), headerSecrets: { ...(prev.type === "http" ? prev.headerSecrets : {}), ...secrets }, ...(oauthBox.checked ? { auth: "oauth" } : {}) }
									: (() => {
											const [cmd, ...args] = command.value.trim().split(/\s+/);
											return { type: "stdio", command: cmd, args, envSecrets: { ...(prev.type === "stdio" ? prev.envSecrets : {}), ...secrets } };
										})();
							const { status } = await api(`/api/instances/${inst.id}/connectors/${encodeURIComponent(cid)}`, { method: "PUT", body: { name: name.value.trim() || cid, transport, enabled: enabled.checked, allowed: allowed.checked, ...(askBox.checked ? {} : { approval: "none" }) } });
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

