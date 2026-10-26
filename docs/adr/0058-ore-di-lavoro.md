# Ore di lavoro

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `timesheet` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Chi lavora a ore teneva il conto su un foglio o nel calendario, poi rifaceva i calcoli per il preventivo o la fattura. Con preventivi (ADR 0055), allegati (ADR 0056) e spese (ADR 0057) mancava il pezzo che lega il tempo ai soldi. Ora «ho lavorato 3 ore per Rossi sul sito», «avvia il timer per Beta», «quanto devo fatturare a Rossi?», «manda a Rossi il riepilogo ore di ottobre» e «fai il preventivo con le ore di ottobre di Rossi» hanno una risposta.

## Decisione

- **Strumento `timesheet`** con `log`, `start`, `stop`, `status`, `set_rate`, `list`, `summary`, `edit`, `remove`, `report`, `to_quote`, `mark_billed` e `mark_unbilled`. Voci, timer, tariffe e prenotazioni stanno in `timesheet.json` nella cartella dell'istanza, con la copia `.bak`, 20.000 voci per anno e 16 MB, attraverso lo stesso `json-book.ts` di preventivi e spese. Numeri O-AAAA-NNNN mai riusati.
- **Durate** in minuti interi: «3 ore», «2h30», «2:15», «90 minuti», «due ore e mezza», «tre quarti d'ora», oppure un intervallo «9-12:30» con una pausa facoltativa. «8.30» è 8 ore e 30; «1,5» è un'ora e mezza; «1,30», «8.3» o «1.25» sono ambigui e Owni chiede. «Mezza giornata» o «tutta la mattina» non diventano un numero inventato: Owni chiede quante ore sono. Da 1 minuto a 24 ore per voce, avviso oltre 16 ore al giorno per cliente; un intervallo oltre la mezzanotte si registra in due voci.
- **Timer** uno per persona, salvato nel file così sopravvive ai riavvii. Un secondo avvio mostra quello che gira e non cambia nulla. Oltre 12 ore lo stop non registra e chiede quante ore erano davvero. Nei gruppi, e dove non si sa chi scrive, il timer non si usa, perché non è chiaro di chi sia.
- **Tariffe** orarie senza IVA, per cliente e generale, con arrotondamento facoltativo a 15 o 30 minuti per voce applicato solo al momento di fatturare: i minuti registrati non cambiano mai. Importo per voce = tariffa × minuti / 60, arrotondato al centesimo. «50 più IVA» è 50; «60 ivati» si chiede, tranne nel forfettario dove è lo stesso numero.
- **Clienti**: una sola regola per tutte le operazioni. Lo stesso nome scritto diversamente (maiuscole, accenti, punteggiatura) prende la grafia già usata e Owni lo dice; la forma giuridica conta, quindi «Rossi Srl» e «Rossi SpA» restano diversi. «Mario Rossi» e «Rossi» sono solo un suggerimento. Report, preventivo e segna fatturate vogliono il nome esatto, altrimenti Owni elenca i candidati. I nomi letti dalle fatture del workspace sono solo suggerimenti.
- **Tre stati** per le ore fatturabili: da fatturare, nel preventivo N, fatturate (con il riferimento della fattura). `to_quote` crea un preventivo vero con lo strumento dei preventivi, una riga per progetto, per voce o totale, e porta le voci «nel preventivo». Owni non emette fatture elettroniche: dopo averla fatta con il proprio programma, `mark_billed` con il numero porta le voci a fatturate. Una voce nel preventivo o fatturata non si modifica nelle ore e non si toglie finché non torna da fatturare.
- **Report per il cliente** in PDF, Word o CSV in `ore/` del workspace, con la stessa carta intestata dei preventivi: data, progetto, attività, ore, tariffa e importo, totali anche in ore decimali. Senza nessuna tariffa diventa un report di sole ore; con tariffe solo su alcune voci Owni chiede quella che manca. Si manda con gli allegati delle mail (ADR 0056), dopo l'approvazione.
- **Periodi** condivisi con le spese in `periods.ts`: oggi, ieri, questa settimana e la scorsa (da lunedì a domenica), mesi, trimestri, anni, da inizio anno; «quanto devo fatturare» guarda tutte le ore da fatturare, di qualunque periodo. Anche le spese capiscono ora «stamattina», «ieri pomeriggio» e le settimane.
- **Brief**: una riga solo se ci sono ore da fatturare da più di 30 giorni o un timer acceso da più di 10 ore.

## Sicurezza e concorrenza

- `to_quote` prenota le voci sotto il lock prima di creare il preventivo, con minuti, tariffa e arrotondamento congelati; due richieste insieme non mettono le stesse ore in due preventivi, e ogni modifica successiva sistema le prenotazioni rimaste in sospeso: se il loro preventivo esiste le voci passano nel preventivo con le condizioni congelate, se non esiste dopo un'ora si liberano. Una prenotazione con il suo preventivo non scade mai, quindi le stesse ore non finiscono in due preventivi nemmeno dopo un errore a metà.
- Rimozione e modifica ricontrollano sotto il lock che la voce non sia prenotata, nel preventivo o fatturata. `mark_billed` senza riferimento non cancella mai un riferimento già salvato.
- Clienti, progetti, attività, riferimenti e percorsi tornano al modello solo dentro il recinto dei dati non fidati. Celle del CSV protette dalle formule, nomi dei file solo dal cliente ripulito e dal periodo, mai sovrascritti.
- Dal canale degli agenti e nel brief solo letture. L'audit registra operazione e numero di voci, mai nomi, ore, importi o testi.

## Alternative scartate

- **Emettere la fattura elettronica**: serve l'invio allo SdI con un intermediario e una firma; resta al programma di fatturazione della persona.
- **Un timer condiviso nei gruppi**: chiunque potrebbe fermare o cancellare le ore di un altro.
- **Arrotondare i minuti registrati**: si perderebbe il tempo reale; l'arrotondamento è una regola di fatturazione, non un dato.
- **Unire da soli i clienti con nomi simili**: le ore di un cliente finirebbero nel preventivo di un altro.
