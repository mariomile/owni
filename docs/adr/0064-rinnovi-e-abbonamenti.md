# Rinnovi e abbonamenti

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `renewals` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Assicurazioni, domini, software, affitti, utenze e contratti che si rinnovano da soli sono costi certi che nessuno guarda finché non arriva l'addebito o è troppo tardi per disdire. Con spese (ADR 0057) e ore (ADR 0058) Owni conosceva i soldi già usciti; ora conosce anche quelli che usciranno. «Ricordami che l'assicurazione dell'auto scade il 12 marzo, 480 euro l'anno», «Canva 12 euro al mese con la carta», «il contratto della fibra si rinnova da solo, disdetta 30 giorni prima», «quanto spendo di abbonamenti al mese?», «cosa scade nei prossimi 60 giorni?», «ho disdetto Netflix» e «ho pagato l'assicurazione» hanno una risposta.

## Decisione

- **Strumento `renewals`** con `add`, `list`, `upcoming`, `summary`, `renewed` (anche `paid`), `cancel`, `reactivate`, `edit`, `remove` ed `export`. I rinnovi stanno in `renewals.json` nella cartella dell'istanza, con la copia `.bak`, 2000 voci e 4 MB, attraverso `json-book.ts`. Numeri R-NNNN mai riusati. Si trovano anche per nome: «l'assicurazione dell'auto» o «il dominio» bastano, e se i candidati sono più d'uno Owni li elenca.
- **Due cose diverse, due campi.** `auto_renew`: il contratto si rinnova se non lo disdici. `auto_pay`: i soldi escono da soli (carta, PayPal, addebito in conto). Se `auto_pay` non è detto, Owni lo deduce solo per un contratto che si rinnova da solo pagato con carta, PayPal o addebito, e lo dice alla persona; mai per qualcosa che non si rinnova da solo, così una RC auto pagata online con la carta non sparisce dagli avvisi.
- **Cosa si vede dopo la scadenza.** Per le voci con uno dei due campi, la prossima scadenza mostrata va avanti da sola di periodo in periodo (calcolata alla lettura, il file si aggiorna alla scrittura successiva). Con addebito automatico non c'è mai «scaduto» né «da pagare»: solo la data entro cui disdire e, per i periodi da 6 mesi in su, un avviso prima dell'addebito. Rinnovo da solo ma pagamento a mano: «da pagare» finché la persona non conferma. Nessuno dei due: «scaduto il …: l'hai rinnovato o lasciato scadere?». Niente si sposta mai in silenzio per le voci a mano.
- **Date.** Il giorno di partenza resta fisso: un mensile del 31 gennaio va al 28 o 29 febbraio e torna al 31 marzo. Una data senza anno è la prossima occorrenza; per i periodi più brevi di un anno Owni avanza di mesi («5 ottobre» mensile, detto il 18 ottobre, è il 5 novembre). «Fine mese», «il 15 di ogni mese», «primo gennaio», «fine anno», «tra un mese» sono date valide; più di 10 anni avanti no.
- **Disdetta** in giorni o in mesi prima della scadenza, o alla fine di una durata contrattuale (`term_months`) diversa da quanto spesso si paga. Per i periodi sotto i 3 mesi il preavviso è un'informazione, non un allarme ogni mese. Una disdetta registrata tiene la storia, con data e fine effettiva, e avvisa se è arrivata dopo il termine.
- **Pagato.** `renewed` sposta la scadenza di un periodo dalla scadenza, non da oggi, una sola volta per richiesta; rifiuta se la scadenza è ancora lontana o se è già stata spostata oggi, salvo `advance`. Con `record_expense` registra anche la spesa (con l'IVA, se nota) attraverso il dominio delle spese, una sola volta anche se la richiesta si ripete, controllando prima che la spesa si possa registrare. Per un addebito automatico registra solo la spesa dell'ultimo addebito.
- **Costi** in centesimi bigint: costo annuo = importo × 12 / mesi del periodo, arrotondato al centesimo per voce; media mensile = totale annuo / 12. Riepilogo per categoria con «X € all'anno (Y € al mese)». «Cosa scade nei prossimi 60 giorni» conta ogni addebito del periodo, anche due di un mensile. Importi «+ IVA» si salvano IVA compresa con l'aliquota; valute estere con l'importo in euro detto dalla persona e quello originale nella nota; un aumento futuro (`new_amount` da una data) vale dalla scadenza che la raggiunge; una prova gratuita dice «la prova finisce il …: disdici prima se non lo vuoi».
- **Brief**: una riga solo per ciò che è nella sua finestra di avviso o scaduto. Per un promemoria a un'ora precisa Owni usa `schedule_create`: nessun secondo scheduler.
- **Export CSV** in `rinnovi/` con nome, fornitore, categoria, importo, frequenza, costo annuo, prossima scadenza, disdetta entro e stato.

## Sicurezza

- Nomi, fornitori, note e percorsi tornano al modello solo dentro il recinto dei dati non fidati; nei gruppi di `upcoming` i titoli stanno fuori e le righe dentro.
- Il documento del contratto si salva solo come percorso di un file esistente nel workspace, senza link simbolici, cartelle nascoste o `..`.
- Dal canale degli agenti e nel brief solo `list`, `upcoming` e `summary`; il collegamento con le spese ha un suo controllo sul canale degli agenti. L'audit registra operazione e numero, mai nomi, importi o date, anche quando una richiesta si ripete.

## Alternative scartate

- **Spostare da sole tutte le scadenze passate**: una polizza pagata a mano e dimenticata sparirebbe dagli avvisi.
- **Un promemoria programmato per ogni rinnovo**: duplicherebbe lo scheduler e moltiplicherebbe i messaggi; il brief basta, e per l'ora precisa c'è `schedule_create`.
- **Confronto automatico con le spese dell'anno prima**: le categorie non coincidono una a una e il numero sarebbe fuorviante.
