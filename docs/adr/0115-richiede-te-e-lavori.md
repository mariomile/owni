# 0115: Richiede te come casella unica, Lavori come la Board

> In parte sostituito dall'[ADR 0126](0126-togliere-la-segreteria-commerciale.md): le pratiche non compaiono più in «Da decidere».

Mario: «ora non si capisce nulla, né in termini di UX né di UI». Fino a oggi «Richiede te» compariva tre volte (nella barra laterale, nella barra di Lavori e come filtro della lista) e non era un posto: era un filtro della lista Lavori, le cui righe portavano a un'altra pagina, «Autorizzazioni», dove si decideva davvero. Gli incarichi avevano due viste, la lista di Lavori e la Board, con la Board dietro un pulsante. La lista mescolava incarichi, autorizzazioni e fino a 100 esecuzioni per agente, con quattro filtri e una riga di conteggi.

## Decisione

- **Richiede te è una pagina, `#/approvazioni`.** Ci sono le decisioni («Da decidere»: strumenti, moduli, azioni dei servizi, richieste tra agenti, Google, pratiche) con le loro schede complete, che si decidono lì, e gli incarichi da rivedere («Da rivedere»: il risultato che l'agente ha lasciato e «Rivedi il risultato», che apre l'incarico nella Board). Sotto, le decisioni precedenti. Un solo ingresso, nella barra laterale, con il conteggio di sempre.
- **Lavori è la Board, `#/board`.** La voce «Lavori» della barra laterale apre gli incarichi in colonne; la barra di Lavori ha Incarichi, Automazioni e, se c'è, Pratiche. (Sostituito da [0123](0123-lavori-come-pagine-della-barra-laterale.md): sono pagine della barra laterale.)
- **Le esecuzioni escono da Lavori.** Stanno nella sezione Attività del pannello dell'agente (ADR 0114), una per agente.
- **La vecchia lista non c'è più**, né il suo indirizzo `#/lavori`. Nessun link generato dal server puntava lì.

## Alternative scartate

- **Tenere la lista e correggere le etichette.** Restavano due viste degli stessi incarichi e due passaggi per decidere.
- **Decidere gli incarichi da rivedere dentro Richiede te.** Accettare o rimandare indietro chiede di leggere il risultato e la cronologia, che sono nella scheda della Board; duplicarli avrebbe dato due posti con le stesse regole.
- **Un nuovo indirizzo `#/richiede-te`.** Più leggibile, ma non cambia niente per chi usa la console e `#/approvazioni/<tipo>/<agente>/<id>` porta già alla singola decisione.

## Conseguenze

- Il conteggio della barra laterale e la pagina usano la stessa regola: un incarico da rivedere è della persona che ci ha lavorato con l'agente, o dell'owner quando nessuno ci ha lavorato.
- Se la Board non si legge, Richiede te mostra comunque le decisioni e dice che gli incarichi da rivedere non sono disponibili.
- Nessuna API cambia.
