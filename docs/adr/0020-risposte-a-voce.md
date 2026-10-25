# Risposte a voce

Chi manda un vocale a Owni su Telegram o WhatsApp di solito ha le mani occupate: in macchina, in negozio, al cantiere. Una risposta scritta lo costringe a fermarsi e leggere. Gli assistenti con cui Owni viene confrontata (Grok, ChatGPT) rispondono a voce.

## Come funziona

- **Quando**: la risposta a un messaggio vocale trascritto (trascrizione, connettore `voice`) va come vocale, seguito dal testo (didascalia su Telegram se ci sta, messaggio a parte su WhatsApp). Solo in chat private: in un gruppo un vocale non decide per tutti. Solo la risposta a quel messaggio: promemoria, task, sentinelle, approvazioni e avvisi restano scritti. Un vocale non trascritto (troppo lungo, trascrizione spenta, una canzone inoltrata) non chiede una risposta a voce.
- **Chi sceglie**: l'operatore mette il servizio (`OWNI_SPEECH_*`), l'owner lo accende per istanza (connettore `speech`, Impostazioni → Risposte a voce, nell'audit `speech.allowed`), ogni persona sceglie per sé con `voice_replies`: `auto` (vocale a un vocale, il default), `always`, `never`. La scelta sta in `voice-replies.json` dell'istanza, per chat privata.
- **Il modello lo sa**: il messaggio che avrà una risposta a voce arriva con una nota (frasi brevi, niente tabelle o link nel corpo, quanti caratteri vengono letti). Le istruzioni predefinite gli dicono di usare `voice_replies` e di non promettere vocali altrimenti.
- **Cosa si legge**: il testo senza markdown, codice e indirizzi (detti «link»). Di una risposta più lunga di `OWNI_SPEECH_MAX_CHARS` si leggono le prime frasi e il vocale finisce con «Il resto te l'ho scritto.»; il testo completo va comunque.
- **Il servizio**: qualunque servizio con l'API di OpenAI (`POST /audio/speech`, `response_format: opus`); di default OpenAI con `gpt-4o-mini-tts` e la voce `nova`. La risposta deve essere OGG Opus (controllati `OggS` e `OpusHead`), al più 5 MB letti a pezzi; 20 secondi al più, poi va il testo da solo. Gli errori del servizio finiscono nei log solo come codice di stato: alcuni servizi ripetono il testo ricevuto.
- **Mai niente al posto di niente**: servizio giù, quota del giorno finita, canale che rifiuta il vocale (Telegram per chi non accetta vocali, Meta per un audio che non prende): va il testo. Su Telegram, mentre il vocale si prepara, la chat mostra «sta registrando un audio».
- **Una volta sola**: il vocale si prova solo al primo invio della risposta. Se il canale non conferma, il nuovo tentativo manda solo il testo, così non si paga e non si sente due volte. Dopo un riavvio, le risposte ancora da mandare vanno per iscritto (quali risposte vanno a voce è tenuto in memoria).
- **Freni**: `OWNI_SPEECH_MAX_PER_DAY` vocali al giorno per tutto il server (300 di default), come la ricerca sul web.
- **Nella console**: «Ascolta» su ogni risposta, con una voce installata sul dispositivo (`localService`), frase per frase; senza una voce locale nella lingua della console il pulsante non c'è. Il testo non lascia il dispositivo e non passa dal servizio dell'operatore.

## Alternative scartate

- **Rispondere sempre a voce a chi l'ha attivato una volta, per tempo** (finestra di 30 minuti per chat): faceva leggere ad alta voce anche promemoria e approvazioni, e un vocale in un gruppo cambiava le risposte per tutti.
- **Solo il vocale, senza testo**: un indirizzo, un orario o un importo vanno ritrovati per iscritto; e chi non può ascoltare in quel momento resta senza risposta.
- **Una voce per istanza**: utile, ma è una scelta in più per l'owner; per ora una voce per server, da rivedere se lo chiedono.
- **La voce del servizio anche nella console**: costerebbe a ogni ascolto e manderebbe il testo fuori; la voce del dispositivo basta per rileggere.

## Conseguenze

- Con OpenAI il testo delle risposte da leggere va negli Stati Uniti: l'owner lo accende sapendolo (la scheda dice a chi va e cosa).
- Su WhatsApp fuori dalla finestra di 24 ore va solo il testo, in attesa come ogni altro messaggio.
- Il telefono (ADR 0012) parla già con la voce di Twilio: non usa questo servizio.
