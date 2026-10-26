# Agenda fiscale

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `fiscal_agenda` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Le scadenze di chi ha la partita IVA erano sparse fra strumenti diversi: gli F24 delle tasse in `taxes`, quelli dell'IVA in `vat_settlement`, le CU in `withholding`, i rinnovi in `renewals`, le fatture da pagare nello scadenzario. Mancavano del tutto le scadenze che non hanno un importo calcolato da Owni: la dichiarazione dei redditi, la dichiarazione IVA, la LIPE, il diritto camerale, l'imposta di bollo sulle fatture elettroniche. Alla domanda «cosa devo pagare a novembre?» o «qual è la prossima scadenza fiscale?» non c'era una risposta sola, e niente finiva nel calendario.

## Decisione

- **Strumento `fiscal_agenda`** con `upcoming` ed `export_ics`. Non salva niente di suo: legge i registri che ci sono attraverso adattatori in `fiscal-agenda-sources.ts` (tasse, IVA, ritenute, rinnovi, scadenzario) e aggiunge le scadenze di legge da `fiscal-agenda-rules.ts`, ognuna con la sua fonte e alcune «da verificare»: Redditi il 31 ottobre, dichiarazione IVA il 30 aprile (solo ordinario), LIPE, diritto camerale con le imposte di giugno (solo per le imprese), bollo per trimestre (DM 4/12/2020, con il riporto sotto i 5.000 €).
- **Una data in più strumenti è una riga sola**: una chiave di dedup per voce. Il saldo IVA annuale si unisce al promemoria generico dell'IVA annuale, mai all'F24 periodico che cade lo stesso giorno. Ogni data passa da `dueSlip` (spostata al giorno lavorativo, con il motivo).
- **Finestra**: 30 giorni per default, un periodo detto («a novembre», «il prossimo trimestre», con `readPeriod(..., { ahead: true })`) fino a 366 giorni. Le scadenze passate si dicono solo dove Owni sa se sono state pagate (IVA, scadenzario, rinnovi).
- **Risposta**: in ordine di data, le scadute prima; «La prossima scadenza fiscale» in apertura quando c'è. Se una riga ha un nome (fornitore, rinnovo) tutta la lista va in un unico recinto dei dati non fidati.
- **Calendario**: `export_ics` scrive `agenda/scadenze-<da>_<a>.ics` (RFC 5545, `ics.ts`), mai sovrascritto, eventi di un giorno intero con UID stabile, SEQUENCE e LAST-MODIFIED, e l'avviso VALARM solo se chiesto. Una scadenza sola va nel Google Calendar con `google_calendar_create`.
- **Brief**: una riga sola per le scadenze nei prossimi 7 giorni che nessun altro strumento dice già (le voci con il flag `brief`), senza nomi.
- **Riuso**: `dueSlip` in `dates.ts`, `taxDeadlineWhat` in `tax-sums.ts`, `vatDeadlineWhat` e `vatInputsOf` in `vat-forecast.ts`, invece di copie.

## Sicurezza

- Nomi di fornitori e rinnovi solo nel recinto; nel file .ics, che è della persona, sono scritti con l'escape di RFC 5545, senza caratteri di controllo (anche C1) e con righe piegate a 75 ottetti.
- Dal canale degli agenti solo `upcoming`, senza nomi né file. L'audit registra operazione e numero di eventi.
- Un registro rovinato si dice in una nota e resta fuori.

## Alternative scartate

- **Scrivere direttamente nel calendario della persona**: serve un connettore e un'approvazione per ogni evento; il file .ics funziona con ogni calendario e non tocca niente finché non lo importa.
- **Una chiave di dedup per data**: per chi versa l'IVA ogni mese il saldo annuale e l'F24 di febbraio cadono il 16 marzo, e uno spariva.
- **La chiave del bollo dai trimestri con fatture**: cambiava mentre il trimestre si riempiva, e il calendario raddoppiava l'evento; ora la chiave è la scadenza.
