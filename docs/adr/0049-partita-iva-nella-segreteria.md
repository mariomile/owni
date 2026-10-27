# Partita IVA nella segreteria

> Sostituito dall'[ADR 0126](0126-togliere-la-segreteria-commerciale.md): la segreteria non c'è più; la partita IVA si controlla con `vat_check` ([ADR 0047](0047-partita-iva.md)).

La segreteria legge le mail dei clienti e prepara la bozza di risposta. Fino alla settimana 45 prendeva la partita IVA scritta nella mail così com'era: un numero con una cifra sbagliata finiva nella pratica e nel CRM, e la fattura sarebbe partita con un dato falso.

## Decisione

- **Controllo formale, mai il VIES.** La segreteria usa `checkVatNumber` di `src/core/tax-ids.ts` (ADR 0047): cifra di controllo e ufficio IVA per l'Italia, forma per i paesi del VIES, forma e cifre di controllo per Regno Unito, Svizzera e Norvegia, forma per San Marino. I numeri arrivano da mail di terzi: niente rete e niente quota.
- **Un numero sbagliato non si salva.** `vatNumber` resta vuoto e la pratica ha il dato mancante `vatNumberInvalid`. Il cliente lo ha scritto, quindi la bozza chiede di ricontrollarlo anche se l'account non richiede la partita IVA e anche a un privato; non chiede due volte (o «ricontrolli» o «ci indichi»).
- **La bozza non ripete il numero.** La regola A7 vieta i codici fiscali nelle bozze; la segreteria toglie dalla bozza del modello il numero come scritto nella mail (letto sia dal modello sia dalla mail), e `scrubPii` toglie ogni numero dopo un'etichetta IVA e i numeri con il prefisso di un paese che passano il controllo. Numeri d'ordine, codici prodotto, date e importi restano.
- **La richiesta è un paragrafo a parte**, dopo le altre domande: «Le segnaliamo che la partita IVA indicata non risulta corretta: può cortesemente ricontrollarla e inviarcela di nuovo?».
- **Chi approva lo sa**: la scheda su Telegram dice «P.IVA sbagliata: non l'ho salvata, nella bozza chiedo al cliente di ricontrollarla.», e la nota su HubSpot «P.IVA da ricontrollare».
- **Cosa non è una partita IVA**: un codice fiscale di persona (giusto o sbagliato) e le parole che il modello scrive al posto di un numero («N/A», «da chiedere») sono ignorati, così la segreteria non chiede di «ricontrollare» un numero mai dato. I codici numerici degli enti (8 o 9) sono accettati: sono il codice con cui l'ente riceve le fatture.
- **Lettura della mail** (`src/segreteria/vat.ts`): etichette italiane ed europee («P.IVA/C.F.», «VAT No.», «USt-IdNr.»), separatori tolti; importi, date e cellulari non contano; fra più numeri vince quello giusto, e se il modello sbaglia una cifra vince la lettura della mail.

## Alternative scartate

- **Il VIES**: numeri di terzi, quota del server, e «non attiva» non vuol dire sbagliata.
- **Ripetere il numero nella bozza** per aiutare il cliente a trovare l'errore: va contro la regola sui dati fiscali nelle bozze, e il commerciale ha la mail originale.
- **Segnalare il numero ma salvarlo lo stesso**: un dato sbagliato nel CRM viene copiato in fattura.
