# Clienti

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `clients` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Fatture, solleciti, preventivi e ore (ADR 0051-0058) sapevano tutto dei soldi di un cliente, ma niente di chi è: il referente, il telefono, come preferisce essere sentito, cosa ci si è detti l'ultima volta e quando richiamarlo. La domanda di chi ha una partita IVA è «cosa so di Rossi?» e «chi devo richiamare?». Ora «cosa so di Rossi?», «chi sono i miei clienti migliori?», «chi non sento da tre mesi?», «ricordami di ricontattare Beta tra due settimane», «ho sentito Beta» e «Rossi e Rossi Mario sono lo stesso cliente» hanno una risposta.

## Decisione

- **Strumento `clients`** con `show`, `list`, `top`, `dormant`, `agenda`, `upsert`, `note`, `follow_up`, `postpone`, `cancel_follow_up`, `done`, `merge`, `remove` ed `export`. Le schede (CL-NNNN) stanno in `clients.json` nella cartella dell'istanza, con la copia `.bak`, attraverso `json-book.ts`: 5.000 schede, 16 MB, ricontatti FU-NNNN mai riusati.
- **La scheda tiene solo quello che dice la persona**: come scrive il nome, partita IVA o codice fiscale, altri nomi, referenti con ruolo, telefono, email e canale preferito, indirizzo, etichette, note datate, ricontatti e contatti avuti. Fatturato, incassato, solleciti, preventivi e ore si leggono dai loro registri e non si copiano mai: un cliente che compare lì è un cliente anche senza scheda.
- **Chi è lo stesso cliente**: stessa partita IVA o codice fiscale; altrimenti stesso nome a meno della forma societaria («Acme» e «Acme Srl»). Un nome che è solo contenuto in un altro («Rossi» e «Mario Rossi») non basta: Owni chiede «se è lui» prima di scrivere. Una scheda senza partita IVA non si lega a un nome che nei registri ha due o più partite IVA.
- **Numeri**: fatturato come imponibile, con l'IVA fra parentesi; incassato IVA inclusa e al netto delle note di credito usate, che sono dette a parte («chiuse con note di credito, non incassate»). Classifica degli ultimi 12 mesi (o anno, trimestre, mese) per fatturato o incassato, con la quota di ognuno; un cliente oltre il 40% è una concentrazione.
- **Dormienti**: nessuna attività da 90 giorni (o quanti detti) e fatturati negli ultimi due anni; chi ha già un ricontatto fissato resta fuori, a meno di chiederlo.
- **Ricontatti** con un promemoria alle 9 del giorno fissato, legato al ricontatto (chiave della chiamata più FU-NNNN) e fatto prima della scrittura che lo collega. Spostarlo, toglierlo o segnarlo fatto toglie il promemoria vecchio, anche se la chiamata è ripetuta dopo un errore. Un promemoria di un ricontatto che non c'è più lo dice e non ricorda niente. I giorni contati da oggi passano al primo giorno lavorativo; una data detta che cade di festa resta, e Owni chiede se spostarla.
- **Unire** due schede mostra prima cosa succede e scrive solo con la conferma; i ricontatti e i loro promemoria passano alla scheda che resta.
- **Brief** (voce 13): ricontatti in ritardo e quelli di oggi senza promemoria, e una concentrazione passata negli ultimi 30 giorni; altrimenti niente.
- **Export** CSV in `clienti/` del workspace, nome dalla data, mai sovrascritto, celle protette dalle formule. Togliere una scheda ricorda i file esportati che contengono ancora quei dati.

## Sicurezza e concorrenza

- Ogni scrittura passa da `updateBook` sotto il lock e riconosce la stessa chiamata ripetuta. I promemoria vecchi da togliere sono annotati nel passo della chiamata prima di scrivere, così un riavvio a metà non lascia promemoria orfani. Un promemoria disattivato perché la persona non è più ammessa viene cancellato e non conta nel limite.
- Nomi, note, referenti e testi dei ricontatti tornano al modello solo dentro un recinto dei dati non fidati. L'audit registra `clients.changed` con operazione e numero, mai nomi, importi, date, note o contatti.
- Dal canale degli agenti solo `top` e `dormant`, ridotti a totali, conteggi e quote: niente nomi, date o testi dei ricontatti. Schede, liste, agenda e scritture sono rifiutate.

## Alternative scartate

- **Copiare fatturato e incassato nella scheda**: due verità che si separano alla prima fattura modificata.
- **Unire da soli i clienti con un nome simile**: «Rossi Srl» e «Rossi Impianti» sono spesso due clienti; Owni lo segnala e chiede.
- **Un CRM con pipeline e fasi**: per una partita IVA bastano chi è, cosa ci si è detti e quando richiamare.
