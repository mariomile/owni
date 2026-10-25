# Settimana 25: Owni risponde a voce

Branch `week-25`. Decisione: [ADR 0020](adr/0020-risposte-a-voce.md). A chi le manda un vocale su Telegram o WhatsApp, Owni risponde con un vocale e con il testo; ognuno può chiederle «rispondimi sempre a voce» o «niente vocali». Nella console ogni risposta ha «Ascolta», con la voce del dispositivo. Serve `OWNI_SPEECH_API_KEY` ([chiavi](chiavi.md) §14); i test usano un servizio finto.

## Cosa funziona (verificato dai test)

- **Il servizio** (`test/speech.test.ts`): chiede Opus con il testo da dire, senza markdown, codice e indirizzi; manda lo stile quando c'è; rifiuta ciò che non è OGG Opus (anche OGG Vorbis), un audio vuoto, uno troppo grande sia dichiarato sia in arrivo senza lunghezza; negli errori né la chiave né il testo. Di una risposta lunga legge le prime frasi e dice che il resto è scritto. Tabelle, elenchi, titoli e citazioni diventano frasi.
- **In un'istanza, da Telegram**: spento finché l'owner non lo accende, e allora il servizio non riceve niente; acceso, un vocale ha un vocale con il testo in didascalia e il modello sa che sarà letto; un messaggio scritto ha il testo; quello che Owni manda da sola (un promemoria) resta scritto; «sempre», «mai» e «auto» con `voice_replies`; servizio giù: il testo; Telegram occupato sul vocale: il nuovo tentativo manda solo il testo e l'audio non si rifà; in un gruppo, il testo.
- **Canali**: Telegram mette il testo in didascalia fino a 1024 caratteri, poi a parte; chi non accetta vocali riceve il testo. WhatsApp manda l'audio e poi il testo; fuori dalla finestra di 24 ore solo il testo, in attesa; un audio rifiutato da Meta lascia il testo.
- **Configurazione e controllo**: tutte e due le variabili o nessuna; https; modello e voce di OpenAI di default, obbligatori per altri servizi; limiti su caratteri e vocali al giorno; `pnpm owni check` controlla la chiave senza produrre audio. Le preferenze di ogni persona restano dopo un riavvio.
- **Console** (Chromium, nessun errore): la scheda Risposte a voce dice a chi va il testo, e chiede di accendere prima Messaggi vocali; «Ascolta» legge con una voce locale del dispositivo, in italiano.

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Alta.** Un vocale rifiutato dal canale faceva perdere anche il testo. Un nuovo tentativo rifaceva e rimandava il vocale. Il modello non sapeva che la risposta sarebbe stata letta, e prometteva vocali che non poteva mandare. Nessuno poteva chiedere vocali o smettere. Rispondeva a voce anche quando non aveva capito il vocale («non riesco ad ascoltarti», detto a voce).
- **Media.** Per 30 minuti ogni messaggio verso quella chat veniva letto, anche promemoria, brief del mattino e approvazioni; un vocale in un gruppo cambiava le risposte per tutti. Nessun tetto alla spesa. «Ascolta» poteva usare una voce online del browser, non si fermava cambiando pagina, non mostrava che stava leggendo e tagliava i testi lunghi. Le risposte lunghe passavano al testo senza dirlo. Nessun segno che Owni stesse registrando. Il controllo accettava qualsiasi OGG e leggeva tutto l'audio prima di misurarlo. ADR mancante. Nessuna menzione nei Primi passi.
- **Bassa.** Una canzone inoltrata su Telegram contava come vocale. Il testo d'errore del servizio finiva nei log. `pnpm owni check` diceva verificati modello e voce. Commento spostato su `voiceCard`, campo inutilizzato, testi della scheda.

Lasciati e scritti nell'ADR: una voce per tutto il server; dopo un riavvio le risposte in sospeso vanno per iscritto; nessuna modalità vocale in tempo reale nella console.

## Limiti

| Cosa | Limite |
|---|---|
| Testo letto | 1500 caratteri (`OWNI_SPEECH_MAX_CHARS`), poi le prime frasi |
| Vocali al giorno | 300 per server (`OWNI_SPEECH_MAX_PER_DAY`) |
| Attesa del servizio | 20 secondi, poi il testo da solo |
| Audio accettato | OGG Opus, 5 MB |
| Dove | Telegram e WhatsApp, chat private |
