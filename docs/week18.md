# Settimana 18: il terminale, in un computer senza rete

Branch `week-18`. Decisione: [ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md). È il terminale della Fase 3 del [piano cloud](piano-cloud.md); il browser con clic viene dopo, sullo stesso computer.

## Cosa funziona (verificato dai test)

- **Il tool** (`test/computer.test.ts`): `computer_run` esegue un comando `sh` nel computer dell'istanza, in `/work`. Copia prima i file del workspace indicati in `copy_in` (al massimo 20, 100 MB in tutto) e dopo riporta nel workspace, sotto `computer/`, quelli di `copy_out` (al massimo 20 MB l'uno), da leggere o mandare con `file_send`. Percorsi con `..`, assoluti fuori da `/work`, con caratteri di controllo o oltre 100 byte per parte sono rifiutati prima di eseguire niente.
- **Acceso dall'owner**: il tool rifiuta finché l'owner non accende il computer in Impostazioni, Computer (connettore `computer`, cambio nell'audit). «Azzera i file del computer» cancella container e volume. Senza `OWNI_COMPUTER=docker` il tool non esiste e la console non mostra la scheda. Se Docker non risponde o manca l'immagine, la scheda lo dice; lo dice anche `pnpm owni check` e il log all'avvio.
- **Il computer** è chiuso: rete `none`, file system in sola lettura tranne `/work` e `/tmp`, nessuna capability, niente escalation, 128 processi, memoria e CPU limitate, nessun file oltre 1 GB, gVisor a scelta. I comandi girano come uid 1000, il container come nobody. Il comando arriva come argomento, mai incollato nello script.
- **Tempi e uscita**: un comando ha fino a 5 minuti; a tempo scaduto viene ucciso con tutto quello che ha avviato. Un comando che finisce la memoria è distinto da uno scaduto. Al modello arrivano al più 16.000 caratteri, divisi fra stdout (l'inizio) e stderr (la fine, dove c'è l'errore), recintati come dati con un'etichetta casuale.
- **Niente resta acceso**: alla fine di ogni comando `kill -9 -1` chiude i processi lasciati in background (verificato dal vivo nella CI). Un comando interrotto (la conversazione annullata) si ferma subito e i suoi processi vengono chiusi.
- **Disco**: dopo ogni comando Owni misura `/work`; oltre la quota (`OWNI_COMPUTER_DISK_MB`, 2048) il risultato lo dice, i nuovi file restano minuscoli e non si copiano altri file dentro, finché Owni non cancella.
- **Ciclo di vita**: un comando alla volta per computer, 4 per server, al massimo 8 computer accesi (si ferma quello inutilizzato da più tempo), arresto dopo 10 minuti senza comandi. Un cambio di immagine, runtime o limiti ricrea il container e tiene i file. All'avvio Owni ferma i computer rimasti accesi da un crash. Un container con il nome del computer ma non suo non viene mai usato.
- **Una sola esecuzione**: dopo un crash il risultato salvato torna indietro senza rieseguire.
- **Audit**: `computer.ran` con codice di uscita, durata, file dentro e fuori, byte di uscita, memoria e disco; `computer.failed` se Docker non risponde. Mai il comando né l'output. Gli errori di Docker vanno nel log dell'operatore; al modello arriva una frase semplice.
- **Dove non gira**: nella chat del brief del mattino (come ogni tool che non è di sola lettura) e in Owni Cloud (le celle non ricevono le variabili del computer).
- **Dal vivo** (`test/computer-docker.live.test.ts`, job `computer` della CI su un Docker vero): uid 1000 in `/work`, solo l'interfaccia `lo`, nessuna connessione verso fuori, sistema in sola lettura; pandas e matplotlib fanno un grafico che torna come PNG; `pypdf`, `openpyxl`, `xlrd`, `weasyprint`, `pdftoppm`, `qpdf` ci sono; un processo in background muore con il comando.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** `/work` non aveva limite di disco: un comando poteva riempire il disco del server. Ora quota per istanza e limite per file. Il nome del computer si calcolava anche senza computer e un id lungo faceva fallire tutti i tool dell'istanza; ora si calcola solo con un computer, ed è un hash.
- **Media.** Due istanze potevano avere lo stesso computer (`a-b`/`c` e `a`/`b-c`). Processi in background sopravvivevano al comando e tenevano aperto il tool; il tempo massimo era di inattività, non totale. Nessun limite alla memoria usata per copiare file né ai computer accesi. Un cambio di limiti non arrivava ai container esistenti. Mancavano il controllo di Docker all'avvio e in console, le istruzioni per Compose, `weasyprint` e `xlrd`, e la versione 1.41 dell'API (Docker 20.10).
- **Bassa.** Errori di Docker mostrati al modello; un errore in una copia in uscita annullava le altre; memoria finita scambiata per tempo scaduto; codice di uscita letto prima che Docker lo registrasse; corse fra avvio, arresto e comandi; container rimasti accesi dopo un crash; `work/x` trattato come `/work/x`; byte di uscita contati in caratteri; frame di Docker non controllati; budget di uscita diviso a metà anche quando uno dei due flussi era vuoto.

## Limiti

| Cosa | Limite |
|---|---|
| Dove | solo installando Owni su un server proprio; in Owni Cloud spento fino alle micro-VM |
| Sicurezza del server | il socket di Docker equivale a root: Owni dev'essere l'unico servizio della macchina |
| Isolamento | quello di un container (kernel condiviso), o di gVisor con `runsc` |
| Rete | nessuna: niente `pip install`, niente download. Gli strumenti sono quelli dell'immagine |
| Backup | i file del computer non sono nel backup: quello che conta va copiato nel workspace |
| Un Docker, un Owni | due installazioni sullo stesso Docker si fermano i computer a vicenda all'avvio |
