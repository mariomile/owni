# Immagini su richiesta

Fino alla settimana 27 Owni vedeva le foto ma non ne creava: chi le chiedeva un logo, un volantino o di ritoccare una foto riceveva una descrizione. Gli assistenti con cui Owni viene confrontata creano e modificano immagini in chat.

## Come funziona

- **Il servizio** lo sceglie l'operatore: qualunque API come quella di OpenAI (`POST /images/generations`, `/images/edits`), con `OWNI_IMAGE_URL`, `OWNI_IMAGE_API_KEY` e `OWNI_IMAGE_MODEL` (`gpt-image-1` per OpenAI). L'owner lo consente istanza per istanza (connettore `image_generation`), come voce e ricerca. Al servizio vanno la descrizione e, per un ritocco, la foto; nient'altro.
- **Il tool** `image_generate`: descrizione (in inglese, con il testo da mostrare tra virgolette così come la persona l'ha scritto), forma (quadrata, verticale, orizzontale; un ritocco senza forma tiene le proporzioni della foto), da 1 a 4 varianti, sfondo trasparente, qualità, una didascalia. `from` è il percorso di una foto del workspace: quelle mandate in chat sono in `uploads/` e il modello ne conosce il percorso; quelle fatte da Owni in `immagini/`, così «più blu» ritocca l'ultima invece di ricominciare.
- **Il risultato**: le immagini si salvano in `immagini/` e vanno nella conversazione con la didascalia; il modello riceve i percorsi, non le immagini (può guardarle con `image_view`). Nella console si vedono nel messaggio; su Telegram e WhatsApp un JPEG o PNG arriva come foto, e se l'app non lo prende come foto (troppo lungo, troppo grande) come documento. Vale per tutte le immagini che Owni manda, screenshot compresi.
- **Il conto**: al massimo `OWNI_IMAGE_MAX_PER_DAY` immagini al giorno per account, contate nel processo. Contano solo le immagini fatte: un rifiuto del servizio, un errore o un tempo scaduto non consumano. Varianti oltre quelle rimaste sono rifiutate prima di chiedere.
- **Una volta sola, quasi**: creare e salvare è un passo durevole: rieseguito dopo che è stato registrato, ritrova le immagini. Se il processo muore mentre il servizio lavora, la richiesta riparte (al più una volta in più, pagata). L'invio di ogni immagine ha la sua chiave nell'outbox.
- **Errori** in parole che il modello può usare: limiti sui contenuti (con cosa fare), richiesta non accettata, chiave rifiutata, troppe richieste, nessuna risposta in due minuti. Mai il messaggio del servizio, che può ripetere la descrizione, e mai la chiave. Un link al posto dei byte non si segue.
- **DALL·E 3** fa un'immagine per richiesta (le varianti sono richieste in parallelo), non ritocca e non fa sfondi trasparenti: Owni lo dice prima di chiedere.
- **Audit**: `images.allowed` quando l'owner lo cambia, `image.generated` con il numero di immagini e se era un ritocco. Mai la descrizione.

## Alternative scartate

- **Un modello di immagini scelto da Owni.** L'operatore paga e sceglie dove vanno i dati, come per voce e trascrizione.
- **Mostrare l'immagine al modello dopo averla fatta.** Costa una lettura d'immagine a ogni richiesta; il modello la guarda solo quando serve, con `image_view`.
- **Foto solo per le immagini create.** Una foto in chat si vede subito; chi vuole il file originale lo trova nella console. Il documento resta per tutto il resto e quando l'app rifiuta la foto.
- **Contare prima di chiedere.** Un rifiuto per i contenuti consumerebbe un'immagine della giornata senza dare niente.

## Conseguenze

- Su Telegram e WhatsApp una foto è compressa dall'app e perde il nome del file.
- Un ritocco con più foto insieme («metti il logo su questa maglietta») non c'è: `from` è una foto sola.
- Il conto del giorno riparte a ogni riavvio, come quello delle ricerche e dei vocali; due richieste nello stesso istante possono superarlo di poco.
