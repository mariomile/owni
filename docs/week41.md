# Settimana 41: meteo

Branch `week-41`. «Che tempo fa?» è una delle domande più fatte a un assistente, e Owni non sapeva rispondere senza cercare sul web. Ora ha `weather`: condizioni di adesso, le fasce di oggi e domani («stasera», «domani mattina») e le previsioni fino a 16 giorni, su Open-Meteo. Come funziona, i limiti, le condizioni d'uso e le alternative scartate sono nell'[ADR 0039](adr/0039-meteo.md).

## Cosa cambia per chi usa Owni

- **«Piove stasera a Milano?»**: la fascia della sera con la probabilità di precipitazioni e i millimetri.
- **«Che tempo fa nel weekend a Torino?»**: sabato e domenica, non tutta la settimana.
- **«Che tempo fa a Paris, Texas?»**: il posto giusto; «Roma» è la Roma italiana, senza alternative inutili; per «Springfield» Owni dice quale ha preso e quali altre ci sono.
- **«Fra venti giorni?»**: Owni dice che le previsioni arrivano a quindici giorni da oggi, e oltre la settimana sono una tendenza.
- **Il brief del mattino**, se Owni sa in che città vive la persona, dice il meteo di oggi.

## Cosa funziona (verificato dai test)

- Richieste al servizio: parametri, fuso del posto, chiave solo se c'è e mai negli errori (`test/weather.test.ts`).
- Scelta del posto: provincia, regione e sigla della provincia («Ciampino, RM», «Frosinone, FR») dopo la virgola, sigle degli stati americani anche con i nomi in italiano, «IT» che non trova «Stati Uniti», preferenza per l'Italia ma non per un paese dieci volte più piccolo («Nizza» è Nice), alternative solo se incerte, popolazioni pari o sconosciute, nessun posto con un'indicazione sbagliata.
- Risposta: virgola nei decimali, giorni della settimana, «1º», percepita solo se diversa, fasce di oggi e domani nel fuso del posto, «(tendenza)», niente «0 mm».
- Errori: 401 e 403 con e senza chiave, 429, 5xx, risposta illeggibile o troppo grande, tempo scaduto, date impossibili.
- Quota spesa solo per le risposte riuscite, mai per un nome vuoto, un posto non trovato, un errore o un riavvio; i tentativi, anche falliti, hanno un tetto a parte.
- Recinto: un nome di posto ostile, con finti segni di recinto, a capo e «ignora le istruzioni», resta dentro.
- Configurazione: acceso, spento, indirizzi non validi (porta, credenziali, query), limite giornaliero; `pnpm owni check` prova il servizio.

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso, con domande vere provate sul codice. Corretti:

- **Alta (uso).**
  - «Paris, TX» dava le previsioni di Parigi senza dirlo.
  - «Roma» e «Milano» avrebbero citato le omonime del Texas.
  - «Il più popoloso» compariva anche a popolazioni sconosciute.
  - «Stasera» non aveva risposta, perché c'erano solo i totali del giorno.
  - Le condizioni d'uso di Open-Meteo erano descritte male: è gratuito solo per uso non commerciale, e ha server anche in Nord America.
- **Media (sicurezza).**
  - La quota si spendeva anche per gli errori.
  - Gli indirizzi dei servizi accettavano porte non valide, credenziali e query.
  - Il codice per leggere JSON e il recinto erano copiati in tre posti: ora sono moduli condivisi, usati anche dalla ricerca sul web e dalle sentinelle.
- **Media (uso).**
  - «pioggia 85%» era ambiguo: ora è «probabilità di precipitazioni».
  - Le istruzioni annunciavano il meteo anche dove non c'è.
  - Il brief chiedeva tre giorni per una riga.
  - Il limite dei 16 giorni era detto male.
- **Bassa.** «ore … ora locale», «(IT)» ripetuto, decimali inutili nelle minime e massime, la data impossibile che faceva cadere la risposta, il messaggio della chiave quando la chiave non c'è.

Una seconda revisione sulle correzioni ha trovato, ed è corretto: i tentativi falliti non avevano limite e potevano consumare il piano gratuito di tutto il server; la preferenza per l'Italia nascondeva città grandi all'estero («Nizza»); le sigle delle province («RM», «FR») non funzionavano o finivano su un paese; «Roma» citava una frazione omonima; con una chiave a pagamento le richieste andavano agli indirizzi gratuiti; la notte dopo la sera si chiamava «domani notte»; «probabilità di pioggia» anche con la neve.
