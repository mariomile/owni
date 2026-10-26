# Organigramma degli agenti

Mario (26 ottobre 2026): «sarebbe figo definire un organigramma in cui definiamo ruoli e team, ownership su attività» e «stiamo creando un'azienda di agenti AI». Ogni agente ha già le sue cose: istruzioni e tono (ADR 0041), memoria, procedure, connettori, task e sentinelle, raccolti nel suo pannello (ADR 0114). Mancava il loro insieme. Le squadre pronte (ADR 0068) scrivevano chi coordina dentro le istruzioni al momento della creazione, e chi parla con chi era una lista di caselle per agente (ADR 0042): niente diceva chi fa cosa nell'azienda, chi risponde a chi, a chi passare una richiesta che non è tua.

## Decisione

Un **organigramma** per installazione, deciso dall'owner nella pagina «Organigramma», accanto ad Agenti. È la sola fonte di chi parla con chi.

- **Cosa contiene.** Le **squadre** (nome, a cosa serve, chi la coordina) e, per ogni agente, il **ruolo** (una riga: «Responsabile vendite»), la squadra, **a chi risponde** (un altro agente, oppure nessuno: risponde alle persone), le **responsabilità** (fino a 10 righe brevi: «Preventivi in attesa», «Solleciti di pagamento») e se è **a disposizione di tutti**. Un agente sta al più in una squadra; chi coordina ne fa parte. Una catena di «risponde a» non torna mai su se stessa. La segreteria resta fuori: non scrive agli altri agenti. Il file è `organigramma.json` nella cartella del tenant.
- **Chi parla con chi viene dall'organigramma.** Si scrivono tra loro i membri della stessa squadra, un agente e chi gli sta sopra (nei due sensi), e chi coordina le squadre, tra coordinatori: il lavoro tra squadre passa da loro, come in un'azienda. A un agente a disposizione di tutti scrivono tutti. Salvare l'organigramma riscrive per ogni agente chi può scrivergli (`allowedUsers.agente`, ADR 0042) e il canale nella sua policy. Spariscono la card «Agenti che possono scrivergli» da modificare e il pulsante «Fate squadra»: la card resta, in sola lettura, e rimanda all'organigramma.
- **Ogni agente sa dove sta.** Le sue istruzioni finiscono con una nota sull'azienda, ricalcolata a ogni richiesta: il suo ruolo e le sue responsabilità, la squadra e chi la coordina, a chi risponde e chi risponde a lui. Chi coordina sa che riceve le richieste, divide il lavoro (sulla board in sotto-schede, ADR 0066) e consegna; un membro sa che il lavoro di solito glielo passa chi coordina. A tutti è detto: una richiesta che è responsabilità di un altro agente la passi a lui con `agent_message` oppure, se non puoi scrivergli, a chi coordina la tua squadra o a chi rispondi.
- **`agent_list` dice chi è responsabile di cosa.** Ogni collega con ruolo, squadra e responsabilità; sotto, gli altri agenti dell'azienda a cui non puoi scrivere, con le loro responsabilità, e a chi chiedere per arrivarci.
- **Le squadre pronte entrano nell'organigramma.** Creare una squadra (ADR 0068) aggiunge la squadra, con chi coordina, i ruoli e le responsabilità di ognuno, e chi risponde a chi coordina. Le istruzioni dei membri tengono solo il loro lavoro: il resto lo dice la nota, che resta vera se l'owner sposta un agente.
- **Eliminare un agente** lo toglie dall'organigramma: chi gli rispondeva non risponde più a nessuno, la sua squadra resta senza chi coordina, e chi parla con chi si ricalcola.

La pagina «Organigramma» mostra le squadre con chi le coordina in testa, poi gli agenti senza squadra. Di ognuno: volto, ruolo, responsabilità, a chi risponde, con chi parla e cosa sta facendo adesso (ADR 0109). L'owner modifica un agente o una squadra da una finestra, e ogni salvataggio scrive l'intero organigramma.

## Alternative scartate

- **Lasciare le caselle per agente accanto all'organigramma.** Due posti che decidono la stessa cosa: un collegamento aggiunto a mano sparirebbe al prossimo salvataggio dell'organigramma, o lo contraddirebbe. Per un agente che serve a tutti c'è «a disposizione di tutti».
- **Tutti parlano con tutti dentro l'azienda.** Più semplice, ma un agente con dati delicati (l'amministrazione) resterebbe aperto a chiunque, e chi deve fare cosa non sarebbe più scritto da nessuna parte.
- **Ruoli e squadre nelle istruzioni dell'agente**, come le squadre pronte prima. Diventano falsi appena l'owner sposta qualcuno, e l'owner dovrebbe riscriverli a mano in ogni agente.
- **Persone nell'organigramma.** Chi può scrivere a un agente e chi approva sono già decisi nella sua configurazione, persona per persona (ADR 0041, 0025). Un agente in cima risponde alle persone che lo usano.

## Conseguenze

- Al primo salvataggio dell'organigramma (anche creando una squadra pronta), i permessi tra agenti messi a mano prima vengono sostituiti da quelli dell'organigramma. Finché l'owner non lo salva, restano come sono.
- Un agente nuovo non è nell'organigramma e non parla con nessuno, nemmeno con chi è a disposizione di tutti, finché l'owner non lo mette da qualche parte e salva.
- Ogni salvataggio porta la versione dell'organigramma letta dalla pagina: se nel frattempo è cambiato (un'altra finestra, una squadra pronta), il salvataggio è rifiutato e la pagina si ricarica, senza cancellare la modifica dell'altro. Un agente eliminato mentre un salvataggio era in corso sparisce alla lettura successiva.
- Le squadre pronte create prima di questo cambio non sono nell'organigramma e hanno ancora il testo della squadra nelle istruzioni: l'owner le aggiunge dalla pagina, e se vuole toglie quelle righe.
- Le richieste tra agenti restano quelle dell'ADR 0042: stessi limiti, stessa catena di al più tre, stessa traccia in Attività.
