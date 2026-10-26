# Gli strumenti dei registri caricati su richiesta

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): i registri non ci sono più. Il meccanismo resta per gli strumenti dei connettori: [ADR 0122](0122-strumenti-dei-connettori-caricati-su-richiesta.md).

L'agente generale riceveva 76 strumenti a ogni richiesta al modello. I 25 dei registri dell'attività (fatture, preventivi, spese, clienti, magazzino, IVA e gli altri) da soli pesano circa 140 mila caratteri di schema, circa 35 mila token: pagati a ogni turno, anche per un saluto o una mail.

## Decisione

- `OwniTool` ha `deferred?: true`. Uno strumento così non è offerto al modello finché il modello non lo carica. In `src/app.ts` i 25 registri sono rimandati con `deferredAll`; gli altri (memoria, calendario, web, posta, file) restano offerti a ogni richiesta.
- Se almeno uno strumento è rimandato, l'adapter Pi Durable aggiunge `tool_search`: quello di Pi Durable 1.3, con due differenze.
  - La sua descrizione elenca gli strumenti rimandati, col nome e la prima frase della loro descrizione. Il modello li conosce così anche negli agenti creati prima, che hanno le istruzioni salvate e non le riscrivono.
  - Una ricerca fatta solo di nomi esatti carica quelli e basta. Con BM25 il nome giusto a volte non è il primo, e ogni ricerca caricava fino a otto strumenti. Una ricerca libera resta BM25, con tre risultati.
- Uno strumento caricato resta offerto per tutta la conversazione, anche dopo una compattazione e un cambio di modello.
- Le istruzioni predefinite non cambiano. Sono a 19.775 caratteri e il limite è 20.000.

## Conseguenze

- Il primo turno che usa un registro fa una chiamata al modello in più (`tool_search`), poi lo strumento resta.
- Uno strumento rimandato che il modello chiama senza caricarlo non parte: il modello riceve un errore e può cercarlo (test/deferred-tools.test.ts). Lo stesso succede se lo chiama nella stessa risposta in cui lo cerca.
- Al primo riavvio dopo l'aggiornamento, una chiamata a un registro rimasta a metà finisce in errore invece di ripartire. Succede una volta, e il modello riceve l'errore.
- L'eval dell'agente (ADR 0099) non conta `tool_search` come primo strumento: conta il primo strumento usato dopo.
- Rimandare un altro gruppo di strumenti è una riga in `src/app.ts`.
