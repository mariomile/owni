# Prodotto finito: definizione e stato

Stato al 15 ottobre 2026: tutte le voci sono fatte sul branch `week-5`, con le riserve indicate. Restano le verifiche che richiedono i segreti di Mario (vedi [`stato-e-todo.md`](stato-e-todo.md)).

Owni è un'azienda di agenti AI: ogni agente è un collega a sé, con il suo modello, la sua memoria, i suoi strumenti, il suo ruolo e le sue responsabilità, e l'organigramma dice come lavorano insieme. Si comincia da un assistente solo e si aggiunge una squadra quando serve.

Owni è «pronta al 100%» quando ognuna di queste voci è vera e verificata da un test o da una prova documentata. Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md). Decisioni: [`adr/`](adr/).

## 1. Un solo processo

- [x] `pnpm start` avvia tutto per un tenant: istanze, Telegram, interfaccia web, task programmati.
- [x] Configurazione da `.env` per il bootstrap; il resto (connettori, task, persone) dalla console web o dalla riga di comando.
- [x] Docker Compose con volume dati, healthcheck e riavvio automatico. *(Verificato: immagine costruita e avviata; healthcheck `healthy`, utente non privilegiato, link dell'owner in un file 0600; login, chat, file, tool proposto approvato ed eseguito in sandbox, CLI; tutto persiste dopo un riavvio del container.)*

## 2. Agente generale

- [x] Tool per istanza, ricalcolati e applicati riaprendo l'istanza quando cambiano (ADR 0004).
- [x] **Connettori MCP** (Streamable HTTP e stdio) configurabili per istanza, con segreti nel secret store ed egress per host; i loro tool arrivano al modello (ADR 0003).
- [x] **Collegamenti API** per agente: indirizzo base, chiave (token, header o parametro) e una nota su cosa sa fare; l'agente legge subito, scrive dopo l'approvazione, raggiunge solo quell'host e non vede mai la chiave. Ogni agente ha le sue chiavi (ADR 0116).
- [x] **Workspace**: l'istanza crea, legge, elenca e invia file; le persone li caricano e scaricano da web e Telegram.
- [x] **Task programmati**: una volta o a ripetizione, creati dalle persone o dall'istanza stessa; eseguiti anche dopo un riavvio; risultato consegnato al thread.
- [x] **Tool proposti**: l'istanza scrive un tool, un approvatore lo approva su Telegram o web, gira in sandbox con egress dichiarato (ADR 0002).
- [x] **Conti in Python**: ogni numero che un agente dà a una persona (totali, IVA, sconti, domande a un CSV o a un Excel) viene da un programma che gira in una sandbox senza rete, chiavi né disco; i file che scrive tornano nel workspace (ADR 0119).
- [x] **Niente registri fissi**: fatture, spese, ore e il resto stanno nei file del workspace, i conti li fa `code_run`, le procedure per ogni cliente sono sue skill (ADR 0121).
- [x] **Approvazioni** in un unico posto, visibili su Telegram (pulsanti) e web.
- [x] **Approvazioni per rischio**: leggere e scrivere nel proprio spazio non chiedono; le scritture che un servizio dichiara interne e non distruttive partono subito (l'owner può alzarle a «chiedi»); mail inviate, eventi con invitati, cancellazioni, pagamenti e strumenti non descritti chiedono sempre. Bozze ed eventi senza invitati si fanno subito (ADR 0120).
- [x] **Organigramma**: squadre con chi le coordina e, per ogni agente, ruolo, a chi risponde e responsabilità. Decide chi può scrivere a chi; ogni agente legge il suo posto prima di ogni richiesta e `agent_list` dice chi è responsabile di cosa. 
- [x] **Il modello di ogni chat**: dalla pillola nel box della console, e su Telegram e WhatsApp con `/modello` (per esempio `/modello google`, `/modello istanza`), fra i provider che l'owner ha permesso (ADR 0036, ADR 0037).

## 3. Interfaccia web

- [x] Accesso con link personale creato dall'owner, sessione con cookie `HttpOnly`, chi non è autorizzato non vede nulla.
- [x] Chat con l'istanza, risposte in tempo reale, storico dei thread.
- [x] Console come una chat di team: un messaggio diretto per agente, canali con più agenti, thread sotto ogni messaggio, non letto dal server (ADR 0113).
- [x] Pannello dell'agente accanto alla conversazione (attività, artifact, routine, memoria, documenti, procedure); configurazione a parte, con i servizi collegati (ADR 0114).
- [x] Richiede te come pagina unica per decisioni e incarichi da rivedere; Lavori si apre sulla Board (ADR 0115).
- [x] Connettori, task programmati, file, tool proposti e approvazioni.
- [x] Spesa del giorno e audit.
- [x] Funziona da telefono; tema chiaro e scuro; nessuna risorsa esterna (ADR 0005).

## 4. Qualità e operatività

- [x] CI verde: typecheck, test, eval deterministiche; giudice notturno. *(Verificato in locale; la CI su GitHub parte con la PR.)*
- [x] Review indipendente su ogni blocco, problemi corretti o documentati.
- [x] Runbook: installazione, aggiornamento, backup e ripristino, rotazione dei segreti.
- [x] LICENSE: Apache-2.0, confermata da Mario il 16 ottobre 2026.

## Fuori dal perimetro (scelte esplicite)

- ~~WhatsApp~~: dal 16 ottobre 2026 è un canale come Telegram (Cloud API di Meta, settimana 13, [week13.md](week13.md)).
- Invio di mail o azioni irreversibili senza approvazione.
- ~~Multi-tenant cloud con billing~~: dal 16 ottobre 2026 è in programma come Owni Cloud, una cella per tenant ([piano](piano-cloud.md)).
- Registri dell'attività già pronti (fatture, preventivi, spese, magazzino e gli altri): tolti il 26 ottobre 2026, vedi [ADR 0121](adr/0121-registri-sostituiti-da-code-run-e-file.md).
