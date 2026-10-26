# Owni

Piattaforma open source di agenti sempre attivi per aziende attente a privacy e controllo dei processi: ogni cliente ha i suoi agenti, che parlano con le persone sui canali, usano i sistemi dell'azienda e non fanno nulla di irreversibile senza un'approvazione.

## Esperienza quotidiana

**Conversazioni**:
I canali e i messaggi diretti della persona, nella barra laterale. Non rende visibili le conversazioni di altre persone.

**Messaggio diretto**:
La conversazione continua di una persona con un agente: una sola per agente, sempre la stessa. Vedi ADR 0113.
_Avoid_: nuova chat, DM nei testi per le persone

**Thread di un messaggio**:
Le risposte a un messaggio di un messaggio diretto o di un canale, tenute a parte: l'agente sa a quale messaggio rispondono, e la conversazione principale resta pulita. Vedi ADR 0113.
_Avoid_: risposta citata

**Pannello dell'agente**:
Quello che un agente fa e sa, a destra della conversazione: attività, artifact, routine, memoria, documenti e procedure. La configurazione non ci sta: è una pagina dell'owner. Vedi ADR 0114.
_Avoid_: scheda dell'agente, profilo

**Risposta interattiva**:
Un pezzo di interfaccia dentro la risposta dell'agente, nella console: schede, tabelle, grafici, bottoni da scegliere o un modulo breve. Un click scrive il messaggio successivo nella casella della persona, che lo legge e lo manda. Non è un artifact: quello è una pagina a sé accanto alla conversazione. Vedi ADR 0118.
_Avoid_: widget, generative UI nei testi per le persone

**Lavori**:
L'area degli incarichi e delle automazioni. Si apre sulla Board degli incarichi. Vedi ADR 0115.

**Incarico**:
Una scheda della Board presentata come lavoro da affidare e seguire. Nel codice e nei tool rimane la scheda esistente, con i suoi quattro stati e le regole di revisione.

**Richiede te**:
La pagina con quello che aspetta la persona: le azioni da autorizzare («Da decidere») e gli incarichi di cui accettare il risultato («Da rivedere»). Autorizzare un’azione e accettare un risultato restano azioni distinte. Vedi ADR 0115.
_Avoid_: Autorizzazioni, approvazioni (come nome della pagina)

**Procedure**:
Il nome usato nella configurazione dell’agente per le skill esistenti. Comandi, bozze, import/export SKILL.md e diritti di modifica restano quelli delle skill.

## Chi

**Owner**:
Chi gestisce un tenant: in self-host chi installa Owni (Buildrs o l'IT del cliente), in Owni Cloud chi si registra. Crea istanze e decide cosa possono raggiungere.
_Avoid_: admin, superuser

**Operatore**:
Chi gestisce Owni Cloud per tutti i tenant (Buildrs). Non legge le conversazioni nel lavoro normale; può entrare in una cella come owner solo lasciando traccia nell'audit della cella, e non se l'owner ha la verifica in due passaggi.
_Avoid_: admin, owner

**Tenant**:
Un cliente (azienda, studio o professionista), con dati, segreti, audit e spesa separati da tutti gli altri.
_Avoid_: cliente (nel codice), account, workspace

**Istanza**:
Un agente di un tenant, con il suo modello, le sue conversazioni, i suoi connettori, i suoi file e le sue regole di uscita. Nella console e nei testi per le persone si chiama **agente** (ADR 0041).
_Avoid_: bot, profilo; «istanza» nei testi per le persone

**Agente**:
Un'istanza vista da chi la usa: ha un nome, una faccia (un'emoji), un compito in una riga e un tono, e con loro la sua memoria, i suoi task, file, connettori e bot. Ognuno si presenta con il suo nome. L'owner lo elimina da Impostazioni scrivendone il nome (tranne il principale e la segreteria). Vedi ADR 0041 e 0046.
_Avoid_: bot, assistente (quando si intende uno degli agenti), GPT

**Board**:
La pagina della console con le cose da fare del tenant: schede in quattro colonne (Da fare, In corso, Da rivedere, Fatto), ognuna affidabile a un agente. L'agente ci lavora in una conversazione con chi gliel'ha affidata e la manda in «Da rivedere»; la chiude una persona. Con «Lavora da solo» l'agente va avanti senza aspettare risposte, fino a un tetto di risposte e di tempo. Vedi ADR 0050, 0061.
_Avoid_: kanban (nei testi per le persone), backlog, issue tracker

**Scheda** (della board):
Una cosa da fare sulla board, con numero (#12), titolo, descrizione, priorità, l'agente a cui è affidata e la sua cronologia di spostamenti e commenti. Vedi ADR 0050.
_Avoid_: issue, ticket, card, task (che è un'istruzione programmata)

**Sotto-scheda**:
Una scheda che fa parte di un'altra, un solo livello. Quella che crea l'agente della scheda mentre ci lavora con una persona parte subito con un altro agente, e il risultato torna all'agente della scheda. Vedi ADR 0066.
_Avoid_: sub-task, child card

**Scheda che si ripete**:
Una scheda affidata a un agente che torna ogni giorno, nei feriali, ogni settimana o ogni mese: ogni volta nasce una scheda nuova che parte con la persona che l'ha impostata. Non ne nasce un'altra finché l'ultima è aperta. Diversa dal task programmato, che è un messaggio in chat. Vedi ADR 0069.
_Avoid_: routine, ricorrenza (nel testo per le persone)

**Scadenza (di una scheda)**:
Il giorno, a Roma, entro cui una scheda va fatta. La board dice «scade oggi» o «in ritardo di 3 giorni»; l'agente la riceve con la scheda. Diversa dallo scadenzario, che riguarda le fatture. Vedi ADR 0073.
_Avoid_: deadline, due date (nel testo per le persone)

**Registro di chi segue cosa**:
Il registro del tenant che dice quale agente ha quale record (cliente, fornitore, preventivo, ordine, appuntamento, fattura, DDT), con ID, tipo, scheda collegata e ultima modifica. Partita IVA, codice fiscale e nome sono pseudonimizzati (HMAC con una chiave del tenant): nessun nome né contenuto in chiaro. Serve ad avvisare quando due agenti seguono lo stesso cliente o fornitore. Non è un'anagrafica comune: i record restano nei registri di ogni agente. Vedi ADR 0110.
_Avoid_: anagrafica unica, CRM condiviso, subject ledger (nel testo per le persone)

**Organigramma**:
Come sono organizzati gli agenti dell'installazione, deciso dall'owner nella pagina Organigramma: le squadre con chi le coordina e, per ogni agente, il ruolo, la squadra, a chi risponde, le sue responsabilità e se è a disposizione di tutti. Decide chi può scrivere a chi: la stessa squadra, chi sta sopra e sotto, i coordinatori fra loro. Ogni agente legge il suo posto prima di ogni richiesta. Le persone non ci sono. Vedi ADR 0117.
_Avoid_: org chart, gerarchia, team (nel testo per le persone)

**Responsabilità (di un agente)**:
Una riga breve nell'organigramma che dice cosa è di quell'agente («Preventivi in attesa»). Gli altri agenti la vedono con `agent_list` e gli passano quello che è suo. Al più 10 per agente. Vedi ADR 0117.
_Avoid_: ownership, compito (che è la riga dell'agente)

**Messaggio tra agenti**:
Una richiesta che un agente manda a un altro con `agent_message`, solo se l'organigramma permette al secondo di ricevere messaggi dal primo. La risposta torna dopo, nella conversazione da cui era partita la domanda. Al più tre agenti in fila, senza giri. Se il collega è occupato, il risultato lo dice e la risposta può metterci di più. Vedi ADR 0042 e 0109.
_Avoid_: chat tra bot, handoff, delega

**Richiesta tra agenti da approvare**:
Un passo che un agente chiede a un altro e che serve il sì di una persona: la chiamata esatta aspetta un approvatore dell'agente che la fa, in Approvazioni e nelle chat; approvata parte una volta, e l'esito torna all'agente che l'ha chiesta. Il testo dell'agente che chiede non è mai l'approvazione. Vedi ADR 0108.
_Avoid_: escalation, delega dell'approvazione

**Automazione**:
Un indirizzo segreto di un agente che un altro servizio chiama (il modulo del sito, Stripe, Zapier): ogni chiamata fa partire l'agente con la sua istruzione e i dati ricevuti, per la persona che l'ha creata e nella sua conversazione. Vedi ADR 0060.
_Avoid_: webhook (nei testi per le persone), trigger, integrazione

**Skill**:
Una procedura salvata di un agente: un nome che è anche il comando (`/chiusura-del-mese`), una riga che dice quando usarla e i passi. L'agente vede nomi e righe nelle istruzioni e apre i passi con `skill_read`; una persona la salva dalla chat o dalla console e la lancia con `/nome`. Vedi ADR 0059.
_Avoid_: prompt salvato, macro, template

**Personalità**:
Emoji, compito e tono di un agente, scelti dall'owner; il modello li riceve dopo le istruzioni, in un blocco «Chi sei». Il tono è uno tra naturale, formale, amichevole, conciso e scherzoso (in console «Spiritoso»).
_Avoid_: persona (nei testi per le persone), prompt, carattere

**Utente consentito**:
Una persona che può parlare con un'istanza su un canale. Chi non è nella lista non riceve risposta.
_Avoid_: user, membro

**Approvatore**:
Utente consentito che può approvare le azioni di un'istanza. Nella segreteria è il commerciale.
_Avoid_: admin, supervisore

**Link personale**:
Il link con cui una persona entra nella console web. È la sua chiave: chi lo ha entra come lei. Rigenerarlo chiude le sessioni aperte.
_Avoid_: password, invito

**Console**:
Le pagine web di Owni, per l'owner e le persone. Si apre dal browser o si installa come app (sulla schermata Home o sul desktop, a schermo intero); senza rete l'app mostra solo che è offline, mai dati salvati.
_Avoid_: dashboard, PWA (nei testi per le persone)

**Primi passi**:
La pagina che l'owner trova aprendo la console finché non ha provato Owni: i passi che la rendono utile (modello, istruzioni, primo messaggio, telefono, web, team, app), ciascuno «fatto» quando le impostazioni vere lo dicono. Si nascondono per istanza, in quel browser, e si ritrovano in Impostazioni.
_Avoid_: onboarding, wizard, setup

**Verifica in due passaggi**:
Per chi la attiva, il link personale da solo non basta: serve anche il codice di sei cifre dell'app di autenticazione del telefono (TOTP). L'owner può toglierla a chi ha perso il telefono.
_Avoid_: MFA, OTP (nei testi per le persone)

## Dove gira

**Self-host**:
Owni installata dal cliente sul suo server, gestita dall'Owner.
_Avoid_: on-prem (nei testi per le persone)

**Owni Cloud**:
Owni offerta come servizio da Buildrs: ogni tenant ha la sua cella, con dati in Unione Europea.
_Avoid_: SaaS, versione online

**Cella**:
L'ambiente isolato di un tenant in Owni Cloud: lo stesso Owni del self-host, con il suo disco e separato dagli altri tenant, che si spegne quando non lavora.
_Avoid_: container, pod, istanza (un'istanza è un agente, dentro la cella)

**Control plane**:
La parte di Owni Cloud comune a tutti i tenant: registrazione, pagamento, smistamento dei messaggi alla cella giusta, risveglio delle celle. Inoltra i messaggi senza conservarli.
_Avoid_: backend, piattaforma

**Periodo di prova**:
I primi giorni di un tenant in Owni Cloud, gratuiti. Finiti senza abbonamento, la cella resta spenta con i dati intatti.
_Avoid_: trial, freemium, piano gratuito

**Abbonamento**:
Quello che un tenant paga ogni mese per Owni Cloud dopo la prova: una quota fissa e, se previsto, il consumo del modello.
_Avoid_: piano, licenza, subscription

## Conversazioni

**Canale**:
Un luogo dove le persone parlano con un'istanza: Telegram, WhatsApp, il telefono, l'interfaccia web. Da non confondere con il canale della console, che è una stanza.
_Avoid_: gateway, integrazione

**Thread**:
Una conversazione su un canale: una chat Telegram, una chat nell'interfaccia web.
_Avoid_: sessione, chat (nel codice)

**Squadra pronta**:
Tre agenti creati insieme dalla pagina Agenti, ciascuno con un compito (per esempio Caporedattore, Ricercatore, Scrittore): entrano nell'organigramma come una squadra, il primo la coordina e divide il lavoro, e hanno una stanza. Dopo sono agenti come gli altri. Vedi ADR 0068 e 0117.
_Avoid_: team, modello di agenti

**Stanza**:
Una conversazione della console fra una persona e da 2 a 5 agenti: la persona chiama chi le serve con @nome, ogni agente risponde dal suo posto (una sua conversazione con la persona, nascosta fra le chat) e può chiamarne un altro. Nella console si chiama canale e si legge `#nome`. Vedi ADR 0063 e 0113.
_Avoid_: gruppo (è di Telegram e WhatsApp), room

**Chiamata**:
Una telefonata al numero Twilio di un'istanza, a turni: la persona parla, Owni risponde a voce. Il thread è il numero di chi chiama, quindi una chiamata continua la conversazione delle precedenti.
_Avoid_: sessione vocale

**Risposta**:
Il messaggio con cui un'istanza chiude un messaggio ricevuto. Arriva almeno una volta, e può arrivare due volte dopo un crash.
_Avoid_: output, reply (in italiano)

**Possibile doppione**:
Un messaggio rimandato dopo un crash che la persona potrebbe aver già ricevuto; viene sempre segnalato.

## Capacità

**Tool**:
Un'azione che il modello di un'istanza può chiamare. Può essere integrato, venire da un connettore o essere scritto dall'istanza stessa.
_Avoid_: funzione, skill, plugin

**Connettore**:
Il collegamento configurato tra un'istanza e un sistema esterno (un server MCP, Gmail, HubSpot), con i suoi segreti e i suoi host. Porta dei tool all'istanza.
_Avoid_: integrazione, adapter (fuori dal codice), plugin

**Tool proposto**:
Un tool scritto dall'istanza che non può essere usato finché un approvatore non lo approva.
_Avoid_: tool generato, skill autogenerata

**Workspace**:
I file di un'istanza: quelli che crea, quelli che le persone le caricano, quelli che invia.
_Avoid_: disco, storage, cartella

**Immagine**:
Una foto o un'immagine che l'istanza guarda: quelle che le persone mandano in un messaggio (al massimo 4, fino a 20 MB ciascuna, JPEG, PNG, GIF o WebP riconosciute dal contenuto, rimpicciolite se il modello le vuole più piccole) e quelle del workspace che riapre da sola. Restano nel workspace sotto `uploads/`.
_Avoid_: allegato (è qualunque file), media, vision

**Documento**:
Un PDF, Word, Excel, PowerPoint o OpenDocument nel workspace, di solito mandato da una persona. Owni ne legge il testo con `file_read`: pagine, fogli e diapositive restano distinti, la formattazione no. Una scansione non ha testo da leggere. Vedi ADR 0026.
_Avoid_: allegato (è qualunque file), file binario

**Scansione**:
Un PDF fatto di immagini delle pagine, senza testo: lo scanner dell'ufficio, un fax, una foto salvata in PDF. Owni ne guarda le pagine con `image_view` e legge da sé. Vedi ADR 0028.
_Avoid_: OCR (Owni non fa OCR, guarda), PDF immagine

**Documento creato**:
Un file Word, Excel o PDF che Owni scrive nel workspace con `document_create`, partendo da Markdown o da un CSV: un preventivo, una lettera, un listino, un report. Lo manda con `file_send`. Vedi ADR 0029.
_Avoid_: export, report (il report di ricerca è un'altra cosa, ADR 0022), template

**Grafico**:
Un'immagine PNG a barre, a linee o a torta che Owni disegna con `chart_create` da numeri o da un CSV, in `grafici/`: la manda in chat come una foto o la mette in un documento. Vedi ADR 0030.
_Avoid_: chart, plot, diagramma

**Programma Python**:
Il codice che Owni scrive e fa girare con `code_run` per ogni numero che dà a una persona: un totale, l'IVA, uno sconto, una rata, una domanda a un CSV o a un Excel del workspace (filtri, gruppi, somme per mese). Gira in una sandbox senza rete, senza chiavi e senza il resto del disco; i file che scrive tornano nel workspace. Mai conti a mente. Vedi ADR 0119.
_Avoid_: script, calcolatrice, query, eval

**Registrazione**:
Un file audio o video più lungo di un vocale (una riunione, una chiamata, una lezione) che Owni tiene nel workspace e trascrive con `audio_transcribe`, a pezzi di dieci minuti. Vedi ADR 0033.
_Avoid_: audio lungo, file vocale, recording

**Trascrizione**:
Il file Markdown in `trascrizioni/` con il testo di una registrazione, l'ora di ogni passaggio e, se il servizio le distingue, le voci (Voce 1, Voce 2). Vedi ADR 0033.
_Avoid_: transcript, sbobinatura

**Ricerca nei file**:
Quello che fa `file_search`: le parole chiave della domanda cercate dentro il testo di tutti i file del workspace (documenti, trascrizioni, note) e nei loro nomi, con i passaggi trovati e il punto da cui leggere il seguito. Senza accenti e maiuscole, all'inizio delle parole. Vedi ADR 0035.
_Avoid_: ricerca full-text, indice, grep

**Lista**:
Un elenco che Owni tiene per chi le scrive (la spesa, le cose da fare, i regali), con voci da fare e fatte, numerate come le mostra `list_show`. Di una persona sola, o condivisa con tutti quelli che scrivono all'istanza quando lo chiedono; in un gruppo solo le condivise. Vedi ADR 0038.
_Avoid_: checklist, todo, elenco puntato

**Meteo**:
Quello che dà `weather`: le condizioni di adesso, le fasce di oggi e domani (notte, mattina, pomeriggio, sera) e le previsioni giorno per giorno fino a 16 giorni compreso oggi, per un posto cercato per nome. Acceso dall'operatore con `OWNI_WEATHER`. Vedi ADR 0039.
_Avoid_: previsioni del tempo (quando si intende il tool), forecast

**Cambio BCE**:
Il tasso di riferimento dell'euro pubblicato dalla Banca Centrale Europea nei giorni lavorativi verso le 16:00, che `exchange_rate` usa per convertire importi, oggi o alla data di una fattura. Per un giorno senza pubblicazione vale l'ultimo giorno lavorativo prima. Acceso dall'operatore con `OWNI_EXCHANGE_RATES`. Vedi ADR 0040.
_Avoid_: tasso di mercato, quotazione (quando si intende il cambio BCE)

**Feed di notizie**:
Il file RSS o Atom pubblico di un giornale, da cui `news_headlines` prende i titoli recenti con fonte, ora e link. La lista la sceglie l'operatore (`OWNI_NEWS_FEEDS`), con una di partenza; acceso con `OWNI_NEWS`. Vedi ADR 0043.
_Avoid_: notiziario, rassegna stampa (quando si intendono i titoli dei feed)

**VIES**:
Il servizio della Commissione europea che dice se un numero IVA è attivo per gli scambi intra-UE, con nome e indirizzo quando il paese li dà; `vat_check` lo usa con `OWNI_VAT_CHECK`. «Non attiva nel VIES» non vuol dire che la partita IVA non esista. Vedi ADR 0047.
_Avoid_: registro delle partite IVA, anagrafe tributaria

**Scadenza fine mese**:
Una scadenza di fattura come «60 gg d.f.f.m.»: Owni conta i giorni dalla data fattura e poi va all'ultimo giorno del mese; alcuni gestionali contano invece a mesi, e `date_calc` dà anche quella data quando è diversa. Una scadenza festiva non viene spostata. Vedi ADR 0048.
_Avoid_: fine mese commerciale, scadenza a 30 giorni come mese

**Partita IVA da ricontrollare**:
Una partita IVA scritta dal cliente in una mail che non supera il controllo formale: la segreteria non la salva e nella bozza chiede di ricontrollarla (dato mancante `vatNumberInvalid`). Non usa il VIES. Vedi ADR 0049.
_Avoid_: partita IVA inesistente, partita IVA non attiva

**Fattura elettronica**:
Il file XML FatturaPA che passa dallo SdI, a volte firmato come `.xml.p7m`; Owni lo legge come un documento e ne fa un riepilogo in italiano, senza verificare la firma. La scadenza che conta è quella scritta in fattura. Vedi ADR 0052.
_Avoid_: e-fattura, XML della fattura, fattura digitale

**Scadenzario**:
L'elenco delle rate delle fatture elettroniche del workspace, da pagare o da incassare, con le scadute e quelle segnate pagate; lo tiene lo strumento `invoices`. Le note di credito si tolgono dal dovuto. Vedi ADR 0053.
_Avoid_: agenda dei pagamenti, prima nota

**Sollecito**:
La mail che chiede a un cliente di pagare fatture scadute, in tre livelli: promemoria, secondo sollecito, sollecito formale (costituzione in mora). Owni la prepara con `invoices` op `reminder`, la manda solo dopo l'approvazione e la annota nello scadenzario. Vedi ADR 0054.
_Avoid_: diffida, recupero crediti

**Preventivo**:
L'offerta numerata a un cliente, con righe, IVA, validità e riquadro per l'accettazione, fatta con lo strumento `quotes` e salvata in PDF o Word nel workspace. Una revisione tiene il numero (`2026-012-R1`). Vedi ADR 0055.
_Avoid_: offerta, quotazione

**Allegato**:
Un file del workspace mandato con una mail di Owni (preventivo, fattura, documento). La card di approvazione mostra percorso e dimensione; all'approvazione il file deve essere identico a quello chiesto. Vedi ADR 0056.
_Avoid_: attachment

**Spesa**:
Un costo registrato con `expenses` (S-AAAA-NNNN): data, totale IVA compresa, IVA, fornitore, categoria, pagamento e, se c'è, lo scontrino nel workspace. La **prima nota** mette in fila le spese e gli incassi delle fatture pagate con il saldo. Vedi ADR 0057.
_Avoid_: expense, costo, uscita (per la singola spesa)

**Voce di ore**:
Un tempo di lavoro registrato con `timesheet` (O-AAAA-NNNN): cliente, progetto, data, minuti, attività e se è fatturabile. Può essere da fatturare, nel preventivo N o fatturata con un riferimento. Vedi ADR 0058.
_Avoid_: timesheet entry, ora (per la voce)

**Rinnovo**:
Un costo o un contratto che torna a ogni periodo (abbonamento, polizza, dominio, affitto), registrato con `renewals` (R-NNNN): importo, frequenza, prossima scadenza, se si rinnova da solo (`auto_renew`), se si paga da solo (`auto_pay`) e la data entro cui disdire. Vedi ADR 0064.
_Avoid_: renewal, subscription

**Voce di cassa**:
Un movimento che la persona dice a Owni per la previsione di cassa, registrato con `cashflow` (C-NNNN): entrata o uscita, importo, data, una volta o ricorrente (ogni N mesi o ogni N giorni), fino a quando. Serve per quello che non sta in fatture, rinnovi o spese: tasse e F24, prelievi, rate di prestiti, entrate senza fattura. Vedi ADR 0065.
_Avoid_: cashflow item, movimento (per la voce)

**Profilo fiscale**:
Come è tassata una persona nel regime forfettario, salvato con `taxes`: coefficiente di redditività (dal gruppo o dal codice ATECO), imposta al 15% o al 5%, anno di inizio, cassa previdenziale (gestione separata, artigiani, commercianti, cassa professionale) e le cifre dette dell'anno prima. Le aliquote dell'anno non stanno nel profilo. Vedi ADR 0070.
_Avoid_: tax profile, regime (per il profilo)

**Scheda cliente**:
Quello che la persona dice a Owni di un cliente, salvato con `clients` (CL-NNNN): nome, partita IVA o codice fiscale, referenti con canale preferito, note, etichette e ricontatti. Fatturato, incassato, solleciti, preventivi e ore non stanno nella scheda: si leggono dai loro registri. Vedi ADR 0071.
_Avoid_: CRM, anagrafica, contatto (per la scheda)

**Ricontatto**:
Un cliente da risentire in un giorno, registrato su una scheda cliente (FU-NNNN), con un promemoria alle 9 di quel giorno. Si sposta, si toglie o si segna fatto. Vedi ADR 0071.
_Avoid_: follow-up, task (per il ricontatto)

**Fattura in uscita**:
Una fattura elettronica che Owni prepara per la persona con `sales_invoices`: prima una bozza (BZ-NNNN) senza numero, poi, dopo il sì, il numero dell'anno, l'XML in `fatture/emesse/` e la copia di cortesia in PDF. Non viene mandata allo SdI: la persona la carica sul portale. Vedi ADR 0072.
_Avoid_: invoice, fattura emessa (per la bozza)

**Liquidazione IVA**:
Il conto che chi è in regime ordinario fa ogni mese o trimestre: IVA delle fatture emesse meno quella detraibile delle fatture ricevute, più il credito o il saldo che passa dal periodo prima. Se è a debito si versa con l'F24. Owni la stima con `vat_settlement`. Vedi ADR 0077.
_Avoid_: VAT settlement, dichiarazione (per la liquidazione periodica)

**Estratto conto**:
Il file con i movimenti del conto che la banca dà (CSV, Excel o CAMT.053). Owni lo legge con `bank_statement` e spiega ogni movimento; l'abbinamento a una fattura, una spesa, un rinnovo o un F24 è sicuro o debole (solo l'importo) e cambia gli altri registri solo dopo un sì. Vedi ADR 0078.
_Avoid_: bank statement, movimenti bancari (per il file)

**Margine**:
Nell'andamento dell'attività, gli incassi meno le spese dello stesso periodo, per cassa. Per il forfettario, tolte le tasse stimate, è quanto «ti resta in tasca»; per l'ordinario Owni dice solo quanto resta dopo l'IVA, prima di IRPEF e contributi. Lo calcola `business_report`. Vedi ADR 0080.
_Avoid_: profitto, utile (per il margine per cassa)

**Ritenuta d'acconto**:
La parte del compenso (di solito il 20% dell'imponibile; per gli agenti il 23% sul 50% o sul 20% delle provvigioni) che il cliente sostituto d'imposta trattiene e versa allo Stato con l'F24, codice 1040, entro il 16 del mese dopo il pagamento. Per chi è in regime ordinario è un credito nella dichiarazione dell'anno in cui il cliente paga; nel forfettario non c'è. Owni la segue con `withholding`, leggendo le fatture in uscita e gli XML del workspace.
_Avoid_: withholding tax, trattenuta (per la ritenuta)

**CU (Certificazione Unica)**:
Il documento con cui il cliente certifica, entro il 16 marzo dell'anno dopo, i compensi pagati e le ritenute trattenute. La persona dice a Owni i due importi, Owni li salva (CU-NNNN, da togliere con lo stesso codice se detta per sbaglio) e li confronta con le sue fatture, spiegando la differenza quando può. L'anno della CU è quello dei pagamenti: la CU 2026 certifica i compensi del 2025.
_Avoid_: certificazione dei compensi, 770 (per la CU)

**Agenda fiscale**:
Tutte le scadenze di chi ha la partita IVA in una lista sola, in ordine di data: gli F24 di tasse e IVA, le CU, i rinnovi, le fatture da pagare e le scadenze di legge (dichiarazioni, LIPE, diritto camerale, bollo). Owni non la salva: la legge ogni volta dai registri e la può esportare in un file .ics. Vedi ADR 0083.
_Avoid_: scadenziario fiscale, calendario delle tasse (per l'agenda fiscale)

**Listino**:
L'elenco di quello che la persona vende, servizi e prodotti, ognuno una voce con prezzo, unità e IVA (LS-NNNN, con un codice suo se vuole). Preventivi, fatture in uscita e ore da fatturare prendono il prezzo da lì; un nome che può essere più voci si chiede. Vedi ADR 0084.
_Avoid_: catalogo, tariffario (per il listino)

**Scheda del fornitore**:
Quello che Owni sa di chi la persona paga (FO-NNNN): note, referenti e IBAN o partita IVA solo come li dice la persona; spesa, fatture aperte, giorni di pagamento e abbonamenti letti ogni volta dai registri. Un IBAN da pagare diverso da quelli già pagati si verifica per telefono prima di pagare. Vedi ADR 0085.
_Avoid_: anagrafica fornitore, vendor (per la scheda del fornitore)

**Budget**:
Un limite di spesa che la persona si dà (BU-NNNN) su una categoria, un fornitore o tutte le spese, per mese, trimestre o anno; o un obiettivo di fatturato o incassato. Owni lo segue dai registri e avvisa una volta quando passa l'80% e il 100%. Vedi ADR 0086.
_Avoid_: tetto di spesa, target (per il budget)

**Fattura ricorrente**:
Un canone che la persona fattura sempre allo stesso cliente (RI-NNNN) ogni mese, bimestre, trimestre, semestre o anno; Owni ne prepara la bozza a ogni periodo e avvisa, l'emissione resta della persona. Vedi ADR 0087.
_Avoid_: abbonamento (per i canoni che fattura la persona: gli abbonamenti che paga sono i rinnovi)

**Origine del turno**:
Da dove nasce un turno di Owni: un messaggio della persona, un avviso, un'attività programmata o un altro agente. Le azioni che non si annullano si confermano solo nei turni della persona. Vedi ADR 0088.
_Avoid_: mittente (per l'origine)

**Articolo di magazzino**:
Una cosa che la persona tiene in magazzino (MG-NNNN), con la sua unità, il minimo sotto cui avvisare e i movimenti (carico, scarico, rettifica) da cui Owni ricava quanto ne resta e quanto vale al costo medio. Vedi ADR 0089.
_Avoid_: prodotto (per l'articolo; il prezzo è la voce del listino)

**Prezzo d'acquisto**:
Quanto la persona paga un prodotto a un fornitore, letto dalle righe delle sue fatture: senza IVA, per unità, con gli sconti della fattura divisi sulle righe. Il prezzo a cui vende è la voce del listino. Vedi ADR 0090.
_Avoid_: costo (per il prezzo d'acquisto; il costo medio è quello del magazzino)

**Margini**:
Quanto la persona guadagna davvero su un prodotto o un cliente: il ricavo senza IVA delle fatture emesse meno il costo della merce venduta, al costo medio del magazzino al momento di ogni vendita. Un costo trovato solo dal nome è una stima, mai una perdita. Owni li ricava ogni volta dai registri, senza salvarli. Vedi ADR 0091.
_Avoid_: utile, guadagno netto (i margini non tolgono spese e tasse; quello è l'andamento dell'attività)

**Ordine al fornitore**:
Quello che la persona ordina a un fornitore (OR-NNNN), riga per riga sugli articoli del magazzino, con il prezzo atteso. È una bozza finché la persona non dice di averlo mandato; arriva in parte o tutto secondo le ricevute: le righe delle fatture caricate, la merce arrivata con la bolla, quella già in magazzino. Owni non lo manda mai. Vedi ADR 0092.
_Avoid_: acquisto (per l'ordine; l'acquisto è la fattura ricevuta), bolla (la bolla è come arriva la merce, non l'ordine)

**DDT (documento di trasporto)**:
Il documento con cui la persona spedisce merce a un cliente (DT-NNNN finché è una bozza, poi «12/2026»), riga per riga, senza prezzi, con la causale e chi fa il trasporto. Emesso, scarica il magazzino (un reso rimette la merce del DDT da cui torna); non si cancella, si annulla tenendo il numero. Vedi ADR 0093.
_Avoid_: bolla (per i DDT che fa la persona; la bolla è quella del fornitore che accompagna la merce in arrivo)

**Fattura differita**:
La fattura (tipo TD24) che a fine mese raccoglie i DDT di vendita di un cliente di quel mese, al netto dei resi, con i loro riferimenti (DatiDDT); va emessa entro il 15 del mese dopo, e la sua IVA va nel mese dei DDT. Non scarica il magazzino, perché la merce è uscita con i DDT; i DDT risultano fatturati solo quando è emessa. Vedi ADR 0093.
_Avoid_: fattura riepilogativa

**Appuntamento**:
Un cliente che viene per uno o più servizi in un giorno e a un'ora, con la sua durata e, se ci sono, la risorsa che lo fa (una persona, una poltrona, un ponte). Fissato, fatto, disdetto o non presentato; non si cancella mai. Si fattura quando è fatto, segnato fatturato solo all'emissione. Non è una scadenza dell'agenda fiscale né un promemoria di Owni. Vedi ADR 0094.
_Avoid_: prenotazione (per il dato salvato; «prenotare» va bene come verbo), evento (quello è il calendario Google)

**Personale**:
Le persone che lavorano nell'attività (PE-NNNN, mai detto), con ruolo, ore del contratto, la settimana solita, ferie e permessi dell'anno, e se c'è la risorsa degli appuntamenti che sono. Non sono utenti di Owni né agenti del board. Ha il primo e l'ultimo giorno in forza; chi se ne va si archivia, non si cancella. Si aggiunge solo quando è detta nuova, o quando se ne dice qualcosa e nessuno ha quel nome. Vedi ADR 0095.
_Avoid_: dipendenti (per il dato salvato; va bene come parola), utenti, membri

**Assenza**:
Un periodo in cui una persona del personale non lavora: ferie (giorni o mezza giornata), permesso (ore), malattia (giorni, solo il protocollo, mai la diagnosi) o altro (un motivo dalla lista chiusa: lutto, congedo, 104…). Non ha note libere. Si cambia o si annulla, e annullata resta nello storico. Blocca la sua risorsa negli appuntamenti. Vedi ADR 0095.
_Avoid_: chiusura (quella è dell'attività), ferie (per tutte le assenze)

**Turno**:
Le ore in cui una persona del personale lavora in un giorno: dalla settimana solita, o detto a parte per quel giorno, meno le assenze e le chiusure. Le ore in cui l'attività è aperta e nessuno è di turno sono scoperte. Vedi ADR 0095.
_Avoid_: orario (quello è dell'attività), slot

**Download**:
Un file del web salvato da Owni nel workspace, sotto `download/`, con `web_download`: per leggerlo tutto o mandarlo. Solo dai siti consentiti, fino a 20 MB. Vedi ADR 0027.
_Avoid_: allegato, scaricamento

**Task programmato**:
Un'istruzione che un'istanza esegue da sola a un'ora stabilita, una volta o a ripetizione, consegnando il risultato a un thread.
_Avoid_: cron, job, promemoria, routine

**Memoria**:
Le cose che un'istanza ricorda di una persona tra una conversazione e l'altra, su sua richiesta o perché la persona le ha dette; valgono solo quando parla con lei da sola, e la persona le vede, le aggiunge e le cancella. Una memoria condivisa vale per tutti quelli che scrivono all'istanza e la gestisce solo l'owner. Le memorie essenziali arrivano con ogni messaggio; quelle in **archivio** si cercano con `memory_search` quando servono (ADR 0062).
_Avoid_: profilo, contesto, knowledge base

**Account collegato**:
Un account esterno di una persona (oggi Google) che le istanze leggono per lei, solo nelle sue conversazioni e solo dove l'owner lo consente. Diverso da un connettore, che appartiene a un'istanza.
_Avoid_: integrazione, connettore personale

**Siti consentiti**:
I siti che un'istanza può leggere, fotografare e navigare con il browser, scelti dall'owner; tutto il resto, e qualunque indirizzo interno, le è negato.
_Avoid_: whitelist, domini, navigazione libera

**Ricerca sul web**:
La ricerca che un'istanza fa con il servizio di ricerca del server (Brave Search) per notizie, prezzi e fatti che cambiano: titoli, indirizzi ed estratti, che apre poi con la lettura dai siti consentiti. La accende l'owner istanza per istanza; al servizio vanno solo le parole cercate.
_Avoid_: Google, motore, browsing

**Risposta a voce**:
Una risposta che arriva su Telegram o WhatsApp come messaggio vocale, con il testo accanto. Di norma a chi ha mandato un vocale; ogni persona può chiedere «sempre» o «mai». Nella console, invece, ogni risposta si ascolta con «Ascolta», dalla voce del dispositivo.
_Avoid_: TTS, sintesi vocale (nei testi per le persone)

**Sentinella**:
Una pagina che un'istanza controlla da sola ogni tanto (da 30 minuti a una settimana), per una conversazione: tutta la pagina, la parte vicino a una frase, o un prezzo con una soglia sotto o sopra. Scrive nella conversazione solo quando qualcosa è cambiato, una volta per cambiamento; legge solo dai siti consentiti.
_Avoid_: watcher, monitor, alert

**Browser**:
La pagina web che un'istanza tiene aperta per una conversazione, dove clicca e scrive per usare siti costruiti in JavaScript. Legge e basta: quello che invia passa da un'azione sul web. Gira nella cella, non nel computer. Nella console si vede e si guida dal pannello «Browser» accanto alla chat.
_Avoid_: computer, automazione del browser, agente web

**Immagine su richiesta**:
Un'immagine che Owni crea da una descrizione o ritoccando una foto che le hanno mandato, con il servizio di immagini dell'operatore, solo nelle istanze dove l'owner lo consente. Arriva in chat e resta in `immagini/` del workspace.
_Avoid_: AI art, generazione

**Report di ricerca**:
Il file Markdown che Owni scrive quando le chiedono di approfondire un tema: più ricerche, le pagine migliori dei siti consentiti, e un testo dove ogni fatto rimanda a una fonte numerata del suo dossier. L'elenco delle fonti lo scrive il codice, non il modello.
_Avoid_: deep research, ricerca profonda

**Richiesta Google**:
Una mail, una risposta, una bozza o un evento che Owni prepara sul Google di chi le scrive dalla console, e che succede solo quando quella persona la approva dalla card in chat o in Approvazioni. Una volta sola; l'esito torna nella conversazione.
_Avoid_: azione Google, automazione

**Azione sul web**:
L'invio di un modulo di un sito consentito che l'istanza chiede e che parte solo dopo che chi l'ha chiesta, o un approvatore, ha letto destinazione e valori e l'ha approvato. Una volta sola; l'esito torna nella conversazione.
_Avoid_: automazione, bot, compilazione automatica

**Computer**:
La macchina di un'istanza, separata dalla cella, senza rete e senza segreti, dove l'istanza esegue comandi su copie dei file del workspace e rimette lì quelli che produce. Un container sul server di Owni o una micro-VM su Fly.io; in Owni Cloud sempre una micro-VM, raggiunta attraverso il control plane. La accende l'owner; i suoi file restano finché l'owner non la azzera.
_Avoid_: sandbox (è quella dei tool proposti), VM, server

**Schermo**:
Il desktop Linux di un agente, con Firefox, dove l'agente guarda lo schermo, clicca, scrive e apre programmi attraverso Cua. Un container sul server di Owni, senza internet se l'operatore non sceglie altrimenti, oppure un desktop che gira altrove e che tutti gli agenti che lo usano condividono. Lo accende l'owner agente per agente. Quello che l'agente fa sullo schermo non passa dalle approvazioni, e con internet il suo browser non segue i siti consentiti: prima di inviare o pagare chiede in chat. Nella console, accanto alla chat, il pannello Schermo mostra l'ultima schermata che l'agente ha preso in quella conversazione (ADR 0067).
_Avoid_: computer (è il terminale senza rete), browser (è quello della cella), desktop remoto, VNC

**Brief del mattino**:
Il task programmato di una persona che ogni mattina le riassume impegni del giorno, mail che chiedono una risposta e quello che l'istanza ricorda di lei, leggendo senza cambiare niente.
_Avoid_: digest, report giornaliero, newsletter

## Controllo

**Egress policy**:
L'elenco di ciò che un'istanza può raggiungere: provider di modelli, canali, connettori. Tutto il resto è negato.
_Avoid_: firewall, whitelist

**Approvazione**:
La decisione di un approvatore su un'azione che l'istanza non può compiere da sola: inviare una mail, attivare un tool proposto, inviare un modulo sul web (questa la può decidere anche chi l'ha chiesta, nella sua conversazione privata). Le richieste sul Google di una persona le decide solo lei.
_Avoid_: conferma, ok

**Audit**:
Il registro, per tenant, di ciò che è successo: accessi negati, invii, approvazioni, spese. Non contiene mai il testo dei messaggi.
_Avoid_: log

**Tetto di spesa**:
Il limite giornaliero di spesa in modelli di un tenant: oltre quello soft si avvisa, oltre quello hard si smette di chiamare il modello.
_Avoid_: budget, quota

## Segreteria commerciale

**Segreteria**:
Il primo caso d'uso: un'istanza che legge le richieste di preventivo arrivate per email, prepara il lead e la bozza di risposta e aspetta l'approvazione del commerciale.

**Pratica**:
Una richiesta di preventivo arrivata per email e tutto quello che ne segue, dalla lettura all'invio o allo scarto.
_Avoid_: ticket, caso, lead (il lead è nel CRM)

**Bozza**:
La risposta al cliente preparata dall'istanza. Ha una versione che cresce a ogni modifica e non parte senza approvazione.
_Avoid_: draft (in italiano), proposta

**Scheda** (della segreteria):
Il messaggio a un approvatore con la pratica, la bozza e i pulsanti Approva, Modifica, Scarta.
_Avoid_: notifica (quando ha pulsanti), card

**Connettore in un clic**:
Un servizio del catalogo (Notion, Linear, Jira, Stripe, GitHub e altri) che l'owner collega dalla pagina Connettori entrando con il suo account, o incollando un token. L'accesso resta sul server di Owni e si rinnova da solo; quando non si rinnova il connettore è «Da collegare». Vedi ADR 0024.
_Avoid_: integrazione, plugin, app

**Collegamento API**:
Un connettore verso l'API di un servizio senza server MCP (un gestionale, un CRM, l'API interna): l'owner dà l'indirizzo base, come si entra, la chiave e cosa sa fare. L'agente legge subito e per scrivere chiede l'approvazione; la chiave è solo di quell'agente e non arriva mai al modello. Vedi ADR 0116.
_Avoid_: webhook, integrazione, http tool

**Azione di un connettore**:
Una chiamata a uno strumento di un servizio collegato che cambia qualcosa (crea, modifica, cancella). Owni la prepara come richiesta; parte, una volta, solo quando chi l'ha chiesta o un approvatore la approva. Gli strumenti che il servizio indica come di sola lettura partono subito. Vedi ADR 0025.
_Avoid_: tool call, operazione

**Richiesta scaduta**:
Una richiesta da approvare (modulo, mail o evento Google, azione di un connettore) che nessuno ha approvato o rifiutato entro 24 ore. Non viene mai fatta; la conversazione che l'ha chiesta riceve un avviso, una volta. Vedi week31.md.
_Avoid_: richiesta annullata, timeout
