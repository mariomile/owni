# 0132: Gli agenti reagiscono ai messaggi con un'emoji

A un «grazie», a un «fatto» o a una buona notizia l'agente rispondeva sempre con un messaggio intero. Una persona in chat metterebbe un 👍 e basta. Telegram, WhatsApp e la console sanno mostrare una reazione sotto il messaggio a cui risponde.

## Decisione

- **Uno strumento, `message_react`.** L'agente sceglie un'emoji da una lista corta (`REACTIONS` in `src/core/tools/reaction-tools.ts`) che si vede uguale sui tre canali. Reagisce al messaggio della persona a cui sta rispondendo: l'ultimo input del turno arrivato dal canale della conversazione. Un turno che non risponde a una persona (la risposta di un collega, un task programmato, una notifica) e il canale `agente` non hanno niente a cui reagire: la risposta di un collega arriva come nota di Owni, e la persona deve ancora sentirla. Lo strumento risponde con un errore e l'agente risponde a parole.
- **Se la reazione dice tutto, nessun messaggio.** L'agente reagisce e chiude il turno senza scrivere. Il gateway non manda una risposta vuota su nessun canale.
- **Passa dall'outbox come un messaggio.** La reazione è una `Reply` con stato `reaction`, chiave `react:` più l'id della chiamata: consegnata almeno una volta, mai due. Un canale senza `react` non ha niente da consegnare.
- **Nella console è una riga del transcript, piegata in lettura.** `WebChannel` e `RoomStore` scrivono la reazione come riga a sé e la attaccano al messaggio quando leggono. Conteggi, anteprime e thread non la vedono come risposta. In un canale l'agente reagisce al messaggio della sua postazione, che porta in `about` l'id del messaggio del canale: la reazione finisce lì, una per agente.
- **Si aggiorna in posto.** L'evento dal vivo rimanda il messaggio con `reaction: true`: la console cambia la riga delle reazioni ovunque il messaggio sia a schermo, senza notifiche e senza segnarlo da leggere. In un canale chiude l'attesa dei puntini: la reazione è la risposta.
- **WhatsApp fuori dalla finestra di 24 ore**: la reazione si lascia cadere. Non vale un template.

## Conseguenze

- Una nuova reazione dello stesso agente sostituisce la precedente, come su Telegram e WhatsApp.
- L'agente non reagisce ai messaggi più vecchi del turno, né in un canale al messaggio di un collega che lo chiama: sono scelte, non limiti tecnici.
- Lo strumento dice «messa» quando la reazione è nell'outbox. Se il canale poi la rifiuta (un gruppo Telegram che limita le reazioni), il turno finisce senza niente per la persona; il rifiuto resta nel log della consegna.
