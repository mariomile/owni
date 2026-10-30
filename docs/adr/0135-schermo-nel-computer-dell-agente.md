# 0135: Lo schermo sta nel computer dell'agente

Mario (28 ottobre 2026): «fai come raccomandato. Vedi come fa openbot». La raccomandazione era una macchina per agente, come Grok Bot: comandi, browser, file e accessi nello stesso posto, che restano. Finora un agente aveva due macchine diverse. Il computer (ADR 0013, 0015) eseguiva i comandi su Docker o su Fly. Lo schermo (ADR 0045) era un desktop di Cua in un altro container, solo su un host Docker, mai in una cella di Owni Cloud. Un file scaricato dal browser dello schermo non arrivava ai comandi, e in Owni Cloud lo schermo non c'era.

OpenBot (nightly-labs/openbot, licenza PolyForm Noncommercial: ne prendiamo le idee, non il codice) ha una macchina per server con un browser vero e un profilo che resta per ogni agente, che salva i login. Prendiamo il profilo che resta e il browser vero. La macchina invece resta una per agente, come il computer di oggi.

## Decisione

- **Lo schermo è il computer.** `ComputerProvider` ha `screen(key, tool, args)`. Nella stessa macchina dei comandi, Docker o Fly, gira uno schermo virtuale (Xvfb, 1280×800) con Chromium. Le azioni passano per `xdotool`, le foto dello schermo per ImageMagick. In Owni Cloud passa per il control plane (`/internal/computer/screen`), con gli stessi controlli per tenant degli altri endpoint e al più due azioni sullo schermo insieme per tenant. Così lo schermo c'è dovunque ci sia il computer: in locale, su un server e in Owni Cloud.
- **Gli strumenti restano quelli.** `ComputerDesktopProvider` è un `DesktopProvider` sopra il computer. I `desktop_*`, la vista dal vivo (ADR 0067) e l'interruttore «Schermo» dell'agente non cambiano. Lo schermo si accende da solo quando c'è un computer; `OWNI_DESKTOP` serve solo per `local`, il Computer Use del Mac, che resta una funzione a parte.
- **Solo il browser.** Niente desktop XFCE e niente altre app: `desktop_open` apre Chromium o un indirizzo. Per file, dati e programmi c'è `computer_run`, nella stessa macchina.
- **Login che restano.** Il profilo di Chromium sta in `/screen`, che resta come `/work`. Su Docker è un secondo volume, su Fly una cartella dello stesso volume, montata a parte. Chi resetta il computer resetta anche i login.
- **I comandi non leggono i cookie.** Lo schermo gira come uid 1001 (`owni-screen`), i comandi come uid 1000. `/screen` è 0700 di 1001, e la pulizia dopo ogni comando (`kill -9 -1` come 1000) non tocca il browser. Un comando non può leggere il profilo, non può fermare Chromium e non può guardarlo: X vuole un cookie che sta in `/screen`. La cartella dei socket di X (`/tmp/.X11-unix`) la crea root all'avvio, con lo sticky bit: un comando non può mettere un suo socket al posto di quello dello schermo. Lo schermo ci si rifiuta di partire se la trova di un altro.
- **I comandi non mettono codice nello schermo o in root.** I comandi possono scrivere in `/work/.local`, che è nel loro PATH e nella loro cartella dei pacchetti Python. Lo schermo e le chiamate di root partono quindi con un PATH di sistema fisso (`/usr/local/bin:/usr/bin:/bin`) e con `/usr/bin/python3 -I`, che ignora i pacchetti dell'utente e le variabili `PYTHON*`. Gli eseguibili interni hanno percorsi assoluti. Un `python3` o un `.pth` lasciati da un comando girano solo per i comandi.
- **File dentro e fuori solo da `/work`.** Su Docker l'API degli archivi segue i collegamenti a metà percorso: con `/work/s -> /screen` si leggerebbe il profilo. Prima di ogni `get` e `put` il provider percorre la strada come uid 1000 senza seguire collegamenti (`owni-run stat`) e rifiuta se ne trova uno. Resta una finestra tra il controllo e l'archivio in cui 1001 potrebbe mettere un collegamento: l'accettiamo, perché 1001 è il browser, che ha già il profilo e `/work`.
- **Un solo schermo per volta.** Le azioni sullo schermo prendono un lock (`flock` su un file di 1001): due azioni insieme alla prima accensione aprono un solo Xvfb e un solo Chromium.
- **Il browser lo configura root.** Una policy gestita (`/etc/chromium/policies/managed/owni.json`) scarica in `/work/Downloads` senza chiedere, blocca le pagine `file://` (il profilo e i cookie sono file) e toglie gli strumenti per sviluppatori. 1001 non la può cambiare.
- **I download arrivano ai comandi.** Chromium scarica in `/work/Downloads`. 1001 è nel gruppo 1000, e `/work` ha i permessi del gruppo (775). I file scaricati si leggono con `computer_run` e si mandano alla persona con gli strumenti di sempre. Così 1001 può anche scrivere in `/work/.local/bin`, che è nel PATH dei comandi: lo accettiamo, perché 1001 ha già tutto `/work`.
- **Le stesse regole di rete.** Le regole di uscita (ADR 0124) valgono per tutta la macchina, quindi anche per il browser: internet pubblico sì, indirizzi privati e metadati del cloud no. Su Fly anche il browser ha il filtro seccomp dei comandi: niente vsock, niente socket di pacchetti, niente io_uring, niente user namespace.
- **Più memoria.** Chromium ne usa parecchia: il default del computer passa da 1024 a 2048 MB, su Docker e su Fly. `/dev/shm` è di 512 MB. Il limite di processi del container passa da 128 a 512, perché Chromium conta i suoi thread. Il limite dei comandi resta 128. Su Fly il volume ha un GB in più per il profilo e la cache del browser (cache massima 100 MB). `/screen` non ha una quota sua: la quota del disco conta solo `/work`.

## Cosa resta fuori dalle regole del resto di Owni

Restano dall'ADR 0045, e la descrizione degli strumenti continua a dirle al modello:

- Il browser dello schermo non segue l'elenco dei siti consentiti dell'agente. Raggiunge tutto internet pubblico.
- Le azioni sullo schermo non chiedono approvazione: prima di inviare, comprare o accettare, l'agente chiede in chat.
- Chromium gira con `--no-sandbox`. La sandbox di Chromium vuole gli user namespace, che su Fly sono chiusi per tutti. La sandbox vera è la macchina: un container senza capability o una micro-VM, con la rete chiusa verso il privato. Una pagina che rompe Chromium si trova con i permessi di 1001: il profilo di quell'agente, i download, internet pubblico. Niente comandi da root, niente API di Fly, niente altri agenti.
- I login sono quelli che l'agente fa sullo schermo. Owni non gli passa password. Un modo per dare un segreto allo schermo senza che passi dal modello (come `submit_secret` di OpenBot) è un passo successivo.

## Alternative scartate

- **Chromium headless pilotato con CDP** (come OpenBot). Toglie X, ma il modello non vede la barra degli indirizzi, le schede e le finestre di dialogo, e i tasti vanno tradotti da keysym X a eventi CDP. Serve anche un demone che tenga la pipe di CDP: con una porta di debug, un comando potrebbe pilotare il browser. Più codice per vedere meno. Gli strumenti semantici sul DOM (riferimenti agli elementi, come `web_browse`) si possono aggiungere dopo, nella stessa macchina.
- **Tenere Cua accanto al computer.** Due container per agente, due cicli di vita, due reset, e niente Owni Cloud. Il desktop XFCE serviva a poche cose che il computer già fa.
- **Browser come uid 1000.** Più semplice, ma un comando potrebbe leggere i cookie, mandarli fuori, o restare vivo dentro Chromium dopo la pulizia.

## Conseguenze

- Cua esce dal codice: `docker-desktop.ts`, `remote-desktop.ts`, `mcp-client.ts`, `spaces.ts`, `OWNI_DESKTOP=docker|remote`, `OWNI_DESKTOP_NETWORK`, `OWNI_DESKTOP_URL`, `OWNI_DESKTOP_TOKEN`. Le installazioni che li avevano devono toglierli: Owni non parte finché ci sono, e il messaggio dice perché.
- L'immagine del computer cresce di circa 400 MB (Chromium, Xvfb, font). Il primo avvio su Fly scarica di più.
- Su Fly il volume si monta in `/data`, e `owni-fly-init` monta `/data/work` su `/work` e `/data/screen` su `/screen`. Le macchine Fly create prima avevano i file nella radice del volume. Il test dal vivo su Fly non era ancora stato fatto, quindi non c'erano computer Fly in uso da spostare.
- Su Docker un volume che c'era già ha `/work` a 755: al primo avvio il provider lo passa a 775. Se non ci riesce il computer non parte, e il log dell'operatore dice perché.
- Sostituisce l'ADR 0045. Aggiorna 0013 e 0015 (la macchina porta anche lo schermo), 0067 (la vista dal vivo viene dal computer) e 0124 (le regole di rete valgono anche per il browser).
