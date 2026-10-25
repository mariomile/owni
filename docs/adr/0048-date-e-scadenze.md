# Date e scadenze: `date_calc`

Chi lavora conta date tutto il giorno: «quanti giorni lavorativi mancano al 30?», «la fattura del 31 gennaio a 60 giorni fine mese quando scade?», «che giorno cade il 2 giugno?», «quanti anni ha chi è nato il 29/02/1980?». Un modello sbaglia questi conti a mente, soprattutto con festivi, fine mese e anni bisestili.

## Decisione

Un tool, `date_calc`, sempre registrato, senza rete né chiavi, con funzioni pure in `src/core/dates.ts` e il calendario in `src/core/italian-calendar.ts`.

- **Operazioni** (`op`): `info` (giorno della settimana, settimana ISO, festivo o no), `between` (giorni fra due date, senza il primo giorno), `add` (giorni, settimane, mesi, anni o giorni lavorativi, anche negativi), `due` (scadenza fattura: giorni data fattura, fine mese, giorno fisso), `working_days` (giorni lavorativi con entrambi gli estremi), `holidays` (festivi di un anno o di un mese), `age`.
- **«Oggi»** è la data di `OWNI_TIME_ZONE`, non quella del server.
- **Festivi** nazionali di oggi, Pasqua e Pasquetta calcolate, e il 4 ottobre (San Francesco) dal 2026 per la legge 151/2025. Valgono dal 2001 al 2200: prima i festivi erano diversi e la risposta sarebbe falsa, quindi festivi e giorni lavorativi sono rifiutati fuori da quegli anni. Giorni della settimana, giorni di calendario ed età vanno dal 1900.
- **Il santo patrono** conta solo se chi chiede lo dice (`patrono`): un giorno, o il nome di uno dei capoluoghi della tabella `PATRONI`. Owni non indovina dove lavora una persona.
- **Il sabato** non è lavorativo, salvo `saturday_working`.
- **«Fine mese» è ambiguo** fra gestionali: Owni conta i giorni dalla data fattura e poi va a fine mese (31/01 + 30 gg f.m. = 31/03), e quando contare a mesi darebbe un'altra data (28/02) la risposta dice anche quella.
- **Una scadenza di sabato, domenica o festivo non viene spostata**: la risposta dice il primo giorno lavorativo dopo, perché la regola dipende dal contratto.
- **Il 29 febbraio** compie gli anni il 28 negli anni non bisestili; una data senza anno prende l'anno in corso, e un intervallo che con la data senza anno finirebbe nell'anno dopo è rifiutato invece di indovinare.
- Le istruzioni dicono di usare `date_calc` per date, giorni e scadenze, non a mente. Nel brief il tool è fra quelli di sola lettura.

## Codice condiviso

- `italian-calendar.ts` raccoglie Pasqua, festivi, `addDays`, `daysInMonth` e i nomi dei mesi, prima ripetuti in cambi, meteo e codice fiscale, che ora lo usano.
- I testi delle date usano `italian-format.ts`.

## Limiti

- Al più 100.000 unità per `add`, intervalli dentro gli anni ammessi.
- Nessun festivo regionale o locale oltre al patrono detto, nessun calendario di altri paesi.

## Sicurezza

Funzioni pure, nessuna rete, nessun file, niente nell'audit: non cambia niente.

## Alternative scartate

- **Lasciare i conti al modello o a `calculate`**: sbaglia fine mese, festivi mobili e bisestili.
- **Una libreria di date**: per questi conti bastano le date UTC di JavaScript, e una dipendenza in più non porta i festivi italiani.
- **Spostare la scadenza al primo giorno lavorativo**: alcuni contratti lo prevedono e altri no; Owni dà entrambe le date.
- **Patrono dedotto dalla città dell'account**: chi lavora a Milano può avere clienti a Roma.
