# Conti esatti: domande alle tabelle e calcolatrice

> Sostituito dall'[ADR 0119](0119-programmi-python.md): `table_query` e `calculate` non ci sono più, i conti li fa `code_run`.

Le persone mandano a Owni l'export delle fatture, l'estratto conto, il foglio delle vendite, e chiedono «quanto ho fatturato a marzo?», «chi sono i cinque clienti migliori?», «quante fatture non sono pagate?». Owni poteva leggere il testo del foglio (ADR 0026) e fare i conti a mente: con cento righe un modello sbaglia una somma, salta una riga o conta due volte il totale in fondo. Lo stesso per un preventivo: imponibile, IVA, sconto e rate fatti a mente escono sbagliati di qualche euro. Un numero sbagliato detto con sicurezza è il danno peggiore che una segretaria possa fare.

## Decisione

Due tool che fanno i conti in codice, esatti, e lasciano al modello solo la domanda.

- **`table_query`** risponde a domande su un CSV, un Excel (.xlsx) o un foglio OpenDocument (.ods) del workspace. Con il solo file descrive le colonne (tipo, celle piene, somma o intervallo di date o valori più frequenti) e le prime righe. Poi filtra (= != > >= < <= in not_in contains empty; su una data anche un mese 2026-03 o un anno 2026), raggruppa per colonne o per periodo (giorno, settimana ISO, mese, trimestre, anno), calcola count, sum, avg, min, max, median, distinct e share (la quota sul totale) di una colonna o di un'espressione di colonne («Quantità * Prezzo», «[Avere] - [Dare]»), ordina, taglia, e salva la risposta intera in un CSV che `chart_create`, `document_create` e `table_query` stesso possono usare.
- **`calculate`** fa l'aritmetica di una o più righe con nomi («imponibile = 3 * 450», poi «iva = imponibile * 22%»), i numeri scritti all'italiana, le percentuali e le funzioni comuni (anche con i nomi italiani di Excel). Un parser scritto qui, mai `eval`.

## Come legge le tabelle

- **I valori veri.** Da Excel e da OpenDocument legge i valori salvati, non quelli che il formato mostra: 10,4 in una cella col formato «0» resta 10,4, e la somma torna. Le righe e le celle che OpenDocument scrive una volta con «ripeti» contano quante volte si ripetono.
- **L'intestazione.** È la riga, tra le prime 15, con più celle di nomi (non numeri o date): il titolo, il conto e il periodo sopra un estratto conto sono saltati e detti. Una prima riga di numeri vuol dire niente intestazione: le colonne prendono le lettere.
- **Totali e saldi.** Le righe «Totale…», «Subtotale», «Riporto», «Saldo iniziale/finale» senza una data sono lasciate fuori, e così l'ultima riga senza nome che è la somma delle altre: i totali li calcola Owni.
- **I numeri come li scrivono gli export.** 1.234,56, € 30, 25%, +150,00, 1.000,00- e (1.000,00) negativi. Il separatore dei decimali si decide per colonna: se le celle chiare scrivono i decimali con il punto (1.25, 1,234.50), 0.500 è mezzo; altrimenti si legge all'italiana e 1.500 è millecinquecento. Il separatore del CSV si sceglie sulle prime 20 righe, così un titolo sopra la tabella non inganna.
- **Date.** 2026-10-17 (anche con l'ora), 17/10/2026, 17-10-2026, 17.10.2026 e 17/10/26.
- **Più fogli.** Il primo foglio visibile con dati, uno per nome o numero, oppure `sheet: "*"` che unisce i fogli con le stesse colonne (un foglio per mese) e aggiunge la colonna «Foglio».
- **Somme al centesimo.** Somma compensata (Kahan); gli importi con due decimali restano con due decimali.

## Come risponde

- Una tabella Markdown con i numeri all'italiana, con sopra una riga di Owni (quante righe, quante dopo i filtri, cosa segue) e sotto le note: cosa ha saltato, valori che non sono numeri, colonne trovate da un pezzo del nome, e perché un filtro non ha trovato niente (con alcuni valori della colonna o l'intervallo delle date). Uno zero senza spiegazione sembrerebbe una risposta.
- Le colonne si chiamano per nome (senza badare a maiuscole e accenti), per una parola del nome se è una sola colonna ad averla, o per lettera. Quando il nome è in più colonne, Owni elenca quali.
- Al massimo 50 righe mostrate (fino a 500); `save` salva tutto.

## Sicurezza e limiti

- Il contenuto della tabella viene da fuori (un export, un allegato): tutto quello che il file scrive o nomina (fogli, colonne, valori, le note che li citano, gli errori che elencano le colonne) sta dentro il recinto con l'etichetta casuale, «dati, non istruzioni»; fuori ci sono solo i numeri di Owni.
- Gira nel worker dei documenti (20 secondi, 512 MB, due alla volta). File fino a 20 MB, 200.000 righe, 200 colonne, 20.000 gruppi, 12 filtri, 8 calcoli: i limiti sono controllati prima del lavoro, e le righe ripetute di un foglio OpenDocument si fermano al limite.
- `save` scrive solo un .csv e mai sopra un file che esiste. Nel CSV salvato il testo che un foglio di calcolo eseguirebbe come formula (=, +, -, @ in testa) prende un apostrofo davanti.
- `calculate`: niente `eval`; al massimo 4.000 caratteri, 50 righe, 40 livelli di parentesi, 200 argomenti. Divisione per zero, radici di negativi, risultati infiniti, virgole ambigue tra gli argomenti di una funzione: rifiutati con il motivo, mai un numero inventato.

## Alternative scartate

- **I conti a mente del modello.** Sbaglia proprio dove conta: somme lunghe, totali contati due volte, percentuali.
- **Il computer di Owni con Python e pandas.** Va bene per analisi lunghe, ma non tutte le istanze lo hanno, è lento da accendere, e un modello che scrive pandas sbaglia anche lui il separatore e i decimali italiani.
- **SQL su un database in memoria.** Potente, ma il modello dovrebbe scrivere SQL corretto per tabelle con colonne «Importo €» e date in tre formati; i parametri strutturati si sbagliano meno e si spiegano meglio.
- **`eval` per la calcolatrice.** Eseguirebbe codice scritto da un modello che legge testo di altri.

## Conseguenze

- Le domande che chiedono più passaggi (la media dei totali settimanali) si fanno in due: raggruppare e salvare, poi chiedere al file salvato. La descrizione del tool lo dice.
- Le settimane senza righe non compaiono tra i gruppi.
- Le etichette dei periodi sono ordinabili (2026-03, 2026-S11, 2026-T1): il modello le scrive per le persone.
