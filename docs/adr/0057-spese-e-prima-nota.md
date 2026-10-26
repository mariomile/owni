# Spese e prima nota

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `expenses` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`.

Con scadenzario (ADR 0053), solleciti (ADR 0054) e preventivi (ADR 0055) Owni segue i soldi che entrano, ma non quelli che escono: gli scontrini finivano in una scatola e il commercialista li riceveva a fine trimestre in foto sparse. Ora «ho speso 42 euro di benzina», o la foto dello scontrino, diventano una spesa registrata, e «quanto ho speso a ottobre?», «fammi la prima nota del trimestre» e «mandami le spese per il commercialista» hanno una risposta.

## Decisione

- **Strumento `expenses`** con le operazioni `add`, `list`, `summary`, `edit`, `remove`, `prima_nota` ed `export`. Le spese stanno in `expenses.json` nella cartella dell'istanza, con la copia `.bak`, 5000 spese per anno e 16 MB in tutto. Il file condiviso con i preventivi passa da `json-book.ts`: lock, scrittura atomica, file rovinato mai sovrascritto.
- **Lo scontrino lo legge il modello**: Owni vede già le foto (ADR 0016), quindi la descrizione dello strumento le chiede di prendere data, totale, IVA e fornitore dall'immagine e di chiedere solo se il totale non si legge. Lo strumento salva il percorso dello scontrino nel workspace, mai il contenuto.
- **Importi** in centesimi bigint, IVA compresa, con le stesse regole di lettura dei preventivi: un «1.250» ambiguo si chiede. L'IVA si dà come importo o come aliquota (22, 10, 5, 4, 0) e si scorpora arrotondando al centesimo. Senza scorporo sullo scontrino l'IVA si lascia vuota, non a zero. Valute estere si convertono con il cambio BCE del giorno e l'importo originale va nella nota; resi e rimborsi si correggono con `edit` o `remove`, niente importi negativi.
- **Date**: oggi di default, poi ieri, l'altro ieri, i giorni della settimana passati («sabato», «lunedì scorso») e dd/mm. Mai date future. Un mese senza anno è l'ultimo già iniziato; «trimestre scorso», «ultimo trimestre» e «da inizio anno» sono periodi validi.
- **Categorie** fisse in italiano: carburante, auto e veicoli, pasti e trasferte, ufficio e cancelleria, software e abbonamenti, telefono e internet, formazione, consulenze, attrezzatura, affitto e utenze, spedizioni, altro. Se la persona non la dice, Owni la indovina da parole intere del fornitore o della nota, mai da parti dell'indirizzo; nel dubbio è «altro».
- **Numerazione** S-AAAA-NNNN per anno della data della spesa; i numeri tolti non si riusano e una spesa non cambia anno con `edit`.
- **Doppioni**: la stessa foto o lo stesso giorno e importo si registrano comunque, con l'avviso «sembra uguale a S-…». Una chiamata ripetuta dallo stesso turno non crea un doppione.
- **Riepilogo** del periodo con totale, IVA registrata, categorie e confronto con lo stesso tratto del periodo prima (a mese in corso, gli stessi giorni). Nel forfettario la riga IVA sparisce e resta una sola nota: le spese non abbassano le tasse, servono a tenerne traccia. Nel brief c'è una riga compatta sul mese, senza confronto prima del 7.
- **Prima nota** di sola lettura: incassi dalle fatture segnate pagate nello scadenzario, uscite dalle spese, in ordine di data con saldo progressivo da zero a inizio periodo. Lo scadenzario non sa quando i soldi sono arrivati davvero, quindi conta il giorno in cui la fattura è stata segnata pagata, e la risposta lo dice. Fatture in altre valute, rate senza importo leggibile e note di credito usate si contano a parte.
- **Export CSV** in `spese/` del workspace, per il commercialista: separatore punto e virgola, virgola decimale, UTF-8 con BOM e righe CRLF perché Excel lo apra bene, colonne Data, Rif., Tipo documento, Fornitore, P.IVA fornitore, N. documento, Descrizione, Imponibile, Aliquota, IVA, Totale, Pagamento, File, e la riga dei totali. Un file esistente non si sovrascrive mai.

## Sicurezza

- Fornitore, nota, percorsi e nomi dei clienti tornano al modello solo dentro il recinto dei dati non fidati; il testo di un periodo non riconosciuto si ripete solo se fatto di lettere e cifre.
- Le celle del CSV che iniziano con = + - @, tab o a capo prendono un apostrofo: un fornitore ostile non diventa una formula. Il nome del file viene solo dal periodo.
- Il percorso dello scontrino deve essere una foto o un PDF esistente nel workspace, senza link simbolici, cartelle nascoste o `..`.
- Dal canale degli agenti e nel brief solo letture. L'audit registra operazione e numero di spese, mai importi, fornitori, note o percorsi.

## Alternative scartate

- **OCR dello scontrino nello strumento**: servirebbe un servizio o una libreria in più, e qualunque modello con la vista legge già lo scontrino meglio di un OCR generico.
- **Detraibilità automatica di IVA e costi**: dipende dal regime, dal tipo di documento e dall'uso del bene; Owni registra e il commercialista decide.
- **Un file per anno**: con circa 3 MB l'anno i 16 MB bastano per anni; se servirà, l'archivio di un anno chiuso è un passo separato.
- **Uscite prese anche dalle fatture passive pagate**: si rischia di contare due volte la stessa spesa; Owni le conta e suggerisce di registrarle.
