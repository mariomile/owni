# Settimana 2: hardening prima del deploy

Branch `week2-hardening`. Dettagli di design in [`architettura.md`](architettura.md) (sezioni 4 e 5).

## Cosa funziona (verificato dai test)

- **Allowlist utenti per istanza e canale** (`test/allowlist.test.ts`). `instance.json` ha `allowedUsers: { <canale>: [userId, ...] }`, default vuoto: nessuno può scrivere all'istanza finché l'owner non lo configura. Il controllo è nel nucleo (`OwniInstance.submit`), quindi vale per ogni canale. Un utente non consentito non arriva al motore durevole (il test conta zero `submit` sul motore), non riceve risposta (nessun `sendMessage` nel flusso Telegram completo) e ogni rifiuto è nell'audit del tenant come `user.denied` con canale, userId, threadId e motivo. La lista è per canale: un utente consentito su Telegram non lo è automaticamente su un altro canale.
- **Lock per istanza** (`test/lock.test.ts`, processi figli reali). Il secondo processo che apre la stessa istanza fallisce subito con `InstanceLocked` e il pid del proprietario. Dopo `SIGKILL` del proprietario un nuovo processo apre l'istanza senza intervento manuale. Chiudere l'istanza libera il lock anche se il processo resta vivo. Funziona anche tra due `OwniRuntime` nello stesso processo.
- **Outbox persistente delle risposte** (`test/outbox.test.ts`). Ogni messaggio ammesso ha una voce nell'outbox dell'istanza; la risposta ci viene scritta (file atomico con fsync) prima che il canale la veda, con chiave di idempotenza `reply:<tenant>/<istanza>/<submissionId>`, e marcata consegnata dopo l'ok del canale.
  - Processo ucciso con `SIGKILL` dopo la scrittura nell'outbox e prima dell'invio: il processo successivo, con `resume()`, la invia; il fetch finto di Telegram riceve esattamente un `sendMessage` in tutto. Un terzo avvio non invia nulla.
  - Processo ucciso dopo che Telegram ha ricevuto il messaggio e prima della marcatura: il processo successivo lo invia di nuovo. Il fetch finto riceve due `sendMessage`, e l'audit registra `reply.delivered` con `attempts: 2, possibleDuplicate: true`.
  - Risposta chiusa in Pi ma mai arrivata all'outbox (simulato con un motore che non inoltra le risposte): alla ripresa il nucleo la riaggancia per ID (`EngineSession.reattach`) e la invia una volta.
  - Invio fallito (canale giù): la voce resta nell'outbox e parte una sola volta al `resume()` successivo, anche con tre `resume()` concorrenti.
  - Conferma del canale che arriva dopo `close()`: non riapre l'istanza (il lock resta libero), la risposta riparte al processo successivo.
- **Test di crash ripetuti**: vedi la sezione Verifica.
- **Review indipendente**: un revisore separato ha trovato 9 problemi sul primo giro. Corretti: risposta persa tra Pi e outbox, possibile doppio invio nello stesso processo con `resume()` concorrenti, conferma tardiva che riapriva l'istanza dopo `close()` lasciando il lock preso, chiave non unica tra tenant, lock non rilasciato su alcuni percorsi d'errore. Gli altri sono documentati come limiti.

## Verifica

Eseguita su questo branch, Node 22.22.3, macOS:

- `pnpm typecheck`: nessun errore. `pnpm build`: ok.
- `pnpm test`: 9 file, 36 test, 0 fallimenti. Ripetuta 5 volte di fila: 36/36 ogni volta.
- Test di crash (`crash-resume`, `lock`, `outbox`, 12 test con processi figli reali e `SIGKILL`): 10 esecuzioni di fila, 12/12 ogni volta.
- Mutazioni: togliendo il controllo allowlist, il lock, il rinvio dell'outbox in `resume()`, il riaggancio per ID o il divieto di riaprire l'istanza in `markDelivered`, i test corrispondenti falliscono.
- Un test instabile trovato durante le ripetizioni (1 fallimento su circa 30): il test leggeva l'audit prima che `reply.delivered` fosse scritto. Corretto il test; il codice era giusto.

## Garanzie e limiti

| Cosa | Garanzia | Limite |
|---|---|---|
| Consegna risposte | at-least-once, al massimo una volta per processo | exactly-once impossibile su Telegram: `sendMessage` non ha chiave di idempotenza. Crash dopo l'invio e prima della marcatura = doppione, contato nell'audit |
| Consegna risposte | nessuna perdita dopo l'ammissione registrata nell'outbox | resta una finestra tra l'ammissione in Pi e la scrittura della voce: se in quei millisecondi Pi chiude anche la submission (solo con il modello locale) e il processo muore, la risposta non parte |
| Invio fallito | ritentato al prossimo avvio | nessun ritentativo nello stesso processo |
| Lock | un processo per istanza, rilasciato dal kernel alla morte del proprietario | solo filesystem locali: i lock POSIX non sono affidabili su NFS/SMB |
| Allowlist | nessun messaggio di sconosciuti raggiunge motore o modello | vale dalla prossima apertura dell'istanza, come la egress policy |
| Durabilità su disco | fsync di file e directory | su macOS `fsync` non svuota la cache del disco: coperto il crash del processo, non lo spegnimento improvviso |

## Decisioni

- **Rifiuto silenzioso.** Un utente non consentito non riceve nessuna risposta. Una frase fissa confermerebbe a uno sconosciuto che il bot esiste e aprirebbe traffico in uscita verso chi non è autorizzato. Il rifiuto resta visibile all'owner nell'audit e nel log del processo.
- **Lock del kernel, non file con PID.** Il lock è una transazione SQLite esclusiva tenuta aperta (`node:sqlite`, già richiesto da Pi). Il kernel lo rilascia quando il processo muore, quindi non c'è un lock stale da riconoscere, nessun PID riusato che inganna il controllo e nessuna gara tra due processi che recuperano lo stesso lock. Il file `instance.lock.owner` serve solo a dire chi tiene il lock.
- **Outbox dall'ammissione, non dalla risposta.** La voce nasce quando il motore ammette il messaggio, così alla ripresa il nucleo sa quali submission aspettano ancora una risposta e le chiede al motore per ID. Costa una scrittura con fsync in più per messaggio in arrivo.
- **Outbox nel nucleo, conferma dal gateway.** L'outbox vive con lo storage dell'istanza (stesso tenant, stesso lock, file 0600, testo mai nell'audit). Il gateway, che sa quando il canale ha accettato, chiama `runtime.markDelivered()`. Il nucleo continua a non conoscere i canali.
- **Una scrittura per consegna.** `attempts` è incrementato e salvato in un'unica scrittura prima di ogni consegna: serve sia come "scritto prima dell'invio" sia per riconoscere i possibili doppioni.
- **Chiave di idempotenza fino al canale.** `OutboundMessage.idempotencyKey` esiste già per i canali API/webhook, dove il destinatario può deduplicare. Telegram la ignora.
- **`pnpm dev:telegram`**: nuova variabile `OWNI_TELEGRAM_ALLOWED_USERS` (ID numerici separati da virgola). Se è impostata sostituisce la lista Telegram dell'istanza a ogni avvio; se la lista resta vuota il processo lo dice all'avvio.

## Cosa manca

- **Finestra tra ammissione e voce nell'outbox**: chiuderla del tutto richiede di scrivere la voce nello stesso commit di Pi che ammette il messaggio.
- **Ritentativi nello stesso processo** con backoff, invece di aspettare il riavvio.
- **Pulizia dell'outbox**: le voci consegnate restano su disco per sempre.
- **Robustezza dell'outbox**: un file corrotto da fuori blocca `resume()`; una voce verso un canale tolto dalla policy resta in coda per sempre.
- **Gestione dell'allowlist a caldo**: oggi serve riaprire l'istanza (riavvio).
- Dalla settimana 1, ancora aperti: messaggi persi se `submit` fallisce dopo l'avanzamento dell'offset Telegram, segreti non cifrati a riposo, token Telegram per processo invece che per tenant, nessun test con un modello reale.

## Comandi

```bash
pnpm typecheck
pnpm test
pnpm vitest --run test/crash-resume.test.ts test/lock.test.ts test/outbox.test.ts   # solo i test di crash
```
