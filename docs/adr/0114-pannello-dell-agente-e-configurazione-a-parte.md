# 0114: Il pannello dell'agente, e la configurazione a parte

Mario vuole che il dettaglio di ogni agente si apra a destra, accanto alla conversazione, con artifact, routine, memoria e il resto; la configurazione resta in una pagina sua. Fino a oggi quello che un agente ha e sa stava in quattro pagine (Documenti, Memoria, Procedure, Connettori) raggiunte da una barra in alto, più Configurazione, e i suoi artifact e le sue routine non avevano un posto: gli artifact si ritrovavano solo nella chat in cui erano nati, le routine erano divise fra Task, Automazioni e Board. Per guardare cosa sa un agente bisognava lasciare la conversazione con lui.

## Decisione

- **Un pannello per agente, accanto alla conversazione.** Si apre dal nome dell'agente in cima al messaggio diretto (lo stesso link lo chiude) e dal nome di un agente in un canale. Sta nel pannello a destra come thread, Browser, Schermo e artifact, e come loro si mostra uno alla volta; sul telefono copre la conversazione con la freccia per tornare. Indirizzo `#/dm/<agente>/info`, e `#/dm/<agente>/info/<sezione>` per una sezione.
- **Sei sezioni**: Attività (le esecuzioni, quelle in corso prima, ognuna apre la sua conversazione), Artifact (tutte le pagine dell'agente con la persona, da ogni conversazione, `GET /api/instances/:id/artifacts`), Routine (orari, sentinelle, eventi esterni e incarichi ricorrenti della board in una lista sola, ognuna con il suo stato, Elimina e Riattiva quando una sentinella si è fermata), Memoria, Documenti e Procedure (le pagine di prima, nel pannello). Le liste lunghe mostrano le prime sei righe e «Mostra tutti».
- **In testa** il volto, il nome, la descrizione e lo stato di adesso («Al lavoro da 40 s su …» o «Libero»). L'ingranaggio porta alla configurazione, solo per l'owner.
- **Un artifact aperto dal pannello** si apre nel pannello degli artifact; chiudendolo si torna al pannello dell'agente.
- **La configurazione resta una pagina, dell'owner**: Identità, Modello, Capacità, Servizi, Canali, Accessi. I servizi collegati (i connettori) sono ora la sezione Servizi della configurazione.
- **Le vecchie pagine non ci sono più.** `#/file`, `#/memoria` e `#/skill` aprono la sezione del pannello dell'agente; `#/connettori` apre Configurazione → Servizi. La barra con Documenti, Memoria, Procedure e Configurazione sparisce, e la scheda dell'agente in Agenti ha «Dettagli» al posto di «Documenti».

## Alternative scartate

- **Una pagina di dettaglio a tutto schermo.** Più spazio per ogni sezione, ma fa lasciare la conversazione: proprio quello che il pannello evita. Le sezioni sono liste, che in 440px si leggono bene.
- **Configurazione nel pannello.** Metterla insieme a memoria e artifact unisce cose che si usano ogni giorno con cose che si toccano una volta e che sono solo dell'owner. Tenerla a parte lascia il pannello uguale per tutti e la configurazione con i suoi salvataggi.
- **Routine come collegamenti alle pagine di prima.** Più semplice, ma tornava alla divisione per tipo (Task, Automazioni, Board) che la persona non deve conoscere. Si crea ancora da Automazioni, con «Nuova».

## Conseguenze

- Il pannello a destra mostra una cosa per volta: Browser, Schermo, un thread, un artifact o l'agente. Sostituisce, di ADR 0113, l'elenco «Browser, Schermo o un thread».
- Un membro vede il pannello degli agenti con cui può parlare, senza l'ingranaggio; un agente con cui la persona non parla non ha pannello, e i suoi materiali restano raggiungibili all'owner dalla configurazione.
- Nessun dato cambia di posto: memoria, documenti, procedure e routine usano le API di prima. L'unica API nuova è l'elenco degli artifact di un agente.
