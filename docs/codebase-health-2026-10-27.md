# Owni — Salute della codebase e best practice

Data: 27 ottobre 2026  
Baseline: `main`, commit `1e7cefc0d01f4f00ea39d91448e7dd258b6eb333`  
Repository: `/Users/mariomiletta/Dev Projects/owni`

## Giudizio

**Owni ha fondamenta valide per un agente locale durevole, ma non considererei chiusi i requisiti di isolamento delle sessioni e controllo dei costi.** Il runtime ha contratti espliciti per ripresa dopo crash, consegna, approvazione ed esiti incerti. La qualità è meno uniforme quando questi contratti attraversano frontend, eventi live, contabilità e distribuzione.

L'analisi individua **3 problemi P1 e 5 P2**. Cinque sono riprodotti mediante codice reale con input controllati, uno mediante la funzione reale di ammissione del risveglio cloud; due derivano direttamente dalla configurazione CI e dal DOM costruito dalla palette. Le riproduzioni isolate non sono incidenti osservati in produzione.

La raccomandazione è una fase di consolidamento mirata: Chiudere privacy e budget, rendere effettivi i controlli CI, poi migliorare i confini dei moduli. Non emerge una ragione per riscrivere il prodotto o sostituire il frontend con un framework.

## Perimetro e metodo

Ispezione di sorgenti, test, configurazioni, documentazione e workflow del checkout attuale. Tre analisi indipendenti hanno coperto runtime/persistenza, sicurezza e frontend/distribuzione; le conclusioni sono state integrate con controlli locali e verifica delle fonti.

Sono stati eseguiti typecheck, build, suite completa, riesecuzione del file fallito, eval deterministiche, parsing sintattico dei moduli JavaScript e audit delle dipendenze di produzione. Le prove sui difetti usano modello faux, filesystem temporaneo o dipendenze in memoria.

Non sono stati eseguiti un penetration test, un benchmark di carico, un audit completo di tutti i percorsi, nuove prove manuali di UX, test con screen reader, build native o test con modelli a pagamento. Non sono state verificate l'app installata, le immagini pubblicate, le impostazioni di branch protection o la cronologia Actions. Nessuna modifica al codice applicativo, nessun commit, push, deploy o aggiornamento dell'app. La directory preesistente `.claude/` è stata preservata.

Le osservazioni si riferiscono all'intera baseline; non sono attribuite automaticamente all'ultima PR.

## Dimensione e struttura

Conteggi sui file tracciati, righe fisiche incluse righe vuote/commenti. Per `src/` è escluso il bundle minificato OpenUI; altri asset di codice generati possono essere inclusi. Non sono percentuali di copertura.

| Area | File | Righe |
|---|---:|---:|
| Sorgenti TS/JS/CSS in `src/`, escluso il bundle minificato | 264 | 53.246 |
| File TS di test e supporto | 128 | 27.366 |
| File delle eval | 9 | 565 |
| Codice JS/CSS/Rust/Swift desktop | 11 | 1.867 |
| Solo JavaScript della console | 41 | 8.679 |

Ci sono **116 file `.test.ts`** e **128 documenti Markdown nella directory ADR**. Il rapporto fra righe di test e sorgenti indica investimento nei test, non dimostra quanto comportamento sia coperto.

I punti più concentrati sono `runtime.ts` (1.212 righe), `pi-durable.ts` (954), `app.ts` (945), `control-plane.ts` (918), `documents.ts` (916), `settings.js` (856) e `app.css` (1.522). Un file lungo non è di per sé un difetto: Il rischio deriva dalle responsabilità che cambiano insieme e dalla difficoltà di verificare i percorsi di errore.

## Controlli eseguiti

Ambiente: Node **24.22.1**, pnpm **10.17.1**, macOS.

| Controllo | Esito osservato |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| Suite completa con `PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright pnpm test` | **1.355 passati, 1 fallito, 11 saltati**; 113 file passati, 1 fallito, 2 saltati; 211,42 s |
| `pnpm exec vitest run test/make-documents.test.ts --maxWorkers=1` | **32/32 passati**, 1,85 s complessivi |
| `pnpm eval:agente` | Catalogo PASS; **4/4 contratti di esito PASS** |
| `node --check` su console, cloud UI e pagina connect desktop | **43 moduli passati** |
| `pnpm audit --prod --json` | **9 advisory: 3 high, 4 moderate, 2 low**; esposizione analizzata sotto |
| `git diff --check` | PASS |

Il fallimento della suite completa è [make-documents.test.ts:372](</Users/mariomiletta/Dev Projects/owni/test/make-documents.test.ts:372>): Il test richiede meno di 3.000 ms per una sequenza di input avversari; ne ha misurati 5.732. Il file intero passa isolato. È un segnale di instabilità della soglia temporale sotto esecuzione concorrente; non dimostra una regressione funzionale né prova da solo complessità non lineare. La prima esecuzione **resta fallita**: Il rerun non la trasforma in una suite completa verde.

I test saltati dipendono dai prerequisiti di integrazione. La quantità locale non descrive i test effettivamente eseguiti su Ubuntu: Vedi F6.

Le eval faux verificano calcolo, artifact su disco, memoria e approvazione prima dell'effetto. Non misurano comprensione di richieste naturali, qualità della ricerca o qualità linguistica: Questo limite è descritto correttamente in [evals/agente/README.md](</Users/mariomiletta/Dev Projects/owni/evals/agente/README.md>).

Log grezzi di questa analisi: [directory delle evidenze](/private/tmp/owni-health-20261027-ze8SZ4). È una directory temporanea; questo documento conserva i risultati essenziali.

## Problemi ordinati per priorità

P1: Da correggere prima di considerare affidabile il relativo contratto di prodotto.  
P2: Difetto concreto da pianificare, con impatto più circoscritto o condizionato.  
Le priorità sono valutazioni di questo audit, non punteggi CVSS.

### F1 — P1: Eventi privati continuano a uscire da sessioni revocate

**Evidenza:** [events-routes.ts:65](</Users/mariomiletta/Dev Projects/owni/src/web/events-routes.ts:65>), listener Board alle righe 72–83 e Rooms alla 86. I soli eventi `run` rileggono sessione, persona e accesso al thread prima di scrivere.

**Scenario:** Una connessione `/api/events` resta aperta; la sessione viene revocata o scade. Arriva un messaggio, un evento stanza o una notifica Board: Il listener usa ancora l'identità catturata all'apertura. La revoca dell'agente manca analogamente di ricontrollo nel percorso `entry`.

**Prova:** Il vero handler, con EventEmitter e dipendenze in memoria, dopo la revoca scrive eventi `entry`, `room` e `board` con **zero controlli di sessione e zero controlli di thread** in quei percorsi. Non è stata aperta una connessione a un sistema di produzione.

**Correzione e accettazione:** Un unico controllo di autorizzazione corrente prima di ogni famiglia di eventi; chiusura delle sessioni revocate; coda e backpressure limitate. Testare revoca/scadenza senza inviare successivamente un evento `run`, che oggi potrebbe chiudere incidentalmente il flusso. [web-run-controls.test.ts:114](</Users/mariomiletta/Dev Projects/owni/test/web-run-controls.test.ts:114>) copre soltanto il caso di progressi run.

### F2 — P1: La console conserva titoli privati dopo il cambio di account

**Evidenza:** [shell.js:371](</Users/mariomiletta/Dev Projects/owni/src/web/ui/shell.js:371>) azzera soltanto `state.me`; [shell.js:231](</Users/mariomiletta/Dev Projects/owni/src/web/ui/shell.js:231>) conserva le conversazioni dopo un errore di lettura; [shell.js:256](</Users/mariomiletta/Dev Projects/owni/src/web/ui/shell.js:256>) disegna i canali senza legare la cache alla persona. Anche [palette.js:18](</Users/mariomiletta/Dev Projects/owni/src/web/ui/palette.js:18>) legge quella cache.

**Scenario:** Alice esce; Bob entra nella stessa tab. La lettura delle conversazioni di Bob è lenta oppure restituisce 500. Il titolo e l'identificativo di un canale privato di Alice compaiono nella sidebar di Bob, transitoriamente o fino a un aggiornamento riuscito.

**Prova:** Funzioni reali `refreshConversations` e `renderRail`, DOM simulato, Bob con zero agenti visibili e lettura fallita: Titolo precedente e relativo collegamento entrambi renderizzati. La prova riguarda **metadati**, non accesso server ai messaggi.

**Correzione e accettazione:** Reset centralizzato dello stato personale al logout e al cambio identità; snapshot associati a persona/generazione di sessione. Testare cambio account con lettura lenta, 500, palette e risposte tardive. Conservare una cache è corretto solo all'interno dello stesso perimetro di autorizzazione.

### F3 — P1: Il limite di spesa promesso non blocca il modello

**Evidenza:** [activity.js:252](</Users/mariomiletta/Dev Projects/owni/src/web/ui/pages/activity.js:252>) promette lo stop delle chiamate oltre il tetto. [usage.ts:189](</Users/mariomiletta/Dev Projects/owni/src/core/usage.ts:189>) implementa `isHardCapped()`, ma nessun sorgente applicativo lo chiama. [runtime.ts:825](</Users/mariomiletta/Dev Projects/owni/src/core/runtime.ts:825>) ammette la submission senza quel controllo.

**Prova:** Runtime temporaneo con adapter Pi reale e modello faux, registro odierno portato a 25 USD contro il tetto di 20: `cappedBefore=true`, nuova submission ammessa, risposta `answered`. Nessuna spesa reale generata dalla prova. L'evento `cost.denied` viene registrato dopo la spesa senza un corrispondente rifiuto dell'inferenza.

**Correzione e accettazione:** Applicare il contratto nel punto condiviso che autorizza ogni generazione, inclusi task, deleghe e ripresa. Il solo controllo all'invio della chat non copre più chiamate nello stesso turno o lavori concorrenti. Definire il massimo sforamento ammesso per chiamate già in corso; lasciare possibili le operazioni approvate che non richiedono nuove generazioni.

### F4 — P2: Registro e totali della spesa possono divergere permanentemente

**Evidenza:** [usage.ts:147](</Users/mariomiletta/Dev Projects/owni/src/core/usage.ts:147>) deduplica prima di riparare i totali; il JSONL viene scritto alla riga 153 e il totale in un secondo file alla 161.

**Prova:** Scrittura del JSONL riuscita, errore iniettato solo sulla scrittura dei totali, rimozione del guasto e retry della stessa submission: **Una riga da 25 USD nel registro, totale odierno 0, hard cap false**. La deduplicazione evita il doppio addebito ma impedisce anche il recupero del totale. Un crash tra le due scritture lascia la stessa incoerenza.

**Correzione e accettazione:** Registro autorevole e totali ricostruibili con cursore, oppure un'unica transazione. Testare errore fra le due scritture seguito da riavvio e retry. È necessario correggerlo insieme a F3.

### F5 — P2: Una chiusura del motore fallita salta il rilascio delle risorse

**Evidenza:** [runtime.ts:1108](</Users/mariomiletta/Dev Projects/owni/src/core/runtime.ts:1108>) attende `session.close()` prima di svuotare le code e chiamare `releaseTools()`; nel `finally` rilascia solo il lock dell'istanza.

**Prova:** Vera `OwniInstance` con motore stub che rifiuta la chiusura: `toolsReleased=false`, `lockReleased=true`.

**Impatto:** Risorse dei tool/MCP possono restare aperte mentre il lock consente una riapertura. La prova non dimostra che Pi abbia già fallito così in produzione o che ne segua corruzione dei dati.

**Correzione e accettazione:** Tentare comunque le pulizie indipendenti, conservando l'errore originale e rendendo la chiusura ripetibile. Aggiungere al test del ciclo open/close/reopen un errore del motore e uno del rilascio tool.

### F6 — P2: La CI installa Chromium ma salta 29 controlli browser

**Evidenza:** [ci.yml:28](</Users/mariomiletta/Dev Projects/owni/.github/workflows/ci.yml:28>) installa Chromium e imposta `PLAYWRIGHT_BROWSERS_PATH`. Quattro suite cercano invece `OWNI_CHROMIUM_PATH` o Chrome nella cartella macOS:

| Suite | Controlli esclusi sul runner Ubuntu configurato |
|---|---:|
| [browser-file-chooser.test.ts:14](</Users/mariomiletta/Dev Projects/owni/test/browser-file-chooser.test.ts:14>) | 17, inclusi casi generati |
| [browser-takeover.test.ts:16](</Users/mariomiletta/Dev Projects/owni/test/browser-takeover.test.ts:16>) | 9 |
| [org.test.ts:222](</Users/mariomiletta/Dev Projects/owni/test/org.test.ts:222>) | 1 |
| [openui.test.ts:23](</Users/mariomiletta/Dev Projects/owni/test/openui.test.ts:23>) | 2, Chromium e WebKit; WebKit non viene installato |

È una conclusione dalla configurazione, **non una lettura dei log Actions storici**. Non tutti i test browser sono saltati: Altre suite usano un resolver differente.

**Correzione e accettazione:** Resolver condiviso dell'eseguibile Playwright, browser richiesti installati esplicitamente, errore CI quando manca un prerequisito obbligatorio. Verificare su Ubuntu il numero dei test realmente eseguiti, inclusi isolamento profili, rifiuto upload e contenimento OpenUI.

### F7 — P2: Richieste anonime possono risvegliare celle cloud

**Evidenza:** [control-plane.ts:886](</Users/mariomiletta/Dev Projects/owni/src/cloud/control-plane.ts:886>) considera sufficienti un cookie con la forma giusta o qualunque percorso `/hooks/`; [control-plane.ts:737](</Users/mariomiletta/Dev Projects/owni/src/cloud/control-plane.ts:737>) avvia la cella prima che questa autentichi la richiesta.

**Prova:** La funzione reale `mayWake` rifiuta una richiesta senza credenziali, ma accetta un cookie inventato di 32 caratteri e `/hooks/not-a-real-hook`. Il tracciamento del chiamante conferma l'avvio precedente alla verifica della cella; richieste inoltrate aggiornano anche l'attività.

**Impatto:** Costi e pressione sulle risorse, non un bypass dimostrato dell'accesso ai dati. Richiede conoscenza del sottodominio del tenant.

**Correzione e accettazione:** Credenziale di risveglio verificabile dal control plane, limitazione dei tentativi, percorsi webhook espliciti e gestione dell'attività che non premi richieste respinte. Se la firma webhook deve essere verificata solo dalla cella, rendere esplicito e limitato quel costo. Test con cookie falso e hook inesistente.

### F8 — P2: La selezione della palette non è esposta correttamente alle tecnologie assistive

**Evidenza:** [palette.js:19](</Users/mariomiletta/Dev Projects/owni/src/web/ui/palette.js:19>) crea input e listbox separati; le frecce aggiornano `aria-selected`, ma il focus resta sull'input senza `aria-activedescendant`, ID delle opzioni o relazione input/listbox.

**Impatto:** La selezione è visibile e azionabile con Invio, ma manca la relazione semantica che identifica l'opzione attiva mentre si scrive. Difetto statico del DOM; nessuna certificazione o prova con screen reader è stata eseguita.

**Correzione e accettazione:** Pattern combobox con opzioni identificate e discendente attivo, oppure focus effettivamente spostato nel listbox. `commands.js` offre già un precedente locale. Test DOM e verifica di navigazione con tastiera e lettore di schermo.

## Best practice effettivamente applicate

| Pratica | Evidenza | Valutazione |
|---|---|---|
| TypeScript rigoroso | [tsconfig.json](</Users/mariomiletta/Dev Projects/owni/tsconfig.json>): `strict`, `noUncheckedIndexedAccess` | Solido per TS; non copre il JS della console |
| Interfaccia al motore e confini modulari | [engine.ts](</Users/mariomiletta/Dev Projects/owni/src/core/engine.ts>), [boundaries.test.ts:23](</Users/mariomiletta/Dev Projects/owni/test/boundaries.test.ts:23>) | Import Pi confinati; core indipendente dai canali, verificato da test |
| Outbox e identità delle consegne | [runtime.ts:1145](</Users/mariomiletta/Dev Projects/owni/src/core/runtime.ts:1145>), [outbox.test.ts](</Users/mariomiletta/Dev Projects/owni/test/outbox.test.ts>) | Persistenza prima dell'invio, ACK separato, retry ed esiti duplicati espliciti |
| Crash test realistici | [crash-resume.test.ts](</Users/mariomiletta/Dev Projects/owni/test/crash-resume.test.ts>), [lock.test.ts](</Users/mariomiletta/Dev Projects/owni/test/lock.test.ts>) | Processi figli e SIGKILL, non solo mock |
| Single writer e scritture atomiche | [lock.ts:22](</Users/mariomiletta/Dev Projects/owni/src/core/lock.ts:22>), [atomic-file.ts](</Users/mariomiletta/Dev Projects/owni/src/core/atomic-file.ts>) | Lock del kernel e fsync; garanzie non uniformi in tutti gli store |
| Approvazione prima degli effetti | [action-queue.ts:83](</Users/mariomiletta/Dev Projects/owni/src/core/action-queue.ts:83>) | Stato running persistito prima dell'effetto, ripresa come uncertain; evita replay cieco |
| Autenticazione e ruoli server | [auth.ts:49](</Users/mariomiletta/Dev Projects/owni/src/web/auth.ts:49>), [server.ts:222](</Users/mariomiletta/Dev Projects/owni/src/web/server.ts:222>) | Token casuali e hash, ruoli e conversazioni personali; F1 è un'eccezione importante |
| Accessi ed egress negati per default | [policy.ts](</Users/mariomiletta/Dev Projects/owni/src/core/policy.ts>), [web-fetch.ts:242](</Users/mariomiletta/Dev Projects/owni/src/core/web-fetch.ts:242>) | Liste esplicite e difese SSRF fino alla risoluzione DNS del socket |
| Isolamento del codice generato | [sandbox.ts:95](</Users/mariomiletta/Dev Projects/owni/src/core/sandbox.ts:95>), [code-run.ts:100](</Users/mariomiletta/Dev Projects/owni/src/core/code-run.ts:100>) | Processi separati, permessi, ambiente vuoto, limiti e cancellazione; test avversari |
| Rendering non fidato contenuto | [markdown.js](</Users/mariomiletta/Dev Projects/owni/src/web/ui/markdown.js>), [openui.js:16](</Users/mariomiletta/Dev Projects/owni/src/web/ui/openui.js:16>) | DOM sicuro e parser limitato; OpenUI in iframe a origine opaca, azioni riportate al composer |
| Cache degli asset controllata | [sw.js](</Users/mariomiletta/Dev Projects/owni/src/web/ui/sw.js>), [console-ui.test.ts:82](</Users/mariomiletta/Dev Projects/owni/test/console-ui.test.ts:82>) | API escluse dal caching, inventario shell testato, CSS/JS no-cache con ETag |
| Test AI distinguono routing ed esito | [evals/agente/README.md](</Users/mariomiletta/Dev Projects/owni/evals/agente/README.md>) | Buona disciplina: Nessuna equivalenza fra tool corretto e compito riuscito |
| Packaging e privilegi operativi | [docker-compose.yml](</Users/mariomiletta/Dev Projects/owni/docker-compose.yml>), [bundle-server.sh](</Users/mariomiletta/Dev Projects/owni/desktop/scripts/bundle-server.sh>) | Container limitato, checksum del Node distribuito e smoke del server preparato |

## Dipendenze: segnalazioni e raggiungibilità

Le versioni JavaScript sono esatte e le installazioni CI usano il lockfile congelato: Buona riproducibilità, purché accompagnata da aggiornamenti di sicurezza.

L'audit corrente segnala nove advisory, soprattutto nella catena di `@modelcontextprotocol/sdk@1.31.0`, `body-parser` e `fast-uri`. Il conteggio **non equivale a nove vulnerabilità sfruttabili di Owni**.

- Le advisory MCP su task condivisi, autenticazione bearer e validazione server, e quella di body-parser, riguardano superfici server non trovate nel prodotto: Owni usa il client MCP; il server MCP individuato è una fixture di test. Fonti primarie: [task/sessioni](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-22jm-h49p-29qw), [validazione server](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453).
- L'advisory sui redirect del client è pertinente al tipo di client usato, ma il percorso Owni fornisce un fetch che forza `redirect: "error"`; OAuth usa richieste controllate senza inseguire redirect. Evidenze: [connectors/http.ts:40](</Users/mariomiletta/Dev Projects/owni/src/connectors/http.ts:40>), [mcp.ts:299](</Users/mariomiletta/Dev Projects/owni/src/connectors/mcp.ts:299>), [mcp-oauth.ts:193](</Users/mariomiletta/Dev Projects/owni/src/connectors/mcp-oauth.ts:193>). [Advisory del maintainer](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw).
- `fast-uri` è raggiungibile attraverso la validazione Ajv degli schemi forniti dai server MCP. Non è stato dimostrato un percorso dai difetti di normalizzazione URI a un bypass auth/SSRF di Owni.

Aggiornare la catena MCP e il lockfile in una modifica dedicata, con i test dei connettori e OAuth. Il maintainer indica SDK 1.32.0 come prima versione corretta per le advisory citate; non è stato eseguito né validato un upgrade in questo audit. Inserire un controllo periodico con triage dell'esposizione: Il pinning da solo non è una politica di manutenzione.

## Debito tecnico e limiti da gestire

**Frontend fuori dal typecheck.** I 41 moduli JS della console non hanno `checkJs` e non esiste un gate lint configurato. Il comando CI esplicito controlla sintatticamente solo `app.js`, senza visitare i suoi import. La verifica locale di tutti i 43 moduli è passata, ma non è un controllo permanente. Primo passo: Controllare tutti i moduli in CI e tipizzare gradualmente contratti API/stato con JSDoc o confini TS. L'assenza di React non è il problema.

**Concentrazione delle responsabilità.** Conservare il ruolo di composition root di `app.ts`, ma isolare lifecycle, ammissione e consegna dove esistono già test. Nella UI, `common.js` unisce DOM, trasporto, stato, routing e componenti visivi. Evitare nuove regole di sessione sparse fra shell, palette e pagine: F2 ne mostra il costo concreto.

**Durabilità e scalabilità non uniformi.** [locked-json.ts:11](</Users/mariomiletta/Dev Projects/owni/src/core/locked-json.ts:11>) può attendere un lock in modo sincrono fino a cinque secondi e poi riscrive JSON sincronicamente. È una scelta comprensibile per dati piccoli; non prova capacità multiutente sotto carico. Inoltre il rename non sincronizza la directory come `writeFileAtomic`: È una differenza di garanzia in caso di perdita di alimentazione, non un guasto riprodotto. Non serve migrare tutto a un database per principio; servono misure e invarianti per gli store critici.

**Crescita degli storici.** [audit.ts:35](</Users/mariomiletta/Dev Projects/owni/src/core/audit.ts:35>) legge l'intero JSONL; [server.ts:503](</Users/mariomiletta/Dev Projects/owni/src/web/server.ts:503>) applica il limite solo dopo la lettura. Anche usage mantiene un registro crescente. Introdurre osservabilità sulle dimensioni, lettura a coda/paginazione e una retention esplicita; misurare riavvio e memoria con dati realistici. Non è stato eseguito un load test.

**Formati documentali mantenuti internamente.** Parsing e produzione PDF/ZIP/documenti sono una parte sostanziale della codebase. La riduzione delle dipendenze trasferisce al progetto costi di compatibilità e input malformati. Conservare isolamento e limiti, ampliare fixture avversarie/fuzzing e separare benchmark da asserzioni rigide sul tempo di una suite concorrente.

**Distribuzione non equivalente al merge.** La CI desktop premerge gira su Linux e su modifiche a `desktop/**`; gran parte del comportamento macOS e del bundle server si verifica al rilascio. La pubblicazione Docker non scatta per molti cambiamenti a `src/**`: È una scelta documentata che richiede pubblicazione manuale. Gli aggiornamenti Tauri sono firmati, ma la workflow non configura Developer ID/notarizzazione Apple. Sono limiti di distribuzione, non prove di compromissione. Aggiungere uno smoke di packaging per i cambiamenti al contratto server/launcher.

**Documentazione architetturale non allineata.** [architettura.md:5](</Users/mariomiletta/Dev Projects/owni/docs/architettura.md:5>) dichiara ancora “settimana 2” e presenta dashboard e desktop come futuri. Gli ADR conservano le decisioni, ma non sostituiscono una mappa aggiornata di processi, store, confini di fiducia e garanzie. Va corretta anche la promessa del tetto fino alla sua effettiva applicazione.

**Segreti e backup.** Il secret store ha permessi 0600, ma resta in chiaro. Il runbook descrive un backup coerente a processo fermo e richiede protezione degli archivi. Non lo classifico come nuova vulnerabilità: È un limite dichiarato da includere nelle condizioni di deployment e nelle prove periodiche di ripristino.

## Piano di miglioramento proposto

| Sequenza | Intervento | Criterio di chiusura |
|---|---|---|
| 1 | F1–F2: Revoca su tutti gli eventi e reset dello stato personale | Nessun dato precedente dopo cambio identità; nessun evento privato dopo revoca, anche con API in errore |
| 2 | F3–F4: Un unico contratto di budget e recupero della contabilità | Generazioni controllate su chat, task, deleghe e resume; registro e totali coerenti dopo fault |
| 3 | F6 e controlli JS: Rendere effettivi i gate esistenti | Tutte le suite browser richieste realmente eseguite su Ubuntu; nessun salto silenzioso; sintassi di tutti i moduli |
| 4 | F5, F7, F8: Chiusura robusta, risvegli cloud verificabili, palette accessibile | Test dei guasti di close, credenziali wake false e selezione assistiva |
| 5 | Manutenzione: Dipendenze, mappa architetturale, retention e packaging | Upgrade verificato, documenti aderenti ai sorgenti, smoke del bundle, metriche su dimensioni e tempi |

Non assegnerei un voto numerico complessivo: Nasconderebbe la differenza fra un runtime ben testato e pochi contratti critici ancora violati. La priorità è chiudere tali contratti e renderli verificabili automaticamente.

