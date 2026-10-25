# La ricerca sul web: un servizio del server, acceso dall'owner

Owni leggeva solo le pagine di cui conosceva l'indirizzo. Ora cerca: per notizie, prezzi, orari e fatti che cambiano chiede a un servizio di ricerca e apre i risultati migliori.

## Come funziona

- **Un servizio per server**: Brave Search, con la chiave dell'operatore in `OWNI_SEARCH_API_KEY`. In Owni Cloud la chiave sta sul control plane e passa alle celle come quella della trascrizione dei vocali.
- **Acceso istanza per istanza** dall'owner (connettore `web_search` nella egress policy, Impostazioni → Ricerca sul web), spento di default, cambio registrato nell'audit. Fuori dalla chat del brief del mattino, come gli altri strumenti web: lì si leggono mail di chiunque, e una mail non deve poter far cercare niente.
- **Cosa esce**: solo le parole cercate, con paese e lingua (Italia e italiano di default, `OWNI_SEARCH_COUNTRY` e `OWNI_SEARCH_LANG`; il modello può chiedere un altro paese). Nell'audit `web_search.ran` dice quanti risultati, mai cosa si è cercato.
- **Cosa torna al modello**: la data e l'ora della ricerca nel fuso dell'istanza, poi titoli, indirizzi, estratti ed età delle pagine, marcati come dati dal web. Fuori da quella recinzione, quali risultati `web_read` può aprire: un risultato non può dire di sé che è apribile.
- **Aprire i risultati** resta un permesso a parte: i siti consentiti (ADR 0009). Senza, il modello risponde con gli estratti e cita gli indirizzi; la scheda della ricerca ha un pulsante, con conferma, per consentire tutti i siti pubblici.
- **Tetti**: 200 ricerche al giorno per account (`OWNI_SEARCH_MAX_PER_DAY`), contate dal processo; una risposta oltre 1 MB è rifiutata; 15 secondi al più.

## Alternative scartate

- **La ricerca del provider del modello** (lo strumento di ricerca di Anthropic o di OpenAI): legherebbe la funzione a un provider, e Owni sceglie il modello per istanza. Un servizio nostro vale per tutti, anche per il modello locale di sviluppo nei test.
- **Cercare con il browser su un motore** (aprire la pagina dei risultati): fragile, contro le condizioni d'uso dei motori, e lento.
- **Una chiave per tenant**: ogni cliente dovrebbe aprire un account Brave. Il costo per ricerca è piccolo e il tetto giornaliero lo contiene.
- **Contare le ricerche nel tetto di spesa del modello**: il tetto misura token; le ricerche hanno un loro tetto in numero. Da rivedere quando ci sarà un prezzo per il consumo.

## Conseguenze

- Una pagina letta con istruzioni nascoste potrebbe spingere Owni a mettere un dato in una ricerca: arriverebbe al servizio di ricerca, non a chi ha scritto la pagina. Il rischio resta basso, ed è il motivo per cui la ricerca è spenta di default e assente dal brief.
- Brave è un servizio statunitense: le parole cercate escono dall'UE. Va detto nell'informativa ai clienti.
- Il conto giornaliero riparte a ogni riavvio del processo: è un freno contro i cicli, non un contatore di fatturazione.
