# Connettori in un clic

Fino alla settimana 28 un connettore MCP si aggiungeva a mano: URL, header segreto, valore. Per un titolare non tecnico era un muro, e i servizi più usati (Notion, Linear, Jira, Stripe) non danno chiavi da incollare: chiedono di entrare con l'account, con OAuth.

## Come funziona

- **Il catalogo** (`src/connectors/catalog.ts`): servizi con un server MCP remoto ufficiale (Streamable HTTP), con nome, descrizione in italiano, indirizzo, tipo di accesso (account, token, nessuno) e gruppo. Indirizzi controllati il 17 ottobre 2026 sugli elenchi pubblici dei fornitori. Fuori, per ora, chi accetta solo app approvate prima (Asana, Vercel).
- **Accesso con l'account**: il flusso di autorizzazione MCP con l'SDK (`auth()`), Owni come client pubblico registrato da sola (registrazione dinamica), PKCE. «Accedi e aggiungi» avvia l'accesso prima di salvare: se il servizio rifiuta, non resta niente. Il servizio rimanda a `<indirizzo della console>/oauth/mcp/callback` (`OWNI_PUBLIC_URL`, o l'indirizzo del link di login), che passa codice e stato alla console nel frammento; la console chiude con una sua richiesta, che porta la sessione (come per Google, ADR 0005).
- **Lo stato**: 18 byte casuali con il tenant, valido 10 minuti, una volta sola, legato alla persona che l'ha iniziato; il verificatore PKCE sta con lo stato, in memoria. Un nuovo «Collega» sostituisce quello lasciato a metà.
- **Dove sta l'accesso**: un segreto per istanza e connettore (`mcp-oauth.<istanza>.<connettore>`) con il client registrato, i token e i server trovati. Le scritture di uno stesso segreto vanno una alla volta nel processo. Un client registrato per un altro indirizzo di ritorno si registra di nuovo.
- **Rinnovo**: il trasporto MCP rinnova da solo. Le richieste al server MCP passano dal fetch del connettore (policy e host); quelle al server di autorizzazione dal fetch dell'accesso, sotto la stessa policy. In background un accesso non parte mai: il connettore diventa «Da collegare».
- **Il fetch dell'accesso**: solo https, solo indirizzi pubblici, controllati sull'indirizzo a cui il socket si collega (niente DNS rebinding), nessun redirect seguito, 15 secondi e 512 KB al massimo. La pagina di accesso data alla console deve essere https.
- **Token**: per GitHub (il suo server MCP non accetta la registrazione automatica) l'owner incolla un token, tenuto come `Authorization: Bearer` in un segreto per istanza (`connector.<connettore>.<istanza>.authorization`). «Cambia token» lo sostituisce; rimuovere il connettore lo cancella.
- **Il modello**: al più 64 strumenti per connettore. Un connettore che va ricollegato, o il cui token è rifiutato, lascia al modello uno strumento `<connettore>__non_collegato` che dice cosa dire alla persona.
- **Errori**: in italiano, senza il testo del servizio (le descrizioni di errore OAuth possono ripetere un token o un codice).
- **Audit**: `connector.saved` (con `catalog`), `connector.authorized`, `connector.sign_in_cancelled`, `connector.removed`, `secret.set`, `secret.deleted`. Mai token, codici o stati.

## Alternative scartate

- **Client OAuth registrati a mano dall'operatore per ogni servizio.** Funziona con tutti, ma vuol dire un'app e una chiave per servizio, per ogni installazione. La registrazione dinamica è quella prevista dalla specifica MCP; per chi non la accetta resta il token o il modulo personalizzato.
- **Accesso in corso nel secret store.** Sopravviverebbe a un riavvio, ma un accesso dura un minuto: dopo un riavvio basta premere di nuovo «Collega».
- **Tutti gli strumenti al modello.** Alcuni servizi ne hanno centinaia: riempiono il contesto e superano i limiti dei fornitori di modelli.

## Conseguenze

- Le azioni di scrittura dei servizi collegati (una issue, un rimborso Stripe) partono senza approvazione, come per i connettori aggiunti a mano. L'approvazione per gli strumenti che scrivono (con le annotazioni `readOnlyHint` dei server) è il passo successivo.
- Un riavvio durante un accesso lo perde: l'owner preme di nuovo «Collega».
- Senza un indirizzo https (`OWNI_PUBLIC_URL`) molti servizi rifiutano di rimandare alla console, tranne che verso `localhost`; la console lo dice.
- Context7 e Hugging Face si collegano senza account; i loro token opzionali (limiti più alti, dati privati) si mettono con il modulo personalizzato.
- I primi 64 strumenti sono quelli nell'ordine del server; la scelta degli strumenti da parte dell'owner non c'è ancora.
