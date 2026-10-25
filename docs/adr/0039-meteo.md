# Meteo: adesso, stasera e i prossimi giorni

Chi usa un assistente ogni giorno gli chiede che tempo fa: «piove stasera a Milano?», «che tempo fa nel weekend a Torino?», «serve l'ombrello domani?». Grok risponde con dati del momento. Owni poteva solo cercare sul web e riassumere una pagina di previsioni, quando la ricerca era accesa: lento, impreciso, e spesso con la pagina di un'altra città.

## Decisione

Un tool, `weather`, su Open-Meteo, in due passi: cerca il posto (geocoding, in italiano), poi chiede le previsioni nel fuso del posto. La risposta ha:

- il posto;
- l'ora locale;
- le condizioni di adesso (temperatura, percepita se diversa di 2 °C o più, umidità, vento e raffiche, precipitazioni);
- per oggi e domani, le fasce (notte, mattina, pomeriggio, sera), così «stasera» ha una risposta;
- una riga per giorno, fino a 16 giorni compreso oggi, con le righe oltre la settimana segnate «(tendenza)».

Numeri con la virgola, gradi interi per minime e massime, codici WMO in parole italiane.

- **Quale posto.**
  - Dopo una virgola si può dare la provincia, la regione, il paese o la sigla di uno stato americano («Paris, TX»).
  - Dopo una virgola valgono anche le sigle delle province («Ciampino, RM»), prima dei codici dei paesi.
  - Senza indicazioni vince un posto in Italia, se non è dieci volte più piccolo del più grande all'estero («Nizza» è Nice, con Nizza Monferrato tra le alternative); poi il più popoloso.
  - Le alternative si dicono solo se la scelta è incerta (popolazioni vicine o sconosciute).
  - Un'indicazione che non corrisponde a niente non dà le previsioni di un altro posto: Owni elenca i candidati e chiede.
- **Acceso dall'operatore.** `OWNI_WEATHER=1` lo accende per tutto il server; senza, il tool non c'è. Non c'è un interruttore per istanza come per la ricerca sul web: al servizio vanno solo il nome di un posto e le sue coordinate, e l'interruttore richiederebbe la console, che segue un altro filone di lavoro. Se servirà, sarà un connettore come `web_search`.
- **Brief del mattino.** Se Owni sa in che città vive la persona, il meteo di oggi in una riga.
- **Codice condiviso.**
  - La lettura JSON con tempo massimo, limite di dimensione ed errori senza indirizzi è in `src/core/http.ts`, usata anche dalla ricerca sul web.
  - Il recinto per i dati da fuori è in `src/core/untrusted.ts`, uno solo per pagine, ricerche, sentinelle e meteo.
  - Gli indirizzi dei servizi in configurazione passano tutti da `serviceUrl`, che rifiuta credenziali, query e porte non valide.

## Limiti

- Al più `OWNI_WEATHER_MAX_PER_DAY` chiamate riuscite per account al giorno (200 di default; ognuna sono 2 richieste al servizio), e al più il triplo di tentativi, riusciti o no: un modello che ripete la chiamata non consuma il piano gratuito, che è di tutto il server.
- Risposte di 1 MB al più, 15 secondi.
- Il nome del posto è lungo da 2 a 100 caratteri.

## Sicurezza

- I nomi dei posti vengono dal servizio: stanno nel recinto, come dati. Fuori ci sono solo numeri e parole calcolate da Owni.
- La chiave, se c'è, non compare mai in errori, log, audit o risposte. Gli errori di rete diventano frasi fisse.
- La quota si spende solo per una risposta riuscita; un nome vuoto non tocca il servizio; dopo un riavvio la risposta salvata non rifà la chiamata.
- L'audit registra `weather.ran` con il numero di giorni, mai il posto.
- Nella chat del brief, che legge le mail, `weather` è consentito: manda solo il nome di un posto al servizio meteo scelto dall'operatore, che chi scrive una mail non può leggere.

## Condizioni d'uso

Open-Meteo è gratuito solo per uso privato o non commerciale, con i dati sotto CC BY 4.0: Owni cita la fonte. A un'azienda, anche in self-host, serve un piano a pagamento: con `OWNI_WEATHER_API_KEY` le previsioni vanno a `customer-api.open-meteo.com` e l'indirizzo di ricerca dei posti dato da Open-Meteo è obbligatorio. I server sono in Europa e Nord America. Le istruzioni sono in [chiavi.md](../chiavi.md), punto 16.

## Alternative scartate

- **Ricerca sul web e lettura di un sito meteo**: lenta, dipende dalla pagina e dalla ricerca accesa, e i siti cambiano.
- **Un servizio con chiave obbligatoria** (OpenWeatherMap, Tomorrow.io): Open-Meteo si prova senza chiave e ha un piano commerciale con gli stessi indirizzi.
- **Allerte meteo**: Open-Meteo non le ha; per un'allerta Owni cerca sui siti della Protezione Civile e delle regioni, se la ricerca è accesa.
