# Settimana 20: il computer su micro-VM Fly.io, anche in Owni Cloud

Branch `week-20`. Decisione: [ADR 0015](adr/0015-computer-su-micro-vm.md). È l'ultimo pezzo della Fase 3 del [piano cloud](piano-cloud.md): il computer della settimana 18 ([ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md)) ora può essere una Fly.io Machine, una micro-VM con un kernel suo, e così si accende anche per le celle di Owni Cloud. Le celle restano container.

## Cosa funziona (verificato dai test)

- **Il provider Fly** (`test/fly-computer.test.ts`, contro una copia dell'API delle macchine che esegue il runner vero): una app per computer su una rete sua, un volume cifrato, una macchina senza servizi e senza riavvio; comandi lunghi aspettati a fette oltre i 60 secondi dell'exec di Fly; tempo massimo, annullamento e processi lasciati in background chiusi; file dentro e fuori a pezzi, con cartelle, collegamenti e file mancanti rifiutati; quota del disco; una macchina ferma da sola riparte con i suoi file; una nuova immagine aggiorna la macchina sullo stesso volume, e una quota più grande fa crescere il volume; un volume rimasto libero viene riusato; un exec chiuso dal kernel non passa per un successo; azzerare cancella la app; nessun comando su una macchina non sigillata.
- **Il sigillo** (`test/computer-fly.live.test.ts` nel job `computer` della CI, sull'immagine vera in un container che raggiunge internet): il container senza sigillo esce in rete, quello sigillato no, né in IPv4 né in IPv6; uid 1000 non toglie le regole; socket packet e vsock rifiutati; senza le capability per sigillarla la macchina non esegue niente.
- **Owni Cloud** (`test/cloud-computer.test.ts`): le celle chiedono al control plane, con un token derivato dal loro segreto; la stessa chiave da due tenant dà due computer; nessuna risposta senza token giusto o dal dominio di un tenant; errori interni nascosti alla cella; comandi annullati dalla cella chiusi con quello che hanno scritto; 2 comandi alla volta e 10 computer per tenant; niente per un tenant con la prova finita; `pnpm cloud computers` e `pnpm cloud computers delete <tenant>`.
- **Impostazioni** (`test/cloud-computer.test.ts`, `test/computer.test.ts`): `OWNI_COMPUTER=fly` e i limiti che Fly accetta; le celle ricevono solo `OWNI_COMPUTER=cloud` e l'indirizzo, mai il token di Fly né Docker, e un control plane senza computer li spegne anche alle celle esistenti al primo `pnpm cloud upgrade`.

## Rispetto al computer Docker

Uguali: i tool, le uscite (inizio di stdout, fine di stderr), i 5 minuti, uid 1000 in `/work`, la quota, i file senza collegamenti, l'accensione per istanza dall'owner. Diversi: un kernel per computer invece di quello del server; nessun socket di Docker; il computer si ferma da solo anche se Owni si spegne; il primo avvio scarica l'immagine (fino a un minuto); copiare 100 MB costa circa 200 chiamate all'API di Fly.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** Il socket dell'API di Fly dentro la macchina (`/.fly/api`) rispondeva senza token a uid 1000: ora è solo di root. Un comando poteva aprire socket vsock o packet, che il firewall non vede: ora seccomp li rifiuta. Il segno «sigillata» restava sul disco da un avvio all'altro: ora sta in memoria e il firewall si ricontrolla prima di ogni comando. Le richieste lunghe fra cella e control plane potevano essere tagliate da un proxy: ora un comando parte con una richiesta e si aspetta con altre di 25 secondi.
- **Media.** I nomi delle app Fly mostravano la chiave e potevano scontrarsi fra installazioni: ora sono un hash con un sale. Nessun limite a processi e memoria dentro la macchina: ora 128 processi, e il kernel chiude il comando prima del supervisore. Il percorso dei file seguiva i collegamenti nelle cartelle intermedie. Una macchina appena creata non era aspettata. Un volume rimasto da un tentativo fallito si pagava due volte. Una quota più grande non faceva crescere il volume. Nessun tetto a computer e copie per tenant. Un exec chiuso da un segnale sembrava riuscito.
- **Bassa.** Programmi setuid nell'immagine; `/tmp` sul volume; `ps` mancante; il controllo di Fly ripetuto a ogni apertura delle impostazioni; dettagli dell'operatore nei messaggi alle celle.

## Limiti

| Cosa | Limite |
|---|---|
| Prova sul kernel di Fly | da fare con un token vero (sotto) |
| Comandi | 5 minuti, 8 alla volta per installazione, 2 per tenant in Owni Cloud |
| Computer | 10 per tenant in Owni Cloud |
| Primo avvio | fino a un minuto, per scaricare l'immagine |
| Backup | i volumi di Fly sono fuori dal backup di Owni |
| Rete | nessuna, come in Docker |

## Prova dal vivo su Fly

Con `FLY_API_TOKEN` e `OWNI_TEST_FLY_ORG` nell'ambiente (mai in chat, [chiavi](chiavi.md) §12) e l'immagine pubblicata su un registry che Fly raggiunge:

```sh
OWNI_TEST_FLY_IMAGE=ghcr.io/mariomile/owni-computer:fly pnpm vitest run test/computer-fly.live.test.ts
```

Crea una app nell'organizzazione, prova sigillo, file, comandi lunghi e processi in background su una macchina vera, poi la cancella. Costo stimato: qualche centesimo.
