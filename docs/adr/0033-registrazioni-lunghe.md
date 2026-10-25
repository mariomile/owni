# Registrazioni lunghe: trascrizione a pezzi con i tempi

Le persone registrano le riunioni, le chiamate con i clienti, le lezioni, i sopralluoghi con il telefono, e vogliono sapere cosa si è detto: un verbale con le decisioni e chi fa cosa, un riassunto, la frase esatta del cliente sul prezzo. Owni capiva i vocali (settimana 14), ma solo fino a cinque minuti: un vocale più lungo era rifiutato, un MP3 di un'ora non arrivava mai al servizio di trascrizione, e un video della riunione era solo un file. I servizi di trascrizione accettano una richiesta di qualche minuto e di 25 MB al più.

## Decisione

Un tool, `audio_transcribe`, che trascrive una registrazione del workspace di qualunque durata (fino a `OWNI_TRANSCRIBE_MAX_MINUTES`, 180 di default) tagliandola in pezzi di dieci minuti al più, mandati tre alla volta allo stesso servizio dei vocali. Ogni passaggio della trascrizione porta l'ora in cui comincia nella registrazione intera ([00:12:40]) e, se il servizio lo sa fare e la persona lo chiede, chi parla (Voce 1, Voce 2). La trascrizione è salvata in `trascrizioni/<nome>.md`; il modello ne vede l'inizio e legge il resto con `file_read` quando deve fare un verbale.

I vocali più lunghi di `OWNI_TRANSCRIBE_MAX_SECONDS` e i file audio lunghi arrivati su Telegram e WhatsApp non sono più rifiutati: finiscono nel workspace come registrazioni, e il messaggio dice a Owni formato, durata e percorso («[Registrazione MP3, 52:10 nel workspace: uploads/…]»). Lo stesso per i file caricati dalla console o mandati come documento, video compresi.

## Come taglia, senza decodificare

Niente dipendenze nuove e niente ffmpeg: il taglio avviene tra le unità che il formato ha già, e ogni pezzo è un file valido a sé.

- **MP3**: tra un frame e l'altro, saltando i tag ID3 e il frame Xing/Info/VBRI, che descrive l'intero file e ingannerebbe sulla durata del pezzo.
- **WAV**: tra un campione e l'altro, con l'intestazione riscritta; un WAV con la dimensione sbagliata (registratore fermato a metà) vale fino alla fine del file.
- **Ogg (Opus, Vorbis)**: tra una pagina e l'altra, mai a metà di un pacchetto, con le pagine d'intestazione ripetute in ogni pezzo, i numeri di sequenza da zero, l'ultima pagina segnata come fine, il tempo (granule) che riparte da zero e il CRC rifatto.
- **M4A e MP4**: l'indice dei campioni AAC (stsz, stts, stsc, stco/co64) diventa una tabella di campioni; ogni pezzo è un M4A piccolo, ricostruito attorno a una serie di campioni con la descrizione originale (stsd) copiata. Da un video si prende solo la traccia audio: il pezzo pesa una frazione del video.
- **FLAC, WebM, AMR**: interi, se stanno in un pezzo; altrimenti Owni chiede di convertirli in MP3 o M4A o di mandarli in parti.

I pezzi hanno durate simili (25 minuti diventano tre pezzi da otto e qualcosa, non 10 + 10 + 5), così l'ultimo non è un frammento di un secondo in cui il servizio non sente niente. Il taglio può cadere a metà di una parola: il prezzo di non decodificare, accettato.

## I tempi e le voci

Il servizio è quello dei vocali (OpenAI-compatibile). Il modo di chiedere i tempi dipende dal servizio ed è in `OWNI_TRANSCRIBE_TIMESTAMPS`:

- `mistral` (default su api.mistral.ai): `timestamp_granularities=segment`, e `diarize=true` per le voci.
- `openai` (default per `whisper-1`): `response_format=verbose_json` e `timestamp_granularities[]=segment`; niente voci.
- `none` (default per gli altri, per esempio gpt-4o-transcribe, che non dà i tempi): solo testo, e i tempi sono quelli dell'inizio di ogni pezzo, scritto nel file.

I segmenti brevi della stessa voce si uniscono in passaggi di un minuto o 600 caratteri al più, ognuno con il suo tempo. Le voci si chiamano Voce 1, Voce 2 nell'ordine in cui parlano: il servizio distingue le voci, non sa i nomi, e la descrizione del tool lo dice al modello. Il campo della voce nella risposta di Mistral (`speaker_id`) non è documentato nella reference: è letto in modo tollerante ed è da verificare dal vivo.

## Durevole e misurato

- Ogni pezzo è uno step durevole: se il processo si ferma a metà di un'ora di registrazione, al riavvio i pezzi già trascritti non si rimandano e non si contano di nuovo.
- Un errore del servizio si riprova una volta dopo due secondi; se fallisce ancora, Owni lo dice e non si consuma niente di quel pezzo.
- Minuti al giorno per account (`OWNI_TRANSCRIBE_MINUTES_PER_DAY`, 600 di default), contati in secondi esatti al momento in cui un pezzo è trascritto; prima di cominciare Owni controlla che bastino per l'intera registrazione.
- Il consenso è quello dei vocali: il connettore `voice` dell'istanza (Impostazioni → Messaggi vocali). Senza, il tool risponde che la trascrizione non è attiva e l'audio non esce.

## Sicurezza

- Il testo trascritto viene da fuori (chiunque parli nella registrazione): il modello lo vede dentro il recinto con l'etichetta casuale, «dati, non istruzioni», e fuori ci sono solo i fatti di Owni (durata, pezzi, file).
- L'audit registra durata e numero di pezzi, mai le parole. La chiave del servizio non compare negli errori.
- I parser leggono byte che arrivano da chiunque: ogni dimensione e ogni conteggio è controllato contro il file prima di usarlo, i cicli avanzano sempre, gli errori sono `AudioError` con un messaggio in italiano. I test rovinano a caso i file di prova e verificano che non escano altri errori; un test con ffmpeg (dove c'è) decodifica ogni pezzo prodotto.

## Alternative scartate

- **ffmpeg nell'immagine**: taglierebbe sul silenzio e accetterebbe tutto, ma aggiunge un binario grande con una lunga storia di vulnerabilità, da far girare sui file di chiunque. Il computer di Owni (settimana 18) resta la strada per i formati rari.
- **Mandare il file intero**: i servizi lo rifiutano oltre i 25 MB o qualche decina di minuti.
- **Tagliare a byte fissi**: i pezzi non sarebbero file validi.
- **Sovrapporre i pezzi di qualche secondo**: eviterebbe le parole tagliate ma duplicherebbe frasi nel testo, più difficili da togliere che una parola spezzata.
