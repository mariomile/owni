# Il modello di ogni chat

Con [ADR 0032](0032-qualsiasi-modello.md) l'owner sceglie il modello dell'istanza, uno per tutte le chat. Su Grok, ChatGPT o Claude chi scrive cambia modello dalla chat: uno veloce per una domanda al volo, uno che ragiona per un conto difficile, uno che guarda le foto. Owni è l'alternativa che non lega a un modello, quindi anche qui si sceglie chat per chat.

## Decisione

- **Una pillola nel box di scrittura**, accanto a invio, con il nome del modello. Apre un elenco che si cerca: prima «Modello dell'istanza», poi i modelli di ogni provider, con il modello suggerito del provider in cima e il prezzo per milione di token. Funziona anche sulla chat vuota: il modello scelto va alla conversazione che il primo messaggio apre.
- **Il motore ricorda il modello della chat.** `EngineSession.setThreadModel` lo scrive in un documento di Pi Durable (`owni.thread-models`), nella stessa base dati delle conversazioni: vale dal messaggio successivo e dopo un riavvio, anche per il lavoro lasciato a metà. A ogni messaggio la conversazione prende il modello della chat se ne ha uno, altrimenti quello dell'istanza; le istruzioni restano quelle dell'istanza. Il provider di un modello scelto in una chat si registra la prima volta che serve.
- **Quali modelli.** Chi scrive vede i provider che l'istanza può usare (`egress.modelProviders`) e che hanno una chiave, del server o salvata dall'owner. L'owner vede anche i provider con una chiave che l'istanza non usa ancora: sceglierne uno lo aggiunge a quelli permessi (`instance.model_provider.allowed` nell'audit), senza riaprire l'istanza e senza toccare il resto della policy. Un membro non allarga mai quello che l'istanza raggiunge. Il modello di prova compare solo quando l'istanza gira con quello.
- **Il permesso conta adesso, non all'apertura.** La chiave di un provider arriva al motore solo se il provider è permesso nel registro in quel momento: un provider tolto dall'owner smette di rispondere subito, uno aggiunto risponde senza riaprire l'istanza.
- **Una chat che perde il suo modello risponde con quello dell'istanza.** Se il provider della chat non è più permesso o ha perso la chiave, la chat risponde con il modello dell'istanza invece di restare muta, anche per il lavoro ripreso dopo un riavvio. La scelta resta salvata: quando il provider torna raggiungibile la chat riprende il suo modello. Nel frattempo la pillola mostra il modello dell'istanza. Nessuno cancella la scelta, quindi nessuna gara fra chi la legge e chi la scrive.
- **API.** `GET /api/instances/:id/chat-models` (i provider della persona e il modello dell'istanza), `GET /api/instances/:id/chat-models/:provider` (i modelli), `PUT /api/instances/:id/threads/:thread/model` con `{provider, modelId}` o `{}` per tornare a quello dell'istanza (409 se il provider non è più raggiungibile); `POST /api/instances/:id/threads` accetta `model`, così la chat nuova nasce con il suo modello e un modello rifiutato non lascia chat vuote; `GET /api/instances/:id/threads/:thread` dice `model` quando la chat ne ha uno raggiungibile. Le risposte portano il `name` del modello, così la pillola non mostra id grezzi. Ognuno sceglie solo per le sue chat. Ogni scelta va nell'audit (`chat.model.updated`), senza chiavi.

- **Ogni risposta dice chi l'ha scritta.** Il motore legge il modello dal messaggio della risposta (provider e id, come li riporta il provider) e lo passa con la risposta: outbox, gateway, canale. La console lo mostra accanto all'ora, con il nome; così si vede anche quando una chat ha risposto con il modello dell'istanza perché il suo non era raggiungibile. Il nome si aggiunge leggendo, non si salva. Telegram e WhatsApp lo ignorano.

## Alternative scartate

- **Il modello nel messaggio.** Ogni messaggio avrebbe portato il suo modello. Ma nelle chat arrivano anche messaggi che non scrive la persona (task, sentinelle, avvisi di un'approvazione): senza modello avrebbero riportato la chat a quello dell'istanza. Il modello è della chat, non del messaggio.
- **Il modello nel file della chat della console.** Sarebbe valso solo per la console, e dopo un riavvio il lavoro a metà sarebbe ripartito con il modello sbagliato. Nel motore vale per ogni canale e per la ripresa.
- **Tutti i provider con una chiave, per tutti.** Una chiave del server non è un permesso: l'istanza raggiunge solo i provider che l'owner ha scelto.

## Conseguenze

- La spesa di una chat dipende dal modello scelto: l'elenco mostra il prezzo di ognuno, e un membro sceglie solo fra i provider che l'owner ha permesso.
- Il modello si allinea a ogni messaggio: un cambio mentre Owni sta già lavorando può valere per il resto di quel turno. È accettato: la scelta è della chat, e il turno successivo la usa comunque. Costa una scrittura in più nella base dati per messaggio.
- Su Telegram e WhatsApp si sceglie con il comando `/modello` ([ADR 0037](0037-modello-dai-canali.md)).
