# Settimana 28: immagini su richiesta

Branch `week-28`. Decisione: [ADR 0023](adr/0023-immagini-su-richiesta.md). Owni crea immagini quando gliele chiedono (illustrazioni, loghi, volantini) e ritocca le foto che le mandano; le immagini arrivano in chat con la didascalia e restano tra i file. Serve un servizio di immagini ([chiavi](chiavi.md) §15); i test usano un servizio finto.

## Cosa funziona (verificato dai test)

- **Servizio** (`test/image-generation.test.ts`): una richiesta con la forma scelta e la chiave nell'intestazione; varianti, sfondo trasparente, qualità; il ritocco manda la foto come file e, senza forma, tiene le proporzioni; DALL·E 3 con le sue misure, una richiesta per variante, e un rifiuto prima di chiedere un ritocco o uno sfondo trasparente. Errori in parole semplici, mai con la chiave o la descrizione; un link al posto dei byte o byte che non sono un'immagine rifiutati; una corsa fermata ferma la richiesta.
- **Istanza**: spenta finché l'owner non la accende (solo l'owner); poi crea, salva in `immagini/` e manda in chat; ritocca una foto del workspace, rifiuta un file che non è un'immagine. Il conto del giorno: solo le immagini fatte contano, un rifiuto no; varianti oltre quelle rimaste rifiutate prima. Audit senza descrizione.
- **Chat**: su Telegram e WhatsApp un JPEG o PNG va come foto, con la didascalia; se l'app non lo prende come foto, come documento. Il resto come prima.
- **Console** (Chromium, desktop e telefono, nessun errore): la card «Immagini» con il servizio e il limite del giorno, l'immagine nel messaggio con la didascalia, il passo «Fatti creare un'immagine» in Primi passi.

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Media.** Ogni JPEG o PNG andava come foto senza ripiego: un'immagine che Telegram o WhatsApp rifiutano come foto non arrivava più; ora va come documento. Il conto del giorno si consumava anche con un rifiuto o un errore. Un ritocco senza forma diventava quadrato.
- **Bassa.** Corsa fermata che lasciava la richiesta aperta due minuti; una copia in più dell'immagine in memoria; DALL·E 3 con un ritocco riceveva un 400 generico; nome del file vuoto per una descrizione senza lettere latine; immagine non valida in console chiamata «non c'è più»; testo nell'immagine a rischio di traduzione; errori senza cosa fare; invio fallito in inglese; niente didascalia, varianti, sfondo trasparente, qualità; Primi passi senza le immagini; testo della card ambiguo e senza limite del giorno; WebP non accettato da WhatsApp come documento.

Lasciati e scritti nell'ADR: la foto compressa dall'app, un solo `from`, il conto che riparte al riavvio.

## Limiti

| Cosa | Limite |
|---|---|
| Immagini al giorno | `OWNI_IMAGE_MAX_PER_DAY` per account (100), solo quelle fatte |
| Varianti | da 1 a 4 per richiesta |
| Descrizione | 4.000 caratteri |
| Foto da ritoccare | JPEG, PNG o WebP fino a 20 MB |
| Attesa del servizio | due minuti |
| Foto in chat | Telegram 10 MB, WhatsApp 5 MB; oltre, documento |
