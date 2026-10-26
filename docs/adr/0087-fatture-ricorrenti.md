# Fatture ricorrenti

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `recurring_invoices` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Chi lavora a canone (manutenzione mensile, hosting trimestrale, consulenza annuale) rifà ogni periodo la stessa fattura allo stesso cliente. Le fatture in uscita (settimana 58) la sapevano preparare, ma solo quando la persona se ne ricordava, e un mese dimenticato era un incasso perso.

## Decisione

- **Strumento `recurring_invoices`** con `add`, `list`, `show`, `pause`, `resume`, `change`, `remove` e `run_now`. Le fatture ricorrenti stanno in `recurring-invoices.json` con lo stesso schema degli altri registri (lock, copia `.bak`, file rovinato mai sovrascritto, RI-NNNN mai riusati). Cadenza mensile, bimestrale, trimestrale, semestrale o annuale; giorno da 1 a 28 o fine mese; inizio, e fine o numero di fatture facoltativi.
- **Solo bozze**: ogni periodo Owni prepara la bozza con lo stesso `draft()` delle fatture in uscita (FatturaPA, forfettario, bollo, ritenuta e rivalsa non sono duplicati), senza numero, senza emetterla e senza mandarla allo SdI. All'aggiunta e a ogni cambio la bozza del primo periodo si prova senza salvarla, così quello che manca si chiede subito e non a ogni periodo.
- **Un periodo, una bozza**: il periodo si prenota nel file prima di costruire la bozza, e la bozza ha un id di chiamata `recurring:RI-x:AAAA-MM`, quindi due giri insieme o un riavvio a metà non fanno doppioni. Ogni bozza copre i mesi del suo periodo: cambiare cadenza o inizio riparte dal primo mese libero, e i mesi rimasti fuori si vedono in `show` e si preparano uno per uno con `run_now`. Una bozza riscritta con `sales_invoices` porta con sé l'origine (`origin`), quindi resta la bozza di quel periodo.
- **Server fermo o pausa**: si prepara solo l'ultimo periodo dovuto e si nominano i mesi saltati; quelli si recuperano con `run_now` e il periodo. `run_now` non prepara periodi futuri, parti di un periodo già coperto o fatture in pausa.
- **Fattura tolta e rimessa**: i mesi già fatturati da una fattura ricorrente tolta restano coperti solo per lo stesso canone (stesso cliente, stesse righe, stessa cadenza) aggiunto dopo, finché quella bozza esiste.
- **Avviso**: nella chat dove il canone è stato messo, una volta per periodo, con la bozza pronta e «Questo avviso non è un suo sì»; se l'invio non riesce si riprova, dopo tre tentativi una volta al giorno. Un errore (cliente tolto, voce del listino sparita, dati dell'azienda mancanti) si dice una volta per periodo con cosa manca.

## Sicurezza

- L'avviso non contiene il comando per emettere: la fattura si emette solo dopo il sì della persona in un suo messaggio. Il runtime oggi non dice agli strumenti se un turno viene da un avviso; quando lo farà, `issue` potrà rifiutare la conferma in quei turni.
- Nomi dei clienti, righe e note solo nel recinto dei dati non fidati, anche il motivo di un errore. Dal canale degli agenti solo `list`, con il numero di fatture attive e l'importo medio al mese, mai per cliente. L'audit registra operazione e conteggio. Un file con date impossibili, partite IVA malformate o una chat del canale agenti non si carica.

## Alternative scartate

- **Emettere da sola**: la numerazione e l'invio allo SdI non si annullano; una bozza sbagliata invece si toglie.
- **Preparare tutti i periodi persi**: dopo due mesi di server fermo arrivava una raffica di bozze; meglio dirli e lasciarli scegliere.
- **Usare le attività programmate (`schedule_create`)**: un promemoria non sa quali mesi sono già fatturati, e non evita i doppioni.
- **Mettere le fatture ricorrenti nella previsione di cassa**: senza un legame fra la fattura scansionata e il periodo del canone si contavano due volte; resta da fare.
