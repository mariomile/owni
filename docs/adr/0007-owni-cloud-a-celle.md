# Owni Cloud: una cella per tenant, un control plane sottile

> Aggiornata dall'[ADR 0008](0008-celle-container-prima-delle-micro-vm.md): per i primi clienti le celle sono container su un server in UE; le micro-VM arrivano con la Fase 3. Il resto di questa decisione vale.

Owni deve funzionare anche come servizio, come Grok Bot e dots: un agente sempre attivo a cui ci si registra e si parla, senza installare nulla. Abbiamo deciso che in Owni Cloud ogni tenant ha una **cella**: lo stesso container del self-host, su una micro-VM con il suo volume, che si spegne quando non lavora e si riaccende a un messaggio o a un task programmato. Accanto c'è un **control plane** sottile e comune: registrazione, pagamento, smistamento dei messaggi in arrivo alla cella giusta, risveglio. Il target sono professionisti e piccoli team (20-50 € al mese, dati in Unione Europea), non il consumer generalista.

Perché: il nucleo di Owni (storage su file, SQLite di Pi Durable, lock POSIX, outbox) è fatto per un processo con un disco suo, e la cella lo riusa senza riscriverlo. L'isolamento per macchina è il più forte che possiamo offrire, contiene la sandbox dei tool proposti e domani il «computer dell'agente» (browser e terminale). Cloud e self-host restano lo stesso prodotto, che è ciò che vendiamo: privacy e controllo.

## Alternative scartate

- **Piattaforma condivisa** (worker comuni, Postgres, object storage): costa meno per tenant a decine di migliaia di tenant, ma chiede di riscrivere lo storage di Pi Durable e isola i tenant solo a livello di applicazione. Da rivalutare se il numero di tenant lo giustifica.
- **Consumer generalista con piano gratuito**: concorrenza diretta con xAI e OpenAI su modello, prezzo e distribuzione; ogni utente gratuito costa modello e macchina senza ricavo.

## Conseguenze

- La cella deve potersi spegnere: Telegram passa dal long polling ai webhook (il messaggio arriva al control plane, che sveglia la cella), e i task programmati vengono svegliati dal control plane all'ora prevista.
- Il control plane vede i messaggi in transito (deve smistarli) ma non li conserva; conversazioni, file e segreti stanno solo nella cella. Tiene però il segreto di ogni cella, con cui può chiedere un link da owner: ogni richiesta resta nell'audit della cella, e chi vuole escludere anche l'operatore attiva la verifica in due passaggi. Per la fattura conserva anche la spesa stimata di ogni tenant, giorno e mesi: solo numeri, nessun contenuto (nota del 16 ottobre 2026).
- In produzione le celle stanno su un dominio separato da quello della registrazione, registrato nella Public Suffix List: tenant diversi non sono «same-site» e non possono toccarsi i cookie.
- Costo fisso per tenant: il volume della cella si paga anche da spenta. Va misurato prima di fissare il prezzo.
- Il provider (per esempio Fly.io Machines in una regione UE) è dietro un'interfaccia nostra, come Pi: si può cambiare.
