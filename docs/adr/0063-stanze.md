# Stanze: più agenti nella stessa conversazione

> Aggiornata da [ADR 0113](0113-canali-messaggi-diretti-e-thread.md): nella console le stanze si chiamano canali (`#nome`), si modificano (nome e agenti) e hanno thread sotto i messaggi. Il resto di questa decisione vale ancora.

Con più agenti (ADR 0041) una persona parla con uno alla volta, e gli agenti si chiedono le cose fra loro dietro le quinte (ADR 0042), dove la persona non vede lo scambio. Per un lavoro che tocca più competenze («trova il bando, prepara l'offerta, fai i conti») serve una conversazione sola, dove la persona chiama chi le serve e vede tutti rispondere. Le alternative a Grok Bot che abbiamo guardato hanno le chat di gruppo fra agenti; ADR 0042 le aveva scartate *fra agenti*, perché nessuno decide chi parla e quando si ferma. Qui decide la persona.

## Decisione

- **Una stanza è di una persona**, con da 2 a 5 agenti a cui può scrivere dalla console, un nome e i suoi messaggi (`rooms/<id>.json` e `.jsonl` nella cartella del tenant). La vede solo lei; al più 50 stanze a testa.
- **La persona chiama con @nome**: `@ricercatore`, `@assistente-vendite`, o la prima parola del nome quando è solo di quell'agente (`@assistente`); `@tutti` chiama tutti. Senza nomi risponde l'ultimo agente che ha parlato, o il primo della stanza. Nella console i nomi degli agenti stanno sopra il box: un tocco aggiunge `@nome`.
- **Ogni agente ha un posto nella stanza**: una sua conversazione web con la persona, segnata con la stanza (`WebThread.room`). Non compare fra le chat della persona, e le sue risposte vanno alla stanza invece che alla chat (evento `room` del canale web). Così passano dal core come ogni messaggio: allowlist, policy, audit, motore durevole, outbox, memorie della persona, modello per chat, approvazioni nella pagina Approvazioni.
- **Quello che un agente si è perso** arriva con la chiamata: i messaggi della stanza dopo la sua ultima risposta, dentro un recinto «dalla stanza» con un'etichetta casuale, perché le risposte degli altri agenti possono citare pagine e mail. Le parole della persona che lo chiamano restano fuori dal recinto, come in chat. In testa una riga dice in che stanza è, con chi, e come chiamare un altro agente. Ogni messaggio sta su una riga (gli a capo sono rientrati), così un agente non può scrivere una riga che sembri della persona, e i finti segni «dalla stanza»/«fine stanza» diventano inerti. Arrivano al più gli ultimi 40 messaggi (16.000 caratteri), con una riga che dice quanti ne mancano. Un messaggio conta come visto solo quando è arrivato all'agente.
- **Chiamato da un altro agente**, un agente lo legge in chiaro: la richiesta non viene dalla persona, e invii, pagamenti, cancellazioni o dati privati aspettano la persona. Il messaggio passa comunque come conversazione privata della persona (è la sua stanza): il limite è la catena, non un permesso in più.
- **Un agente può chiamarne un altro** scrivendo @nome nella risposta: l'altro riceve la stanza e la riga «X ti ha chiamato in causa». Al più 3 chiamate fra agenti dopo ogni messaggio della persona; poi una nota nella stanza dice che tocca a lei. Un agente non chiama se stesso.
- **I comandi valgono anche qui**: «@contabile /chiusura-mese ottobre» lancia la skill di quell'agente, e /modello cambia il suo modello in questa stanza. Il comando si legge solo dalle parole della persona, senza i nomi chiamati (`InboundMessage.command`), mai dal testo della stanza intorno né dalla risposta di un altro agente: così niente di quello che un agente cita fa partire una skill.
- **Un agente che la persona non può più usare** (tolto dalle persone ammesse, senza chat, cancellato) resta nella stanza barrato e non riceve niente.
- **Audit**: `room.created` (con quanti agenti) e `room.deleted`; i messaggi hanno l'audit dei messaggi di ogni agente.

## Alternative scartate

- **Una conversazione condivisa del motore fra più agenti**: ogni agente ha istruzioni, strumenti e connettori suoi; mescolarli in una conversazione sola vuol dire dare a uno gli strumenti dell'altro.
- **Mandare a ogni agente tutta la stanza a ogni messaggio**: costa e ripete; la conversazione del posto ricorda già quello che l'agente ha visto, basta il pezzo nuovo.
- **Agenti che rispondono da soli senza essere chiamati**: in una stanza con cinque agenti ogni messaggio diventerebbe cinque risposte da pagare.

## Conseguenze

- Cancellare una stanza toglie i suoi messaggi; i posti degli agenti restano nelle loro cartelle, nascosti, e se ne vanno con l'agente.
- Per ora solo dalla console. Telegram e WhatsApp hanno già i gruppi, con un agente per bot.
- Le schede di approvazione di Google e dei connettori nate in una stanza si decidono dalla pagina Approvazioni, non sopra il box della stanza.
