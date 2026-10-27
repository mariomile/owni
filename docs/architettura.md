# Architettura di Owni

Owni è un agente sempre attivo, sul modello di Hermes Agent, pensato per aziende attente a privacy e controllo dei processi: self-host o on-prem, multi-tenant, nessun dato in uscita senza una configurazione esplicita. Il runtime durevole è Pi Durable (`@earendil-works/pi-durable`, MIT, sperimentale), nascosto dietro un'interfaccia nostra.

Stato: settimana 2 (allowlist utenti, lock per istanza, outbox delle risposte). Questo documento descrive cosa c'è nel codice oggi e cosa è solo progettato. Dove una cosa non è ancora implementata è scritto esplicitamente.

## 1. Mappa

```text
                Owner (futura dashboard)
                        │ TenantRegistry
                        ▼
   ┌──────────────── src/core ─────────────────────────────────────┐
   │ OwniRuntime                                                   │
   │   ├─ TenantRegistry   tenant.json, instance.json               │
   │   ├─ TenantSecrets    secrets.json (0600) per tenant           │
   │   ├─ AuditLog         audit.jsonl append-only per tenant       │
   │   ├─ EgressPolicy     default deny: provider modello + canali  │
   │   ├─ AllowedUsers     default deny: utenti per canale          │
   │   └─ OwniInstance ──► DurableEngine (interfaccia)             │
   │        ├─ InstanceLock  un solo processo per istanza           │
   │        └─ Outbox        risposte fino alla conferma del canale │
   │                           ▲                                    │
   │        src/core/adapters/pi-durable*.ts (unico import di Pi)   │
   └────────────────────────────────────────────────────────────────┘
                        ▲ submit / onReply
                        │
                 src/gateway.ts  (unico modulo che conosce core e canali)
                        │ onInbound / send
                        ▼
   src/channels/types.ts   ChannelAdapter, InboundMessage, OutboundMessage
   src/channels/telegram.ts  (implementato)
   src/channels/whatsapp.ts  (implementato, Cloud API di Meta, solo webhook)
   src/web/channel.ts        (implementato, la console)
   desktop, API/webhook, mobile  (solo interfaccia, sezione 6)
```

Regole verificate da `test/boundaries.test.ts`:

- Solo `src/core/adapters/pi-durable*.ts` importa pacchetti `@earendil-works/*`.
- `src/core` non importa nulla da `src/channels`.

## 2. Modello: Owner, Tenant, Instance

- **Owner**: chi installa e gestisce Owni (Buildrs o il reparto IT del cliente on-prem). Oggi agisce via codice sul `TenantRegistry`; in futuro tramite una dashboard owner che userà la stessa API.
- **Tenant**: un cliente. Confine di isolamento per dati, segreti, memoria e audit.
- **Instance**: un agente di un tenant. Ha il suo modello, la sua egress policy, le sue istruzioni e il suo storage durevole. Un tenant può avere più istanze (es. "assistente interno" e "amministrazione").

### Layout su disco

```text
data/
  tenants/<tenantId>/
    tenant.json
    secrets.json                 mode 0600
    audit.jsonl                  append-only
    instances/<instanceId>/
      instance.json              modello, egress policy, utenti consentiti, istruzioni
      instance.lock              lock del processo che ha aperto l'istanza
      instance.lock.owner        pid, host e ora del proprietario (solo per il messaggio d'errore)
      engine/pi-durable.sqlite   storage Pi Durable dedicato (WAL)
      outbox/<hash>.json         una voce per submission ammessa, con la risposta quando arriva; mode 0600
```

Gli ID di tenant e istanza diventano nomi di directory, quindi sono validati (`a-z0-9_-`, max 63 caratteri, niente punti né separatori): un ID come `../altro` viene rifiutato (testato).

## 3. Interfacce

### Nucleo (`src/core`)

```ts
class OwniRuntime {
  registry: TenantRegistry;                       // createTenant, createInstance, get/list
  secrets(tenantId): TenantSecrets;               // legato a un solo tenant
  audit(tenantId): AuditLog;                      // legato a un solo tenant
  openInstance(tenantId, instanceId): Promise<OwniInstance>;
  submit(req: SubmitRequest): Promise<{ submissionId }>;
  resume(tenantId, instanceId): Promise<{ pending, undelivered, reattached }>;
  onReply(listener: (reply: Reply) => void): () => void;
  markDelivered(reply): Promise<void>;           // il canale ha accettato la risposta
  close(): Promise<void>;
}

type SubmitRequest = { tenantId, instanceId, channel, threadId, userId, text, messageId? };
type Reply = { tenantId, instanceId, channel, threadId, deliveryId } &
  ({ status: "answered"; text } | { status: "unanswered"; reason });

// instance.json
type InstanceRecord = { id, tenantId, name, model, egress, allowedUsers, instructions?, createdAt };
type AllowedUsers = Record<channel, userId[]>;   // canale assente o lista vuota = nessuno
registry.setAllowedUsers(tenantId, instanceId, channel, userIds);   // vale dalla prossima apertura
```

`deliveryId` è la chiave di idempotenza della risposta (`reply:<tenantId>/<instanceId>/<submissionId>`), stabile tra i riavvii e unica tra tenant e istanze.

`SubmitRequest` ha la stessa forma di `InboundMessage` dei canali, ma è definito nel nucleo: il nucleo non dipende dai canali, il gateway passa l'uno all'altro.

### Motore durevole (`src/core/engine.ts`)

```ts
interface DurableEngine { open(options: EngineOpenOptions): Promise<EngineSession> }

type EngineOpenOptions = {
  storageDir;                                   // directory esclusiva dell'istanza
  model: { provider, modelId };
  apiKey: (provider) => Promise<string | undefined>;   // unica fonte di credenziali
  tools: OwniTool[];
  instructions?;
};

interface EngineSession {
  submit(threadKey, text, requestId?): Promise<{ submissionId }>;  // ammesso in modo durevole
  resume(): Promise<{ pending }>;
  reattach(submissionId, threadKey): Promise<boolean>;   // riemette l'esito di una submission già ammessa, anche chiusa
  onReply(listener): () => void;
  idle(): Promise<void>;
  close(): Promise<void>;
}

type OwniTool = {
  name; description; parameters /* JSON Schema */;
  replaySafe: boolean;
  execute(args, ctx: { step(key, work), progress(text), signal }): Promise<string>;
};
```

`ctx.step(key, work)` è il checkpoint durevole di un tool: esegue `work` al massimo una volta per chiamata e chiave, e dopo un crash restituisce il risultato salvato senza rieseguirlo. Nell'adapter è implementato con `api.memo()` di Pi Durable (memo durevole, first-writer-wins, legato al task del tool).

### Canali (`src/channels/types.ts`)

```ts
interface ChannelAdapter {
  name: string;                          // "telegram", ...
  start(): Promise<void>;
  stop(): Promise<void>;
  onInbound(handler: (m: InboundMessage) => Promise<void>): void;
  send(m: OutboundMessage): Promise<void>;   // risolve solo quando il canale ha accettato tutto
}
type InboundMessage  = { tenantId, instanceId, channel, threadId, userId, text, messageId? };
type OutboundMessage = { tenantId, instanceId, channel, threadId, text, idempotencyKey };
```

`idempotencyKey` è il `deliveryId`: un canale il cui destinatario deduplica (API HTTP con header `Idempotency-Key`) lo deve inoltrare. Telegram non ha un meccanismo equivalente e lo ignora.

## 4. Flussi

### Messaggio in arrivo e risposta

```text
Telegram getUpdates ─► TelegramAdapter ─► InboundMessage
  ─► gateway ─► OwniRuntime.submit
       ├─ egress: il canale è consentito?        no ─► EgressDenied + audit "egress.denied"
       ├─ allowlist: l'utente è consentito su questo canale?
       │                                         no ─► UserNotAllowed + audit "user.denied", nessuna risposta
       ├─ audit "message.received" (solo metadati: canale, thread, utente, lunghezza)
       ├─ EngineSession.submit(threadKey = "telegram:<chatId>", text, requestId = "telegram:<chatId>:<messageId>")
       │    ├─ conversazione Pi per threadKey (creata al primo messaggio, mappa salvata nello stesso commit)
       │    └─ conversation.submit(): ammissione durevole, poi generazione e tool come task Pi
       └─ outbox: voce per la submission, ancora senza risposta
  ◄─ submission.wait() ◄─ risposta del modello
       ├─ outbox: chiave reply:<tenant>/<istanza>/<submissionId> già consegnata? sì ─► niente
       ├─ egress: il canale è ancora consentito? (secondo controllo, in uscita)
       ├─ outbox: scrittura atomica e fsync della voce (attempts + 1)
       └─ audit "reply.emitted" ─► onReply
  ─► gateway ─► TelegramAdapter.send ─► sendMessage (spezzato a 4096 caratteri)
       └─ ok del canale ─► runtime.markDelivered ─► outbox: deliveredAt ─► audit "reply.delivered"
```

Un messaggio riconsegnato da Telegram (stesso `message_id`, es. dopo un crash prima della conferma dell'offset) produce lo stesso `requestId`: Pi Durable lo riconosce e non c'è una seconda risposta (testato).

### Crash e ripresa

```text
processo A: submit("conta fino a 6") ─► pi.generation ─► tool slow_counter (replay: "safe")
            step 1 ✓ memo, step 2 ✓ memo, step 3 ✓ memo, ── SIGKILL ──
processo B: openInstance ─► Harness.open(stesso SQLite) ─► resume()
            harness.resume() riparte dallo stato salvato; inspect() trova la submission aperta
            il tool riparte: step 1-3 letti dai memo, step 4-6 eseguiti ─► risposta ─► onReply
```

Verificato da `test/crash-resume.test.ts` con due processi figli reali e `SIGKILL`. Il processo B riesce ad aprire l'istanza perché il lock di A è sparito con A (sezione 5). Garanzia: at-least-once per step. Uno step il cui lavoro è finito ma il cui memo non è stato ancora scritto al momento del crash viene rieseguito; i tool con effetti esterni devono quindi essere idempotenti anche dentro lo step (es. chiave di idempotenza verso il CRM).

### Consegna delle risposte (outbox)

Ogni risposta passa dall'outbox dell'istanza prima di arrivare a un canale:

1. Quando il motore ammette un messaggio, il nucleo scrive nell'outbox una voce per quella submission, senza risposta.
2. Quando il motore risponde, il nucleo riempie la voce (testo o motivo, `attempts + 1`) e la scrive in `outbox/<hash>.json`: file temporaneo, `fsync`, `rename`, `fsync` della directory. Solo dopo la emette ai listener. Se la voce risulta già consegnata, si ferma.
3. Il gateway chiama `adapter.send`; quando risolve, chiama `runtime.markDelivered`, che riscrive la voce con `deliveredAt` e scrive `reply.delivered` nell'audit.
4. Se `send` fallisce, la voce resta non consegnata e il gateway lo dice al nucleo (`runtime.deliveryFailed`, con il numero del tentativo). Un fallimento (rete, timeout, o un rifiuto «non ora» come un 429 di Telegram, `ChannelRefused` con `retryable`) riparte nello stesso processo dopo 5 s, 30 s, 2 min e poi ogni 10 min, al massimo 14 volte (audit `reply.retry_scheduled`, poi `reply.retries_exhausted`). Un rifiuto definitivo (`ChannelRefused`: per esempio un bot bloccato, o un file non più nel workspace) non si ritenta nel processo (audit `reply.refused`). Un fallimento di un tentativo già superato (dopo una riapertura che l'ha rimandato) viene ignorato. `close()` annulla i ritentativi in sospeso.
5. `resume()` all'avvio, prima di riprendere il motore, rimanda ogni voce con risposta non consegnata e chiede al motore di riemettere (`reattach`) l'esito di ogni voce ancora senza risposta, anche se in Pi la submission è già chiusa.

Le operazioni sulla stessa voce sono serializzate e rileggono il file prima di agire; ogni voce è affidata ai canali al massimo una volta per processo, anche con più `resume()` concorrenti o se il motore riemette la stessa risposta. Dopo `close()` le risposte che arrivano e le conferme tardive del canale non toccano più l'outbox: restano per il processo successivo.

Garanzia: **at-least-once**, non exactly-once.

| Crash | Cosa succede | Test |
|---|---|---|
| dopo la scrittura nell'outbox, prima dell'invio | il processo successivo invia una volta | `outbox.test.ts`, SIGKILL reale: un solo `sendMessage` in tutto |
| dopo che Telegram ha ricevuto il messaggio, prima della marcatura | il processo successivo invia di nuovo: l'utente lo vede due volte | `outbox.test.ts`, SIGKILL reale: due `sendMessage`, audit `possibleDuplicate: true` |
| dopo che Pi ha chiuso la submission, prima che la risposta sia nell'outbox | il processo successivo la riaggancia per ID e la invia una volta | `outbox.test.ts`, simulato con un motore che non inoltra le risposte |
| dopo l'ammissione in Pi, prima della voce senza risposta | se la submission è ancora aperta, la ripresa di Pi la trova; se Pi l'ha già chiusa (servono millisecondi, possibile solo con il modello locale) la risposta non parte | non coperto |

Exactly-once non è possibile con Telegram: `sendMessage` non accetta una chiave di idempotenza, e dopo un crash non si può sapere se il messaggio è partito. Mitigazioni in atto:

- La finestra è minima: la marcatura avviene subito dopo l'ok del canale.
- `attempts` è salvato prima di ogni consegna: con `attempts > 1` l'audit registra `possibleDuplicate: true`, quindi i doppioni sono contabili.
- `OutboundMessage.idempotencyKey` porta la chiave fino al canale: per i canali API/webhook futuri il destinatario può deduplicare, e lì la consegna diventa effectively-once.

Limiti:

- **Ritentativi**: dopo 14 tentativi nello stesso processo, o dopo un rifiuto definitivo, la risposta aspetta il prossimo avvio. Un nuovo tentativo porta «Possibile doppione» anche quando il precedente era un rifiuto (quindi non arrivato): è un falso allarme accettato.
- **Messaggi lunghi**: una risposta oltre 4096 caratteri sono più `sendMessage`; un crash a metà rimanda tutti i pezzi.
- **Pulizia**: a ogni `resume()` le risposte alle persone (chiavi `reply:`) consegnate da più di 30 giorni vengono tolte (audit `outbox.pruned`). I messaggi che l'istanza manda da sé (chiavi `msg:`, per esempio gli avvisi di un tool da approvare) restano: sono loro a impedire un secondo avviso.
- **Canale tolto dalla policy**: una voce verso un canale non più consentito resta non consegnata e a ogni avvio produce di nuovo `egress.denied`.
- **File illeggibile**: un file dell'outbox corrotto da fuori (le scritture di Owni sono atomiche) fa fallire `resume()` con l'errore di parsing invece di saltarlo.
- **Reset parziale**: cancellare `engine/` e tenere `outbox/` fa ripartire gli ID di Pi; voci vecchie con lo stesso ID verrebbero prese per già consegnate. Si cancellano insieme.
- **macOS**: `fsync` non forza la cache del disco (serve `F_FULLFSYNC`); su Linux sì. Un crash del processo è coperto, un'interruzione di corrente su macOS no.

## 5. Isolamento ed egress

### Isolamento per tenant

| Risorsa | Come è isolata | Test |
|---|---|---|
| Storage conversazioni e task | un file SQLite Pi Durable per istanza, sotto la directory del tenant | `isolation.test.ts`: i byte su disco di un tenant non contengono dati dell'altro |
| Segreti | `TenantSecrets` è costruito per un solo tenant e legge solo il suo file (0600) | stesso test |
| Chiavi modello | l'engine riceve solo una funzione `apiKey` che legge i segreti del tenant dell'istanza | `isolation.test.ts`: acme riceve la sua chiave, mai quella di globex |
| Audit | un `audit.jsonl` per tenant; ogni record porta il `tenantId` | stesso test |
| Risposte in uscita | outbox sotto la directory dell'istanza; contiene testo, quindi file 0600 e mai nell'audit | `outbox.test.ts` |
| Memoria | per ora la memoria è il transcript Pi dell'istanza, quindi segue lo storage | |

L'isolamento oggi è di processo condiviso: più tenant possono girare nello stesso processo Node, separati da file e API. Per clienti che lo richiedono, il deployment consigliato è un processo (o container) per tenant, con lo stesso layout. Con un container per tenant l'isolamento diventa anche di sistema operativo.

### Un processo per istanza (lock)

`OwniRuntime` apre un'istanza solo dopo aver preso il lock `instance.lock`, prima di toccare lo storage di Pi o l'outbox, e lo rilascia in `close()`. Un secondo processo (o un secondo `OwniRuntime` nello stesso processo) riceve subito:

```text
InstanceLocked: Instance acme/ops is already open in another process (pid 4242 on host-a, since 2026-10-15T21:00:00.000Z).
An instance runs in one process at a time: stop the other one first.
```

Il lock è una transazione SQLite `BEGIN EXCLUSIVE` tenuta aperta, cioè un lock POSIX gestito dal kernel. Quando il proprietario muore, in qualunque modo (SIGKILL, OOM, crash), il kernel lo rilascia: non esistono lock "stale" da riconoscere. Scartato il classico file con PID: un PID riusato da un altro processo terrebbe il lock bloccato, e due processi che recuperano insieme un lock stale possono entrambi credere di averlo. `instance.lock.owner` (pid, host, ora) serve solo al messaggio d'errore e può restare indietro dopo un crash senza effetti.

Testato con processi figli reali (`test/lock.test.ts`): il secondo processo fallisce con il pid del primo, il primo viene ucciso con SIGKILL, un terzo apre l'istanza; chiudere l'istanza libera il lock anche se il processo resta vivo.

Limite: i lock POSIX non sono affidabili su filesystem di rete (NFS, SMB). `data/` deve stare su disco locale o su un volume a blocchi del container.

### Utenti consentiti (allowlist)

Ogni istanza ha `allowedUsers` in `instance.json`: per canale, gli ID utente nativi del canale (per Telegram lo user ID numerico). Default: nessuno. Il controllo sta nel nucleo, in `OwniInstance.submit`, dopo il controllo egress del canale e prima di qualunque altra cosa: vale per ogni canale presente e futuro, non solo per Telegram.

Un messaggio da un utente non consentito:

- non arriva al motore durevole né al modello (testato con un motore che conta le `submit`);
- non riceve risposta. Scelta: silenzio invece di una frase fissa, perché rispondere conferma a uno sconosciuto che il bot esiste e apre un canale in uscita verso chi non è autorizzato;
- è registrato nell'audit del tenant come `user.denied` con `channel`, `userId`, `threadId` e `reason` (`no_users_allowed_on_channel` o `user_not_in_allowlist`), mai il testo.

`registry.setAllowedUsers()` riscrive `instance.json` in modo atomico e registra `instance.allowlist.updated`; come la egress policy, vale dalla prossima apertura dell'istanza. `pnpm dev:telegram` la imposta all'avvio da `OWNI_TELEGRAM_ALLOWED_USERS`.

### Egress policy (default deny)

```ts
type EgressPolicy = { modelProviders: string[]; channels: string[] };   // vuoto = nulla
```

- Un'istanza creata senza policy ha `{ modelProviders: [], channels: [] }` e non può aprire alcun modello (testato).
- **Modello**: all'apertura dell'istanza il provider configurato deve essere nella lista, altrimenti `EgressDenied` e audit. Nell'adapter Pi viene registrato solo quel provider in pi-ai, e pi-ai riceve un `authContext` vuoto: nessuna chiave da variabili d'ambiente o file di credenziali locali, solo dal secret store del tenant (verificato sul codice di pi-ai 1.3.0: una credenziale salvata ha precedenza e le fonti ambientali sono lette solo tramite `authContext`).
- **Canali**: un messaggio da un canale non consentito è rifiutato prima di arrivare al motore (testato); una risposta verso un canale non consentito non viene emessa.
- Con il modello locale `faux` un'intera conversazione con tool non fa alcuna chiamata di rete (testato con `fetch` intercettato).

Limiti attuali, da sapere:

- La policy controlla chi Owni contatta tramite i suoi moduli. Non è un firewall: un tool scritto male potrebbe aprire connessioni proprie. Per garanzie forti serve anche un controllo di rete a livello di deployment (egress firewall del container).
- La policy è letta all'apertura dell'istanza: una modifica a `instance.json` vale dal riavvio successivo.
- pi-ai rispetta `HTTPS_PROXY`/`HTTP_PROXY` dell'ambiente: in un deployment con proxy, il proxy vede le richieste verso il provider consentito.
- Il canale Telegram usa un token di processo (`TELEGRAM_BOT_TOKEN`), non un segreto per tenant: un bot per processo.

## 6. Roadmap canali

Ogni canale è un `ChannelAdapter` con un `name` che la policy dell'istanza deve consentire. Nessuno dei seguenti è implementato.

| Canale | Forma prevista | Note |
|---|---|---|
| Telegram | long polling Bot API (fatto) | webhook in uscita quando serve scalare |
| API / webhook | server HTTP: `POST /v1/tenants/:t/instances/:i/threads/:thread/messages`, risposta via webhook firmato o polling | primo canale enterprise: integrazione con sistemi interni |
| Web app | adapter che espone thread via HTTP + streaming (SSE/WebSocket) | Pi Durable ha `viewState()`/`watch()` per seguire una conversazione dal vivo e più client sulla stessa conversazione; servirà estendere `EngineSession` con un'operazione di osservazione |
| Desktop | stessa API della web app, client nativo | nessun adapter separato se parla con l'API |
| Mobile | stessa API, notifiche push come canale di uscita | push = adapter solo `send` |

Due estensioni previste dell'interfaccia, da fare quando arriva il primo canale che le richiede: streaming di risposte parziali e azioni strutturate (pulsanti Approva/Scarta per l'human-in-the-loop).

## 7. Rischi di Pi Durable sperimentale

| Rischio | Mitigazione in atto |
|---|---|
| API che cambia senza preavviso tra release (README: "Experimental") | versione pinnata esatta (`1.3.0`, anche `pi-ai` e `chord`); tutto il codice Pi in un adapter (~280 righe in due file); `DurableEngine` è nostra; test di confine che impedisce import di Pi altrove |
| Formato dello storage che cambia tra versioni | un upgrade va provato su una copia di `data/`; test crash-resume come gate di upgrade. Nessuna migrazione automatica per ora |
| Un solo processo per storage, nessun lock tra processi (README Pi) | lock nostro per istanza, preso prima di aprire Pi e rilasciato dal kernel se il processo muore (sezione 5) |
| `node:sqlite` non è ancora stabile in Node 24 (release candidate) | Node 24.22+ richiesto dal pacchetto (LTS) |
| Replay dei tool: at-least-once, non exactly-once | `replaySafe` esplicito per tool; i tool con effetti esterni devono essere idempotenti; i tool non ripetibili (invio email) restano `replaySafe: false` e il modello riceve un risultato "interrupted" |
| Comportamento di `resume()`: lo scheduler riparte anche al primo `submit` | `resume()` di Owni va chiamato all'avvio prima di accettare messaggi, per riagganciare le risposte in sospeso ai canali |
| Progetto giovane, numeri GitHub anomali (vedi piano iniziale) | dipendiamo da poche primitive (Harness, conversation, submit/wait, tool con memo, SQLite storage); sostituibili dietro `DurableEngine` se necessario |

## 8. Decisioni e alternative scartate

- **Un'istanza = uno storage Pi Durable**, non un Harness condiviso con una conversazione per tenant: isolamento fisico dei dati, backup e cancellazione per istanza con un `rm -r`, ed è coerente con il modello "un processo possiede uno storage" di Pi.
- **Thread del canale → conversazione Pi**, mappa salvata come documento Pi di sessione nello stesso commit che crea la conversazione: non può puntare a una conversazione inesistente.
- **Segreti in JSON 0600 non cifrato**: sufficiente per self-host su macchina del cliente nella settimana 1. Prossimo passo: cifratura a riposo con chiave fornita dall'owner (o KMS/Vault del cliente) dietro la stessa classe.
- **Audit senza contenuti**: l'audit registra metadati (chi, dove, quanti caratteri, esito), mai testo dei messaggi o risposte. Il contenuto vive solo nello storage dell'istanza.
- **Modello predefinito**: Anthropic `claude-sonnet-5-5` via pi-ai. Il provider `faux` (modello locale deterministico di pi-ai, nessuna rete, nessuna chiave) serve per test e sviluppo.
