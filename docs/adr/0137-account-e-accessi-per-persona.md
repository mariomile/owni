# 0137: Account in una pagina, accessi per persona

Mario (31 ottobre 2026): «Ancora non ho capito come funziona l'account e la sua gestione», poi «semplifichiamo e assicurati anche che funzioni». Il menu aveva «Account e gestione» e «Il tuo account»: la prima era una pagina che rimandava altrove, la seconda un dialog. Per sapere cosa può fare una persona bisognava aprire la configurazione di ogni agente, scheda «Accessi».

## Decisione

- **Una pagina «Account»** (`#/account`) al posto della pagina «Account e gestione» e del dialog «Il tuo account». In cima, per tutti, Google e la verifica in due passaggi, nella pagina. Sotto, per l'owner, «Installazione» con i tre link (persone e accessi, provider, consumi e registro); per un membro, le sue esecuzioni. Nel menu una voce sola, «Account». Il ritorno dal consenso di Google arriva su questa pagina.
- **Gli accessi alla console si gestiscono per persona**, in «Persone e accessi». Ogni riga dice a quali agenti la persona scrive e per quali approva; «Accessi» li cambia, un agente per riga, e ogni spunta si salva da sola. Il modulo «Aggiungi una persona» sceglie già gli agenti a cui scrive (spuntato, se l'agente è uno solo), così un nuovo membro non entra in una console vuota.
- **Il dato non cambia.** I permessi restano di ogni agente (`allowedUsers.web`, `approvers.web`) e si scrivono con lo stesso `PUT /api/instances/:id/settings`. Le modifiche a uno stesso agente partono una dopo l'altra, ognuna con gli elenchi interi; una modifica respinta torna indietro sullo schermo e si dice.
- **La scheda «Accessi» della configurazione dell'agente sparisce.** Un solo posto dove cambiarli. «Dove risponde», nella scheda Canali, porta a «Persone e accessi»; Telegram, WhatsApp e telefono tengono i loro elenchi nella configurazione dell'agente, perché sono numeri e id del canale, non persone della console.

## Alternative scartate

- **Tenere entrambi i posti.** Due schermate per lo stesso permesso dicono cose diverse appena una si aggiorna e l'altra no.
- **Una tabella persone × agenti.** Con più di tre o quattro agenti non sta in larghezza, e sul telefono per niente.
- **Spostare i permessi sulla persona nel server.** Il modello per agente regge già i canali, le approvazioni e le stanze: cambiare la sola vista basta.

## Conseguenze

- `src/web/ui/account.js` diventa `src/web/ui/pages/account.js` (`viewAccount`); `accountDialog` non c'è più.
- La pagina «Persone e accessi» legge le impostazioni di ogni agente: una richiesta per agente in più, solo per l'owner.
