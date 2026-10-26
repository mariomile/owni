# 0122: Gli strumenti dei connettori caricati su richiesta

L'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md) ha tolto i registri e con loro `tool_search`: ogni agente riceveva tutti i suoi strumenti a ogni richiesta al modello. Restano però i connettori. Un servizio MCP collegato porta i suoi strumenti, a volte decine, ciascuno col suo schema: pagati a ogni turno, anche quando la conversazione non usa quel servizio.

## Decisione

- Gli strumenti dei connettori, MCP e API, sono rimandati: `deferred: true`, messo in `src/app.ts` su quello che restituisce `mcp.connect`. Gli strumenti di Owni (memoria, file, `code_run`, posta, calendario, web, promemoria) restano offerti a ogni richiesta.
- `tool_search` torna come nell'[ADR 0100](0100-strumenti-caricati-su-richiesta.md), nell'adapter Pi Durable: c'è solo se almeno uno strumento è rimandato. La sua descrizione elenca gli strumenti dei connettori col nome e la prima frase. Una ricerca fatta solo di nomi esatti carica quelli e basta, una ricerca libera resta BM25 con tre risultati.
- Uno strumento caricato resta per tutta la conversazione.
- Le chiamate approvate da una persona (ADR 0025) non passano dal modello: partono sulla connessione anche se lo strumento non è caricato.

## Conseguenze

- Un agente senza connettori non ha `tool_search` e non paga niente in più.
- Il primo turno che usa un connettore fa una chiamata al modello in più, poi lo strumento resta.
- Uno strumento di un connettore chiamato senza caricarlo non parte: il modello riceve un errore e può cercarlo (`test/connector-actions.test.ts`).
- Lo strumento che dice che un connettore va ricollegato (`<id>__non_collegato`) non è rimandato: il modello lo vede subito e può chiedere di accedere.
- Una chiamata a un connettore rimasta a metà durante l'aggiornamento si chiude una volta con `tool_unavailable`: lo strumento non è ancora caricato nella conversazione ripresa.
- L'eval dell'agente non conta `tool_search` come primo strumento: conta il primo usato dopo.
