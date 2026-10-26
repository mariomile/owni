# Magazzino

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `stock` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Un negozio o un artigiano vuole sapere quanta merce ha, cosa sta finendo e quanto vale. Il listino (settimana 64) diceva i prezzi, ma non le quantità, e una fattura emessa non toglieva niente da nessuna parte.

## Decisione

- **Strumento `stock`** con `add_item`, `receive` (carico), `unload` (scarico per vendita, uso interno, reso o scarto), `count` (inventario), `status`, `list`, `low` (sottoscorta), `value`, `movements`, `remove_item`, `fix_cost`, `close_year` ed `export`. Gli articoli (MG-NNNN) e i movimenti (MV-NNNNNN) stanno in `stock.json` con lo schema dei registri (lock, copia `.bak`, file rovinato mai sovrascritto).
- **I movimenti non si toccano**: si aggiungono soltanto, e la quantità in magazzino si ricalcola sempre da loro. L'inventario scrive una rettifica con la differenza; un costo sbagliato dell'ultimo carico si corregge con `fix_cost`, che rifà la media come se quel carico avesse avuto il costo giusto.
- **Costo medio ponderato**: cambia solo con un carico; scarichi, rettifiche e resi vanno al costo medio. Quantità con 3 decimali (kg, metri, litri), costi a un centesimo di centesimo, valore in centesimi arrotondato una volta sola alla fine: l'errore della media cresce al massimo di 0,00005 € per unità a ogni carico.
- **Nomi e confezioni**: «cartuccia xl» e «rotoli di carta» trovano «Cartucce XL» e «rotolo carta» (`name-keys.ts`: singolare e plurale dello stesso genere, parole vuote tolte; mai «colla» per «collo»). Per leggere Owni prende l'articolo e lo dice; per scrivere, se il nome non è esattamente quello, chiede «Intendi questo articolo?». Il primo carico di un articolo nuovo lo crea, dalla voce del listino con lo stesso nome se c'è. «3 scatole da 12 a 30 € la scatola» diventa 36 pezzi a 2,50 €, detto nella risposta; un articolo può avere la sua confezione, e una riga di fattura in scatole scarica i pezzi giusti.
- **Fatture**: le righe di una fattura in uscita tengono la voce del listino; quando la fattura è emessa (mai una bozza), ogni riga legata a un articolo lo scarica una volta sola (chiave fattura e riga), e una nota di credito ricarica al massimo quello che la fattura aveva scaricato. L'anteprima dell'emissione dice cosa scaricherà e avvisa prima di andare in negativo; una riga che sembra un articolo ma non è una voce del listino viene detta, non scaricata.
- **Negativo**: uno scarico oltre quello che c'è si chiede una volta, e con il sì della persona resta segnato «in negativo» fino al prossimo inventario.
- **Avvisi nel brief**: una riga quando un articolo scende sotto il suo minimo, una volta per discesa, e una quando va in negativo.
- **Anno chiuso**: `close_year` sostituisce i movimenti fino a fine anno con un movimento di apertura per articolo, con quantità, costo medio e stato esatti, e tiene le chiavi delle vendite per le note di credito; serve quando il file si avvicina al limite di 20.000 movimenti, e Owni lo dice.

## Sicurezza

- Carichi con costo, inventari, scarichi in negativo, correzioni di costo, chiusura dell'anno ed eliminazione di un articolo si confermano solo in un turno della persona (ADR 0088).
- Nomi, codici, posti, note, fornitori e riferimenti solo nel recinto dei dati non fidati. Agli altri agenti `list` e `low` con nomi e quantità, mai costi, valori, fornitori o movimenti: i nomi degli articoli non sono dati personali, e le quantità da sole non dicono soldi. L'audit registra operazione e conteggio. CSV con celle protette dalle formule, mai sovrascritto.
- Un `stock.json` modificato a mano con una forma valida non viene riconosciuto: oltre al controllo della forma (id, ordine, tipi, unicità) è fuori dallo scopo.
- Se il magazzino è pieno o non si legge, la fattura è numerata e scritta, ma resta da completare: Owni lo dice, e si completa emettendo di nuovo dopo aver chiuso l'anno o ripristinato il file.

## Alternative scartate

- **Salvare la quantità invece dei movimenti**: un inventario o una correzione cancellavano la storia.
- **Costo FIFO**: più preciso per chi rivende a prezzi molto diversi, ma difficile da spiegare a parole e da correggere; il costo medio basta per un piccolo negozio.
- **Caricare da sole le fatture dei fornitori**: le fatture lette dallo scadenzario non hanno righe strutturate; resta da fare, come proposta da confermare.
- **Scaricare con le fatture ricorrenti**: i loro mesi rimasti fuori riscrivono la quantità a 1; per ora non scaricano.
