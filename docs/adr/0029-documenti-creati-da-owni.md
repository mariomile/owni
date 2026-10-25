# Documenti creati da Owni: Word, Excel e PDF

Owni leggeva Word, Excel e PDF (ADR 0026, 0027, 0028) ma non sapeva crearli: un preventivo, una lettera, un listino o una tabella da inoltrare uscivano come testo in chat o come file Markdown, che un cliente non apre. Il computer di Owni poteva farlo con LibreOffice o WeasyPrint, ma non tutte le istanze hanno il computer e per una lettera è un giro lungo.

## Decisione

Un tool, `document_create`: Owni scrive il contenuto in Markdown, che i modelli scrivono bene e senza errori di sintassi, e il tool ne fa un file `.docx`, `.xlsx` o `.pdf` nel workspace, che poi Owni manda con `file_send`. Il formato lo dice l'estensione del percorso. In alternativa a `content`, `source` converte un file Markdown o CSV già nel workspace (un CSV in Excel, un report in PDF). Tutto scritto qui, senza dipendenze: i tre formati sono testo XML in uno ZIP (Word ed Excel) o un PDF con i caratteri che ogni lettore ha.

## Come funziona

- **Markdown.** Titoli a tre livelli (anche sottolineati con `===`), paragrafi (un a capo resta un a capo, come in un indirizzo, e così `<br>`), grassetto, corsivo, codice, link web e mail anche scritti per intero (gli altri schemi restano testo), elenchi puntati, numerati e di cose da fare, annidati e misti, tabelle con allineamento, citazioni, blocchi di codice, linee, `\newpage` e immagini del workspace (PNG e JPEG). Il parser fa una passata sola: per ogni segno che apre un grassetto, un corsivo o un link cerca la chiusura proseguendo dalla ricerca precedente, e prova l'espressione solo su 1.000 caratteri; un testo pieno di `[` o `*` aperti costa una lettura, non una per segno.
- **Word.** Stili veri (Titolo 1-3, Citazione, Codice), elenchi numerati che ripartono da capo, tabelle con l'intestazione ripetuta, colonne larghe almeno quanto la parola più lunga e quelle di numeri allineate a destra (le celle vuote non contano), importi che non vanno a capo tra «€» e la cifra, numero di pagina in fondo, A4 con margini di 2 cm, titolo del documento dal primo titolo.
- **Immagini.** Un'immagine la cui descrizione dice «logo» va a sinistra e piccola (al massimo 4,5 per 2 cm); le altre al centro, a 96 punti per pollice, dentro la pagina; `![foto|8cm](...)` sceglie la larghezza. Un'immagine seguita da testo sulla stessa riga (il logo e il nome dell'azienda) non si perde.
- **Excel.** Ogni tabella diventa righe con l'intestazione in grassetto, ferma e con i filtri (sulla prima tabella del foglio). Il livello più alto di titoli apre i fogli e dà loro il nome; se è un solo titolo all'inizio, quel titolo nomina il file e il foglio con il testo che viene prima delle sezioni, e i fogli li apre il livello sotto. I titoli più bassi sono righe in grassetto. Le celle diventano numeri (1234.5 o 1.234,56), importi in euro o dollari (anche negativi, -€ 2,00), percentuali, date (2026-10-17 o 17/10/2026) o formule; i codici con zeri davanti, i numeri lunghi e i telefoni restano testo, e un apostrofo iniziale tiene testo qualunque cella. Un CSV (virgole, punti e virgola o tabulazioni) diventa un foglio con i filtri. Una cella oltre i 32.000 caratteri (Excel ne tiene 32.767) è accorciata, e Owni lo dice.
- **Formule.** Si scrivono in inglese o in italiano: `=SOMMA(B2:B3)`, `=ARROTONDA(D7*(1-B8);2)` e `=D5*0,22` diventano `SUM`, `ROUND(…,2)` e `0.22`, come Excel le salva (le stringhe tra virgolette restano come sono). Le funzioni più recenti (XLOOKUP, IFS, CONCAT, TEXTJOIN e altre) prendono il prefisso `_xlfn.` senza il quale Excel mostra #NAME?. Le formule semplici (operazioni, percentuali, SUM, AVERAGE, MIN, MAX, COUNT, ROUND, IF e poche altre, sulle celle dello stesso foglio) sono anche calcolate qui e il valore è salvato con la formula: un'anteprima che non calcola, come quelle delle app sul telefono, mostra i totali. Le altre, un ciclo o una divisione per zero restano da calcolare all'apertura. Una formula prende il formato più usato nella sua colonna (euro, percentuale) e il grassetto se è scritta in grassetto. Quando un foglio ha formule e una tabella che non comincia alla riga 1 (testo sopra, più tabelle), Owni dice a che riga sono le intestazioni.
- **PDF.** Helvetica e Courier, che ogni lettore ha, entrambi nella codifica WinAnsi: accenti, euro e virgolette tipografiche ci sono, anche nel codice. Le lettere dell'Europa centrale e dell'est che mancano (ș, ț, ř, ł) sono scritte senza il segno (s, t, r, l), le emoji sono tolte, gli altri alfabeti diventano «?», le caselle delle cose da fare «[ ]» e «[x]»; Owni dice ognuna di queste cose e propone Word, che le tiene. Testo a capo sulla larghezza vera dei caratteri, tabelle con colonne larghe quanto serve che continuano sulla pagina dopo con l'intestazione ripetuta, link cliccabili, immagini (PNG con trasparenza, JPEG così come sono), numeri di pagina.
- **Cosa non è andato.** Il risultato del tool elenca quello che non è entrato: un'immagine che non c'è o non è PNG o JPEG, i caratteri tolti dal PDF, una riga di tabella più alta di una pagina (tagliata).

## Sicurezza

Il contenuto può venire da una pagina web o da una mail, e il file lo apre una persona nel suo Excel o Word. Per questo:

- **Formule.** Solo un elenco di funzioni ammesse: calcolo, statistica, testo, date, logica e ricerca nel foglio. Tutto il resto no: le funzioni che chiamano il web o servizi cloud (WEBSERVICE, COPILOT, TRANSLATE, STOCKHISTORY), altri file o programmi (INDIRECT, CALL, RTD, DDE), i riferimenti ad altri file (`[file.xlsx]`), a programmi (`|`) e `@`. Un elenco di funzioni vietate resterebbe indietro a ogni funzione nuova di Excel. Da Markdown la formula è rifiutata con il motivo; da un CSV la cella resta testo e la conversione va avanti.
- **Link.** Solo `http`, `https` e `mailto`, normalizzati come URI validi; `javascript:`, `file:` e gli altri restano testo.
- **XML.** Tutto il testo passa per l'escape, e i caratteri che XML non accetta (controllo, surrogati spaiati) sono tolti: un testo strano non produce un file che Word dice rovinato.
- **Immagini.** Solo dal workspace dell'istanza (percorsi relativi, senza `..`), al massimo 20 per documento, 10 MB l'una e 10.000 pixel per lato; un PNG si decodifica solo se ha al massimo 16 milioni di pixel e i dati non superano quello che dichiara, e in un PDF al massimo 40 milioni di pixel in tutto (i pixel decodificati stanno fuori dal limite di memoria del worker).

## Limiti

La creazione gira nel worker dei documenti (20 secondi, 512 MB, due alla volta), come la lettura: un documento enorme costa un worker, non il processo. Nel processo principale resta solo la ricerca delle immagini, riga per riga. Al massimo 400.000 caratteri di testo (controllati anche nel codice, non solo nello schema del tool), 300 pagine di PDF, 63 colonne in una tabella di Word o PDF, 100.000 righe, 200 colonne e 50 fogli in Excel, 20 MB di file (il limite del workspace, controllato prima di scrivere). Le formule di un foglio leggono al massimo 2 milioni di celle in tutto per calcolare i valori; oltre, il resto lo calcola Excel.

## Alternative scartate

- **LibreOffice o WeasyPrint nel server.** Centinaia di MB, lenti ad avviarsi, un'altra superficie da tenere aggiornata. Restano nel computer di Owni per chi ha bisogno di impaginazioni particolari.
- **Una libreria (docx, exceljs, pdfkit).** Dipendenze grandi per quello che serve qui; il progetto finora legge e scrive questi formati da sé (ADR 0026).
- **HTML convertito in PDF.** Servirebbe un browser per ogni documento. Il browser della cella esiste, ma non in tutte le istanze, e una pagina web non ha l'intestazione ripetuta delle tabelle né i numeri di pagina.
- **Caratteri incorporati nel PDF.** Darebbero tutti gli alfabeti, al costo di un font da distribuire e di un sottoinsieme da calcolare. Per l'italiano bastano quelli standard; per altri alfabeti c'è Word.

## Conseguenze

- Le formule che Owni non sa calcolare (CERCA.VERT, date, testo) arrivano senza valore: Excel, LibreOffice e Numbers le calcolano all'apertura, ma un'anteprima sul telefono può mostrarle vuote.
- Le righe contano dall'alto del foglio: chi scrive una formula deve sapere dove finisce la tabella. Il tool lo dice quando la tabella non comincia alla riga 1.
- Le immagini da internet vanno prima salvate con `web_download`: il tool non scarica niente.
