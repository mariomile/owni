# Fatture elettroniche (FatturaPA)

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): il riepilogo delle fatture elettroniche non c'è più: un file FatturaPA si legge come testo o con `code_run`. I file firmati `.p7m` si aprono ancora.

Le imprese italiane ricevono le fatture dallo SdI come file XML FatturaPA (`IT01234567890_00001.xml`), spesso firmati come `.xml.p7m`. Fino alla settimana 46 Owni li leggeva come testo grezzo o non li leggeva affatto: tag, codici come TD04, MP05, N6.3, e niente che dicesse a chi paga l'IVA o quando scade.

## Decisione

- **Un nuovo tipo di documento**, «fattura elettronica (FatturaPA)», dentro `documents.ts`: allegati in chat, `file_read`, `file_search`, `web_read`, la ricerca approfondita e `web_download` lo leggono senza cambiare gli strumenti. Riconosciuto dal contenuto (radice `FatturaElettronica` nel namespace dell'Agenzia, FPA12, FPR12 e la semplificata FSM10), non dall'estensione; gli altri XML restano testo.
- **Un riepilogo in italiano** (`src/core/fattura-pa.ts`, tabelle in `fattura-pa-codes.ts`), dentro il recinto dei dati esterni. La prima riga dice chi, cosa, quanto e quando («Fattura n. … del … da … a …, totale …, scadenza …»); poi fornitore e cliente con il controllo formale della partita IVA, righe, riepilogo IVA, cassa, ritenuta, bollo, riferimenti (ordine, DDT, CIG, CUP), pagamento, allegati (solo i nomi), e la trasmissione in fondo.
- **Il significato prima del codice**, e quello che conta per chi legge: una nota di credito dice che gli importi sono a favore del cliente; lo split payment dice che l'IVA la versa la pubblica amministrazione; il reverse charge dice che la versa il cliente; ritenute e contributi dicono chi li trattiene; «Da pagare» compare quando il dovuto è diverso dal totale.
- **La scadenza è quella scritta in fattura.** Se i giorni dei termini portano a un'altra data, il riepilogo lo dice («come scritta in fattura (30 giorni dal … sarebbero …)»); «fine mese» non si può scrivere nel tracciato, ma Owni lo riconosce quando la data torna. Le istruzioni dicono di usare `date_calc` solo per i giorni che mancano o se la data non c'è.
- **File firmati (.p7m)**: un lettore DER/BER limitato (`src/core/p7m.ts`) estrae il documento dalla busta CMS, anche in base64 o PEM e anche firmato due volte. La firma non viene verificata e il riepilogo lo dice. Un PDF, un Word, un Excel o un testo firmati si leggono come il documento che contengono; per riconoscerli basta l'inizio della busta.
- **Niente rete**: tutto gira nel worker dei documenti, con i suoi limiti.

## Sicurezza

- Il lettore XML (`src/core/xml-tree.ts`) rifiuta DOCTYPE ed entità: nessuna espansione, nessun file esterno. Limiti: 20 MB, 100.000 elementi, profondità 64; oltre i 20 MB la fattura si legge come XML a pezzi, senza il contenuto degli allegati.
- Riconoscere un file sul thread principale legge al più 256 KB della busta; ogni byte si legge una volta, con un tetto agli elementi e ai pezzi, così un `.p7m` costruito apposta non blocca il server.
- I riferimenti a caratteri non producono caratteri di controllo, surrogati soli o caratteri che invertono la direzione del testo (che potrebbero mascherare un IBAN); ogni valore sta su una riga, i caratteri di direzione scritti nel testo vengono tolti, e un testo che imita i segni del recinto viene neutralizzato nei documenti letti con `file_read`, nelle tabelle e nei risultati di `file_search`.
- Importi e quantità si scrivono partendo dalle cifre, senza passare per numeri a virgola mobile.
- Niente audit e niente log con il contenuto delle fatture.

## Alternative scartate

- **Un parser XML come dipendenza**: per un tracciato noto e senza DTD basta un lettore piccolo e limitato, senza le superfici di attacco dei parser generici.
- **Verificare la firma**: servono i certificati delle autorità e le liste di revoca, e lo SdI ha già controllato la fattura; Owni dice che non l'ha verificata.
- **Il foglio di stile dell'Agenzia**: produce HTML pensato per la stampa, lungo e pieno di codici; il riepilogo spiega quello che serve a chi deve pagare.
