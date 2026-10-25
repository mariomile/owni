# Settimana 26: Owni scrive mail ed eventi, con approvazione

Branch `week-26`. Decisione: [ADR 0021](adr/0021-google-scrivere-con-approvazione.md). Dalla console Owni prepara mail, risposte, bozze in Gmail ed eventi da creare, spostare o cancellare sul Google di chi le scrive. Ognuno compare come card in chat, sopra la casella del messaggio, e in Approvazioni; succede solo quando quella persona tocca il pulsante. Serve `OWNI_GOOGLE_WRITE=1` ([chiavi](chiavi.md) §4); i test usano un Google finto.

## Cosa funziona (verificato dai test)

- **Il consenso** (`test/google-write.test.ts`): con la scrittura accesa Google chiede anche `gmail.compose` e `calendar.events`. Chi non li concede resta collegato in sola lettura, e Owni gli dice di ricollegarlo quando chiede di scrivere.
- **Mail**: niente parte prima dell'approvazione; parte una volta, con il testo mostrato, oggetto accentato codificato e righe d'intestazione corte. La risposta va al mittente (o a tutti con `reply_all`) nello stesso filo, con lo stesso oggetto; la bozza si salva e basta. Indirizzi strani, intestazioni con a capo, oggetto o testo vuoti sono rifiutati prima.
- **Calendario**: crea con invitati e avvisi; giorni interi con l'ultimo giorno incluso; spostare tiene la durata; invitati aggiunti e tolti; cancellare avvisa gli invitati; la card mostra l'evento com'è e se è un'occorrenza; con un `etag`, un evento cambiato nel frattempo non si tocca. Un id che non è un id non arriva a Google.
- **Chi decide**: solo la persona dell'account; un approvatore dell'istanza non la vede. Parte solo con l'account nominato dalla card e con Google ancora consentito. Due tocchi insieme fanno una sola scrittura; un token scaduto si rinnova una volta.
- **Esiti**: rifiuto di Google = non riuscito; nessuna risposta o errore di Google = esito incerto, mai ripetuto; dopo un riavvio a metà, esito incerto. Owni riceve ogni esito, anche il rifiuto. Nell'audit niente indirizzi, oggetti o testi.
- **Console** (Chromium, desktop e telefono, nessun errore): la card in chat con «Invia la mail» e «Rifiuta», il toast «Mail inviata», la card che sparisce, Owni che riferisce; in Approvazioni la modifica di un evento con orario attuale e nuovo.

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Alta.** Gli invitati: il modello vedeva solo i nomi e una modifica riscriveva la lista, togliendo tutti senza dirlo; ora indirizzi, aggiunte e tolte, e la card le mostra. Giorni interi: la fine esclusiva di Google faceva eventi di un giorno in più o rifiutati. Un consenso senza scrittura revocava anche la lettura.
- **Media.** Un id evento con `..` poteva arrivare all'indirizzo del calendario. La card non diceva a quale mail si rispondeva, né del `Reply-To` diverso. Un account ricollegato diverso avrebbe mandato la mail da un altro indirizzo. Nessun `etag`, nessun limite di tempo sulla scrittura. Il ciclo di vita copiava quello dei moduli web: ora è condiviso (`ActionQueue`). Risposte con oggetto nuovo uscivano dal filo; niente «rispondi a tutti»; «R:» diventava «Re: R:». Spostare con solo l'inizio era un errore. Cancellare non avvisava gli invitati. Le occorrenze di una serie non erano dette. Rifiuto e riavvio arrivavano in chat ma non a Owni. Le istruzioni nominavano tool che potevano non esserci. Ore con fuso mostrate come scritte. Titolo della card scritto dal modello.
- **Bassa.** Oggetti lunghi in una sola parola codificata; `References` non filtrati; indirizzi con caratteri di controllo; errori di Google in inglese e passati al modello senza recinto; link dell'esito senza controllo; limiti diversi tra schema e codice; richieste vecchie mai cancellate; un errore nel dire l'esito faceva sembrare fallita una scrittura riuscita; toast vaghi; badge non aggiornato dopo una decisione in chat; testo lungo in una card su telefono.

Lasciati e scritti nell'ADR: la bozza chiede l'approvazione come l'invio; una richiesta scaduta non manda un avviso; niente modifica di tutta la serie da un'occorrenza.

## Limiti

| Cosa | Limite |
|---|---|
| Richieste in attesa | 20 per istanza, scadono dopo 24 ore |
| Destinatari o invitati | 20 |
| Oggetto, testo | 300 e 20.000 caratteri |
| Attesa di Google | 30 secondi, poi esito incerto |
| Richieste decise | cancellate dopo 30 giorni |
| Dove | solo nelle conversazioni della persona dalla console |
