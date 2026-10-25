# Owni dentro l'app per Mac

Mario vuole provare Owni scaricando un'app, senza installare Node, pnpm e il repository. L'app desktop (ADR 0034) era solo una finestra su un server che la persona doveva già avere. L'ADR 0034 lasciava aperta questa strada: «Si può aggiungere per chi vuole provare in locale».

## Decisione

- **L'app per Mac porta il suo server.** Nel bundle ci sono Node (universale, arm64 e x64 uniti con `lipo`, verificati con i checksum di nodejs.org), il server compilato con `tsc` (`dist/`, senza tsx a runtime) e i pacchetti di produzione. Li prepara `desktop/scripts/bundle-server.sh` nel workflow «Desktop app»; `tauri.local.conf.json` li aggiunge al bundle solo sul Mac. Windows e Linux restano una finestra su un server.
- **Al primo avvio parte da sola.** Senza un server salvato, l'app avvia Owni su `127.0.0.1` (porta 47821, o una libera se è occupata), con i dati nella sua cartella (`~/Library/Application Support/app.owni.desktop/data`) e il registro in `~/Library/Logs/app.owni.desktop/server.log`. Il modello all'inizio è quello di prova: «Primi passi» chiede il modello vero e la chiave, che resta nel server locale come per qualsiasi server.
- **Entra senza link.** Il server scrive il link dell'owner una volta sola (`owner-login-link.txt`) e chiede di cancellarlo. L'app tiene il token nella sua cartella di configurazione, leggibile solo dall'utente (0600), cancella il file e apre `/login#…` a ogni avvio.
- **Si ferma con l'app.** «Esci» ferma il server con SIGTERM, che chiude i file. Se l'app si chiude male, il server se ne accorge da solo: l'app gli tiene aperto lo stdin e `server-entry.mjs` si ferma quando lo stdin finisce, così la cartella dei dati non resta bloccata.
- **Si può ancora collegare un altro server.** «Cambia server…» apre la pagina di collegamento, che ora ha anche «Usa Owni su questo computer». Collegare un server ferma quello locale.

## Sicurezza

- Il server ascolta solo su `127.0.0.1`. Le sue pagine non hanno accesso all'app, come prima: nessuna capability le nomina.
- Il token dell'owner sta in un file 0600 nella cartella dell'utente, accanto ai dati che già sono suoi.

## Conseguenze

- L'app per Mac pesa di più (Node da solo è circa 100 MB per architettura).
- Non è firmata: al primo avvio macOS chiede conferma (tasto destro, Apri; o Impostazioni di Sistema, Privacy e sicurezza, Apri comunque). Con la firma Apple e la notarizzazione l'avviso sparisce.
- Owni locale vive finché il Mac è acceso e l'app aperta: task programmati e canali come Telegram si fermano quando il Mac dorme. Per tenerla sempre accesa resta il server (ADR 0034).
