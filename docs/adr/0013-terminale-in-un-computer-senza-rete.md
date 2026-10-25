# Fase 3, terzo passo: il terminale, in un computer per istanza senza rete

> Aggiornata dall'[ADR 0015](0015-computer-su-micro-vm.md): il computer può girare su micro-VM Fly.io, e così anche in Owni Cloud.

Owni esegue comandi (`computer_run`) in un computer suo, separato dalla cella: un container per istanza, con i suoi file in `/work`, **senza rete** e senza segreti. Ci copia i file del workspace che servono, lancia i comandi (Python, `jq`, `sqlite3`, `pandoc`, `pdftotext` e gli altri strumenti dell'immagine) e riporta nel workspace i file che produce. Il browser con clic resta per il passo dopo, sullo stesso computer.

Perché adesso e perché così: le persone chiedono di unire due fogli, convertire un documento, fare un grafico da un CSV, controllare un PDF. Sono lavori da terminale che non devono uscire. «Leggere è libero, scrivere o inviare si approva»: un computer senza rete non può inviare niente a nessuno, e non ha niente da rubare. I comandi girano quindi senza approvazione: il rischio di un comando sbagliato resta dentro il computer dell'istanza.

## Come funziona

- L'owner accende il computer per istanza (Impostazioni, «Computer»), spento di default come canali e connettori. L'operatore lo rende disponibile con `OWNI_COMPUTER=docker` e l'accesso al socket di Docker.
- Il computer è un container dall'immagine `OWNI_COMPUTER_IMAGE` (`docker/computer.Dockerfile`), creato al primo comando: rete `none`, comandi come utente 1000 (mai root) e container come nobody, file system in sola lettura tranne `/work` (un volume dell'istanza) e `/tmp`, nessuna capability, niente escalation di privilegi, limiti di memoria, CPU, processi e dimensione dei file, una quota per `/work`. Con `OWNI_COMPUTER_RUNTIME=runsc` gira sotto gVisor, con un kernel suo. Il nome del computer è un hash di tenant e istanza.
- Un comando alla volta per computer; alla fine di ognuno, tutto quello che ha lasciato acceso viene chiuso (`kill -9 -1` come utente 1000, che non può toccare il container). Al massimo 8 computer accesi e 4 comandi alla volta per server.
- Un comando ha un tempo massimo (fino a 5 minuti) e un tetto di output: al modello arrivano al più 16.000 caratteri di uscita, recintati come dati, perché possono contenere il testo dei file.
- I file entrano dal workspace (`copy_in`) ed escono nel workspace sotto `computer/` (`copy_out`), al massimo 20 MB l'uno: lì Owni li può mandare con `file_send`.
- Il computer si ferma dopo 10 minuti senza comandi e riparte al primo; i file in `/work` restano.
- Audit: un comando eseguito, con durata, codice di uscita e dimensioni; mai il testo del comando né l'output.

## Limiti voluti

- Niente rete: niente `pip install`, niente `curl`. Gli strumenti sono quelli dell'immagine; l'operatore può costruirne una sua.
- In Owni Cloud il computer resta spento finché le celle non girano su micro-VM: una cella non ha il socket di Docker, e darglielo equivarrebbe a darle il server.
- Nella chat del brief del mattino `computer_run` non gira, come tutti i tool che non sono di sola lettura.

## Alternative scartate

- **Comandi con approvazione uno per uno**: senza rete non proteggono da niente che il computer non contenga già, e renderebbero il terminale inutilizzabile.
- **Rete verso i siti consentiti**: è il passo del browser con clic, con il traffico che passa dal fetch controllato della cella e l'approvazione per quello che invia. Prima il terminale chiuso.
- **Comandi nella cella** (nel sandbox dei tool proposti, ADR 0002): la cella ha la chiave del modello e i dati di tutte le conversazioni.
- **Un servizio dentro il computer che riceve comandi via HTTP**: serve una rete fra cella e computer. Con `docker exec` il computer non ha nessuna interfaccia di rete.

## Conseguenze

- Il processo di Owni che usa il socket di Docker equivale a root sul server, come il control plane dell'ADR 0008. Va acceso solo dove Owni è l'unico servizio del server, e il runbook lo dice.
- L'isolamento è quello di un container (kernel condiviso) o, con gVisor, di un kernel in user space. Per le micro-VM (Fly.io Machines in UE il candidato) basta un altro `ComputerProvider`, con un token e una prova dal vivo.
- I file in `/work` sono dati delle persone, come il workspace: li cancella l'owner dalla console (Impostazioni, Computer, «Azzera i file del computer»). Restano fuori dal backup della cartella dei dati: quello che conta va copiato nel workspace.
