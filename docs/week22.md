# Settimana 22: Owni cerca sul web

Branch `week-22`. Decisione: [ADR 0017](adr/0017-ricerca-sul-web.md). Owni cerca notizie, prezzi, orari e tutto quello che cambia con Brave Search, poi apre i risultati migliori e cita le fonti. Serve la chiave `OWNI_SEARCH_API_KEY` ([chiavi](chiavi.md) §13); l'owner accende la ricerca istanza per istanza.

## Cosa funziona (verificato dai test)

- **Il servizio** (`test/web-search.test.ts`): la chiave in un'intestazione, mai nei messaggi d'errore; Italia e italiano di default, un altro paese se il modello lo chiede; risultati recenti per giorno, settimana, mese o anno; titoli ed estratti senza tag; indirizzi non web scartati; chiave rifiutata, troppe ricerche, servizio fermo e risposte oltre 1 MB detti chiaramente.
- **Nell'istanza**: spenta finché l'owner non la accende, e nessuna ricerca esce; poi risultati con la data della ricerca, marcati come dati dal web, e fuori dalla recinzione quali `web_read` può aprire e quali siti mancano; solo l'owner la accende e la spegne; l'audit conta i risultati, non contiene né la ricerca né la chiave; un server senza chiave non la offre.
- **Tetto**: 200 ricerche al giorno per account, tutte le istanze insieme.
- **Impostazioni**: chiave, indirizzo, paese, lingua e tetto controllati all'avvio; le celle di Owni Cloud ricevono le stesse variabili; `pnpm owni check` prova una ricerca.
- **Console** (Chromium, nessun errore): la scheda «Ricerca sul web» accende la ricerca, dice cosa può aprire, e con un pulsante (e una conferma) consente tutti i siti pubblici.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** Nessun paese né lingua: risultati americani per domande italiane. Il modello non sapeva la data, quindi non poteva giudicare cosa è recente. Nessun test per le celle di Owni Cloud né per `pnpm owni check`.
- **Media.** Nessun tetto alle ricerche: un ciclo o un task sbagliato poteva consumare la quota dell'operatore. Le istruzioni non dicevano di cercare prima di rispondere su cose che cambiano. La risposta del servizio era letta tutta, senza limite. Un risultato poteva scrivere di sé «apribile» dentro la recinzione: ora lo si dice fuori. Il pulsante «tutti i siti» partiva senza conferma e da un elenco vecchio.
- **Bassa.** `OWNI_SEARCH_URL` controllato anche senza chiave; nomi degli eventi di audit diversi tra loro; descrizione del tool che prometteva un ordine per data; ADR e documentazione mancanti.

## Limiti

| Cosa | Limite |
|---|---|
| Risultati per ricerca | 10 (5 se il modello non dice) |
| Ricerche al giorno | 200 per account, contate dal processo |
| Pagine aperte | solo dai siti consentiti |
| Prova dal vivo | da fare con una chiave vera |
