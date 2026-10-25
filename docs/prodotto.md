# Prodotto finito: definizione e stato

Stato al 15 ottobre 2026: tutte le voci sono fatte sul branch `week-5`, con le riserve indicate. Restano le verifiche che richiedono i segreti di Mario (vedi [`stato-e-todo.md`](stato-e-todo.md)).

Owni è «pronta al 100%» quando ognuna di queste voci è vera e verificata da un test o da una prova documentata. Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md). Decisioni: [`adr/`](adr/).

## 1. Un solo processo

- [x] `pnpm start` avvia tutto per un tenant: istanze, Telegram, interfaccia web, task programmati, segreteria se configurata.
- [x] Configurazione da `.env` per il bootstrap; il resto (connettori, task, persone) dalla console web o dalla riga di comando.
- [x] Docker Compose con volume dati, healthcheck e riavvio automatico. *(Verificato: immagine costruita e avviata; healthcheck `healthy`, utente non privilegiato, link dell'owner in un file 0600; login, chat, file, tool proposto approvato ed eseguito in sandbox, CLI; tutto persiste dopo un riavvio del container.)*

## 2. Agente generale

- [x] Tool per istanza, ricalcolati e applicati riaprendo l'istanza quando cambiano (ADR 0004).
- [x] **Connettori MCP** (Streamable HTTP e stdio) configurabili per istanza, con segreti nel secret store ed egress per host; i loro tool arrivano al modello (ADR 0003).
- [x] **Workspace**: l'istanza crea, legge, elenca e invia file; le persone li caricano e scaricano da web e Telegram.
- [x] **Task programmati**: una volta o a ripetizione, creati dalle persone o dall'istanza stessa; eseguiti anche dopo un riavvio; risultato consegnato al thread.
- [x] **Tool proposti**: l'istanza scrive un tool, un approvatore lo approva su Telegram o web, gira in sandbox con egress dichiarato (ADR 0002).
- [x] **Approvazioni** in un unico posto, visibili su Telegram (pulsanti) e web.
- [x] **Il modello di ogni chat**: dalla pillola nel box della console, e su Telegram e WhatsApp con `/modello` (per esempio `/modello google`, `/modello istanza`), fra i provider che l'owner ha permesso (ADR 0036, ADR 0037).

## 3. Interfaccia web

- [x] Accesso con link personale creato dall'owner, sessione con cookie `HttpOnly`, chi non è autorizzato non vede nulla.
- [x] Chat con l'istanza, risposte in tempo reale, storico dei thread.
- [x] Console come una chat di team: un messaggio diretto per agente, canali con più agenti, thread sotto ogni messaggio, non letto dal server (ADR 0113).
- [x] Segreteria: elenco pratiche, scheda con bozza, Approva, Modifica, Scarta.
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
