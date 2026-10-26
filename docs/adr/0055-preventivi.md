# Preventivi

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `quotes` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Chi ha una piccola impresa manda preventivi di continuo: «fammi un preventivo per Rossi Srl: 3 giornate di consulenza a 500 €, trasferta 120 €, IVA 22%», «rifai il 12 con lo sconto del 10%», «quali sono ancora aperti?», «il 12 è stato accettato». Finora Owni poteva solo scrivere un documento libero con `document_create`, facendo i conti a mente.

## Decisione

- **Uno strumento, `quotes`**: `create`, `revise`, `list`, `show`, `set_status`. Ogni preventivo ha un numero per anno (`2026-012`), mai riusato; una revisione tiene il numero e aggiunge `-R1` (nel documento «rev. 1»), e la versione vecchia resta come «sostituita». Lo stato cambia solo quando la persona lo dice; «scaduto» si calcola dalla validità (30 giorni se non detto).
- **Conti esatti**: centesimi interi, arrotondamento per riga e poi per aliquota, come nel riepilogo di una fattura. Importi ambigui come «1.250» sono rifiutati e Owni chiede. Prezzi IVA inclusa restano esattamente come detti: l'imponibile si ricava per aliquota e l'IVA per differenza, e Owni lo dice quando il centesimo non torna.
- **Owni non sceglie l'aliquota**: se manca chiede «Che aliquota IVA applico: 22%, 10%, 4%, oppure senza IVA…?». Una riga allo 0% vuole il motivo; con il regime forfettario salvato le righe vanno allo 0% con la dicitura dell'art. 1, commi 54-89, L. 190/2014, e il documento non mostra colonne IVA. Ritenuta d'acconto 20%, cassa (rivalsa INPS, che entra nella base della ritenuta, o contributo integrativo, che non ci entra), bollo, acconto e tempi di consegna solo se chiesti; il bollo è suggerito quando la parte senza IVA supera 77,47 €.
- **Documento**: PDF (o Word) in `preventivi/` del workspace, con carta intestata dai dati salvati con `set_company` (ragione sociale, P.IVA, sede, contatti, codice fiscale, REA, IBAN, firma), cliente, dettaglio, totali per aliquota, validità, pagamento e il riquadro «Per accettazione». Senza ragione sociale e partita IVA il preventivo non parte. I dati di un cliente si riprendono dal suo ultimo preventivo.
- **Dopo**: Owni manda il file nella chat con `file_send` da inoltrare al cliente; quando un preventivo è accettato propone di ricordare la fattura; il brief del mattino segnala i preventivi aperti che scadono entro tre giorni.

## Sicurezza e robustezza

- Mai un preventivo senza il suo file: se il documento non si scrive il preventivo si toglie; finché il file non c'è è «in preparazione» e non si accetta né si rivede; una ripetizione della stessa chiamata dopo un riavvio ritrova il preventivo già salvato e scrive solo il file, nello stesso percorso.
- Cambiando partita IVA con `set_company`, sede, contatti, regime, IBAN e firma della vecchia azienda si cancellano, così la carta intestata non mescola due imprese.
- Dati del cliente e dell'azienda nel recinto dei dati esterni nelle risposte, e resi inerti nel documento (niente link, titoli o tabelle iniettate). Nomi di file solo ASCII, mai sovrascritti.
- `quotes.json` per istanza con validazione, blocco, copia `.bak`, 2000 preventivi per anno e 16 MB; se è rovinato le letture lo dicono e le scritture si fermano. Dal canale degli agenti e nel brief solo letture. L'audit ha solo operazione e quanti.

## Alternative scartate

- **`document_create` con i conti fatti dal modello**: sbaglia arrotondamenti e IVA scorporata.
- **Numero nuovo per ogni revisione**: il cliente ha già il riferimento del primo.
- **Mandare il preventivo per mail dal tool**: servirebbero allegati nella coda delle mail; per ora la persona lo inoltra.
