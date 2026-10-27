# Notizie: i titoli dai feed dei giornali

> Sostituito dall'[ADR 0127](0127-niente-squadre-pronte-ne-strumenti-per-cose-che-l-agente-fa-gia.md): lo strumento `news_headlines` e `OWNI_NEWS` non ci sono più; le notizie si cercano e si leggono con `web_search` e `web_read`.

Il vantaggio di Grok è sapere cosa succede adesso. Owni rispondeva a «che notizie ci sono oggi?» solo con la ricerca sul web, quando c'era una chiave Brave, e senza un ordine per ora né una fonte chiara.

## Decisione

Un tool, `news_headlines`, che legge i feed RSS e Atom pubblici di giornali scelti dall'operatore, senza chiave.

- **Cosa fa.**
  - I titoli delle ultime 24 ore (fino a 72), oppure di oggi o di ieri (`day`), dal più recente, ciascuno con fonte, ora («alle 14:32», «ieri alle 9:10») e link.
  - Filtri: `topic` (parole cercate in titoli e sommari, con sinonimi separati da `|`), `source` (un giornale, anche per prefisso: «ansa», «il post»), `section` (ultima ora, italia, politica, mondo, economia, tecnologia, sport), `limit` fino a 20.
  - `list` mostra fonti e sezioni.
  - Lo stesso titolo o lo stesso link da più feed compare una volta sola.
- **Senza filtri** legge solo i feed «ultima ora» e «italia», così la prima risposta sono le notizie principali italiane e non lo sport o la BBC.
- **Il topic resta sul server.** I feed si scaricano interi e si filtrano in memoria: nessuna parola di chi scrive arriva a un giornale. Le parole si confrontano senza accenti né maiuscole, con una radice per singolari e plurali (banca e banche, treno e treni) che non allarga troppo (governo non trova governatore). «Oggi», «notizie», «ultime» e simili non sono un topic.
- **Fonti.** Una lista di partenza (ANSA per sezione, Rai News, Sky TG24, Corriere della Sera, la Repubblica, Il Post, Il Sole 24 Ore, BBC per mondo e tecnologia) che l'operatore sostituisce con `OWNI_NEWS_FEEDS` (fino a 30 feed, nome, indirizzo https e sezione).
- **Prima dei feed, non la ricerca.** Le istruzioni dicono di usare `news_headlines` per le notizie e `web_search` solo per ciò che i feed non coprono (un giornale che non c'è, un fatto più vecchio di 72 ore); per aprire un articolo c'è `web_read`.
- **Brief.** Se la persona ha chiesto le notizie nel brief (Owni lo salva in memoria), il brief del mattino aggiunge tre titoli delle ultime 12 ore. Il tool è consentito nella chat del brief perché scarica solo indirizzi fissati dall'operatore.
- **Acceso dall'operatore** con `OWNI_NEWS=1`, come meteo e cambi (ADR 0039, 0040). `pnpm owni check` prova ogni feed e avvisa per nome di quelli che non vanno; fallisce solo se non risponde nessuno.

## Limiti

- 2 MB e 100 titoli per feed, 6 secondi per feed, 8 secondi in tutto per una risposta: i feed in ritardo continuano a scaricarsi e Owni dice che arriveranno fra poco.
- Ogni feed resta in memoria 10 minuti, un errore 2 minuti; 4 download alla volta.
- Si mostrano solo titoli con una data valida (RFC 822 o ISO 8601, anche con mesi e giorni in italiano); una data nel futuro vale come il momento in cui Owni ha visto la notizia la prima volta (oltre un giorno avanti non vale), così un feed non resta in cima per sempre; una data senza ora vale per quel giorno.

## Sicurezza

- I feed sono letti con scansioni lineari, senza librerie XML né DTD: CDATA, entità (da una `Map`, non dal prototipo), blocchi script e style, caratteri invisibili e di direzione tolti. Le funzioni sul testo HTML sono condivise con `web_read` in `src/core/html-text.ts`.
- Tutto il testo dei feed arriva al modello dentro il recinto dei dati non fidati. Fuori ci sono solo i nomi delle fonti dati dall'operatore e frasi fisse.
- Link solo http(s), senza credenziali; un link relativo si risolve sull'indirizzo del feed senza query né frammento, così un token nell'indirizzo non finisce in chat. Il tool non apre mai i link che mostra.
- Redirect: al massimo 3, solo https sulla porta 443, solo verso indirizzi pubblici (gli stessi controlli di `web_read`). Resta il caso di un nome che cambia indirizzo tra il controllo e la connessione: i feed sono scelti dall'operatore, e il rischio è accettato.
- Una risposta che non è RSS, RDF o Atom non vale. L'indirizzo di un feed non compare mai in chat, nei log o nel check: solo il nome.
- Nessun audit: non esce niente di chi scrive e non cambia niente.
- Le funzioni condivise decodificano più entità nel testo di `web_read`: le sentinelle salvano una versione del testo, e una istantanea di una versione precedente si aggiorna in silenzio invece di dare un falso «la pagina è cambiata».

## Alternative scartate

- **Un'API di notizie** (NewsAPI, GNews e simili): chiave, costi e condizioni d'uso, per titoli che i giornali danno già nei feed.
- **Solo la ricerca sul web**: serve una chiave, non dà l'ordine per ora e manda fuori le parole di chi scrive.
- **Google News RSS**: comodo ma non pensato per l'uso automatico, con titoli riscritti e link di reindirizzamento.
- **Mandare il topic ai feed** (ricerche dei giornali): esporrebbe le domande di chi scrive ai siti.
