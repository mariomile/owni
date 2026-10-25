# App desktop

Owni come app per Mac, Windows e Linux: una finestra sul tuo server Owni, l'icona nella barra e una scorciatoia per chiamarla da qualsiasi app. Perché e come è fatta: [ADR 0034](adr/0034-app-desktop.md).

## Owni sul Mac

L'app per Mac porta Owni con sé ([ADR 0096](adr/0096-owni-dentro-l-app-per-mac.md)): al primo avvio la accende su questo computer ed entra da sola. Riconosce gli abbonamenti già collegati alle CLI ufficiali di Claude Code e Codex. Puoi anche scegliere un provider con una chiave API in «Impostazioni → Provider». I dati restano in `~/Library/Application Support/app.owni.desktop/data`; se qualcosa non parte, il registro è in `~/Library/Logs/app.owni.desktop/server.log`.

L'app non è ancora firmata. La prima volta: trascina Owni in Applicazioni, poi tasto destro sull'icona, **Apri**, e ancora **Apri**. Se macOS non mostra il pulsante, vai in Impostazioni di Sistema, Privacy e sicurezza, e premi **Apri comunque** accanto a Owni.

## Provider AI e abbonamenti

Sul Mac, Owni usa le CLI ufficiali `claude` e `codex` installate sul computer. All'avvio controlla il loro accesso e collega gli abbonamenti già autenticati; solo la prima volta, se l'agente usa ancora il modello di prova, sceglie il primo disponibile. Le scelte successive del modello e le disconnessioni restano salvate.

In **Impostazioni → Provider**, **Collega** avvia l'accesso ufficiale nel browser. La CLI deve essere già installata; se il browser non si apre, puoi accedere dal Terminale con `claude auth login` oppure `codex login`, poi premere **Rileva provider**. **Scollega** toglie a Owni l'accesso al provider senza disconnettere la CLI dalle altre app. Prima di scollegare un provider usato da un agente, scegli un altro modello per quell'agente.

Claude Code usa gli alias Sonnet, Opus e Haiku. Per Codex, **modello del tuo piano** usa il modello preferito del catalogo locale della CLI; se il catalogo non esiste ancora, usa GPT-5.5. Restano disponibili anche le scelte GPT-5.5 e GPT-5.4, se comprese nel piano. Le risposte consumano i limiti dell'abbonamento; le chiavi API si gestiscono separatamente.

Owni non copia token o password dalle CLI. Il processo locale conserva solo le preferenze di connessione; l'autenticazione e il rinnovo dell'accesso restano delle CLI ufficiali. Gli strumenti di Owni continuano a passare dal suo motore durevole, dalle autorizzazioni e dalle approvazioni. Il provider riceve il contesto della chat e le immagini necessarie alla risposta, con un output strutturato per richiedere gli strumenti; le CLI non eseguono i propri strumenti. Le immagini e gli schemi temporanei vengono cancellati dopo ogni richiesta.

Per sviluppare il server con gli abbonamenti locali, imposta `OWNI_LOCAL_PROVIDERS=1`, `OWNI_MODEL_PROVIDER=faux` e `OWNI_MODEL_ID=owni-dev`: il modello di prova resta disponibile finché un abbonamento non è pronto, poi Owni lo seleziona automaticamente. Funziona solo su loopback (`127.0.0.1`, `localhost` o `::1`), senza `OWNI_PUBLIC_URL` e senza `OWNI_CELL_SECRET`, per il solo tenant configurato. Sui server remoti e nelle celle cloud il rilevamento è spento e gli account del computer che ospita il server non sono disponibili.

Riferimenti: [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [Claude Agent SDK con un piano Claude](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Codex CLI](https://developers.openai.com/codex/cli), [configurazione Codex](https://developers.openai.com/codex/config-reference).

## Usarla

### Computer Use su questo Mac

Su macOS 14 o successivo, **Impostazioni → Computer Use** mostra i permessi reali di **Registrazione schermo** e **Accessibilità**. Premi **Concedi** per aprire la richiesta e la sezione corretta delle Impostazioni di Sistema; dopo aver autorizzato Owni, premi **Controlla di nuovo**. macOS può chiedere di riaprire l'app.

Se l'interruttore di Owni è acceso in macOS ma l'app continua a mostrare **Da consentire**, chiudi Owni, rimuovi soltanto la sua voce dall'elenco dei permessi e aggiungi di nuovo `/Applications/Owni.app`, poi riaprila e premi **Controlla di nuovo**. Una build locale firmata ad hoc può lasciare un'autorizzazione associata alla vecchia firma: accendere l'interruttore della vecchia voce non basta. Il nuovo consenso va dato alla build attuale. In macOS 27 la sezione prima chiamata Accessibilità compare come **Device Control and Data Access**.

Il consenso **Consenti a Owni di usare questo Mac** è separato per ciascun agente ed è spento inizialmente. Un consenso già dato allo schermo remoto non abilita il Mac. Con Computer Use acceso, Owni può vedere lo schermo principale, cliccare, scrivere, premere tasti, scorrere, trascinare e aprire applicazioni. È il computer condiviso dell'utente: le azioni hanno effetto sulle app e sui file reali. Le schermate inviate al modello sono ridotte a un massimo di 1280 pixel sul lato lungo; le coordinate rispettano la scala Retina. Il consenso si può revocare dalla stessa pagina.

Owni non controlla tutte le app, nemmeno con il consenso acceso: un terminale (Terminale, iTerm2, Warp, Ghostty, kitty, Alacritty, WezTerm, cmux, Hyper, Tabby), un gestore di password (1Password, Bitwarden, Dashlane, Password, Accesso Portachiavi) o una richiesta di password di macOS. Se una di queste app è in primo piano, Owni non guarda lo schermo e non fa nessuna azione, e dice al modello quale app è. Se è dietro un'altra finestra, un clic, uno scorrimento o un trascinamento che la colpiscono sono rifiutati; mentre una richiesta di password di macOS è sullo schermo, Owni non scrive né preme tasti né usa il puntatore. Le foto non includono mai le finestre di queste app, e Owni non le apre. Un terminale aggirerebbe il computer isolato di Owni e le sue approvazioni; le password non devono passare dal modello. In quei casi l'app la usi tu. Non è un confine completo: editor con un terminale integrato, Script Editor e Comandi rapidi restano controllabili ([ADR 0107](adr/0107-app-che-computer-use-non-controlla.md)).

Il componente nativo non viene esposto quando l'app si collega a un altro server. Il server locale richiede `OWNI_LOCAL_PROVIDERS=1`, un indirizzo di ascolto loopback, nessun URL pubblico né cella cloud, `OWNI_DESKTOP=local` e il percorso assoluto del componente in `OWNI_LOCAL_DESKTOP_HELPER`. Questi valori sono impostati dall'app sul Mac; non occorre configurarli nei Settings.

Per ricostruire il componente senza dipendenze aggiuntive: `bash desktop/scripts/build-computer-helper.sh`. Lo script compila le versioni Apple Silicon, Intel e universale; la preparazione dell'app lo include accanto a Node. Windows, Linux e macOS precedenti alla versione 14 possono continuare a usare lo schermo remoto già supportato.

### Finestra e scorciatoie

1. Su Windows e Linux, al primo avvio scrivi l'indirizzo del tuo Owni (per esempio `owni.tuaazienda.it`), oppure incolla il tuo link personale per entrare subito. Sul Mac lo fai da «Cambia server…», se vuoi usare un server invece di Owni sul computer.
2. **Ctrl+Shift+Spazio** (⌘⇧Spazio sul Mac) la apre e la nasconde da qualsiasi app. Su Linux con Wayland le scorciatoie globali non arrivano alle app: lì si usa l'icona nella barra.
3. Chiudere la finestra la nasconde: Owni resta nella barra. Dall'icona: Apri Owni, Nuova chat, Cambia server, Esci. Sul Mac la riapre anche l'icona nel Dock.
4. I link che portano fuori da Owni si aprono nel browser. Una pagina di Owni aperta "in una nuova scheda" (un file, un documento) si apre in una seconda finestra dell'app.
5. I file scaricati vanno nella cartella Download, con un numero in fondo al nome se ce n'è già uno uguale.

## Svilupparla

Servono Rust (stable) e, su Linux, le librerie di WebKitGTK:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

```bash
pnpm start                        # un Owni locale, per esempio con OWNI_MODEL_PROVIDER=faux
cd desktop && pnpm install
pnpm dev                          # l'app; al primo avvio: localhost:8080 o il link di data/owner-login-link.txt
pnpm build                        # l'installer di questo sistema in src-tauri/target/release/bundle
cd src-tauri && cargo test        # i test di indirizzi, navigazione e impostazioni
```

La pagina di collegamento è in `desktop/connect/` (HTML, CSS e JS senza build, come la console). Il codice Rust è in `desktop/src-tauri/src/`:

- `server.rs`: legge l'indirizzo, decide cosa resta nella finestra, controlla `/healthz`;
- `settings.rs`: il file con l'indirizzo del server;
- `local.rs`: Owni su questo computer (avvio, attesa, accesso dell'owner, arresto);
- `update.rs`: gli aggiornamenti;
- `lib.rs`: finestra, icona, scorciatoia, comandi.

Le icone vengono da `src/web/ui/icon-512.png`: `pnpm icons` le rigenera.

## Installer

Il workflow **Desktop app** (a mano da GitHub Actions, o con un tag `desktop-v0.8.0`) costruisce gli installer per Mac (universale), Windows e Linux e li mette in una bozza di release. Per il Mac prima `desktop/scripts/bundle-server.sh` prepara Node e il server compilato, e controlla che partano; `--config src-tauri/tauri.local.conf.json` li mette nell'app.

### Aggiornamenti

L'app si aggiorna da sola. All'avvio e ogni sei ore chiede all'ultima release pubblicata su GitHub (`latest.json`) se c'è una versione più nuova; se c'è, lo dice in una finestra con **Installa e riavvia** e **Più tardi**. Installando, scarica il pacchetto, ne controlla la firma, sostituisce l'app, ferma il server di questo computer e riapre Owni: i dati restano dove sono. **Cerca aggiornamenti…** nel menu dell'icona controlla subito e dice anche quando l'app è già aggiornata.

La firma degli aggiornamenti è separata da quella di Apple. Il workflow firma i pacchetti con la chiave privata nel segreto `TAURI_SIGNING_PRIVATE_KEY` (senza password) e l'app accetta solo pacchetti firmati con la chiave pubblica scritta in `tauri.conf.json`. Senza quella chiave privata non si possono più pubblicare aggiornamenti per le app già installate: chi la perde deve far reinstallare l'app a mano. Una copia sta in `~/.tauri/owni-updater.key` sul Mac di chi l'ha creata.

Una release conta solo quando è pubblicata come ultima (la bozza del workflow non basta). Finché l'app per Mac non ha la firma Developer ID, ogni aggiornamento è per macOS un'app diversa: dopo l'aggiornamento vanno dati di nuovo i permessi di Computer Use.

### Firma

Per ora gli installer non sono firmati. Per firmarli si mettono nei segreti del repository e si passano come env al passo `tauri-action` del workflow: per il Mac `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` (account Apple Developer, 99 dollari l'anno); per Windows un certificato di firma del codice.

Per collaudare sul Mac una build locale creata con `--no-sign`, chiudi Owni e firma il bundle completo dopo l'ultima copia delle risorse:

```bash
bash desktop/scripts/sign-local-app.sh desktop/src-tauri/target/debug/bundle/macos/Owni.app
```

Lo script applica una firma ad hoc al componente Computer Use e all'app, conserva la firma originale di Node e verifica il bundle completo. Serve a dare a macOS l'identità dell'app per i permessi: un eseguibile firmato da solo, senza il bundle sigillato, può essere riconosciuto soltanto dal suo percorso. Questa firma locale non sostituisce la firma Developer ID e la notarizzazione per la distribuzione; una nuova compilazione può richiedere di concedere nuovamente i permessi. Dopo la firma non modificare le risorse del bundle.

Per conservare l'identità tra le compilazioni, imposta `OWNI_CODESIGN_IDENTITY` sull'identità **Apple Development** o **Developer ID Application** presente nel Portachiavi prima di eseguire lo script. Usa la stessa identità per le build successive: lo script firma con quel certificato sia il componente Computer Use sia l'app, mantenendo la firma originale di Node. Senza un certificato configurato resta attiva la firma ad hoc per il collaudo locale.
