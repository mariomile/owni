# Settimana 6: istanze dalla console, affidabilità e sicurezza

Branch `week-6` (parte da `main` dopo il merge delle settimane 4 e 5). Vocabolario: [`GLOSSARY.md`](../GLOSSARY.md).

## Perché

Fino alla settimana 5 una nuova Istanza si creava solo da configurazione o nel codice. Per un owner che vuole un Owni per reparto (acquisti, vendite, amministrazione) serviva un passaggio tecnico. Era il primo punto della lista «Dopo» in [`stato-e-todo.md`](stato-e-todo.md).

## Cosa funziona (verificato dai test)

- **Nuova istanza dalla console** (`test/app.test.ts`). L'owner preme «Nuova istanza» nella barra laterale, sceglie nome, ID (proposto dal nome) e istruzioni facoltative. L'istanza nasce con lo stesso modello dell'istanza principale, egress limitata al modello e al canale web, e solo chi l'ha creata può scriverle; il resto si decide in Impostazioni. La chat risponde subito, senza riavviare, e dopo un riavvio. ID non valido, nome vuoto o ID già usato vengono rifiutati con un messaggio. Solo l'owner può creare istanze (`POST /api/instances`).
- **Task programmati dell'istanza nuova** (`test/app.test.ts`). Lo scheduler rilegge l'elenco delle istanze a ogni giro: i task di un'istanza appena creata partono senza riavvio. Prima l'elenco era fissato all'avvio.
- **Risposte in tempo reale** (`test/app.test.ts`). Uno stream di eventi aperto prima della creazione riceve anche le risposte dell'istanza nuova. Prima i canali venivano agganciati solo all'apertura dello stream, quindi nel browser la risposta compariva solo ricaricando.

- **Ritentativi delle risposte nello stesso processo** (`test/outbox.test.ts`). Una risposta che il canale non prende per un problema di rete, o per un «non ora» (un 429 o un errore 5xx di Telegram), riparte dopo 5 secondi, poi 30 secondi, 2 minuti e ogni 10 minuti, fino a 14 volte; poi aspetta il prossimo avvio. Un fallimento di un tentativo già superato (dopo una riapertura dell'istanza) non la rimanda di nuovo. Prima restava nell'outbox fino al riavvio. Ogni nuovo tentativo porta l'avviso «Possibile doppione», perché il tentativo fallito potrebbe essere arrivato comunque. Un rifiuto definitivo del canale (per esempio un utente che ha bloccato il bot, o un file non più nel workspace) non viene ritentato nel processo: resta nell'outbox per il prossimo avvio e finisce nell'audit (`reply.refused`). Lo spegnimento annulla i ritentativi in sospeso. Le schede della segreteria si ritentano già a ogni giro di polling dalla settimana 4: il giro (un minuto di default) fa da intervallo.

- **Pulizia dell'outbox** (`test/outbox.test.ts`). All'apertura di un'istanza le risposte alle persone consegnate da più di 30 giorni vengono tolte dall'outbox (evento `outbox.pruned` nell'audit); quelle recenti, quelle non ancora consegnate e i messaggi che l'istanza manda da sé (gli avvisi dei tool da approvare, la cui chiave evita un secondo avviso) restano. Senza pulizia l'outbox cresceva di un file per risposta e ogni avvio li rileggeva tutti. I file del workspace invece non si cancellano da soli: sono dati delle persone.

- **Container con privilegi minimi** (`docker-compose.yml`). Filesystem in sola lettura tranne `/data` e `/tmp`, nessuna capability Linux, niente escalation di privilegi (`no-new-privileges`). I tool proposti girano in un processo figlio dentro lo stesso container e ne ereditano i limiti. L'utente di sistema separato per la sandbox è scartato: servirebbero proprio i privilegi che qui togliamo (ADR 0002, sezione aggiunta). Verificato con un'immagine costruita da questo branch e avviata con le stesse opzioni: healthcheck `healthy`, utente 1000, `/app` non scrivibile, `/data` sì; login, file, tool proposto approvato ed eseguito in sandbox (con `node:sqlite` bloccato), tutto ancora lì dopo `docker restart`.

- **Verifica in due passaggi** (`test/totp.test.ts`, `test/web.test.ts`). Ognuno, dal dialogo «Il tuo account» (clic sul proprio nome), può attivarla: aggiunge la chiave all'app di autenticazione del telefono e conferma con un codice. Da quel momento il link personale da solo non basta: al login serve il codice di sei cifre. Attivarla chiude le altre sessioni della persona. Ogni codice vale una volta sola; dopo cinque tentativi in dieci minuti (contati prima della verifica, anche in parallelo) il login e la disattivazione aspettano; i tentativi respinti finiscono nell'audit (`web.login_denied`). Per disattivarla serve un codice. L'owner può toglierla a chi ha perso il telefono (Persone → Reset 2FA, oppure `pnpm owni person reset-2fa <id>`). TOTP standard (RFC 6238, verificato sui vettori della RFC), senza dipendenze nuove. Decisione in [ADR 0006](adr/0006-verifica-in-due-passaggi-totp.md).

## Review indipendente

Due revisori separati (standard del repo e aderenza a questo documento) hanno trovato questi problemi, tutti corretti con un test:

- **Alta, 2FA.** Il limite di cinque codici si aggirava mandando i tentativi in parallelo (il conteggio si leggeva prima della verifica e si scriveva dopo), e la disattivazione non aveva limite: da una sessione aperta si potevano provare codici all'infinito. Ora ogni tentativo conta prima della verifica, su login e disattivazione.
- **Alta, 2FA.** Attivare la verifica lasciava aperte le sessioni esistenti, anche una aperta con un link rubato. Ora l'attivazione chiude le altre sessioni e il reset le chiude tutte.
- **Media.** La riga di comando e il server scrivevano `people.json` e `sessions.json` senza coordinarsi: un reset poteva essere sovrascritto. Ora le scritture passano da un lock condiviso fra processi.
- **Media, ritentativi.** Due segnalazioni di fallimento insieme potevano programmare due ritentativi; un fallimento arrivato dopo una riapertura rimandava una risposta già ripartita; i ritentativi non finivano mai; un 429 di Telegram era trattato come rifiuto definitivo; un file sparito si ritentava per sempre. Corretti tutti.
- **Media, pulizia.** La pulizia toglieva anche la chiave che impedisce di rimandare l'avviso di un tool in attesa da più di 30 giorni. Ora tocca solo le risposte alle persone.
- **Bassa.** Due creazioni della stessa istanza insieme davano un errore 500 invece del messaggio; la creazione non finiva nell'audit con chi l'ha fatta (`web.instance_created`); la riga di comando su un ID sconosciuto stampava uno stack trace; nell'interfaccia «2FA» al posto della parola del glossario. `docs/architettura.md` ora descrive ritentativi e pulizia, e c'è l'[ADR 0006](adr/0006-verifica-in-due-passaggi-totp.md).

## Verifica

- `pnpm typecheck`: ok. `pnpm test`: 26 file, 172 test, 0 fallimenti (146 a fine settimana 5). `pnpm eval:segreteria`: 35 casi ok.
- Chromium headless: l'owner crea «Ufficio acquisti» dal dialogo, l'istanza viene selezionata, la chat risponde in tempo reale. Poi attiva la verifica in due passaggi, esce, rientra: il link da solo viene respinto, un codice sbagliato pure, quello giusto entra. Nessun errore in console oltre ai 401 attesi.

## Limiti

| Cosa | Limite |
|---|---|
| Modello | l'istanza nuova usa il modello dell'istanza principale; cambiarlo resta un'operazione da configurazione |
| Telegram | l'istanza nuova parla solo dal web; un bot Telegram resta legato all'istanza principale |
| Cancellazione | la console non cancella istanze |
| Verifica in due passaggi | la chiave TOTP sta in `people.json` nella cartella dati, come il resto dei dati delle persone: i backup vanno conservati cifrati. Il blocco dopo cinque codici sbagliati vale per il processo e si azzera al riavvio |
