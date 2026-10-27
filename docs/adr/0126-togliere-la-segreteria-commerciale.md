# 0126: Togliere la segreteria commerciale

Owni aveva una verticale già pronta: la segreteria commerciale. Leggeva una casella Gmail, classificava le mail, estraeva i dati del cliente con un modello, preparava la bozza di risposta, scriveva il contatto su HubSpot e mandava ai commerciali una scheda su Telegram con i pulsanti per approvare. Aveva il suo processo (`pnpm dev:segreteria`), il suo bot, le sue pratiche, i suoi tetti di spesa, le sue 37 eval e una pagina «Pratiche» nella console. Tenerla costava in tre modi.

- **Era una verticale in un prodotto generale.** Owni è un agente generale: dopo la rimozione dei 25 registri ([ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md)) la segreteria era l'ultimo pezzo costruito per un solo mestiere, con un modello di dati (la pratica), un canale (il bot dedicato) e un'interfaccia (la pagina Pratiche) che nessun altro agente usava.
- **Due strade per la stessa cosa.** Gmail e il calendario di una persona si collegano già dalla console ([ADR 0021](0021-google-scrivere-con-approvazione.md)), e qualunque CRM o casella si collega come connettore ([ADR 0003](0003-mcp-per-i-connettori.md), [ADR 0116](0116-collegamenti-api-per-agente.md)). La segreteria aveva i suoi adattatori Gmail e HubSpot, con le sue chiavi nel `.env`.
- **Il limite.** Un'azienda ha un CRM suo e una procedura sua. La segreteria faceva quello che i suoi autori avevano previsto, con HubSpot; per ogni altro CRM serviva codice nuovo.

## Decisione

Owni non ha verticali già pronte. Una segreteria è un agente che il titolare crea, con le sue istruzioni, i suoi connettori e le sue attività programmate.

- **Le istruzioni dicono come si lavora**: cosa è una richiesta di preventivo, quali dati servono, con che tono si risponde, cosa non si promette. Sono il testo dell'agente, come per ogni altro.
- **I connettori portano i dati**: la casella (Gmail della persona, o una casella collegata come connettore MCP o API) e il CRM che l'azienda usa, qualunque sia.
- **Le attività programmate e le sentinelle fanno il giro**: controllare la posta ogni tanto, preparare le bozze, avvisare chi decide.
- **Chi decide lo fa dalle approvazioni di sempre**: una mail o una scrittura sul CRM sono azioni di un servizio e partono solo con il sì della persona ([ADR 0021](0021-google-scrivere-con-approvazione.md), [ADR 0120](0120-approvazioni-per-rischio.md)). Non c'è più una scheda a parte per le pratiche.

Non ci sono più:

- **`pnpm dev:segreteria`, il bot Telegram della segreteria e le variabili `OWNI_SEGRETERIA_*`.** Il canale Telegram di un agente si collega dalla console come per ogni altro.
- **Gli adattatori Gmail e HubSpot della segreteria**, la pratica e il suo archivio, gli strumenti `mail_*` e `crm_*`, la classificazione e l'estrazione con modelli per ruolo.
- **La chiave Anthropic come unica via del modello della segreteria.** Un agente usa il modello che l'owner sceglie ([ADR 0032](0032-qualsiasi-modello.md)), anche l'abbonamento di Claude Code o Codex sul proprio computer.
- **La pagina Pratiche e le pratiche in «Richiede te».**
- **Le eval della segreteria** (dataset, gold, giudice notturno, controlli sulle bozze). Restano le eval dell'agente ([ADR 0099](0099-eval-dell-agente.md)).
- **I tetti di spesa con messaggi su Telegram** (il testo soft e hard della segreteria) e i tipi di consumo `extract`, `draft`, `classify`. Il registro dei consumi ha solo i turni degli agenti ([ADR 0098](0098-quanto-costa-un-turno.md)).

Resta, perché serve anche senza segreteria: `vat_check` e il controllo formale delle partite IVA ([ADR 0047](0047-partita-iva.md)), le bozze e gli allegati delle mail dalla console ([ADR 0056](0056-allegati-nelle-mail.md)), e il tetto di spesa mostrato nella console.

## Dati esistenti

Le cartelle delle pratiche di una segreteria già avviata (`practices/`, i cursori della posta) restano dove sono. Owni non le legge e non le cancella. Un'istanza con l'id della vecchia segreteria compare come un agente qualunque, senza conversazioni salvate.

## Alternative scartate

- **Tenerla dietro un'opzione.** Il codice, i test, le eval e la documentazione resterebbero tutti, per una funzione che un agente con i connettori giusti fa già.
- **Una skill pronta «segreteria».** Rifarebbe la verticale con un altro nome: la procedura vera cambia da cliente a cliente ([ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md)).
- **Migrare le pratiche in file del workspace.** Sono dati di prove, mai di un cliente in produzione, in un formato pensato per uno strumento che sparisce.

## Conseguenze

- Il processo e la configurazione di Owni hanno un percorso solo: `pnpm start`. Per usarlo con la propria sottoscrizione non serve nessuna chiave né account di terzi.
- Una segreteria per un cliente si costruisce nella console: istruzioni, connettori, una routine. Cosa fa bene lo dicono le sue istruzioni, non il codice di Owni.
- La CI e le eval notturne controllano solo l'agente generale.
