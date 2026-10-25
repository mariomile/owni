# Settimana 9: Owni Cloud su Railway

Branch `week-9`. Mario ha chiesto se Railway va bene per le celle. Questa settimana porta un provider Railway pronto da provare, e l'immagine di Owni costruita e pubblicata dalla CI.

## Cosa c'è

- **Provider Railway** (`src/cloud/railway-provider.ts`, `test/railway-provider.test.ts` con un Railway finto). Per ogni tenant un progetto Railway (rete privata e volume suoi), un servizio dall'immagine di Owni, un volume su `/data`, le variabili della cella senza far partire deploy a metà, la regione EU West (Amsterdam), la modalità serverless e un dominio `*.up.railway.app`. Il primo avvio fa il deploy; i risvegli successivi sono una richiesta che aspetta i 502 dell'avvio a freddo. «Spento» per il control plane vuol dire che smette di parlarle e lascia che Railway la metta a dormire. Una creazione fallita a metà cancella il progetto; gli errori nominano l'operazione, mai il token. `pnpm cloud upgrade` aggiorna variabili e rifà il deploy, tenendo il volume.
- **Control plane anche verso https**: il proxy verso una cella usa https se il suo indirizzo lo è, e manda come `Host` l'indirizzo della cella (Railway smista per quello), con quello pubblico in `X-Forwarded-Host`.
- **Immagine dalla CI** (`.github/workflows/image.yml`): a ogni PR costruisce il `Dockerfile` e controlla che il container, in sola lettura e senza capability, risponda su `/healthz`; su `main` la pubblica su `ghcr.io/<owner>/owni` (`latest` e lo SHA). È anche la verifica del `Dockerfile` vero che qui non si poteva fare.

## Da dove vengono le API

La documentazione di Railway non si raggiunge da questa sessione. Le mutation GraphQL vengono dagli esempi citati nei forum di Railway ([serviceCreate](https://station.railway.com/questions/help-problem-processing-request-when-ecb49af7), [volumeCreate](https://station.railway.com/questions/can-t-use-api-aa55fc35), [deploy da CI](https://station.railway.com/questions/deploy-docker-tag-from-ci-cf2cd5dc)), dalla [guida ufficiale sui segreti](https://docs.railway.com/guides/external-secrets-manager) (`variableCollectionUpsert` con `skipDeploys`) e dal codice di un server MCP open source che le usa ([jason-tan-swe/railway-mcp](https://github.com/jason-tan-swe/railway-mcp), ramo `main` di ottobre 2026): `projectCreate`, `serviceCreate` con `source.image`, `volumeCreate` con `mountPath`, `variableCollectionUpsert` con `skipDeploys`, `serviceInstanceUpdate` con `sleepApplication` e `region`, `serviceDomainCreate`, `serviceInstanceDeployV2`, `projectDelete`. Sono tutte in un solo punto del file (`GQL`): la prima prova dal vivo le conferma o le corregge.

## Review indipendente

Due revisori separati. Corretti:

- **Alta.** Un rifiuto di Railway sul salvataggio delle variabili poteva ripetere un segreto della cella (chiave del modello, segreto di cella) nell'errore, e da lì nei log del control plane: ora quell'errore non porta dettagli. Il control plane considerava una cella sveglia per 15 minuti, Railway la mette a dormire dopo 5-10: il suo controllo la risvegliava, e una richiesta in quella finestra prendeva il 502 dell'avvio a freddo. Ora il control plane la lascia andare dopo 4 minuti, e dopo un proprio riavvio considera ogni cella spenta.
- **Media.** Il volume poteva nascere prima che la regione UE fosse impostata (ora la regione va prima). `upgrade` non cambiava l'immagine (ora la imposta). Un risveglio in corso poteva rimettere in elenco una cella appena cancellata. Il workflow dava il permesso di scrivere pacchetti anche al build delle PR (ora solo al job che pubblica, su `main`), e su `main` poteva interrompere una pubblicazione a metà. L'attesa di un avvio a freddo superava il timeout tipico di un reverse proxy (ora 90 secondi). Un progetto lasciato indietro da una creazione fallita non veniva segnalato.
- **Lasciati, con motivo.** Le celle su Railway hanno un dominio pubblico: `/internal/` lì è protetto solo dal segreto di cella (256 bit, confronto a tempo costante), che conosce solo l'operatore; `owner-link` resta nell'audit della cella e non basta con la verifica in due passaggi. Scritto nell'ADR 0008. `X-Forwarded-Host` non lo legge nessuno: resta come informazione per i log di una cella. Il proxy non ha un timeout verso la cella perché lo stream degli eventi è una richiesta lunga per natura.

## Da misurare con il token (spike)

| Domanda | Come |
|---|---|
| Le mutation sono giuste | `pnpm cloud` con `OWNI_CLOUD_PROVIDER=railway`, una registrazione |
| Tempo di risveglio da sonno | prima risposta dopo 15 minuti di silenzio |
| Costo di una cella che dorme | fattura dopo qualche giorno: il volume si paga anche da spenta? |
| Limiti di progetti per workspace | quanti tenant regge un account |
| Il control plane tiene sveglie le celle | non deve chiamarle quando sono «spente» (lo fa già) |

## Limiti

| Cosa | Limite |
|---|---|
| Verifica | solo contro un Railway finto: nessuna chiamata vera senza token |
| Immagine | se il pacchetto GHCR resta privato, Railway ha bisogno delle credenziali del registry |
| Esposizione | ogni cella ha un dominio pubblico: si difende come un self-host, ma è raggiungibile anche senza passare dal control plane, e chi la chiama la sveglia (costo) |
| Primo deploy | `serviceCreate` con un'immagine potrebbe fare subito un deploy senza configurazione: fallisce, e il primo avvio rifà il deploy con tutto |
| Isolamento | quello dei container della piattaforma; per la Fase 3 servono micro-VM |
