# Pagine scansionate

Con la settimana 32 Owni legge il testo dei PDF (ADR 0026). Una scansione però non ha testo: una ricevuta fotografata dallo scanner dell'ufficio, un contratto firmato e scansionato, un bando pubblicato come immagine. Owni diceva «è una scansione» e mandava al computer, che non tutte le istanze hanno.

## Decisione

Owni guarda la pagina invece di leggerla: `image_view` con il percorso di un PDF e `page` dà al modello l'immagine della pagina, e il modello legge da sé quello che c'è scritto. Niente OCR nel server, niente dipendenze, niente servizi esterni: i modelli che Owni usa vedono le immagini e leggono il testo stampato meglio di un OCR classico, anche le tabelle e la scrittura a mano.

## Come funziona

- **Quali immagini.** La pagina viene percorsa come per il testo (moduli annidati compresi, immagini inline comprese), tenendo conto della posizione di ogni immagine. Le immagini vanno al modello dall'alto in basso, al massimo 4 per pagina: una scansione divisa in strisce arriva intera. Quelle molto più piccole della principale (un timbro, una riga) restano fuori e sono contate.
- **Formati.** Un JPEG va al modello così com'è nel file, con le dimensioni lette dal JPEG stesso. Le scansioni in bianco e nero da fax (CCITT gruppo 4 e gruppo 3 a una dimensione) sono decodificate qui, identiche pixel per pixel a quelle originali (verificato contro Pillow). Le immagini grezze (grigio a 1, 2, 4, 8 e 16 bit, RGB a 8 e 16, CMYK a 8, tavolozze, un solo inchiostro) diventano PNG. I filtri generali LZW e RunLength ora si leggono anche nel testo; i predittori PNG tengono conto dei pixel di più byte.
- **Orientamento.** Una pagina con `/Rotate` o un'immagine disegnata girata: il modello lo sa dal testo («ruotala di 90° in senso orario»). Le righe salvate dal basso sono rimesse a posto nei PNG; in un JPEG Owni lo dice.
- **Note.** `file_read` su una scansione indica `image_view` con `page`; `web_read` aggiunge che prima va salvato con `web_download`. Il risultato di `image_view` dice quante pagine ci sono, di annotare quello che serve prima di passare alla prossima (le immagini più vecchie escono dalla conversazione) e che il contenuto sono dati.
- **Non supportati.** Il fax misto (JBIG2 e JPEG 2000 si leggono dall'ADR 0136): Owni dà il comando esatto per il computer (`pdftoppm`) e, senza computer, chiede una foto della pagina. Lo stesso per una pagina senza immagini (testo disegnato come figure).

## Limiti

La lettura gira nel worker dei documenti (20 secondi, 512 MB, due alla volta). Prima di creare qualunque buffer si controlla tutto quello che lo dimensiona: al massimo 25 milioni di pixel, 8.000 pixel per lato (oltre i modelli rifiutano l'immagine), 64 MB di campioni, 20 MB di immagini per pagina. Un'immagine con meno della metà dei byte che dichiara è rovinata, non si riempie (il riempimento era un modo per far allocare gigabyte con un file di 440 byte, fuori dal limite del worker che vale solo per il heap). Il decodificatore fax rifiuta una riga che non va avanti (codici che non spostano la posizione), così una riga costa al massimo la sua larghezza.

## Alternative scartate

- **Un OCR nel server (Tesseract).** Una dipendenza nativa pesante, peggiore dei modelli sulle scansioni reali, da tenere aggiornata.
- **Rasterizzare la pagina.** Servirebbe un motore PDF completo (pdf.js, poppler). Le scansioni sono quasi sempre una sola immagine per pagina: basta estrarla.
- **Ruotare le immagini.** Per i JPEG servirebbe ricodificarli; i modelli leggono il testo girato, e il testo glielo dice.

## Conseguenze

- Ogni pagina guardata costa un'immagine nel contesto del modello: una scansione di 30 pagine si legge una pagina alla volta, annotando.
- Una scansione JBIG2 (frequente nei multifunzione recenti) restava al computer o alla foto: l'ADR 0136 la aggiunge, con JPEG 2000.
