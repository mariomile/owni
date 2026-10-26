# 0121: I registri dell'attività lasciano il posto a code_run e ai file

Owni aveva 25 registri dell'attività: fatture ricevute e in uscita, preventivi, spese, ore, clienti, fornitori, magazzino, ordini, DDT, IVA, tasse, banca, budget, appuntamenti, turni e gli altri. Ciascuno era uno strumento con il suo archivio, le sue regole e le sue istruzioni, per circa 58 mila righe di codice in `src` (da 120 mila a 61 mila). Tenerli costava in tre modi.

- **Il peso.** Pesavano circa 140 mila caratteri di schema, tanto che arrivavano al modello solo caricati con `tool_search` ([ADR 0100](0100-strumenti-caricati-su-richiesta.md)), con istruzioni scritte dentro ogni strumento ([ADR 0101](0101-istruzioni-dei-registri-nei-loro-strumenti.md)). Un meccanismo in più per tenerne in piedi un altro.
- **Il codice che li teneva insieme.** Il registro di chi segue cosa ([ADR 0110](0110-registro-di-chi-segue-cosa.md)), le richieste tra agenti da approvare ([ADR 0108](0108-richieste-tra-agenti-che-chiedono-un-si.md)) e il controllo sull'origine del turno ([ADR 0088](0088-conferme-solo-dalla-persona.md)) esistevano per i registri.
- **Il limite.** Un registro fa quello che i suoi autori hanno previsto. Un'azienda ha procedure sue, e ogni procedura nuova era codice nuovo da scrivere, provare e mantenere.

Da quando i conti li fa un programma ([ADR 0119](0119-programmi-python.md)) e i file stanno nel workspace dell'agente, un registro è un file che l'agente tiene e interroga con `code_run`.

## Decisione

I 25 registri e tutto quello che esisteva solo per loro non ci sono più.

- **Il lavoro sui dati si fa con i file del workspace e con `code_run`.** Fatture, spese, ore e il resto sono file (CSV, Excel, XML) che la persona manda o che l'agente crea; i conti li fa `code_run`.
- **Le procedure per ogni cliente sono skill dell'agente** ([ADR 0059](0059-skill.md)). Nessuna skill è pronta: si creano per cliente, quando serve.
- **Gli strumenti di Owni non si caricano più su richiesta.** Ogni agente li riceve tutti insieme. Restano caricati su richiesta, con `tool_search`, solo gli strumenti dei connettori ([ADR 0122](0122-strumenti-dei-connettori-caricati-su-richiesta.md)).
- **Il registro di chi segue cosa e le richieste tra agenti da approvare non ci sono più.** Le facevano e le usavano solo i registri.
- **Il controllo sull'origine del turno per le conferme non c'è più.** Resta il tipo di origine (persona, agente, avviso, attività programmata) sui turni.
- **Il riepilogo delle fatture elettroniche (FatturaPA) non c'è più.** Un file XML FatturaPA nel workspace si legge come testo, o con `code_run`.
- **I brief salvati mandano sempre l'istruzione di oggi.** Un brief programmato prima di questo cambio non porta più le righe dei registri: l'attività programmata di tipo brief usa il testo corrente del brief, non quello salvato.

Resta, perché serve anche senza registri:

- **I file firmati `.p7m`** si aprono come il documento che contengono (`p7m.ts`), con la firma segnalata e non verificata. Un `.p7m` che contiene una fattura XML si legge come testo dell'XML, senza riepilogo.
- **`vat_check`** per controllare una partita IVA.
- **I promemoria e le attività programmate** (`schedule_*`), con il brief del mattino. Il limite di 50 conta solo quelle ancora da fare: i promemoria dei ricontatti già salvati scattano una volta, restano finiti e non lo occupano.
- **«Chi ha chiesto»** sulle card di approvazione: se la richiesta viene da un altro agente, la card lo dice.
- **Gli allegati nelle mail** ([ADR 0056](0056-allegati-nelle-mail.md)): si allegano file del workspace.

## Dati esistenti

I file dei registri già presenti nella cartella dei dati (`invoices.json`, `quotes.json`, le richieste tra agenti, `subjects.json` e il segreto `subjects.key`) restano dove sono. Owni non li legge e non li cancella; un avvio con quei file presenti funziona come uno senza. Un tocco su una vecchia card di richiesta tra agenti non fa niente.

Le istruzioni salvate dagli agenti non vengono toccate: possono nominare strumenti che non ci sono più, e l'agente allora lavora con quello che ha.

## Alternative scartate

- **Migrare i dati dei registri in file del workspace.** Sono dati di aziende vere, in formati pensati per gli strumenti che sparivano: una migrazione scritta una volta e mai più usata. Chi li vuole li ha sul disco.
- **Tenere i registri dietro un'opzione.** Il costo del codice, dei test e delle istruzioni resterebbe tutto, per una funzione che nessuno usa più di un file.
- **Skill pronte per ogni registro.** Rifarebbero i registri con un altro nome: le procedure vere cambiano da cliente a cliente.

## Conseguenze

- Circa 58 mila righe di codice in meno in `src`, e una pagina di istruzioni e di strumenti più corta per ogni turno.
- Gli strumenti di Owni sono sempre lì; quelli dei connettori si caricano con `tool_search` ([ADR 0122](0122-strumenti-dei-connettori-caricati-su-richiesta.md)).
- Una fattura elettronica firmata si apre come testo del file; i conti sulle fatture si fanno con `code_run` su un export.
- Una richiesta tra agenti da approvare lasciata in attesa non compare più da nessuna parte.
- Un agente il cui prompt nomina `quotes`, `invoices` e gli altri strumenti tolti riceve un errore se prova a chiamarli; va riscritto il prompt.
