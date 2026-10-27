# 0130: Registro dei consumi a rotazione mensile, 12 mesi

`usage.jsonl` è l'unica traccia della spesa ([ADR 0098](0098-quanto-costa-un-turno.md)): i totali del giorno e del mese sono somme delle sue righe. Cresceva senza fine e veniva riletto tutto. Come per l'audit ([ADR 0129](0129-audit-a-rotazione-mensile.md)), serve una durata.

## Decisione

- **Un file per mese.** Il primo record di un mese nuovo (mese di Europe/Rome, lo stesso dei totali) sposta `usage.jsonl` in `usage-AAAA-MM.jsonl`, dove AAAA-MM è il mese dell'ultimo record del file, e ne apre uno nuovo. La rotazione avviene dentro la coda che scrive i record, quindi non si incrocia con una scrittura o una lettura. Un `usage.jsonl` già esistente diventa semplicemente il file vivo.
- **Dodici mesi di archivio.** Alla rotazione si cancellano gli archivi più vecchi di 12 mesi. Il control plane in Cloud tiene già il massimo letto per ogni mese (`months` in `control-plane.json`), quindi la fatturazione non dipende dagli archivi vecchi.
- **Il totale di oggi legge solo il file vivo.** Oggi sta sempre nel mese corrente, che dopo la rotazione è nel file vivo: il tetto giornaliero non rilegge gli archivi. Subito dopo la rotazione il totale di oggi parte da quello dei record del mese nuovo.
- **Totali del mese, statistiche e `pnpm owni usage` leggono file vivo e archivi.** `byMonth()` e `monthSpent()` sommano tutti i mesi conservati; `records()` restituisce gli archivi e poi il file vivo, dal più vecchio. Gli archivi non cambiano più, quindi si rileggono solo se il file cambia.
- **Un turno si conta una volta sola anche attraverso il cambio di mese.** Un turno è identificato da agente e submission ([ADR 0098](0098-quanto-costa-un-turno.md)). Prima di scrivere, il registro cerca quella coppia nel file vivo e in tutti gli archivi conservati: se il turno è registrato in un mese già archiviato, il ritentativo non scrive nulla e non cambia nessun totale. La regola è una sola: *un turno è fatturato una volta finché il suo record è conservato*.
- **La dimensione si vede.** `/api/usage` porta `usageBytes`: byte del file vivo e degli archivi, accanto ad `auditBytes`.

## Conseguenze

- Dopo 12 mesi un record sparisce e con lui il dedup: un ritentativo dopo oltre un anno verrebbe contato di nuovo. Non succede in pratica, perché un ritentativo arriva da un recupero dopo un guasto, entro minuti o giorni.
- Chi deve conservare i consumi più a lungo li copia fuori dalla cartella del tenant prima dei 12 mesi: la durata non è configurabile.
- Il dedup rilegge fino a 12 archivi la prima volta dopo un riavvio; poi li tiene in memoria finché non cambiano.
