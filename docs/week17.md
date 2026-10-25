# Settimana 17: Owni risponde al telefono

Branch `week-17`. Decisione: [ADR 0012](adr/0012-chiamate-vocali-con-numero-twilio.md). Le chiamate vocali erano l'ultima parte della Fase 4 del [piano cloud](piano-cloud.md) senza codice.

## Cosa funziona (verificato dai test)

- **Collegare il numero** (`test/phone.test.ts`): l'owner scrive in Impostazioni → Telefono Account SID, auth token, numero e un codice di 4-8 cifre. Owni cerca il numero nell'account Twilio e imposta il suo indirizzo delle chiamate sul webhook della cella; credenziali sbagliate o un numero che non è nell'account danno un errore chiaro e non cambiano niente. Salvare solo «Chi può chiamare» o il codice non chiama Twilio. Auth token e codice non tornano mai indietro. A ogni avvio l'indirizzo delle chiamate viene reimpostato. Senza indirizzo https pubblico il collegamento è rifiutato e la console lo dice.
- **Solo chiamate vere**: ogni richiesta di Twilio deve avere la firma giusta (HMAC-SHA1 con l'auth token su indirizzo e parametri, con o senza la porta 443), altrimenti 403. Una chiamata da un numero non in elenco, anonima, verso un altro numero o da un altro account riceve `<Reject/>` prima di rispondere; anche un avvio ripetuto con lo stesso `CallSid`.
- **Il codice**: il numero di chi chiama si può falsificare, quindi la chiamata comincia con il codice sulla tastiera. Prima del codice Owni non dice niente di privato e non ascolta; tre codici sbagliati chiudono, e un codice giusto dopo il terzo sbagliato non apre più niente.
- **La conversazione**: Owni saluta e ascolta; la frase riconosciuta da Twilio arriva come messaggio della persona (thread privato, il suo numero), con un ID fatto di chiamata e turno, quindi una richiesta ripetuta non la manda due volte, e con una nota per il modello: risposta breve e parlata, niente schede né file. La risposta viene letta da Twilio e Owni torna ad ascoltare. Una risposta arrivata in ritardo viene detta prima della nuova, presentata come tale.
- **Risposte lente**: se la risposta non arriva entro 8 secondi Owni dice «un momento» e Twilio torna a chiedere. Dopo sei attese la chiamata si chiude con «richiamami»: la risposta resta da parte (una volta sola, anche se viene rimandata) e Owni la dice all'inizio della chiamata dopo, dopo il codice. Se chi chiama riattacca mentre aspetta, la risposta resta da parte. Un messaggio che il nucleo rifiuta chiude la chiamata con «ora non posso risponderti» invece di un'attesa senza fine.
- **Fatte per l'orecchio**: niente simboli di formattazione, i link diventano «un link», il codice non si legge, le risposte oltre 1500 caratteri vengono tagliate con l'invito a chiederle per iscritto, e un turno intero resta sotto il limite di Twilio. Un file viene nominato («lo trovi nella console») e non conta come risposta. Niente nella risposta può diventare TwiML.
- **Chiudere**: «ciao», «grazie, ciao», «basta» chiudono la chiamata; un silenzio fa ripetere la domanda, un secondo silenzio chiude.
- **Promemoria**: al telefono `schedule_create` rifiuta, perché Owni non chiama per prima.
- **Scollegare** cancella credenziali e risposte in attesa; le chiamate che arrivano ancora vengono rifiutate senza rispondere.

## Review indipendente

Due revisori separati (standard e sicurezza, spec). Corretti:

- **Alta.** Il numero di chi chiama era l'unica prova di identità, e si può falsificare: chiunque poteva entrare nella conversazione privata di una persona in elenco e sentire le sue risposte in attesa. Ora serve il codice. Un promemoria creato al telefono veniva disattivato senza dirlo: ora Owni non lo crea e lo spiega. Con due messaggi nello stesso turno (un file e la risposta, o un avviso) le risposte slittavano di un turno: ora un file non conta come risposta e quello che era in attesa viene detto prima, come tale. Un messaggio rifiutato dal nucleo lasciava chi chiama ad aspettare un minuto e poi prometteva una risposta che non sarebbe arrivata.
- **Media.** Una risposta si perdeva se chi chiama riattaccava durante l'attesa. Le chiamate a un numero sostituito arrivavano ancora all'istanza; scollegato il numero, chi chiamava sentiva l'errore di Twilio (a pagamento). Il modello non sapeva di essere al telefono. Un turno poteva superare il limite di caratteri di `<Say>` e la voce non era impostata (le voci di base di Twilio non parlano italiano). La console trasformava `3331234567` in un numero francese. Un errore di Twilio diventava «non raggiungibile» senza log. Un silenzio chiudeva la chiamata invece di far ripetere.
- **Bassa.** La firma non reggeva parametri ripetuti e la porta 443 esplicita; un avvio di chiamata ripetuto rileggeva le risposte; le risposte in attesa di un numero che non richiama non scadevano; una risposta rimandata dopo un crash si sentiva due volte; un cambio di indirizzo pubblico non arrivava a Twilio; un percorso di file letto ad alta voce; `OWNI_PHONE_LANGUAGE` cambiava la lingua del riconoscimento ma non le frasi (tolta: al telefono Owni parla italiano); `DELETE` su un'istanza inesistente rispondeva 200.

## Limiti

| Cosa | Limite |
|---|---|
| Latenza | a turni: Twilio aspetta la fine della frase, poi Owni ragiona. Niente voce in tempo reale |
| Approvazioni | niente schede al telefono: arrivano su Telegram, WhatsApp o nella console |
| Codice | uno per istanza: chi lo conosce e falsifica il numero di un'altra persona in elenco entra nella sua conversazione |
| Lingua | solo italiano |
| Avvisi a metà chiamata | un avviso che arriva mentre Owni pensa può essere detto al posto della risposta, che arriva al turno dopo |
| File | non passano dal telefono |
| Chiamate in uscita | Owni non chiama per prima |
| Costi | minuti e numero li fattura Twilio all'owner, fuori dal tetto di spesa del modello |
| Prova dal vivo | non fatta: serve un numero Twilio italiano con il Regulatory Bundle ([chiavi.md](chiavi.md), punto 11) |
