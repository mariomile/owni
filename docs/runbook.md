# Runbook: installare e gestire Owni

Per chi installa Owni presso un cliente (owner). Un'installazione = un tenant = un container. Vocabolario in [`GLOSSARY.md`](../GLOSSARY.md).

Le chiavi che servono, dove prenderle e dove metterle, passo per passo: [`chiavi.md`](chiavi.md).

## 1. Requisiti

- Un server Linux con Docker e Docker Compose, oppure Node.js 24+ e pnpm 10.
- Disco locale per i dati (non NFS/SMB: il lock delle istanze usa lock POSIX).
- La chiave di un modello: Anthropic, OpenAI, Gemini, Grok, Mistral, OpenRouter o un altro dei provider di [ADR 0032](adr/0032-qualsiasi-modello.md). Opzionali: un bot Telegram per l'agente, un secondo bot per la segreteria, OAuth Gmail e token HubSpot per la segreteria.
- Un reverse proxy con https davanti alla console (Caddy, nginx, Traefik).

## 2. Installazione con Docker

```bash
git clone <repo> owni && cd owni
cp .env.example .env          # compila almeno la chiave del modello (ANTHROPIC_API_KEY o un'altra) e OWNI_PUBLIC_URL
docker compose up -d --build
docker compose exec owni cat /data/owner-login-link.txt
docker compose exec owni rm /data/owner-login-link.txt
```

Al primo avvio Owni crea il tenant, l'istanza `owni` e l'owner, e scrive il link d'accesso dell'owner in `owner-login-link.txt` nella cartella dati (permessi 0600; non finisce nei log). Aprilo nel browser, poi cancella il file.

Il container gira con il minimo dei privilegi: filesystem in sola lettura tranne `/data` e `/tmp`, nessuna capability Linux, niente escalation di privilegi. Se lo avvii senza compose, usa le stesse opzioni (`--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true`).

La porta 8080 è esposta solo su `127.0.0.1`. Esempio Caddy:

```text
owni.cliente.it {
	reverse_proxy 127.0.0.1:8080
}
```

Con `OWNI_PUBLIC_URL=https://owni.cliente.it` i cookie di sessione sono `Secure` e i link d'accesso hanno l'indirizzo giusto. Il proxy non deve fare buffering degli eventi (`/api/events` è uno stream SSE): Caddy e Traefik vanno bene così; con nginx usa `proxy_buffering off` su quel percorso.

Dietro un proxy aziendale che ispeziona TLS, la build deve fidarsi della sua CA: aggiungi la CA all'immagine (`COPY` + `NODE_EXTRA_CA_CERTS`) e passa il proxy con `--build-arg HTTPS_PROXY=...`.

## 3. Installazione senza Docker

```bash
pnpm install --prod --frozen-lockfile
cp .env.example .env
pnpm start                    # oppure un servizio systemd che lancia questo comando
cat data/owner-login-link.txt && rm data/owner-login-link.txt   # primo avvio
```

Prima di tutto, e ogni volta che cambi una chiave: `pnpm owni check` (con Docker: `docker compose exec owni node_modules/.bin/tsx src/main/cli.ts check`). Prova ogni servizio configurato e dice cosa non va, senza stampare segreti: chiave del modello, bot Telegram, OAuth Gmail con i due scope, token HubSpot (e i valori di `hs_lead_status` del portale), host non raggiungibili.

## 4. Persone e accessi

Dalla console (pagina Persone, solo owner) o da riga di comando:

```bash
pnpm owni person add "Anna Rossi" --instance owni    # stampa il link personale
pnpm owni person list
pnpm owni person link p_xxxxxxxxxxxx                   # nuovo link, il vecchio e le sue sessioni smettono di funzionare
pnpm owni person remove p_xxxxxxxxxxxx
pnpm owni person reset-2fa p_xxxxxxxxxxxx              # toglie la verifica in due passaggi (telefono perso)
```

Con Docker: `docker compose exec owni node_modules/.bin/tsx src/main/cli.ts person add "Anna Rossi" --instance owni`.

Ognuno può attivare la verifica in due passaggi cliccando sul proprio nome nella console: da quel momento per entrare servono il link e il codice dell'app di autenticazione. Per chi gestisce dati di clienti conviene chiederla a tutti.

Il link contiene il token nel frammento (`#...`): non finisce nei log del server né del proxy. Va dato alla persona in privato. In Impostazioni l'owner decide chi può **scrivere** all'istanza dal web e chi **approva** le sue azioni (tool proposti, pratiche della segreteria).

## 5. Telegram

Ogni istanza può avere il suo bot, collegato dall'owner in Impostazioni → Telegram (token, chi può scrivere, chi approva), senza riavviare. In alternativa, per l'istanza principale, da `.env`:

1. Crea un bot con @BotFather e metti il token in `TELEGRAM_BOT_TOKEN`.
2. Metti in `OWNI_TELEGRAM_ALLOWED_USERS` gli ID numerici di chi può scrivere al bot, e in `OWNI_TELEGRAM_APPROVERS` chi riceve le schede di approvazione dei tool. Ogni persona apre il bot e preme Start una volta.
3. Riavvia. Chi non è in elenco non riceve risposta (e finisce nell'audit).
4. Facoltativo, webhook invece del long polling: con `OWNI_PUBLIC_URL` in https e `OWNI_TELEGRAM_WEBHOOK_SECRET` (lettere, cifre, `_` e `-`), all'avvio Owni registra il webhook e Telegram manda i messaggi a `OWNI_PUBLIC_URL/hooks/telegram/<istanza>`. Il reverse proxy deve far passare quel percorso. Serve quando il processo può spegnersi (Owni Cloud); in self-host il long polling va benissimo.

## 6. Segreteria commerciale

Richiede un **secondo** bot (due processi in long polling sullo stesso token si rubano gli update):

```text
OWNI_SEGRETERIA_TELEGRAM_BOT_TOKEN=...
OWNI_SEGRETERIA_SALES=<ID Telegram dei commerciali>
GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN    # scope gmail.readonly + gmail.send
HUBSPOT_ACCESS_TOKEN                                         # scope crm.objects.contacts.read/write
```

Al primo avvio la segreteria ignora la posta già presente e parte da quella nuova. Le pratiche si gestiscono su Telegram o nella console (pagina Segreteria). Nessuna mail parte senza Approva. Un'app Google in modalità «Testing» ha refresh token che scadono dopo 7 giorni: per l'uso reale pubblica l'app OAuth.

La segreteria controlla la partita IVA scritta nelle mail senza rete ([ADR 0049](adr/0049-partita-iva-nella-segreteria.md)): se è sbagliata non la salva, la scheda lo dice e la bozza chiede al cliente di ricontrollarla. Se un cliente dice che il suo numero è giusto, controllalo con `vat_check`: un numero di un paese fuori dal VIES (Regno Unito, Svizzera, Norvegia, San Marino) è controllato solo nella forma.

## 6b. Google per persona (Gmail e Calendar; scrittura con approvazione)

Ogni persona collega il proprio account Google dal menu del suo account nella console; Owni lo usa solo nelle conversazioni di quella persona dalla console e nel suo brief del mattino. Per attivarlo:

1. In Google Cloud console crea un client OAuth di tipo «Applicazione web» e aggiungi come URI di reindirizzamento `OWNI_PUBLIC_URL/oauth/google/callback` (in locale `http://localhost:8080/oauth/google/callback`).
2. Abilita Gmail API e Google Calendar API nel progetto.
3. In `.env`: `OWNI_GOOGLE_CLIENT_ID`, `OWNI_GOOGLE_CLIENT_SECRET` e, se serve, `OWNI_GOOGLE_SERVICES` (`gmail,calendar`, il default, oppure uno dei due). Riavvia.
4. In Impostazioni l'owner attiva «Consenti Google a questa istanza».
5. Facoltativo: `OWNI_GOOGLE_WRITE=1` perché Owni prepari mail, risposte, bozze ed eventi. Mail inviate, risposte, eventi con invitati, modifiche e cancellazioni succedono solo quando la persona di cui è l'account li approva, dalla card in chat o in Approvazioni ([ADR 0021](adr/0021-google-scrivere-con-approvazione.md)); una bozza e un evento senza invitati si fanno subito, senza card ([ADR 0120](adr/0120-approvazioni-per-rischio.md)), e nell'audit risultano come `google_action.direct`. Chi aveva già collegato Google lo ricollega dal menu del suo account. Nell'audit: `google_action.*`, senza indirizzi né testi. Una richiesta con «esito incerto» (Google non ha risposto, o Owni si è riavviata a metà) non si ripete: la persona controlla in Gmail o nel calendario.

Verifica dell'app da parte di Google: `calendar.readonly` è uno scope «sensitive» (verifica di pochi giorni), `gmail.readonly` è «restricted» e per un'app pubblica che conserva i dati sul server richiede una valutazione di sicurezza annuale da un assessor approvato da Google. Finché l'app è in «Testing» i refresh token scadono dopo 7 giorni e possono collegarsi solo gli utenti di test; in un'organizzazione Google Workspace l'amministratore può marcare l'app come attendibile. Per partire senza la valutazione: `OWNI_GOOGLE_SERVICES=calendar`.

Il brief del mattino si attiva dalla pagina Task; `pnpm owni brief` dice quanti sono attivi e quante persone lo ricevono e lo usano. La memoria di una persona vale solo nelle sue conversazioni private (console, chat privata di Telegram), mai nei gruppi.

Il refresh token resta nel secret store del tenant; «Scollega» lo cancella e lo revoca presso Google. In Owni Cloud il control plane passa le variabili alle celle nuove e riceve lui il ritorno da Google (`https://<dominio>/oauth/google/callback`, da registrare come unico URI), poi rimanda la persona alla sua cella.

## 6c. Owni Cloud su un server (control plane e celle container)

Per offrire Owni come servizio su un solo server in UE (ADR 0008). Serve Docker 28 o successivo (prima, le porte pubblicate su 127.0.0.1 erano raggiungibili dalla rete locale), Node 24 e pnpm.

1. Un utente dedicato, nel gruppo `docker` (l'accesso al socket di Docker equivale a root: nessun altro servizio con quell'utente). Clona il repository, `pnpm install --frozen-lockfile`, poi costruisci l'immagine delle celle: `docker build -t owni:local .`.
2. In `.env` del control plane: `OWNI_CLOUD_DOMAIN` (dominio delle celle, separato da quello di Buildrs e registrato nella Public Suffix List, ADR 0007), `OWNI_CLOUD_SCHEME=https`, `OWNI_CLOUD_PROVIDER=docker`, `OWNI_CLOUD_DOCKER_IMAGE=owni:local`, la chiave del modello (passa alle celle), `OWNI_CLOUD_SMTP_URL` e `OWNI_CLOUD_MAIL_FROM` per i link di accesso, e se serve `OWNI_CLOUD_CELL_MEMORY_MB` (intero, almeno 128; default 512).
3. `pnpm cloud` come servizio (systemd), dietro un reverse proxy https per `dominio` e `*.dominio` (certificato wildcard) che passa l'header `Host` così com'è: lo smistamento alle celle si basa su quello. Il control plane ascolta su 127.0.0.1.
4. Blocca ai container l'endpoint dei metadati del cloud e i servizi dell'host, e rendi la regola permanente (per esempio con `iptables-persistent`): `iptables -I DOCKER-USER -d 169.254.169.254 -j DROP` (e l'equivalente IPv6 se il provider lo espone). Sull'host niente in ascolto su 0.0.0.0 oltre al reverse proxy.
5. Backup ogni notte dei volumi `owni-cell-*` (contengono tutto di ogni tenant) e di `data-cloud/control-plane.json`. Ripristino: ricrea il volume con lo stesso nome, rimetti i file, e la cella riparte al primo messaggio.
6. Aggiornare (nuova versione, nuova chiave del modello): ferma `pnpm cloud`, ricostruisci l'immagine, `pnpm cloud upgrade` (ricrea i container tenendo i volumi), riavvia `pnpm cloud`.

Le celle stanno tutte sulla rete `owni-cells`, dove i container non si parlano fra loro. `OWNI_TEST_DOCKER_IMAGE=owni:local pnpm vitest run test/docker-provider.test.ts` prova il giro completo su un daemon vero.

Il computer delle istanze, in Owni Cloud, gira su Fly: vedi 6j, «Su Fly».

`pnpm cloud status` elenca i tenant (email, data, stato della cella, prossimo risveglio) e la spesa sul modello di oggi, del mese e del mese scorso, stimata dai prezzi di listino. Le celle accese vengono interrogate; per quelle che dormono mostra l'ultima spesa letta, senza svegliarle. Il control plane conserva la spesa di ogni mese, anche di quelli chiusi, per la fattura. Funziona con `docker` e `railway`; con il provider `local` (solo sviluppo) le celle sono processi del control plane e da un altro processo risultano tutte spente.

## 6d. Owni Cloud su Railway

In alternativa al server (in valutazione, docs/week9.md): ogni cella è un progetto Railway con un servizio dall'immagine di Owni, un volume su `/data`, la regione EU West (Amsterdam) e la modalità serverless, che la fa dormire da sola dopo qualche minuto senza traffico e la risveglia alla prima richiesta.

1. L'immagine: il workflow `Image` la pubblica su `ghcr.io/<owner>/owni:latest` a ogni merge su `main`. Se il pacchetto GHCR è privato, Railway ha bisogno delle credenziali del registry (o rendi pubblico il pacchetto).
2. Un token di account o workspace Railway (Account Settings → Tokens).
3. In `.env` del control plane: `OWNI_CLOUD_PROVIDER=railway`, `RAILWAY_API_TOKEN`, `OWNI_CLOUD_RAILWAY_IMAGE`, facoltativi `OWNI_CLOUD_RAILWAY_WORKSPACE` e `OWNI_CLOUD_RAILWAY_REGION` (default `europe-west4-drams3a`), più dominio, chiave del modello e SMTP come in 6c.
4. Il control plane (anche lui su Railway o altrove) raggiunge ogni cella sul suo dominio `*.up.railway.app` in https. La cella risponde solo alle richieste che portano l'intestazione del control plane (derivata dal segreto di cella); una richiesta diretta al dominio Railway riceve 404.
5. Aggiornare: `pnpm cloud upgrade` aggiorna le variabili e rifà il deploy di ogni cella; i volumi restano.

## 6e. Navigazione web

In Impostazioni → Navigazione web l'owner elenca i siti che l'istanza può leggere e fotografare (un dominio per riga, sottodomini compresi; `*` per tutti i siti pubblici). Vuoto vuol dire nessuno. Gli indirizzi interni (rete locale, metadati del cloud) restano negati comunque. Per gli screenshot serve Chromium: nell'immagine Docker con `docker build --build-arg WITH_BROWSER=1 .` (l'immagine pubblicata su GHCR lo ha), senza Docker con `OWNI_CHROMIUM_PATH` o il browser di Playwright. Chromium deve partire con il suo sandbox; se nel log compare «screenshots off», o si dà al container quello che serve agli user namespace, o si accetta il rischio con `OWNI_SCREENSHOTS_WITHOUT_SANDBOX=1` (ADR 0009).

Lo stesso Chromium fa da browser con clic (`web_browse`, `web_click`, `web_type`, ADR 0014): niente da configurare in più, e «screenshots off» vuol dire anche browser spento. Il browser legge e basta: le richieste non GET non partono, per inviare c'è `web_submit` con approvazione. Al più 4 sessioni per server, una per conversazione, chiuse dopo 5 minuti senza azioni e perse al riavvio; ogni pagina ha un tetto di 400 richieste e 40 MB. Chromium parte senza DNS proprio (`--host-resolver-rules`) e con WebRTC limitato al proxy, che non esiste: ogni richiesta passa dal fetch controllato.

Con `OWNI_SEARCH_API_KEY` (Brave Search, [chiavi.md](chiavi.md) punto 13) le istanze possono anche cercare (`web_search`, ADR 0017). L'owner lo consente istanza per istanza in Impostazioni → Ricerca sul web (connettore `web_search` nella egress policy, cambio registrato nell'audit). Al servizio vanno solo le parole cercate, con paese e lingua (`OWNI_SEARCH_COUNTRY`, `OWNI_SEARCH_LANG`, Italia e italiano di default); nell'audit c'è `web_search.ran` con il numero di risultati, mai la ricerca. Le pagine trovate si aprono solo dai siti consentiti: la stessa scheda ha un pulsante, con conferma, per consentirli tutti. Ogni account fa al più `OWNI_SEARCH_MAX_PER_DAY` ricerche al giorno (200 di default, contate dal processo: un riavvio azzera il conto del giorno), poi Owni risponde con quello che sa e lo dice. Il costo delle ricerche non entra nel tetto di spesa del modello: si controlla sulla dashboard di Brave. `pnpm owni check` prova la chiave.

Meteo (settimana 41, [ADR 0039](adr/0039-meteo.md)): con `OWNI_WEATHER=1` (Open-Meteo, server in Europa e Nord America, [chiavi.md](chiavi.md) punto 16) tutte le istanze hanno il meteo (`weather`): condizioni di adesso, fasce di oggi e domani, previsioni fino a 16 giorni. Non c'è un interruttore per istanza: lo decide l'operatore per il server. Al servizio vanno solo il nome del posto cercato e le sue coordinate; nell'audit c'è `weather.ran` con il numero di giorni chiesti, mai il posto. Ogni account fa al più `OWNI_WEATHER_MAX_PER_DAY` chiamate al tool al giorno (200 di default, contate dal processo come le ricerche, solo quelle riuscite; ognuna sono 2 chiamate al servizio), poi Owni lo dice senza inventare previsioni. Senza chiave l'uso è consentito solo per scopi privati o non commerciali (10.000 chiamate al giorno, 5.000 all'ora, 600 al minuto, 300.000 al mese); a un'azienda, anche in self-host, serve un piano a pagamento con `OWNI_WEATHER_API_KEY`, `OWNI_WEATHER_URL=https://customer-api.open-meteo.com/v1/forecast` e in `OWNI_WEATHER_GEOCODING_URL` l'indirizzo di ricerca che dà Open-Meteo. Non ci sono allerte ufficiali: per quelle Owni usa la ricerca sul web (Protezione Civile, siti regionali), se attiva. `pnpm owni check` prova il servizio.

Cambi delle valute (settimana 42, [ADR 0040](adr/0040-cambi.md), [chiavi.md](chiavi.md) punto 17): con `OWNI_EXCHANGE_RATES=1` tutte le istanze convertono le valute con i cambi di riferimento della BCE (`exchange_rate`), dal 04/01/1999 a oggi, anche alla data di una fattura, con più importi e il totale, l'andamento fino a un anno indietro (`since`) e l'elenco delle valute (`list`). Come ogni servizio esterno è spento finché l'operatore non lo accende, anche se al servizio non va niente di chi scrive: Owni scarica solo i file pubblici della BCE e li tiene in memoria nel processo. Il file del giorno resta finché non è dovuta la pubblicazione successiva (l'ultimo giorno lavorativo TARGET, oggi solo dalle 16:00); dopo le 16:00 senza i cambi di oggi lo richiede al più ogni 5 minuti, dopo le 18:00 al più ogni ora fino a mezzanotte, e intanto Owni dice che oggi la BCE non ha pubblicato. Il file degli ultimi 90 giorni e lo storico completo (per una data più vecchia; secondo la nostra stima meno di 10 MB, con un tetto di 32 MB) restano sei ore. Un errore del servizio vale per due minuti senza nuove richieste; Owni lo dice e non inventa un cambio. Non c'è un conto giornaliero né una riga nell'audit. Nel fine settimana, nei festivi TARGET (1º gennaio, Venerdì santo, Lunedì dell'Angelo, 1º maggio, 25 e 26 dicembre) e prima delle 16:00 Owni usa l'ultimo cambio pubblicato e dice perché. I cambi BCE sono solo informativi: non valgono per le operazioni di mercato, e banche e carte applicano il proprio cambio; il rublo è sospeso dal 2 marzo 2022; nel 2026 le valute sono 29 (niente più lev bulgaro, che dal 2026 ha il cambio fisso con l'euro). `OWNI_EXCHANGE_RATES_URL` serve solo per i test o un mirror. `pnpm owni check` scarica i cambi del giorno.

Notizie (settimana 43, [ADR 0043](adr/0043-notizie.md), [chiavi.md](chiavi.md) punto 18): con `OWNI_NEWS=1` tutte le istanze danno i titoli recenti dei feed RSS e Atom scelti dall'operatore (`news_headlines`, che per le notizie viene prima di `web_search`): l'elenco predefinito (ANSA, Rai News, Sky TG24, Corriere della Sera, la Repubblica, Il Post, Il Sole 24 Ore, BBC) o quello in `OWNI_NEWS_FEEDS`, al più 30 feed `Nome|https://indirizzo|sezione`. Per le notizie in generale legge solo i feed di ultima ora e Italia, tutti quando la persona chiede un argomento (`topic`, cercato nei titoli e nei riassunti sul server, singolare e plurale insieme, sinonimi con `|`), un giornale (`source`) o una sezione; `day` dà le notizie di oggi o di ieri nel fuso del server. Come ogni servizio esterno è spento finché l'operatore non lo accende, anche se ai feed non va niente di chi scrive: Owni scarica solo i loro indirizzi fissi, quattro alla volta, e un rimando al più 3 volte e solo verso indirizzi https pubblici. Ogni feed ha 6 secondi e la risposta al più 8: quelli in ritardo Owni li nomina e continuano a scaricarsi per la domanda successiva. Ogni feed resta in memoria nel processo 10 minuti, un errore 2 minuti; un feed che non risponde non ferma gli altri, e Owni dice per nome quali fonti non hanno risposto quando non ha titoli da dare o quando la persona le aveva scelte. Un feed oltre 2 MB, o una risposta che non è RSS, RDF o Atom (una pagina HTML, un errore), è rifiutato; di ogni feed contano al più 100 notizie con un titolo e una data valida (una notizia senza data, o datata più di un giorno avanti, non si mostra; una notizia non è mai più recente della prima volta che Owni l'ha vista, così un feed con date nel futuro o sempre «adesso» non resta in cima; una data senza ora vale per quel giorno di calendario, com'è scritta, e si mostra senza ora; un fuso sconosciuto vale come UTC); il link è facoltativo, solo http(s), e senza Owni scrive «(senza link)». Lo stesso titolo o lo stesso link una volta sola. Titoli, riassunti e link sono dati dall'esterno, recintati come le pagine web e ripuliti dai caratteri invisibili; i link si mostrano e basta, li apre `web_read` se l'istanza ha gli strumenti web. Non c'è un conto giornaliero né una riga nell'audit. Nel brief del mattino, se la persona l'ha chiesto, le 3 notizie delle ultime 12 ore (o del suo argomento). `pnpm owni check` scarica ogni feed con 15 secondi ciascuno e li elenca tutti: qualcuno che non va o senza notizie datate è un avviso, nessuno che risponde un errore.

Partita IVA (settimana 44, [ADR 0047](adr/0047-partita-iva.md), [chiavi.md](chiavi.md) punto 20): tutte le istanze hanno sempre `vat_check`, che controlla sulla carta partite IVA (cifra di controllo, matricola non tutta a zero e codice dell'ufficio IVA), numeri IVA dei paesi del VIES (la forma di ciascuno, EL per la Grecia, XI per l'Irlanda del Nord) e codici fiscali (forma, omocodia da destra, mese, giorno e carattere di controllo; con «IT» davanti o un'etichetta come «P.IVA:», «partita IVA n.», «P.I.», «C.F.» o «Cod. Fisc.» va bene lo stesso; «IT» seguito da lettere si legge sempre come codice fiscale, anche corto), senza chiedere niente a nessuno. Di un codice fiscale Owni dice solo che sembra scritto giusto, perché all'Agenzia delle Entrate non si può verificare da qui; un numero di 11 cifre che comincia con 8 o 9 e passa gli stessi controlli è il codice fiscale numerico di un ente senza partita IVA, e Owni lo dice senza chiedere al VIES. Senza VIES, per una partita IVA italiana Owni rimanda a «Verifica partita IVA» sul sito dell'Agenzia delle Entrate. Con `OWNI_VAT_CHECK=1` una partita IVA scritta giusta va anche al VIES della Commissione europea, che dice se è attiva per le operazioni intracomunitarie, con nome e indirizzo quando lo Stato membro li comunica (recintati come dati dall'esterno) e data e ora del controllo. Al VIES vanno solo il paese e il numero; se rifiuta un numero scritto giusto (lo Stato membro ha regole più strette della forma), Owni lo dice e la risposta vale un'ora. «Non attiva nel VIES» non vuol dire inesistente: molte partite IVA italiane valide non sono abilitate agli scambi intra-UE, e Owni lo dice. Ogni risposta resta in memoria nel processo un'ora per account e numero (un account non vede mai quando un altro ha controllato), un errore due minuti, al più 2000 numeri in tutto. Owni non segue rimandi del VIES; ha 10 secondi e al più 64 KB di risposta. Ogni account fa al più `OWNI_VAT_CHECK_MAX_PER_DAY` richieste al VIES al giorno (200 di default) e tutto il server al più `OWNI_VAT_CHECK_MAX_PER_DAY_SERVER` (2000 di default), perché il VIES blocca l'indirizzo che chiede troppo; i conti sono del processo, e le risposte in memoria non contano. Finiti, Owni lo dice e resta il controllo sulla carta. Quando uno Stato membro non risponde (succede spesso di notte e nel fine settimana) o il VIES ha troppe richieste, Owni lo dice, invita a riprovare fra qualche minuto e non dice mai se il numero è valido. Non c'è una riga nell'audit: non cambia niente, e il numero non si scrive mai. Nella chat del brief del mattino, e in una chiamata senza conversazione, `vat_check` fa solo il controllo sulla carta e chiede di scriverle altrove per il VIES: il numero verrebbe da una mail, e non va al VIES né consuma il conto. `pnpm owni check` chiede al VIES la partita IVA di ENI: non attiva o servizio italiano giù è un avviso, nessuna risposta un errore. In ogni tool che recinta dati dall'esterno (pagine, feed, mail, uscita del computer, VIES) un `<<<` seguito da parole che imitano un segno del recinto («dati dal web», «fine dati…», «uscita…») diventa `‹‹‹`, così il testo non può fingere di chiuderlo; codice, doctest, here-string e conflitti di git restano come sono.

Le sentinelle (`watch_*`, ADR 0018) non chiedono niente all'operatore: leggono con lo stesso fetch controllato, dai siti consentiti dell'istanza riletti a ogni controllo, e girano nel passaggio dello scheduler (ogni 30 secondi, al più 20 pagine per passaggio, 4 alla volta, 10 secondi per pagina). Ogni istanza ne ha al più 20, una ogni 30 minuti al più spesso. Il modello lavora solo quando una sentinella ha qualcosa da dire; nell'audit ci sono `watch.created`, `watch.deleted` e `watch.fired` con ID e sito, mai il testo della pagina. Dopo 6 controlli falliti di fila, o 8 messaggi in 24 ore, una sentinella si ferma e lo scrive nella sua conversazione; le persone la vedono, la riattivano e la cancellano in «Task e sentinelle». Se una sentinella non avvisa: guardare lì l'ultimo errore (sito non consentito, pagina che non risponde, frase che non c'è più); se la persona non può più scrivere all'istanza o il canale è stato tolto, la sentinella si ferma senza scrivere. Quando cambia il modo in cui Owni ricava il testo da una pagina (settimana 43, versione 2), la prima lettura di ogni sentinella rifà la base in silenzio, senza avvisare; una soglia di prezzo superata proprio in quel controllo si vede al cambio successivo.

## 6f. Abbonamenti (Stripe)

Senza `OWNI_CLOUD_STRIPE_SECRET_KEY` Owni Cloud è gratuito. Con la chiave, ogni tenant ha una prova (`OWNI_CLOUD_TRIAL_DAYS`, 14 giorni di default) e poi serve l'abbonamento; finita la prova senza abbonamento la cella resta spenta, con i dati intatti (ADR 0010).

1. In Stripe crea un prodotto «Owni» con un prezzo mensile ricorrente: il suo id (`price_…`) va in `OWNI_CLOUD_STRIPE_PRICE`.
2. Facoltativo, il consumo del modello: crea un contatore (Billing → Meters) con aggregazione «somma», chiave cliente `stripe_customer_id` e valore `value`. Poi crea un prezzo a consumo collegato al contatore. Un'unità è un centesimo di dollaro di costo del modello a prezzi di listino. Il prezzo per unità copre cambio e ricarico: se un centesimo di dollaro vale X euro, X × 1,5 è un ricarico del 50%. Nome dell'evento del contatore in `OWNI_CLOUD_STRIPE_METER_EVENT`, id del prezzo in `OWNI_CLOUD_STRIPE_USAGE_PRICE`.
3. Developers → Webhooks → aggiungi l'endpoint `https://<dominio>/stripe/webhook` con gli eventi `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` e `customer.subscription.deleted`. Il segreto di firma (`whsec_…`) va in `OWNI_CLOUD_STRIPE_WEBHOOK_SECRET`. A ogni evento il control plane rilegge l'abbonamento da Stripe: la chiave deve poter leggere le subscription.
4. Settings → Billing → Customer portal: attiva il portale (fatture, carta, disdetta). In Settings → Billing → Subscriptions and emails, per i pagamenti non riusciti scegli di annullare l'abbonamento dopo l'ultimo tentativo: finché resta «in ritardo», Owni continua a funzionare.
5. Prova in modalità test (chiavi `sk_test_…`) con le carte di prova di Stripe, poi passa alle chiavi live.

Le persone si abbonano dalla pagina di Owni Cloud («Gestisci l'abbonamento», con il link via email) o, a prova finita, dal link che ricevono entrando. Chi si abbona durante la prova paga dalla fine della prova. `pnpm cloud status` mostra per ogni tenant: in prova fino a quando, abbonato, pagamento in ritardo, oppure sospeso (con lo stato Stripe se l'abbonamento è stato annullato). Lo legge da quello che il control plane ha salvato, quindi non servono le variabili Stripe nella shell. Un secondo abbonamento dello stesso tenant (due pagamenti da due schede) compare nel log del control plane: va rimborsato e annullato su Stripe.

## 6g. WhatsApp

Ogni istanza può avere un numero WhatsApp Business, collegato dall'owner in Impostazioni → WhatsApp con token di accesso, ID del numero e app secret dell'app Meta (passi in [chiavi.md](chiavi.md), punto 9). I messaggi arrivano solo per webhook, quindi serve `OWNI_PUBLIC_URL` in https. In Owni Cloud il control plane inoltra `/hooks/whatsapp/…` alla cella e la sveglia. Meta firma ogni consegna con l'app secret: una consegna senza firma valida riceve 401. Chi non è in «Chi può scrivere» non riceve risposta e i suoi file non vengono scaricati.

WhatsApp consente risposte libere solo entro 24 ore dall'ultimo messaggio della persona. Owni ricorda quando ognuna delle persone ammesse ha scritto l'ultima volta (`whatsapp-window.json` nella cartella dell'istanza), dall'ora del messaggio e non da quella in cui Meta lo consegna. Un messaggio che parte più tardi, per esempio un brief o un promemoria, viene tenuto da parte (una volta sola, anche se l'invio viene ritentato) e consegnato appena la persona scrive; esce dall'attesa solo dopo essere partito. Se in Impostazioni → WhatsApp c'è un template approvato da Meta, con una variabile `{{1}}` nel corpo, Owni lo manda con un estratto del primo messaggio: uno solo per finestra chiusa, perché Meta fa pagare ogni template. Nel registro un messaggio messo in attesa risulta consegnato: se ne restano più di 20 per persona, i più vecchi si perdono e il log lo dice. I file non possono aspettare: fuori finestra vengono rifiutati. Per chi non ha ancora scritto da quando c'è questa versione la finestra non è nota: il messaggio parte, e se Meta lo rifiuta più tardi il motivo finisce nel log («not delivered: outside the 24-hour window»).

I messaggi passano dai server di Meta, che li conserva secondo le sue regole: per i dati in Unione Europea va verificata l'opzione di archiviazione locale della Cloud API e va indicato Meta nell'informativa.

## 6h. Messaggi vocali

Con `OWNI_TRANSCRIBE_URL` e `OWNI_TRANSCRIBE_API_KEY` i vocali di Telegram e WhatsApp possono essere trascritti e arrivare a Owni come testo, marcati «[Messaggio vocale, trascritto]». L'owner lo consente istanza per istanza in Impostazioni → Messaggi vocali (connettore `voice` nella egress policy, cambio registrato nell'audit); finché non lo fa, l'audio non esce e Owni chiede di scrivere. Il servizio deve avere la stessa API di OpenAI (`/audio/transcriptions`); il consigliato è Mistral, con server in UE ([chiavi.md](chiavi.md), punto 10). L'audio va solo a quel servizio, e solo per le persone che possono scrivere: il vocale di un estraneo non viene nemmeno scaricato. Su Telegram i vocali più lunghi di `OWNI_TRANSCRIBE_MAX_SECONDS` (300 di default) non vengono nemmeno scaricati; WhatsApp non dice la durata, quindi lì vale solo il limite di 20 MB del download. Un vocale troppo grande arriva come nota, non si perde. Se il servizio non risponde, Owni riceve una nota e chiede di riprovare o di scrivere. `pnpm owni check` controlla chiave e modello. Il costo della trascrizione non entra nel tetto di spesa del modello: si controlla sulla console del servizio.

Registrazioni lunghe (settimana 38, [ADR 0033](adr/0033-registrazioni-lunghe.md)): i vocali e i file audio più lunghi di `OWNI_TRANSCRIBE_MAX_SECONDS` non sono più rifiutati, ma salvati nel workspace come registrazioni, e così i file audio e video caricati dalla console o mandati come documento. Con `audio_transcribe` Owni li trascrive a pezzi di dieci minuti, tre alla volta, con lo stesso servizio e lo stesso consenso dei vocali; la trascrizione, con l'ora di ogni passaggio, va in `trascrizioni/`. Formati: MP3, M4A, WAV, Ogg/Opus e il sonoro dei video MP4 si tagliano; FLAC, WebM e AMR solo se stanno in un pezzo. Limiti: `OWNI_TRANSCRIBE_MAX_MINUTES` (180) per registrazione e `OWNI_TRANSCRIBE_MINUTES_PER_DAY` (600) per account, contati per processo come le altre quote giornaliere; i file restano entro i 20 MB del workspace e dei download di Telegram e WhatsApp. L'audit registra `recording.transcribed` con durata e pezzi.

Cerca nei file (settimana 39, [ADR 0035](adr/0035-cerca-nei-file.md)): `file_search` cerca le parole nel testo dei file del workspace e dei documenti, e nei nomi. Non serve configurare niente e non esce niente dal server. Una ricerca guarda al più 5000 file, 300 MB e 60 milioni di caratteri e dura al più un minuto, partendo dai più recenti (gli altri file li cerca solo per nome); il testo dei documenti resta in memoria, per istanza, fino a 4 milioni di caratteri, così le ricerche successive non rileggono i PDF; la ricerca usa un solo worker dei documenti alla volta e ne aspetta uno libero per tre secondi al più. Niente audit: la ricerca non cambia nulla.

Liste (settimana 40, [ADR 0038](adr/0038-liste.md)): `list_add`, `list_show`, `list_check`, `list_remove` e `list_edit` tengono le liste in `lists.json` nella cartella dell'istanza, cambiate sotto lo stesso lock della memoria. Non serve configurare niente e non esce niente dal server. Una lista è di una persona o condivisa (`owner` `*`); al più 30 liste per persona e 30 condivise, 200 voci da fare e le 50 fatte più recenti per lista. L'audit registra `list.changed` con l'id della lista, il tipo di cambiamento e quante voci, mai nomi o voci. Per vedere o correggere le liste di un'istanza a mano basta leggere `lists.json`, con l'istanza ferma se lo si modifica.

## 6i. Telefono

Ogni istanza può avere un numero Twilio, collegato dall'owner in Impostazioni → Telefono con Account SID, auth token e numero ([chiavi.md](chiavi.md), punto 11). Owni imposta da sola l'indirizzo delle chiamate del numero su `/hooks/phone/<istanza>`, quindi serve `OWNI_PUBLIC_URL` in https; in Owni Cloud il control plane inoltra la chiamata alla cella e la sveglia. Twilio firma ogni richiesta con l'auth token (`X-Twilio-Signature`): senza firma valida, 403. Una chiamata da un numero che non è in «Chi può chiamare» viene rifiutata prima di rispondere. Poiché il numero di chi chiama si può falsificare, all'inizio di ogni chiamata si digita il codice scelto dall'owner; tre codici sbagliati chiudono la chiamata e finiscono nel log.

Le automazioni ([ADR 0060](adr/0060-automazioni.md)) rispondono su `/hooks/automazione/<agente>/<id>`: il reverse proxy deve far passare quel percorso, e per darle a servizi esterni serve `OWNI_PUBLIC_URL` (senza, il messaggio con l'indirizzo dà solo il percorso). Un servizio che riceve 404 ha l'indirizzo o il token sbagliati, o l'automazione è stata cancellata; 409 vuol dire che la persona non può più parlare con l'agente o il canale della sua conversazione è spento; 429 che ha superato le 30 chiamate l'ora. Le automazioni stanno in `automations.json` nella cartella dell'istanza, con il solo hash dei token.

Una chiamata è a turni: Twilio trascrive la frase, Owni risponde, Twilio la legge. La cella aspetta la risposta fino a 8 secondi per richiesta e, se serve di più, fa dire «un momento»; dopo sei attese la chiamata si chiude e la risposta resta da parte (`phone-pending.json` nella cartella dell'istanza, al massimo 5 per numero e per 7 giorni), detta all'inizio della chiamata dopo. Le schede di approvazione e i file non passano dal telefono: arrivano sugli altri canali o nella console. Al telefono Owni non crea task programmati. Scollegare il numero cancella le credenziali e le risposte in attesa; l'indirizzo delle chiamate resta impostato su Twilio, e la cella rifiuta quelle chiamate senza rispondere. A ogni avvio Owni reimposta l'indirizzo delle chiamate, quindi dopo un cambio di `OWNI_PUBLIC_URL` basta riavviare. Riavviare la cella mentre una chiamata è in corso la fa cadere; la risposta non si perde.

La voce passa da Twilio, che fa riconoscimento e sintesi: per i dati in UE scegli la regione Irlanda (`OWNI_TWILIO_API`) e indica Twilio nell'informativa. Il costo delle chiamate lo fattura Twilio e non entra nel tetto di spesa del modello.

## 6j. Il computer delle istanze

Owni può eseguire comandi (Python, `jq`, `sqlite3`, `pandoc`, gli strumenti PDF) in un computer suo, un container per istanza collegato a internet e senza segreti ([ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md), [ADR 0124](adr/0124-il-computer-dell-agente-ha-la-rete.md)): può installare pacchetti, clonare repository, scaricare dati e chiamare API pubbliche. Serve Docker 20.10 o più recente sullo stesso server.

**Prima di accenderlo: il socket di Docker equivale a root sul server.** Chi lo usa può creare un container che monta tutto il disco. Accendilo solo dove Owni è l'unico servizio della macchina, e mai in Owni Cloud: lì il computer gira solo su Fly (sotto, «Su Fly»).

1. Costruisci l'immagine: `docker build -f docker/computer.Dockerfile -t owni-computer:latest docker`. Va rifatta quando cambia il Dockerfile; al comando dopo, ogni computer viene ricreato con la nuova immagine e i suoi file restano.
2. In `.env`: `OWNI_COMPUTER=docker`. Le altre variabili hanno valori di default: `OWNI_COMPUTER_IMAGE` (`owni-computer:latest`), `OWNI_DOCKER_SOCKET` (`/var/run/docker.sock`), `OWNI_COMPUTER_MEMORY_MB` (1024), `OWNI_COMPUTER_CPUS` (1), `OWNI_COMPUTER_DISK_MB` (2048, la quota di `/work`), `OWNI_COMPUTER_RUNTIME` (vuoto; `runsc` per gVisor).
3. Con Docker Compose, scommenta in `docker-compose.yml` il socket e `group_add`, con `DOCKER_GID` uguale al gruppo del socket (`stat -c %g /var/run/docker.sock`). Senza Compose, il processo di Owni deve poter leggere e scrivere il socket.
4. `pnpm owni check` dice se Docker risponde e se l'immagine c'è; lo stesso controllo compare nella console (Impostazioni, Computer) e nel log all'avvio.
5. L'owner accende il computer istanza per istanza (Impostazioni, Computer).

Come gira: un container per istanza sulla rete `bridge` di default di Docker (esce verso internet, nessuna porta pubblicata, quindi da fuori non entra niente), nessuna variabile d'ambiente di Owni, file system in sola lettura tranne `/work` (un volume `owni-computer-<hash>`) e `/tmp` (256 MB in memoria), nessuna capability, niente escalation di privilegi, 128 processi, nessun file oltre 1 GB. I comandi girano come uid 1000 e il container come nobody: alla fine di ogni comando tutto quello che il comando ha lasciato acceso viene chiuso. Al massimo 8 computer accesi e 4 comandi alla volta; un computer senza comandi per 10 minuti si ferma. Quando `/work` supera la quota, Owni lo legge nel risultato, i nuovi file restano minuscoli finché non ne cancella e non si copiano altri file dentro. All'avvio Owni ferma i computer rimasti accesi da un avvio precedente: un solo Owni per server Docker, perché due installazioni sullo stesso Docker si fermerebbero i computer a vicenda.

**La rete**: dalla rete `bridge` il computer raggiunge internet, ma anche la rete locale del server e i servizi del server in ascolto su tutte le interfacce (l'indirizzo del bridge, di solito `172.17.0.1`). I servizi che il computer non deve vedere vanno in ascolto solo su `127.0.0.1`, o chiusi dal firewall del server verso `docker0`. Su Fly il problema non c'è: la macchina ha una rete privata sua.

**gVisor** dà al computer un kernel suo invece di quello del server: installa `runsc` ([gvisor.dev](https://gvisor.dev/docs/user_guide/install/)), registralo in `/etc/docker/daemon.json` e imposta `OWNI_COMPUTER_RUNTIME=runsc`. Consigliato se più persone di fiducia diversa usano la stessa installazione.

**Disco**: i volumi dei computer stanno nella cartella dati di Docker (`/var/lib/docker`). Meglio metterla su una partizione sua, così un computer pieno non ferma il server. `docker system df -v` mostra quanto occupa ogni volume `owni-computer-*`; «Azzera i file del computer» nella console cancella container e volume di un'istanza. I file dei computer non sono nel backup della cartella dati: quello che conta Owni lo copia nel workspace.

**Immagine personalizzata**: si può partire da `docker/computer.Dockerfile` e aggiungere strumenti, purché restino l'utente 1000, `/work` suo, `sh`, `timeout`, `du` e `chmod`. Poi `OWNI_COMPUTER_IMAGE` con il nuovo nome. `copy_out` legge i file attraverso Docker, non dentro il computer: un collegamento simbolico o una cartella vengono rifiutati.

### Su Fly (micro-VM, anche per Owni Cloud)

Una micro-VM Fly.io per istanza, con un kernel suo, collegata a internet ma senza indirizzo pubblico né servizi; il primo processo chiude a root l'API di Fly dentro la macchina prima di ogni comando ([ADR 0015](adr/0015-computer-su-micro-vm.md), [ADR 0124](adr/0124-il-computer-dell-agente-ha-la-rete.md)). Non serve Docker sul server.

1. L'immagine: il workflow `Image` pubblica a ogni merge su `main` `ghcr.io/<owner>/owni-computer:fly` (e `:fly-<commit>`), il target `fly` di `docker/computer.Dockerfile`. Rendi pubblico il pacchetto GHCR, o copia l'immagine nel registry di Fly (`registry.fly.io/<app>`). Meglio indicare il tag con il commit: ogni computer passa alla nuova immagine al comando dopo, con i suoi file.
2. Il token dell'organizzazione ([chiavi](chiavi.md) §12).
3. Su un server proprio, in `.env`: `OWNI_COMPUTER=fly`, `FLY_API_TOKEN`, `OWNI_FLY_ORG`, `OWNI_COMPUTER_IMAGE`. Facoltativi: `OWNI_FLY_REGION` (`fra`), `OWNI_COMPUTER_MEMORY_MB` (1024, a passi di 256 e al più 2048 per CPU), `OWNI_COMPUTER_CPUS` (1, intero fino a 8), `OWNI_COMPUTER_DISK_MB` (2048, il volume si arrotonda al gigabyte), `OWNI_COMPUTER_MAX_RUNNING` (8 comandi alla volta), `OWNI_FLY_APP_PREFIX` (solo se Fly dice che il nome è preso).
4. `pnpm owni check` dice se Fly accetta il token; lo stesso nella console e nel log all'avvio.

Un computer senza comandi per 10 minuti si ferma da solo e costa solo il volume; al comando dopo riparte (un primo avvio, con il download dell'immagine, può chiedere un minuto). «Azzera i file del computer» cancella la app Fly con macchina e volume. Le app si chiamano `owni-computer-<hash>`; `fly apps list -o <org>` le mostra. I volumi di Fly non sono nel backup di Owni.

**In Owni Cloud** il token sta solo nel control plane:

1. Nel `.env` del control plane: `OWNI_CLOUD_COMPUTER=fly` più le variabili del punto 3 (senza `OWNI_COMPUTER`). `OWNI_CLOUD_COMPUTER_URL` è l'indirizzo del control plane come lo raggiungono le celle; di default `https://<dominio>`. Con le celle su Railway serve l'indirizzo pubblico del control plane.
2. Il reverse proxy deve passare al control plane `/internal/computer/` con richieste fino a 100 MB (con nginx `client_max_body_size 100m` su quel percorso) e risposte fino a 25 secondi.
3. Le celle esistenti ricevono `OWNI_COMPUTER=cloud` con `pnpm cloud upgrade` (control plane fermo); quelle nuove lo hanno da sole.
4. Per spegnerlo: togli `OWNI_CLOUD_COMPUTER` e rifai `pnpm cloud upgrade`; le celle lo vedono spento nella console.

Tetti per tenant: 2 comandi alla volta, 10 computer, una copia di file alla volta. `pnpm cloud computers` elenca i computer di ogni tenant con la sua app Fly; `pnpm cloud computers delete <tenant>` li cancella, macchine e file, quando un account se ne va.

## 6k. La console come app

- **Installare**: serve l'indirizzo https della console (`OWNI_PUBLIC_URL`); su http i browser non la installano, e la console funziona lo stesso nella scheda. Su iPhone e iPad: Safari, Condividi, «Aggiungi alla schermata Home».
- **Entrare nell'app su iPhone**: l'app ha una sessione sua, separata da Safari. Chi tocca il link in una mail entra in Safari; nell'app incolla il link nella schermata di accesso («Hai il link ma sei nell'app?»).
- **Cosa resta sul telefono**: solo la shell (pagina, script, stile, font, icone), mai `/api`, file o conversazioni. Il service worker chiede sempre prima alla rete, quindi un aggiornamento arriva al primo avvio online.
- **Il proxy** non deve tenere in cache `/sw.js` né `/manifest.webmanifest` (Owni li manda con `no-cache`). Dopo aver cambiato l'elenco dei file della shell in `sw.js`, cambia il nome `CACHE` lì dentro.
- **«Primi passi» spariti**: Impostazioni → Primi passi, oppure `#/inizia`. Il «Nascondi» vale per istanza e per browser (chiave `owni.setup.hidden` nel localStorage).

## 6l. Immagini

Con `OWNI_IMAGE_URL` e `OWNI_IMAGE_API_KEY` ([chiavi.md](chiavi.md), punto 15) Owni crea e ritocca immagini quando gliele chiedono. L'owner lo consente istanza per istanza in Impostazioni → Immagini (connettore `image_generation`, cambio registrato nell'audit come `images.allowed`). Le immagini vanno in `immagini/` del workspace e in chat: nella console si vedono nel messaggio, su Telegram e WhatsApp arrivano come foto (o come documento, se l'app non le prende come foto). `OWNI_IMAGE_MAX_PER_DAY` (100) conta le immagini fatte per account, nel processo: un riavvio azzera il conto del giorno. L'audit registra `image.generated` con il numero di immagini e se era un ritocco, mai la descrizione. Il costo non entra nel tetto di spesa del modello: si controlla sulla console del servizio. Un errore «rifiuta la chiave» vuol dire chiave sbagliata o organizzazione non verificata da OpenAI.

## 6m. Documenti

Owni legge da sola il testo di PDF, Word, Excel, PowerPoint e OpenDocument con `file_read` (ADR 0026): niente chiavi né servizi esterni. La lettura gira in un worker thread, 20 secondi e 512 MB al massimo, due alla volta. Se una persona dice che Owni «non riesce a leggere» un documento, i casi sono questi e Owni li dice: PDF con una password di apertura (quelli protetti solo contro la copia si leggono), scansione senza testo (Owni ne guarda le pagine con `image_view`, ADR 0028; i formati JBIG2 e JPEG 2000 solo dal computer o con una foto), file rovinato o troncato, documento troppo grande o troppo complesso (oltre i limiti o i 20 secondi), vecchi formati `.doc`, `.xls`, `.ppt` e RTF. «Non sono riuscita a leggerlo ora» vuol dire che il worker non è partito o si è fermato: guarda i log del processo e la memoria libera. Un `.p7m` che contiene un PDF, un Word o un Excel si legge come quel documento, e la firma non viene mai verificata. Anche un `.txt.p7m` o `.csv.p7m` fino a 1 MB si legge. Un Excel scritto da uno script senza valori salvati mostra vuote le celle con le formule: aprirlo e salvarlo con Excel o LibreOffice le riempie. Il testo estratto dei 4 documenti letti per ultimi resta in memoria, per istanza; un riavvio lo libera.

Owni crea file Word, Excel e PDF con `document_create` (ADR 0029), nello stesso worker della lettura e senza chiavi né programmi esterni. Se una persona dice che un documento «non si apre» o è sbagliato, i casi sono questi: un PDF con emoji o alfabeti non latini (le emoji sono tolte, lettere come ș e ř perdono il segno, gli altri alfabeti diventano «?»: Owni lo dice e propone Word); un Excel con qualche formula vuota in un'anteprima del telefono (Owni salva il valore solo delle formule semplici; le altre si calcolano all'apertura in Excel, LibreOffice e Numbers); una formula rifiutata perché usa una funzione fuori dall'elenco ammesso, come quelle che chiamano il web, servizi cloud o altri file (scelta voluta, ADR 0029); un totale sbagliato perché la formula conta righe diverse da quelle della tabella (Owni dice a che riga sono le intestazioni); un'immagine lasciata fuori perché non è nel workspace, non è PNG o JPEG o supera 10 MB. «Il documento è troppo lungo da creare» vuol dire oltre i 20 secondi del worker o oltre le 300 pagine.

Owni disegna grafici con `chart_create` (ADR 0030), nello stesso worker, senza chiavi né font installati. Se una persona dice che un grafico è sbagliato, i casi sono questi: un nome con lettere non latine scritto con «?» (le emoji sono tolte apposta); un valore che non compare sopra la sua barra perché non entrava (scelta voluta: si scrivono il più alto, il più basso e l'ultimo); le fette piccole di una torta raccolte in «Altri»; una riga «Totale» di un CSV lasciata fuori; numeri in scala corta («€ 12,5 mila»). «Troppe barre per lo spazio» chiede di raggruppare i dati o di usare una linea; «il grafico è troppo complesso da disegnare» vuol dire oltre i 20 secondi del worker, e non dovrebbe succedere con i limiti dell'ADR: va guardato.

Owni fa i conti e risponde alle domande sulle tabelle con un programma Python, `code_run` ([ADR 0119](adr/0119-programmi-python.md)), senza chiavi né rete. Ogni esecuzione è un processo Node a parte con Pyodide: 60 secondi e 512 MB al massimo, due alla volta (le altre aspettano fino a 45 secondi, poi «Python è occupato con altro, riprova tra poco»). Se una persona dice che un totale è sbagliato, guarda nel turno il programma che Owni ha scritto (è nella chiamata del tool) e la sua uscita: di solito è un filtro sbagliato o una colonna letta male, e si corregge chiedendo a Owni di rifare il conto. Un Excel o un OpenDocument arriva al programma come un CSV per foglio, con i valori come li mostra il foglio («1250,5», «12,5 €»): il programma li converte. «Il codice è andato oltre 60 secondi» o «ha usato più memoria» vuol dire una tabella troppo grande o un programma che non finisce: la tabella va divisa. Un file che il programma scrive e che esiste già nel workspace non viene sovrascritto se non era fra quelli passati: Owni lo dice nella risposta.

Owni fa i calcoli sulle date con `date_calc` (settimana 45, [ADR 0048](adr/0048-date-e-scadenze.md)), sempre attivo, senza rete né chiavi: che giorno cade una data, giorni e giorni lavorativi fra due date, date più giorni, mesi o giorni lavorativi, scadenze delle fatture, festività nazionali ed età. «Oggi» è la data di `OWNI_TIME_ZONE`. Se una persona dice che un conto è sbagliato, i casi sono questi: `between` («quanti giorni mancano») non conta il primo giorno, mentre `working_days` («giorni lavorativi dal… al») conta entrambi gli estremi, e la risposta di `between` dà anche l'altro conteggio quando è diverso; «f.m.» qui vuol dire contare i giorni dalla data fattura e poi andare a fine mese (31/01 + 30 gg f.m. = 31/03), mentre alcuni gestionali contano 30 giorni come un mese (28/02), e la risposta chiude con le date contate a mesi quando sono diverse; una scadenza di sabato, domenica o festivo non viene spostata, la risposta dice il primo giorno lavorativo dopo; il santo patrono conta solo se chi chiede lo dice (`patrono`, un giorno o il nome di uno dei capoluoghi della tabella in `italian-calendar.ts`; per gli altri comuni serve il giorno). I festivi sono quelli nazionali di oggi, con il 4 ottobre dal 2026 (legge 151/2025), e valgono dal 2001 al 2200: per gli anni prima festivi, giorni lavorativi e scadenze delle fatture sono rifiutati, mentre giorni della settimana, giorni di calendario ed età vanno fino al 1900.

Dal web (ADR 0027): `web_read` legge i PDF e i documenti dei siti consentiti, `web_download` li salva in `download/` nel workspace, fino a 20 MB; ogni salvataggio è una riga `web.download` nell'audit (percorso e byte). Se una persona dice che un link a un PDF «non si apre», controlla che il sito sia tra quelli consentiti (Impostazioni) e che il file non superi i 20 MB. «Riprova tra poco» su un documento vuol dire che i due lettori erano occupati o che troppi documenti grandi arrivavano insieme (oltre 100 MB in tutto il processo): se succede spesso, guarda quante ricerche approfondite girano.

## 6n. Lo schermo (Cua)

Ogni agente può avere un desktop Linux con Firefox, dove Owni guarda lo schermo, clicca e scrive attraverso Cua ([ADR 0045](adr/0045-schermo-cua.md)). Serve un server amd64 con Docker 20.10 o più recente. Come per il computer (6j), **il socket di Docker equivale a root sul server**: accendilo solo dove Owni è l'unico servizio, mai in Owni Cloud.

1. Scarica l'immagine, circa 8 GB: `docker pull trycua/cua-xfce:0.3.0`.
2. In `.env`: `OWNI_DESKTOP=docker`, e se serve il web dal browser dello schermo `OWNI_DESKTOP_NETWORK=internet`.
3. `pnpm owni check`, poi l'owner accende lo schermo agente per agente (Impostazioni, Schermo).

Come gira: un container `owni-desktop-<hash>` per agente, 3 GB di memoria, 2 CPU, 1 GB di `/dev/shm`, un init come primo processo, solo le capability `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `KILL`, niente escalation di privilegi, nessuna porta pubblicata. Token del demone e password VNC casuali per ogni container. Al massimo 4 schermi accesi: per un quinto agente si chiude quello usato meno di recente, e se tutti stanno lavorando il quinto riprova dopo un minuto. Uno schermo senza azioni per 15 minuti si ferma (quello che era aperto si perde). «Riavvia lo schermo» nella console cancella il container. All'avvio Owni ferma gli schermi rimasti accesi e cancella quelli già fermi.

**Rete.** Gli schermi stanno sulla rete Docker `owni-desktop` (interna, senza internet) o, con `OWNI_DESKTOP_NETWORK=internet`, su `owni-desktop-internet`. Lascia che sia Owni a crearla: la crea con il traffico fra container spento, così uno schermo non vede gli altri. Se trova una rete con quel nome che lo lascia passare, la usa e scrive un avviso nel log: gli schermi allora si vedono fra loro, protetti solo da token e password VNC diversi. Owni raggiunge ogni schermo all'indirizzo del suo container sulla rete, porta 3211:

- Owni installata direttamente sul server Linux: funziona così com'è.
- Owni in Docker Compose: usa la rete del server, così raggiunge gli schermi come un processo del server e la rete degli schermi resta chiusa. Nel servizio `owni` di `docker-compose.yml` metti `network_mode: host`, togli `ports:` e imposta `OWNI_WEB_HOST: 127.0.0.1` (non `0.0.0.0`: la console resta solo su questa macchina, dietro il proxy https). Non mettere il container di Owni sulla rete degli schermi: servirebbe il traffico fra container acceso.

**Quello che lo schermo raggiunge sul server.** Con o senza internet, il server è il gateway della rete degli schermi: dal browser dello schermo si arriva alla console e ai webhook di Owni e a ogni servizio del server in ascolto su tutte le interfacce (`0.0.0.0`). Owni lo ricorda nel log all'avvio. Tieni quei servizi su `127.0.0.1` o chiudili con il firewall del server verso le reti `owni-desktop*`; Owni non tocca il firewall. Con internet lo schermo raggiunge anche la rete locale, e il suo browser non segue i siti consentiti dell'agente.

**Uno schermo altrove**: `OWNI_DESKTOP=remote` con `OWNI_DESKTOP_URL` e `OWNI_DESKTOP_TOKEN` ([chiavi](chiavi.md) §19), per esempio un container di Cua su un'altra macchina dietro un proxy https. Tutti gli agenti che lo usano condividono lo stesso schermo; Owni non lo avvia e non lo riavvia.

## 7. Connettori MCP

Pagina Connettori (owner): un server MCP via HTTP (URL) o locale (comando). Un header o una variabile segreta viene salvata nel secret store del tenant e non è più visibile. Owni riapre l'istanza e mostra quanti tool ha trovato. Un connettore raggiunge solo il suo host, e solo finché è consentito nella egress policy (casella «Consenti»). I connettori locali sono processi sul server di Owni: solo comandi di cui ti fidi.

In un clic (settimana 29, ADR 0024): sotto i connettori c'è la galleria dei servizi noti. «Accedi e aggiungi» porta l'owner sulla pagina del servizio e lo riporta a `OWNI_PUBLIC_URL/oauth/mcp/callback`: senza un indirizzo https molti servizi rifiutano. I token stanno nel secret store (`mcp-oauth.<istanza>.<connettore>`, o `connector.<connettore>.<istanza>.authorization` per i token incollati) e si rinnovano da soli; quando il servizio rifiuta il rinnovo il connettore mostra «Da collegare» e basta premere «Collega». Un accesso in corso si perde a un riavvio. Audit: `connector.authorized`, `connector.sign_in_cancelled`, `connector.removed`.

Azioni con approvazione (settimana 30, ADR 0025; per rischio dall'ADR 0120): gli strumenti di sola lettura partono subito, quelli che il servizio dichiara interni e non distruttivi (`destructiveHint` e `openWorldHint` falsi) partono subito se il connettore non è alzato a «chiedi», tutti gli altri (senza annotazioni, distruttivi, aperti al mondo, e ogni scrittura di un collegamento API) aspettano un «Approva» in Approvazioni, sopra la chat web o sulla card di Telegram e WhatsApp. Le richieste stanno in `connector-actions/` dell'istanza, scadono in 24 ore e al massimo 20 restano in attesa. Una richiesta rimasta «in corso» per un riavvio diventa «esito incerto» all'avvio: controlla sul servizio prima di chiederla di nuovo. Per chiedere anche per le modifiche interne, Modifica → spunta «Chiedi l'approvazione anche per le modifiche ai dati dell'azienda» (i servizi di pagamento del catalogo nascono già così). I connettori che avevano l'approvazione spenta (`approval: "none"` sul disco) ora chiedono per quello che esce, distrugge o non è descritto: il valore è ignorato, non serve toccare il file. Audit: `connector_action.*`, mai argomenti o risposte. Ogni richiesta (moduli, Google, connettori) che scade senza decisione viene annunciata una volta alla conversazione che l'ha chiesta; se l'avviso non parte resta l'evento `*.expired` con `told: false` e il motivo.

## 8. Backup e ripristino

Tutto lo stato è nella cartella dati (`/data` nel container, `data/` senza Docker): istanze, conversazioni (SQLite), outbox, pratiche, file, task, persone, segreti, audit.

Backup coerente (pochi secondi di fermo):

```bash
docker compose stop owni
docker run --rm -v owni_owni-data:/data -v "$PWD":/backup busybox tar czf /backup/owni-$(date +%F).tgz -C /data .
docker compose start owni
```

Ripristino: ferma Owni, svuota il volume, estrai l'archivio nel volume, riavvia. Gli archivi contengono `secrets.json` in chiaro: conservali cifrati.

## 9. Aggiornare

```bash
git pull
docker compose up -d --build
```

Le risposte rimaste a metà ripartono dall'outbox; quelle che potrebbero arrivare due volte su Telegram sono segnalate come possibile doppione.

## 10. Ruotare i segreti

- **Chiave del modello, Gmail, HubSpot, token Telegram**: cambia `.env` e riavvia (i valori vengono riscritti nel secret store all'avvio).
- **Segreti dei connettori**: pagina Connettori → Modifica → nuovo valore.
- **Auth token di Twilio**: dopo averlo ruotato su Twilio, Impostazioni → Telefono → nuovo auth token → Salva. Fino ad allora le chiamate ricevono 403.
- **Link di una persona**: `pnpm owni person link <id>` o Persone → Nuovo link.
- **Link dell'owner perso**: `pnpm owni person list` per l'ID, poi `pnpm owni person link <id>`.

## 11. Problemi comuni

| Sintomo | Causa probabile |
|---|---|
| `Instance ... is already open in another process` | Due copie di Owni sulla stessa cartella dati. Fermane una. |
| Il bot non risponde | L'utente non è in `OWNI_TELEGRAM_ALLOWED_USERS`, o non ha premuto Start. Controlla l'audit (Attività). |
| La segreteria non legge la posta | Refresh token Gmail scaduto (`invalid_grant` nei log): rigenera il token. |
| `does not allow connector "hubspot"` all'avvio | La egress policy dell'istanza è stata ristretta: Owni non la allarga da sola. Correggi `instance.json` o usa un'altra istanza. |
| Le risposte web arrivano solo ricaricando | Il proxy bufferizza `/api/events`: disattiva il buffering. |
| La console dice «Non riesco a raggiungere Owni» | Il server non risponde (riavvio, cella che si sveglia): riprova da sola ogni 10 secondi. Se resta, guarda i log del server. |
| Owni ha smesso di usare il modello | Tetto di spesa giornaliero raggiunto (Attività e spesa). Riprende il giorno dopo. |
