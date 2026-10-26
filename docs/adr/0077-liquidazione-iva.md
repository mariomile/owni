# Liquidazione IVA

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `vat_settlement` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Le tasse del forfettario (ADR 0070) coprivano chi non addebita l'IVA. Chi è in regime ordinario la addebita in fattura, la detrae dagli acquisti e ogni mese o trimestre versa la differenza con l'F24: è il pagamento più frequente e più facile da dimenticare. Con le fatture emesse (ADR 0072) e quelle ricevute dello scadenzario (ADR 0053) Owni ha già i numeri. Ora «quanta IVA devo versare questo trimestre?», «quando scade il prossimo F24 dell'IVA?», «quanto acconto IVA a dicembre?», «se compro a novembre invece che a ottobre?» e «mandami il riepilogo IVA per il commercialista» hanno una risposta, sempre come stima da verificare con il commercialista.

## Decisione

- **Strumento `vat_settlement`** (il nome distingue la liquidazione da `vat_check`, il controllo della partita IVA) con `settings`, `period`, `calendar`, `acconto`, `what_if`, `mark_paid`, `deductibility`, `set_credit` ed `export`. Periodicità, F24 segnati pagati, detraibilità e credito detto stanno in `vat.json` nella cartella dell'istanza, con la copia `.bak`, attraverso `json-book.ts`.
- **Solo per l'ordinario.** Nel forfettario Owni spiega che non c'è liquidazione e rimanda a `taxes`; se il regime non è salvato lo chiede. La periodicità (mensile o trimestrale) la dice la persona: Owni non la indovina, e ricorda che i codici 6001-6012 sono mensili e 6031-6033 trimestrali.
- **IVA a debito** dalle fatture emesse con Owni e da quelle in XML del workspace dove la persona è il fornitore, ognuna una volta sola; le note di credito tolgono. Scissione dei pagamenti e inversione contabile (N6) sono mostrate a parte e non si versano. **IVA a credito** dalle fatture ricevute nel periodo di ricezione (la data la dice la persona; altrimenti quella della fattura, e Owni lo dice solo quando cambia il periodo), con le percentuali di detraibilità segnate per fornitore o per fattura. Le integrazioni TD16-TD19 contano dai due lati; l'IVA per cassa quando la fattura è segnata pagata.
- **Liquidazione** in centesimi esatti: un saldo fino a 25,82 € passa al periodo dopo, il credito anche; il trimestrale aggiunge l'1% di interessi, anche sul saldo annuale del 4º trimestre (da verificare). Scadenze: il 16 del mese dopo; 16 maggio, 20 agosto e 16 novembre per i trimestri; il saldo annuale il 16 marzo, con la proroga al 30 giugno e lo 0,40% al mese; tutte spostate al giorno lavorativo. Codici tributo con ogni scadenza.
- **Acconto** entro il 27 dicembre: storico (88% di dicembre o del 4º trimestre dell'anno prima), analitico (definitivo dal 20 dicembre) e previsionale se la persona dice quanto si aspetta; si indica il metodo che costa meno e niente sotto 103,29 €. Un acconto non segnato pagato non viene mai tolto dal saldo di dicembre.
- **Credito di inizio anno** solo se la persona lo dice o lo conferma. Quando l'anno prima ha fatture in ogni periodo, Owni propone la cifra che vede e non la scala finché non è confermata: un archivio di vecchi acquisti non deve far sembrare l'IVA già pagata.
- **F24 scaduti** e non segnati pagati restano per 30 giorni nel calendario, nel brief e nella previsione di cassa (a oggi); un pagamento fatto tardi li chiude.
- **Previsione di cassa**: gli F24 dell'IVA stimati sono una fonte, come quelli delle tasse del forfettario, e i due non si sommano mai. Una voce o una spesa con un nome da F24 dell'IVA («F24 IVA settembre», «6031», «saldo IVA 2025 + interessi») la sostituisce; un nome da prezzo («IVA inclusa», «+ IVA», «IVA 10%») no. Nell'ordinario la spesa media toglie solo i pagamenti dell'IVA.
- **Brief** (voce 15): un F24 dell'IVA entro 10 giorni o scaduto da poco, con l'importo. **Export** CSV in `iva/`.
- Regole, soglie, scadenze e codici stanno in `vat-rules.ts` con la fonte; dove non è certo c'è «da verificare».

## Sicurezza e concorrenza

- Ogni scrittura passa da `updateBook` sotto il lock e riconosce la stessa chiamata ripetuta. Un `vat.json` rovinato non viene mai sovrascritto.
- Nomi di clienti e fornitori tornano al modello solo dentro un recinto dei dati non fidati. L'audit registra operazione e numero, mai nomi, importi o date.
- Dal canale degli agenti solo `period` e `calendar`, con i totali e senza nomi; il brief legge soltanto. Le righe IVA di una fattura sono al più 100, così una fattura costruita apposta non riempie la memoria.

## Alternative scartate

- **Dare per versato l'acconto calcolato dopo il 27 dicembre**: se non era stato versato, l'F24 di dicembre risultava più basso di 8.800 € senza dirlo.
- **Portare avanti il credito calcolato di anno in anno**: un solo acquisto del 2019 azzerava l'IVA del 2026.
- **Indovinare la periodicità dal volume d'affari**: la soglia dipende dall'attività ed è un'opzione, non un obbligo.
