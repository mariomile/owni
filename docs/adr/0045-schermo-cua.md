# Lo schermo: un desktop per agente, con Cua

> Sostituito dall'[ADR 0135](0135-schermo-nel-computer-dell-agente.md): lo schermo non è più un desktop di Cua in un altro container. È Chromium dentro il computer dell'agente, e `OWNI_DESKTOP=docker|remote` con le sue impostazioni non ci sono più. Lo schermo continua a non seguire i siti consentiti e a non chiedere approvazione.

Mario (17 ottobre 2026): «computer use e browser use con Cua». Owni aveva già un terminale senza rete ([ADR 0013](0013-terminale-in-un-computer-senza-rete.md), [ADR 0015](0015-computer-su-micro-vm.md)) e un browser che legge, clicca e scrive nei siti consentiti ([ADR 0014](0014-browser-con-clic-nella-cella.md)). Mancava un desktop vero: una finestra da guardare, un mouse e una tastiera, i programmi che non hanno una pagina web, i siti che il browser della cella non riesce a usare.

Lo schermo è quel desktop. Ogni agente ne ha uno suo: un Linux con XFCE e Firefox, dove Owni guarda lo schermo e clicca, scrive, preme tasti, scorre e apre programmi o indirizzi. Lo guida attraverso [Cua](https://github.com/trycua/cua), che dà un desktop già pronto in un'immagine Docker e un demone che lo comanda via MCP.

## Decisione

- **Cua come immagine separata, non come codice nostro.** Owni avvia `trycua/cua-xfce:0.3.0` (tag fisso, mai `latest`; solo amd64, circa 8 GB) come container a parte e parla con il suo demone `cua-spacesd` sulla porta 3211: `GET /health` per sapere se è pronto, `POST /mcp` per i comandi. Non copiamo né distribuiamo il codice di Cua (licenza FSL-1.1-MIT per il demone): usiamo l'immagine che pubblicano.
- **Un client MCP minimo, nostro** (`src/desktop/mcp-client.ts`): JSON-RPC 2.0 su HTTP, `initialize` e `notifications/initialized` prima di tutto, l'intestazione `Mcp-Session-Id` del server rimandata a ogni richiesta, l'elenco degli strumenti chiesto una volta, un tempo massimo per richiesta, una sessione che il server ha dimenticato riaperta una volta. Le risposte sono JSON; legge anche un event stream, per i server che rispondono così. I connettori tengono l'SDK completo: qui bastano poche richieste a un demone che Owni avvia da sé.
- **Il controllo degli strumenti.** Prima di chiamare uno strumento di Cua (`get_desktop_state`, `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `get_screen_size`, `launch_app`) Owni guarda se il demone lo offre. Se manca, lo dice in chiaro invece di fallire a metà: l'immagine pubblicata può differire dal codice di Cua su `main`.
- **Sette tool** (`src/core/tools/desktop-tools.ts`), offerti solo se il server ha lo schermo **e** l'owner l'ha acceso per quell'agente (l'interruttore riapre l'agente, come il salvataggio delle impostazioni): il modello non vede strumenti che non può usare.
  - `desktop_look`: una foto dello schermo, che arriva al modello come immagine, con il testo che il desktop accompagna, recintato come dati. Una foto più grande di 1280 pixel di lato o più pesante di 5 MB viene rifiutata, non mandata.
  - `desktop_click` (x, y, tasto, doppio clic), `desktop_type` (testo dove sta il cursore), `desktop_key` (un tasto, o una combinazione come `ctrl+l` che diventa `hotkey`; i nomi comuni come enter, esc, pagedown, control, cmd diventano quelli del desktop), `desktop_scroll` (direzione, passi, punto), `desktop_drag` (da un punto a un altro), `desktop_open` (un programma per nome, o un indirizzo nel browser dello schermo).
  - Dopo ogni azione Owni riceve lo schermo com'è adesso: vede subito l'effetto, senza un `desktop_look` in più. Se l'azione è andata ma la foto dopo non arriva, Owni lo legge così, senza credere che l'azione sia fallita: guarda di nuovo prima di rifarla.
  - Le descrizioni dicono quando usare lo schermo (programmi del desktop, siti che `web_browse` non riesce a usare) e quando no (`web_read` e `web_browse` per leggere e compilare pagine, `computer_run` per file, dati e comandi; `web_browse` lo ripete quando l'agente ha lo schermo). Dicono anche di guardare di nuovo una pagina che si sta ancora caricando, di fermarsi e dirlo alla persona dopo due o tre tentativi senza effetto o davanti a un CAPTCHA o a un accesso, e che la prima azione può chiedere fino a 2 minuti mentre lo schermo si avvia.
  - Le coordinate si leggono sull'immagine. Lo schermo Docker è 1280×800, la stessa misura della foto, quindi coincidono. Uno schermo più grande (quello remoto) arriva rimpicciolito: Owni riporta le coordinate alla misura vera con le dimensioni originali che Cua manda con la foto o, dopo un riavvio, con `get_screen_size`. Non usa il `capture_id` di Cua per questo: il conto lo fa il codice nostro, e si prova nei test.
- **L'owner accende lo schermo agente per agente** (Impostazioni, «Schermo»), spento di default: è il connettore `schermo` nella egress policy, letto a ogni chiamata come per il computer. L'operatore lo rende disponibile con `OWNI_DESKTOP`.
- **Due fornitori.**
  - `OWNI_DESKTOP=docker`: un container per agente sul server Docker di Owni, con il nome da un hash di tenant e agente come il computer. Token del demone (`CUA_ENV_TOKEN`) e password VNC (`VNC_PW`, senza la quale noVNC non ne chiede una) casuali per ogni container: stanno nelle impostazioni del container, e dopo un riavvio Owni li rilegge da Docker. 3 GB di memoria, 2 CPU, 1 GB di `/dev/shm` per Firefox, un init come primo processo, niente escalation di privilegi, nessuna porta pubblicata sul server. Tutte le capability tolte tranne `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` e `KILL`: quelle che servono a un supervisord che gira come root per avviare VNC e il desktop come utente e sistemarne i file. Niente `NET_ADMIN`: l'indirizzo lo dà Docker, e il `dhclient` dell'immagine può fallire senza danni. Al massimo 4 schermi accesi: per un quinto agente si chiude quello usato meno di recente, e se tutti e quattro stanno lavorando il quinto aspetta un minuto e riprova (Owni glielo dice). Uno schermo senza azioni per 15 minuti si ferma. All'avvio Owni ferma gli schermi rimasti accesi e cancella quelli già fermi. Eliminare un agente cancella anche il suo schermo ([ADR 0046](0046-eliminare-un-agente.md)).
  - `OWNI_DESKTOP=remote`: un solo demone di Cua che qualcuno fa girare altrove, con `OWNI_DESKTOP_URL` (https) e `OWNI_DESKTOP_TOKEN`. **È lo stesso schermo per tutti gli agenti che lo usano**: la console lo dice, Owni manda un comando alla volta, e non lo si riavvia da Owni.
- **La rete dello schermo Docker.** Owni mette gli schermi su una rete Docker sua. Di default è `owni-desktop`, **interna**: niente internet, e il browser dello schermo apre solo quello che c'è dentro. Con `OWNI_DESKTOP_NETWORK=internet` l'operatore sceglie `owni-desktop-internet`, che arriva a internet: serve per usare il web dal Firefox dello schermo. Quando Owni crea la rete, spegne il traffico fra container (`com.docker.network.bridge.enable_icc=false`), così lo schermo di un agente non vede quello di un altro. Owni raggiunge il demone all'indirizzo del container su quella rete. Una rete con quel nome che esiste già deve essere interna o no come dice l'operatore, altrimenti Owni si ferma e lo dice; se lascia passare il traffico fra container, Owni la usa e scrive un avviso nel log, perché allora **l'isolamento fra gli schermi è perso**: restano solo token e password VNC diversi.
- **Mai in una cella di Owni Cloud.** `OWNI_DESKTOP` con `OWNI_CELL_SECRET` è un errore di configurazione.

## Cosa resta fuori dalle regole del resto di Owni

Lo diciamo chiaro, perché è la differenza con il browser della cella.

- **Con internet, il browser dello schermo non segue l'elenco dei siti consentiti dell'agente.** Il browser della cella passa da un fetch che controlla ogni richiesta; quello dello schermo esce dalla rete Docker. È una scelta dell'operatore (`OWNI_DESKTOP_NETWORK=internet`) più quella dell'owner, agente per agente. La card in Impostazioni lo scrive.
- **Quello che Owni fa sullo schermo non passa dalle approvazioni.** Un modulo inviato, una mail mandata, un acquisto, un accesso a un account dentro lo schermo non diventano una card da approvare, perché per Owni sono clic e tasti. Le descrizioni dei tool dicono al modello di fermarsi e chiedere alla persona in chat prima di inviare, pagare, accettare condizioni o accedere a qualsiasi account, e di non scrivere mai password. È un'istruzione, non un blocco: per questo lo schermo è spento di default e senza internet di default.
- **Quello che c'è sullo schermo sono dati, non istruzioni.** Una pagina o una mail aperta può contenere testo scritto per far fare qualcosa a Owni; il testo che accompagna la foto arriva recintato con un'etichetta casuale, e così le parole di un errore del demone, che possono citare lo schermo. Le descrizioni dei tool lo ripetono.
- **Anche senza internet, lo schermo arriva al server.** Su una rete Docker, interna o no, il server è il gateway: dal browser dello schermo si raggiungono la console e i webhook di Owni e ogni servizio del server in ascolto su tutte le interfacce (`0.0.0.0`). Owni lo scrive nel log all'avvio. Il codice non tocca il firewall del server: l'operatore tiene quei servizi su `127.0.0.1` o dietro un firewall (runbook 6n).

## Audit

Una riga per azione (`desktop.action` con il tipo: clic, scrittura, tasto, scorrimento, trascinamento, apertura), mai il testo scritto né l'indirizzo aperto: della scrittura resta solo quanti caratteri, dell'apertura se era un programma o un indirizzo. Gli errori del desktop vanno nel log dell'operatore; al modello arriva una frase semplice e nell'audit `desktop.failed`. Accensione e riavvio dalla console hanno le loro righe (`desktop.allowed`, `desktop.reset`).

## Ripetizioni dopo un crash

Come `web_click`: ogni azione gira dentro un passo durevole, quindi un'azione finita non si ripete quando la chiamata riparte dopo un crash. Un crash nel mezzo di un'azione può ripeterla (un clic in più, un testo scritto due volte). La foto dopo l'azione si rifà sempre: guardare non cambia niente.

Lo stesso vale per una connessione persa con il demone dello schermo Docker: una foto si chiede di nuovo dopo qualsiasi errore di rete (con lo schermo riavviato se serve); un'azione solo quando la connessione è stata rifiutata, cioè non è mai arrivata. Dopo una connessione caduta a metà l'azione non si ripete, perché potrebbe essere già successa.

## Limiti voluti

- Niente vista dal vivo nella console, e nemmeno l'ultima schermata visibile all'owner: l'owner non vede lo schermo mentre Owni lo usa. Il VNC c'è dentro il container, con la sua password, ma non è pubblicato.
- Niente file fra workspace e schermo: lo schermo non ha `/work`, e Cua non ha uno strumento per i file via MCP. Per i file c'è il computer.
- Solo amd64, perché così è l'immagine di Cua. `pnpm owni check` lo dice su un server ARM.
- In Owni Cloud lo schermo resta spento: una cella non ha il socket di Docker, e lo schermo remoto condiviso non va bene fra tenant diversi.
- Nella chat del brief del mattino i tool dello schermo non girano, come tutti i tool che non sono di sola lettura.

## Alternative scartate

- **L'SDK di Cua (Python) o il loro agente**: porterebbe un secondo runtime e un secondo modello dentro Owni. A noi serve solo il desktop: il modello resta quello dell'agente.
- **Il desktop nel computer di ADR 0013**: il computer non ha rete per scelta, e un desktop con Firefox ha senso proprio quando può averla. Due macchine diverse, accese separatamente dall'owner.
- **Il traffico dello schermo attraverso il fetch controllato della cella**, per tenere l'elenco dei siti: servirebbe un proxy per ogni schermo con TLS da ispezionare. Prima lo schermo spento di default e la scelta esplicita dell'operatore; un proxy si può aggiungere dopo.
- **Approvazione per ogni clic**: renderebbe lo schermo inutilizzabile, e un clic da solo non dice cosa invia.
- **Porte pubblicate sul server** per raggiungere il demone: con una rete interna Docker non funzionano, e con una normale esporrebbero il demone e il VNC fuori da Docker.

## Conseguenze

- Come per il computer, il processo di Owni che usa il socket di Docker equivale a root sul server: lo schermo Docker va acceso solo dove Owni è l'unico servizio.
- Owni deve raggiungere l'indirizzo del container sulla rete degli schermi. Owni installata direttamente sul server Linux lo raggiunge. Owni in Docker Compose usa la rete del server (`network_mode: host`, runbook 6n): così la rete degli schermi resta con il traffico fra container spento. Mettere il container di Owni sulla rete degli schermi chiederebbe di accendere quel traffico, e l'isolamento fra gli schermi sarebbe perso.
- Con internet, lo schermo raggiunge anche la rete locale e le porte del server aperte su tutte le interfacce. L'operatore che lo accende lo sa, e il runbook lo ripete.
- Da provare dal vivo, su un server amd64 con Docker vero:
  - l'avvio dell'immagine con le sole capability `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `KILL`, con un init davanti e senza escalation di privilegi (se l'immagine usa `sudo`, è la prima cosa da rivedere), e Firefox con il suo sandbox;
  - il tempo di avvio;
  - che il server raggiunga l'indirizzo del container su una rete interna con il traffico fra container spento;
  - che il demone 0.3.0 offra gli strumenti, accetti `scope: "desktop"` e mandi le dimensioni originali come previsto;
  - i nomi dei tasti (`Return`, `BackSpace`, `Page_Down`, `space`, `super`…) e delle combinazioni con `hotkey`.
