# Settimana 14: Owni capisce i vocali

Branch `week-14`. Fase 4 del [piano](piano-cloud.md) (voce, primo passo).

## Cosa funziona (verificato dai test, con un finto servizio di trascrizione)

- **Vocali di Telegram e WhatsApp** (`test/voice.test.ts`): il vocale di una persona che può scrivere viene scaricato, mandato al servizio di trascrizione e arriva a Owni come testo, «[Messaggio vocale, trascritto] …». Su Telegram valgono anche i file audio.
- **Servizio scelto dall'operatore**: qualunque servizio con l'API di trascrizione di OpenAI. Il consigliato è Mistral (Voxtral, server in UE), che è anche il modello predefinito quando l'indirizzo è il suo. Senza configurazione Owni riceve una nota e chiede di scrivere.
- **Consenso per istanza**: l'owner accende la trascrizione in Impostazioni → Messaggi vocali (connettore `voice` nella egress policy, nell'audit). Spenta, l'audio non esce e Owni chiede di scrivere.
- **Privacy**: il vocale di un estraneo non viene scaricato né trascritto; l'audio va solo al servizio configurato; la chiave non compare nei log, nemmeno se il servizio la ripete nel suo errore.
- **Limiti**: su Telegram un vocale oltre `OWNI_TRANSCRIBE_MAX_SECONDS` (300 di default) non viene nemmeno scaricato; oltre 20 MB, su entrambi i canali, arriva una nota. Un servizio che fallisce o non riconosce parole produce una nota chiara, mai testo inventato. I file audio mantengono il loro formato (mp3, m4a, …) anche nel nome.
- **`pnpm owni check`** controlla chiave e modello del servizio.
- **Owni Cloud**: le variabili del control plane passano a tutte le celle.

## Review indipendente

Un revisore su due assi (standard e sicurezza, aderenza). Corretti:

- **Media.** Su Telegram un audio oltre 20 MB faceva fallire l'aggiornamento tre volte e poi spariva senza risposta: ora arriva una nota. La trascrizione usciva senza passare dalla egress policy dell'istanza: ora è un connettore che l'owner consente. I file audio partivano sempre come `.ogg`, e alcuni servizi leggono il formato dal nome. Su WhatsApp un errore temporaneo di Meta diventava «non disponibile» invece di un nuovo tentativo.
- **Bassa.** La durata su Telegram si controllava dopo il download; il dettaglio degli errori di Mistral si perdeva; documenti con limiti imprecisi.
- **Lasciato, con motivo.** I webhook aspettano la trascrizione prima di rispondere (fino a 45 secondi): rispondere subito e trascrivere dopo rischierebbe di perdere il vocale se il processo si ferma. Una consegna ripetuta viene comunque scartata dal core.

## Limiti

| Cosa | Limite |
|---|---|
| Prova dal vivo | solo contro un finto servizio: serve una chiave Mistral (docs/chiavi.md, punto 10) |
| Costo | la trascrizione non entra nel tetto di spesa del modello |
| Durata su WhatsApp | WhatsApp non dice quanto dura un vocale: vale solo il limite di 20 MB del download |
| Tempi | il webhook risponde dopo la trascrizione: un servizio lento può far riconsegnare il messaggio (scartato come doppione, ma trascritto di nuovo) |
| Errori temporanei | se il servizio non risponde il vocale non viene ritentato: Owni chiede alla persona di riprovare |
| Chiamate vocali | non ancora: Owni risponde per iscritto |
