# Settimana 8: Owni Cloud apribile su un server

Branch `week-8`. Piano: [`piano-cloud.md`](piano-cloud.md). Decisione: [ADR 0008](adr/0008-celle-container-prima-delle-micro-vm.md).

## Perché

Alla Fase 1 mancavano due pezzi per avere clienti veri: le email di accesso (finivano in un file) e un isolamento fra tenant (le celle erano processi dello stesso utente). Entrambi dipendevano da scelte di fornitore; li abbiamo fatti in modo che non dipendano più: SMTP parla con qualunque servizio, e le celle container girano su qualunque server con Docker.

## Cosa funziona (verificato)

- **Link di accesso via SMTP** (`test/smtp.test.ts`, server SMTP finto con TLS vero). `OWNI_CLOUD_SMTP_URL` con `smtps://` (TLS dal primo byte) o `smtp://` con STARTTLS obbligatorio; AUTH PLAIN o LOGIN; testo UTF-8. SMTP in chiaro solo verso questa macchina; un a capo in un indirizzo o nell'oggetto viene rifiutato (niente header iniettati); un login rifiutato si segnala senza ripetere cosa è stato mandato.
- **Celle come container** (`test/docker-provider.test.ts`). `OWNI_CLOUD_PROVIDER=docker`: per ogni tenant un container e un volume, tutti su una rete dove i container non si parlano; uid 1000 (mai root, qualunque immagine), root in sola lettura, nessuna capability, `no-new-privileges`, limiti di memoria (un valore sbagliato blocca l'avvio invece di togliere il limite), CPU e processi; porta solo su 127.0.0.1; timeout su ogni chiamata a Docker e sul controllo di salute. Sul daemon Docker di questa macchina: registrazione, link, cella creata, prima risposta in circa 4 secondi; cella fermata per inattività e risvegliata in circa 4 secondi con la conversazione intatta; aggiornata con `upgrade` senza perdere niente; tutto rimosso alla fine. Misure: circa 100 MB di memoria da accesa, 0,1 MB di disco da spenta. A mano: una cella non raggiunge l'altra (timeout), gira come uid 1000, il codice non è scrivibile, `/data` sì.
- **Aggiornare le celle**: `pnpm cloud upgrade`, a control plane fermo, ricrea ogni container dall'immagine attuale e con le impostazioni del modello attuali; volumi e dati restano.

## Review indipendente

Due revisori separati. Corretti:

- **Alta.** Una cella che non diventava mai sana bloccava per sempre `start` e `stop` di quel tenant (si aspettavano a vicenda), anche il giro di spegnimento: riprodotto e corretto, con un test. STARTTLS: risposte iniettate in chiaro dopo il `220` venivano lette come risposte del server dopo TLS, e una mail persa risultava inviata (classe CVE-2011-0411): ora qualunque dato prima dell'handshake fa fallire l'invio, con un test.
- **Media.** Un valore di memoria sbagliato toglieva il limite; una rete per tenant esauriva i pool di indirizzi di Docker a circa trenta clienti (ora una rete sola, con traffico fra container spento); nessun timeout verso Docker né verso un server SMTP che risponde un byte alla volta (ora 30 secondi per chiamata, 60 per invio, righe al massimo 8 KB); l'utente del container dipendeva dall'immagine; nessun modo di aggiornare una cella senza cancellarne il volume; il runbook non bastava per mettere in piedi il servizio; la spunta della Fase 1 era prematura (tolta).
- **Bassa.** Un indirizzo rifiutato dal server finiva nei log; il mittente si poteva non validare costruendo il mailer a mano; commenti che non dicevano il vero (`ca`, utente del container, «macchina tutta sua» nel glossario e nell'interfaccia); l'ADR 0007 non diceva di essere aggiornata.
- **Lasciati, con motivo.** Firewall di egress per le celle: come nel self-host oggi, scritto nell'ADR 0008 come lavoro da fare. Segreti nell'ambiente del container: leggibili solo da root sul server. Il percorso «basta `docker build`» non è provato qui (il proxy di questo ambiente blocca il download di pnpm nel build). La duplicazione fra provider locale e Docker (avvio e controllo di salute) resta: due implementazioni piccole di un'interfaccia, unirle costerebbe più di quanto rende.

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: tutti verdi; il test sul daemon vero (`OWNI_TEST_DOCKER_IMAGE=owni:local`) passa qui.

## Limiti

| Cosa | Limite |
|---|---|
| Isolamento | quello di un container, kernel condiviso: basta per conversazioni e file, non per il «computer dell'agente» (Fase 3), che chiede micro-VM |
| Server | uno solo: backup notturni dei volumi; sull'host va bloccato l'endpoint dei metadati del cloud (runbook 6c) |
| Immagine | qui costruita copiando le dipendenze già installate, perché il proxy di questo ambiente non lascia scaricare pnpm dal build: il `docker build` del Dockerfile del repository non è stato provato su questa macchina |
| Rete delle celle | escono su internet senza filtro, come il self-host (ADR 0008); qui i container non hanno DNS, quindi la prova usa il modello finto |
| Prova dal vivo | Telegram, Gmail, HubSpot e Google veri restano da provare: servono i segreti e i domini consentiti |
