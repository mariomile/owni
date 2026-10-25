# Settimana 42: cambi delle valute

Branch `week-42`. Fatture in dollari, fornitori svizzeri, preventivi in sterline: Owni faceva i conti ma non aveva i cambi. Ora `exchange_rate` usa i tassi di riferimento ufficiali della BCE, oggi o alla data di una fattura, per uno o più importi, con l'elenco delle valute e l'andamento in un periodo. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0040](adr/0040-cambi.md).

## Cosa cambia per chi usa Owni

- **«Quanto fanno 1.250 dollari in euro?»**: una riga con il risultato e una con il cambio BCE e la data.
- **«Il cambio del dollaro alla data della fattura, 25 dicembre»**: il cambio del 24, perché il 25 la BCE è chiusa, detto in chiaro.
- **«Converti queste cinque righe in franchi»**: una riga ciascuna e il totale.
- **«Com'è andata la sterlina da settembre?»**: inizio, fine, minimo, massimo e di quanto si è rafforzata o indebolita.
- **«E i rubli? E i bitcoin? E 100.000 lire?»**: il rublo è sospeso dal 2022, i bitcoin non sono una valuta, le lire hanno il cambio fisso con l'euro.
- **IVA e preventivi**: il risultato già arrotondato va a `calculate` e nei documenti.

## Cosa funziona (verificato dai test)

- Lettura dei file BCE: valute, cambi e date controllati; giorni ripetuti, file troncati, XML ostile (anche 2 MB di commenti aperti, letti in meno di 200 ms) (`test/exchange-rates.test.ts`).
- Date: fine settimana, festivi TARGET con Pasqua calcolata, oggi prima delle 16:00, dopo le 16:00, dopo le 18:00 senza pubblicazione; scelta fra il file del giorno, dei 90 giorni e della storia; date future o prima del 1999.
- Cache: un solo download per chiamate insieme, file del giorno rinnovato solo quando serve, fallimenti tenuti 2 minuti.
- Conti: euro verso valuta, valuta verso euro, fra due valute passando per l'euro, importi fino a un miliardo senza perdere centesimi, totale di più importi, cambi fissi delle vecchie valute.
- Risposte: forma compatta, cambio come lo pubblica la BCE, date gg/mm/aaaa, nessun «hai chiesto» quando la data non c'era, motivi specifici per rublo, criptovalute e codici sconosciuti.
- Configurazione: spento senza `OWNI_EXCHANGE_RATES=1`, indirizzo di prova controllato, `pnpm owni check` che scarica il file del giorno solo se è acceso.
- In un'istanza vera: una conversione dalla chat con il modello di prova.

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso, con richieste vere provate sul codice e i fatti controllati sul sito della BCE. Corretti:

- **Alta (sicurezza).** Un'espressione regolare che toglieva i commenti era quadratica: un file ostile da 320 KB bloccava il server per 15 secondi. Il tool era acceso di default, contro il principio «niente in uscita senza configurazione», e rompeva `owni check` sui server senza rete.
- **Media (sicurezza).** I download falliti si ripetevano a ogni chiamata, anche quello della storia. Un giorno scartato poteva tornare. Un file troncato era accettato. Gli importi grandi perdevano i centesimi o finivano in notazione esponenziale.
- **Alta (uso).**
  - Dopo le 16:00 il cambio di oggi poteva restare nascosto per un'ora.
  - «1.250 dollari» poteva arrivare come 1,25.
  - «Hai chiesto sabato» anche quando nessuno aveva chiesto una data.
  - Una data senza anno era lasciata al caso.
- **Media (uso).**
  - Risposte di cinque righe.
  - Il cambio derivato mostrato prima di quello BCE.
  - Zeri inutili.
  - Rublo e bitcoin trattati con un elenco di 31 codici.
  - Nomi ambigui (corona, rupia).
  - IVA calcolata sul cambio invece che sull'importo arrotondato.
  - Mancavano più importi, l'elenco delle valute e l'andamento.
- **Bassa.**
  - Festivi detti «festivi» anche quando non lo erano.
  - Una data non testuale presa per oggi.
  - La formattazione italiana dipendeva dal modulo del meteo: ora è un modulo a sé.

## Seconda revisione

- L'andamento funziona anche con le valute entrate nell'euro (lev, lira): ogni giorno usa il cambio pubblicato o quello fisso.
- Il totale di importi in centesimi si arrotonda ai centesimi; yen, won, corona islandese, fiorino, lira e peseta si scrivono senza decimali.
- Se le due date cadono sullo stesso giorno pubblicato, Owni lo dice invece di rispondere «invariato».
- Dopo le 18:00 il file del giorno si richiede al più ogni ora fino a mezzanotte, così una pubblicazione tardiva non va persa.
- `MAX_MONEY` scende a 9e13, il limite dei centesimi esatti.
