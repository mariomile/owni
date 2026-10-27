# 0127: Niente squadre pronte né strumenti per cose che l'agente fa già

Dopo i 25 registri ([ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md)) e la segreteria ([ADR 0126](0126-togliere-la-segreteria-commerciale.md)), in Owni restavano due tipi di pezzi pronti per un mestiere o per una cosa sola.

- **Tre squadre già fatte** ([ADR 0068](0068-squadre-pronte.md)): Contenuti, Vendite e Amministrazione, con le istruzioni scritte da noi per un mestiere che non è quello di ogni cliente.
- **Cinque strumenti per cose che l'agente sa già fare**: le liste (`list_*`, [ADR 0038](0038-liste.md)), il calcolo delle date (`date_calc`, [ADR 0048](0048-date-e-scadenze.md)), i cambi della BCE (`exchange_rate`, [ADR 0040](0040-cambi.md)), i titoli dei giornali (`news_headlines`, [ADR 0043](0043-notizie.md)) e il meteo (`weather`, [ADR 0039](0039-meteo.md)). Erano circa 7 mila righe tra codice e test, con i loro archivi, tetti giornalieri, variabili d'ambiente (`OWNI_WEATHER`, `OWNI_EXCHANGE_RATES`, `OWNI_NEWS`), controlli in `pnpm owni check` e voci nella lista dei siti raggiungibili.

Tenerli costava in tre modi.

- **Contenuto già pronto in un prodotto generale.** Owni è un agente generale: quello che serve a un cliente sono istruzioni sue, connettori suoi e file suoi, non il catalogo che abbiamo immaginato noi.
- **Strumenti che un agente con `code_run`, il web e i file rifà da sé.** Una lista della spesa è un file di testo. Le date e le scadenze sono un programma di poche righe, e i conti dell'agente vengono già da `code_run`. I cambi e le notizie si trovano con `web_search` e `web_read`, il meteo con una pagina o un'API. Ogni strumento in più è schema che il modello legge a ogni richiesta, test da tenere in piedi e un servizio esterno da accendere e da pagare (Open-Meteo vuole un piano a pagamento per un uso aziendale).
- **Un modo solo di fare le cose, quello nostro.** Il calendario dei festivi, l'elenco dei giornali e le fasce del meteo erano scelte nostre. Chi vuole altro scrive un programma, cerca altrove o chiede a un collega.

## Decisione

Owni non ha squadre già fatte né strumenti che ripetono quello che l'agente fa con `code_run`, il web e i file del workspace.

- **Un agente si crea a mano** dal modulo «Nuovo agente», con i modelli di partenza che riempiono solo il modulo. Le squadre si fanno nell'organigramma ([ADR 0117](0117-organigramma-degli-agenti.md)): il titolare sceglie nome, scopo, chi ne fa parte e chi coordina.
- **Le liste sono file del workspace.** «Aggiungi latte e pane alla spesa» diventa una riga in un file; lo leggono e lo cambiano `file_*` e `code_run`. Le istruzioni di una persona (o una skill) dicono dove tenerli.
- **Le date e le scadenze le calcola `code_run`**: giorni, giorni lavorativi, scadenze a 30-60-90 giorni fine mese, età. Un programma Python con le sue regole, scritte nella skill del cliente se servono quelle di un contratto.
- **I cambi, le notizie e il meteo si cercano sul web** (`web_search`, `web_read`) o si chiamano come API con un connettore ([ADR 0116](0116-collegamenti-api-per-agente.md)). Il brief del mattino non li include più.
- **Non ci sono più** le variabili `OWNI_WEATHER*`, `OWNI_EXCHANGE_RATES*` e `OWNI_NEWS*`, le loro righe in `pnpm owni check` e i domini nella tabella delle chiavi.

## Cosa resta, e perché

Restano le cose che l'agente non può avere altrimenti.

- **`vat_check` e il controllo formale di partite IVA e codici fiscali** ([ADR 0047](0047-partita-iva.md)): il VIES è un servizio della Commissione europea con le sue regole e il suo tetto, e la cifra di controllo va fatta bene. Per questo restano anche gli aiuti di data e di formato che servono a `vat_check` e alla board (`italian-calendar.ts`, `italian-format.ts`), ridotti a quello che usano.
- **La lettura dei `.p7m`** ([ADR 0052](0052-fatture-elettroniche.md)): estrarre il documento da una busta firmata non si fa in un programma di poche righe.
- **Il catalogo dei connettori, i toni, la ricerca, le sentinelle, la voce, le registrazioni, `code_run` e le attività programmate**: sono capacità, non contenuto.

## Dati esistenti

Le liste già salvate (`lists.json` nella cartella di un'istanza) restano dove sono. Owni non le legge e non le cancella. Le squadre già create sono agenti e squadre dell'organigramma come le altre, e si cambiano o si tolgono nello stesso modo.

## Alternative scartate

- **Tenerli dietro un'opzione.** Il codice, i test e la documentazione resterebbero tutti, per funzioni che un agente con gli strumenti di base fa già.
- **Una skill pronta per ogni strumento tolto** («liste», «scadenze»). Rifarebbe lo strumento con un altro nome: la procedura vera cambia da cliente a cliente ([ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md)).
- **Togliere anche `vat_check`.** Senza VIES non si controlla se un numero è attivo, e la cifra di controllo scritta ogni volta a mano dall'agente è proprio l'errore che lo strumento evita.
- **Migrare le liste in file.** Sono dati di prova, in un formato pensato per uno strumento che sparisce.

## Conseguenze

- Il modello vede cinque schemi in meno a ogni richiesta e il sistema ha meno variabili da configurare per l'operatore.
- Una domanda come «quanti giorni lavorativi tra il 3 novembre e il 19 dicembre?» si risolve con `code_run`, e l'eval dell'agente la prova così.
- Chi vuole le notizie o il meteo nel brief del mattino lo scrive nelle istruzioni dell'agente; la lettura dal web non gira nel brief, che resta di sola lettura sui dati dell'azienda.
