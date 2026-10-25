# La console in un modulo per pagina

Tutto il front end della console stava in un solo file, `src/web/ui/app.js`, di circa 5.900 righe. Ogni modifica a una pagina toccava lo stesso file e rendeva difficile trovare le cose e rivedere le PR.

## Decisione

- **Un modulo ES per pagina.** `app.js` resta il punto d'ingresso e avvia l'app. Le pagine sono in `src/web/ui/pages/` (chat, board, impostazioni, e così via); le parti della console che non sono una pagina (`shell.js`, `login.js`, `account.js`, `palette.js`, `pwa.js`, `listen.js`, `session.js`) stanno accanto a `app.js`.
- **Un modulo comune che non importa nulla.** `common.js` tiene gli strumenti usati da tutti: costruzione del DOM, client API, stato, percorsi, volti degli agenti. Quando una chiamata riceve 401, `api()` emette l'evento `owni:unauthorized` e `session.js` mostra il login.
- **Le parti condivise stanno fuori dalle pagine.** Il menu dei comandi (`commands.js`), le schede delle azioni (`cards.js`), i modelli (`models.js`), la sezione Google (`google.js`), il ritorno dai connettori (`signin.js`), i passi di «Primi passi» (`setup.js`) e i toni (`tones.js`) sono moduli a sé; `copyBox` sta in `listen.js`.
- **Una tabella delle pagine.** `PAGES` in `shell.js` ha una riga per pagina (id, etichetta, gruppo, funzione della pagina, se sta nella barra laterale) e la usano la shell e la palette dei comandi.
- **Nessun cambio di comportamento.** Il codice è stato spostato così com'è: cambiano solo le righe `import` in testa e `export` davanti a quello che altre pagine usano.
- **Nessun passaggio di build e nessuna dipendenza.** La pagina caricava già `app.js` come `type="module"`, quindi il browser carica i moduli da solo.
- **Il server serve ogni file.** All'avvio `src/web/server.ts` elenca la cartella della UI e serve ogni file di un tipo noto al suo percorso: nessun elenco da tenere. Gli script sono serviti con `no-cache`, così i moduli di un deploy non si mescolano con quelli vecchi in cache. Il service worker (`sw.js`) non può elencare una cartella: tiene la sua lista `SHELL` e la sua cache passa a `owni-shell-v5`.

## Conseguenze

- **Regola sugli import:** solo `shell.js` importa da `pages/`, e le pagine non si importano a vicenda. Una parte usata da più pagine va in un modulo accanto a `app.js`. Il test `test/console-ui.test.ts` fallisce se la regola è violata, se `common.js` importa qualcosa o se uno script manca in `SHELL`.
- **Aggiungere una pagina:** il file in `pages/`, una riga in `PAGES` (`shell.js`) e una riga in `SHELL` (`sw.js`, con il numero della cache alzato). Il server la serve da solo e il test controlla `SHELL`.
- Il primo caricamento fa più richieste (un file per modulo invece di uno), tutte dalla stessa origine; gli script si ricontrollano a ogni visita (`no-cache`), quindi costano una richiesta condizionale ciascuno.
- I cicli rimasti sono solo tra la shell e il codice di avvio (`shell.js`, `session.js`, `login.js`, `palette.js`, `pwa.js`): valgono per funzioni chiamate dopo il caricamento, non per codice eseguito all'import.
