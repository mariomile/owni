# 0129: Audit a rotazione mensile, 12 mesi

`audit.jsonl` cresceva senza fine, ed era letto tutto in memoria anche per mostrare le ultime 100 righe. Il codice ora legge dalla coda del file; resta da decidere per quanto tempo si conserva.

## Decisione

- **Un file per mese.** Il primo evento di un mese nuovo sposta `audit.jsonl` in `audit-AAAA-MM.jsonl` (il mese dell'ultima scrittura) accanto al file vivo e ne apre uno nuovo. Le scritture dello stesso file si eseguono una dopo l'altra, quindi la rotazione non si incrocia con un evento.
- **Dodici mesi di archivio.** Alla rotazione si cancellano gli archivi più vecchi di 12 mesi. L'audit registra metadati e mai testi, ma resta una traccia di persone e azioni: non va tenuta per sempre senza una ragione.
- **La lettura attraversa i file.** `read(n)` restituisce gli ultimi `n` eventi anche quando il mese corrente ne ha meno, e legge solo la coda di ogni file; `read()` li restituisce tutti, dal più vecchio.
- **La dimensione si vede.** `/api/usage` (la stessa risposta che la console già mostra per i consumi) porta `auditBytes`: byte del file vivo e degli archivi.

## Conseguenze

- Chi deve conservare l'audit più a lungo (obblighi del cliente) lo copia fuori dalla cartella del tenant prima dei 12 mesi: la durata non è configurabile.
- Il mese si calcola in UTC dalla data dell'ultima scrittura del file.
- Il registro dei consumi (`usage.jsonl`) ha lo stesso problema e lo risolve l'[ADR 0130](0130-registro-dei-consumi-a-rotazione-mensile.md).
