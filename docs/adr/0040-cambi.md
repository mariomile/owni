# Cambi delle valute: i tassi di riferimento della BCE

> Sostituito dall'[ADR 0127](0127-niente-squadre-pronte-ne-strumenti-per-cose-che-l-agente-fa-gia.md): lo strumento `exchange_rate` e `OWNI_EXCHANGE_RATES` non ci sono più; i cambi si cercano sul web o si scaricano con `code_run`.

Una piccola impresa riceve fatture in dollari, paga fornitori in franchi svizzeri, fa preventivi in sterline. «Quanto fanno 1.250 dollari in euro?», «il cambio del dollaro alla data della fattura», «com'è andata la sterlina questo mese?». Owni faceva i conti con `calculate`, ma senza un cambio: il modello avrebbe dovuto inventarlo.

## Decisione

Un tool, `exchange_rate`, sui tassi di riferimento dell'euro della Banca Centrale Europea: ufficiali, gratuiti, senza chiave, una trentina di valute (29 nel 2026), pubblicati verso le 16:00 nei giorni lavorativi TARGET.

- **Cosa fa.**
  - Il cambio di oggi o di una data (per le fatture, il giorno lavorativo prima se quel giorno la BCE non ha pubblicato).
  - Uno o più importi convertiti (fino a 20, con il totale).
  - Fra due valute non euro, passando per l'euro.
  - L'elenco delle valute.
  - L'andamento in un periodo fino a un anno: inizio, fine, minimo, massimo e variazione.
- **Risposta corta.** Una riga per importo e una con il cambio come lo pubblica la BCE («1 EUR = 1,1642 USD», con l'inverso tra parentesi), più il motivo quando la data è un'altra: fine settimana, festivo TARGET calcolato (Pasqua compresa), oggi non ancora pubblicato. Date gg/mm/aaaa, numeri all'italiana, centesimi arrotondati una volta sola.
- **Valute che la BCE non pubblica.**
  - Il rublo, sospeso dal 2 marzo 2022: lo dice.
  - Le criptovalute: dice che non sono valute e rimanda alla ricerca sul web.
  - Le vecchie valute dell'euro (lira, marco, franco francese, peseta, kuna, lev): usa il cambio fisso irrevocabile.
- **Tre file della BCE.** Il giorno, gli ultimi 90 giorni, la storia dal 1999 (solo per date più vecchie), tenuti in memoria.
  - Il file del giorno resta finché basta. Dopo le 16:00 di Francoforte, se non ha ancora il cambio di oggi, si riprova ogni 5 minuti fino alle 18:00, poi al più ogni ora fino a mezzanotte; intanto Owni dice che la BCE oggi non ha pubblicato.
  - Un download fallito non si ripete per 2 minuti.
- **Acceso dall'operatore.** Con `OWNI_EXCHANGE_RATES=1`, come il meteo (ADR 0039). Dal server non esce nessun dato di chi scrive, solo la richiesta di un file pubblico, ma vale il principio dell'architettura: niente in uscita senza una configurazione esplicita. Così un server senza rete non ha un tool che fallisce.
- **Formattazione condivisa.** Numeri, importi e date all'italiana sono in `src/core/italian-format.ts`, usato da calcoli, meteo e cambi.

## Limiti

- Importi fino a un miliardo, 20 per chiamata.
- Andamento fino a 366 giorni.
- File di 256 KB (giorno), 2 MB (90 giorni) e 32 MB (storia), con un tempo massimo di 15 secondi (60 per la storia).

## Sicurezza

- I file sono letti con espressioni regolari lineari sui soli tag `<Cube>`.
  - Valute di tre lettere maiuscole, cambi decimali in un intervallo plausibile, date vere dal 1999.
  - Un giorno ripetuto si scarta tutto.
  - Un file senza la chiusura dell'Envelope (troncato) non vale.
  - Niente del file arriva al modello come testo: solo numeri controllati e codici.
- Due chiamate insieme fanno un solo download; i fallimenti restano in memoria per 2 minuti, così un modello che ripete la chiamata non scarica la storia di continuo.
- Nessun audit: non esce niente di chi scrive e non cambia niente, come `calculate`. Nella chat del brief il tool è consentito: chiede solo un file fisso.

## Condizioni d'uso

La BCE pubblica i tassi a solo scopo informativo e sconsiglia di usarli per operazioni di mercato: Owni cita «BCE» e, una volta per conversazione o quando si parla di pagamenti, ricorda che banche e carte applicano il loro cambio.

## Alternative scartate

- **Servizi di cambi commerciali** (con chiave, quotazioni in tempo reale): costano, e per fatture e contabilità il riferimento usuale è il cambio BCE.
- **Il servizio dati della BCE per intervalli di date**: più leggero per l'andamento storico, ma un'API in più da seguire; i tre file bastano.
- **Cambi dentro `calculate`**: i conti restano senza rete e deterministici; il cambio è un dato da fuori con la sua data.
