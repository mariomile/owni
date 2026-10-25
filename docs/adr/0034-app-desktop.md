# App desktop: una finestra su Owni, con Tauri

Owni si usa dal browser, dal telefono come app installata, da Telegram e WhatsApp. Sul computer una scheda del browser si perde tra le altre e non ha una scorciatoia per chiamarla. Mario vuole un'app desktop sul modello di Reflect, che ha appena pubblicato la sua app come open source ([team-reflect/reflect-open](https://github.com/team-reflect/reflect-open), MIT).

## Decisione

- **Tauri 2, come Reflect.** Una finestra nativa con la webview del sistema (WebKit su Mac e Linux, WebView2 su Windows), un binario Rust di pochi MB. Scartato GPUI (rifare tutta la console in Rust, crate prima della 1.0, accessibilità debole) e Electron (un Chromium intero per mostrare una pagina).
- **La console è quella del server.** L'app apre l'indirizzo del server Owni della persona (il suo o Owni Cloud) e mostra la console che già c'è: ogni funzione nuova arriva anche sul desktop, senza una seconda interfaccia da tenere allineata. Il server resta il posto dei dati, delle chiavi e dei modelli.
- **Quello che il browser non fa.** Icona nella barra (o nella barra dei menu sul Mac) con Apri, Nuova chat, Cambia server, Esci; una scorciatoia da qualsiasi app (Ctrl+Shift+Spazio, ⌘⇧Spazio sul Mac); chiudere la finestra la nasconde e Owni resta pronta; una sola copia aperta; la finestra ricorda posizione e dimensioni. Da Reflect: finestra creata nascosta e mostrata quando è pronta, plugin single-instance e window-state, installer da una GitHub Action.
- **La prima volta** una pagina dentro l'app chiede l'indirizzo, o il link personale (`/login#…`) che entra subito. L'app controlla che a quell'indirizzo risponda un Owni (`/healthz`) prima di ricordarlo.

## Sicurezza

- Le pagine del server non hanno accesso all'app: Tauri non dà IPC ai contenuti remoti se nessuna capability li nomina, e nessuna lo fa. Solo la pagina di collegamento, che è nell'app, chiama i comandi `connect`, `state` e `use_local`.
- Nella finestra restano solo le pagine di quel server (stesso schema, host e porta). Un link altrove si apre nel browser; `file://` e gli schemi sconosciuti non si aprono.
- http solo verso questo computer (`localhost`, `127.0.0.1`): altrimenti il cookie di sessione viaggerebbe in chiaro. Indirizzi con utente e password sono rifiutati.
- L'app ricorda solo l'indirizzo del server, in un file nella cartella di configurazione. La sessione è il cookie della webview, come nel browser.

## Alternative scartate

- **Il server dentro l'app** (Node come sidecar, come il sidecar di Reflect). Owni è multi-persona, con canali, task programmati e chiavi che devono restare accesi quando il portatile dorme: il posto è un server. Si può aggiungere per chi vuole provare in locale. Aggiunto sul Mac: [ADR 0096](0096-owni-dentro-l-app-per-mac.md).
- **Una console scritta per il desktop.** Raddoppia il lavoro a ogni funzione.

## Conseguenze

- Gli installer escono dal workflow «Desktop app» come bozza di release, per ora non firmati: macOS avvisa al primo avvio e Windows mostra SmartScreen. Per firmarli servono il certificato Apple Developer (con notarizzazione) e uno per Windows, nei segreti del repository; poi si accendono gli aggiornamenti automatici (plugin updater con chiave minisign, come Reflect).
- Prossimi passi: notifiche native quando Owni risponde con la finestra nascosta, link `owni://` per aprire un link personale, avvio al login.
