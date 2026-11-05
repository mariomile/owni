# 0138: Canali con più persone

> Proposta, da approvare. Aggiorna [ADR 0113](0113-canali-messaggi-diretti-e-thread.md), che aveva scartato i canali condivisi «da decidere quando serve davvero».

Mario (5 novembre 2026): «Vorrei fare uno Slack multiplayer interno ma per le imprese, PMI soprattutto italiane, dove le persone non ci capiscono niente di tecnologia». Oggi la console è già una chat di team con gli agenti (messaggi diretti, canali, thread, ADR 0113), ma ogni canale è di una persona sola: il titolare e la sua impiegata non possono lavorare insieme con lo stesso agente nello stesso posto, e si passano le risposte di Owni su WhatsApp.

Persone e agenti negli stessi canali non bastano a distinguerci: da luglio a ottobre 2026 li hanno lanciati Grok Bot, Buzz di Block (gratis e open source), Ando, OpenAI Space e Slack ([analisi del 4 novembre](https://claude.ai/artifact/15MbwxCDuyRfTPGsVpPmkY)). Sono pensati per team che usano già Slack. La differenza che scegliamo è il pubblico: un ufficio di 3-15 persone che non ha mai usato Slack, non sa cosa sia un agente e non deve configurare niente.

## Principio: nessuno deve capire la tecnologia

Ogni scelta sotto passa questa prova: la segretaria di un'impresa edile di Frosinone, al primo accesso dal telefono, scrive nel canale giusto senza una spiegazione.

- **Niente da configurare per partire.** All'installazione (e in Owni Cloud alla registrazione) nasce `#generale` con il titolare e l'agente principale. Chi entra dopo ci si ritrova dentro.
- **Invitare è dare un nome e un numero o una mail.** Owni manda il link personale (che esiste già, `pnpm owni person add`) per mail o con un messaggio WhatsApp da inoltrare, già scritto. Niente password, niente app da installare: il link apre la console nel browser.
- **Le parole della console sono quelle di un ufficio.** «Persone», «Canali», «Owni», «Chi decide». Mai istanza, tenant, permesso, approvatore, prompt.
- **L'agente si chiama toccando il suo volto o scrivendo il suo nome.** La `@` funziona ma nessuno deve impararla.

## Decisione

- **Un canale ha dei membri.** Oltre agli agenti (da 1 a 5), un canale ha da 1 a 20 persone della console (`Room.members`, con `personId` che resta chi l'ha creato). Tutti i membri vedono tutti i messaggi del canale e dei suoi thread, e possono scrivere. Un canale con un solo membro funziona esattamente come oggi.
- **Chi aggiunge chi.** Il titolare (owner) e chi ha creato il canale aggiungono e tolgono persone e agenti. Un agente si aggiunge solo se chi lo aggiunge può scrivergli. Una persona aggiunta al canale può chiamare gli agenti di quel canale lì dentro, anche se nel suo elenco di accessi ([ADR 0137](0137-account-e-accessi-per-persona.md)) non li ha: entrare nel canale è l'accesso. Fuori dal canale non cambia niente.
- **Le persone parlano tra loro, gli agenti rispondono solo se chiamati.** In un canale con più persone un messaggio senza un agente chiamato è per le persone, e nessun agente risponde (oggi risponde l'ultimo agente che ha parlato: resta così solo nei canali con un membro). Altrimenti ogni «ok grazie» tra colleghi costerebbe una risposta del modello.
- **Per il nucleo un canale con più persone è un gruppo.** È la regola che vale già per i gruppi Telegram e WhatsApp (`MemorySubjects.clear`, [ADR 0062](0062-memoria-con-archivio.md), [ADR 0038](0038-liste.md)): arrivano solo le memorie e le liste condivise, mai quelle private di chi scrive. Una cosa detta a Owni in privato non esce in un canale davanti ai colleghi.
- **Un posto per agente e per canale.** Oggi ogni agente ha un posto (`WebThread.room`) per persona. In un canale con più persone il posto è del canale: una conversazione sola dell'agente, con il nome di chi scrive davanti a ogni messaggio, fuori dal recinto come le parole di chi chiama. Il modello scelto per la chat ([ADR 0036](0036-modello-per-chat.md)) è del canale.
- **Chi decide le approvazioni.** In un canale nessuno è «la persona della conversazione privata», quindi le azioni che escono o distruggono ([ADR 0120](0120-approvazioni-per-rischio.md)) le decide solo chi approva per quell'agente. La card compare nel canale: chi può decidere vede Approva e Rifiuta, gli altri leggono «Aspetta Mario» con il nome di chi decide. Le richieste sul Google di una persona restano solo sue, e in un canale l'agente non usa il Google di nessuno.
- **Non letto per persona.** `readAt` diventa un valore per membro. Il pallino nella barra laterale e il conteggio dei thread valgono per chi guarda. Un messaggio che nomina una persona (`@Anna` o il suo nome toccato) la avvisa nella console; avvisi su Telegram, WhatsApp e mail sono una decisione a parte.
- **I comandi restano di chi li scrive.** `/chiusura-mese` lancia la skill solo dalle parole di chi chiama, come in ADR 0063, mai dal testo di un collega o di un agente citato.
- **Togliere una persona.** Non vede più il canale, i suoi messaggi restano con il suo nome. Una persona tolta dalla console esce da tutti i canali.
- **Audit**: `room.member_added` e `room.member_removed` con chi l'ha fatto; i messaggi hanno l'audit di sempre.

## Come misuriamo

L'obiettivo è che le persone di un'azienda lavorino davvero insieme dentro Owni, non solo che la funzione esista.

- **Metrica principale**: aziende con almeno un canale dove nella stessa settimana hanno scritto almeno 2 persone e un agente ha risposto. Oggi è 0 per costruzione.
- **Attivazione**: quota di persone invitate che scrive il primo messaggio entro 24 ore dal link. Soglia di partenza: almeno 60%.
- **Prova**: 3 PMI pilota con almeno 3 persone ciascuna, per 3 settimane. Si va avanti se almeno 2 su 3 restano sopra la metrica principale nella terza settimana. Le soglie sono stime nostre, non benchmark.

## Alternative scartate

- **Lasciare i canali di una persona e condividere i risultati** (un link a un messaggio, un artifact). Costa meno, ma non è lavorare insieme: il collega vede il risultato, non la conversazione, e non può chiedere all'agente nello stesso posto.
- **Usare i gruppi WhatsApp come canale condiviso.** Le PMI italiane ci stanno già, ma un gruppo ha un solo bot, nessun thread, nessuna card di approvazione e nessun posto per gli artifact. Restano un canale in più ([ADR 0063](0063-stanze.md)), non il posto di lavoro.
- **Memorie private anche nei canali, filtrate per chi scrive.** L'agente scriverebbe in un canale una cosa privata di Anna perché è Anna a chiederla, e i colleghi la leggerebbero. Nei canali con più persone valgono solo le condivise.
- **Ruoli e permessi per canale** (amministratore, ospite, sola lettura). Sono la complessità che il nostro pubblico non vuole; il titolare e chi crea il canale bastano finché un'azienda pilota non chiede altro.
- **Agenti che rispondono da soli quando capiscono che si parla di loro**, come Ando. Con 20 persone in un canale ogni messaggio diventerebbe una chiamata del modello da pagare, e un agente che interviene senza essere chiamato in una chat tra colleghi è la prima cosa che un ufficio non tecnico spegne.

## Conseguenze

- `Room` guadagna `members` e `readAt` per membro; `RoomStore.list` oggi cerca i file per prefisso `personId.` e dovrà leggere anche i canali dove la persona è membro (un indice per persona nella cartella del tenant). Un canale salvato prima resta di un membro, senza migrazione.
- Il posto di un agente in un canale con più persone non è più una conversazione privata: niente Browser personale né Schermo con i cookie di una persona ([ADR 0106](0106-browser-personale-e-controllo-umano.md)) dentro un canale condiviso.
- Il limite di 50 canali per persona conta quelli che ha creato, non quelli dove è membro.
- Ordine di lavoro proposto, una PR ciascuno: 1) membri, memorie e approvazioni nel nucleo, con i test; 2) invito con link per mail o WhatsApp e `#generale` di default; 3) non letto per persona e avvisi nella console. Prima della PR 1 serve l'ok di Mario su questa decisione.
