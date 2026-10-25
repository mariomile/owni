# Settimana 43: notizie

Branch `week-43`. Grok sa cosa succede adesso; Owni no, se non con la ricerca sul web. Ora `news_headlines` legge i feed dei giornali (ANSA, Rai News, Sky TG24, Corriere, Repubblica, Il Post, Il Sole 24 Ore, BBC) e risponde con i titoli recenti, ciascuno con fonte, ora e link, senza chiave. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0043](adr/0043-notizie.md).

## Cosa cambia per chi usa Owni

- **«Che notizie ci sono oggi?»**: i titoli principali italiani, dal più recente, con fonte e ora.
- **«Novità su Stellantis?»**: solo i titoli che ne parlano, con il sommario.
- **«C'è qualcosa sul terremoto?»**: Owni cerca anche i sinonimi (terremoto, sisma, scossa).
- **«Le ultime di economia»**, **«cosa dice il Post sulle elezioni?»**: per sezione o per giornale.
- **«Notizie di ieri sul governo»**: solo quelle di ieri.
- **Un articolo**: Owni lo apre con `web_read`, se la persona vuole leggerlo.
- **Il brief del mattino**: tre titoli delle ultime 12 ore, per chi lo chiede.

## Cosa funziona (verificato dai test)

- Lettura di RSS 2.0, RDF e Atom: CDATA, entità, HTML scritto due volte, script, link relativi e guid, date in inglese e in italiano con i fusi; input ostili da 2 MB letti in tempo lineare (`test/news.test.ts`).
- Sicurezza: redirect verso indirizzi interni, http o porte strane rifiutati; un token nell'indirizzo del feed non compare nei link; caratteri invisibili tolti; `&constructor;` resta testo.
- Filtri: topic senza accenti, singolari e plurali, sinonimi con `|`, parole vuote ignorate, fonte per prefisso, sezione, oggi e ieri nel fuso di Owni, limiti.
- Cache, un solo download per richieste insieme, un feed rotto che non ferma gli altri, scadenza di 8 secondi con i feed in ritardo nominati.
- Configurazione, check con avviso per i feed che non vanno, tool assente quando è spento, consentito nel brief.

## Revisioni

Prima revisione (sicurezza e risposte), corretta:

- Redirect seguiti ovunque: ora solo https verso indirizzi pubblici, al massimo 3.
- Un link «#a» mostrava l'indirizzo del feed con la sua query: ora si risolve senza query.
- Caratteri invisibili, entità dal prototipo, testo prima di uno script tagliato male con «İ», «spread >150» mangiato, guid non URL presi per link, date in italiano: corretti.
- «Notizie di ieri» non si poteva chiedere: c'è `day`.
- Il modello usava ancora `web_search` per le notizie: le istruzioni ora mettono prima i feed.
- Sinonimi, plurali, notizie principali italiane per prime, i grandi giornali italiani nella lista, il brief con tre titoli di oggi, risposte vuote più utili, scadenza di 8 secondi.

Seconda revisione, corretta:

- Le entità decodificate in più avrebbero fatto scattare una volta le sentinelle esistenti: ora le istantanee hanno una versione e si aggiornano in silenzio.
- Radici più strette: pace non trova più «pacco», casa non trova «caso», mare non trova «Mario».
- Un feed con date nel futuro non resta in cima: vale la prima volta che Owni vede la notizia.
- Date senza ora contate nel giorno giusto, fusi sconosciuti come UTC, feed lenti detti lenti e non rotti, il brief sulle ultime 12 ore, il check che avvisa anche dei feed senza notizie datate.

## Da fare

- Provare gli indirizzi dei feed con `pnpm owni check` su un server con rete: da qui il proxy blocca i siti dei giornali.
