# Agenti: più agenti per tenant, ognuno con la sua personalità

> Aggiornata dall'[ADR 0125](0125-stato-unico-degli-agenti-e-console-piu-chiara.md): `persona` non ha più `emoji`; un'emoji mandata o salvata prima viene lasciata fuori. La pagina Agenti mostra lo stato dell'agente e i conteggi diversi da zero.

Mario (17 ottobre 2026): «si devono poter creare più Agenti, ognuno con la propria memoria, personalità, automazioni». Come Grok bot, dove ogni bot ha un nome e un carattere.

Quasi tutto c'era già: un'istanza è un agente con il suo modello, le sue conversazioni, la sua memoria (`memory.json` nella cartella dell'istanza), i suoi task programmati e sentinelle, i suoi file, i suoi connettori e il suo bot su Telegram, WhatsApp e telefono. L'owner ne creava di nuove da «Nuova istanza». Mancavano tre cose: un nome che l'agente usa davvero (ogni istanza nuova si presentava come Owni, perché le istruzioni predefinite dicono «Sei Owni»), una personalità che non fosse un muro di istruzioni, e un posto dove vederli tutti.

## Decisione

- **Le persone vedono «agente», il codice resta `Instance`.** Nella console «istanza» diventa «agente» ovunque. Il glossario lo registra: un agente è un'istanza vista da chi la usa.
- **Persona.** `InstanceRecord.persona` ha tre campi facoltativi: `emoji` (la faccia nella console), `tagline` (cosa fa, in una riga, al più 120 caratteri) e `tone` (`naturale`, `formale`, `amichevole`, `conciso`, `scherzoso`). `checkPersona` li controlla: una sola emoji (niente lettere, cifre o spazi), un tono tra quelli previsti.
- **Il modello sa chi è.** All'apertura il runtime passa al motore `withPersona(istruzioni, nome, persona)`: le istruzioni dell'agente, poi un blocco «Chi sei» con il nome (se non è Owni, e con il genere che si addice al nome, perché le istruzioni predefinite parlano al femminile), il compito e il tono. Il nome entra solo quando l'owner ha dato all'agente una personalità dalla console (`persona.named`, messo dal server): le istanze nate da uno script con nomi come «Telegram (default)» o «Segreteria (acme)» non cambiano finché l'owner non salva la loro personalità, e le conversazioni esistenti tengono le loro istruzioni. Il nome passa da `cleanName` (una riga, senza « »), così non apre righe nuove nelle istruzioni. Il blocco sta dopo le istruzioni, così l'owner non lo cancella per sbaglio modificandole, e cambia con un salvataggio (che riapre l'istanza).
- **Pagina Agenti.** Nella barra laterale, per tutti: ogni agente che la persona può vedere, con faccia, compito, modello, tono, canali oltre al web, e quanti task, sentinelle e ricordi ha. Si contano i task e le sentinelle che la persona vedrebbe nelle loro pagine (tutti per l'owner, quelli che lavorano per lui per un membro) e, per tutti, i ricordi suoi e quelli condivisi: i ricordi di una persona restano suoi anche nei numeri. «Chatta» apre la chat con quell'agente; l'owner ha anche «Personalità e impostazioni».
- **Nuovo agente.** Il modulo parte da un modello (Da zero, Assistente, Ricercatore, Scrittore, Analista, Assistenza clienti) che riempie nome, emoji, compito, tono e istruzioni: si cambia tutto prima di creare. I modelli stanno nella console, non nel server: sono solo un aiuto a compilare.
- **Una persona sola per volta.** `PUT` sostituisce tutta la personalità, non la fonde: la console la manda sempre intera.
- **Impostazioni.** La card «Personalità» sostituisce quella con nome e istruzioni: emoji e nome sulla stessa riga, compito, tono, istruzioni.
- **Eliminare un agente**: dalla console, con il nome da scrivere per conferma ([ADR 0046](0046-eliminare-un-agente.md)).
- **API.** `POST /api/instances` e `PUT /api/instances/:id/settings` accettano `persona`; `GET /api/instances` aggiunge `emoji` e `tagline` quando ci sono; `GET /api/agents` dà la pagina Agenti. Un nome vuoto in Impostazioni non cancella più il nome.

## Scartato

- **Un agente per thread, scelto dalla chat** (come i GPT): ogni agente ha già memoria, file e bot suoi; mescolarli nello stesso elenco di conversazioni confonderebbe di chi è la memoria.
- **Avatar caricati come immagini**: l'emoji basta a riconoscerli, non pesa e si vede uguale sul telefono, nel selettore e nei canali.
- **Personalità libera senza istruzioni**: il tono a scelta chiusa dice al modello una cosa precisa; il resto va nelle istruzioni, come prima.

## Da fare

- Le istruzioni in Impostazioni mostrano anche quelle predefinite: sarebbe più chiaro modificare solo la parte dell'owner, come in Primi passi.

## Conseguenze

- Gli agenti si scrivono tra loro (ADR 0042): il nome e il compito sono quello che un agente vede degli altri.
- Telegram e WhatsApp non cambiano: ogni agente ha già il suo bot. La faccia e il nome nei canali sono quelli del bot.
