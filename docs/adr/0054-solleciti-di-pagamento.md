# Solleciti di pagamento

> Sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): lo strumento `invoices` non c'è più, i conti e i dati stanno nei file del workspace e li fa `code_run`. I solleciti si scrivono con le mail e le bozze di sempre.

Dalla settimana 48 Owni sa quali fatture emesse sono scadute. Il passo dopo è riscuoterle: «chi non mi ha ancora pagato?», «prepara un sollecito per Gamma», «manda i solleciti a tutti i clienti in ritardo».

## Decisione

- **Due operazioni nuove di `invoices`**: `reminder` scrive il sollecito (bozza, sola lettura) e con `send` lo mette nella coda delle mail da approvare; `reminder_sent` annota un sollecito che la persona dice di aver mandato da sé. «Chi non mi ha pagato?» resta `due` con le scadute da incassare, che mostra anche i solleciti già fatti («sollecitata 2 volte, l'ultima il 12/10»).
- **Tre livelli**: promemoria cortese, secondo sollecito con un termine di 7 giorni, sollecito formale con 15 giorni che vale come costituzione in mora (art. 1219 c.c.) e interrompe la prescrizione (art. 2943 c.c.). Il livello si conta per fattura: il più alto annotato più uno, fino a 3. Fatture dello stesso cliente a livelli diversi vanno in lettere separate, così solo quelle del sollecito formale sono messe in mora; un livello chiesto non abbassa mai una fattura già sollecitata di più. Le frasi sul «precedente sollecito» compaiono solo se un sollecito è davvero annotato; una fattura non ancora scaduta ha solo il promemoria di scadenza. Dopo un sollecito formale Owni non ne prepara un altro senza che la persona lo chieda, e ricorda che il passo dopo di solito è un legale.
- **Importo**: solo le rate scadute (quelle non ancora scadute sono una nota per la persona); le note di credito di quel cliente si scalano solo in una lettera che copre tutto il suo scaduto, se no restano una nota; con lo split payment senza IVA, e lo scadenzario lo scrive accanto all'importo. Le 40 € di risarcimento (art. 6 D.Lgs. 231/2002) solo se la persona le chiede e solo verso imprese ed enti; gli interessi solo con un tasso dato dalla persona, semplici, esatti al centesimo e con i conti scritti, e mai quando ci sono note di credito scalate.
- **IBAN**: quello salvato con `set_company` (controllato con mod-97). Un sollecito inviato o da copiare usa solo quello; senza, esce senza riga di pagamento e Owni dice di salvarlo. Solo nelle bozze l'IBAN delle fatture compare, se è valido e uguale in tutte le fatture emesse non pagate degli ultimi due anni. Un file non può cambiare dove arrivano i soldi.
- **Destinatario**: l'indirizzo dato dalla persona, che resta salvato per quel cliente; poi quello salvato; poi la PEC di recapito SdI, segnalata perché può essere dell'intermediario; per ultima una mail scritta nel file, con un avviso, perché il tracciato non la prevede per il cliente. Gli indirizzi PEC sono sempre segnalati.
- **Invio**: solo dalla console web con un account Google collegato, con la card di approvazione di sempre. Il sollecito si annota solo quando l'invio approvato è riuscito. Senza account o dal telefono Owni manda un messaggio per cliente con oggetto e testo da copiare, e un link `mailto:` che apre la posta già compilata.
- **Niente doppioni**: con `send` Owni salta i clienti sollecitati oggi, quelli con una card ancora da decidere e quelli già al sollecito formale; `reminder_sent` detto due volte nello stesso giorno annota una volta sola.
- **Forma**: «Spett.le» e voi per imprese ed enti, «Gentile» e Lei per i privati; per la PA una nota (PEC all'ufficio, split payment). Oggetto con il nome dell'azienda e firma salvati con `set_company`; nomi presi dai file non finiscono mai in oggetto o firma (senza nome salvato la lettera è firmata con la partita IVA).

## Sicurezza

- Nomi, numeri, IBAN, indirizzi e testo della lettera stanno nel recinto dei dati esterni; il link `mailto:` è codificato e un solo destinatario è accettato, senza a capo nell'oggetto.
- Un file, una mail o una pagina non possono mai far partire un invio o annotare un sollecito: solo la persona. Dal canale degli agenti tutte le scritture dello scadenzario sono rifiutate, anche segnare pagata.
- L'audit ha solo l'operazione e quante: nessun nome, importo, indirizzo o testo.
- Solleciti e rubrica stanno in `invoices.json` con le stesse regole delle pagate (validazione, limiti, copia `.bak`); un elenco di solleciti rovinato blocca solo i solleciti, non lo scadenzario; una rubrica rovinata blocca invii e salvataggi di indirizzi, e la lettera non ripiega mai sull'indirizzo del file. Numeri o nomi troppo lunghi si salvano come impronta sha256, così un file non può rovinare lo stato. Lo storico dei solleciti resta anche quando una fattura è segnata pagata, e si toglie un anno dopo il pagamento.

## Alternative scartate

- **Prendere IBAN e indirizzo dal file più recente**: una copia ritoccata di una fattura dirotterebbe i pagamenti.
- **Diffida ad adempiere (art. 1454 c.c.)**: serve a risolvere il contratto, va oltre un sollecito.
- **Interessi di mora con un tasso scritto nel codice**: il tasso cambia ogni semestre e qui non si può verificare.
- **Invio automatico senza approvazione**: una mail a un cliente non si ritira.
