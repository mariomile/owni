# 0136: Scansioni JBIG2 e JPEG 2000

Mario (30 ottobre 2026): «Va bene, procedi», dopo la spiegazione dei due formati. Una pagina scansionata in JBIG2 (il bianco e nero dei multifunzione da ufficio) o in JPEG 2000 (archivi, alcuni scanner a colori) finora non si guardava: l'ADR 0028 la mandava al computer di Owni o chiedeva una foto. È la scansione più comune che restava fuori.

## Decisione

- **I decodificatori di PDF.js.** `pdfjs-dist` (Apache-2.0, Mozilla) ha due decodificatori di immagini separati dal resto: JBIG2 (quello di PDFium) e JPEG 2000 (OpenJPEG), compilati in WebAssembly. Li usiamo da `src/core/pdf-scan-codecs.ts`; il resto della lettura dei PDF resta nostro (ADR 0026, 0028). Il WebAssembly si legge dalla cartella del pacchetto, perché il `fetch` di Node non legge file.
- **JBIG2 come un fax.** Il risultato è un'immagine in bianco e nero a un bit, come dopo il decodificatore fax: passa per la stessa strada (`Decode`, maschere, righe dal basso). I simboli condivisi tra le pagine (`JBIG2Globals`) si leggono dal loro stream.
- **JPEG 2000 con le sue dimensioni.** Come per un JPEG, dimensioni e numero di componenti si leggono dall'immagine e non dal PDF, prima di decodificare: dall'intestazione SIZ all'inizio del codestream, o del box `jp2c` in un file JP2. Non cercando il marcatore nei byte, come fa `parseImageProperties` di PDF.js: un profilo colore o un altro box può contenerne uno falso, piccolo, davanti a un'immagine enorme. Senza `ColorSpace` nel PDF decide l'immagine (1 grigio, 3 RGB, 4 CMYK, uno in meno con `SMaskInData`); un componente in più dei colori è l'alfa e si lascia fuori; altrimenti, con un `ColorSpace` che non torna, Owni lo dice invece di indovinare. Le tavolozze (`Indexed`) si leggono. Diventa un PNG a 8 bit.
- **Gli stessi limiti.** 25 milioni di pixel, 8.000 per lato, 64 MB di campioni, controllati prima di decodificare; dopo, il risultato deve avere esattamente i byte che le dimensioni dicono. Tutto gira nel worker dei documenti (20 secondi). I 512 MB del worker valgono solo per il heap JavaScript, non per la memoria del WebAssembly: per questo il controllo prima di decodificare deve leggere le dimensioni vere.
- **Un limite di JBIG2.** Per JBIG2 si controllano le dimensioni che dice il PDF; il decodificatore taglia il risultato a quelle. Uno stream che dentro dichiara una pagina più grande costa al decodificatore fino a qualche centinaio di MB e qualche secondo (il tetto di PDFium è circa 2^31 pixel), poi riesce o si ferma ai 20 secondi del worker, che interrompe anche il WebAssembly. Lo accettiamo.
- **Un'installazione rotta non è un file rovinato.** Se il WebAssembly non si carica, Owni lo dice («non riesco ad aprire le scansioni JBIG2 e JPEG 2000 su questa installazione») invece di dare la colpa al file.

## Alternative scartate

- **`jpeg2000` o `@cornerstonejs/codec-openjpeg`.** Il primo non è aggiornato dal 2023; il secondo fa solo JPEG 2000. PDF.js fa tutti e due, è mantenuto da Mozilla e decodifica i PDF di Firefox.
- **Scriverli a mano, come il fax.** JBIG2 (codifica aritmetica, simboli, mezzitoni) e JPEG 2000 (wavelet) sono migliaia di righe ciascuno, con una lunga storia di vulnerabilità. Meglio il codice che Firefox usa su ogni PDF.
- **Tutto PDF.js per rasterizzare la pagina.** Servirebbe un canvas nativo e il motore completo, per un caso che resta una sola immagine per pagina.

## Conseguenze

- `pdfjs-dist` pesa circa 35 MB installato: entra nell'app per Mac e nell'immagine Docker. Il canvas nativo opzionale (`@napi-rs/canvas`) non si installa (`pnpm.ignoredOptionalDependencies`).
- `pdfPageImage` è asincrona, perché i decodificatori lo sono.
- Restano al computer o alla foto solo il fax misto (gruppo 3 a due dimensioni) e le pagine senza immagini.
