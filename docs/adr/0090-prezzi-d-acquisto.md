# Prezzi d'acquisto

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `purchase_prices` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Le fatture dei fornitori arrivano con le righe (DettaglioLinee), ma Owni ne leggeva solo il testo: «quanto pago la carta A4 da Beta?», «chi me la vende meno cara?», «quali prezzi sono aumentati?» non avevano risposta, e la merce di una fattura andava caricata in magazzino a mano (la settimana 69 lo aveva lasciato aperto).

## Decisione

- **Righe strutturate**: il lettore FatturaPA espone le righe dei documenti ordinari (descrizione, quantità, unità, prezzo, totale, IVA o natura, codice articolo, tipo di riga) come decimali esatti; una riga che non si legge si conta e si salta, mai indovinata; al massimo 2000 righe per documento. Solo le fatture ricevute le tengono nello scadenzario. Le semplificate e i file oltre 20 MB non hanno righe, e Owni lo dice.
- **Prezzo d'acquisto**: totale della riga diviso la quantità, senza IVA. Le righe di sconto (SC, AB) e lo sconto o la maggiorazione di tutto il documento si dividono sulle righe di merce in proporzione ai loro totali (mai fino a zero), e la risposta lo dice; le spese accessorie (AC, come il trasporto) sono «spese della fattura», non prodotti, e non entrano nei costi. Una riga senza quantità è «a corpo» e non si confronta. Unità diverse sono prodotti diversi; le sigle delle fatture (PZ, NR, RS, CF, CT…) diventano unità vere.
- **Strumento `purchase_prices`**, solo lettura: `item`, `supplier`, `compare`, `increases`, `export`. Un prodotto è lo stesso nome al singolare o plurale, o lo stesso codice dello stesso fornitore; quando la persona nomina un prodotto, si confrontano tutte le righe con quelle parole nella stessa unità, ognuna con la sua descrizione. Abbreviazioni come «80GR», «RS500» e «FF» si sciolgono solo per le righe delle fatture.
- **Aumenti**: l'ultimo acquisto da un fornitore contro il precedente di un'altra fattura, sui prezzi già scontati, dal 5%. Nel brief una riga per fornitore e prodotto, una volta per riga di fattura, al massimo tre al giorno e una per fornitore, con la data e il prezzo di prima; gli altri il giorno dopo. Anche la risposta su una fattura ricevuta dice i suoi aumenti, una volta.
- **Carico da una fattura** (`stock receive_invoice`): Owni propone articolo, quantità e costo per ogni riga (dal codice o dalla descrizione già confermati per quel fornitore, dal codice dell'articolo, o dallo stesso nome «da confermare»), dice le righe che non carica e perché, e carica solo con il sì della persona. Il sì porta un controllo della proposta: se qualcosa è cambiato nel frattempo (un file nuovo, un prezzo, un articolo), non carica niente e mostra la proposta nuova. Ogni riga si carica una volta sola, anche dopo la chiusura dell'anno. Codici, descrizioni e conversioni di unità confermati si ricordano per quel fornitore.

## Sicurezza

- Le fatture dei fornitori sono testo di altri: descrizioni, codici, numeri e nomi solo nel recinto dei dati non fidati, il numero tagliato a 20 caratteri. Un codice già imparato con una descrizione che non è quella dell'articolo, un costo tre volte sopra o sotto la media, la stessa merce di una fattura di meno di 60 giorni prima e date impossibili si segnalano o si saltano.
- Il carico si conferma solo in un turno della persona (ADR 0088); un altro agente non può né proporre né caricare. Un turno è di un altro agente sia sul canale degli agenti sia quando un agente chiama Owni in una stanza: un solo controllo, `isAgentTurn` in `turn-origin.ts`, vale per tutti gli strumenti che rispondono diversamente agli agenti.
- Agli altri agenti `purchase_prices` dà solo conteggi (quanti acquisti, da quanti fornitori, quanti prodotti aumentati, con soglie e periodi fissi): quello che l'attività paga dice i suoi margini, e un agente che parla con i clienti potrebbe ripeterlo. L'audit registra operazione e conteggio. CSV con celle protette dalle formule.

## Alternative scartate

- **Caricare da sole le fatture dei fornitori**: una fattura sbagliata o falsa sposterebbe il costo medio, che non si annulla.
- **Unire i prodotti per somiglianza**: «colla» e «collo» diventavano lo stesso prodotto; meglio confrontare per le parole che dice la persona.
- **Ignorare gli sconti**: i prezzi e i costi di carico risultavano più alti, e un aumento poteva essere solo uno sconto mancato.
- **Sommare tutti gli sconti che la fattura scrive**: molti programmi ripetono lo sconto di riga nell'intestazione, e si contava due volte; ora si divide solo lo sconto che fa tornare il riepilogo IVA, e se non torna si dice.
