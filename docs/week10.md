# Settimana 10: Owni legge il web

Branch `week-10`. Decisione: [ADR 0009](adr/0009-navigazione-web-in-sola-lettura.md). Mario ha scelto di iniziare la Fase 3 dalla navigazione web.

## Cosa funziona (verificato dai test)

- **`web_read`** (`test/web-tools.test.ts`): legge una pagina http(s) e restituisce titolo e testo (al massimo 12.000 caratteri, pagine fino a 2 MB, 15 secondi), marcati come dati con un'etichetta casuale.
- **`web_screenshot`**: apre la pagina in Chromium headless (1280×800, o intera), senza download, e salva un PNG nel workspace (`screenshot/…`), da mandare con `file_send`. Provato con un Chromium vero: l'immagine che la pagina carica da un host non consentito viene bloccata (il server di quell'host non riceve richieste).
- **Siti consentiti**: in Impostazioni l'owner li elenca per istanza; vuoto vuol dire nessuno, `*` tutti i siti pubblici. Il cambio finisce nell'audit (quanti siti, se c'è `*`, mai l'elenco).
- **Mai dentro una rete**: loopback, reti private, link-local, CGNAT, multicast, metadati del cloud e le loro forme IPv6 sono rifiutati, sull'indirizzo a cui ci si connette davvero e dopo ogni redirect (un redirect verso `169.254.169.254` è rifiutato anche con `*`). Solo http e https, niente credenziali nell'indirizzo.
- **Immagine Docker**: Chromium facoltativo con `--build-arg WITH_BROWSER=1`; senza, gli screenshot rispondono che non sono disponibili.
- **Ordine dei messaggi nella console** (`test/web-channel.test.ts`). Bug trovato dalla suite sotto carico: il messaggio di una persona veniva scritto dopo averlo passato a Owni, e una risposta molto veloce poteva finire nella conversazione prima della domanda. Ora le scritture di un thread vanno una alla volta; il test fallisce senza la correzione.
- **Immagine pubblicata con Chromium**: il job che pubblica su GHCR costruisce con `WITH_BROWSER=1` e controlla che il container risponda. (La pubblicazione senza artifact è su `main` dalla PR #9.)

## Review indipendente

Due revisori separati. Corretti:

- **Alta.** Gli indirizzi IPv4 scritti in forma IPv6 esadecimale (`[::ffff:a9fe:a9fe]`, quello che il parser degli URL fa di `[::ffff:169.254.169.254]`) passavano per pubblici: con `*` si arrivava ai metadati del cloud o al loopback. Ora l'indirizzo IPv6 si normalizza e si guarda l'IPv4 dentro (anche 6to4, Teredo, NAT64). Negli screenshot Chromium seguiva i redirect da solo senza controlli, apriva WebSocket e service worker e risolveva il DNS per conto suo: ora non tocca la rete, ogni richiesta gliela serviamo noi. Chromium girava senza sandbox accanto ai segreti della cella: ora il sandbox è richiesto (o gli screenshot restano spenti salvo consenso esplicito dell'operatore) e Chromium parte senza segreti nell'ambiente.
- **Media.** Una pagina mandata un byte alla volta teneva viva una lettura per ore (ora c'è una scadenza totale); un HTML costruito apposta bloccava il processo per minuti (la pulizia del testo ora è lineare); titolo della pagina e tipo di contenuto arrivavano al modello fuori dalla recinzione; nessun limite a screenshot in parallelo, altezza della pagina intera e byte caricati; un Chromium caduto restava in cache; le celle cloud non avevano Chromium.
- **Lasciati, con motivo.** L'owner non può elencare un indirizzo IP, solo domini (gli IP interni sono comunque negati). Domini come `gov.it` sono accettati: vuol dire tutti i siti sotto, ed è una scelta dell'owner.

## Limiti

| Cosa | Limite |
|---|---|
| Azioni | niente moduli, clic o invii: arrivano con le micro-VM e l'approvazione |
| Sandbox | in un container senza user namespace il sandbox di Chromium non parte: gli screenshot restano spenti finché l'operatore non accetta `OWNI_SCREENSHOTS_WITHOUT_SANDBOX=1` |
| Chromium di Debian | l'immagine usa il Chromium della distribuzione con Playwright 1.56: la compatibilità va provata sull'immagine pubblicata |
| Pagine viste dagli screenshot | le risorse arrivano senza cookie e senza compressione: alcune pagine possono apparire diverse da un browser normale |
| Pagine dinamiche | `web_read` legge l'HTML che arriva, non quello che JavaScript costruisce dopo: per quelle c'è lo screenshot |
