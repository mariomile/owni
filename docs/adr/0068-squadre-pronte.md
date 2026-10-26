# Squadre pronte

> Aggiornata da [ADR 0117](0117-organigramma-degli-agenti.md): una squadra pronta entra nell'organigramma con chi la coordina, i ruoli, le responsabilità e chi risponde a chi. Le istruzioni dei membri tengono solo il loro lavoro, chi parla con chi lo decide l'organigramma e «Fate squadra» non c'è più. Il resto di questa decisione vale ancora.

Owni ha già tutti i pezzi per far lavorare più agenti insieme: agenti con un compito ciascuno ([ADR 0041](0041-agenti.md)), che si chiedono aiuto ([ADR 0042](0042-agenti-che-si-scrivono.md)), stanze dove la persona li chiama tutti ([ADR 0063](0063-stanze.md)) e sotto-schede per dividere il lavoro sulla board ([ADR 0066](0066-sotto-schede.md)). Montarli a mano però vuol dire creare tre agenti, scrivere tre istruzioni che si citano a vicenda, spuntare chi scrive a chi e aprire una stanza. Le alternative a Grok Bot che abbiamo guardato partono da squadre già fatte; da noi chi non conosce questi pezzi non li trova.

## Decisione

- **Nella pagina Agenti, «Squadre pronte»** apre l'elenco: Contenuti (Caporedattore, Ricercatore, Scrittore), Vendite (Responsabile vendite, Ricerca clienti, Preventivi), Amministrazione (Responsabile amministrativo, Contabile, Assistente d'ufficio). Un clic su «Crea la squadra» e la console apre la stanza della squadra.
- **Ogni membro è un agente come quelli del modulo «Nuovo agente»**: nome, emoji, riga, tono, modello dell'agente principale, aperto solo all'owner. Le sue istruzioni sono quelle predefinite più il suo compito e la squadra: chi sono gli altri (nome e ID), chi coordina e come passa il lavoro.
- **Il primo coordina**: riceve le richieste, chiede agli altri con agent_message o con @nome nella stanza, e per una scheda della board affidata a lui la divide in sotto-schede per gli altri, che partono subito, e lavorano da sole se lo fa la scheda. Gli altri fanno la loro parte e mettono la scheda in «Da rivedere» con un riassunto.
- **Si scrivono solo fra loro**: ognuno accetta i messaggi degli altri della squadra, non dell'agente principale né di altri agenti. L'owner allarga in Impostazioni o con «Fate squadra».
- **ID liberi**: se «ricercatore» c'è già, il nuovo è «ricercatore-2» (fino a -9), e le istruzioni degli altri citano quello. La stessa squadra si può creare più volte.
- **Il catalogo sta nel codice** (`src/core/teams.ts`): istruzioni scritte e provate da noi, uguali per tutti; le cambia solo un aggiornamento di Owni. Le squadre già create non cambiano.
- **Se qualcosa va storto a metà**, gli agenti già creati restano e il messaggio li elenca per nome; due squadre chieste insieme si creano una dopo l'altra; se la stanza non si può aprire (già 50 stanze), la squadra c'è lo stesso e la console lo dice. Audit `team.created` con la squadra, gli agenti e se la stanza c'è, più `room.created` come per ogni stanza.

## Alternative scartate

- **Squadre fatte dall'owner e salvate come modello**: più lavoro per una cosa che si fa una volta; chi vuole una squadra diversa crea gli agenti a mano e usa «Fate squadra».
- **Un agente solo con più «ruoli»**: perde quello che rende utili più agenti, cioè strumenti, memoria e modello di ciascuno, e la stanza dove si vede chi ha detto cosa.
- **Squadre che lavorano da sole appena create**: un agente che parte senza che una persona glielo chieda è proprio quello che la board evita con Avvia.
