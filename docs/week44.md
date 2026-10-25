# Settimana 44: partita IVA

Branch `week-44`. Chi fattura controlla partite IVA e codici fiscali di continuo. Ora `vat_check` fa il controllo formale (cifra di controllo, ufficio IVA, codice fiscale con omocodia, forma dei numeri IVA europei) sempre, senza rete, e con `OWNI_VAT_CHECK=1` chiede al VIES della Commissione europea se un numero è attivo, con nome, indirizzo e ora del controllo. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0047](adr/0047-partita-iva.md).

## Cosa cambia per chi usa Owni

- **«La partita IVA 01234567890 è valida?»**: «la cifra di controllo non torna», senza chiamare nessuno.
- **«Di chi è la P.IVA IT00000500157?»**: attiva nel VIES, con nome, indirizzo e ora del controllo.
- **«Controlla questa partita IVA tedesca»**: la forma tedesca e il VIES; la Germania non dà nome e indirizzo, e Owni lo dice.
- **Una partita IVA non attiva nel VIES**: Owni spiega che non vuol dire inesistente e rimanda a «Verifica partita IVA» dell'Agenzia delle Entrate.
- **«Questo codice fiscale è giusto?»**: il controllo formale, con sesso e data di nascita, e il limite detto chiaro (all'Agenzia non può chiedere).
- **Il codice fiscale di un'associazione** (comincia con 8 o 9): scritto giusto, ma non è una partita IVA e non è nel VIES.

## Cosa funziona (verificato dai test)

- Validatori: cifra di controllo, uffici IVA, matricola a zero, enti 8/9, codice fiscale con omocodia da destra, mesi, giorni, secolo ambiguo, forme europee (EL, XI), etichette e separatori (`test/vat.test.ts`).
- VIES con risposte finte: attivo, non attivo, ogni errore del VIES, risposte illeggibili, troppo grandi, rimandi rifiutati, tempo scaduto, cache per account, quota per account e per server.
- Risposte: forma compatta, articoli giusti davanti ai paesi, nome e indirizzo nel recinto, codici d'errore sconosciuti non ripetuti, brief solo con il controllo formale, nessun audit con il numero.

## Revisioni

Prima revisione (sicurezza e risposte), corretta:

- I numeri che cominciano con 8 o 9 saltavano il controllo dell'ufficio e andavano al VIES: ora sono enti, detti come tali, senza VIES.
- La cache era condivisa fra clienti dello stesso server: ora è per account. Aggiunta la quota per server.
- Codici d'errore del VIES ripetuti fuori dal recinto, omocodia in ordine sbagliato, matricola tutta a zero, Irlanda del Nord: corretti.
- Il recinto dei dati esterni ora neutralizza i testi che imitano i suoi segni, per tutti gli strumenti; la seconda revisione l'ha ristretto ai soli segni, perché cambiare ogni `>>>` rovinava codice e mail citate.
- Testi: «dell'Italia» e non «di Italia», «numero IVA» per i paesi esteri, il rimando all'Agenzia anche senza VIES, il secolo ambiguo del codice fiscale, istruzioni che escludono la ricerca sul web.
- Funzioni di formattazione condivise in `italian-format.ts`.

Seconda revisione, corretta: recinto ristretto ai segni veri (anche per mail e computer), nessun «va bene» per una partita IVA non attiva nel VIES, altre etichette tolte («P.I.», «Cod. Fisc.»), il brief che non va mai al VIES anche senza conversazione nota, codici degli enti senza «IT» davanti.

## Da fare

- Provare l'indirizzo del VIES con `pnpm owni check` su un server con rete: da qui il proxy blocca il sito della Commissione.
- ~~Segreteria: usare il controllo formale sulla partita IVA estratta dalle mail~~ fatto nella settimana 46.
