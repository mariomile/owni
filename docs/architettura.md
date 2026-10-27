# Architettura di Owni

Owni è un agente sempre attivo per professionisti e piccoli team: i dati restano dove li mette la persona (il suo Mac, il suo server, una cella in UE) e niente esce senza una regola esplicita. Il runtime durevole è Pi Durable (`@earendil-works/pi-durable`, sperimentale) dietro un'interfaccia nostra ([ADR 0001](adr/0001-pi-durable-dietro-interfaccia-nostra.md)).

Questo documento è la mappa: processi, store su disco, confini di fiducia, garanzie. Le singole decisioni stanno negli [ADR](adr/); per l'esercizio, il [runbook](runbook.md). Ogni percorso citato esiste nel repository.

## 1. Processi

Lo stesso server (`src/app.ts`, `startOwni`) gira in tre modi. Un processo serve un tenant.

| Modo | Come parte | Dove stanno i dati |
|---|---|---|
| Server | `pnpm start` (`src/main/owni.ts`), o il container del [Dockerfile](../Dockerfile) | `OWNI_DATA_DIR` (nel container `/data`) |
| App per Mac | l'app Tauri in `desktop/` avvia il server nel bundle su `127.0.0.1` ([ADR 0034](adr/0034-app-desktop.md), [ADR 0096](adr/0096-owni-dentro-l-app-per-mac.md), [docs/desktop.md](desktop.md)) | `~/Library/Application Support/app.owni.desktop/data` |
| Owni Cloud | `pnpm cloud` (`src/main/cloud.ts`): un control plane (`src/cloud/control-plane.ts`) e una cella per tenant ([ADR 0007](adr/0007-owni-cloud-a-celle.md), [ADR 0008](adr/0008-celle-container-prima-delle-micro-vm.md), [docs/piano-cloud.md](piano-cloud.md)) | il volume di ogni cella; il control plane ha solo `control-plane.json` |

```text
 browser / app desktop / Telegram / WhatsApp / telefono
        │
        ▼
 src/web/server.ts  console (src/web/ui, senza build, ADR 0005) + API
 src/channels/*     adapter dei canali, collegati da src/gateway.ts
        │ submit / onReply
        ▼
 src/core  OwniRuntime ─► OwniInstance ─► DurableEngine (src/core/engine.ts)
                                            └─ src/core/adapters/pi-durable*.ts (unico import di Pi)
        │ strumenti
        ├─ src/connectors     MCP, Google, collegamenti API
        ├─ src/computer       il computer dell'agente (container o Fly)
        └─ src/desktop        lo schermo dell'agente
```

- **Server**: `src/app.ts` compone tutto (store, runtime, canali, console). Una persona sola o un piccolo team entra dalla console con un link personale.
- **App per Mac**: una finestra sulla console più il server nel bundle (Node, `dist/`, dipendenze di produzione). Si ferma con l'app; il server locale vive finché il Mac è acceso. Può anche collegarsi a un altro server.
- **Cella e control plane**: la cella è lo stesso container del server. Il control plane gestisce registrazione, pagamento (Stripe, [ADR 0010](adr/0010-abbonamento-stripe-con-prova.md)), smistamento per host (`<tenant>.<dominio>`), spegnimento delle celle inattive e risveglio per il prossimo task o per un webhook. Inoltra le richieste senza conservarle; il provider delle celle (`local-provider.ts`, `docker-provider.ts`, `railway-provider.ts`) è dietro l'interfaccia `src/cloud/provider.ts`.

Regole verificate da `test/boundaries.test.ts`: solo `src/core/adapters/pi-durable*.ts` importa pacchetti `@earendil-works/*`; `src/core` non importa nulla da `src/channels`.

## 2. Modello

- **Owner**: chi gestisce Owni (la persona stessa, o il reparto IT del cliente). Agisce dalla console come `owner`.
- **Tenant**: un cliente. Confine di isolamento per dati, segreti e audit.
- **Instance**: un agente del tenant, con modello, egress policy, istruzioni e storage durevole suoi ([ADR 0041](adr/0041-agenti.md)).
- **Person** (`src/web/auth.ts`): chi usa la console, con ruolo `owner` o `member` e verifica in due passaggi opzionale ([ADR 0006](adr/0006-verifica-in-due-passaggi-totp.md)).

Gli ID di tenant e istanza diventano nomi di directory, quindi sono validati (`src/core/ids.ts`): `../altro` viene rifiutato.

## 3. Store su disco

Il layout è definito in `src/core/paths.ts`. Sotto la `dataDir`:

```text
owner-login-link.txt                 link dell'owner, scritto una volta (da cancellare)
tenants/<tenant>/
  tenant.json
  secrets.json                       0600, non cifrato (TenantSecrets)
  audit.jsonl + audit-AAAA-MM.jsonl  append-only, solo metadati; archivi mensili per 12 mesi
  people.json  sessions.json         persone della console e sessioni
  usage.jsonl  usage-totals.json     registro dei consumi (src/core/usage.ts)
  board.json  board-routines.json    bacheca
  connectors.json  google-accounts.json
  rooms/                             stanze
  removed/                           istanze eliminate, fino alla cancellazione dei file
  instances/<istanza>/
    instance.json                    modello, egress, utenti consentiti, istruzioni
    instance.lock                    lock del processo che l'ha aperta
    engine/pi-durable.sqlite         storage Pi Durable (WAL)
    outbox/<hash>.json               risposte fino alla conferma del canale, 0600
    workspace/                       i file dell'agente
    memory.json  skills.json  automations.json  runs.json
    proposals/  tools/               strumenti proposti e approvati
    web-actions/  google-actions/  connector-actions/    richieste in attesa di approvazione
    schedules/  watches/
```

I file JSON condivisi con la CLI si scrivono con `src/core/locked-json.ts` (lock SQLite esclusivo, file temporaneo, `fsync`, `rename`, `fsync` della directory); i file che un solo processo riscrive usano `writeFileAtomic` (`src/core/atomic-file.ts`).

## 4. Confini di fiducia

| Confine | Cosa lo regge |
|---|---|
| Tenant contro tenant | directory, segreti, audit e storage separati; `TenantSecrets` e `AuditLog` sono legati a un solo tenant al costruttore. In Cloud, in più, una macchina per tenant e un dominio delle celle separato da quello di registrazione. |
| Persona contro persona | ruoli `owner` e `member` della console; ogni persona vede le sue stanze e i suoi agenti consentiti. |
| Utente di un canale | allowlist per istanza e per canale, default deny, controllata nel nucleo (`OwniInstance.submit`): un utente non consentito non raggiunge il modello e non riceve risposta. |
| Owni contro il mondo | egress policy per istanza (provider del modello e canali, default deny), `src/core/web-guard.ts` per le richieste verso il web, connettori con fetch che non segue i redirect. |
| Contenuto non fidato | pagine, file, mail e risultati dei connettori sono dati, non istruzioni (`src/core/untrusted.ts`); le azioni con effetti esterni passano da approvazioni decise dalla persona, non dal testo letto ([ADR 0088](adr/0088-conferme-solo-dalla-persona.md)). |
| Codice scritto dall'agente | `code_run`: Python in Pyodide dentro un processo Node con il permission model, senza rete né file fuori da quelli dati ([ADR 0119](adr/0119-programmi-python.md), `src/core/code-run.ts`). Strumenti proposti: processo separato con file system limitato alla loro cartella e rete solo attraverso la `fetch` con egress ([ADR 0002](adr/0002-tool-proposti-sandbox-e-approvazione.md), `src/core/sandbox.ts`). |
| Computer dell'agente | container senza capability e con radice in sola lettura, o macchina Fly; ha internet pubblico ma non la rete interna né i metadati del server ([ADR 0124](adr/0124-il-computer-dell-agente-ha-la-rete.md), `src/core/computer.ts`, `src/computer/`). |
| Control plane contro cella | il control plane tiene il segreto di ogni cella e inoltra con un token di proxy; vede i messaggi in transito ma non li conserva ([ADR 0007](adr/0007-owni-cloud-a-celle.md)). |
| App desktop | le pagine del server non hanno IPC con l'app; nella finestra restano solo le pagine di quel server ([ADR 0034](adr/0034-app-desktop.md)). |

Limiti dichiarati: `secrets.json` è in chiaro (permessi 0600), la policy di egress non è un firewall di rete, i lock POSIX non reggono NFS/SMB. I segreti e il backup coerente sono trattati nel [runbook](runbook.md).

## 5. Garanzie

### Una risposta non si perde (outbox)

Ogni risposta passa dall'outbox dell'istanza (`src/core/outbox.ts`) prima di arrivare a un canale: voce scritta all'ammissione del messaggio, riempita con la risposta (file temporaneo, `fsync`, `rename`, `fsync` della directory), marcata consegnata solo dopo l'ok del canale. Se `send` fallisce, il gateway ritenta con attese crescenti (5 s, 30 s, 2 min, poi ogni 10 min, al massimo 14 volte); un rifiuto definitivo non si ritenta nel processo. `resume()` all'avvio rimanda le risposte non consegnate e riaggancia le submission già chiuse.

La garanzia è **at-least-once**: dopo un crash tra l'invio e la marcatura l'utente può vedere la risposta due volte, e l'audit lo segna (`possibleDuplicate`). `OutboundMessage.idempotencyKey` porta la chiave fino ai canali che sanno deduplicare. Test: `test/outbox.test.ts` (SIGKILL reali). Limiti: sopra i 4096 caratteri una risposta Telegram è più messaggi; su macOS `fsync` non forza la cache del disco, quindi una perdita di corrente non è coperta; cancellare `engine/` tenendo `outbox/` confonde gli ID (si cancellano insieme).

### Crash e ripresa

Pi Durable riprende da dove era: i passi dei tool già fatti sono memoizzati (`ctx.step`), quindi dopo un `SIGKILL` il processo successivo li legge invece di rieseguirli. Per gli strumenti è at-least-once per passo: quelli con effetti esterni devono essere idempotenti o `replaySafe: false`. Test: `test/crash-resume.test.ts`.

### Un processo per istanza (lock)

`OwniRuntime` apre un'istanza solo dopo aver preso `instance.lock`, una transazione SQLite `BEGIN EXCLUSIVE` tenuta aperta: un lock del kernel che sparisce con il processo, in qualunque modo muoia. Un secondo processo riceve `InstanceLocked` con pid e host del primo. Test con processi reali: `test/lock.test.ts`.

### Approvazioni

Le azioni si approvano in base al rischio, non al connettore ([ADR 0120](adr/0120-approvazioni-per-rischio.md)): leggere e scrivere nello spazio di chi parla non chiede; uscire o distruggere (mail inviata, evento con invitati, pagamento, modulo web, strumento MCP non annotato) chiede sempre. Chi decide è un approvatore (`src/core/approvals.ts`): l'owner, o un utente consentito; chi non può viene rifiutato e registrato. Gli strumenti proposti dall'agente hanno sempre bisogno di un approvatore per nascere ([ADR 0002](adr/0002-tool-proposti-sandbox-e-approvazione.md)). Le richieste restano su disco finché qualcuno decide.

### Sandbox

Descritta ai confini di fiducia: `code_run` e strumenti proposti girano in processi con permessi ridotti, tempo e memoria limitati, output limitato; il computer dell'agente è un ambiente a parte con le sue regole di rete.

### Audit e consumi

`audit.jsonl` registra chi, dove, che cosa e quanto grande, mai il testo dei messaggi né i valori dei segreti. Il file ruota ogni mese e gli archivi si tengono 12 mesi ([ADR 0129](adr/0129-audit-a-rotazione-mensile.md)); la lettura recente (`AuditLog.read(last)`) legge dalla coda dei file con memoria limitata e la dimensione totale è in `auditBytes` di `/api/usage`. I consumi stimati stanno in `usage.jsonl`; il tetto di spesa è in `src/core/usage.ts`, ma la sua applicazione su tutti i percorsi non è ancora uniforme (vedi [l'audit del codice](codebase-health-2026-10-27.md)).

## 6. Rischi di Pi Durable

Pi Durable è sperimentale. Mitigazioni: versione esatta, tutto il codice Pi in un adapter, `DurableEngine` e `EngineSession` nostre, test di confine e `test/crash-resume.test.ts` come gate di upgrade. Un upgrade si prova su una copia dei dati; non c'è migrazione automatica. `resume()` va chiamato all'avvio prima di accettare messaggi.
