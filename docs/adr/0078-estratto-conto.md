# Estratto conto

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `bank_statement` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Scadenzario (ADR 0053), spese (ADR 0057), rinnovi (ADR 0064) e previsione di cassa (ADR 0065) sapevano cosa doveva entrare e uscire, ma solo la persona sapeva cosa era successo davvero sul conto, e doveva dirlo fattura per fattura. La banca lo scrive già nell'estratto conto. Ora «ti mando l'estratto conto di ottobre», «quali movimenti non hanno una spiegazione?», «quanto è entrato a ottobre sul conto?» e «Rossi ha pagato?» hanno una risposta, e le fatture si segnano incassate con un sì.

## Decisione

- **Strumento `bank_statement`** con `import`, `summary`, `list`, `totals`, `anomalies`, `confirm`, `refuse`, `to_expense`, `set_balance`, `settings`, `export`, `same` e `remove_import`. Movimenti, importazioni e abbinamenti stanno in `bank.json` nella cartella dell'istanza, con la copia `.bak`, attraverso `json-book.ts`: 20.000 movimenti (i più vecchi se ne vanno con i loro abbinamenti), 300 importazioni, 16 MB. Movimenti B-NNNNNN mai riusati.
- **Il file lo manda la persona.** CSV ed Excel come li esportano le banche italiane, e CAMT.053. Owni non si collega alla banca. Colonne riconosciute per nome (data contabile e valuta, descrizione e causale unite, importo unico o Dare e Avere); se non sono chiare Owni mostra ogni colonna con i primi valori e chiede, come chiede se le date sono giorno/mese o mese/giorno e se «1,200» sono mille e duecento. Un valore negativo in Avere è un'uscita; una riga con Dare e Avere tutti e due pieni resta fuori ed è detta. In CAMT le voci e i saldi non in euro restano fuori e sono contati.
- **Mai due volte lo stesso movimento.** Ogni movimento ha un'impronta di data, importo e descrizione, senza il saldo progressivo. Un file caricato di nuovo con lo stesso formato si riconosce dall'impronta, e due righe uguali nello stesso file restano due. Fra formati diversi (CSV e CAMT dello stesso mese) un movimento con stessa data, importo e segno e una parola in comune che non sia generica («bonifico», «pagamento», «addebito») è «forse già caricato»: Owni lo carica e lo dice, e `same` toglie la copia dopo il sì. `remove_import` toglie un'importazione sbagliata finché nessun suo movimento è confermato.
- **Una copia tolta resta tolta**: `same` tiene l'impronta della copia sul movimento che resta, e `remove_import` lascia i movimenti che ci sono anche in un file caricato dopo, passandoli a quello.
- **Ogni movimento trova la sua spiegazione**, in quest'ordine: fattura da incassare o da pagare dello scadenzario, spesa già registrata (stesso importo entro 5 giorni), addebito di un rinnovo, F24 (solo dalle parole della banca: «F24», «delega», «Agenzia delle Entrate»), giroconto fra i conti della persona, prelievo. Un abbinamento è sicuro solo con la partita IVA, o con un nome di almeno due parole in qualsiasi ordine (anche troncato nell'ultima parola), o con un nome di una parola insieme al numero della fattura. Se coincide solo l'importo l'abbinamento è debole e si chiede uno per uno, con importo e data. Due fatture uguali: la più vecchia, e lo dice. Un importo minore di una fattura nominata è un «forse un acconto»: la fattura resta aperta.
- **Niente cambia negli altri registri senza il sì.** `confirm` segna la fattura incassata o pagata nel giorno della banca attraverso lo scadenzario, con la fonte «banca»; `to_expense` registra le spese (le commissioni nella categoria «banca e commissioni») e chiede prima se una spesa uguale c'è già; `set_balance` salva il saldo di chiusura nella previsione di cassa. Gli abbinamenti deboli si confermano solo per numero.
- **Previsione di cassa.** Un saldo che viene dall'estratto conto contiene tutti i movimenti fino al suo giorno: una fattura segnata a mano dopo che il saldo è stato salvato si porta avanti, tranne quando nell'estratto c'è un movimento con lo stesso importo fra la data della fattura e il giorno del saldo che non spiega altro. Una fattura con data dopo il saldo si porta sempre avanti. Salvando il saldo Owni avvisa di queste fatture.
- **Brief**: se l'ultimo estratto conto arriva a più di 35 giorni fa chiede il resto, e dice quanti abbinamenti aspettano un sì. Non scrive mai.
- **Export** CSV in `banca/` del workspace con i movimenti abbinati e la loro spiegazione, per il commercialista.

## Sicurezza e concorrenza

- Il file non è mai fidato: 5 MB, 5.000 righe, celle di 300 caratteri, caratteri di controllo tolti. IBAN e numeri di carta nelle descrizioni e nelle intestazioni vengono mascherati prima di salvare qualsiasi cosa (dell'IBAN restano le ultime 4 cifre). Le descrizioni tornano al modello solo dentro un recinto dei dati non fidati per risposta; celle del CSV protette dalle formule.
- Ogni scrittura passa da `updateBook` sotto il lock; una chiamata ripetuta non scrive due volte. Un `bank.json` rovinato non viene mai sovrascritto.
- Dal canale degli agenti solo `totals`, numeri per mese senza descrizioni; il brief usa solo `summary`. L'audit registra operazione e conteggi, mai descrizioni, importi, date o IBAN.

## Alternative scartate

- **Leggere il conto in banca (PSD2)**: serve un aggregatore autorizzato e il consenso ogni 180 giorni; il file che la banca dà già basta.
- **Segnare le fatture incassate da soli**: un bonifico con lo stesso importo di un'altra fattura avrebbe chiuso la fattura sbagliata, e il sollecito non sarebbe partito.
- **Riconoscere gli F24 con le parole delle tasse**: «rivalsa INPS» o «saldo IVA» nella causale di un cliente diventavano un F24.
- **Scartare i movimenti che somigliano a uno già caricato**: due bonifici veri dello stesso importo nello stesso giorno sparivano; meglio caricarli e chiedere.
