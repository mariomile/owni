# 0123: Incarichi, Automazioni e Pratiche come pagine della barra laterale

Mario: «Non mi interessa avere questi tab interni. Meglio più pagine nella sidebar». La voce «Lavori» apriva la Board e, sopra, una barra di linguette con Incarichi, Automazioni e Pratiche: due livelli di navigazione per tre posti, e il nome della voce non diceva cosa si apriva.

## Decisione

- **Tre voci nella barra laterale**: Incarichi (`#/board`), Automazioni (`#/programmi`) e Pratiche (`#/segreteria`, solo se un agente ha la Segreteria, aperta su quell'agente). «Richiede te» resta sotto, con il suo conteggio.
- **Nessuna barra di linguette** sopra queste pagine. Orari e pagine da controllare ed Eventi esterni si aprono da Automazioni, che resta evidenziata nella barra laterale.
- La voce è evidenziata quando la pagina aperta è la sua, o una pagina che le appartiene (`under` in `PAGES`).

## Alternative scartate

- **Tenere «Lavori» come gruppo con sotto-voci a scomparsa.** Un clic in più per aprire la Board, che è la pagina più usata.
- **Togliere le linguette lasciando Automazioni solo nella palette dei comandi.** Le automazioni non si troverebbero più a vista.

## Conseguenze

- Nessun indirizzo cambia e nessuna API cambia.
- La barra laterale ha una voce in più (due con la Segreteria).
