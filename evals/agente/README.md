# Eval dell'agente generale (ADR 0099)

```bash
pnpm eval:agente                          # catalogo + 4 contratti di esito deterministici
pnpm eval:agente:catalog                  # ogni strumento atteso esiste nel catalogo
pnpm eval:agente:outcomes                 # runtime, tool e store reali; modello faux
pnpm eval:agente:outcomes artifact-roundtrip
pnpm eval:agente:real                     # nightly: Anthropic, serve OWNI_JUDGE_MODEL_KEY
pnpm eval:agente:real saluto              # solo i casi con questi id
pnpm eval:agente:conti                    # sei domande di conti a un modello vero, con l'abbonamento di Claude Code (ADR 0119)
```

`cases.jsonl`: una richiesta per riga, `{ id, text, expect }`. `expect` indica i tool accettabili come prima chiamata; `[]` significa nessuno. Selettori sconosciuti e cataloghi vuoti sono errori, anche senza chiave.

Il routing reale scrive sempre, salvo interruzioni forzate o errori di scrittura, `last-report/agente.json` e `agente.md`: stato `passed|failed|skipped|error`, casi selezionati e misurati, motivi, modello selezionato e provider/modello effettivi dal ledger per ogni turno. Senza chiave: `skipped`, zero misure, accuratezza `null`, nessun modello dichiarato come eseguito. Errori di avvio, turno o chiusura: `error`. `failed` indica accuratezza sotto l'80%; `failed` ed `error` escono con codice 1. `skipped` esce con 0 ma compare separatamente nel riepilogo e negli artifact nightly; un report mancante fa fallire il controllo.

`OWNI_MODEL_ID` sceglie il modello Anthropic da misurare. `tool_search`, che carica gli strumenti dei connettori, non conta come primo tool se segue un tool operativo; un turno che chiama solo `tool_search` non equivale a nessun tool. L'accuratezza riguarda solo i turni misurati; un errore impedisce comunque `passed`. **Primo tool corretto non significa compito riuscito**: il routing non misura l'esito (`outcomeSuccess: null`).

Gli **integration/outcome-contract checks** in `outcomes.ts` usano il runtime durevole e il modello `faux` esistenti, comandati con `/tool`, directory temporanee rimosse a fine scenario e il client Google con trasporto stub senza rete:

- «Quanto ho fatturato a marzo?» su 1000 righe con `code_run`: totale esatto al centesimo e risposta persistita nell'outbox.
- Creazione del file, verifica dei byte su disco e lettura in un turno successivo.
- Memoria salvata, corretta eliminando il fatto precedente, riletta in una nuova conversazione e isolata da un'altra persona.
- Proposta mail persistita con destinatario/contenuto esatti; zero invii prima dell'approvazione, decisione di un'altra persona respinta e rifiuto senza effetti.

Il report separato è `last-report/outcomes.json` con riepilogo `outcomes.md`. I test negativi sostituiscono l'implementazione mantenendo il nome del tool: valore sbagliato, file mancante, operazione fallita, memoria obsoleta e invio non autorizzato devono fallire. Questi controlli verificano esecuzione e persistenza con chiamate prescritte; **non misurano qualità linguistica, scelta naturale dei tool o parità con Grok**. Il flusso web di approvazione e l'invio effettivo dopo approvazione restano fuori da questi quattro scenari.

```bash
pnpm test test/agent-eval-report.test.ts test/agent-outcomes.test.ts
pnpm typecheck
```
