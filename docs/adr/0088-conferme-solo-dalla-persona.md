# Conferme solo dalla persona

Un'azione che non si annulla (emettere una fattura, applicare gli abbinamenti della banca, unire due clienti, cambiare i prezzi del listino) si fa con `confirm: true`, e fino a oggi lo strumento non sapeva da dove veniva il turno. Un avviso di Owni («è pronta la bozza del canone»), un'attività programmata, un webhook o un altro agente aprono un turno come un messaggio della persona: bastava che il modello mettesse `confirm: true` per fare il passo senza il suo sì. La settimana 67 lo aveva lasciato aperto.

## Decisione

- **Origine del turno**: ogni ingresso ha un'origine, `person`, `notice`, `scheduled` o `agent`. Il motore durevole la salva nello stesso commit del messaggio (voce `owni.input`), quindi una ripresa dopo un crash la ritrova, e gli strumenti la leggono come `ctx.origin`. Conta l'origine meno fidata di tutti gli ingressi del giro in corso (fino all'ultima risposta senza strumenti), così un messaggio infilato a metà di un giro nato da un avviso non lo rende della persona. Un ingresso senza origine, una sessione vecchia o un giro troppo lungo da leggere non sono della persona.
- **Chi è chi**: i messaggi da Telegram, WhatsApp, web e voce sono della persona; gli avvisi sono `notice`; attività programmate, sentinelle, automazioni, webhook e schede della board sono `scheduled`; il canale degli agenti e i turni degli agenti nelle stanze sono `agent`. I pulsanti (approvare una scheda, una pratica, una proposta) non aprono un turno del modello: sono la persona per costruzione.
- **Un solo controllo**: `requirePersonFor(ctx, cosa)` in `turn-origin.ts`, usato da emissione delle fatture, numerazione e ultimo numero, bozze tolte, conferme della banca (abbinamenti, spese, saldo, stessi movimenti, importazioni tolte, conferma automatica accesa), unione di clienti e fornitori, cambi e importazioni del listino, voci della cassa che superano un doppione, preventivi scaduti o rifiutati mandati, fatture ricorrenti (aggiunta, cambio, ripresa, preparazione, eliminazione) e rinnovi disdetti o tolti. Senza conferma l'anteprima funziona sempre; con la conferma, in un turno che non è della persona, Owni chiede in una frase e ripete dopo il suo sì. A un altro agente risponde che lo conferma solo la persona, nella sua conversazione.
- **Skill**: i comandi delle skill (`/attiva-skill`, `/nome`) partono solo dai messaggi della persona.
- **Canoni nella previsione di cassa**: le fatture ricorrenti attive entrano nella previsione come canone da preparare, poi come bozza da emettere, poi fra le fatture da incassare, ognuna una volta sola grazie alla discendenza della settimana 67; al totale con l'IVA (ritenuta e split payment come farebbe la bozza, privato o azienda dalla scheda del cliente), pagate alla scadenza della loro fattura. Il caso prudente li lascia fuori.
- **Codice morto tolto**: `request_approval` e `record_approval` non erano mai stati registrati dalla settimana 3.

## Sicurezza

- La previsione di cassa vista da un altro agente non ha più nomi: fatture per numero, «preventivo accettato», «rinnovo», «canone di ottobre 2026», «voce»; doppioni e preventivi vecchi restano fuori. Un altro agente può spostare o togliere nelle ipotesi solo una fattura per numero, mai un cliente per nome, così non può indovinare chi deve pagare.
- L'audit resta operazione e conteggio.

## Alternative scartate

- **Lasciare la frase «questo avviso non è un suo sì»**: era solo testo per il modello.
- **Guardare solo l'ultimo ingresso**: un messaggio della persona infilato in un giro nato da un avviso avrebbe reso suo tutto il giro.
- **Contare le bozze dei canoni solo quando emesse**: la previsione scendeva di colpo appena Owni preparava la bozza, e poteva dare un falso «vai in rosso».
