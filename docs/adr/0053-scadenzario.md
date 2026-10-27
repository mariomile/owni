# Scadenzario delle fatture

> Anche `date_calc`, citato qui, non c'è più ([ADR 0127](0127-niente-squadre-pronte-ne-strumenti-per-cose-che-l-agente-fa-gia.md)).

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `invoices` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Dalla settimana 47 Owni legge una fattura elettronica alla volta. Chi ha un'impresa però chiede altro: «quali fatture devo pagare questa settimana?», «cosa è scaduto?», «quanto devo ad Alfa?», «segna pagata la 153 di Alfa», «ricordami le scadenze ogni lunedì». Rispondere leggendo i file uno per uno con `file_search` è lento e porta a sommare a mente.

## Decisione

- **Uno strumento, `invoices`**, sulle fatture FatturaPA del workspace (`.xml`, `.xml.p7m`, semplificate). Operazioni: `due` (rate aperte per data: oggi, settimana, mese, scadute, prossimi giorni, un mese o un intervallo, da pagare o da incassare), `by_party` (aperto e pagato per fornitore o cliente), `list`, `mark_paid` / `mark_unpaid`, `set_company`.
- **Un solo parser**: `fattura-pa.ts` produce un oggetto tipizzato (`Fattura`), e il riepilogo testuale della settimana 47 si costruisce dallo stesso oggetto.
- **Da che parte sta chi chiede.** Con la partita IVA o il nome dell'azienda salvati (`set_company`, controllati senza rete) ogni rata è «da pagare a…» o «da incassare da…». Senza, le fatture sono indicate per fornitore e cliente e i totali restano separati per direzione: pagare e incassare non si sommano mai. Se una partita IVA compare in tutte le fatture, Owni chiede una volta se è quella dell'azienda; non lo decide da sola.
- **Le note di credito** si tolgono dal dovuto verso la loro controparte, mai sotto zero e mai due volte: ogni controparte è scalata da sola e i totali sono la somma dei risultati, così la nota di un fornitore non abbassa il debito verso un altro. Il totale dice quanto è stato scalato davvero e quanto resta «da scalare». Nelle finestre di date le note sono elencate una volta, senza sottrarle.
- **Scadenze**: vale la data scritta in fattura; una rata che cade di sabato, domenica o festivo è in ritardo solo dopo il primo giorno lavorativo, con la stessa frase di `date_calc`. Un mese o un giorno senza anno è quello più vicino a oggi (anno scorso, quest'anno o il prossimo; a pari distanza vince il futuro), così «dicembre» a ottobre è il dicembre che arriva e a gennaio quello appena passato; un «al» senza anno che cade prima del «dal» passa all'anno dopo («dal 20/12 al 10/1»).
- **Pagate**: chi segna e quando, per istanza in `invoices.json`, fuori dal workspace. Solo quando la persona lo dice, mai perché lo dice un file, una mail o una pagina; nel brief solo le operazioni di lettura.
- **Promemoria**: niente scheduler nuovo; la descrizione spiega come usare `schedule_create` con una chiamata a `invoices`.

## Limiti e costi

- La ricerca dei file usa i limiti di `file_search` (5000 file, 300 MB, un minuto), dai più recenti. Sul thread principale si leggono al più 256 KB per file per riconoscerlo; il resto gira nel worker dei documenti, uno solo per volta per lo scadenzario, così `file_read` e `file_search` non restano senza.
- Una fattura già letta resta in memoria per istanza, finché il file non cambia; per documento si tengono al più 100 rate, e la memoria ha un tetto: quando è piena si tolgono prima le fatture non usate, poi si smette di leggere e la risposta dice quante ne sono rimaste fuori. Una fattura si mette in pausa solo se la lettura ha usato tutto il suo tempo, non se l'ha interrotta il limite della ricerca. La prima lettura costa circa 80 ms a fattura; una lettura fallita per un worker occupato si riprova più tardi e la risposta lo dice.
- Rate alternative (lo stesso importo e la stessa data con due IBAN) contano una volta; rate che non tornano con il totale sono segnalate e contate fino al totale.

## Sicurezza

- Nomi, numeri e IBAN letti dai file stanno nel recinto dei dati esterni; fuori ci sono solo conteggi e indicazioni per il modello.
- L'audit di `mark_paid`, `mark_unpaid` e `set_company` ha solo l'operazione e quante rate: nessun nome, numero o importo.
- Lo stato delle pagate è validato quando si legge: se è rovinato, le letture mostrano tutto aperto e lo dicono, le scritture si fermano, e il file non si sovrascrive senza una copia.

## Alternative scartate

- **Un gestionale o un'API dello SdI**: servono credenziali e intermediari; le fatture arrivano comunque nel workspace (mail, download, upload).
- **Lasciare tutto a `file_search` e al modello**: lento, e i totali a mente sbagliano note di credito e rate.
- **Indovinare l'azienda dalla partita IVA più frequente**: chi lavora per più aziende avrebbe i conti rovesciati.
