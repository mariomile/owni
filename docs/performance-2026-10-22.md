# Affidabilità e prestazioni di Owni

Analisi e interventi del 22 ottobre 2026. Ramo locale: `feat/agent-performance`.

## Obiettivo e perimetro

Una richiesta deve produrre un risultato verificabile, con memoria aggiornata, recupero dopo interruzioni, errori comprensibili e approvazioni rispettate. Avere molti strumenti non basta a dimostrare questo risultato.

Il confronto riguarda [Grok Bot](https://docs.x.ai/grok-bot/overview), il prodotto con agenti persistenti e computer condiviso. La sua documentazione descrive funzionalità, non fornisce un benchmark comparativo di affidabilità riproducibile qui. Questo lavoro non dimostra parità con Grok Bot e non misura la qualità dei modelli su compiti reali.

I PR [#162](https://github.com/mariomile/owni/pull/162), [#163](https://github.com/mariomile/owni/pull/163), [#164](https://github.com/mariomile/owni/pull/164), [#165](https://github.com/mariomile/owni/pull/165), [#166](https://github.com/mariomile/owni/pull/166), [#167](https://github.com/mariomile/owni/pull/167), [#168](https://github.com/mariomile/owni/pull/168), [#169](https://github.com/mariomile/owni/pull/169) e [#170](https://github.com/mariomile/owni/pull/170) sono integrati nel ramo locale per verificare il prodotto insieme. I rami originali e `main` restano separati. L'integrazione conserva strumenti differiti, istruzioni per strumento, misure dei turni, menu Telegram, console per pagina e clic nel browser. Le nuove correzioni sono nel ramo di integrazione; non sono state pubblicate sui PR originali.

## Problemi individuati e interventi

- **Ripresa dei turni:** Il confronto finale della configurazione conservava una lettura vecchia mentre un altro controllo era sospeso. Inoltre Pi conserva modello e istruzioni nel checkpoint della richiesta interrotta. L'adapter ora controlla la configurazione quando consegna la richiesta all'API del modello, anche per richieste differite e riassunti di compattazione. Se è cambiata, prepara nuovamente quella generazione, preservando strumenti già completati, memorie dei passi e conteggi dei consumi.
- **Provider locali:** Gli errori conservano i segnali che permettono a Pi di ritentare un'indisponibilità temporanea o compattare il contesto pieno, senza esporre i log della CLI. Autenticazione, quota esaurita e annullamento esplicito restano terminali. I dati di consumo non partecipano alla classificazione degli errori. Codex analizza l'ultimo messaggio completo dopo aver letto gli eventi, accettando i commenti intermedi ma conservando i controlli sugli errori e sugli strumenti esterni.
- **Memoria:** Il contesto caricava due volte l'intero archivio JSON. Memorie essenziali e conteggi ora derivano dalla stessa lettura; la cache limitata rileva anche le sostituzioni del file da altri processi.
- **Console:** Ogni aggiornamento dei contatori invia richieste sequenziali per ciascun agente e scarica i contenuti completi delle richieste di approvazione. Il nuovo `/api/console-summary` restituisce solo contatori e spesa, applicando i permessi della persona. Gli eventi simultanei condividono una lettura e ne richiedono una successiva se arriva un cambiamento durante la prima. Una risposta tardiva di un accesso precedente viene ignorata; un errore conserva gli ultimi conteggi noti.
- **Sandbox su Mac:** Le autorizzazioni del processo figlio usano ora i percorsi reali del runner e del workspace. Gli alias `/var` e `/tmp` non impediscono più l'avvio. Si eliminano anche le variabili che il sistema operativo aggiunge nonostante `env: {}`. I limiti di accesso restano attivi.
- **Verifiche:** La scelta corretta del primo strumento non dimostra un risultato corretto. I nuovi eval controllano dati persistiti, contenuti dei file e assenza di effetti prima dell'approvazione. Un eval senza credenziali dichiara `skipped`, zero casi misurati e nessuna accuratezza.

## Misura della console

Browser collegato a un'installazione temporanea locale, modello `faux`, dieci agenti sintetici, nessun dato reale. Confronto tra il codice precedente (`a0ee31f`) e quello nuovo sullo stesso server. Tre ripetizioni per versione, con 25 ms di latenza aggiunta a ogni richiesta HTTP per rendere visibile il costo della sequenza.

| Aggiornamento contatori | Prima | Dopo |
| --- | ---: | ---: |
| Richieste HTTP | 42 | 1 |
| Durate delle tre prove | 1.310 / 1.392 / 1.357 ms | 40 / 36 / 35 ms |
| Mediana | 1.357 ms | 36 ms |

È una riduzione del traffico di circa il 98% per questa operazione. Il tempo dipende dalla latenza simulata e dal contenuto dei registri; non è una misura della generazione delle risposte. Con un agente la verifica nel browser passa da sei richieste a una. La prova degli eventi simultanei verifica che venti aggiornamenti sovrapposti producano una richiesta in corso e una di riallineamento.

## Misura del contesto di memoria

`pnpm exec tsx test/memory-context.bench.ts` costruisce 20.000 record sintetici per venti persone, circa 7,14 MB. Su trenta richieste, le letture con parsing passano da 60 a 1; la mediana della preparazione passa da 14,60 a 0,088 ms. La prima preparazione a cache fredda richiede 7,47 ms. La misura comprende il filesystem con cache del sistema operativo già calda, esclude modello e rete. Gli archivi superiori a 8 MiB non vengono conservati nella cache del processo.

Le regressioni verificano che una sostituzione atomica da un altro processo sia visibile alla richiesta successiva, che una correzione non lasci memorie vecchie e che una modifica del risultato da parte del chiamante non alteri la cache.

## Verifiche della ripresa e dei provider

I due riproduttori della revisione 6 fallivano prima della correzione e passano dopo: Cambio del modello di una chat durante la verifica di un'altra, e ripresa di un checkpoint di richiesta con modello e istruzioni aggiornati. I 23 test di riallineamento comprendono credenziali pubblicate mentre la coda dei documenti è bloccata, richieste differite, istruzioni rimosse, compattazione interrotta e assenza di ripetizione degli strumenti completati. La verifica mirata complessiva conta 79 test su dieci suite.

Il confine verificato è l'invio all'API del modello di Pi: Dopo il controllo di disponibilità, la verifica della scelta pubblicata, il confronto delle istruzioni e l'invio non fanno altro I/O nell'adapter. Questo non rende atomiche le letture esterne di policy e credenziali dentro `modelUsable`, né copre una modifica dopo la sua ultima osservazione. Le richieste già inviate conservano la semantica dell'ADR 0036. Un provider revocato non viene contattato neppure per annullare una richiesta differita: Il lavoro remoto potrebbe finire, ma il suo risultato viene scartato.

I 78 test mirati di CLI e provider locali verificano ritentativi effettivi del motore con risposte simulate, anche per cancellazione del trasporto e HTTP 429 con indicazione del reset. Una quota di abbonamento esaurita resta terminale. Non sono state eseguite chiamate alle CLI ufficiali con account reali.

## Verifiche degli esiti

`pnpm eval:agente` distingue il controllo del catalogo (29 casi, 76 strumenti) da quattro scenari con 29 verifiche: Calcolo esatto, creazione e rilettura di un file, correzione della memoria su più conversazioni con isolamento tra persone, proposta di una mail senza invio prima dell'approvazione. Usa runtime, strumenti e registri reali con modello `faux` e servizi esterni simulati.

Cinque controlli negativi coprono valore errato, file mancante, operazione fallita, memoria vecchia e invio non autorizzato. Sol 6.1 ha approvato la revisione e verificato anche file corrotti, rilettura sbagliata, memoria/proposta mancante e destinatario errato. I 37 test mirati passano. Non è una prova dell'invio approvato attraverso la console né della pianificazione del modello.

Il report del modello reale distingue `passed`, `failed`, `skipped` ed `error`, selezione e copertura effettiva, modello richiesto e modello registrato nei consumi. Selettori sconosciuti falliscono; i report mancanti fanno fallire il riepilogo notturno. Lo schema JSON sostituisce i vecchi campi `pass`, `cases`, `model` e `ok`: Non risultano consumatori nel repository, eventuali consumatori esterni vanno aggiornati. Le chiamate a modelli reali e GitHub Actions ospitate non sono state eseguite in questa verifica.

Anche `pnpm eval:segreteria` passa: 37 casi, zero errori di controlli, schema, flusso e IVA.

## Verifiche della console e della piattaforma

- Prima delle modifiche, la suite integrata aveva 2.546 test superati, dieci falliti e 18 saltati. Otto fallimenti erano legati alla sandbox su macOS e due alle differenze di `pwd`/`wc` nei test Fly.
- Dopo l'integrazione: `pnpm typecheck`, `pnpm test`, `pnpm build` e `pnpm eval:agente` passano. La suite completa conta 2.675 test superati e 18 saltati, 136 file superati e tre saltati; durata 91,60 secondi su questa macchina. Non esiste uno script lint nel progetto.
- Dopo la correzione dei percorsi e dell'ambiente della sandbox: I 47 test di sandbox, tool proposti, avvio dell'app e computer Fly passano insieme.
- I test mirati di console, sessione e sandbox coprono autorizzazioni, revoca dell'accesso, richieste scadute/rifiutate, isolamento dei risultati dopo logout ed eventi simultanei. La regressione aggiunta durante la revisione verifica anche un evento arrivato fra l'ultima lettura e la pulizia della promise condivisa.
- Nel browser locale: Accesso, caricamento dei dieci agenti, aggiornamento dei contatori e invio di un messaggio dalla chat fino alla risposta del modello `faux`. Nessun indicatore di attesa rimasto dopo la risposta.
- La cattura immagine della preview T3 è andata in timeout; la verifica del browser ha usato DOM renderizzato, interazione con la chat e misure delle richieste HTTP. Non è una verifica dell'app desktop installata.

Sol 6.1 ha approvato gli eval, i provider locali e il recupero dei checkpoint, dopo la correzione dei casi aggiuntivi riprodotti. La revisione di memoria, sandbox e console non segnala ulteriori difetti P0–P2. Sul recupero ha verificato autonomamente 38 test e sei prove aggiuntive, comprese istruzioni vuote, esaurimento dei ritentativi, idempotenza e consumi dopo compattazione. Le revisioni usano i file correnti e confronti con `a0ee31f`, la base locale che integra i nove PR.

## Differenze ancora da colmare

Aggiornamento del 23 ottobre: Il [lavoro successivo](next-level-2026-10-23.md) implementa stato e Stop del punto 1, lo storico delle esecuzioni del punto 3 e il percorso limitato a cookie e moduli semplici del punto 2. L'esito del motore resta distinto dal successo di un'azione esterna o da una decisione ancora da approvare. Il punto 4 e la compatibilità con autenticazioni complesse restano aperti. L'elenco seguente conserva la valutazione del 22 ottobre.

1. **Controllo del lavoro in corso:** La chat mostra l'attesa e il risultato finale. Servono stato del turno, progressi degli strumenti e Stop per singola conversazione, con cancellazione persistente anche dopo un riavvio. Criterio: Un contatore lungo mostra progressi prima della fine, Stop impedisce i passi successivi e non interrompe altre conversazioni.
2. **Browser autenticato persistente e passaggio alla persona:** Il browser controllato di Owni è limitato e le sue sessioni sono temporanee. Grok Bot documenta sessioni persistenti e intervento umano per accesso/verifica. Criterio: Accesso fatto dalla persona, sessione conservata per il proprietario corretto, ripresa del lavoro e confini espliciti per le azioni che modificano dati. Il clic su una schermata non realizza questo flusso. [Computer e applicazioni](https://docs.x.ai/grok-bot/computer-and-apps)
3. **Cronologia degli esiti delle routine:** Owni dispone già di task, webhook, skill, schede ricorrenti e delega. Manca una vista unica che distingua ammesso, in esecuzione, riuscito, fallito e in attesa di una decisione, con il risultato della singola esecuzione. [Skill e routine di Grok Bot](https://docs.x.ai/grok-bot/skills-and-routines)
4. **Qualità misurata su richieste reali:** Gli scenari deterministici verificano integrazione e contratti. Per misurare pianificazione e qualità del modello servono casi rappresentativi, correzioni su più turni, strumenti reali o servizi simulati e valutazione dei risultati, separati dall'accuratezza del primo strumento. [File e risultati di Grok Bot](https://docs.x.ai/grok-bot/files-and-results)

## Confini della consegna

Le verifiche locali usano dati temporanei e provider simulati. Non attestano l'app desktop installata, la pubblicazione cloud o l'affidabilità di servizi esterni. Nessun merge su `main`, push, deploy o aggiornamento dell'app installata è parte di questa consegna locale.
