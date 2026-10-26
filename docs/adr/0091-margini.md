# Margini

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `margins` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Con il listino (ADR 0084), il magazzino (ADR 0089) e i prezzi d'acquisto (ADR 0090) Owni sapeva a quanto la persona vende, quanto ha in magazzino e quanto paga, ma non quanto ci guadagna: «quanto guadagno sul toner?», «su cosa ci perdo?», «quanto mi rende Rossi?», «il listino è ancora giusto?» non avevano risposta.

## Decisione

- **Strumento `margins`**, solo lettura: `product`, `ranking`, `client`, `price_check`, `what_if`, `export`. Il periodo predefinito sono gli ultimi 12 mesi. Non salva margini: li ricava ogni volta dai registri che ci sono già.
- **Ricavo**: le righe delle fatture emesse senza IVA, con lo sconto di riga già tolto, meno le note di credito; le spese anticipate e il bollo non sono ricavo. Forfettario o no, i margini sono gli stessi: l'IVA non c'entra, e le tasse del forfettario stanno solo in una nota della simulazione, mai tolte.
- **Costo del venduto**: il costo medio del magazzino al momento di ogni vendita. Da questa settimana lo scarico di una vendita lo registra (`cost`), perché il costo medio di oggi non è quello di allora. Una vendita più vecchia, senza il costo registrato, si stima dall'ultimo prezzo d'acquisto di allora (fattura ricevuta o carico), e la risposta lo dice. Le quantità sono nell'unità dell'articolo, convertite solo con la sua confezione; una riga in un'altra unità resta fuori, e si dice. Le ore fatturate sono ricavo senza costo, a meno che la persona dica quanto le costa un'ora. Un servizio non ha costo: si dice il ricavo, mai un margine inventato.
- **Note di credito (M1)**: tolgono il ricavo e restituiscono il costo solo della merce che lo storno ha davvero rimesso in magazzino, mai più di quanto la fattura aveva scaricato. Una nota di credito senza storno (non è tornato niente) toglie il ricavo e non restituisce costo, e lo dice.
- **Anno chiuso (M2)**: la chiusura dell'anno del magazzino tiene il costo registrato di ogni vendita nella sua chiave (`SaleKey.c`), così i margini dell'anno chiuso restano quelli. Una vendita già chiusa senza costo prende il costo medio dell'apertura, come stima.
- **Acquisti per nome (M3)**: per un articolo i prezzi d'acquisto vengono dai codici e dalle descrizioni già confermati; per nome solo con le stesse parole in tutte e due le direzioni (mai una dentro l'altra) e un prodotto solo. Se più prodotti comprati hanno quel nome, si dice e non se ne sceglie nessuno.
- **Le stime non sono mai perdite**: un costo trovato solo dal nome è una «stima, da verificare»; una perdita su quel costo è «forse», mai «in perdita», e il brief non la dice.
- **Percentuali**: il margine sul prezzo, in decimi arrotondati per difetto. Il 100% è solo un margine senza costo, una perdita non diventa mai zero, e un margine minimo si dice «quasi niente, meno dello 0,1%».
- **Controllo del listino** (`price_check`): ogni voce legata a un articolo contro il costo medio di adesso (senza, l'ultimo acquisto), segnata sotto la soglia (20%, o quella detta dalla persona) o in perdita, con il prezzo che la riporta alla soglia, arrotondato per eccesso, anche a confezioni e IVA inclusa. Se quel prezzo non si riesce a calcolare, la riga resta e lo dice. Owni offre di aggiornare il listino, ma i prezzi li cambia `price_list` dopo la sua anteprima.
- **Simulazione** (`what_if`): un prezzo o un costo cambiato, in percentuale o in euro, sulle stesse quantità vendute. È solo un calcolo: non cambia niente.
- **Brief**: il lunedì e per tutta la settimana, le voci vendute la settimana prima sotto costo o sotto la soglia, ognuna una volta a settimana, tre al massimo fra tutti i brief; oltre, quante ne restano. Le voci già dette si ricordano in `margins.json` dell'istanza, con la copia `.bak`.
- **CSV** (`export`): una riga per voce venduta in `margini/` del workspace, con gli importi come numeri e le celle protette dalle formule.

## Sicurezza

- **Fiducia nel costo (L4)**: il `cost` di uno scarico lo scrive solo `planSale` in `stock-store.ts`, dai movimenti del magazzino stesso; non viene mai da un file, da una fattura o da un altro agente, e `validMove` lo accetta solo su uno scarico di vendita. È una fotografia: una correzione successiva del costo di un carico (`fix_cost`) non riscrive le vendite già fatte, e la risposta dice che quella vendita è al costo con cui è uscita.
- I margini dicono prezzi e costi: a un altro agente (`isAgentTurn`) `margins` non dà niente, nemmeno conteggi, con una frase sola. Nel brief del mattino legge soltanto; l'export lì è rifiutato.
- Nomi di prodotti e clienti, descrizioni delle righe e cose dette dalla persona stanno solo nel recinto dei «dati dei margini». L'audit registra operazione e conteggio, mai nomi, prezzi o costi.
- Un `margins.json` rovinato non viene mai sovrascritto: il brief lo dice e non segna niente.

## Alternative scartate

- **Il costo medio di oggi per tutte le vendite**: un carico a un prezzo nuovo cambiava il margine di un anno di vendite già fatte.
- **Ricalcolare il costo di ogni vendita dai movimenti**: dopo una chiusura d'anno i movimenti non ci sono più, e una correzione di costo cambiava il passato senza che nessuno lo vedesse.
- **Prendere per buono un acquisto con un nome simile**: «colla» e «colla stick XL» diventavano lo stesso prodotto, e una stima sbagliata appariva come una perdita.
- **Salvare i margini**: diventavano vecchi a ogni fattura o carico; leggerli dai registri ogni volta costa poco e non si sbaglia.
- **Aggiornare da sé il listino sotto soglia**: un prezzo cambiato senza anteprima arriva ai clienti; resta della persona, con `price_list`.
