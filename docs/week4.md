# Settimana 4: segreteria funzionante end-to-end

Branch `week-4`. Spec: [`spec-segreteria-commerciale.md`](spec-segreteria-commerciale.md).

## Perché il piano è cambiato

La lista della settimana 4 in [`stato-e-todo.md`](stato-e-todo.md) prevedeva tre cose: avviso doppioni, adapter live di Gmail e HubSpot, giudice notturno. Riprendendo il lavoro è emerso che la settimana 3 era una libreria provata solo con fake: nessun entry point la avviava, l'adapter Telegram non gestiva pulsanti né `callback_query`, estrazione e bozza erano regex, e le 35 eval costruivano la bozza partendo dal gold, quindi misuravano il template e non il sistema. Con i segreti di Mario la prova reale non sarebbe partita.

La settimana 4 è quindi diventata «segreteria funzionante end-to-end», con dentro i tre punti previsti.

## Cosa funziona (verificato dai test)

- **Avviso doppioni sulle risposte** (`test/outbox.test.ts`, `test/telegram.test.ts`). Una risposta reinviata dall'outbox dopo un crash (`attempts > 1`) arriva al canale con `possibleDuplicate`; Telegram mette in cima al primo pezzo «Possibile doppione: mi sono riavviata mentre ti inviavo questa risposta. Se l'hai già ricevuta, ignora questa.». Verificato con `SIGKILL` reale nei due scenari della settimana 2.
- **Pulsanti Telegram** (`test/telegram.test.ts`). `OutboundMessage.buttons` diventa una inline keyboard sull'ultimo pezzo; `callback_data` oltre 64 byte viene rifiutato prima di inviare. I tap diventano `InboundAction`, con risposta a `answerCallbackQuery` prima dell'handler; un tap riconsegnato dopo un crash e ormai scaduto viene comunque gestito. `callback_query` viene chiesto a Telegram solo se qualcuno gestisce le azioni, quindi `dev:telegram` non cambia.
- **Adapter Gmail live** (`test/connectors.test.ts`, fetch finto). Refresh OAuth con token in cache e rinnovo su 401; polling con `in:inbox -from:me after:<cursore>`, paginazione, ordine di arrivo; al primo avvio il cursore parte da «adesso», quindi la posta vecchia non diventa pratiche. Corpo `text/plain` con ripiego su HTML ripulito. Risposta nello stesso thread (`threadId`, `In-Reply-To`, `References`, `Re:`), oggetto non ASCII in RFC 2047. Il `Message-ID` deriva dalla chiave di idempotenza e prima di inviare viene cercato con `rfc822msgid:` nella posta inviata: se c'è, non si reinvia. Letture ritentate su 429/5xx, invio mai ritentato.
- **Adapter HubSpot live** (`test/connectors.test.ts`). Upsert del contatto per email (`batch/upsert`, il campo `new` dice se è nuovo), creazione semplice senza email, una nota sul contatto con richiesta e dati mancanti. Al CRM vanno solo i dati scritti dal mittente: niente titolo, niente P.IVA (A7). L'esito della pratica imposta `hs_lead_status` da una mappa sovrascrivibile; se il portale rifiuta il valore resta la nota.
- **Egress per i connettori** (`test/connectors.test.ts`). Nuova voce `connectors` nella policy, default deny anche per le policy scritte prima. Ogni connettore usa un fetch che raggiunge solo i suoi host, solo in https, e ricontrolla la policy a ogni richiesta.
- **Estrazione e bozza con il modello** (`test/segreteria-model.test.ts`). Una chiamata Haiku per mail restituisce classificazione e campi del lead in JSON; l'email viene sempre dall'header `From`, mai dal modello; i dati mancanti seguono le regole del gold (prodotto, quantità e sede quando servono per preventivare, email, P.IVA solo se il tenant la richiede; mai budget, scadenza o azienda). Una chiamata Sonnet scrive la bozza, che deve passare gli stessi controlli deterministici della CI (prezzi, lei/tu, domande sui dati mancanti, elenco per le richieste multiple, PII): se fallisce, un secondo tentativo con l'elenco degli errori; se fallisce ancora, si usa il template e la scheda lo dice. Il costo viene registrato dai token restituiti dal provider. Modello giù: euristiche, evento `model.failed` nell'audit e nota in scheda. Senza modello o con `faux` la pipeline fa quello che faceva prima.
- **Client modello one-shot** (`src/core/completion.ts`, `src/core/adapters/pi-durable-completion.ts`). Interfaccia nostra nel nucleo, implementazione su `pi-ai` nell'adapter: solo le chiavi del tenant, nessuna variabile d'ambiente, solo i provider ammessi dalla policy. Il confine «solo `src/core/adapters/pi-durable*` importa Pi» resta valido.
- **Servizio segreteria** (`test/segreteria-service.test.ts`, adapter Telegram vero su fetch finto). Mail in arrivo → scheda con Approva, Modifica, Scarta al commerciale → Approva → una sola risposta inviata; un tap riconsegnato non reinvia. Modifica più testo del commerciale → bozza v2 con pulsanti nuovi. Tap e testi di sconosciuti: silenzio, `user.denied` nell'audit, nessun cambiamento. Una scheda che Telegram non accetta resta nell'outbox delle notifiche e riparte al riavvio con la riga dello spec «Possibile doppione di notifica: ignora se hai già risposto.». Una mail che fallisce tre volte viene saltata con un avviso, senza bloccare le successive. Sopra il tetto hard di spesa: un solo avviso al giorno, nessuna pratica, mail rilette quando il tetto si azzera. Un crash tra il salvataggio della pratica e la scrittura della scheda viene recuperato al giro dopo (evento `card.recovered`). Tutto il lavoro passa da una coda unica.
- **CRM giù dopo l'invio** (`test/segreteria-pipeline.test.ts`). Prima la pratica finiva in `failed` con «Invio non riuscito» e i pulsanti, anche se la mail era partita. Ora resta `sent` (o `discarded` su Scarta), la scheda dice di segnare l'esito sul lead a mano, l'errore va in `lastError` e nell'audit.
- **`pnpm dev:segreteria`** (`src/main/segreteria.ts`). Crea tenant e istanza `segreteria` (egress: provider del modello, `telegram`, `gmail`, `hubspot`), salva le credenziali nel secret store del tenant, prende il lock dell'istanza e avvia il servizio. Configurazione verificata dai test (`test/telegram.test.ts`).
- **Giudice notturno** (`evals/segreteria/judge.ts`, metriche in `metrics.ts` testate in `test/eval-metrics.test.ts`). Fa girare la pipeline vera sui 35 casi, misura classificazione (accuratezza, nessuno spam preso per preventivo), estrazione (micro-F1 sui campi, lead esatti), applica i controlli deterministici con i vincoli del gold, fa giudicare ogni bozza a Sonnet con la rubrica, scrive `last-report/judge.json` ed esce con 1 se un gate fallisce (soglie §7.2). Il workflow notturno carica il report come artifact.

## Review indipendente

Un revisore separato ha trovato 13 problemi sul branch. Corretti tutti quelli con uno scenario reale:

- **Alta.** Un tap Approva riconsegnato da Telegram dopo un crash a metà invio poteva rimandare la mail senza un nuovo tap. Ora la pratica salva l'ID del tap prima dell'invio: lo stesso tap viene riconosciuto (`tap.redelivered` nell'audit) e solo un tap nuovo sulla scheda di ripresa può inviare.
- **Alta.** Un crash durante CRM o bozza lasciava una pratica `received` senza scheda, per sempre. Ora la pratica di un preventivo viene salvata solo con la bozza pronta: dopo un crash la mail è ancora nuova e viene riletta da capo.
- **Media.** Una scheda rifiutata da Telegram ripartiva solo al riavvio: ora a ogni giro, senza la riga doppione se Telegram l'aveva rifiutata esplicitamente.
- **Media.** Un a capo nell'oggetto generato dal modello poteva aggiungere header alla mail (un `Bcc`). Ora `buildMime` rifiuta a capo in ogni header e l'oggetto della bozza è sempre su una riga.
- **Media.** Con più di 200 mail arretrate il cursore Gmail saltava le più vecchie, e una mail indicizzata in ritardo poteva sfuggire. Ora ogni giro guarda 10 minuti indietro, scarica solo le mail che il servizio non conosce e smaltisce l'arretrato dal più vecchio.
- **Media.** All'avvio `dev:segreteria` riscriveva la egress policy dell'istanza, riabilitando connettori tolti dall'owner. Ora la imposta solo alla creazione e, se manca qualcosa, si ferma dicendo cosa. La policy si rilegge a ogni richiesta.
- **Media.** Una risposta nello stesso thread di una pratica già inviata non si poteva più inviare. Ora l'invio precedente va in `sentHistory` e la nuova bozza è approvabile.
- **Media.** Approva su una scheda spam provava a inviare a `null`. Ora prepara lead e bozza e mostra la scheda, che va approvata a sua volta.
- **Media.** Il testo di modifica finiva sulla pratica in modifica più recente, di chiunque. Ora va alla pratica su cui quella persona ha toccato Modifica, entro 30 minuti.
- **Bassa.** Un tap il cui handler falliva andava perso: ora Telegram lo riconsegna, fino a tre volte. Un redirect poteva portare un connettore su un host non controllato: ora i redirect sono rifiutati.
- **Bassa.** Il giudice gonfiava le metriche: ora fa girare `processInboundMail` vero, esclude dall'accuratezza le mail scartate prima del modello, conta come errore ogni spam non riconosciuto, mette un tetto del 10% ai ripieghi sul template e non conta l'email nella F1.

## Verifica

Eseguita su questo branch, Node 22.22.0, Linux:

- `pnpm typecheck`: nessun errore. `pnpm build`: ok.
- `pnpm test`: 15 file, 98 test, 0 fallimenti (erano 51 a inizio settimana).
- `pnpm eval:segreteria`: 35 casi, 0 fallimenti.
- Mutazioni: togliendo la ricerca `rfc822msgid:` prima dell'invio Gmail, il ripiego su nota quando HubSpot rifiuta `hs_lead_status`, la riga doppione delle schede o il limite di un avviso al giorno sul tetto di spesa, i test corrispondenti falliscono.
- Avvio reale di `dev:segreteria` con credenziali finte: bootstrap, lock e policy ok; la richiesta di refresh OAuth arriva a Google, che risponde `invalid_client` (client inesistente), quindi endpoint e formato sono quelli giusti. Telegram non è raggiungibile da questo ambiente.
- `eval:segreteria:judge` con chiave finta: le chiamate arrivano all'API Anthropic, che risponde `401 invalid x-api-key`, e i gate fanno uscire con 1. La chiave usata è solo quella passata, mai quella d'ambiente.

## Garanzie e limiti

| Cosa | Garanzia | Limite |
|---|---|---|
| Invio mail | solo dopo Approva di un utente in allowlist | |
| Doppio invio mail dopo un crash | il tap riconsegnato non reinvia mai; un tap nuovo sulla scheda di ripresa trova l'invio precedente via `rfc822msgid:` | la seconda difesa regge solo se Gmail conserva il `Message-ID` che impostiamo: da verificare sulla casella vera |
| Schede Telegram | at-least-once, mai perse: un crash tra il salvataggio della pratica e la scrittura della scheda viene recuperato al giro successivo (la mail viene riletta, la scheda manca, riparte) | un crash nel mezzo della scrittura della scheda può produrre due schede uguali |
| Avviso doppioni | ogni reinvio dopo un crash è segnalato | scatta anche se il primo tentativo è morto prima di arrivare a Telegram: falso allarme possibile, doppione silenzioso mai |
| Estrazione | email sempre dall'header, campi fuori dagli insiemi ammessi scartati | qualità del modello non ancora misurata dal vivo |
| Bozza | passa sempre i controlli deterministici (modello o template) | i controlli sono regex: un prezzo scritto in lettere passa |
| Contatti HubSpot senza email | creati | un crash tra creazione e salvataggio può creare un secondo contatto |
| `hs_lead_status` | mappa sovrascrivibile | i valori interni di default non sono confermati dalla documentazione HubSpot |
| Posta in arrivo | nessuna mail persa tra un giro e l'altro (10 minuti di sovrapposizione, arretrato smaltito dal più vecchio) | al primo avvio la posta già presente viene ignorata; una mail indicizzata con più di 10 minuti di ritardo sfugge |

## Decisioni

- **Settimana 4 allargata.** Senza entry point, pulsanti e modello la prova reale non partiva: i tre punti previsti da soli non bastavano.
- **Il modello propone, il codice decide.** Email dal `From`, regole fisse per P.IVA e campi da chiedere, bozza bocciata se non passa i controlli della CI. Il prompt dice di ignorare istruzioni dentro la mail, ma la difesa vera è che nessuna azione parte dal testo del modello: l'invio resta dietro Approva.
- **HubSpot obbligatorio in `dev:segreteria`.** Con un CRM «spento» le schede direbbero «lead aggiornato nel CRM» senza esserlo.
- **Bot Telegram separato.** Due processi in long polling sullo stesso token si rubano gli update: `dev:segreteria` vuole un bot suo.
- **Niente retry automatico dell'invio mail.** Un retry cieco può mandare due mail; l'errore torna al commerciale con i pulsanti.
- **Prima lettura da «adesso».** Al primo avvio non si trasformano mesi di posta in pratiche.

## Cosa manca

- **Prova reale**: servono i segreti (vedi `stato-e-todo.md`). Da verificare dal vivo: conservazione del `Message-ID` su Gmail, valori di `hs_lead_status` del portale, qualità di estrazione e bozza (giudice notturno), costo per pratica.
- **Annullare una bozza in modifica quando arriva una mail nuova**: oggi il testo del commerciale va alla pratica in modifica più recente.
- **Più commerciali**: le schede vanno a tutti; il primo tap vince, gli altri vedono la pratica chiusa.
- Dalla settimana 2, ancora aperti: ritentativi nello stesso processo, pulizia dell'outbox delle risposte, segreti non cifrati a riposo.

## Comandi

```bash
pnpm typecheck
pnpm test
pnpm eval:segreteria                                 # controlli deterministici, nessuna chiave
OWNI_JUDGE_MODEL_KEY=... pnpm eval:segreteria:judge  # modelli veri + giudice; filtra: ... judge 001 017
pnpm dev:segreteria                                  # vedi .env.example, sezione dev:segreteria
```
