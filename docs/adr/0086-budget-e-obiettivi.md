# Budget e obiettivi

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `budgets` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

L'andamento dell'attività (settimana 61) dice come stanno andando le cose, ma non rispetto a quello che la persona si era data come limite o come traguardo. «Quanto ho speso per il software questo mese rispetto al budget?», «come vado con l'obiettivo di 60.000 € di fatturato?», «quali budget sto sforando?» non avevano una risposta, e nessuno avvisava quando una spesa passava il limite.

## Decisione

- **Strumento `budgets`** con `set`, `remove`, `status`, `list` ed `export`. I budget stanno in `budgets.json` attraverso `json-book.ts` (lock, copia `.bak`, file rovinato mai sovrascritto, BU-NNNN mai riusati, chiamate ripetute scritte una volta). Un budget di spesa è su una categoria delle spese, un fornitore o tutte le spese; un obiettivo è sul fatturato o sull'incassato; ognuno è mensile, trimestrale o annuale, con un inizio facoltativo. Un secondo budget sulla stessa cosa con lo stesso periodo sostituisce il primo, tiene il suo inizio, e se è identico non cambia niente.
- **Le cifre non si ricalcolano**: fatturato, incassato, spese e categorie vengono dalle stesse funzioni dell'andamento dell'attività; il budget di un fornitore conta come le schede dei fornitori (con i pagamenti confermati dall'estratto conto, attraverso `supplier-find.ts`). I possibili doppioni si contano e si dicono una volta per risposta.
- **Percentuali oneste**: sotto il limite si arrotonda per difetto, sopra non si scende mai sotto 101%, e 100% vuol dire raggiunto esattamente. «Superato» è solo oltre il limite.
- **Stima** a fine periodo allungando quello che è successo finora, detta come stima e solo dopo il primo decimo del periodo; per un obiettivo annuale, quanto serve al mese per arrivarci.
- **Avvisi nel brief**: una riga sola quando un budget di spesa passa l'80% o il 100% o un obiettivo è indietro nell'ultimo terzo del periodo; ogni soglia si dice una volta per periodo (gli avvisi detti restano scritti nel budget, e restano anche se il budget cambia ma è ancora oltre quella soglia).
- **Riuso**: `supplier-find.ts` (trovare un fornitore, caricarlo con banca e rinnovi, la domanda «intendi questo fornitore?») e `register-read.ts` (leggere il registro delle fatture con le sue note) ora servono anche a fornitori, clienti e andamento dell'attività.

## Sicurezza

- Nomi dei fornitori solo nel recinto dei dati non fidati, mai nel brief.
- Dal canale degli agenti solo `status` e `list`, a cifre e percentuali, con «un fornitore» al posto dei nomi; una domanda su un singolo fornitore è rifiutata sempre, così non si può indovinare chi ha un budget. L'audit registra operazione e conteggio. CSV con celle protette dalle formule, mai sovrascritto.

## Alternative scartate

- **Contare il budget di un fornitore senza l'estratto conto**: non tornava con quello che dicono le schede dei fornitori, e gli avvisi arrivavano tardi.
- **Arrotondare le percentuali al più vicino**: 79,95% diventava 80% senza avviso, e 100% voleva dire sia «superato» sia «restano 0,20 €».
- **Dare a un altro agente i budget per nome**: bastava provare dei nomi per sapere quali fornitori avevano un budget.
