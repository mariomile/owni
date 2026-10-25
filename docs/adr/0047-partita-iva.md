# Partita IVA: controllo formale e VIES

Una piccola impresa fattura tutto il giorno. «Questa partita IVA è valida?», «di chi è la P.IVA IT…?», «il codice fiscale del cliente è scritto giusto?». Il modello non sa controllare una cifra di controllo a occhio, e non sa se un numero è attivo.

## Decisione

Un tool, `vat_check`, con due livelli.

- **Controllo formale, sempre acceso, senza rete** (`src/core/tax-ids.ts`, funzioni pure):
  - partita IVA italiana: 11 cifre, cifra di controllo, codice dell'ufficio IVA (001–100, 120, 121, 888, 999), matricola non tutta a zero;
  - numeri che cominciano con 8 o 9: codici fiscali numerici di enti senza partita IVA (associazioni, enti non commerciali, enti pubblici), detti come tali e mai mandati al VIES;
  - codice fiscale: forma, omocodia (lettere al posto delle cifre, da destra), mese, giorno (più 40 per le donne), carattere di controllo; sesso e data di nascita, con il secolo detto in due modi quando è ambiguo, senza tabella dei comuni;
  - numeri IVA europei: la forma di ciascun paese del VIES (EL per la Grecia, XI per l'Irlanda del Nord); Regno Unito, Svizzera, Norvegia e San Marino fuori dal VIES, detto in chiaro;
  - etichette e separatori tolti («P.IVA:», «CF», spazi, punti, trattini).
- **Controllo nel VIES della Commissione europea, acceso dall'operatore** con `OWNI_VAT_CHECK=1` (`src/core/vies.ts`): attiva o no, con nome e indirizzo quando il paese li dà, e l'ora del controllo, utile come prova per una fattura intra-UE.
- **«Non attiva nel VIES» non vuol dire inesistente.** Molte partite IVA italiane valide non sono abilitate agli scambi intra-UE: Owni lo dice e rimanda a «Verifica partita IVA» sul sito dell'Agenzia delle Entrate. Un errore del VIES non diventa mai un «valida» o un «non valida».
- **Il tool c'è sempre**, anche senza VIES: un numero sbagliato merita una risposta precisa, e il controllo formale non manda niente fuori. Le istruzioni dicono di usare `vat_check` e non `web_search`, e di non cercare il titolare sul web.
- **Nel brief** il tool fa solo il controllo formale: un numero letto in una mail non va al VIES e non consuma la quota.

## Limiti

- Al VIES: 200 controlli al giorno per account (`OWNI_VAT_CHECK_MAX_PER_DAY`) e 2000 per server (`OWNI_VAT_CHECK_MAX_PER_DAY_SERVER`), perché il VIES blocca gli indirizzi che chiedono troppo. Le risposte dalla cache non contano.
- Cache per account: un'ora per una risposta, due minuti per un errore temporaneo, al più 2000 numeri.
- 10 secondi e 64 KB per risposta, nessun rimando seguito.

## Sicurezza

- Il numero va al VIES solo dopo il controllo formale, normalizzato a lettere e cifre e codificato in un solo segmento dell'indirizzo.
- Nome e indirizzo restituiti dal VIES sono dati dall'esterno, dentro il recinto. Il recinto ora neutralizza nel contenuto le sequenze che imitano i suoi segni di apertura e chiusura, per tutti gli strumenti (anche mail e computer); il codice con `>>>` o `<<<` resta com'è.
- Un codice d'errore sconosciuto non si ripete in chat.
- La cache è per account: un altro cliente dello stesso server non vede quando un numero è stato controllato.
- Nessun audit e nessun log con il numero: non cambia niente, come meteo e cambi.

## Alternative scartate

- **Registro delle imprese o servizi commerciali** (nome, PEC, stato): a pagamento o con accesso riservato.
- **Il servizio dell'Agenzia delle Entrate**: non ha un'API pubblica senza credenziali; Owni ci rimanda la persona.
- **Il VIES nel brief e nella segreteria**: i numeri arrivano da mail di terzi; il controllo formale basta e non spende la quota.
