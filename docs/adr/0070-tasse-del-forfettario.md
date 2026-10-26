# Tasse del forfettario

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `taxes` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Chi è nel regime forfettario incassa senza IVA ma deve tenere da parte imposta sostitutiva e contributi, e scopre quanto solo a giugno, quando il commercialista manda l'F24 con saldo e primo acconto. Con lo scadenzario (ADR 0053) Owni sa cosa è stato incassato e quando; con la previsione di cassa (ADR 0065) sa quanti soldi ci saranno. Ora «quanto devo mettere da parte per le tasse?», «quando scade il prossimo F24 e quanto?», «se incasso altri 10.000 €?» e «quest'anno guadagno meno, posso pagare meno acconti?» hanno una risposta, sempre come stima da verificare con il commercialista.

## Decisione

- **Strumento `taxes`** con `set_profile`, `set_aside`, `estimate`, `calendar`, `what_if` ed `export`. Profilo, cifre dette per anno e accantonato stanno in `taxes.json` nella cartella dell'istanza, con la copia `.bak`, attraverso `json-book.ts`. Il profilo tiene solo quello che la persona ha detto; i valori dell'anno (aliquote, minimali, massimali) si cercano al momento del calcolo nelle tabelle di `taxes.ts`, e per un anno senza valori Owni usa l'anno prima e lo dice.
- **Ricavi per cassa**: le rate segnate come incassate nell'anno, dallo stesso `cash-book.ts` della prima nota; rivalsa INPS e bollo addebitato al cliente sono compensi, il contributo integrativo di una cassa no. Reddito = ricavi × coefficiente di redditività del gruppo ATECO (L. 190/2014, allegato 4). Le parole generiche («consulente informatico», «sviluppatore», «fotografo») non bastano: Owni propone i due gruppi probabili e chiede il codice ATECO.
- **Contributi**: gestione separata al 26,07% (2026) sul reddito, fino al massimale; artigiani e commercianti con la parte fissa sul minimale, il 24% o il 24,48% oltre il minimale e un punto in più oltre la seconda fascia, con la riduzione del 35% del forfettario su tutto o il 50% per chi si è iscritto nel 2025 fino al 2027 (con una partita IVA più vecchia Owni salva e chiede di confermare l'anno della prima iscrizione all'INPS); nel profilo restano solo le cifre dette, i valori INPS dell'anno si leggono al momento del calcolo; per una cassa professionale l'aliquota e il minimo detti dalla persona. I contributi versati nell'anno si tolgono dal reddito: quelli detti, altrimenti quelli che il calendario fa pagare in quell'anno (saldo, acconti, rate fisse), altrimenti la stima, e la risposta dice quale.
- **Imposta** al 15%, o al 5% per i primi cinque anni con i requisiti. Accantonamento come percentuale di ogni incasso, arrotondata per eccesso. Avviso dall'80% del limite di 85.000 € (fuori dal regime l'anno dopo) e oltre 100.000 € (fuori subito).
- **Calendario F24** con il metodo storico: saldo e primo acconto a giugno, secondo acconto a novembre; acconto d'imposta niente fino a 51,65 €, tutto a novembre se la prima rata sarebbe sotto 103 €, altrimenti metà e metà; gestione separata 80% dei contributi dell'anno prima, 40 e 40; rate fisse di artigiani e commercianti il 16 maggio, 20 agosto, 16 novembre e 16 febbraio. Le scadenze passano al giorno lavorativo dopo. La proroga di luglio per forfettari e ISA è una tabella per anno (2024, 2025, 2026) con la data in alternativa e la maggiorazione; per un anno non in tabella Owni usa il 30 giugno e i 30 giorni dopo, e dice di verificare la proroga. Un F24 di giugno non pagato resta fino alla data in alternativa, a meno che la persona abbia detto gli acconti versati.
- **Metodo previsionale** come opzione di sola lettura: con i ricavi attesi Owni confronta acconto per acconto («a novembre verseresti X invece di Y»), segnala un eventuale credito e avvisa delle sanzioni se la stima è troppo bassa.
- **Previsione di cassa**: gli F24 stimati entrano come fonte «tasse stimate (F24)». Una voce o una spesa con un nome chiaramente fiscale (F24, IRPEF, sostitutiva, INPS, Agenzia delle Entrate, che vincono su tutto il resto; le parole generiche, «tasse» compresa, solo con saldo o acconto e mai con bollo, tassa automobilistica, rifiuti, associazioni, fornitori) entro 10 giorni la sostituisce: una spesa solo se è almeno il 30% della stima, delle voci la parte che copre, e il resto della stima rimane. Un pagamento che copre almeno il 70% di più stime dello stesso giorno (l'F24 di giugno in ritardo e la rata fissa del 20 agosto) vale per tutte. Le spese fiscali escono dalla spesa media.
- **Brief**: una riga solo quando un F24 scade entro 10 giorni, quando negli ultimi 3 giorni gli incassi hanno passato una soglia del limite, o fino a fine anno oltre 100.000 €.
- **Export** CSV in `tasse/`: profilo, cifre dette, stima, calendario, l'alternativa di luglio su una riga a sé e l'elenco degli incassi, con una colonna che dice da dove viene ogni numero (detto, stimato, fatture, predefinito, dal codice ATECO).
- **Regime ordinario**: solo le date (IVA trimestrale e annuale, imposte), senza importi.

## Fonti

Le costanti in `taxes.ts` hanno ognuna il commento con la fonte e l'anno. I siti di Agenzia delle Entrate, INPS e Normattiva non erano raggiungibili durante la revisione, quindi la verifica è stata fatta su fonti secondarie che citano circolari e leggi. Restano marcati «da verificare»: la soglia dell'acconto unico (le fonti danno 206/207 € o 257,52/258 €), la maggiorazione dello 0,80% del 2026 e la fine della riduzione per gli iscritti nel 2025. Ogni risposta con importi dice che è una stima.

## Sicurezza e concorrenza

- Ogni scrittura passa da `updateBook` sotto il lock e riconosce la stessa chiamata ripetuta; un file rovinato non viene mai sovrascritto. `estimate`, `calendar` e `what_if` non scrivono niente.
- Nomi dei clienti e testo della persona (date o percentuali illeggibili comprese) tornano al modello solo dentro il recinto dei dati non fidati. Celle del CSV protette dalle formule, nome del file solo da anno e data, mai sovrascritto.
- Dal canale degli agenti solo `estimate`, `calendar` e `what_if`; il brief usa solo `calendar`. L'audit registra operazione e numero, mai importi, nomi o date.

## Alternative scartate

- **Calcolare anche il regime ordinario**: IRPEF a scaglioni, detrazioni e IVA richiedono dati che Owni non ha; date sì, importi no.
- **Usare le aliquote dell'anno salvate nel profilo**: un profilo salvato nel 2026 avrebbe usato i valori INPS del 2026 per sempre.
- **Riconoscere un F24 da qualunque parola fiscale**: un bollo da 16 € o un «acconto fornitore» cancellavano un F24 da 3.000 € dalla previsione.
- **Mandare gli F24**: il pagamento resta alla banca o al commercialista; Owni dice quando e quanto.
