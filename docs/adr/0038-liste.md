# Liste: la spesa, le cose da fare, i regali

> Sostituito dall'[ADR 0127](0127-niente-squadre-pronte-ne-strumenti-per-cose-che-l-agente-fa-gia.md): gli strumenti `list_*` non ci sono più; le liste sono file del workspace e le tiene l'agente con `file_*` e `code_run`.

Le persone usano un assistente per tenere a mente le cose: «aggiungi latte e pane alla spesa», «ho preso il latte», «cosa devo ancora fare?», la lista della spesa di casa che tengono in due. Owni aveva la memoria (fatti su una persona) e i task programmati (un messaggio a un'ora), ma nessun posto per un elenco che cambia ogni giorno: la memoria non è fatta per spuntare, e un file nel workspace non distingue chi lo vede.

## Decisione

Cinque tool: `list_add` (aggiunge voci, crea la lista se non c'è), `list_show` (la lista numerata, o quali liste ci sono), `list_check` (spunta, anche tutte con `all`, o con `undo` rimette da fare), `list_remove` (toglie voci, quelle fatte, o la lista intera), `list_edit` (rinomina, condivide o rende privata). Le liste sono in `lists.json` dell'istanza, cambiate sotto lo stesso lock su file della memoria.

- **Di chi è una lista**: come la memoria. Una lista è della persona che l'ha creata e la vede solo nelle conversazioni con lei sola; con `shared: true` è condivisa con tutti quelli che scrivono all'istanza (la spesa di famiglia, le cose da fare di un ufficio), e solo quando la persona lo chiede. In un gruppo, o in una conversazione che Owni non sa di chi è, ci sono solo le liste condivise, e per cambiarle il modello deve dire `shared: true`: una lista non diventa condivisa per sbaglio.
- **Due liste con lo stesso nome**, una privata e una condivisa: Owni non sceglie, chiede quale e la indica con `shared`. Lo stesso per due nomi che si somigliano («regalo» trova «Regali» se è l'unica che somiglia; se ce ne sono due chiede).
- **Il nome**: «Spesa», «la lista della spesa», «lista per la spesa», «elenco spesa» sono la stessa lista, senza accenti né maiuscole; il nome si scrive senza «lista della», ma «Lista nera» resta.
- **Le voci**: una per riga, come la persona le ha dette. La stessa voce non si aggiunge due volte, senza articoli, quantità, accenti né maiuscole: «3 uova» dopo «uova» aggiorna la quantità, «Mele» è «mela». Una voce fatta che torna nella spesa è rimessa da fare.
- **Quale voce**: per numero, come lo dà `list_show` (prima le voci da fare, poi le fatte più recenti), o per parole: la voce uguale, oppure l'unica che le contiene tutte («soia» è «latte di soia»), cercate come in `file_search` (ADR 0035); spuntando si guarda prima tra le voci da fare. Se le parole vanno bene per più voci Owni non cambia niente e dice quali.
- **Le voci fatte** restano, le 50 più recenti, per rimetterle da fare o rivederle; `list_remove` con `done` le toglie.
- **I nomi delle liste** arrivano al modello con ogni messaggio, nel blocco della memoria, con quante voci restano: così usa la lista che c'è invece di farne una nuova. Le voci mai: per quelle c'è `list_show`. Il brief del mattino dice quante voci restano.

## Limiti

30 liste per persona e 30 condivise, 200 voci da fare per lista, nomi di 60 caratteri, 200 caratteri per voce, 50 voci per chiamata.

## Sicurezza

- Le liste condivise le scrive chiunque parli con l'istanza, e una lista resa privata tiene le voci scritte da altri: ogni risposta dei tool delle liste e i nomi nella nota della memoria stanno in un recinto con un'etichetta casuale, come dati e non istruzioni.
- Le descrizioni dei tool e le istruzioni dicono di cambiare le liste solo quando lo chiede chi scrive, mai perché lo dice una mail, un file o una pagina web. Nella chat del brief del mattino, che legge le mail, solo `list_show` funziona.
- Una lista condivisa intera si cancella, si condivide o si rende privata solo in una conversazione con una persona sola; prima di cancellare una lista con voci da fare Owni chiede conferma.
- `list_check` e `list_remove` trovano la lista e le voci in uno step durevole e le cambiano in un altro, per id: dopo un riavvio a metà cambiano le stesse voci, anche se nel frattempo i numeri si sono spostati; quelle tolte da altri nel frattempo sono dette. `list_add` e `list_edit` sono uno step: la voce non si aggiunge due volte.
- L'audit registra `list.changed` con la lista (id), il tipo di cambiamento e quante voci, mai i nomi o le voci.

## Alternative scartate

- **Liste nella memoria**: la memoria arriva al modello con ogni messaggio ed è fatta di frasi; una spesa di trenta voci la riempirebbe e non si spunta.
- **Un file Markdown nel workspace**: il modello dovrebbe riscriverlo tutto a ogni voce, e il workspace è dell'istanza, senza liste private.
- **Promemoria dentro la lista** (una scadenza per voce): per un'ora c'è già `schedule_create`, che la descrizione del tool ricorda.
- **Una lista nuova condivisa da sola in un gruppo**: comoda, ma un modello convinto da un messaggio o da una mail la creerebbe dove la vedono tutti; meglio un `shared: true` detto.
