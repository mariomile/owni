# Andamento dell'attività

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `business_report` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Con fatture (ADR 0053, 0072), spese (ADR 0057), ore, preventivi (ADR 0055), clienti (ADR 0071), tasse del forfettario (ADR 0070), liquidazione IVA (ADR 0077) ed estratto conto (ADR 0078) Owni aveva tutti i numeri di chi ha una partita IVA, ma sparsi in registri diversi. La domanda che li tiene insieme è una: «come sta andando l'attività?». Ora «quanto ho guadagnato quest'anno?», «ottobre rispetto a settembre?», «rispetto all'anno scorso?», «qual è il mio margine?», «quanto mi resta in tasca dopo le tasse?» e «mandami il report del mese per il commercialista» hanno una risposta.

## Decisione

- **Strumento `business_report`** con `summary`, `compare`, `trend`, `top` ed `export`. Non ha un registro suo e non scrive in nessun registro: legge quelli che ci sono attraverso le loro funzioni.
- **Le cifre**, ognuna da un solo posto:
  - fatturato: le fatture emesse per data della fattura, contate una volta fra quelle fatte con Owni e quelle in XML, note di credito tolte (le stesse regole della liquidazione IVA);
  - incassato: per giorno del pagamento, quello della banca se viene dall'estratto conto;
  - spese: le spese registrate più le fatture dei fornitori pagate che nessuna spesa rappresenta già. Ogni spesa vale al più il suo importo: con partita IVA e numero, o sul totale della fattura, copre tutte le rate di quella fattura; sul solo importo ne copre una, e solo se il fornitore non dice un nome diverso. Gli stessi abbinamenti valgono nella previsione di cassa. I rinnovi contano attraverso la spesa che li registra;
  - margine: incassato meno spese, per cassa;
  - tasse: per il forfettario la percentuale della stima dell'anno, portata a fine anno come fa `taxes`, applicata agli incassi del periodo, e allora «ti resta in tasca»; per l'ordinario l'IVA da versare e «dopo l'IVA, prima di IRPEF e contributi», che Owni non stima. Senza profilo lo dice e spiega come darlo;
  - ore e preventivi del periodo, e il fatturato diviso le ore registrate solo da 10 ore in su, come rapporto grezzo;
  - ancora da incassare e scaduto.
- **Periodi** che finiscono oggi: un mese in corso si confronta con gli stessi giorni del mese prima, un periodo detto con altrettanti giorni subito prima, l'anno scorso con lo stesso periodo (il 29 febbraio diventa il 28). Nessuna percentuale se prima era zero, negativo o meno di un decimo di adesso: «da X a Y». Prima le tre differenze più grandi fra fatturato, incassato e spese.
- **Trend** mese per mese, 6 mesi in chat e fino a 24, i mesi vuoti all'inizio in una riga. Nessun grafico proprio: se la persona lo chiede, il modello passa le cifre a `chart_create`.
- **Top**: dove si spende per categoria e quanto pesano i primi clienti, con l'avviso di dipendenza solo quando il primo pesa davvero più degli altri. La classifica dei clienti resta di `clients`.
- **Export** CSV in `report/` del workspace; senza periodo è il mese chiuso, e lo dice.
- **Brief**: il primo giorno feriale del mese una riga sul mese chiuso, «Ottobre chiuso: incassati …, spese …, margine … (+N% su settembre)».

## Sicurezza

- Nomi di clienti e categorie solo dentro un recinto dei dati non fidati per risposta. CSV con celle protette dalle formule, nome del file solo dalle date, mai sovrascritto.
- Un registro rovinato è detto e non viene mai scritto. Solo `export` scrive, un file; l'audit registra operazione e conteggi.
- Dal canale degli agenti solo `summary` e `trend`, senza nomi; il brief usa solo `summary`.

## Alternative scartate

- **Un registro del report con cifre salvate**: si sarebbe disallineato dai registri veri alla prima fattura corretta.
- **Stimare IRPEF e contributi dell'ordinario**: servono deduzioni, detrazioni e redditi che Owni non conosce; meglio dire cosa manca.
- **La stima delle tasse dagli incassi dell'anno finora**: i contributi fissi di un anno intero finivano su un mese, e a gennaio le tasse superavano gli incassi.
- **Una spesa che rappresenta più pagamenti**: una spesa da 500 € faceva sparire due fatture da 500 € di fornitori diversi.
