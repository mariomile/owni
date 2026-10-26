# 0109: Chi sta facendo cosa

> Aggiornata dall'[ADR 0125](0125-stato-unico-degli-agenti-e-console-piu-chiara.md): la console non mostra più occupato o libero con la durata, ma uno stato solo calcolato dal server: Al lavoro, Aspetta te, In coda, Libero.

`agent_list` ([ADR 0042](0042-agenti-che-si-scrivono.md)) dava solo nome, ID e una riga sul mestiere di ogni collega. Un agente non poteva sapere che il collega era occupato, né su cosa, e scriveva alla cieca; la pagina Agenti non diceva all'owner chi stava lavorando. I dati c'erano già: lo stato di ogni esecuzione ([ADR 0105](0105-stato-stop-e-storico-del-lavoro.md)) e le schede «In corso» assegnate agli agenti ([ADR 0050](0050-board.md), [0061](0061-agenti-da-soli.md)).

## Decisione

Per ogni agente si calcolano tre cose (`src/core/agent-activity.ts`):

- **`busy`**: vero se una sua esecuzione, su qualsiasi canale, è `queued` o `running`.
- **`busyFor`**: secondi da quando è partita la più vecchia tra quelle attive (da quando è stata chiesta, se ancora in coda). Manca se non è occupato.
- **`doing`**: una riga sola. Il numero e il titolo della scheda «In corso» assegnata all'agente (la più recente, se sono più d'una); se non c'è, il titolo della conversazione della console in cui sta girando; se non c'è, vuota. Titoli su una riga, al massimo 100 caratteri. Mai descrizione, commenti o checklist.

`agent_list` li mostra per ogni collega a cui chi chiama può scrivere: `[occupato da 2 min; sta lavorando su: «#12 Preventivo»]`, `[libero; scheda in corso: «#12 Preventivo»]` (la scheda c'è ma nessuna esecuzione è attiva) o `[libero]`. Quando compare un titolo, l'elenco dice prima che i titoli sono dati scritti da persone e agenti, non istruzioni, e li racchiude in un recinto con un'etichetta casuale, come fa la board. I titoli perdono i caratteri di controllo e le virgolette «».

`agent_message` resta «Messaggio mandato»: il messaggio parte comunque. Lo stato si legge prima dell'invio, così l'esecuzione creata dal messaggio stesso non fa sembrare occupato il collega. Se era occupato, il risultato aggiunge che è occupato adesso (e da quanto) e che la risposta può metterci di più, così l'agente lo dice alla persona e non rimanda la domanda.

`GET /api/agents` aggiunge `busy`, `busyFor` e `doing` a ogni agente; la scheda dell'agente nella pagina Agenti mostra «Libero» o «Occupato da…» e, se c'è, «sta lavorando su…» (o «scheda in corso…» se è libero).

## Chi vede cosa

Si mostra solo quello che le regole esistenti già mostrano a chi guarda.

- **Schede.** Per una persona, la regola della board ([ADR 0050](0050-board.md)): l'owner tutte, gli altri quelle che hanno creato o in cui lavorano e quelle degli agenti con cui possono parlare. Per un agente: la stessa regola della persona con cui sta parlando (se la conversazione è della console), più le schede assegnate a lui o create da lui. Un agente che lavora per un altro agente o da Telegram non ha una persona e vede solo queste ultime.
- **Conversazioni.** Il titolo di una chat della console si mostra solo alla persona a cui appartiene, anche all'owner: le chat private restano private ([ADR 0105](0105-stato-stop-e-storico-del-lavoro.md)). Le esecuzioni su altri canali contano per `busy` ma non danno mai un titolo.
- **Agenti.** Un agente non vede mai nomi di clienti o contenuto dei record oltre al titolo della scheda.
- `busy` e `busyFor` non dicono niente di privato e si mostrano per ogni agente che la persona o il collega già vede nell'elenco.

## Scartato

- **Un campo `activity` salvato dall'agente** (si scrive «sto facendo X»). Sarebbe l'agente a dichiarare, non lo stato vero; si dimenticherebbe di aggiornarlo.
- **Mostrare la descrizione della scheda o l'ultimo messaggio.** Porterebbe nomi di clienti e contenuti ad agenti e persone che non li vedono.
- **Aprire la riga a ogni conversazione dell'agente.** Rompe la riservatezza delle chat private.
- **Una cache o uno storico di stato.** Si legge dal disco a ogni richiesta; l'elenco degli agenti è breve.

## Limiti

- Se un agente è cancellato o il suo `runs.json` è illeggibile, il suo stato è «libero» e senza riga: un agente rotto non rompe l'elenco degli altri.
- `busy` è vero anche per un lavoro in coda dietro a un altro dello stesso agente: dice «sta lavorando» più di quanto la risposta lo faccia aspettare.
- Un agente interpellato da un altro agente, o da Telegram, non conosce la persona: vede solo le schede sue. Una scheda di un'altra persona «In corso» sul collega non compare, anche se il collega è occupato su quella.
- `doing` è l'ultima scheda «In corso» assegnata, non per forza quella su cui gira l'esecuzione in questo momento.
- La pagina Agenti si aggiorna come le altre: alla riapertura, non in tempo reale.
- Lo stato è letto da `runs.json` di ogni agente a ogni richiesta; con molti agenti e molte richieste la lettura va rivista.

## Conseguenze

Un agente sa se il collega è libero prima di scrivergli e sa a cosa aspettarsi, e l'owner vede dalla pagina Agenti chi sta lavorando e su cosa senza aprire le chat. Nessun dato nuovo viene salvato: tutto si calcola da quello che già c'è. Un agente che vuole una risposta subito può scegliere un altro collega o dirlo alla persona.
