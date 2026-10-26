# Fatture in uscita

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `sales_invoices` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Con preventivi (ADR 0055), ore (ADR 0058), clienti (ADR 0071) e tasse (ADR 0070) Owni sapeva cosa fatturare e a chi, ma la fattura la faceva la persona con un altro programma. Ora «fammi la fattura a Rossi per il preventivo 4», «fattura a Beta le ore di ottobre», «fattura a Gamma: consulenza 1.500 €», «nota di credito per la fattura 12» e «le fatture che mi hai fatto quest'anno» hanno una risposta: una fattura elettronica XML pronta da caricare, con la copia di cortesia in PDF.

## Decisione

- **Strumento `sales_invoices`** con `draft`, `credit_note`, `show`, `list`, `issue`, `finish`, `remove` e `settings`. Bozze e fatture stanno in `sales-invoices.json` nella cartella dell'istanza, con la copia `.bak`, attraverso `json-book.ts`; i file in `fatture/emesse/` del workspace, mai sovrascritti.
- **Prima la bozza, poi il sì.** `issue` senza conferma mostra la fattura e chiede; con la conferma prende il numero. Una bozza non prende numeri e toglierla non ne consuma.
- **Numerazione**: progressiva per anno solare, fatture e note di credito insieme, «12» o «2026/12». Il numero è il più alto fra il contatore e l'ultimo numero detto dalla persona più uno, sotto il lock. I file in `fatture/emesse/` del venditore servono solo a proporre il punto di partenza («nei tuoi file l'ultima è la 17: questa sarà la 18, va bene?») e ad avvisare: un XML qualsiasi nel workspace non sposta mai il numero. La data non può essere precedente all'ultima fattura dell'anno.
- **Dati del venditore** dagli stessi dati dell'azienda della carta intestata (`invoices` `set_company`), più regime e IBAN; **cliente** dalla scheda cliente, dal preventivo o dall'ultima fattura, con partita IVA o codice fiscale, indirizzo e codice destinatario o PEC (0000000 per un privato, XXXXXXX per l'estero, 6 caratteri per la PA con FPA12). Quello che manca è chiesto tutto in una volta, in tre gruppi («su di te», «sul cliente», «su questa fattura»), mai inventato.
- **Calcoli** in centesimi esatti: righe, riepiloghi per aliquota o natura con l'IVA arrotondata per riepilogo, cassa previdenziale (rivalsa INPS 4% o contributo integrativo) sui soli compensi, ritenuta d'acconto (20%, causale A) sui compensi e sulla cassa se soggetta, solo verso aziende e PA, bollo virtuale di 2,00 € oltre 77,47 € di importi senza IVA, a carico del cliente se la persona lo dice. Spese anticipate (N1) fuori da cassa e ritenuta. Forfettario: N2.2 e la dicitura della legge 190/2014, niente IVA né ritenuta.
- **Note di credito** (TD04) solo sulle aliquote della fattura originale e fino a quanto resta da stornare per riepilogo; nello scadenzario compensano la fattura, senza segnarla incassata.
- **Da preventivo e ore**: il preventivo risulta fatturato, le ore segnate con la fattura; se cambiano fra bozza e emissione, Owni rifà la bozza. Se il cliente ha un preventivo accettato non fatturato, la bozza lo ricorda.
- **Emissione a passi**: XML, PDF, ore, preventivo. Una fattura con il numero ma senza tutti i passi si completa con `finish` (o `issue` senza bozza), con lo stesso numero; senza PDF la fattura è valida lo stesso.
- **Niente invio allo SdI**: serve un intermediario accreditato. Owni dice come caricare il file sul portale «Fatture e Corrispettivi» entro 12 giorni e come mandare la copia al cliente con la mail che parte solo dopo l'approvazione.
- Regole, aliquote, codici e limiti dei campi stanno in `sales-invoice-rules.ts` con la fonte; dove la prassi varia c'è «da verificare».

## Sicurezza e concorrenza

- Ogni scrittura passa da `updateBook` sotto il lock e riconosce la stessa chiamata ripetuta; togliere una bozza e il limite delle note di credito sono ricontrollati sotto il lock. Un `sales-invoices.json` rovinato non viene mai sovrascritto.
- L'XML è scritto nell'ordine dello schema 1.2.2, con escape, solo caratteri Latin-1, senza caratteri di controllo e con i limiti dei campi; i test lo rileggono con il lettore di ADR 0052.
- Nomi dei clienti e descrizioni tornano al modello solo dentro il recinto dei dati non fidati. L'audit registra operazione e numero, una volta per fattura, mai nomi, importi, numeri o date.
- Dal canale degli agenti solo `list`, ridotto a conteggi e totali; il brief legge soltanto.

## Alternative scartate

- **Prendere il numero dai file del workspace**: un allegato qualsiasi con la partita IVA del venditore (che è pubblica) poteva spostare la numerazione a 99.999 o bloccarla per un anno.
- **Mandare allo SdI via PEC**: serve l'accreditamento del canale e la gestione delle ricevute; un intermediario si aggiunge quando c'è.
- **Numerare le bozze**: ogni bozza tolta lasciava un buco nella numerazione.
