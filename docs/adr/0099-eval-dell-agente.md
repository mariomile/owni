# L'eval dell'agente: il primo strumento giusto, ogni notte

La segreteria aveva i suoi eval (classificazione, estrazione, bozze). L'agente generale no: un prompt cambiato, uno strumento rinominato o un modello nuovo potevano fargli sbagliare strumento senza che nessuno se ne accorgesse, fino alla persona che lo usa.

## Decisione

- **I casi** sono in `evals/agente/cases.jsonl`: una richiesta in italiano per riga, come la scriverebbe una persona, con gli strumenti accettabili come prima chiamata. `expect: []` vuol dire che la risposta giusta non usa strumenti (un saluto, una mail da scrivere).
- **In ogni PR** (`pnpm eval:agente`, deterministico, senza chiavi): Owni si avvia con il modello di prova e si controlla che ogni strumento atteso esista davvero tra quelli che l'agente riceve. Uno strumento rinominato o tolto rende rossa la CI invece di falsare la misura della notte.
- **Ogni notte** (`pnpm eval:agente:real`, con `OWNI_JUDGE_MODEL_KEY`): Owni si avvia come con `pnpm start`, in una cartella temporanea, con il modello vero. Ogni caso è una chat web nuova con un messaggio. Cosa ha chiamato il turno si legge dal record del turno nel registro dei costi (ADR 0098), non dal testo della risposta.
- **La misura**: la quota di casi in cui il primo strumento è uno di quelli accettati, con soglia 0,8, e quanto è costata la corsa. Il rapporto va in `evals/agente/last-report/agente.json`, caricato come artifact. Sotto la soglia il job è rosso.
- Senza chiave lo script dice che salta ed esce 0, come il giudice della segreteria.

## Conseguenze

- Si misura la scelta dello strumento, non la qualità della risposta: un giudice sulle risposte si aggiunge sopra questo, quando servirà.
- Gli strumenti che scrivono (spese, clienti, promemoria) scrivono nella cartella temporanea, che si butta. I casi evitano strumenti che mandano messaggi fuori.
- Una corsa costa qualche dollaro a listino: circa trenta turni con tutto il catalogo degli strumenti nel prompt. Il rapporto lo scrive ogni notte.
- Ogni caso nuovo si aggiunge con una riga; la CI controlla che gli strumenti che nomina esistano.
