# 0131: La shell offline è una release intera

Il service worker teneva la shell un file alla volta: ogni risposta arrivata online sostituiva la copia di quel file, sotto un nome di cache cambiato a mano (`owni-shell-v20`). Così in cache potevano convivere file di release diverse. Quando il server non risponde, la console offline li mescolava. Nell'app Mac 0.12.0 gli script nuovi disegnavano il link «Salta al contenuto» con un `app.css` più vecchio che non aveva il suo stile: il link diventava una colonna della griglia e la pagina finiva fuori dalla finestra.

## Decisione

- **Il nome della cache viene dai file.** Il server serve `sw.js` sostituendo `__SHELL_VERSION__` con un'impronta di tutti i file della UI (`versionOf` in `src/web/assets.ts`, dalle etag che calcola già). Se cambia un solo file, cambia `sw.js`: il browser installa un worker nuovo e il vecchio cancella la sua cache all'attivazione. Non c'è più un numero da cambiare a mano.
- **La shell si scarica intera all'installazione.** `addAll` chiede ogni file con `cache: "reload"`, saltando la cache HTTP del browser: tutti i file vengono dal server nello stesso momento, e `addAll` li salva tutti o nessuno.
- **Online non si tiene niente.** La rete viene prima e la sua risposta non viene messa in cache. Offline la pagina e i file arrivano solo dalla cache della release corrente (`cacheName: CACHE`).

## Conseguenze

- Offline la console è quella dell'ultima installazione del worker, mai un misto.
- Se il server cade a metà di un caricamento, i file già scaricati sono nuovi e gli altri vengono dalla shell intera. È un caso stretto; ricaricare lo risolve.
- L'impronta copre ogni file servito dalla cartella della UI, anche quelli fuori da `SHELL`: un cambio a un'icona reinstalla la shell. Costa un download della shell, non una correzione.
