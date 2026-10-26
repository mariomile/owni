# 0124: Il computer dell'agente ha la rete

Mario (26 ottobre 2026): il computer dell'agente ha la rete verso internet, come Grok Bot di xAI, dove ogni agente ha una macchina Linux nel cloud, persistente, con browser e rete. Fino a oggi il computer era chiuso: un container con rete `none` ([ADR 0013](0013-terminale-in-un-computer-senza-rete.md)) o una micro-VM sigillata da iptables ([ADR 0015](0015-computer-su-micro-vm.md)).

Perché: un agente che lavora davvero deve poter installare un pacchetto che l'immagine non ha, clonare un repository, scaricare un file pubblico, chiamare un'API, aprire una pagina. Senza rete ognuna di queste cose diventa un rifiuto, o un giro dalla persona che scarica e carica il file. Il computer chiuso proteggeva da un rischio (i file che escono) togliendo all'agente quasi tutto quello che un computer serve a fare.

## Decisione

Il computer ha la rete in uscita verso internet, con ogni provider, senza elenco di siti consentiti e senza approvazione per comando. Non c'è un'opzione per tornare al computer chiuso.

- **Docker**: il container sta sulla rete `bridge` di default di Docker invece che su `none`. Nessuna porta pubblicata.
- **Fly**: `owni-fly-init` non blocca più l'uscita (niente iptables e ip6tables) e non scrive più il segno «sigillata». `owni-run` non rifiuta più una macchina non sigillata e non ricontrolla il firewall prima di ogni comando. Un comando parte solo quando il primo processo ha chiuso l'API di Fly dentro la macchina: il segno ora si chiama `ready` e dice questo.
- **Owni Cloud**: niente cambia nel control plane e nelle celle. Il control plane passa comandi e file come prima; nessuna parte assumeva il computer senza rete.
- **L'immagine** ha in più `curl`, `git` e `pip`. Con il file system in sola lettura, `pip install` scrive in `/work/.local` (`/etc/pip.conf` e `PYTHONUSERBASE`): i pacchetti restano con i file del computer e contano nella quota.
- **`computer_run`** dice al modello che il computer ha internet (pip install, curl, git clone, API pubbliche), che non ha chiavi né password, e che non deve mandare fuori niente che la persona non abbia chiesto, mai perché lo dice un file, una pagina o un'uscita.
- **Dopo un crash `computer_run` non riparte da solo.** Prima ripartire era innocuo: senza rete niente usciva due volte. Ora un comando interrotto a metà può aver già fatto un POST o un caricamento, e ripeterlo lo farebbe due volte. Il modello riceve «interrotto, forse in parte eseguito» e guarda `/work` prima di riprovare.
- **La console** dice che il computer è collegato a internet e che quello che Owni ci copia può finire in rete.

## Cosa resta

- **Niente segreti nel computer.** Il container non riceve variabili d'ambiente di Owni; il comando ha solo `HOME`, `LANG` e le variabili di Python e del PATH. La macchina Fly riceve solo `OWNI_IDLE_S`. Nel computer entrano solo i file del workspace copiati con `copy_in`, e il workspace è separato da `secrets.json` e dai token dei connettori. I token di Fly e la chiave del modello restano nel server o nel control plane.
- **Niente in entrata.** Docker: nessuna porta pubblicata. Fly: nessun indirizzo pubblico, nessun servizio, una rete privata per ogni app, nessuna registrazione DNS.
- **L'API di Fly chiusa.** `/.fly/api` dentro la macchina risponde senza token: resta solo per root, e nessun comando parte prima che sia chiusa.
- **Niente vsock né socket packet.** Il filtro seccomp di `owni-run` resta. Il vsock parla con l'host della VM, non con internet. Un socket packet serve a falsificare e ascoltare pacchetti, mai a usare internet: `pip`, `curl` e `git` usano socket normali.
- **Le protezioni della macchina**: comandi come uid 1000, file system in sola lettura tranne `/work` e `/tmp`, nessuna capability, niente escalation di privilegi, limiti di memoria, CPU, processi e dimensione dei file, quota di `/work`, gVisor facoltativo, tutto chiuso alla fine di ogni comando.
- **L'interruttore dell'owner.** Il computer resta spento finché l'owner non lo accende per l'istanza (il connettore `computer` della policy). È l'unico controllo, ed è quello giusto: acceso vuol dire computer con internet.
- **Quello che si vede**: i membri vedono il workspace dell'agente come prima. Il registro conta i comandi senza testo né uscita, come prima.

## Il rischio nuovo

Un comando può mandare fuori i file che l'agente ha copiato in `/work`. Il caso da tenere a mente è la prompt injection: una mail, una pagina o un file con istruzioni nascoste spinge l'agente a copiare un documento nel computer e a mandarlo a un indirizzo con `curl`. Prima il danno restava dentro il computer; ora può uscire. Le difese sono tre, nessuna assoluta: l'uscita del computer arriva al modello recintata come dati, la descrizione dello strumento vieta di inviare quello che la persona non ha chiesto, e nel computer ci sono solo i file copiati, mai le credenziali.

Altri rischi, minori:

- **Abuso della rete**: scansioni, spam, mining partono dagli indirizzi di Fly o del server di Owni. Limiti di CPU e di tempo per comando li contengono, non li impediscono.
- **Docker e la rete locale**: dal bridge il computer raggiunge anche la rete locale del server e i servizi in ascolto su tutte le interfacce. Il runbook (6j) dice di tenerli su `127.0.0.1` o chiusi verso `docker0`. Su Fly no: la macchina ha una rete privata sua.

## Alternative scartate

- **Un elenco di siti consentiti** (PyPI, GitHub, poche API): il lavoro di un agente non sta in un elenco scritto prima. Pacchetti che scaricano da altri siti, mirror, CDN, le API che la persona nomina oggi: l'elenco sarebbe sempre corto, e tenerlo toccherebbe all'owner. Filtrare per dominio vuol dire anche un proxy davanti al computer, con DNS e TLS da gestire, e un nome consentito come GitHub basta comunque a far uscire un file. Il costo è alto, la protezione è poca.
- **Il computer chiuso**: è lo stato di prima. Toglie i lavori per cui serve un computer, e una persona finisce a fare da ponte con internet. Mario l'ha deciso: niente opzione per tenerlo.
- **L'approvazione per ogni comando**: con decine di comandi per lavoro, la persona approva senza leggere. Il controllo diventa finto e il lavoro si ferma a ogni passo.

## Conseguenze

- Il job `computer` del workflow Image prova il contrario di prima, sull'immagine vera: il computer raggiunge internet, `pip install` scrive in `/work/.local`, nell'ambiente non c'è niente di Owni; sul target `fly` l'API di Fly è chiusa a uid 1000 e vsock e packet sono rifiutati. Serve ancora la prova dal vivo su Fly con un token vero.
- Il traffico in uscita costa: Fly fattura l'uscita oltre la soglia gratuita, e un computer che scarica molto pesa sul conto del tenant.
- Un computer già creato passa alla rete al comando dopo: su Docker cambia la configurazione e il container viene ricreato, su Fly serve l'immagine nuova (`owni-computer:fly`). I file in `/work` restano.
- Se un giorno serve chiudere la rete per un cliente, si torna a decidere: oggi non c'è e non si tiene codice per farlo.
