# Settimana 29: connettori in un clic

Branch `week-29`. Decisione: [ADR 0024](adr/0024-connettori-in-un-clic.md). Nella pagina Connettori c'è una galleria di servizi noti (Notion, Linear, monday.com, Jira e Confluence, Stripe, GitHub, Sentry, Supabase, Context7, Hugging Face). L'owner preme «Accedi e aggiungi», entra con il suo account sulla pagina del servizio e torna nella console: Owni ha i nuovi strumenti. Per GitHub incolla un token; i servizi pubblici si collegano subito. Nessuna chiave da mettere sul server.

## Cosa funziona (verificato dai test)

- **Accesso con l'account** (`test/one-click-connectors.test.ts`, server MCP finto con OAuth): scoperta del server di autorizzazione, registrazione automatica di Owni, PKCE, ritorno su `/oauth/mcp/callback` che passa alla console solo codice e stato, scambio del codice, strumenti subito disponibili. Lo stesso codice non vale due volte; lo finisce solo chi l'ha iniziato. Annullare sulla pagina del servizio chiude l'accesso e riporta all'istanza giusta.
- **Rinnovo**: un token scaduto si rinnova da solo; se il rinnovo è rifiutato, il connettore mostra «Da collegare» e il modello sa dire alla persona che va ricollegato. Un nuovo «Collega» sostituisce quello lasciato a metà; un codice rifiutato non cancella l'accesso che funziona.
- **Niente avanzi**: un servizio che non accetta la registrazione automatica è spiegato e non lascia connettore, permesso o segreto. Cambiare l'indirizzo di un connettore cancella i suoi token; rimuoverlo cancella accesso e token.
- **Token**: tenuto per istanza come `Authorization: Bearer`, cambiabile con «Cambia token»; un token rifiutato è detto in italiano.
- **Rete**: le richieste dell'accesso e dei rinnovi vanno solo in https a indirizzi pubblici, controllati quando la connessione si apre, senza seguire redirect.
- **Console** (Chromium, desktop e telefono, nessun errore): galleria per gruppi, accesso e ritorno, token, «Da collegare» con «Collega», passo «Collega i tuoi strumenti» in Primi passi.

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Alta.** I rinnovi dei token passavano dal fetch del connettore, che controlla il nome dell'host ma non l'indirizzo: un server di autorizzazione che punta a un indirizzo interno avrebbe ricevuto il refresh token. Senza `OWNI_PUBLIC_URL` il servizio rimandava a `localhost` mentre la console era su `127.0.0.1`: cookie perso, accesso perso.
- **Media.** Controllo degli indirizzi solo prima della connessione (DNS rebinding) e senza tempo massimo; scritture del segreto senza ordine tra rinnovo e nuovo accesso; schema della pagina di accesso non controllato; token di un connettore del catalogo condiviso tra istanze; due accessi con lo stesso verificatore PKCE e token buoni cancellati da un codice rifiutato; errori del server di autorizzazione nell'audit; connettore salvato a metà quando l'accesso falliva; token rimasto dopo la rimozione; Asana e Vercel in catalogo ma senza registrazione automatica; un token sbagliato con un errore tecnico in inglese e nessun modo semplice di cambiarlo; centinaia di strumenti di un solo servizio al modello; il modello che non sa perché un servizio manca.
- **Bassa.** Accesso non legato a chi l'ha iniziato; header segreti mandati anche al server di autorizzazione; token di un indirizzo vecchio mandati al nuovo; accesso partito per un connettore spento; «Bearer …» incollato rifiutato; client registrato per un altro indirizzo di ritorno; codice inutilizzato; testi («firmi», «secret store», «tool» e «strumenti» insieme); avvisi di errore che sparivano troppo presto; galleria senza gruppi; niente passo in Primi passi; audit senza rimozioni e annullamenti.

Lasciati e scritti nell'ADR: le azioni di scrittura dei servizi senza approvazione, l'accesso in corso perso a un riavvio, i token opzionali per i servizi pubblici.

## Limiti

| Cosa | Limite |
|---|---|
| Strumenti per connettore | 64 (gli altri non arrivano al modello) |
| Accesso in corso | 10 minuti, in memoria |
| Risposta del server di autorizzazione | 512 KB, 15 secondi |
| Token incollato | 8-4.096 caratteri, senza spazi |
