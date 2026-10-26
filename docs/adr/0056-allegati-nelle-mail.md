# Allegati nelle mail

> In parte sostituito dall'[ADR 0121](0121-registri-sostituiti-da-code-run-e-file.md): i preventivi e i solleciti non ci sono più; restano gli allegati dal workspace nelle mail.

Con preventivi (ADR 0055) e solleciti (ADR 0054) Owni prepara documenti da mandare ai clienti, ma le mail non potevano portare allegati: il PDF andava inoltrato a mano. Ora «manda il preventivo 12 a Rossi», «manda il sollecito a Gamma con la fattura allegata», «mandami per mail il report» e «rispondi a Marco allegando il contratto» partono con il file.

## Decisione

- **`google_mail_send`** (invio, risposta, bozza) accetta fino a 5 file del workspace, 17 MiB in tutto: con la codifica base64 restano sotto i 25 MB di Gmail. `to: ["me"]` è l'indirizzo dell'account collegato. Per trovare un file nominato a voce Owni usa prima `file_search` e chiede se ce n'è più d'uno.
- **`quotes` op `send`**: il PDF o il Word del preventivo, con oggetto «Beta Ristorazione Srl: preventivo n. 2026-001» e una lettera breve (Spett.le e voi per le imprese, Gentile e Lei per i privati). Un preventivo scaduto o rifiutato parte solo se la persona lo conferma; uno sostituito non parte nemmeno se la card era già stata chiesta. Una sola card in attesa per preventivo; dopo l'invio il preventivo dice «inviato per mail il …» e l'indirizzo si salva solo se l'invio è riuscito.
- **Solleciti con `attach_invoice`**: l'XML (o il .p7m) della fattura e il PDF di cortesia solo se sta accanto e il suo testo contiene il numero della fattura. Con il solo XML Owni avverte che il cliente non lo legge facilmente.
- **Tipi ammessi** controllati anche nel contenuto: PDF, Word, Excel, PowerPoint (anche i vecchi formati), OpenDocument, RTF, CSV, testo, PNG, JPG, XML, .p7m. Rifiutati eseguibili, script, HTML anche rinominato, archivi, documenti con macro, HEIC (Owni chiede di convertire in JPG).
- **Dal telefono** niente invio: Owni manda il file in chat e il testo da copiare, con un link che apre la posta.

## Sicurezza

- La card di approvazione è la guardia contro un contenuto ostile che chieda di allegare file riservati: ha una riga sua, «Allegati», con un file per riga: percorso completo e dimensione («cartella/file.pdf (84 KB)»), e il numero di allegati nel titolo. Il motivo scritto da Owni sta fuori da quella riga e non può imitarla (caratteri invisibili e di direzione tolti, 300 caratteri al massimo). La richiesta salva solo percorso, nome, dimensione e impronta sha256; all'approvazione il file si rilegge senza seguire link simbolici e, se è cambiato, la mail non parte.
- Intestazioni MIME senza a capo iniettabili, nomi non ASCII codificati (RFC 2231), un invio con allegati alla volta per tenere bassa la memoria; oltre 4 MB codificati si usa l'endpoint di upload di Gmail.
- L'audit conta solo gli allegati: niente nomi, percorsi o indirizzi. Dal canale degli agenti e nel brief nessun invio.

## Alternative scartate

- **Allegare il contenuto letto dal modello**: il file non passa mai dal contesto del modello, solo dal disco a Gmail.
- **Archivi .zip**: possono contenere qualunque cosa e la card non lo mostrerebbe.
- **Link a una cartella condivisa invece dell'allegato**: richiede permessi e un servizio in più per un cliente che si aspetta un PDF.
