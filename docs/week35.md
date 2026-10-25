# Settimana 35: Owni crea documenti Word, Excel e PDF

Branch `week-35`. Owni leggeva i documenti (settimane 32-34) ma non li creava: un preventivo o un listino uscivano come testo in chat. Ora `document_create` scrive un file Word, Excel o PDF nel workspace, partendo da quello che Owni scrive in Markdown o da un CSV, e Owni lo manda con `file_send` su Telegram, WhatsApp o nella console. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0029](adr/0029-documenti-creati-da-owni.md).

## Cosa cambia per chi usa Owni

- **«Fammi un preventivo in PDF per Rossi»**: titolo, indirizzo, tabella delle voci con gli importi allineati, totale in grassetto, condizioni, il logo dal workspace in alto a sinistra, numeri di pagina.
- **«Scrivimi la lettera in Word»**: un documento con gli stili veri di Word, che si modifica come uno scritto a mano.
- **«Mettimi questi dati in Excel»**: numeri, importi, percentuali e date che Excel riconosce come tali, l'intestazione ferma con i filtri, un foglio per sezione, le formule anche scritte all'italiana (`=SOMMA(B2:B9)`), con i totali già calcolati per chi apre il file dal telefono.
- **«Trasforma questo CSV in Excel»** (o un report in PDF): `source` converte un file del workspace.
- **Quando qualcosa non entra**, Owni lo dice: un'immagine che non c'è, lettere che il PDF non ha (e propone Word), una formula non ammessa, una tabella che in un foglio non comincia alla riga 1.

## Cosa funziona (verificato dai test)

- Markdown come lo scrivono i modelli: titoli anche sottolineati, a capo e `<br>`, elenchi misti e di cose da fare, tabelle con `\|` nelle celle, link per intero, un'immagine seguita dal nome dell'azienda (`test/make-documents.test.ts`).
- Word: titolo, stili, tabella, elenco numerato, link nei rels, immagine con la misura giusta, caratteri che XML non accetta tolti; il testo riletto con `file_read`.
- Excel: numeri italiani e internazionali, euro anche negativi, percentuali, date vere e false, codici e telefoni come testo; formule italiane convertite, valori calcolati e salvati, formato della colonna sulle formule, prefisso `_xlfn.` per XLOOKUP; funzioni non ammesse rifiutate (COPILOT, TRANSLATE, INDIRECT, WEBSERVICE, `@`, `[`, `|`) e lasciate come testo da un CSV; un foglio per sezione, nomi di foglio validi e unici anche con le emoji; celle troppo lunghe accorciate.
- PDF: testo, accenti ed euro riletti, titolo, link cliccabili, tabelle su più pagine con l'intestazione ripetuta e i numeri di pagina, PNG con trasparenza e JPEG, emoji tolte, ș ř ł senza segno, accenti nel codice, limite di 300 pagine e di 63 colonne.
- Lettura PNG: tutti i filtri, grigio, tavolozza e bassa profondità; immagini enormi, interlacciate o con più dati del dichiarato rifiutate prima di occupare memoria.
- Il parser resta lineare su testi costruiti per rallentarlo (righe di spazi, migliaia di `[`, `*`, `_`, backtick).
- Il tool: file nel workspace, `source` da CSV, errori per estensione, testo mancante o doppio, documento già Office, file mancante, percorso fuori dal workspace, testo troppo lungo, immagini troppo grandi.
- Nel browser: in chat della console, `document_create` di un PDF; il file compare in «File». Nessun errore in console.

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso, con 14 documenti generati, convertiti con LibreOffice e guardati pagina per pagina. Corretti:

- **Alta (sicurezza).** Il Markdown veniva analizzato nel processo principale, con un'espressione per i titoli che su una riga di 4.000 spazi impiegava 19 secondi e un parser che rileggeva il testo per ogni `[` aperto: un testo copiato da una pagina web poteva fermare il servizio per tutti. Ora nel processo principale resta una ricerca delle immagini riga per riga, l'analisi è nel worker e lineare, e la lunghezza del testo è controllata nel codice.
- **Media (sicurezza).** L'elenco delle funzioni Excel vietate lasciava passare COPILOT, TRANSLATE e STOCKHISTORY, che mandano il contenuto delle celle a servizi cloud all'apertura. Ora c'è un elenco di funzioni ammesse. Il codice nel PDF mostrava le lettere accentate sbagliate (Courier senza codifica WinAnsi).
- **Alta (uso).** Le formule all'italiana (`;`, `0,22`, SOMMA) davano errori; le anteprime sul telefono avrebbero mostrato i totali vuoti; i nomi rumeni, cechi e polacchi diventavano «?» nel PDF; le righe delle formule si spostavano senza avviso quando c'era testo sopra la tabella.
- **Media (uso).** Le regole dei fogli perdevano il titolo o creavano fogli a caso; le colonne di Word spezzavano «Cod» e gli importi; il logo occupava mezza pagina; `<br>`, titoli sottolineati, link per intero e un'immagine seguita da testo uscivano male; le colonne di numeri con una cella vuota non si allineavano.
- **Bassa.** Nomi di foglio doppi o vuoti con le emoji; celle oltre il limite di Excel; tabelle di migliaia di colonne in Word; troppi pixel o file oltre 20 MB scoperti solo dopo il lavoro; indirizzi dei link non validi nei rels; caratteri invisibili nel codice; il Markdown letto due volte per Excel; `-€ 2,00` come testo; i numeri degli elenchi persi in Excel.

Lasciato, scritto nell'ADR: niente caratteri incorporati nel PDF (per altri alfabeti c'è Word); le formule che Owni non sa calcolare restano da calcolare all'apertura.
