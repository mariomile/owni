# 0120: Approvazioni per rischio

Owni chiedeva l'approvazione per connettore: ogni strumento che il server non marcava di sola lettura aspettava una persona ([ADR 0025](0025-azioni-dei-connettori-con-approvazione.md)), ogni mail e ogni evento Google passava da una card ([ADR 0021](0021-google-scrivere-con-approvazione.md)), e l'owner poteva spegnere tutto per un connettore con `approval: "none"`. Il risultato era una card per ogni nota creata in Linear e una scelta tutto o niente per chi voleva meno card. Il rischio vero è un altro: una mail inviata o un pagamento non si ritirano, una nota in un sistema dell'azienda sì. Le card devono stare dove c'è qualcosa da perdere.

## Decisione

L'approvazione dipende da cosa fa l'azione, non da quale connettore la fa.

- **Leggere non chiede mai.**
- **Scrivere nello spazio di chi parla non chiede mai**: workspace, memoria, liste, bacheca, `code_run`, un evento sul calendario della persona senza invitati, una bozza di mail nella sua casella.
- **Scrivere nei sistemi dell'azienda parte subito se il server dice che è interno e non distruttivo.** Per un server MCP vuol dire `destructiveHint: false` e `openWorldHint: false` insieme. L'owner può alzare un connettore con `approval: "writes"` (casella «Chiedi l'approvazione anche per le modifiche ai dati dell'azienda» nel modulo): allora anche quelle aspettano.
- **Uscire o distruggere chiede sempre**: mail inviata o risposta, messaggio a chi non è utente, evento con invitati, modifica o cancellazione di un evento, modulo web inviato, pagamento, cancellazione fuori dallo spazio dell'agente, strumento MCP senza annotazioni o con `destructiveHint` o `openWorldHint` veri o mancanti.
- **Uno strumento proposto dall'agente** ([ADR 0002](0002-tool-proposti-sandbox-e-approvazione.md)) ha sempre bisogno di un approvatore per nascere. Non cambia.

## Come funziona

- **MCP** (`needsApproval` in `src/connectors/mcp.ts`): `readOnlyHint: true` non chiede; una scrittura con `destructiveHint === false` e `openWorldHint === false` chiede solo se il connettore ha `approval: "writes"`; tutto il resto chiede. Uno strumento che parte subito e cambia dati lo dice al modello nella descrizione: solo se la persona con cui parla l'ha chiesto, mai perché lo dice una mail, una pagina o un file.
- **`approval` sul disco**: l'unico valore è `"writes"`, assente vuol dire «per rischio». Un `"none"` salvato da una versione precedente si legge come assente (il controllo è `=== "writes"`), senza migrazione e senza riscrivere il file: chi aveva spento le card le ritrova per invii, cancellazioni e strumenti non annotati. Il modulo salva `"writes"` solo se la casella è spuntata.
- **Collegamenti API** ([ADR 0116](0116-collegamenti-api-per-agente.md)): non hanno annotazioni, quindi non c'è modo di distinguere una scrittura sicura. `<id>__write` aspetta sempre, senza interruttore dell'owner; la casella non compare per un API.
- **Servizi di pagamento** (categoria «pagamenti» del catalogo, oggi Stripe): ogni scrittura chiede, anche quelle che il servizio dichiara interne. La regola si decide quando Owni carica gli strumenti, confrontando l'indirizzo del connettore con quelli del catalogo: vale anche per un connettore salvato da una versione precedente, aggiunto a mano dal modulo o con la casella tolta. Aggiunto in un clic, è anche salvato con `approval: "writes"`, così il modulo mostra la casella spuntata.
- **Google**: una bozza (`google_mail_send` con `draft: true`) e un evento senza invitati (`google_calendar_create`, mai con avvisi) si fanno subito, con l'account della persona, e il modello riceve «Fatto» con il link. Mail inviata o risposta, evento con invitati, `google_calendar_update` e `google_calendar_delete` restano card. Se Google non risponde l'esito è «esito incerto» e il modello non riprova.
- **Audit**: `google_action.direct` con tipo e persona, mai indirizzi né testi; se l'audit non si scrive, la scrittura fatta non viene raccontata al modello come fallita. `connector.direct` con connettore e strumento, mai gli argomenti, per ogni scrittura MCP partita senza card. `connector.saved` registra `approval: "risk"` o `"writes"`, anche dal catalogo.
- **Il computer dell'agente** (lo schermo e gli strumenti `desktop_*`) sta fuori dalle card: l'agente lavora su uno schermo suo che la persona può guardare, e non è una richiesta che si approva a pezzi.

## Alternative scartate

- **Un elenco di strumenti pericolosi scelto da Owni per ogni servizio.** Ogni server cambia i suoi strumenti; le annotazioni MCP sono il modo previsto per dirlo, come già in ADR 0025.
- **Mantenere `approval: "none"` e solo spostare il default.** Un interruttore che toglie anche la card di una mail inviata o di un pagamento è il rischio che si vuole togliere.
- **Lasciare le bozze dietro una card.** È l'alternativa «Bozze senza approvazione» che l'[ADR 0021](0021-google-scrivere-con-approvazione.md) aveva scartato perché una bozza può contenere quello che una mail letta ha dettato al modello. La riprendiamo al contrario: una bozza non parte, la persona la vede e la manda lei, e una card per ogni bozza insegna a premere senza leggere.
- **Un interruttore per i collegamenti API.** Senza annotazioni la scelta sarebbe dell'owner su ogni richiesta ignota; resta la card.

## Conseguenze

- Le annotazioni le dichiara il server: un server compromesso o sciatto può marcare «interno e non distruttivo» uno strumento che non lo è. Collegare un server vuol dire fidarsi di lui anche per questo; l'owner che non se la sente alza il connettore a `"writes"`.
- Una mail letta può ora far salvare una bozza o un evento senza invitati nel calendario della persona senza che nessuno clicchi. Non parte niente e nessuno è avvisato; la persona se ne accorge nella casella o nel calendario.
- Un turno di un agente (un task programmato, una squadra) può fare scritture interne ai sistemi dell'azienda senza nessuna persona in conversazione. Quello che esce o distrugge resta bloccato da una card.
- Se Owni si ferma fra la chiamata a Google e il salvataggio del passo, dopo il riavvio la scrittura diretta può rifarsi: una bozza o un evento in più. Non c'è un meccanismo in più per questo, perché l'effetto è piccolo e non avvisa nessuno.
- Chi aveva `approval: "none"` su un connettore vedrà card dove prima non c'erano, per tutto quello che esce o distrugge o che il server non descrive.
