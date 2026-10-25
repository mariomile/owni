# Eliminare un agente

Con più agenti per tenant ([ADR 0041](0041-agenti.md)) serviva anche il contrario di «Nuovo agente»: toglierne uno fatto per prova, o che non serve più. Finora l'owner poteva solo togliere a tutti il permesso di scrivergli, e l'agente restava lì con bot, chiavi, automazioni e file.

## Decisione

- **Solo l'owner, dalla console**, nella card «Elimina agente» in fondo a Impostazioni. Il dialogo dice cosa se ne va e che non si può annullare, e il pulsante si attiva solo quando l'owner scrive il nome dell'agente com'è adesso. Il server ricontrolla il nome (`DELETE /api/instances/:id` con `{ "confirm": "<nome>" }`): un nome sbagliato o mancante è un 400, un membro riceve 403.
- **Non si eliminano l'agente principale né la segreteria.** Il principale è quello che Owni crea a ogni avvio (`OWNI_INSTANCE_ID`, con il bot del `.env`): eliminarlo lo farebbe solo ricomparire vuoto. La segreteria si configura dal server. Per loro la card non c'è e il server risponde 400.
- **Un'eliminazione alla volta per agente**: una seconda richiesta (un doppio clic, due schede) aspetta la prima.
- **Prima si stacca tutto quello che l'agente ha fuori dalla sua cartella**, così niente lo riapre mentre se ne va:
  - la chat web e il canale degli altri agenti, il bot Telegram (che in modalità webhook chiede anche a Telegram di smettere di mandare aggiornamenti), il numero WhatsApp e il telefono, i task programmati e le sentinelle (lo scheduler legge l'elenco degli agenti a ogni giro);
  - le sue chiavi nel secret store del tenant: token del bot Telegram e segreto del webhook, credenziali WhatsApp e Twilio, token OAuth dei connettori MCP e token incollati nei connettori in un clic. I segreti che l'owner nomina negli header di un connettore restano, perché può usarli anche un altro agente;
  - gli accessi a un connettore lasciati a metà, che non possono più finire;
  - il permesso degli altri agenti di ricevere messaggi da lui (e il loro canale `agente`, se non resta nessuno da cui riceverne). Conta: un agente nuovo con lo stesso ID non deve ereditare la fiducia del vecchio.
  
  Se l'eliminazione si ferma qui per un errore, l'agente resta ma scollegato, e si può eliminare di nuovo.
- **Poi il core lo chiude e cancella la sua cartella** (`OwniRuntime.removeInstance`): l'agente aperto si chiude senza riprendere il lavoro in corso, che se ne va con lui, e nel frattempo nessuno lo può aprire né riaprire. Se un altro processo lo tiene aperto (la CLI, un bot avviato a parte), il lock dell'istanza ferma l'eliminazione. La cartella `instances/<id>/` viene spostata in `removed/` con un solo `rename`, così l'agente sparisce subito anche se cancellare i file richiede tempo o si interrompe; quello che resta in `removed/` si cancella al prossimo avvio. Nella cartella c'è tutto quello che l'agente aveva: conversazioni, sessione del modello, memoria, persone conosciute, liste, workspace, task, sentinelle, richieste in attesa, tool approvati, connettori, outbox, preferenze di voce, finestra WhatsApp.
- **Infine** si chiudono i browser delle sue conversazioni e si cancellano il suo computer e il suo schermo con i loro file (uno schermo remoto condiviso non si tocca). Un errore qui finisce nel log dell'operatore: l'agente è già eliminato.
- **L'ID torna libero**: un agente creato dopo con lo stesso ID parte vuoto. Prima di crearlo Owni toglie di nuovo chiavi e permessi rimasti a quell'ID, e mette da parte una cartella senza record (file rimessi da una scrittura arrivata in ritardo). Per lo stesso motivo un task che finisce dopo l'eliminazione non riscrive il suo file, una risposta con un file per un agente che non c'è più viene scartata prima di scrivere, e l'elenco degli agenti ignora una cartella senza record.

## Cosa resta

- **L'audit log del tenant**: è la traccia di cosa è successo, e ci restano le righe dell'agente eliminato, più `instance.deleted` (ID e nome) e `web.instance_deleted` (chi l'ha eliminato).
- **Il registro dei costi**: le spese già fatte restano nel mese in cui sono state fatte.
- **Il numero Twilio e il webhook di Meta** restano puntati su Owni finché l'owner non li cambia da Twilio e dall'app Meta; chiamate e messaggi vengono rifiutati, come dopo «Scollega».
- **Le risposte di altri agenti** indirizzate all'agente eliminato vengono scartate senza riprovare ([ADR 0042](0042-agenti-che-si-scrivono.md)). Una risposta che un altro agente sta ancora riprovando a consegnare quando l'ID è già stato riusato arriva al nuovo agente: un caso limite che accettiamo.
