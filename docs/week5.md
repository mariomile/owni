# Settimana 5: l'agente generale e la console web

Branch `week-5` (parte da `week-4`). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md). Decisioni: [`adr/`](adr/). Definizione di prodotto finito: [`prodotto.md`](prodotto.md).

## Perché

Mario ha chiarito l'obiettivo: Owni deve poter fare tutto, non solo la segreteria su Telegram. Collegarsi a servizi terzi, essere proattiva, creare file, scriversi da sola tool e connettori, e avere un'interfaccia web. La settimana 5 costruisce questo sopra il nucleo delle settimane 1-4, senza rinunciare a ciò che Owni vende: privacy, controllo dei processi, nessuna azione irreversibile senza una persona.

## Cosa funziona (verificato dai test)

- **Tool per istanza** (`test/instance-tools.test.ts`). I tool di un'istanza si calcolano dal suo record all'apertura (integrati, connettori, tool approvati); `runtime.reopen` applica un elenco cambiato e riprende il lavoro in sospeso come dopo un riavvio. Le risorse dei tool (connessioni MCP, processi) si chiudono con l'istanza (ADR 0004).
- **Workspace** (`test/workspace.test.ts`, `test/workspace-tools.test.ts`). File per istanza in una cartella da cui non si esce: niente `..`, percorsi assoluti, nomi nascosti o symlink; limiti di 20 MB per file e 1 GB in tutto; scritture atomiche. Tool `file_write`, `file_read`, `file_list`, `file_delete`, `file_send`. `file_send` passa dall'outbox come una risposta e arriva su Telegram come documento, nel web come allegato scaricabile. I documenti mandati su Telegram finiscono in `uploads/`, solo da utenti consentiti.
- **Task programmati** (`test/cron.test.ts`, `test/schedules.test.ts`). Cron a 5 campi valutato nel fuso del tenant (anche nel giorno del cambio d'ora) ed esecuzione singola a un'ora data. Lo scheduler ammette i task scaduti con un ID richiesta derivato dall'ora prevista: un crash tra ammissione e registrazione non produce doppioni. Dopo uno spegnimento, una sola esecuzione di recupero. Limiti: 50 task per istanza, non più spesso di ogni 5 minuti. Creati dalle persone (web) o dall'istanza (`schedule_create`); il risultato va nel thread scelto. Un task non viene da una persona, quindi salta l'allowlist ma non l'egress, e finisce nell'audit (`schedule.fired`).
- **Connettori MCP** (`test/mcp.test.ts`, server MCP veri dell'SDK via HTTP e stdio). Configurati senza segreti (header e variabili puntano al secret store). Un connettore raggiunge la rete solo se la policy elenca `mcp:<id>`, con un fetch limitato al suo host (http in chiaro solo verso loopback), senza seguire redirect. Ai processi stdio passa solo l'ambiente che il connettore nomina (più le variabili di base dell'SDK: HOME, PATH, USER, SHELL, TERM, LOGNAME). Un connettore rotto viene saltato e registrato nell'audit (ADR 0003).
- **Tool proposti** (`test/proposals.test.ts`, `test/sandbox.test.ts`). `tool_propose` salva nome, descrizione, schema, codice e host dichiarati; il tool non è chiamabile finché un approvatore (lista separata da chi può solo parlare) o l'owner non lo approva, su Telegram (scheda con Approva/Rifiuta) o nel web. Approvare aggiunge `tool:<nome>` alla egress policy, riapre l'istanza e lo dice nella conversazione d'origine. Il tool gira in un processo separato: permission model di Node (filesystem limitato alla sua cartella, niente processi figli né worker), ambiente vuoto, moduli e globali di rete rimossi, unica uscita un `fetch` inoltrato al processo principale con l'egress, limiti di tempo e memoria (ADR 0002).
- **Approvazioni in un posto solo**: la pagina Approvazioni raccoglie le bozze della segreteria in attesa e i tool proposti, con un contatore unico.
- **Console web** (`test/web.test.ts`, `test/app.test.ts`, prova in Chromium headless). Accesso con link personale (token nel frammento dell'URL, scambiato con un cookie `HttpOnly; SameSite=Strict`; su disco solo hash). Ogni modifica vuole l'header `X-Owni`; CSP `default-src 'self'`, niente frame. Canale web con storico per thread di una sola persona, risposte in tempo reale (SSE) e deduplicate dopo un crash. Chat, segreteria (bozza come lettera, Approva con conferma, Modifica, Scarta), approvazioni (timbro), task, file; per l'owner connettori, impostazioni, persone, spesa e audit. Stile neutro e denso (Geist e Geist Mono, OFL, inclusi nel repo), icone in linea, palette di comandi con ⌘K / Ctrl K; tema chiaro e scuro, layout da telefono, nessuna risorsa esterna (ADR 0005).
- **Processo unico** (`test/app.test.ts`). `pnpm start` avvia istanza generale, canali, scheduler, segreteria (se configurata) e console; al primo avvio crea l'owner e stampa il suo link una volta. `pnpm owni person add|list|link|remove` gestisce le persone.
- **Pacchetto**: Dockerfile e compose (solo dipendenze di produzione, utente non privilegiato, volume `/data`, healthcheck), [runbook](runbook.md), LICENSE Apache-2.0 (confermata da Mario), NOTICE.

## Review indipendente

Un revisore separato ha trovato 15 problemi, tre dei quali riprodotti contro la sandbox. Corretti tutti, ognuno con un test:

- **Alta, sandbox.** I moduli interni di Node (`_http_agent`, `_tls_wrap`, `dns/promises`) aprivano connessioni di rete; `node:sqlite` ignora il permission model e poteva leggere lo storage del motore (tutte le conversazioni); `process.kill` poteva uccidere Owni. Ora i moduli sono una lista di consentiti (libreria standard senza rete, niente sqlite, niente `file:`), segnali e API native del processo sono bloccati, le risposte `fetch` hanno un tetto letto a pezzi, al massimo 4 richieste insieme, annullate a fine esecuzione.
- **Alta, accessi.** Un link revocato dalla CLI non chiudeva le sessioni del server in esecuzione, e l'allowlist valeva solo alla riapertura. Ora sessioni, allowlist ed egress dei canali si leggono a ogni richiesta.
- **Media.** Una scheda Telegram con codice troncato aveva comunque Approva: ora il codice lungo si approva solo dalla console. Un task programmato continuava a scrivere a una persona tolta dall'allowlist: ora viene disattivato. I messaggi arrivati durante una riapertura andavano persi: ora aspettano l'istanza nuova, e le riaperture si mettono in fila. Un task delle 2:30 scattava due volte la notte del cambio d'ora. Un membro vedeva e cancellava i task degli altri.
- **Bassa.** Vince l'approvazione più recente; intervallo minimo controllato su una settimana di esecuzioni; niente download dei documenti degli sconosciuti; decisioni sulla stessa proposta in fila; il link dell'owner non finisce più nei log ma in un file 0600.

## Verifica

Eseguita su questo branch, Node 22.22.0, Linux:

- `pnpm typecheck`: nessun errore. `pnpm test`: 26 file, 146 test, 0 fallimenti (98 a fine settimana 4). `pnpm eval:segreteria`: 35 casi ok.
- Console: giro completo in Chromium headless (login con link, chat con file e proposta di tool, approvazione con timbro, task, file, segreteria, persone, impostazioni, connettori, attività; tema scuro; telefono 390 px senza scorrimento orizzontale). Nessun errore in console oltre al 401 atteso senza sessione.
- `pnpm start` con le sole dipendenze di produzione: avvio, `/healthz`, console servita.
- Sandbox: provata su Node 22.22 (filesystem fuori cartella, processi, segnali, moduli interni di rete, sqlite, `getBuiltinModule`, ambiente: tutto bloccato; fetch solo agli host dichiarati, con tetto).
- Docker: immagine costruita e avviata (in questo ambiente solo aggiungendo la CA del proxy locale, come fa ogni rete con proxy TLS); healthcheck `healthy`, utente `node`, link dell'owner in un file 0600; login, chat, file, tool proposto approvato ed eseguito in sandbox, CLI; storico, file e tool approvato restano dopo `docker restart`. `docker compose config` valido.
- Non verificati: Telegram dal vivo, Gmail, HubSpot e i modelli veri (servono i segreti di Mario).

## Garanzie e limiti

| Cosa | Garanzia | Limite |
|---|---|---|
| Tool proposti | mai eseguiti prima dell'approvazione; poi solo in sandbox, verso gli host dichiarati | il blocco di rete e segnali nella sandbox è nostro (moduli consentiti, proprietà bloccate), non del kernel: per garanzie forti serve un egress firewall sul container e un utente di sistema separato |
| Allowlist e sessioni | applicate a ogni richiesta, anche se cambiate da un altro processo | |
| Connettori stdio | ambiente limitato a quello dichiarato | sono processi sul server: la loro rete va controllata a livello di deployment; solo l'owner li configura |
| Task programmati | nessun doppione dopo un crash, un solo recupero dopo uno spegnimento | granularità 30 secondi; un task di un'istanza chiusa aspetta la riapertura |
| File | non escono dal workspace | i file restano finché qualcuno non li cancella |
| Console | sessioni da 30 giorni, revocabili rigenerando il link | nessun 2FA; la console va messa dietro https |
| Istanze nuove | | dalla settimana 6 l'owner le crea anche dalla console ([week6.md](week6.md)) |

## Decisioni

Registrate negli ADR: [0001](adr/0001-pi-durable-dietro-interfaccia-nostra.md) Pi dietro interfacce nostre, [0002](adr/0002-tool-proposti-sandbox-e-approvazione.md) tool proposti solo dopo approvazione e in sandbox, [0003](adr/0003-mcp-per-i-connettori.md) MCP per i connettori, [0004](adr/0004-tool-per-istanza-e-riapertura.md) tool per istanza applicati riaprendo, [0005](adr/0005-interfaccia-web-senza-build.md) console senza build servita dal processo.

## Cosa manca

Vedi [`prodotto.md`](prodotto.md) e [`stato-e-todo.md`](stato-e-todo.md).
