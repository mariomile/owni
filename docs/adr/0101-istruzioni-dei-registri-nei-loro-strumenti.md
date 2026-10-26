# Le istruzioni dei registri stanno nei loro strumenti

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): i registri e le loro istruzioni non ci sono più.

Dopo l'ADR 0100 i 25 registri dell'attività arrivano al modello solo quando li carica con `tool_search`, ma le istruzioni predefinite avevano ancora una frase lunga per ciascuno: quasi 12 mila caratteri, circa 3 mila token, pagati a ogni turno. Le istruzioni erano a 19.775 caratteri su un limite di 20.000, e quasi tutto quello che dicevano lo dicevano già le descrizioni degli strumenti.

## Decisione

- Le 25 frasi dei registri escono da `DEFAULT_INSTRUCTIONS`. Al loro posto c'è una riga sola: i registri dell'attività si caricano con `tool_search`, che li elenca, e si segue la sua descrizione. L'elenco dei registri non è scritto a mano nelle istruzioni, perché la descrizione di `tool_search` lo costruisce già dagli strumenti rinviati (ADR 0100) e una terza copia potrebbe andare fuori passo senza che un test se ne accorga.
- Resta nelle istruzioni la sola regola che quell'elenco non porta: le fatture da pagare o incassare si cercano con `invoices`, non con `file_search`.
- Le regole che solo le istruzioni avevano passano nella descrizione dello strumento: le conferme di incassi e pagamenti dall'estratto conto (invoices), cosa è listino, prezzi d'acquisto e magazzino (price_list), la rettifica dell'inventario (stock), sottoscorta e riordino (orders), la fattura differita entro il 15 (sales_invoices), il numero di un DDT annullato (ddt), il calendario Google solo su richiesta (appointments), l'IBAN cambiato da verificare per telefono (suppliers).
- Le frasi degli strumenti sempre offerti (file, web, memoria, liste, compiti, connettori) restano nelle istruzioni.
- Le istruzioni passano da 19.775 a 7.331 caratteri.

## Conseguenze

- Una regola di un registro si scrive in un posto solo, la sua descrizione, e arriva al modello solo quando il registro serve.
- Gli agenti già creati hanno le istruzioni salvate e tengono le frasi vecchie, che non contraddicono le descrizioni. Non c'è migrazione: chi vuole le istruzioni nuove le ripristina dalla console.
- Le istruzioni hanno di nuovo spazio sotto il limite di 20.000 caratteri.
- Aggiungere un registro non richiede di toccare le istruzioni né i test degli altri registri.
- Ogni test di registro controlla solo la regola nella descrizione del proprio strumento. Due test in `deferred-tools.test.ts` coprono la regola comune: ogni strumento rinviato compare nella descrizione di `tool_search`, e nessuna descrizione contiene un trattino lungo.
