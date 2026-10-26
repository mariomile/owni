# Schede dei fornitori

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `suppliers` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Con la settimana 57 Owni sapeva tutto dei clienti, ma dei fornitori sapeva solo quello che stava sparso fra fatture ricevute, spese, rinnovi ed estratto conto. «Quanto ho speso con Aruba quest'anno?», «chi sono i miei fornitori principali?», «pago in ritardo qualcuno?» non avevano una risposta sola. E l'IBAN di un fornitore che cambia su una fattura, il segnale più comune di una truffa sui pagamenti, non lo notava nessuno.

## Decisione

- **Strumento `suppliers`** con `summary`, `top`, `late`, `note_add`, `note_remove`, `contact_set`, `merge` ed `export`. Le schede FO-NNNN stanno in `suppliers.json` attraverso `json-book.ts` (lock, copia `.bak`, file rovinato mai sovrascritto, id mai riusati) e tengono solo quello che dice la persona: note, referenti, grafie unite, IBAN, partita IVA o codice fiscale dettati. Tutto il resto si legge ogni volta da fatture ricevute, spese, rinnovi ed estratto conto, senza scriverli.
- **Spesa contata una volta**: la regola dell'andamento dell'attività, cioè le spese più le rate pagate ai fornitori che nessuna spesa rappresenta; i possibili doppioni si contano tutti e due e si dicono. I rinnovi contano solo attraverso la loro spesa.
- **Chi è chi**: prima la partita IVA o il codice fiscale, poi il nome; un nome simile si chiede sempre, anche per leggere. Due fornitori con partite IVA diverse non si uniscono mai, e una partita IVA dettata che è di un altro fornitore o diversa da quella delle sue fatture viene rifiutata. Le parti in comune con i clienti stanno in `party-groups.ts` e `party-cards.ts` (raggruppamento, unione delle schede, nomi simili) invece che in copie.
- **IBAN**: ogni IBAN di ogni rata da pagare si confronta con quelli già pagati, o con quello dettato dalla persona; l'ordine delle date non conta, perché lo decide chi scrive la fattura. Un IBAN mai pagato si mostra come tale; più IBAN diversi senza riferimento si chiedono tutti. Un documento non cambia mai l'IBAN dettato.
- **Fornitore con lo stesso nome e un'altra partita IVA**: se non ha mai ricevuto un pagamento, non ha spese con la sua partita IVA e la persona non l'ha confermato dettando IBAN o partita IVA, Owni avvisa di verificare per telefono prima di pagare. Una scheda nata da una nota non conferma niente (`taxFrom`), neanche dopo un'unione.
- **Giorni di pagamento**: dalla data della fattura al pagamento (segnato nello scadenzario o abbinato e confermato nell'estratto conto); in ritardo è dopo il giorno lavorativo della scadenza.
- **Brief**: una riga sola quando un fornitore con una fattura da pagare entro 7 giorni ha un IBAN diverso da quello che si conosce, o lo stesso nome di un altro fornitore; mai l'IBAN, il nome solo nel recinto.
- Correzione collegata: le schede dei clienti rifiutano ora anche un codice fiscale già di un altro cliente.

## Sicurezza

- Nomi, IBAN e referenti solo nel recinto dei dati non fidati. Note e referenti solo come li dice la persona, mai da una mail, un file o una fattura.
- Dal canale degli agenti solo `summary` e `top`, a totali e quote senza nomi, IBAN o contatti. L'audit registra operazione e conteggio. CSV con celle protette dalle formule, mai sovrascritto, senza il testo delle note.

## Alternative scartate

- **Confrontare l'ultima fattura con la precedente**: una fattura retrodatata o una seconda rata su un altro IBAN passavano senza avviso.
- **Prendere come riferimento l'IBAN più usato**: due fatture false bastavano per far sembrare sospetta quella vera.
- **Considerare confermato un fornitore con una scheda qualsiasi**: una nota o una spesa con solo il nome finiva sul fornitore sbagliato e spegneva l'avviso.
