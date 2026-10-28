# Chiavi e accessi: dove prenderli, dove metterli

Questa guida serve a dare a Owni quello che le manca per la prova dal vivo e per Owni Cloud. Le chiavi non si incollano mai in una chat, in un'issue o in un commit: vanno solo nei posti indicati qui.

## Dove si inseriscono

**Nella sessione cloud di Claude Code** (per far fare a Claude la prova dal vivo):

1. Apri la sessione su claude.ai/code e clicca il nome dell'ambiente cloud nella barra del titolo, poi **Edit**.
2. Ogni chiave va in **Network secrets** (nelle app non aggiornate si chiama **API credentials**). Se quella sezione non c'è, aggiungila come **variabile d'ambiente**. Il nome è quello indicato qui sotto, per esempio `ANTHROPIC_API_KEY`.
3. In **Network access** scegli il livello **Limited**. Sotto **Allowed domains** aggiungi i domini della tabella in fondo e lascia spuntato *Allow package managers*. Nelle app non aggiornate la voce si chiama **Custom**. Istruzioni ufficiali: https://code.claude.com/docs/en/cloud-environments#network-access
4. Apri una **nuova sessione**: le chiavi entrano solo nelle sessioni nuove.

**Su un server tuo** (self-host o control plane di Owni Cloud): nel file `.env` accanto al codice, con i nomi di [`.env.example`](../.env.example). Il file non va mai su git, perché è già escluso.

**In GitHub Actions** (solo per il giudice notturno): repository → Settings → Secrets and variables → Actions → New repository secret.

## Le chiavi, in ordine di priorità

### 1. Modello: `ANTHROPIC_API_KEY` o la chiave di un altro provider (indispensabile)

1. Vai su https://console.anthropic.com (può rimandarti alla nuova console della piattaforma) ed entra con l'account di Buildrs.
2. **Settings → API Keys → Create Key**, nome `owni-dev`.
3. Copia la chiave, che inizia con `sk-ant-`, e salvala come `ANTHROPIC_API_KEY`.
4. Consigliato: in **Settings → Limits** metti un tetto di spesa mensile, per esempio 50 dollari. Owni ha anche il suo tetto giornaliero.
5. Dominio da consentire: `api.anthropic.com`.

Al posto di Anthropic, o accanto, va bene uno qualsiasi dei 18 provider di [ADR 0032](adr/0032-qualsiasi-modello.md), che ha la tabella con il nome di ogni variabile e il dominio da consentire. `OWNI_MODEL_PROVIDER` dice quale usa la prima istanza; ogni chiave messa qui l'owner la può usare da Impostazioni → Modello AI, dove può anche incollare una chiave sua.

### 2. Telegram: `TELEGRAM_BOT_TOKEN` e gli ID delle persone

1. Su Telegram apri **@BotFather** → `/newbot` → scegli nome e username (deve finire in `bot`).
2. BotFather ti dà il token, nella forma `123456789:AA…`: va in `TELEGRAM_BOT_TOKEN`.
3. Il tuo ID numerico: scrivi a **@userinfobot**, che ti risponde con `Id: 123456789`.
4. `OWNI_TELEGRAM_ALLOWED_USERS` = gli ID di chi può scrivere a Owni, separati da virgola. `OWNI_TELEGRAM_APPROVERS` = chi approva gli strumenti proposti (di solito il tuo ID).
5. Apri il bot e premi **Start**: senza, Telegram non lascia scrivere il bot a te.
6. Dominio: `api.telegram.org`.

In alternativa il bot si collega anche dalla console: Impostazioni → Telegram.

### 3. Google per persona: `OWNI_GOOGLE_CLIENT_ID`, `OWNI_GOOGLE_CLIENT_SECRET`

Serve perché ognuno colleghi il proprio Gmail e Calendar dalla console: in lettura e, con `OWNI_GOOGLE_WRITE=1`, anche per far preparare a Owni mail ed eventi, che partono solo quando la persona li approva ([ADR 0021](adr/0021-google-scrivere-con-approvazione.md)).

1. Nello stesso progetto Google Cloud abilita anche **Google Calendar API**.
2. **Credentials → Create credentials → OAuth client ID**, tipo *Web application*. Redirect URI:
   - in locale: `http://localhost:8080/oauth/google/callback`;
   - su un server: `https://<tuo-dominio>/oauth/google/callback`;
   - in Owni Cloud: `https://<dominio-del-control-plane>/oauth/google/callback`.
3. Client ID e secret vanno in `OWNI_GOOGLE_CLIENT_ID` e `OWNI_GOOGLE_CLIENT_SECRET`. Facoltativi: `OWNI_GOOGLE_SERVICES` (`gmail,calendar`, oppure `calendar` da solo) e `OWNI_GOOGLE_WRITE=1` (scrivere, con approvazione). Con la scrittura, nella schermata di consenso aggiungi anche gli scope `gmail.compose` e `calendar.events`.
4. Pubblicazione dell'app (**OAuth consent screen → Publish app**):
   - `calendar.readonly` richiede una verifica di pochi giorni;
   - `gmail.readonly` richiede una valutazione di sicurezza annuale da un assessor approvato da Google. Va chiesto un preventivo.
   - con `OWNI_GOOGLE_WRITE=1`: `calendar.events` sta nella stessa verifica di `calendar.readonly`, `gmail.compose` nella stessa valutazione di `gmail.readonly`.
5. Domini: `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com`.

### 5. Owni Cloud su Railway: `RAILWAY_API_TOKEN`

1. https://railway.com → **Account Settings → Tokens** → crea un token di account (o di workspace) e salvalo come `RAILWAY_API_TOKEN`.
2. Rendi pubblica l'immagine di Owni, che la CI pubblica su GHCR (privata di default):
   - vai su https://github.com/mariomile?tab=packages → `owni` → **Package settings**;
   - **Change visibility → Public**.
   
   In alternativa, dai a Railway le credenziali del registry.
3. Sul control plane: `OWNI_CLOUD_PROVIDER=railway`, `OWNI_CLOUD_RAILWAY_IMAGE=ghcr.io/mariomile/owni:latest`.
4. Dominio: `backboard.railway.com` (e `docs.railway.com`, utile per verificare le API).

### 6. Email dei link di accesso: `OWNI_CLOUD_SMTP_URL`

1. Scegli un servizio con server in UE: Brevo, Mailjet o un altro SMTP europeo. Verifica il dominio mittente (record SPF e DKIM che ti indica il servizio).
2. Prendi le credenziali SMTP e componi `OWNI_CLOUD_SMTP_URL=smtps://UTENTE:PASSWORD@HOST:465`. Usa `smtp://…:587` se il servizio offre solo STARTTLS. I caratteri speciali della password vanno scritti in forma URL: `@` diventa `%40`.
3. `OWNI_CLOUD_MAIL_FROM=Owni <accesso@tuodominio.it>`.

### 7. Giudice notturno (facoltativo): `OWNI_JUDGE_MODEL_KEY`

Una chiave Anthropic separata, magari con un suo tetto di spesa. Va come secret di GitHub Actions (vedi sopra), non nella sessione.

### 8. Abbonamenti: `OWNI_CLOUD_STRIPE_SECRET_KEY` e i prezzi

Servono solo quando decidi il prezzo di Owni Cloud. Senza, il servizio resta gratuito.

1. https://dashboard.stripe.com → crea l'account di Buildrs e lascia attiva la **modalità test** per le prove.
2. **Developers → API keys → Secret key** (`sk_test_…`, poi `sk_live_…`): va in `OWNI_CLOUD_STRIPE_SECRET_KEY`. Meglio ancora una **restricted key** con scrittura su Checkout Sessions, Customer portal e Billing meter events, e lettura sulle Subscriptions.
3. **Product catalog → Add product** «Owni», con un prezzo mensile ricorrente. Il suo id (`price_…`) va in `OWNI_CLOUD_STRIPE_PRICE`.
4. Facoltativo, il consumo del modello: **Billing → Meters → Create meter** con aggregazione *Sum*. Il nome dell'evento, per esempio `owni_model_cost`, va in `OWNI_CLOUD_STRIPE_METER_EVENT`. Poi aggiungi al prodotto un prezzo a consumo collegato a quel contatore e metti il suo id in `OWNI_CLOUD_STRIPE_USAGE_PRICE`. Un'unità è un centesimo di dollaro di costo del modello.
5. **Developers → Webhooks → Add endpoint**: `https://<dominio-del-control-plane>/stripe/webhook`, con gli eventi `checkout.session.completed` e `customer.subscription.created`, `.updated`, `.deleted`. Il **Signing secret** (`whsec_…`) va in `OWNI_CLOUD_STRIPE_WEBHOOK_SECRET`.
6. **Settings → Billing → Customer portal**: attivalo, così ognuno vede le fatture, cambia carta e disdice da solo.
7. Facoltativo: `OWNI_CLOUD_TRIAL_DAYS`, i giorni di prova (14 se non lo metti).
8. Dominio: `api.stripe.com`.

### 9. WhatsApp: token, ID del numero e app secret (per istanza, dalla console)

Owni risponde su un numero WhatsApp Business attraverso la Cloud API di Meta. I tre valori si inseriscono nella console, in Impostazioni → WhatsApp, non nel file `.env`. Serve un indirizzo https pubblico, perché Meta manda i messaggi a un webhook: in Owni Cloud c'è già, in self-host è `OWNI_PUBLIC_URL`.

1. https://developers.facebook.com → **My Apps → Create app**, tipo *Business*, e aggiungi il prodotto **WhatsApp**. Collega o crea il **Business portfolio** di Buildrs.
2. In **WhatsApp → API Setup** aggiungi il numero di telefono (un numero non già usato sull'app WhatsApp) e verificalo. Copia il **Phone number ID**: è il campo «ID del numero».
3. Token permanente: in https://business.facebook.com → **Impostazioni → Utenti di sistema** crea un utente di sistema *Admin*. Assegnagli l'app e il WhatsApp Business Account, poi **Genera token** con i permessi `whatsapp_business_messaging` e `whatsapp_business_management`. È il campo «Token di accesso». Il token temporaneo di API Setup dura 24 ore: va bene solo per una prova.
4. **App settings → Basic → App secret** → *Show*: è il campo «App secret».
5. Nella console premi **Collega**. Owni mostra l'indirizzo del webhook e un token di verifica.
6. Di nuovo su developers.facebook.com, in **WhatsApp → Configuration → Webhook → Edit**, incolla indirizzo e token di verifica, poi **Verify and save**. Sotto *Webhook fields* iscriviti a **messages**.
7. In «Chi può scrivere» metti i numeri delle persone con il prefisso, solo cifre (per esempio `393331234567`).
   Se i messaggi non arrivano con un numero vero (non quello di test), l'app va iscritta anche al WhatsApp Business Account: da Graph API Explorer, con il token dell'utente di sistema, `POST /<WABA_ID>/subscribed_apps`.
8. Facoltativo, per i messaggi oltre le 24 ore: in **WhatsApp Manager → Modelli di messaggio → Crea modello**, categoria *Utilità*, lingua italiano. Nel corpo metti una variabile e poco altro testo (meno di 400 caratteri: l'estratto può arrivare a 600 e Meta non accetta corpi oltre 1024), per esempio «Ciao, ho un aggiornamento per te: {{1}}. Rispondi a questo messaggio per leggerlo tutto.» Meta chiede un valore di esempio per {{1}}: metti una frase tipo «domani scade l'F24». Può riclassificare il template come *Marketing*, che ha limiti di frequenza. Quando Meta lo approva, scrivi nome e lingua (`it`) nella scheda WhatsApp della console.
9. Per uscire dalla modalità sviluppo l'app va pubblicata (**App Review** per `whatsapp_business_messaging`) e serve un metodo di pagamento sul Business Account: Meta fa pagare i template secondo il suo listino (le risposte entro le 24 ore sono gratuite, da verificare sul listino aggiornato).
10. Domini: `graph.facebook.com` (e `lookaside.fbsbx.com` per scaricare i file che le persone mandano).

### 10. Messaggi vocali: `OWNI_TRANSCRIBE_URL` e `OWNI_TRANSCRIBE_API_KEY`

Senza queste variabili Owni riceve i vocali ma non li capisce, e chiede di scrivere. Consiglio Mistral, che ha i server in Unione Europea.

1. https://console.mistral.ai → entra con l'account di Buildrs → **Billing**: aggiungi un metodo di pagamento. La trascrizione costa pochi millesimi di dollaro al minuto: controlla il listino aggiornato su https://mistral.ai/pricing.
2. **API Keys → Create new key**, nome `owni-voce`. La chiave va in `OWNI_TRANSCRIBE_API_KEY`.
3. `OWNI_TRANSCRIBE_URL=https://api.mistral.ai/v1`. Il modello è `voxtral-mini-latest` se non indichi altro in `OWNI_TRANSCRIBE_MODEL`.
4. Facoltativo: `OWNI_TRANSCRIBE_MAX_SECONDS`, la durata massima di un vocale letto come messaggio (300 secondi se non lo metti); i più lunghi diventano registrazioni da trascrivere con `audio_transcribe`. Per le registrazioni: `OWNI_TRANSCRIBE_MAX_MINUTES` (180) e `OWNI_TRANSCRIBE_MINUTES_PER_DAY` (600 al giorno per account); con Mistral i tempi delle frasi e le voci sono già attivi (`OWNI_TRANSCRIBE_TIMESTAMPS`, `OWNI_TRANSCRIBE_SPEAKERS`, [ADR 0033](adr/0033-registrazioni-lunghe.md)).
5. In Owni Cloud basta metterle sul control plane: passano a tutte le celle.
6. Poi, in ogni istanza che deve capire i vocali: Impostazioni → **Messaggi vocali** → spunta «Trascrivi i vocali di questa istanza».
7. Dominio: `api.mistral.ai`.

In alternativa va bene qualunque servizio con la stessa API di OpenAI: per OpenAI `OWNI_TRANSCRIBE_URL=https://api.openai.com/v1` (modello `whisper-1`, con i tempi delle frasi ma senza le voci).

### 11. Telefono: Account SID, auth token e numero Twilio (per istanza, dalla console)

Owni risponde alle chiamate su un numero Twilio, a voce, un turno alla volta ([ADR 0012](adr/0012-chiamate-vocali-con-numero-twilio.md)). I tre valori si inseriscono nella console, in Impostazioni → Telefono, non nel file `.env`. Serve un indirizzo https pubblico, perché Twilio chiama un webhook della cella.

1. https://console.twilio.com → crea l'account (o entra con quello di Buildrs) e aggiungi un metodo di pagamento: con l'account di prova Twilio legge un avviso all'inizio di ogni chiamata e accetta solo i numeri verificati.
2. **Phone Numbers → Manage → Buy a number**: un numero italiano con la capacità *Voice*. Per i numeri italiani Twilio chiede un *Regulatory Bundle* (documento e indirizzo di Buildrs): va approvato prima dell'acquisto. Il costo del numero e dei minuti è sul listino di Twilio, da verificare.
3. Dalla home della console copia **Account SID** (`AC…`) e **Auth Token** (32 caratteri, *Show*).
4. Facoltativo, per i dati in Unione Europea: Twilio offre la regione Irlanda. Si sceglie nella console (**Regions**), e allora `OWNI_TWILIO_API=https://api.dublin.ie1.twilio.com` con le credenziali di quella regione.
5. Nella console di Owni scrivi Account SID, auth token, il numero con il prefisso (`+390612345678`) e un codice da 4 a 8 cifre, e in «Chi può chiamare» i numeri delle persone con il `+`. Premi **Collega**: Owni controlla le credenziali e imposta da sola l'indirizzo delle chiamate del numero. Non serve incollare niente su Twilio. Il codice va dato solo alle persone in elenco: lo digitano all'inizio di ogni chiamata.
6. Facoltativo: `OWNI_PHONE_VOICE`, la voce di Twilio (`Polly.Bianca` se non lo metti). Si prova con una chiamata vera.
7. Domini: `api.twilio.com` (o quello della regione scelta).

### 12. Il computer delle istanze: nessuna chiave con Docker, `FLY_API_TOKEN` con Fly

Con Docker il terminale di Owni ([ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md)) non usa chiavi né domini: gira in un container sul server di Owni, collegato a internet ma senza segreti ([ADR 0124](adr/0124-il-computer-dell-agente-ha-la-rete.md)), con `OWNI_COMPUTER=docker` in `.env` ([runbook](runbook.md), 6j).

Su micro-VM Fly.io ([ADR 0015](adr/0015-computer-su-micro-vm.md)), ed è l'unico modo in Owni Cloud, serve un token dell'organizzazione Fly:

1. https://fly.io → crea l'account di Buildrs e un'organizzazione (lo *slug*, per esempio `buildrs`, è `OWNI_FLY_ORG`), con un metodo di pagamento: le macchine si pagano al secondo da accese, i volumi al gigabyte al mese (listino di Fly, da verificare).
2. Con la CLI `fly` installata e l'accesso fatto: `fly tokens create org -o <slug> -x 8760h` (un anno). Il token inizia con `FlyV1 `: va copiato intero, spazio compreso.
3. Mettilo **solo** nel `.env` del control plane come `FLY_API_TOKEN` (in Owni Cloud) o nel `.env` del server (installazione propria). Mai nelle celle: il control plane non lo passa, e chi ha il token raggiunge tutte le macchine dell'organizzazione.
4. Per ruotarlo: crea il nuovo, sostituiscilo, riavvia, poi revoca il vecchio con `fly tokens revoke`.
5. Domini: `api.machines.dev` (l'API delle macchine) e, per Fly, il registry da cui scarica l'immagine (`ghcr.io` se usi quella pubblicata dal workflow `Image`).

Per la prova dal vivo: `FLY_API_TOKEN` e `OWNI_TEST_FLY_ORG` nell'ambiente della sessione (mai in chat), poi il comando di [week20.md](week20.md).

### 13. Ricerca sul web: `OWNI_SEARCH_API_KEY`

Senza questa chiave Owni legge le pagine che le indichi ma non può cercare. Il servizio è Brave Search, con un indice suo (non rivende Google o Bing).

1. https://api-dashboard.search.brave.com → crea un account con l'email di Buildrs → scegli un piano della **Search API** (prezzi e limiti aggiornati sulla stessa pagina: controllali prima di scegliere) e aggiungi un metodo di pagamento.
2. **API Keys → Add API key**, nome `owni`. La chiave va in `OWNI_SEARCH_API_KEY`.
3. In Owni Cloud basta metterla sul control plane: passa a tutte le celle.
4. `pnpm owni check` prova una ricerca e dice se la chiave funziona.
5. Poi, in ogni istanza che deve cercare: Impostazioni → **Ricerca sul web** → spunta «Consenti la ricerca a questa istanza». Dalla stessa scheda puoi farle aprire tutti i siti pubblici; altrimenti apre solo quelli elencati in Navigazione web.
6. Dominio: `api.search.brave.com`.

Facoltativi: `OWNI_SEARCH_COUNTRY` e `OWNI_SEARCH_LANG` (risultati dall'Italia e in italiano se non li metti; Owni può chiedere un altro paese per una ricerca), `OWNI_SEARCH_MAX_PER_DAY` (200 ricerche al giorno per account se non lo metti). `OWNI_SEARCH_URL` serve solo per un servizio con la stessa API di Brave a un altro indirizzo.

### 14. Risposte a voce: `OWNI_SPEECH_URL` e `OWNI_SPEECH_API_KEY`

Senza queste variabili Owni risponde sempre per iscritto. Con queste, a chi le manda un vocale su Telegram o WhatsApp risponde con un vocale e con il testo, e chi vuole può chiederle «rispondimi sempre a voce» o «niente vocali» ([ADR 0020](adr/0020-risposte-a-voce.md)). Al servizio va solo il testo delle risposte da leggere, fuori dall'Unione Europea nel caso di OpenAI.

1. https://platform.openai.com → entra con l'account di Buildrs → **Billing**: aggiungi un metodo di pagamento. Il prezzo si paga a caratteri o a minuti di audio: controlla il listino aggiornato su https://openai.com/api/pricing prima di accendere.
2. **API keys → Create new secret key**, nome `owni-voce`, con permesso solo sul modello audio se la console lo consente. La chiave va in `OWNI_SPEECH_API_KEY`.
3. `OWNI_SPEECH_URL=https://api.openai.com/v1`. Modello `gpt-4o-mini-tts` e voce `nova` se non indichi altro in `OWNI_SPEECH_MODEL` e `OWNI_SPEECH_VOICE`. La voce è una per tutto il server; quelle di OpenAI (per esempio `alloy`, `coral`, `nova`, `sage`, `shimmer`) sono elencate e si ascoltano su https://platform.openai.com/docs/guides/text-to-speech.
4. Facoltativi: `OWNI_SPEECH_MAX_CHARS`, quanto di una risposta viene letto (1500 caratteri se non lo metti; di una più lunga si leggono le prime frasi e il resto resta scritto); `OWNI_SPEECH_MAX_PER_DAY`, i vocali al giorno per tutto il server (300 se non lo metti; poi le risposte vanno solo per iscritto fino al giorno dopo); `OWNI_SPEECH_STYLE`, come parlare, per i modelli che lo accettano (per esempio «Parla in italiano, tono cordiale e naturale»).
5. In Owni Cloud basta metterle sul control plane: passano a tutte le celle.
6. `pnpm owni check` controlla la chiave senza produrre audio.
7. Poi, in ogni istanza che deve rispondere a voce: Impostazioni → **Risposte a voce** → spunta «Rispondi a voce ai vocali». Perché Owni capisca i vocali serve anche il punto 10.
8. Dominio: `api.openai.com`.

Va bene qualunque servizio con la stessa API di OpenAI (`POST /audio/speech` che risponde in OGG Opus); per un altro servizio indica anche il modello e la voce.

### 15. Immagini: `OWNI_IMAGE_URL` e `OWNI_IMAGE_API_KEY`

Senza queste variabili Owni non crea immagini. Con queste, quando glielo chiedono crea illustrazioni, loghi e volantini e ritocca le foto che le mandano ([ADR 0023](adr/0023-immagini-su-richiesta.md)). Al servizio vanno la descrizione e, per un ritocco, la foto, fuori dall'Unione Europea nel caso di OpenAI.

1. https://platform.openai.com → entra con l'account di Buildrs → **Billing**: un metodo di pagamento. Si paga a immagine, secondo qualità e misura: controlla il listino aggiornato su https://openai.com/api/pricing prima di accendere. Per `gpt-image-1` OpenAI può chiedere di verificare l'organizzazione (**Settings → Organization → Verify**).
2. **API keys → Create new secret key**, nome `owni-immagini`. Può essere la stessa delle risposte a voce, ma una chiave separata si revoca da sola. La chiave va in `OWNI_IMAGE_API_KEY`.
3. `OWNI_IMAGE_URL=https://api.openai.com/v1`. Modello `gpt-image-1` se non indichi altro in `OWNI_IMAGE_MODEL`; con `dall-e-3` Owni crea immagini ma non ritocca foto e non fa sfondi trasparenti.
4. Facoltativo: `OWNI_IMAGE_MAX_PER_DAY`, le immagini al giorno per ogni account (100 se non lo metti). Contano solo le immagini fatte: un rifiuto del servizio non le consuma.
5. In Owni Cloud basta metterle sul control plane: passano a tutte le celle.
6. Poi, in ogni istanza: Impostazioni → **Immagini** → spunta «Consenti le immagini a questa istanza».
7. Dominio: `api.openai.com`.

Va bene qualunque servizio con la stessa API di OpenAI (`POST /images/generations` e `/images/edits`, immagini in `b64_json`); per un altro servizio indica anche il modello.

### 19. Lo schermo: nessuna chiave, viene con il computer

Lo schermo è Chromium su un display virtuale dentro il computer dell'agente, la stessa macchina dei comandi ([ADR 0135](adr/0135-schermo-nel-computer-dell-agente.md)). **Non ha chiavi, impostazioni né immagini da scaricare a parte**: si accende da solo dove c'è un computer.

1. Serve il computer (§12): `OWNI_COMPUTER=docker` o `fly`, oppure Owni Cloud, che lo ha già. L'immagine del computer porta Chromium e cresce di circa 400 MB; la memoria di default passa a 2048 MB.
2. `pnpm owni check` e la console (Impostazioni, Schermo) dicono se lo schermo è pronto, come per il computer.
3. Poi, in ogni agente che deve usarlo: Impostazioni → **Schermo** → spunta «Consenti lo schermo a questo agente».
4. Domini: nessuno in più rispetto al computer (§12). Le regole di rete del computer valgono anche per il browser: internet pubblico sì, indirizzi privati no. Il browser non segue l'elenco dei siti consentiti dell'agente, e quello che Owni fa sullo schermo non chiede approvazione.
5. Le vecchie impostazioni di Cua (`OWNI_DESKTOP=docker` o `remote`, `OWNI_DESKTOP_NETWORK`, `OWNI_DESKTOP_URL`, `OWNI_DESKTOP_TOKEN`) non esistono più: Owni non parte finché ci sono, e il messaggio dice di toglierle. `OWNI_DESKTOP=local` (Computer Use sul Mac, [desktop](desktop.md)) è un'altra cosa e resta.

### 20. Partita IVA: `OWNI_VAT_CHECK=1`

Anche senza questa variabile Owni controlla «sulla carta» partite IVA, numeri IVA europei e codici fiscali (tool `vat_check`): la cifra di controllo, la matricola (non tutta a zero) e il codice dell'ufficio IVA di una partita IVA italiana, la forma del numero per ogni paese del VIES, e di un codice fiscale la forma, le lettere di omocodia, il mese, il giorno e il carattere di controllo. Un numero scritto male ha così una risposta precisa senza chiedere niente a nessuno. Un numero di 11 cifre che comincia con 8 o 9 ed è scritto giusto è il codice fiscale numerico di un ente senza partita IVA (associazione, ente non commerciale, ente pubblico): Owni lo dice e non lo cerca nel VIES, dove non c'è. Con `OWNI_VAT_CHECK=1` risponde anche a «la partita IVA 00000500157 è attiva?», «di chi è la P.IVA IT…?» o «controlla questa partita IVA tedesca»: chiede al VIES della Commissione europea se il numero è attivo per le operazioni intracomunitarie e dà nome e indirizzo registrati, quando lo Stato membro li comunica (la Germania no), con data e ora del controllo, utili come riscontro per una fattura intra-UE.

«Non attiva nel VIES» non vuol dire inesistente: molte partite IVA italiane valide non sono abilitate alle operazioni intracomunitarie, e Owni lo dice. Un codice fiscale non si può verificare all'Agenzia delle Entrate da qui: Owni dice solo se sembra scritto giusto.

1. **Non serve una chiave.** Al VIES vanno solo il paese e il numero chiesto, nient'altro di chi scrive. Si accende con `OWNI_VAT_CHECK=1`, come ogni servizio esterno.
2. Facoltativo: `OWNI_VAT_CHECK_MAX_PER_DAY`, le richieste al VIES al giorno per ogni account: 200 se non lo metti. Le risposte restano in memoria un'ora per account e numero (un errore del VIES due minuti) e quelle non contano; un account non vede mai quando un altro ha controllato lo stesso numero. Il VIES limita le richieste: meglio non alzarlo troppo.
3. Facoltativo: `OWNI_VAT_CHECK_MAX_PER_DAY_SERVER`, le richieste al VIES al giorno per tutto il server, tutti gli account insieme: 2000 se non lo metti. Il VIES blocca un indirizzo che chiede troppo, e l'indirizzo è quello del server.
4. Facoltativo, solo per i test o per un mirror con la stessa API: `OWNI_VAT_CHECK_URL` (di default `https://ec.europa.eu/taxation_customs/vies/rest-api`).
5. In Owni Cloud basta metterle sul control plane: passano a tutte le celle (il tetto del server vale per ogni cella).
6. `pnpm owni check` chiede al VIES la partita IVA di ENI (IT00905811006): se risulta attiva va tutto bene; se risulta non attiva, o se il servizio italiano non risponde in quel momento, è un avviso; se il VIES non risponde o risponde in un modo che Owni non sa leggere è un errore. L'indirizzo dell'API va verificato così alla prima sessione con la rete.
7. Dominio: `ec.europa.eu`.

## Domini da consentire nella sessione cloud

| Servizio | Domini |
|---|---|
| Modello | `api.anthropic.com`, o il dominio del provider scelto (tabella in [ADR 0032](adr/0032-qualsiasi-modello.md)) |
| Telegram | `api.telegram.org` |
| Google per persona | `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com` |
| Railway | `backboard.railway.com`, `docs.railway.com` |
| Stripe | `api.stripe.com` |
| WhatsApp | `graph.facebook.com`, `lookaside.fbsbx.com` |
| Vocali | `api.mistral.ai` (o il servizio scelto) |
| Ricerca sul web | `api.search.brave.com` |
| Partita IVA | `ec.europa.eu` |
| Risposte a voce | `api.openai.com` (o il servizio scelto) |
| Immagini | `api.openai.com` (o il servizio scelto) |
| Telefono | `api.twilio.com` (o la regione scelta) |
| Schermo | nessuno in più: come il computer (§12) |
| Connettori in un clic | `mcp.notion.com`, `mcp.linear.app`, `mcp.monday.com`, `mcp.atlassian.com`, `mcp.stripe.com`, `api.githubcopilot.com`, `mcp.sentry.dev`, `mcp.supabase.com`, `mcp.context7.com`, `huggingface.co` (e i loro server di autorizzazione) |

## Cosa succede dopo

In una sessione nuova con le chiavi, il primo comando è `pnpm owni check`. Prova ogni servizio configurato e dice cosa correggere, senza stampare segreti. Poi vengono la prova dal vivo di Telegram, e di Google, e lo spike Railway con le misure di risveglio e di costo.
