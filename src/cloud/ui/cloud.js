// Owni Cloud: sign up and sign in by email link; with billing, the trial and the subscription.
// Text is set with textContent only; Stripe's pages are reached only through links the server made.

const $status = document.getElementById("status");
const $form = document.getElementById("signup");
const $title = document.getElementById("title");
const $lead = document.getElementById("lead");
const $forBilling = document.getElementById("for-billing");
const $forBillingRow = document.getElementById("for-billing-row");
const params = new URLSearchParams(location.search);
let purpose = "signin";
let billingOn = false;
// The subscription link only where Owni Cloud has billing.
fetch("/api/info")
	.then((res) => res.json())
	.then((info) => {
		billingOn = info.billing === true;
		if (billingOn && location.pathname !== "/verify" && purpose !== "billing") $forBillingRow.hidden = false;
	})
	.catch(() => {});
async function post(path, body) {
	const res = await fetch(path, { method: "POST", headers: { "x-owni": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `Errore ${res.status}`);
	return data;
}

const rome = (iso) => new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", dateStyle: "long" }).format(new Date(iso));

function link(id, url) {
	const a = document.getElementById(id);
	a.hidden = !url;
	if (url) a.href = url;
}

/** Where the tenant stands, and the ways on: subscribe, manage, or go to Owni. */
function showBilling(loginUrl, billing) {
	$form.hidden = true;
	$forBillingRow.hidden = true;
	const text = {
		trial: ["Sei in prova", `La prova gratuita dura fino al ${rome(billing.trialEndsAt)}. Puoi attivare l'abbonamento quando vuoi.`],
		active: ["Abbonamento attivo", "Da qui trovi fatture, carta e disdetta."],
		past_due: ["Pagamento non riuscito", "Owni continua a lavorare, ma il rinnovo non è andato a buon fine: aggiorna la carta."],
		ended: ["La prova è finita", "Owni è in pausa e i tuoi dati sono al sicuro. Attiva l'abbonamento per riprendere da dove avevi lasciato."],
	}[billing.state];
	$title.textContent = text[0];
	$lead.textContent = text[1];
	link("checkout", billing.checkoutUrl);
	link("portal", billing.portalUrl);
	link("enter", loginUrl);
	document.getElementById("billing").hidden = false;
	if (!billing.checkoutUrl && !billing.portalUrl && !loginUrl) $status.textContent = "Il servizio di pagamento non risponde: riprova tra poco con un nuovo link.";
}

if (location.pathname === "/verify") {
	const token = location.hash.slice(1);
	const forBilling = params.get("per") === "abbonamento";
	history.replaceState(null, "", "/verify");
	$form.hidden = true;
	$forBillingRow.hidden = true;
	$title.textContent = "Un momento";
	$lead.textContent = "Sto preparando la tua Owni. La prima volta può volerci qualche secondo.";
	post("/api/verify", { token, purpose: forBilling ? "billing" : "signin" })
		.then(({ loginUrl, billing }) => {
			if (loginUrl && (!billing || (!forBilling && !billing.checkoutUrl && !billing.portalUrl))) return location.replace(loginUrl);
			showBilling(loginUrl, billing);
		})
		.catch((error) => {
			$title.textContent = "Il link non funziona";
			$status.textContent = error.message;
			$form.hidden = false;
			$forBillingRow.hidden = !billingOn;
		});
} else if (params.get("sospesa") === "1") {
	$title.textContent = "Owni è in pausa";
	$lead.textContent = "La prova gratuita è finita. Scrivi la tua email: ti mando il link per attivare l'abbonamento, e Owni riprende da dove si era fermata.";
	purpose = "billing";
} else if (params.get("abbonamento") === "attivo") {
	$title.textContent = "Grazie, l'abbonamento è attivo";
	$lead.textContent = "Torna a Owni dal tuo link, oppure chiedine uno nuovo qui sotto.";
}

$forBilling.addEventListener("click", (event) => {
	event.preventDefault();
	purpose = "billing";
	$title.textContent = "Il tuo abbonamento";
	$lead.textContent = "Scrivi l'email con cui sei registrato: ti mando il link per vedere prova, fatture e pagamento.";
	$forBillingRow.hidden = true;
});

$form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const email = document.getElementById("email").value.trim();
	$status.textContent = "";
	try {
		await post("/api/signup", { email, purpose });
		$form.hidden = true;
		$forBillingRow.hidden = true;
		$title.textContent = "Controlla la posta";
		$lead.textContent = `Ti ho mandato un link a ${email}. Vale 30 minuti.`;
	} catch (error) {
		$status.textContent = error.message;
	}
});
