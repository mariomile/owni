# Listino prezzi

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `price_list` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Preventivi, fatture in uscita e ore da fatturare chiedevano ogni volta il prezzo, o lo prendevano da quello che il modello ricordava. Chi vende sempre le stesse cose (una giornata di consulenza, un sito base, un'ora di sviluppo) doveva ripeterlo a ogni documento, e un prezzo detto male finiva in fattura. Ora «quanto faccio pagare una giornata?», «fammi un preventivo per Rossi: 3 giornate di consulenza e il sito base» e «fattura a Bianchi 10 ore di sviluppo» prendono il prezzo dal listino.

## Decisione

- **Strumento `price_list`** con `add`, `update`, `remove`, `list`, `find`, `price_change`, `import` ed `export`. Le voci stanno in `price-list.json` nella cartella dell'istanza attraverso `json-book.ts` (lock, copia `.bak`, file rovinato mai sovrascritto): id LS-NNNN mai riusati, 2.000 voci al massimo, prezzi in centesimi con gli aiuti di `quote-sums.ts`. Ogni voce ha nome, codice facoltativo, descrizione, unità (ora, giornata, pezzo, mese, a corpo), aliquota o natura IVA e se il prezzo è IVA inclusa.
- **Trovare una voce senza indovinare**: prima il nome intero e il codice, poi senza le parole della domanda («quanto faccio pagare», «qual è il mio prezzo»); le unità al plurale valgono come al singolare. Una lettera di differenza si usa e si dice; più voci simili, o un nome che è il codice di un'altra voce, si chiedono sempre; un nome che non c'è non ha mai un prezzo inventato.
- **Nei documenti**: una riga di `quotes` o `sales_invoices` può avere `item` (codice o nome). Descrizione, unità, prezzo e IVA vengono dalla voce, e quello detto sulla riga vale di più. Un'IVA detta per tutto il documento vale più di quella della voce. Una voce IVA inclusa in un documento senza IVA perde l'IVA alla sua aliquota, con un prezzo a unità di quattro decimali scelto perché l'imponibile della riga torni al centesimo; se non torna entro 50 centesimi Owni chiede il prezzo netto. Nel forfettario il prezzo resta com'è scritto. Senza `item` preventivi e fatture fanno quello che facevano.
- **Ore da fatturare**: senza una tariffa detta, `to_quote` usa la voce oraria del listino solo se è chiaramente quella dell'attività o del cliente, o se è l'unica tariffa oraria generica; altrimenti chiede come prima. La voce usata resta scritta nella prenotazione delle ore e detta nella risposta.
- **Cambi di prezzo e import in due passi**: `price_change` (percentuale o importo, per una voce o tutte) e `import` (CSV o Excel dal workspace) mostrano prima l'anteprima con un controllo di otto cifre e applicano solo con il sì e lo stesso controllo; una ripetizione dopo l'applicazione risponde «Fatto» senza applicare due volte. L'import non sovrascrive mai una voce che c'è già e scarta le righe con un motivo (prezzo che si legge in due modi come «1.234», IVA mancante, nome che è il codice di un'altra voce).
- **Export** CSV in `listino/`, mai sovrascritto.
- Correzione collegata: `sales_invoices` legge i prezzi a quattro decimali come i preventivi; con più decimali rispondeva con un errore non gestito.

## Sicurezza

- Le voci dette dalla persona sono suoi dati; il contenuto di un file importato resta nel recinto dei dati non fidati, anche nelle note dei documenti. Celle del CSV protette dalle formule.
- Dal canale degli agenti solo `list` e `find`; ogni scrittura è rifiutata. L'audit registra operazione e conteggio.

## Alternative scartate

- **Togliere l'IVA dal prezzo a unità e moltiplicare**: l'imponibile della riga sbagliava di un centesimo in molti casi rispetto ai preventivi IVA inclusa.
- **Usare l'unica voce oraria per tutti**: una «Consulenza Rossi» finiva nel preventivo di Bianchi.
- **Ricalcolare l'anteprima alla conferma**: dopo un'applicazione interrotta la ripetizione mostrava un secondo aumento.
