# Settimane 11 e 12: la spesa per tenant e l'abbonamento

Branch `week-11` (PR #11, su `main`) e `week-12`. Decisione: [ADR 0010](adr/0010-abbonamento-stripe-con-prova.md). Fase 4 del [piano](piano-cloud.md).

## Settimana 11: `pnpm cloud status`

- Per ogni tenant: email, data di registrazione, stato della cella, prossimo risveglio e spesa stimata sul modello di oggi, del mese e del mese scorso, in ora di Roma (`test/cloud.test.ts`).
- Le celle accese vengono interrogate. Per quelle che dormono si mostra l'ultima lettura, senza svegliarle.
- Il control plane conserva la spesa di ogni mese, anche di quelli chiusi: un mese finito si può ancora fatturare. Le letture si uniscono (vince il giorno più recente, un mese può solo crescere).
- Con Railway il comando, lanciato da un altro processo, non fa più risultare spente le celle sveglie.

## Settimana 12: l'abbonamento (verificato dai test, con un finto Stripe)

- **Prova, poi abbonamento**: alla registrazione parte la prova (`OWNI_CLOUD_TRIAL_DAYS`, 14 giorni di default). Finita senza abbonamento, la cella resta spenta. Una pagina rimanda a quella di registrazione («Owni è in pausa»), un'API risponde 402, i webhook di Telegram non la svegliano e nemmeno i task programmati. I dati restano.
- **Abbonarsi e gestire**: con lo stesso link via email dell'accesso. Chi ha finito la prova riceve il link a Checkout di Stripe. «Gestisci l'abbonamento» porta a Checkout o al portale clienti (fatture, carta, disdetta). La carta la vede solo Stripe.
- **Webhook firmati** (`/stripe/webhook`): firma HMAC-SHA256 di Stripe, al massimo 5 minuti di età. Una firma sbagliata o mancante risponde 400 e non cambia niente. Lo stato dell'abbonamento si rilegge da Stripe a ogni evento. «Pagamento in ritardo» lascia Owni accesa, «annullato» o «non pagato» la sospende.
- **Consumo a contatore** (facoltativo): il costo del modello di ogni tenant abbonato va a un Billing Meter di Stripe in centesimi di dollaro, solo quello successivo all'abbonamento. Ogni invio ha un identificativo, quindi un nuovo tentativo non conta due volte. Le celle accese si leggono almeno una volta l'ora.
- **Abbonarsi in prova** tiene i giorni restanti: Stripe addebita alla fine della prova.
- **Prezzo come configurazione**: quota fissa, prezzo per unità di consumo, valuta, IVA e coupon si impostano su Stripe, senza toccare il codice.
- **`pnpm cloud status`** mostra anche lo stato: in prova fino a quando, abbonato, pagamento in ritardo, sospeso.
- Senza `OWNI_CLOUD_STRIPE_SECRET_KEY` non cambia niente: Owni Cloud resta gratuito.

## Review indipendente

Due revisori separati (standard e sicurezza, aderenza al piano). Corretti:

- **Alta.** Se Stripe mandava l'evento dell'abbonamento prima di quello del checkout, la spesa fatta in prova finiva in fattura. Ora i mesi della prova contano come già inviati la prima volta che il tenant ha un cliente, in qualunque ordine arrivino gli eventi (c'è un test). Un evento di un secondo abbonamento dello stesso tenant poteva sospendere chi pagava: ora non scavalca mai quello vivo. Eventi nello stesso secondo potevano applicarsi nell'ordine sbagliato: ora lo stato si chiede ogni volta a Stripe. Su Railway una cella era raggiungibile direttamente, saltando il controllo dell'abbonamento: ora risponde solo alle richieste passate dal control plane.
- **Media.** Chi si abbonava in prova perdeva i giorni restanti (ora `trial_end`). Due link di pagamento aperti potevano dare due abbonamenti (ora il nuovo fa scadere il vecchio). Annullare in prova non sospendeva. Una cella accesa a fine prova restava su fino al tempo di inattività. Il consumo di un mese chiuso poteva cadere in un periodo già fatturato (ora si data all'invio). Un invio fallito non si ritentava. `pnpm cloud status` voleva le variabili Stripe nella shell. Spegnere e riaccendere la fatturazione chiudeva tutte le prove. Il test della firma falsificata falliva una volta su sedici.
- **Bassa.** Un url mancante nella risposta di Stripe diventava il link «undefined». Un evento firmato con `object: null` dava 500. I prefissi di chiavi e prezzi non venivano controllati all'avvio. Gestire l'abbonamento svegliava la cella.

## Limiti

| Cosa | Limite |
|---|---|
| Prova dal vivo | fatta solo contro un finto Stripe: serve un giro in modalità test con le chiavi `sk_test_…` (docs/chiavi.md, punto 8) |
| Cifre | prezzo e durata della prova sono una decisione di Mario |
| Consumo durante la prova | la spesa fatta in prova ma letta dopo la conferma del checkout finisce nel primo periodo pagato |
| Railway | una richiesta diretta all'indirizzo Railway di una cella sospesa riceve 404, ma sveglia il servizio: i task in scadenza girano finché Railway non lo rimette a dormire |
| Doppio abbonamento | se qualcuno paga due volte, il secondo abbonamento non conta e finisce nel log: rimborso e annullamento si fanno a mano su Stripe |
| Fatturazione elettronica italiana | Stripe emette le fatture, ma da verificare se le trasmette da solo allo SdI; altrimenti serve un servizio collegato |
| Cancellazione dei dati | un tenant sospeso tiene la sua cella spenta; cancellarla resta un'operazione manuale |
