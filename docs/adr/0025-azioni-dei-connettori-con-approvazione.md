# Azioni dei connettori con approvazione

Con i connettori in un clic (ADR 0024) Owni può creare issue su Linear, pagine su Notion, link di pagamento e rimborsi su Stripe. Fino alla settimana 29 lo faceva appena il modello lo decideva. Per un titolare è il rischio più grosso di tutto il prodotto: un'istruzione nascosta in una pagina letta, o un equivoco, diventa un'azione su un servizio vero.

## Come funziona

- **Quali strumenti aspettano**: quelli che il server MCP non marca `readOnlyHint: true`. È il valore predefinito di ogni connettore (`approval: "writes"`), anche di quelli del catalogo. L'owner può metterlo a `"none"` per un connettore (casella nel modulo): allora tutti gli strumenti partono subito.
- **Cosa vede il modello**: lo stesso strumento, con un parametro in più, `owni_reason`, una frase in italiano per chi approva (se lo strumento ha già un argomento con quel nome, quello di Owni si chiama `owni_reason_owni`). Chiamarlo non fa niente sul servizio: crea una richiesta e risponde dove si decide, che scade in 24 ore e che non va richiamato.
- **La richiesta** (`src/core/connector-actions.ts`, sulla coda di `action-queue.ts`, come moduli e Google): connettore, server (URL o comando), strumento, titolo, argomenti, i valori come li legge una persona, motivo, chi l'ha chiesta. L'ID viene dalla chiamata: rieseguire lo stesso turno ritrova la stessa richiesta, e una richiesta già decisa non viene riannunciata.
- **Chi approva vede tutto**: niente valori tagliati. Un valore oltre 5.000 caratteri o più di 50 dati sono rifiutati; nomi con a capo o caratteri di controllo pure; motivo e titolo sono messi su una riga e accorciati. Il nome vero dello strumento sta sempre accanto al titolo che dà il servizio.
- **Chi decide**: la persona della conversazione privata che l'ha chiesta, finché può scrivere a Owni, o un approvatore dell'istanza (owner incluso). Dalla console (Approvazioni, e sopra la chat web da cui è partita) e dai pulsanti su Telegram e WhatsApp. Una card che non sta in chat ha solo «Rifiuta» e rimanda alla console.
- **L'esecuzione**: una volta, sulla connessione aperta, solo se il connettore è ancora consentito dalla egress policy e punta allo stesso server. «In corso» è scritto prima della chiamata. Un errore prima che parta è «non fatta»; dopo che è partita, senza risposta, «esito incerto», mai rifatta. Una risposta con `isError` è «non fatta».
- **L'esito**: alla conversazione come notizia, con la risposta del servizio recintata come dati e senza titoli scritti dal servizio fuori dal recinto; dice se ha deciso la persona o un approvatore e cosa non fare dopo.
- **Audit**: `connector_action.approved`, `.done`, `.failed`, `.uncertain`, `.rejected`, `user.denied`; connettore, strumento e chi ha deciso. Mai argomenti, motivo o risposta.

## Alternative scartate

- **Elenco fisso di strumenti pericolosi per servizio.** Ogni server cambia i suoi strumenti; le annotazioni MCP sono il modo previsto per dirlo.
- **Approvare il connettore una volta per tutte.** È quello che c'era: non protegge da un'istruzione nascosta in una pagina letta un minuto prima.
- **Chiedere conferma in chat al modello.** Il modello può essere ingannato; la conferma deve essere un pulsante premuto da una persona sulla richiesta esatta.

## Conseguenze

- `readOnlyHint` lo dichiara il server: un server compromesso può marcare come lettura uno strumento che scrive. Collegare un server vuol dire fidarsi di lui per questo; una lista di strumenti scelta dall'owner è un passo successivo.
- Un server che non annota i suoi strumenti chiede l'approvazione anche per leggere. Il modulo del connettore lo dice; l'owner può spegnere l'approvazione per quel servizio.
- Una richiesta che scade viene annunciata una volta alla conversazione che l'ha chiesta (settimana 31, [week31.md](../week31.md)); le card già mandate agli approvatori su Telegram e WhatsApp restano com'erano, e un tocco risponde «scaduta».
- Un errore dal servizio è «non fatta», anche se alcuni servizi possono aver fatto una parte.
- Con molte richieste nello stesso istante il limite di 20 in attesa può essere superato di poco, come per i moduli.
- Chi chiede da Telegram o WhatsApp non entra nella console come quella persona: una richiesta lunga la approva un approvatore.
