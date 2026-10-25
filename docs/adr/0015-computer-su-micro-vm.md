# Fase 3, quinto passo: il computer su micro-VM, anche in Owni Cloud

Il computer della settimana 18 (ADR 0013) gira come container sul server dove Owni è installata, e in Owni Cloud resta spento: dare a una cella il socket di Docker equivale a darle il server. Ora il computer può essere una **Fly.io Machine**, una micro-VM con un kernel suo, e così si accende anche per le celle di Owni Cloud.

## Come funziona

- **Una app Fly per computer**, cioè per istanza, su una rete privata sua (nessun'altra app la raggiunge), senza indirizzo pubblico e senza servizi: niente arriva alla macchina. `/work` è un volume cifrato della app, grande quanto la quota arrotondata al gigabyte, che cresce con la quota e non si restringe mai. Regione UE (`fra` di default). Il nome della app è un hash della chiave del computer con un sale dell'installazione (`computer-salt` nella cartella dati) e l'organizzazione: non dice niente dell'istanza, e due installazioni non si scontrano. Un prefisso diverso (`OWNI_FLY_APP_PREFIX`) serve solo se il nome è già preso fuori dall'organizzazione.
- **Sigillata prima di tutto**: il primo processo della macchina (`docker/owni-fly-init`, come root) blocca ogni pacchetto in uscita tranne loopback e le risposte a connessioni entrate (che non ce ne sono), con iptables e ip6tables. Chiude a root il socket dell'API di Fly dentro la macchina (`/.fly/api`, che risponde senza token e nessun firewall vede). Mette `/tmp` e il proprio stato in memoria. Solo dopo segna la macchina come sigillata, in memoria, così un segno rimasto da un avvio precedente non vale. Se un passo fallisce il primo processo termina e la macchina si ferma: nessun comando parte.
- **Ricontrollata a ogni comando**: `owni-run` non avvia niente su una macchina non sigillata, rilegge le regole del firewall prima di ogni comando, e dà al comando un filtro seccomp che rifiuta i socket vsock e packet (l'uno parla con l'host, l'altro passa sotto iptables).
- **I comandi** passano dall'API exec di Fly a `docker/owni-run`, che li esegue come uid 1000 in `/work`, senza privilegi nuovi (l'immagine non ha programmi setuid), al più 128 processi, con la quota come dimensione massima di un file. Se la memoria finisce, il kernel chiude il comando, non il supervisore. Un exec risponde entro 60 secondi, quindi il comando parte in background e si aspetta a fette: un comando può durare fino a 5 minuti come in Docker. Alla fine, o quando la conversazione lo annulla, tutto quello che uid 1000 ha acceso viene chiuso, e un comando nuovo non parte finché non è chiuso. Stesse uscite di ADR 0013: inizio di stdout e fine di stderr, 64 KB ciascuno, quota del disco.
- **I file** entrano ed escono a pezzi da 512 KB, letti e scritti come uid 1000 senza seguire collegamenti, neanche nelle cartelle del percorso.
- **Si spegne da sola**: senza chiamate per 10 minuti il primo processo termina e la macchina si ferma, anche se chi l'ha accesa non c'è più. Al comando dopo riparte con i suoi file. Una macchina ferma costa solo il volume.
- **Azzerare** cancella la app con macchina e volume.

## In Owni Cloud

Il token di Fly sta solo nel control plane (`OWNI_CLOUD_COMPUTER=fly`). Le celle ricevono `OWNI_COMPUTER=cloud` e l'indirizzo del control plane, e chiedono lì i comandi e i file per il proprio tenant, con un token derivato dal loro segreto. Il control plane rinomina ogni computer con il tenant e la chiave mandata dalla cella, quindi una cella non può raggiungere il computer di un altro tenant qualunque chiave mandi.

Un comando parte con una richiesta e si aspetta con altre di al più 25 secondi, così nessun proxy fra cella e control plane taglia un comando di 5 minuti; una cella che smette di chiedere (spenta, riavviata) fa chiudere il suo comando dopo 90 secondi. Tetti per tenant: 2 comandi alla volta, 10 computer, una copia di file alla volta (e 256 MB in transito sul control plane in tutto). Un tenant sospeso (prova finita) non esegue niente. Alla cella arrivano solo gli errori che la persona può risolvere; il resto finisce nel log del control plane. L'owner accende il computer istanza per istanza come prima. `pnpm cloud computers` li elenca, `pnpm cloud computers delete <tenant>` li cancella per un account che se ne va.

Installando Owni su un proprio server si può usare Fly direttamente (`OWNI_COMPUTER=fly`): il token sta nel server dell'operatore.

## Alternative scartate

- **Il token di Fly nelle celle**: un token dell'organizzazione raggiunge tutte le app; una cella compromessa raggiungerebbe i computer degli altri. Un token per app sarebbe da creare, dare e ruotare per ogni istanza, e la cella potrebbe comunque cambiare la configurazione della sua macchina (immagine, rete).
- **La rete della macchina affidata solo a Fly**: le network policy di Fly hanno solo regole di permesso e il loro comportamento verso internet non è documentato; nessuna opzione dell'API toglie l'uscita a una macchina. Il sigillo dentro la VM è nostro e si prova nella CI (job `computer`: l'immagine reale su una rete che raggiunge internet).
- **Un comando per exec**: 60 secondi bastano a poco; un comando lungo verrebbe tagliato.
- **Firecracker su server nostri**: più controllo, ma serve gestire host, immagini e rete. Fly lo fa già, in UE.

## Conseguenze

- Prima di accenderlo per tutti serve una prova dal vivo con un token vero (`test/computer-fly.live.test.ts` con `FLY_API_TOKEN` e `OWNI_TEST_FLY_ORG`): che la macchina parta, che il sigillo regga sul kernel di Fly, che l'exec accetti i pezzi da 512 KB.
- Le risposte alle connessioni entrate restano permesse: se Fly un giorno inoltrasse traffico a una macchina senza servizi, la macchina potrebbe rispondere. Nessun processo in ascolto la rende comunque inutile.
- Il sigillo si prova nella CI su un container dell'immagine vera (con le capability che root ha in una VM di Fly), con il controllo opposto: lo stesso container senza sigillo raggiunge internet, e senza capability non parte nessun comando. Non è il kernel di Fly: per quello serve la prova dal vivo.
- Copiare 100 MB dentro richiede circa 200 chiamate all'API di Fly.
- I file del computer stanno nei volumi di Fly, fuori dal backup di Owni, come in ADR 0013.
