# 0133: L'agente risponde in un thread quando ha senso

I thread sotto un messaggio (ADR 0113) li apriva solo la persona. Un agente che rispondeva con un lavoro lungo, o su un argomento a parte, riempiva la conversazione principale. In una chat una persona apre il thread da sola quando la risposta merita un posto suo, e risponde in linea a tutto il resto.

## Decisione

- **Uno strumento, `thread_reply`.** L'agente scrive la risposta nel thread sotto il messaggio della persona a cui sta rispondendo: lo stesso messaggio di `message_react` (ADR 0132), l'ultimo input del turno arrivato dal canale. La descrizione dice quando: un lavoro lungo, un argomento a parte, qualcosa da discutere per conto suo. Un messaggio breve o di conversazione ha la risposta in linea. Dopo, il turno finisce senza parole o con una riga breve nella conversazione.
- **Solo dove ci sono thread, solo per la persona.** Funziona nei messaggi diretti e nei canali della console. Telegram, WhatsApp, le vecchie chat, un thread già aperto e i turni che non vengono da una persona (un collega, un task programmato, una notifica) hanno un errore: l'agente risponde in linea. Mai un thread dentro un thread.
- **La stessa strada di ogni messaggio.** Lo strumento trova la conversazione del thread (`threadUnder` in `src/web/thread-replies.ts`) e la consegna con `sendMessage`, chiave l'id della chiamata: almeno una volta, mai due. Nei messaggi diretti è il thread sotto il messaggio (`openReplies`). In un canale è la postazione dell'agente nel thread sotto il messaggio del canale che la sua postazione portava (`about`, ADR 0132): la risposta entra nel thread come ogni risposta di una postazione, con i suoi @nome e il limite della catena. Il thread nasce al primo uso, e da allora è lo stesso.
- **Il messaggio a cui risponde è già scritto.** La persona scrive e il turno parte prima che il messaggio sia nel transcript. `WebChannel.entry` lo legge dopo le scritture in corso del thread, così un modello veloce lo trova.
- **Il thread sa cosa l'agente ci ha scritto.** La risposta consegnata non è nella conversazione del modello del thread. Al primo messaggio della persona nel thread, l'agente riceve, insieme al messaggio a cui risponde, quello che ha già scritto lì, recintato come dati. In un canale, alla prima chiamata della sua postazione nel thread, le sue risposte già lì arrivano con le altre, segnate «(tu)».
- **La console lo mostra al suo posto.** Sotto il messaggio compare il riassunto del thread, anche se il thread è nuovo. In un canale la risposta nel thread chiude l'attesa dei puntini.

## Conseguenze

- Un secondo `thread_reply` sotto lo stesso messaggio, dopo che la persona ha già scritto nel thread, arriva alla persona ma non alla conversazione del modello del thread. Lo stesso in un canale dopo la prima chiamata della postazione. È raro: l'agente risponde nel thread dal thread stesso.
- Lo strumento dice «scritta» quando la risposta è nell'outbox, come `message_react`.
