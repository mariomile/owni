# Ritenute d'acconto e Certificazione Unica

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `withholding` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Per chi è in regime ordinario e lavora per clienti sostituti d'imposta, ogni fattura ha una ritenuta d'acconto che il cliente trattiene, versa con l'F24 e certifica nella Certificazione Unica entro il 16 marzo dell'anno dopo. Quella ritenuta è un credito nella dichiarazione dei redditi, ma solo se il cliente l'ha trattenuta davvero e se torna con la CU. Owni aveva le fatture e gli incassi ma non teneva il conto delle ritenute, e lo scadenzario aspettava il lordo dalle fatture XML senza dati di pagamento. Ora «quanto mi hanno trattenuto quest'anno?», «quali clienti devono ancora mandarmi la CU?», «la CU di Rossi torna?», «quanto credito ho per la dichiarazione?» e «Rossi mi ha pagato al netto?» hanno una risposta.

## Decisione

- **Strumento `withholding`** con `summary`, `check_payment`, `record_cu`, `cu_remove`, `cu_list` ed `export`. Le CU dette dalla persona stanno in `withholding.json` nella cartella dell'istanza, con la copia `.bak`, attraverso `json-book.ts`: CU-NNNN mai riusati, 2.000 al massimo. Tutto il resto viene letto dai registri che ci sono.
- **Da dove vengono le ritenute**: dalle fatture in uscita fatte con Owni e dai `DatiRitenuta` delle fatture XML (RT01 e RT02 sono imposta e fanno credito; RT03-RT06 sono contributi, come l'ENASARCO, e non sono un credito d'imposta). Una fattura fatta con Owni e il suo XML sono una fattura sola, come nella liquidazione IVA. I compensi sono l'imponibile senza le spese anticipate e senza il contributo integrativo delle casse (TC01-TC21; la gestione separata INPS resta).
- **Per cassa**: la ritenuta conta nell'anno in cui il cliente paga. Una fattura pagata in più rate divide la ritenuta in proporzione e ogni parte conta nell'anno della sua rata, anche se la fattura non è ancora pagata tutta.
- **Cosa aspetta lo scadenzario**: per le fatture emesse in XML senza dati di pagamento la rata è il totale meno le ritenute (e meno l'IVA della scissione dei pagamenti), solo se il totale è il lordo delle righe; se è già scritto al netto resta com'è. Le fatture ricevute restano al lordo. I contributi trattenuti tornano negli incassi su cui si calcolano le tasse del forfettario, mentre l'incassato resta quello arrivato davvero.
- **Pagato al netto?** Prima i movimenti dell'estratto conto confermati, poi un importo detto dalla persona, poi lo scadenzario, che però è la cifra della fattura e non una prova, e Owni lo dice. Solo una fattura pagata al lordo secondo la banca esce dal credito.
- **CU**: confrontata con le fatture del cliente pagate in quell'anno, al centesimo per fattura; se non torna Owni cerca le fatture che spiegano la differenza (pagata l'anno dopo o prima, non segnata pagata, nota di credito, pagata al lordo). La CU è dell'anno dei pagamenti, quello prima dell'anno scritto sul modulo: Owni rifiuta una CU dell'anno in corso e lo spiega. Una seconda CU dello stesso cliente e anno la sostituisce, ma non su un nome solo simile. Un cliente che non è nelle fatture si accetta solo con partita IVA o codice fiscale.
- **Scadenza** il 16 marzo, spostata al giorno lavorativo, con la fonte in `withholding-rules.ts` (alcune voci «da verificare»). Dal giorno dopo la scadenza al 31 marzo il brief dice quante CU mancano.
- **Forfettario**: niente ritenute (L. 190/2014, art. 1, comma 67), Owni lo dice e si ferma.
- **Andamento dell'attività**: per l'ordinario una riga con le ritenute trattenute nel periodo, senza quelle pagate al lordo.
- **Export** CSV in `ritenute/` con una riga per fattura, la parte dell'anno, il credito e il confronto con la CU, e il totale.

## Sicurezza

- Nomi dei clienti solo dentro un recinto dei dati non fidati per risposta; le cifre della CU dette dalla persona sono dati. CSV con celle protette dalle formule, mai sovrascritto.
- Ogni scrittura sotto il lock; una chiamata ripetuta non scrive due volte, anche dopo una sostituzione. Un `withholding.json` rovinato non viene mai sovrascritto.
- Dal canale degli agenti solo `summary`, a totali senza nomi; il brief usa solo `cu_list` e non scrive. L'audit registra operazione e conteggi.

## Alternative scartate

- **Contare la ritenuta quando la fattura è pagata tutta**: una fattura pagata metà a dicembre e metà a gennaio finiva tutta nell'anno sbagliato, e la CU non tornava.
- **Togliere la ritenuta anche dalle fatture ricevute**: la ritenuta che l'azienda versa con l'F24 spariva dalla previsione di cassa e dalle spese.
- **Togliere i contributi dagli incassi del forfettario**: l'ENASARCO trattenuto è un compenso percepito, e le tasse stimate venivano più basse.
