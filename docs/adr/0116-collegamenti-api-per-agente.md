# Collegamenti API per agente

Un agente oggi raggiunge un servizio esterno in tre modi: i connettori integrati (Google, HubSpot), un server MCP (ADR 0003, 0024) o un tool proposto (ADR 0002). Molti servizi che un'azienda usa davvero (il gestionale, Fatture in Cloud, un CRM di nicchia, l'API interna) non hanno un server MCP. Un tool proposto non basta: raggiunge solo gli host dichiarati e non ha accesso ai segreti, quindi non può chiamare un'API con una chiave.

## Decisione

Un nuovo tipo di connettore, il **collegamento API**, nella sezione Servizi della configurazione di ogni agente, accanto ai server MCP.

- **Cosa configura l'owner**: nome, indirizzo base (`https://api.example.com/v1`), come si entra e la chiave, e una nota su cosa sa fare l'API (gli indirizzi principali, fino a 2.000 caratteri). La nota va al modello nella descrizione dei tool, così sa quali indirizzi chiamare.
- **Come si entra**: token (header `Authorization: Bearer …`), chiave in un header con il nome che dice il servizio (`X-API-Key`), chiave come parametro nell'indirizzo (`?api_key=…`), oppure nessuna.
- **Due tool per collegamento**: `<id>__read` fa una richiesta GET e parte subito; `<id>__write` fa POST, PUT, PATCH o DELETE e aspetta l'approvazione di una persona come ogni azione di un connettore (ADR 0025). La richiesta da approvare mostra metodo, percorso e corpo; una DELETE è segnata come distruttiva. Una richiesta che non potrebbe partire (percorso fuori dall'indirizzo base, corpo troppo grande) non arriva nemmeno all'approvazione. Con l'approvazione spenta dall'owner, anche `write` parte subito.
- **Cosa decide il modello**: metodo, percorso relativo all'indirizzo base, parametri dell'indirizzo, corpo JSON. Non decide l'host, gli header o la chiave. Un percorso che esce dall'indirizzo base (`..`, `//`, un indirizzo intero) è rifiutato; un parametro con il nome di quello della chiave pure.
- **La chiave non esce mai**: sta nel secret store del tenant, non arriva al modello, non finisce nei log, nell'audit, nelle richieste da approvare né nei messaggi d'errore (l'indirizzo con la chiave non si scrive mai). Se il servizio la rimanda nella risposta, Owni la sostituisce con «[chiave]» prima che arrivi al modello. La console non la mostra più dopo averla salvata.
- **Dove arriva la richiesta**: solo all'host dell'indirizzo base, in https (http solo su questo computer), sotto la egress policy dell'agente (`mcp:<id>`, come gli altri connettori), senza seguire redirect. Risposta fino a 100.000 caratteri; un corpo non testuale è descritto, non passato.
- **Ogni agente ha la sua chiave**: il segreto si chiama `connector.<id>.<agente>.authorization`. Due agenti con lo stesso servizio non si vedono le chiavi; rimuovere il collegamento o l'agente cancella la sua.
- **Una chiave resta col suo servizio**: salvando di nuovo il collegamento senza chiave, la chiave resta solo se l'host è lo stesso. Con un host nuovo l'owner la deve rimettere: un indirizzo cambiato non porta la chiave a un altro servizio. Togliere l'accesso («Nessuna chiave») cancella la chiave.

Nella stessa occasione, i segreti del modulo «Nuovo connettore» MCP passano da `connector.<id>.<nome>` a `connector.<id>.<agente>.<nome>`: prima due agenti con un connettore dello stesso ID usavano lo stesso segreto, e chi lo cambiava per uno lo cambiava per tutti. Il server accetta solo segreti dell'agente nell'indirizzo; rimuovere un connettore o un agente cancella i suoi.

## Alternative scartate

- **Un tool generico `http_request` con i segreti per nome.** Il modello sceglierebbe quale chiave mandare dove: un'istruzione nascosta in una pagina basterebbe a spedire la chiave di Stripe a un altro host.
- **Un tool per ogni indirizzo dell'API, da una specifica OpenAPI.** Più preciso, ma chiede all'owner un file che spesso non ha e moltiplica i tool. La nota in testo libero più due tool copre i casi reali; OpenAPI si può aggiungere sopra.
- **Approvare anche le letture.** Una GET non cambia niente sul servizio; chiedere sempre insegna a premere «Approva» senza leggere.
- **Mettere il collegamento API nei tool proposti.** Un tool proposto è codice scritto dal modello che gira in sandbox senza segreti: dargli una chiave toglierebbe il motivo della sandbox.

## Conseguenze

- Una GET che su un servizio mal fatto cambia qualcosa parte senza approvazione. L'owner lo sa dal modulo: se non si fida, spegne il collegamento o lo usa solo per scrivere con approvazione.
- Il corpo della risposta arriva al modello: dati di un servizio, recintati come i risultati degli altri connettori. La chiave scritta così com'è viene nascosta; una chiave rimandata trasformata (codificata, spezzata) no.
- OAuth per un'API senza MCP non c'è: chi lo vuole usa un server MCP o un connettore integrato.
- I connettori MCP con segreti salvati prima di questo cambio continuano a usare il nome vecchio finché l'owner non rimette il valore dal modulo.
- I server MCP con un segreto salvato dal modulo tengono il segreto anche quando l'owner ne cambia l'indirizzo: per loro la regola dell'host nuovo non c'è ancora.
