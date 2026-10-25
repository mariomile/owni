# Owni: Semplificazione del prodotto

Data: 25 ottobre 2026. Stato: Implementazione completata e verificata localmente sul branch `feat/product-simplification`. App locale aggiornata il 25 ottobre, insieme alla successiva correzione della chat; release pubblica non aggiornata.

Richiesta di Mario:

> Dobbiamo fare un lavoro di semplificazione del prodotto e di miglioramento. Ora ci sono troppe pagine, troppo cose confuse. Rivediamo tutto e semplifichiamolo riorganizzandolo o trasformandolo

## Raccomandazione

Portare Owni a **due spazi quotidiani: Conversazioni e Lavori**. Gli agenti restano entità reali, configurabili e riconoscibili, raggiungibili dal loro nome nella conversazione e da un ingresso secondario **Agenti**. L'account personale e la gestione dell'installazione restano separati.

La promessa da rendere concreta è: **Affidi un lavoro, sai cosa sta succedendo e intervieni quando serve.** File, memoria, procedure, strumenti, computer e collegamenti servono questo percorso; non devono essere altrettanti prodotti da imparare prima di cominciare.

Non basta spostare le voci sotto «Altro». Bisogna ridurre le scelte preventive: Chat oppure Stanza; task oppure scheda oppure automazione; impostazioni dell'agente oppure account oppure collegamento. Ogni scelta rimasta deve spiegare una differenza reale per la persona.

### Direzione confermata

Il 25 ottobre Mario ha scelto esplicitamente: **«Un assistente aziendale semplice, estendibile a un team di agenti»**.

L'esperienza primaria serve chi affida lavoro e ne controlla gli esiti. La configurazione di molti agenti è un'estensione che emerge al bisogno. Questa scelta conferma la direzione dell'esperienza; non equivale ad aver validato ogni schermata della proposta.

Titolare o operatore di una piccola azienda resta il profilo operativo di riferimento, coerente con il piano originario. Dimensione dell'azienda, settore prioritario e disponibilità di utenti per le prove restano da validare: La risposta non li specifica.

### Regole che derivano dalla scelta

1. **Si comincia con un assistente.** Nel primo utilizzo si può capire a chi scrivere e affidare un'attività senza decidere quanti agenti creare. Il destinatario rimane sempre visibile.
2. **La prima prova arriva prima della configurazione opzionale.** Chiedere soltanto ciò che manca per ottenere una risposta reale. Un provider già collegato viene riconosciuto; canali, computer, procedure e altri agenti non sono passi obbligatori.
3. **Il lavoro rimane seguibile.** La conversazione è il punto di partenza; Lavori permette di ritrovare esiti, richieste di intervento e attività automatiche anche dopo aver chiuso una chat. Creare un incarico direttamente rimane possibile.
4. **Il team emerge per una responsabilità concreta.** Si aggiunge un agente quando serve un ruolo, un insieme di accessi o un'attività separata. Aprire una seconda conversazione non richiede un secondo agente. Non si creano squadre né si condividono storici automaticamente.
5. **Le capacità emergono nel momento utile.** Per usare un servizio si apre il suo collegamento; per ripetere un lavoro si sceglie quando; per insegnare un metodo si salva una procedura. I dettagli avanzati restano raggiungibili nel profilo dell'agente.
6. **Le installazioni esistenti conservano la propria struttura.** Un'esperienza iniziale semplice non elimina agenti, chat, accessi o configurazioni già presenti e non rinomina automaticamente gli agenti delle persone.
7. **Semplicità non significa esecuzione invisibile.** Destinatario, stato, risultato e decisione richiesta restano comprensibili. Disponibilità del server e dell'app desktop, errori e permessi mancanti non sono nascosti dietro la promessa di un assistente sempre disponibile.

Il costo ipotizzato è dover conoscere la struttura interna e cercare fra più sezioni per capire dove assegnare, ritrovare o controllare un lavoro. Non abbiamo quantificato questo costo né verificato quanto sia diffuso: L'evidenza è la richiesta di Mario, l'inventario e il walkthrough locale, non una ricerca clienti.

## Evidenze e limiti

- Checkout analizzato: `main`, `ebca03ce2ec95a5fc2fbc14fc061cd82c812da21`. La console registra 16 tipologie di pagina e fino a 11 voci di sezione nella sidebar, oltre ad agenti, cronologia, ricerca e menu account. Questo non significa che ogni ruolo veda tutte le pagine. Fonte: [shell.js](../src/web/ui/shell.js#L32).
- Nell'app Owni 0.5.0 sono stati ispezionati navigazione, impostazioni, Board, Task e sentinelle, Automazioni, Approvazioni e Skill tramite l'albero di accessibilità. L'istanza locale ha due agenti e pochi contenuti: Non è un campione dell'uso clienti.
- La preview T3 ha restituito due volte `Preview automation snapshot timed out after 15000ms`. Anche le catture native hanno mostrato contenuto centrale vuoto a fronte di contenuto presente nell'albero di accessibilità; in seguito l'albero si è svuotato. Il server rispondeva a `/healthz`, senza errori nel registro filtrato. Dopo un riavvio normale l'albero della chat è tornato disponibile. Non si rivendica un audit visivo completo né una diagnosi della causa.
- Il documento [console.md](console.md) parla ancora di un gruppo «Altro»; il renderer corrente espone direttamente le voci `sidebar:true`. Per la struttura attuale prevalgono codice e app osservata.
- Il vault del 15 ottobre descrive una piattaforma Buildrs per operazioni aziendali, con primo caso concreto nelle richieste di preventivo e uffici commerciali di 1–5 persone. Non prova che questo sia ancora l'unico pubblico.
- La nota del 24 ottobre richiede capacità per agente: Comunicazione con altri agenti, skill, memoria, strumenti, collegamenti, computer e modello. Non impone pagine principali separate.
- Nessuna analytics di prodotto, intervista, prova di usabilità o test di autorizzazione è stata eseguita per questa proposta. Le soglie di validazione sotto sono obiettivi da provare.

## Diagnosi: Dove nasce la confusione

| Priorità | Fatto verificato | Conseguenza di prodotto dedotta |
|---|---|---|
| Prima | Il conteggio Approvazioni comprende più agenti; la pagina carica prevalentemente l'agente selezionato, oltre alle segreterie approvabili. [server.ts](../src/web/server.ts#L2067), [approvals.js](../src/web/ui/pages/approvals.js#L17) | Un badge può promettere decisioni che la destinazione non mostra. È un problema concreto da risolvere anche senza rifare la navigazione. |
| P1 | Il selettore agente resta visibile su pagine di tenant e di agente; cambiare agente mantiene molte pagine. [shell.js](../src/web/ui/shell.js#L209) | Sembra un filtro globale, ma il suo effetto cambia a seconda della pagina. |
| P1 | Task, sentinelle e brief sono in Task; webhook in Automazioni; schede ricorrenti e autonomia in Board. [tasks.js](../src/web/ui/pages/tasks.js#L120), [automations.js](../src/web/ui/pages/automations.js#L96), [board.js](../src/web/ui/pages/board.js#L538) | Per «fallo ogni mattina» bisogna conoscere categorie di implementazione. |
| P1 | Chat singole e Stanze hanno ingressi diversi; squadre pronte e comunicazione fra agenti aggiungono altri concetti. [rooms.js](../src/web/ui/pages/rooms.js#L6), [agents.js](../src/web/ui/pages/agents.js#L134) | Si confondono conversazione con più agenti e autorizzazione degli agenti a collaborare. |
| P1 | Impostazioni carica 14 risorse; il Salva generale e diversi controlli salvano cose diverse. [settings.js](../src/web/ui/pages/settings.js#L633) | Non è chiaro cosa sia cambiato, cosa richieda Salva e a quale livello appartenga. |
| P1 | Istruzioni, memoria, documenti e procedure sono in quattro superfici con diritti differenti. [settings.js](../src/web/ui/pages/settings.js#L699), [memory.js](../src/web/ui/pages/memory.js#L79), [files.js](../src/web/ui/pages/files.js#L80), [skills.js](../src/web/ui/pages/skills.js#L92) | «Insegnagli questa cosa» non ha un punto d'ingresso chiaro. |
| P2 | MCP, Google personale, permessi Google dell'agente, provider e canali sono distribuiti fra Account, Connettori e Impostazioni. [connectors.js](../src/web/ui/pages/connectors.js#L90), [google.js](../src/web/ui/google.js#L26) | Si confondono credenziale personale, capacità dell'agente e accesso condiviso. |
| P2 | Le rotte omettono l'ID agente; la ricerca comprende sezioni, chat dell'agente corrente e stanze. [common.js](../src/web/ui/common.js#L282), [palette.js](../src/web/ui/palette.js#L8) | Per ritrovare un contenuto bisogna ricordare prima quale agente fosse selezionato. |

La densità visiva è una conseguenza. Il problema più profondo è la presenza simultanea di tre perimetri non sufficientemente espliciti: **La persona, l'agente, l'installazione aziendale**.

## Nuova struttura

```text
Conversazioni
  Nuova conversazione / ricerca / conversazioni recenti
  Con un agente oppure con più agenti
  Dettaglio: Messaggi, lavoro collegato, file e risultati, Browser/Schermo quando usati

Lavori
  Tutti · Richiede te · In corso · Conclusi
  Vista Lista predefinita; Board come vista alternativa degli incarichi
  Pratiche commerciali quando configurate
  Automazioni: Orario · Cambiamento di pagina · Evento esterno · Ripeti un incarico

Agenti [ingresso secondario, anche dal nome dell'agente]
  Elenco e stato degli agenti visibili
  Dettaglio: Panoramica · Materiali · Procedure · Capacità · Configurazione

Il mio account
  Collegamenti personali · Sicurezza personale · Preferenze

Gestione dell'installazione [sezioni in base al ruolo]
  Persone e accessi · Provider disponibili · Consumi · Registro attività
```

**Richiede te** è un filtro trasversale, con una scorciatoia persistente e conteggio coerente in ogni area. Non è uno stato unico che sostituisce gli stati reali. Un incarico da avviare, bloccato da dipendenze o non assegnato deve esistere in Tutti, con il suo stato leggibile.

**Conversazioni** contiene solo quelle della persona: L'owner non acquisisce accesso alle chat altrui. Una stanza resta una conversazione fra una persona e 2–5 agenti, non una chat condivisa dell'azienda.

**Lavori** presenta ciò che la persona può vedere, attraverso gli agenti consentiti. Il filtro agente si trova dentro la vista; selezionare un agente in una conversazione non cambia di nascosto il perimetro di Lavori.

**Agenti** non scompare. Si riduce la sua presenza nel percorso quotidiano, conservando configurazione per agente e monitoraggio dello stato. La scelta confermata privilegia chi usa l'assistente; una console dedicata alla costruzione di molti agenti non guida questa semplificazione.

## Destinazione di tutte le pagine attuali

| Oggi | Proposta | Cosa si elimina o trasforma |
|---|---|---|
| Primi passi | Checklist contestuale nell'agente e nella chat iniziale | Il percorso obbligato attraverso funzioni opzionali. Nessun accesso a un canale va presentato come necessario per provare la chat. |
| Chat | Conversazioni | Un solo ingresso per iniziare a parlare; agente destinatario sempre visibile. |
| Agenti | Agenti, ingresso secondario e dettaglio contestuale | La duplicazione fra selettore, schede e impostazioni. |
| Stanze | Conversazioni con più agenti | La scelta di una sezione separata; non i partecipanti, le menzioni o i permessi. |
| Board | Lavori, Lista/Board | Board diventa una vista degli incarichi, non un altro prodotto. |
| Segreteria | Lavori → Pratiche commerciali | La voce principale; si conserva l'intero flusso richiesta/bozza/modifica/invio/scarto e il dettaglio specializzato. |
| Approvazioni | Lavori → Richiede te, accessibile sempre dal badge | La necessità di indovinare l'agente giusto per trovare una decisione. |
| Task e sentinelle | Lavori → Automazioni | Il termine «sentinella» come categoria da imparare e l'apertura contemporanea di più moduli. |
| Automazioni | Lavori → Automazioni → Evento esterno | «Automazione» diventa il contenitore; il webhook è un tipo avanzato, non tutta la categoria. |
| File | Agente → Materiali → Documenti; anche dal lavoro e dalla chat | Una pagina principale separata; i risultati restano raggiungibili dal lavoro che li ha prodotti. |
| Memoria | Agente → Materiali → Memoria su di me / Memoria condivisa | L'obbligo di imparare essenziale/archivio per iniziare. Provenienza e visibilità restano esplicite. |
| Skill | Agente → Procedure; comando e salvataggio dalla chat | Il termine tecnico nell'ingresso principale. Import/export SKILL.md rimangono in azioni avanzate. |
| Connettori | Agente → Capacità e collegamenti | La gestione separata dalla domanda «cosa può fare questo agente?». |
| Impostazioni | Configurazione dell'agente; provider comuni in Gestione | Il modulo unico con salvataggi eterogenei. Ogni sezione ha il proprio salvataggio esplicito. |
| Persone | Gestione → Persone e accessi | La separazione inutile fra creare una persona e vedere quali agenti può usare; i diritti restano distinti. |
| Attività e spesa | Esiti in Lavori; consumi e audit in Gestione | La sovrapposizione fra lavoro operativo e diagnostica. |

Account, accesso, 2FA, callback OAuth, modalità offline e cambio server restano flussi di servizio. Non entrano nel conteggio delle sezioni quotidiane.

## I concetti che diventano più semplici

### Conversazione

Un ingresso «Nuova conversazione». Con un solo agente disponibile è già selezionato; con più agenti si vede il destinatario e si può cambiarlo. Nessuna scelta invisibile di un coordinatore e nessuna creazione automatica di agenti.

Una conversazione con più agenti mostra partecipanti e chi risponderà al messaggio corrente. Avviare un nuovo gruppo da una chat 1:1 richiede una scelta esplicita del contesto da portare; non si aggiungono agenti a una chat privata condividendone silenziosamente lo storico. Le collaborazioni già abilitate fra agenti continuano secondo le regole esistenti, dichiarate nel dettaglio dell'agente.

### Incarico

La persona specifica **Cosa deve ottenere, chi se ne occupa e quando**. Può farlo dalla chat o direttamente da «Nuovo incarico»: La chat non diventa un passaggio obbligatorio.

Dal lavoro si ritrovano conversazione, risultato, documenti, decisioni, stato e ultima esecuzione. Conservare gli stati della Board: Da fare, In corso, Da rivedere, Fatto; rendere visibili anche dipendenze, mancata assegnazione e interruzione. «Da rivedere» non prova che il risultato sia completato. «Risposta pronta», «consegna riuscita» e «risultato accettato» restano eventi diversi.

La scheda del risultato deve dire cosa è stato prodotto e come verificarlo. «Accetta risultato» chiude la revisione; non autorizza chiamate a servizi. «Approva invio» autorizza l'azione esatta proposta. Un errore propone «Vedi problema» o un retry ammissibile, non un pulsante Approva generico.

### Automazione

Un ingresso chiede **Quando deve partire?** e presenta quattro scelte comprensibili. Il modulo successivo è specifico per tipo:

| Tipo | Cosa la persona deve capire |
|---|---|
| A un orario | Data o frequenza, fuso, agente, destinazione, prossima esecuzione; cron solo in Avanzate. Il brief è un esempio pronto. |
| Quando cambia una pagina | Pagina, condizione supportata, frequenza del controllo e destinazione. Non ogni controllo produce un messaggio. |
| Quando arriva un evento | Servizio sorgente, istruzione e destinatario. URL segreto mostrato solo nel flusso previsto; chiave e dati ricevuti non entrano in anteprime o log generici. |
| Ripeti un incarico | Risultato atteso, assegnazione, frequenza e regola che attende la chiusura del precedente. Non è una semplice notifica programmata. |

Mostrare separatamente **Configurazione attiva**, **ultima esecuzione**, **ultimo esito**, **prossimo avvio/condizione**. Mettere in pausa una configurazione riguarda i prossimi avvii, fermare un'esecuzione riguarda il lavoro in corso e non annulla azioni già effettuate.

### Agente e materiali

- **Panoramica:** Compito, stato attuale, lavoro collegato e azioni di configurazione consentite al ruolo.
- **Materiali:** Documenti dell'agente, Memoria su di me, Memoria condivisa. Non un archivio indistinto. File ricevuti e risultati prodotti restano distinguibili e raggiungibili dalla loro origine.
- **Procedure:** Come svolgere un'attività. Sono le skill esistenti, con proprietà, bozze personali, attivazione e diritti di modifica invariati.
- **Capacità:** Strumenti attivi/proposti, servizi collegati, browser, computer, canali e collaborazione fra agenti. Uno strumento eseguibile non è una procedura testuale; i suoi nuovi accessi continuano a richiedere le approvazioni previste.
- **Configurazione:** Identità e istruzioni, modello predefinito, chi può scrivere e chi può approvare. Le sezioni riservate non diventano visibili ai membri solo perché appartengono alla stessa schermata.

Il percorso «insegnagli qualcosa» offre tre intenzioni: Aggiungi un documento, ricorda un fatto, salva una procedura. La conferma mostra chi lo vedrà e quale agente lo userà.

## Flussi da progettare e verificare

| Flusso | Entrata e percorso | Uscita, interruzione e reversibilità |
|---|---|---|
| Primo risultato | Apri → verifica provider pronto → scrivi al destinatario visibile → risposta/file | Non occorre configurare canali, più agenti o Computer Use. Un provider mancante ha un recupero esplicito. Bozza salvata con il contesto corretto. |
| Affidare lavoro | Chat → Segui come incarico, oppure Lavori → Nuovo incarico → obiettivo/agente → avvia o salva | Creazione e avvio distinti quando necessario. Chiude il modulo: Mantiene bozza o conferma l'abbandono, senza esecuzioni involontarie. |
| Intervenire | Badge Richiede te → elemento autorizzato → decisione specifica → esito e ritorno al lavoro | Rifiuto, invio, accettazione e retry hanno conseguenze diverse. Chiusura del dettaglio non decide nulla. Conflitto/versione scaduta ricarica prima di decidere. |
| Lavoro automatico | Lavori → Automazioni → tipo → campi specifici → agente/destinatario → conferma | Bozza fino alla conferma. Pausa configurazione e Stop dell'esecuzione sono controlli separati. |
| Pratica commerciale | Lavori → Pratiche → richiesta → bozza → modifica/versione → approva invio oppure scarta | Mantenere tutto il flusso della Segreteria, inclusi esiti e problemi dopo l'invio. Non appiattirlo in un generico risultato chat. |
| Più agenti | Nuova conversazione → partecipanti → eventuale contesto esplicito → destinatario corrente → invio | Annullare non crea una stanza vuota. Distinguere partecipazione alla stanza e permesso di delegare fra agenti. |
| Insegnare/collegare | Nome agente → materiale/procedura/capacità → proprietà e accesso → salva/collega | Bozze e credenziali rispettano i flussi correnti. Nessun consenso allargato implicitamente. |

## Stati e accessibilità

| Stato | Comportamento richiesto |
|---|---|
| Vuoto | Una sola azione pertinente; niente moduli tecnici sempre aperti e niente invito a configurare ogni capacità. |
| Caricamento | Caricamento dell'area con contesto conservato; soglia temporale e recupero da definire sulla latenza misurata. |
| Parziale | Gli elementi già caricati restano; un agente irraggiungibile è dichiarato. I totali non sono presentati come completi se una fonte manca. |
| Errore | Dire cosa non è riuscito e come riprendere; gli esiti incerti non diventano «Fallito» o «Completato» per comodità. |
| Successo | Risultato e conseguenza della decisione visibili, con link all'origine. Nessuna promessa di consegna basata sulla sola risposta del modello. |
| Permesso | Usare gli stessi contratti 401/403/404 e di occultamento risorse esistenti; non rivelare nomi, conteggi o anteprime non autorizzati. |

Percorso tastiera principale: Navigazione → filtri → elenco → dettaglio → azione specifica → conferma. Aprendo un dialog il focus va al titolo/campo pertinente; chiudendolo torna al controllo di origine. Errori portano al campo responsabile. Completamento e variazione del conteggio sono annunciati, senza affidarsi solo al colore. Target: Testo 4.5:1, testo grande 3:1, controlli significativi 3:1. Drag della Board ha un'alternativa da tastiera/lista.

## Vincoli da non rompere

1. Tenant separati e politica di uscita invariata. Nessun nuovo archivio condiviso implicito.
2. Essere owner non significa poter chattare con ogni agente o leggere le chat di altre persone. Fonti: [server.ts](../src/web/server.ts#L262), [server.ts](../src/web/server.ts#L498).
3. La memoria personale resta personale; quella condivisa mantiene i suoi diritti. File condivisi nell'agente e bozze delle procedure non ereditano la stessa visibilità. Fonti: [server.ts](../src/web/server.ts#L755), [server.ts](../src/web/server.ts#L1566), [server.ts](../src/web/server.ts#L1669).
4. Una coda comune non attribuisce un diritto comune di approvazione. Google rimane della persona proprietaria dell'account; gli altri tipi usano la propria idoneità. Fonti: [server.ts](../src/web/server.ts#L1007), [server.ts](../src/web/server.ts#L1760).
5. Conservare Stop, recupero dopo crash, destinatario degli esiti, collegamento incarico/chat, versioni delle bozze e consegne incerte. Fonte: [runs.js](../src/web/ui/runs.js#L11).
6. Unificare le viste non significa fondere i motori di esecuzione. Identità e azioni restano collegate all'oggetto sorgente. Per esempio: `tipo + id sorgente + agente + persona + stato + azione consentita`, come proiezione, non nuovo oggetto universale da imporre al dominio.
7. I vecchi link e callback devono continuare ad aprire il contesto corretto. Le nuove destinazioni esplicitano l'agente, senza fidarsi solo dell'ultima selezione nel browser.

## Componenti e attuazione

Riutilizzare: Shell/registro pagine, elenco conversazioni, card delle decisioni, dettaglio Board, pratiche Segreteria, editor delle procedure, liste di file e memorie, moduli dei collegamenti, pannelli Browser/Schermo. Non aggiungere dipendenze per la riorganizzazione.

Estendere: Navigazione con gerarchia uso/gestione; elenco conversazioni attraverso gli agenti consentiti; contatori coerenti; stato agente esplicito; menu di scelta del tipo di automazione; collegamenti al contesto.

Nuovo, giustificato: Vista personale aggregata **Richiede te**, perché oggi il conteggio e la pagina non condividono lo stesso insieme; composizione della vista **Lavori** sopra le fonti esistenti. Servono risposte aggregate con visibilità e azioni calcolate dal server, non solo filtri client su dati troppo ampi.

### Ordine consigliato

1. **Coerenza delle decisioni e del contesto.** Conteggio → lista → dettaglio con lo stesso perimetro, agente e tipo di conseguenza espliciti. È il primo intervento utile anche prima del nuovo guscio.
2. **Due ingressi quotidiani e configurazione dell'agente.** Nuova navigazione, conversazioni singole/multiple nello stesso elenco, profilo agente e vecchie rotte compatibili. I dettagli specializzati si riutilizzano.
3. **Lavori e automazioni comprensibili.** Lista predefinita, Board alternativa, Pratiche commerciali esplicite, creazione per intenzione e automazioni tipizzate. Nessuna riscrittura dello scheduler.
4. **Riduzione della configurazione preventiva.** Primo avvio minimo, materiali/procedure contestuali, salvataggi coerenti e moduli avanzati aperti su richiesta.

Ogni fase è una porzione verificabile. Non pubblicare una sidebar nuova che manda a superfici mancanti o perde le decisioni pendenti. Una riscrittura globale del front end non è un prerequisito.

### Primo intervento implementabile: Decisioni coerenti fra agenti

**Problema:** A dati invariati, il conteggio globale delle approvazioni e la destinazione aperta non rappresentano lo stesso insieme. La correzione serve anche alle installazioni con più agenti già configurati, senza obbligare chi usa l'assistente a selezionare prima quello giusto.

**Risultato:** Aprendo Approvazioni la persona trova tutte le decisioni che le competono negli agenti visibili. Ogni elemento mostra agente, tipo e conseguenza; le azioni restano quelle della risorsa sorgente.

Superfici coinvolte:

- [server.ts](../src/web/server.ts#L2067): Il riepilogo conta le sei fonti, applicando regole specifiche. Aggregazione, visibilità e conteggi devono usare la stessa definizione; nessun dato troppo ampio inviato al client per poi nasconderlo.
- [approvals.js](../src/web/ui/pages/approvals.js#L14): Sostituire il solo contesto selezionato con la raccolta consentita, mantenendo il riferimento all'agente di ogni elemento e le pratiche commerciali.
- [cards.js](../src/web/ui/cards.js): Riutilizzare le card tipizzate. La decisione deve indirizzare l'agente e l'oggetto originali anche se nel frattempo cambia la selezione della console.
- [console-ui.test.ts](../test/console-ui.test.ts) e [web.test.ts](../test/web.test.ts): Verifiche del comportamento della console e delle regole lato server, scegliendo i test esistenti più vicini durante l'implementazione.

Criteri di accettazione:

1. Con due agenti e decisioni pendenti distribuite fra loro, aprire la pagina da ciascun agente mostra il medesimo insieme personale consentito; a dati invariati, il conteggio corrisponde agli elementi pendenti, incluse le singole pratiche dentro eventuali gruppi.
2. Persona richiedente, approvatore e owner mantengono le idoneità attuali. Le azioni Google restano della persona proprietaria dell'account; essere owner non le trasferisce.
3. Identificativi uguali in agenti o tipi diversi non causano collisioni. Ogni elemento conserva tipo, agente e ID sorgente.
4. Decidere un elemento esegue soltanto l'azione esatta prevista, sul suo agente. Un cambio di selezione o una decisione concorrente non indirizza un altro oggetto né ripete l'azione.
5. Una fonte che non si carica non produce il messaggio «Niente da approvare». La pagina dichiara il caricamento parziale o l'errore e permette di riprovare senza rieseguire una decisione.
6. Le revisioni della Board rimangono distinte dalle autorizzazioni di azioni. La loro raccolta nella futura vista Richiede te non cambia il significato di Approva/Accetta.
7. Il flusso è utilizzabile da tastiera e su telefono. Ogni decisione espone agente e conseguenza senza richiedere di visitare Impostazioni.

Validazione dell'implementazione: Typecheck, test mirati di visibilità e decisione fra agenti, build e prova renderizzata con dati locali controllati. Nessun invio reale di mail, richiesta a servizi clienti o chiamata a modelli a pagamento è necessario per verificarla.

Il primo intervento è stato implementato insieme alla navigazione a due aree, alla composizione di Lavori e Automazioni e alla configurazione progressiva. Le verifiche e i limiti della consegna sono riportati nell’aggiornamento di implementazione in fondo al documento.

## Validazione prima di trasformare tutto

La direzione dell'esperienza è stata scelta. Resta da provare l'ipotesi di interazione: Le persone del pubblico scelto riescono ad affidare e controllare lavoro con meno esitazioni usando conversazioni e risultati da seguire, e trovano le configurazioni contestuali quando servono. Se non le trovano, si correggono scoperta e percorsi senza cambiare il pubblico per giustificare il design.

Provare il modello con compiti reali di Mario, poi con persone del pubblico scelto. Le persone da contattare e l'accesso a utenti del prodotto non sono stati identificati: Nessun reclutamento è stato fatto.

- Trovare la decisione pendente di un agente diverso da quello appena usato.
- Trovare e avviare un incarico non assegnato; capire perché uno bloccato non parte.
- Distinguere «Accetta risultato», «Approva invio» e un errore da risolvere, anche senza scheda Board.
- Portare una richiesta commerciale dalla ricezione alla bozza e all'esito dell'invio.
- Impostare e spiegare i quattro tipi di automazione, inclusa la ricorrenza che aspetta la chiusura precedente.
- Recuperare un documento prodotto e distinguere memoria personale da condivisa.
- Capire chi riceve contesto passando da conversazione singola a più agenti.
- Ripetere con owner e membro, più agenti, fonti parzialmente indisponibili e permessi revocati.

Soglia proposta, da concordare: Almeno 4 persone su 5 completano i tre compiti principali senza spiegazioni; nessuna confusione fra autorizzare un invio e accettare un risultato; nessuna regressione di visibilità nei controlli automatici. Non è un risultato già ottenuto. Misurare numero di scelte sbagliate e ritorni fra pagine, oltre al tempo; il numero di voci di menu da solo non prova semplicità.

## Alternative considerate

| Strada | Vantaggio | Limite | Giudizio |
|---|---|---|---|
| Solo raggruppare il menu | Poco rischio di migrazione | Le stesse decisioni restano da capire | Utile come contenimento, insufficiente come direzione |
| Conversazioni / Lavori / Agenti tutti principali | Più accesso al coordinamento e alla configurazione | Mette ancora una funzione di gestione nel percorso di tutti | Alternativa considerata, non prioritaria per l'esperienza scelta |
| Conversazioni / Lavori, agenti contestuali | Riduce le scelte quotidiane e conserva il prodotto multi-agente | Richiede buona scoperta di materiali e configurazione | Proposta coerente con la direzione confermata; da provare nell'uso |
| Solo chat | Primo uso molto pulito | Nasconde lavoro persistente, decisioni, errori e automazioni | Non raccomandata per la promessa attuale |

La revisione indipendente ha richiesto e questa versione include: Stati di lavoro completi, flusso Segreteria esplicito, automazioni differenziate, contesto delle conversazioni multi-agente, memoria condivisa e strumenti separati dalle procedure.

## Fonti di prodotto e riferimenti

Fonti canoniche del vault, consultate in sola lettura:

- [Piano iniziale, 15 ottobre](</Users/mariomiletta/Vaults/marioverse.ai/Active/Projects/Owni/Piattaforma agenti Buildrs - piano.md:18>): Posizionamento, conversazione come unità di lavoro e perimetro iniziale.
- [Specifica della segreteria](</Users/mariomiletta/Vaults/marioverse.ai/Active/Projects/Owni/Spec segreteria commerciale Telegram.md:24>): Primo pubblico, flusso operativo e controllo umano.
- [Nota del 24 ottobre](</Users/mariomiletta/Vaults/marioverse.ai/Journal/Daily/24-10-2026.md:9>): Capacità per agente; non un'architettura approvata.
- [Owni](</Users/mariomiletta/Vaults/marioverse.ai/Active/Projects/Owni/Owni.md:23>): Espansione del perimetro, senza priorità sufficienti a decidere un nuovo pubblico.

Riferimenti esterni limitati a due pattern, non prova di adozione o di preferenze dei nostri utenti:

- Linear distingue gli aggiornamenti che richiedono attenzione dentro la sua Inbox. È un riferimento per la visibilità delle decisioni; l'uso per Owni è una nostra inferenza. [Documentazione Inbox](https://linear.app/docs/inbox).
- Dust distingue l'accesso ai dati dall'accesso agli agenti. È un richiamo a conservare i confini quando si semplifica la presentazione, non una proposta di importarne il modello. [Descrizione ufficiale dei permessi](https://dust.tt/blog/permissions-in-the-age-of-ai-driven-companies-2).

Proposta navigabile: [product-simplification-2026-10-25.html](product-simplification-2026-10-25.html). Usa dati inventati e interazioni dimostrative; non accede al server di Owni né modifica account, agenti o lavori reali.

Verifiche dell'artefatto: Render a 728 px in tema scuro e 360 px in tema chiaro, più viste Materiali e dettaglio della decisione. Controlli eseguiti nel browser su navigazione, filtri, distinzione delle azioni, quattro tipi di attivazione, modulo incarico, conversazione con più agenti e presentazione per ruolo. Controllati sintassi JavaScript, ID/label HTML e destinazioni relative del rapporto. Queste verifiche riguardano il prototipo; non certificano l'usabilità o i permessi dell'app reale.

## Implementazione locale del 25 ottobre

L'implementazione sul branch `feat/product-simplification` usa i moduli, le API e i controlli esistenti. Non introduce dipendenze o un nuovo motore di esecuzione.

| Area | Comportamento implementato |
|---|---|
| Navigazione | Conversazioni e Lavori principali; Richiede te sempre raggiungibile; Agenti e Account e gestione secondari. Le rotte specializzate restano disponibili. |
| Conversazioni | Elenco personale attraverso gli agenti consentiti, ricerca e filtro locale; conversazioni con più agenti nello stesso elenco e creazione progressiva. Collegamenti e titoli mantengono l'agente esplicito. |
| Lavori | Incarichi, decisioni tipizzate ed esiti delle esecuzioni personali. Tutti conserva anche non assegnati e dipendenze; Richiede te segue i destinatari effettivi. Board resta una vista alternativa. |
| Decisioni | Nuova API autenticata `/api/approvals` con le stesse regole e lo stesso conteggio del riepilogo. I dettagli conservano tipo, agente e ID; le azioni indirizzano la risorsa originale. |
| Automazioni | Scelta fra orario, cambiamento di pagina, evento esterno e incarico ricorrente. Configurazione, ultima esecuzione, risultato e prossimo evento restano propri di ciascun tipo. |
| Agente | Profilo con materiali, memoria personale/condivisa, procedure, capacità e configurazione. Impostazioni divise in cinque sezioni, con gli input non salvati conservati cambiando sezione. |
| Primo uso | Modello e primo messaggio come percorso iniziale; capacità e personalizzazione opzionali. |
| Compatibilità | Vecchi indirizzi, ancore delle impostazioni e moduli esistenti; creazione/dettaglio Board e quattro intenti di automazione raggiungibili direttamente. Service worker aggiornato con tutti i nuovi moduli. |

### Correzioni emerse dalla review

- Le approvazioni precedenti vengono eliminate quando la nuova lettura fallisce, evitando di conservare dettagli privati dopo una revoca confermata dall'elenco agenti.
- Una copia Board precedente viene eliminata se il nuovo elenco conferma un cambio di visibilità mentre la lettura Board fallisce, oppure se manca un elenco precedente con cui verificarne l'autorizzazione. Una fonte temporaneamente indisponibile con visibilità invariata può conservare l'ultima lettura, dichiarata parziale.
- La Segreteria non richiede più risorse di conversazione che non supporta. Gli agenti amministrabili senza accesso chat mantengono le risorse consentite.
- Gli eventi live della Board aggiornano le fonti della vista montata e mantengono i filtri scelti.
- I filtri di Lavori e Automazioni usano solo gli agenti accessibili alla persona. Il catalogo più ampio restituito dalla Board non aggiunge scelte inutilizzabili a questi filtri.
- I dialoghi del percorso corrente si chiudono quando cambia la rotta, incluso Indietro del browser; la creazione di un incarico ricorrente non resta sovrapposta alla pagina Automazioni.
- Le pagine asincrone controllano che il contesto sia ancora corrente prima di presentare risposte; i link espliciti a un agente non accessibile mostrano indisponibilità invece di scegliere un altro agente.

### Verifiche automatiche e nel browser

L'ultima esecuzione mirata comprende **67 test superati**: Aggregazione delle approvazioni, permessi, collisioni di ID, routing esplicito, configurazione progressiva, copie parziali e revoche, destinatari delle revisioni, modelli di automazione e impostazioni del computer. Superati anche typecheck, build, sintassi dei 37 moduli UI e controllo delle differenze.

La suite completa precedente alle ultime regressioni aggiunte ha prodotto **2.866 test superati, 25 saltati e tre timeout** durante l'esecuzione parallela. I tre file interessati sono stati rieseguiti con un solo worker: **42 test superati**. Non viene presentata come una singola esecuzione completa senza errori.

Il browser usa il server di prova locale con due agenti e due persone, modello deterministico, scheduler fermo e richieste esterne bloccate. Le prove del parent hanno verificato:

- Conteggio Richiede te coerente con autorizzazioni più revisioni Board. Accettare un risultato ha portato l'incarico a Fatto lasciando pendenti le autorizzazioni di invio.
- Dettaglio Google dell'agente corretto e rifiuto di una proposta strumento su un altro agente, senza cambiare la selezione della chat. Dopo il rifiuto il conteggio si è aggiornato coerentemente.
- Creazione diretta di un incarico non assegnato, senza avvio di agenti.
- Elenco owner con sole conversazioni personali e stanza personale, senza titoli delle conversazioni del membro.
- Evento Board reale con filtro In corso e agente mantenuti; nessun errore JavaScript osservato.
- Indietro dal modulo di incarico ricorrente alla pagina Automazioni, con nessun dialogo rimasto aperto.
- Layout a 1.440 e 390 px; nella vista mobile verificata, larghezza del documento uguale a quella della finestra.

La QA indipendente ha verificato 54 viste a 1.440 e 390 px, più otto percorsi di ingresso alle automazioni: Privacy delle conversazioni, permessi dei profili, input non salvati, vecchie ancore, intenti Board, conteggi e assenza di scorrimento orizzontale o eccezioni JavaScript. Ha riprodotto la persistenza del dialogo con Indietro e i filtri con un agente non accessibile. Entrambi sono stati corretti e ricontrollati con esito positivo. Il secondo giro ha verificato otto combinazioni owner/membro, Lavori/Automazioni e desktop/telefono: Scelta agente, filtro, reset e aggiornamento corretti; nessuna lettura dell'agente nascosto, errore browser o larghezza eccedente la finestra.

La review indipendente del codice ha chiuso tutte le osservazioni su copie private dopo revoca e navigazione: Il quarto giro ha riportato PASS con 104 test mirati e prove aggiuntive sui casi di privacy e ciclo di vita dei dialoghi.

Le evidenze locali e il manifest dei dati di prova sono in `/private/tmp/owni-product-qa-LWwlET`; i file di autenticazione restano fuori dal repository. La QA indipendente usa `independent-qa-report.md`, `independent-qa-matrix.json`, `independent-qa-dialog-recheck.json` e `independent-qa-filter-round2-report.md`; il primo rapporto conserva i difetti trovati prima delle correzioni. Il server di prova viene fermato al termine della verifica.

### Limiti e stato di consegna

Queste prove non costituiscono ricerca di usabilità con il pubblico scelto. Il ciclo commerciale completo della Segreteria e gli effetti reali su Google/MCP o altri servizi esterni non sono stati eseguiti. Il tentativo di rifiuto Google nel server di prova ha restituito 501 perché quel server non dispone del relativo esecutore; l'interfaccia ha mostrato l'errore. Nessuna chiamata a modelli a pagamento, mail reale o modifica a sistemi clienti.

Al termine della prima consegna, l'app installata e la release pubblica non includevano ancora l'implementazione. Dopo la successiva segnalazione di Mario sulla chat, il 25 ottobre l'app locale è stata aggiornata con questa semplificazione e con il rendering Markdown, la nuova tipografia, il compositore compatto e lo stato discreto delle esecuzioni. L'aggiornamento delle risorse è stato verificato nella conversazione originale, dopo un backup dei dati e senza cambiare i binari nativi. Dettagli delle verifiche in [console.md](console.md#verificato). Nessun push, merge o pubblicazione della nuova versione.
