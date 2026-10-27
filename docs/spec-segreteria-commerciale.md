# Spec: segreteria commerciale su Telegram (settimana 3)

> Storico: la segreteria commerciale è stata tolta ([ADR 0126](adr/0126-togliere-la-segreteria-commerciale.md)). Questo documento descrive com'era.

> Deliverable di Craft per Ship (codice) e AI Guru (stack agenti). Nessun codice in questo documento. Commit e PR: Ship. Decisioni A1-A8 integrate.

Architettura: [`architettura.md`](architettura.md). Settimana 2: [`week2.md`](week2.md). Piano e nota vault: `Active/Projects/Owni/`.

## 1. Caso d'uso e cliente tipo

**Nome del caso.** Segreteria commerciale su Telegram.

**Cliente tipo.** PMI italiana da 5 a 50 milioni di fatturato (ICP Buildrs): studio professionale, distributore, e-commerce B2B o produttore con ufficio commerciale di 1-5 persone. Il commerciale (o il titolare) vive già su Telegram; la mail aziendale è Gmail Workspace o Microsoft 365; il CRM è spesso assente o poco usato. Il dolore è la coda di richieste di preventivo che restano senza risposta o ricevono risposte lente e disomogenee.

**Cosa vende Owni qui.** Un'istanza dedicata che legge la casella delle richieste, crea o aggiorna il lead nel CRM, prepara una bozza in italiano e chiede al commerciale di approvare su Telegram prima di qualsiasi invio. Tempo risparmiato misurabile, rischio basso (human-in-the-loop), privacy rispettata (tenant isolato, egress default deny).

**Policy di prodotto (SLA pilota).** «Bozze, non invii autonomi.» Qualsiasi percorso che chiama l'invio mail senza un tap esplicito su **Approva** da un utente in allowlist è un bug bloccante. Il commerciale resta responsabile del testo inviato al cliente finale.

**Attori.**

| Ruolo | Chi | Canale |
|---|---|---|
| Cliente finale | Chi ha scritto la mail di richiesta | Solo mail (riceve la risposta approvata) |
| Commerciale | Utente in allowlist Telegram dell'istanza | Telegram |
| Owner | Mario / IT del cliente | Config (oggi env e file; poi dashboard) |
| Owni | Istanza `segreteria-commerciale` del tenant | Motore + adapter mail, CRM, Telegram |

**Registro linguistico e prompt di istanza.**

- **Bozza al cliente finale:** nella **lingua del cliente** (A1). Default italiano. Se `originalLanguage` è `en`, la bozza è in inglese formale; se è `it`, `it+en` o incerto, default italiano. In italiano il registro è **lei**; in inglese è il formale (Dear Mr./Ms.).
- **Scheda e messaggi Telegram al commerciale:** sempre in **italiano**, **tu** professionale (A1), anche se la mail e la bozza sono in un'altra lingua.
- **Non inventare mai prezzi**, disponibilità, sconti o impegni di consegna. Se nella mail o nel catalogo (sola lettura) mancano dati necessari al preventivo, la bozza **chiede** quei dati al cliente finale invece di colmare il vuoto.
- Se il cliente ha già citato un prezzo nella mail, la bozza non ne introduce altri e non lo contraddice senza istruzione del commerciale.
- **PII in bozza (A7):** la bozza ripete solo nome (con eventuale titolo) e azienda. Non ripete mai cellulare personale, indirizzo, IBAN, codice fiscale o data di nascita, anche se presenti nella mail.

## 2. Flusso end-to-end

```text
Mail di richiesta preventivo
        |
        v
Adapter mail (polling o push)  -->  classificazione (Haiku)
        |
        |- spam / non-preventivo --> notifica leggera + solo Scarta (o Approva = forza)
        |- preventivo --> pratica (Document durable)
                |- estrazione lead (Haiku)
                |- create/update lead via adapter CRM
                |- bozza risposta lei (Sonnet)
                        |
                        v
                Telegram al commerciale (allowlist)
                  notifica + scheda lead + bozza
                  bottoni: Approva | Modifica | Scarta
                        |
                        |- Approva  -->  adapter mail: invio  -->  CRM: esito  -->  conferma
                        |- Modifica -->  testo in chat  -->  nuova bozza  -->  di nuovo i bottoni
                        |- Scarta   -->  CRM: scartata  -->  conferma; nessun invio
```

**Regola d'oro.** Nessun messaggio esce verso il cliente finale senza un tap esplicito su **Approva**. `send_email` è un tool `replaySafe: false`: dopo un crash a metà non si reinvia da solo.

Su Telegram ci sono **sempre e solo tre pulsanti**: Approva, Modifica, Scarta. Nessun quarto bottone. Nello stato di invio fallito, Approva significa «ritentare l'invio della bozza corrente».

Stato minimo della pratica (Document Pi, per istanza):

```ts
type PraticaStatus =
  | "received"
  | "classified_skip" // spam (bottoni) o non_commerciale (solo avviso)
  | "lead_upserted"
  | "draft_ready"
  | "awaiting_edit"
  | "approved"
  | "sent"
  | "discarded"
  | "failed";

type Pratica = {
  praticaId: string;
  tenantId: string;
  instanceId: string;
  status: PraticaStatus;
  mailMessageId: string;
  mailThreadId?: string;
  inReplyToPraticaId?: string;
  lead: LeadFields;
  missingFields: string[];
  crmLeadId?: string;
  draftSubject: string;
  draftBody: string;
  draftVersion: number;
  approvedBy?: string;
  approvedAt?: string;
  sentMessageId?: string;
  lastError?: { code: string; message: string; at: string };
};
```

## 3. Conversazioni Telegram (testo esatto)

Convenzioni:

- Un commerciale = un `userId` Telegram in allowlist. Messaggi da altri: silenzio + audit `user.denied` (week2).
- Ogni pratica cita sempre `Pratica #<id-corto>` (8 caratteri).
- I bottoni sono callback. **Solo tre**, sempre: Approva, Modifica, Scarta. Tap da fuori allowlist: ignorato.
- Possibile doppione di notifica (outbox at-least-once): stessa scheda con la riga «Possibile doppione di notifica: ignora se hai già risposto.» e gli stessi `callback_data` idempotenti.

### 3.1 Notifica nuova richiesta

```
Nuova richiesta di preventivo · Pratica #a1b2c3d4

Da: Marta Bianchi <marta.bianchi@acme.it>
Oggetto: Richiesta preventivo stampante industriale
Ricevuta: 15 ott 2026, 14:32

Riassunto: chiede preventivo per 2 stampanti UV formato 60x90, consegna indicativa entro novembre, budget non dichiarato.

Lead aggiornato nel CRM: Marta Bianchi · Acme Srl (nuovo contatto).
```

### 3.2 Scheda lead + bozza + bottoni

```
Scheda lead · Pratica #a1b2c3d4

Nome: Marta Bianchi
Azienda: Acme Srl
Email: marta.bianchi@acme.it
Telefono: -
Prodotto/servizio: stampante UV 60x90 x 2
Urgenza: entro novembre
Dati mancanti: budget, sede di installazione
Note: budget non dichiarato

- Bozza v1 (lei) -

Oggetto: Re: Richiesta preventivo stampanti UV

Gentile Signora Bianchi,

la ringraziamo per la richiesta. Abbiamo preso in carico la domanda relativa a due stampanti UV formato 60x90, con consegna indicativa entro novembre.

Per prepararle un preventivo accurato, può indicarci la sede di installazione e se ha un intervallo di budget di riferimento?

Restiamo a disposizione.
Cordiali saluti
[Nome commerciale] · [Azienda]

- Fine bozza -

[ Approva ]  [ Modifica ]  [ Scarta ]
```

### 3.3 Approva → conferma d'invio

```
Invio in corso · Pratica #a1b2c3d4
Bozza v1 approvata da te. Sto inviando la mail a marta.bianchi@acme.it.
```

Se l'invio riesce:

```
Inviata · Pratica #a1b2c3d4

A: Marta Bianchi <marta.bianchi@acme.it>
Oggetto: Re: Richiesta preventivo stampanti UV
Ora: 15 ott 2026, 14:41
CRM: esito «risposta inviata» registrato sul lead.
```

I bottoni della bozza si disattivano. Un tap successivo:

```
Questa pratica è già chiusa (inviata). Non posso cambiare l'esito da qui.
```

### 3.4 Modifica in linea

Dopo Modifica:

```
Modifica · Pratica #a1b2c3d4

Scrivi qui sotto come vuoi cambiare la bozza (tono, contenuti, dati mancanti). Puoi anche incollare il testo intero da usare al posto della bozza.
Per annullare senza cambiare nulla, scrivi: annulla modifica
```

Esempio commerciale: `Togli la domanda sul budget. Aggiungi che il sopralluogo in sede è gratuito nel Lazio.`

Owni risponde con bozza v2 e di nuovo i tre bottoni. Se scrive `annulla modifica` in `awaiting_edit`, ripristina i bottoni sulla bozza precedente senza incrementare la versione.

### 3.5 Scarta

```
Scartata · Pratica #a1b2c3d4

Nessuna mail è stata inviata. Sul CRM il lead resta aperto con esito «scartata da commerciale».
Se era un errore, crea una nuova pratica dalla mail originale (non si «riapre» questa).
```

### 3.6 Errori e stati speciali (testo esatto)

**CRM non raggiungibile al create/update lead:**

```
Attenzione · Pratica #a1b2c3d4

Non sono riuscita ad aggiornare il CRM (timeout). La bozza è comunque pronta qui sotto. Puoi Approvare: riproverò il CRM dopo l'invio. Se preferisci aspettare, tocca Scarta e riprova più tardi.
```

(poi scheda + bozza + i tre bottoni)

**Invio mail fallito dopo Approva:**

```
Invio non riuscito · Pratica #a1b2c3d4

Il provider mail ha rifiutato l'invio (mailbox unavailable). Nessuna mail è partita.
Quando il problema è risolto, tocca Approva per ritentare l'invio della stessa bozza. Oppure Modifica o Scarta.

[ Approva ]  [ Modifica ]  [ Scarta ]
```

**Crash dopo Approva, prima dell'invio (alla ripresa):**

```
Invio non completato · Pratica #a1b2c3d4

Il processo si è interrotto prima della conferma di invio. Nessuna mail risulta inviata.
Tocca Approva per ritentare l'invio della bozza v{n}, oppure Modifica o Scarta.

[ Approva ]  [ Modifica ]  [ Scarta ]
```

**Spam:**

```
Mail in arrivo · probabilmente spam · Pratica #e5f6a7b8

Da: newsletter@shop.example
Oggetto: -30% questo weekend
Classificazione: spam. Nessun lead nel CRM.

Tocca Scarta per archiviare. Tocca Approva se vuoi forzarla come richiesta di preventivo (partirà l'estrazione e la bozza).

[ Approva ]  [ Modifica ]  [ Scarta ]
```

In questo stato Modifica chiede una nota libera («Perché la forzi?») opzionale e poi equivale ad Approva-forza. Scarta chiude senza upsert CRM.

**Non commerciale (A4), distinta dallo spam:** fornitore che vende a noi, richiesta amministrativa, assistenza su fattura, ecc. Nessuna bozza, nessun lead, nessun pulsante.

```
Mail in arrivo · non commerciale · #c9d0e1f2

Da: Rita Colombo <rita.colombo@panificio-colombo.example>
Oggetto: Problema con la fattura
Classificazione: non_commerciale (non è spam). Nessun lead, nessuna bozza.
```

**Mittente non valido (A2):** nessun lead nel CRM, solo audit/registro e avviso Telegram **senza pulsanti**.

```
Avviso · mittente non valido · #b0c1d2e3

Ho ricevuto una mail senza indirizzo mittente utilizzabile (From vuoto o non valido).
Nessun lead è stato creato nel CRM. Nessuna bozza. Controlla la casella a mano se serve.
```

**Nuova richiesta su thread già inviato (A5):** stesso lead aggiornato (prodotti inclusi), nuova bozza da approvare, nessuna pratica nuova.

```
Nuova richiesta sul thread · Pratica #a1b2c3d4 (già inviata)

Da: Irene Basile
Oggetto: Re: Preventivo attrezzature cucina
Ha aggiunto prodotti alla richiesta. Ho aggiornato lo stesso lead nel CRM e preparato una nuova bozza (v1).

[ Approva ]  [ Modifica ]  [ Scarta ]
```

**Follow-up sul thread (risposta a domande, senza nuova merce):** stessa pratica, bozza di follow-up, tre bottoni; update lead solo se emergono nuovi contatti scritti dal mittente.

**Tap da fuori allowlist (A8), anche su pratiche chiuse:** silenzio verso l'utente; audit `user.denied` con `praticaId` e stato; nessuno cambio di stato e nessun invio.

**Possibile doppione di notifica** (riga in cima alla scheda):

```
Possibile doppione di notifica: ignora se hai già risposto.
```

**Tetti di spesa:** testi in §5.1.

## 4. Dati del lead e adapter CRM

### 4.1 Campi minimi (indipendenti dal CRM)

| Campo | Obbligatorio | Note |
|---|---|---|
| `fullName` | sì (o company) | Almeno uno tra nome e azienda |
| `title` | no (A6) | Dott., Avv., Ing., ecc. se scritto dal mittente; usato nel saluto |
| `company` | sì (o fullName) | |
| `email` | sì | Destinatario; validazione formato. Solo contatti **scritti dal mittente** vanno nel CRM (A7) |
| `phone` | no | Solo se scritto dal mittente; in CRM sì, in bozza mai (A7) |
| `productOrService` | sì per preventivo | Estratto dalla mail |
| `quantity` | no | In `missingFields` se assente e rilevante |
| `urgency` | no | Testo libero |
| `vatNumber` | no (A3) | Facoltativo. Mai chiesto ai privati. Alle aziende solo se il tenant imposta `requireVatNumber` (default **no**) |
| `originalLanguage` | sì (A6) | `it` \| `en` \| `it+en` \| `other`; guida la lingua della bozza (A1) |
| `missingFields` | sì (lista, può essere vuota) | Guida le domande in bozza; `vatNumber` ci entra solo se il tenant lo richiede |
| `source` | sì | Fisso `email` |
| `rawSubject` | sì | |
| `rawSnippet` | sì | Primi ~500 caratteri, senza allegati |
| `receivedAt` | sì | ISO |
| `mailMessageId` | sì | Idempotenza ingresso |
| `ownerUserId` | no | Telegram userId assegnato |

### 4.2 Interfaccia adapter

```ts
interface CrmAdapter {
  name: string;
  upsertLead(tenantId: string, lead: LeadFields, idempotencyKey: string): Promise<{ crmLeadId: string; created: boolean }>;
  updateLeadStatus(tenantId: string, crmLeadId: string, status: "replied" | "discarded" | "error", note?: string): Promise<void>;
}

interface MailAdapter {
  name: string;
  listNewRequests(tenantId: string, sinceCursor: string): Promise<{ messages: InboundMail[]; nextCursor: string }>;
  sendReply(tenantId: string, args: {
    to: string; subject: string; bodyText: string;
    inReplyToMessageId: string; idempotencyKey: string;
  }): Promise<{ sentMessageId: string }>;
}
```

### 4.3 Primo CRM: HubSpot; prima mail: Gmail

**HubSpot** (Contacts + nota/engagement; Deal opzionale dopo) perché: piano gratuito per il pilota, OAuth e API chiare, diffusione nelle PMI digitali italiane. Pipedrive è il secondo adapter sulla stessa interfaccia.

**Gmail** (label o casella dedicata `owni-preventivi`) come primo mail adapter; Microsoft Graph secondo, stessa interfaccia.

## 5. Regole di sicurezza

1. **Allowlist Telegram (A8).** Solo gli `userId` in `allowedUsers.telegram`. Default: nessuno. Messaggio o tap (anche su pratica già `sent`/`discarded`/`failed`) da fuori lista: silenzio + audit `user.denied`, nessuno stato cambiato.
2. **Egress default deny.** Canali e provider mail/CRM/modello esplicitamente consentiti.
3. **Niente invii automatici (policy «bozze, non invii autonomi»).** Stato `approved` solo per callback Approva da allowlist. Il tool di invio non è richiamabile dal modello senza quel gate.
4. **Audit senza contenuti.** Eventi pratica + `user.denied` / `egress.denied` / `cost.warn` / `cost.denied`: metadati sì, corpi no.
5. **Segreti per tenant.** OAuth e API key solo in `secrets.json` (0600). Mai nel prompt.
6. **Doppioni noti.** Outbox at-least-once: `possibleDuplicate: true` in audit; riga in scheda; callback idempotenti su `praticaId` + `draftVersion` + azione.
7. **Idempotenza effetti esterni.** `mailMessageId` in ingresso; `idempotencyKey` su upsert e send. Secondo Approva con `sentMessageId` già salvato: nessun secondo invio.
8. **Tool replay.** Lettura mail e upsert CRM: `replaySafe: true` + memo. Invio mail: `replaySafe: false`; ritentativo solo via Approva umano.

### 5.1 Modelli, costo e tetti di spesa

**Routing per ruolo** (config per istanza):

| Ruolo | Modello | Note |
|---|---|---|
| Classificazione + estrazione JSON | Claude **Haiku 5.5** | Schema stretto, costo basso |
| Bozza email (lei) e judge eval | Claude **Sonnet 5.5** | Qualità copy; default bozza Owni |
| Fallback se Anthropic down | OpenAI GPT-5 (bozza) / GPT-5 mini (extract) | Solo se in egress policy |

**Costo per pratica.** Stima **non misurata** su traffico Owni: circa **0,01-0,02 USD** a pratica con Haiku+Sonnet e cache sul system prompt (tutto-Sonnet ~0,03). Da ricalcolare quando esisterà `usage.jsonl` / audit usage per tenant. Log per submission: provider, model, token in/out, `estimatedUsd`, senza testo.

**Tetti per tenant** (giorno civile Europe/Rome):

| Soglia | Default | Effetto |
|---|---|---|
| Soft | **5 USD / giorno** | Avviso; pratiche già aperte possono chiudersi; nuove mail in coda. Audit `cost.warn`. |
| Hard | **20 USD / giorno** | Niente nuove chiamate modello fino a mezzanotte (o override owner). Audit `cost.denied`. Approva su bozza **già** in Document (solo `mail.send`) resta consentito. |

**Cosa vede il commerciale.**

Soft cap:

```
Limite soft di spesa · oggi

Questo tenant ha superato circa 5 USD di modelli nel giorno civile.
Continuo a preparare le bozze già in corso. Le nuove mail restano in coda e ti avviso se il ritmo non cala.
Se serve alzare il tetto, chiedilo all'owner.
```

Hard cap (reject di una nuova estrazione/bozza):

```
Limite hard di spesa · oggi

Ho smesso di usare il modello per questo tenant: raggiunto il tetto di circa 20 USD nel giorno civile.
Nessuna nuova bozza partirà fino a domani (o finché l'owner non alza il tetto).
Le mail in arrivo restano salvate e non vengono inviate risposte automatiche.
Pratiche già in approvazione: puoi ancora Approvare una bozza già pronta (parte solo l'invio mail).
```

Approva che richiederebbe una nuova generazione sotto hard cap:

```
Non posso rigenerare la bozza: tetto di spesa giornaliero raggiunto.
Puoi Scartare, oppure Approvare la bozza già mostrata (v{n}) senza rigenerarla.
```

### 5.2 Eval di prodotto (`evals/segreteria/`)

```text
evals/segreteria/
  README.md
  dataset/cases.jsonl      # ~25 mail sintetiche IT
  gold/labels.jsonl
  rubrics/draft_rubric.md
  run.ts
  judge.ts
```

Copertura minima (allineata a §6): completi; dati mancanti; formale vs informale; prezzo presente/assente; multi-prodotto nella stessa mail; IT/EN; spam / non-preventivo; reply a thread; titoli/PII; encoding. Gold rivisti a mano da Craft. Nessuna email reale di cliente in CI senza anonimizzazione.

CI: estrazione + check deterministici su ogni PR (fixture/faux). Judge Sonnet: nightly o manuale.

## 6. Casi limite

Ogni riga ha comportamento obbligatorio e criterio in §7.

| Caso | Comportamento atteso |
|---|---|
| Stessa mail riletta al restart | Stesso `mailMessageId` → nessuna seconda pratica |
| Mail senza mittente valido (A2) | Nessun lead CRM; solo registro/audit; avviso Telegram **senza pulsanti**; stato `failed` |
| Dati mancanti (qty, sede, product) | `missingFields` valorizzato; bozza **chiede** quei campi; nessun prezzo inventato |
| P.IVA assente (A3) | Campo facoltativo; mai in `mustAsk` per privati; per aziende solo se tenant `requireVatNumber` (default no) |
| Più richieste nella stessa mail | Una pratica, un lead; bozza elenca i prodotti in punti e chiede priorità; non N lead automatici |
| Nuova richiesta su thread già inviato (A5) | Stesso lead aggiornato (prodotti inclusi); nuova bozza da approvare; nessuna pratica nuova |
| Follow-up su thread (risposta a domande) | Stessa pratica; bozza follow-up; tre bottoni |
| Spam | Classificazione `spam`; nessun upsert finché non si forza con Approva; tre bottoni |
| Non commerciale (A4) | Classificazione `non_commerciale`; nessun lead, nessuna bozza; notifica breve senza pulsanti |
| Prezzo citato dal cliente | Nessun altro importo in bozza; niente contraddizione senza Modifica |
| Lingua del cliente (A1) | Bozza nella lingua del cliente (`en` → inglese; `it`/`it+en`/incerto → italiano); scheda Telegram sempre in italiano |
| Allegati / allegato citato assente | Non letti in v1; nota in scheda |
| Titoli e PII (A6, A7) | `title` e `originalLanguage` nel lead; CRM solo contatti scritti dal mittente; bozza solo nome+azienda |
| Due commerciali in allowlist | Primo tap valido vince; il secondo vede pratica chiusa |
| Crash dopo Approva, prima di send | Ripresa con tre bottoni e copy «Invio non completato»; nessun invio silenzioso |
| Crash dopo send, prima di markDelivered | Possibile doppione conferma Telegram; non secondo invio mail se c'è `sentMessageId` |
| CRM down post-invio | Mail resta `sent`; avviso CRM; audit sul sotto-passo |
| Soft cap | Copy §5.1; coda nuove mail; pratiche aperte ok |
| Hard cap | Copy §5.1; reject nuove chiamate modello; Approva-solo-send ancora ok |
| Allowlist aggiornata a caldo | Vale dalla prossima apertura istanza (limite week2) |
| Bozza > 4096 caratteri | Spezza i messaggi; i tre bottoni sull'ultimo pezzo |

## 7. Criteri di accettazione (verificabili)

### 7.1 Flusso e sicurezza

1. **Gate umano / policy bozze.** Nessuna `sendReply` prima di callback Approva da allowlist.
2. **Solo tre pulsanti.** Negli stati interattivi con bozza (e nello spam forzabile) compaiono esclusivamente Approva, Modifica, Scarta. Mittente invalido (A2) e `non_commerciale` (A4): **zero** pulsanti.
3. **Allowlist (A8).** Messaggio o tap da fuori lista, anche su pratica chiusa: zero submit motore, zero send, zero cambio stato; audit `user.denied`.
4. **Idempotenza ingresso.** Stesso `mailMessageId` → una pratica, al più un `upsertLead` netto.
5. **Idempotenza invio.** Due Approva di ritentativo con `sentMessageId` già salvato → un solo `sendReply`.
6. **Flussi Approva / Modifica / Scarta.** Stati finali `sent`, `draft_ready` (v2), `discarded` con fetch finto.
7. **Modifica in linea.** Messaggio testo → `draftVersion + 1` + tre bottoni; `annulla modifica` non incrementa.
8. **Crash dopo approve.** SIGKILL tra approve e send → ripresa con tre bottoni; nessun invio silenzioso.
9. **Doppione notifica.** `attempts > 1` → riga doppione; secondo Approva non reinvia.
10. **Isolamento tenant.** Nessun leak A→B su pratiche o segreti.

### 7.2 Qualità e decisioni A1-A8 (`evals/segreteria/`)

11. **Schema lead.** 100% JSON validi; campi `title` e `originalLanguage` presenti (A6).
12. **Estrazione.** Micro-F1 campi ≥ 0.85; exact-match lead ≥ 0.60 (soglie iniziali).
13. **Dati mancanti.** Ogni caso `missing_*`: bozza con domanda per ciascun `mustAsk`; nessun prezzo se `mustNotInventPrices`.
14. **Multi-richiesta.** Una pratica, un `upsertLead`, bozza a punti.
15. **Spam.** Zero upsert finché non si forza; messaggio di classificazione; tre bottoni.
16. **Non commerciale (A4).** Classificazione `non_commerciale`; `crmUpsertExpected=0`; `draft=null`; notifica breve; `telegramButtons=[]`.
17. **Thread / nuova richiesta (A5).** Nessuna pratica duplicata; su nuova merce: update dello stesso lead (prodotti inclusi) + nuova bozza + tre bottoni.
18. **Lingua (A1).** Bozza in `draft.language` allineata a `originalLanguage` (en→en; it/it+en/altro→it); scheda Telegram in italiano.
19. **Mittente invalido (A2).** `crmUpsertExpected=0`; `telegramButtons=[]`; stato `failed`; avviso senza pulsanti.
20. **P.IVA (A3).** Con `requireVatNumber=false` (default): `vatNumber` assente non è in `mustAsk`, né per privati né per aziende nei gold di default.
21. **PII in bozza (A7).** Nessuna stringa di cellulare personale, indirizzo, IBAN, C.F. o data di nascita nella bozza; saluto con nome/titolo e menzione azienda ammessi.
22. **Niente prezzi inventati.** Nessun `€` / `EUR` / importo se il gold lo vieta; se l'email cita un prezzo, nessun altro importo aggiunto.
23. **Registro formale.** Bozza IT: forme lei/Le/Suoi, niente tu/ciao. Bozza EN: formale, niente slang.

### 7.3 Costi

24. **Routing.** Extract/classificazione Haiku 5.5; bozza Sonnet 5.5 (config istanza).
25. **Soft cap.** Audit `cost.warn` + messaggio §5.1; submit in volo possono finire.
26. **Hard cap.** Nuove submit modello rifiutate con `cost.denied` + messaggio §5.1; nessun invio mail come scorciatoia autonoma.

## 8. Fuori scope (settimana 3)

- Dashboard owner e web app / mobile.
- WhatsApp.
- Secondo CRM (Pipedrive) e seconda mail (Graph): solo interfaccia.
- Lettura allegati, OCR, preventivo numerico automatico da listino (catalogo sola lettura per non inventare prezzi).
- Ruoli fini «solo status» vs «può approvare» (in week3 tutti in allowlist possono Approvare).
- Code multi-team, calendar, PEC, streaming token, messaggi vocali.
- Multi-bot Telegram per processo; cifratura a riposo oltre 0600.
- Judge LLM delle eval su ogni PR (resta nightly/manuale).
- Merge su main: Ship via PR dopo review.

## 9. Decisioni di prodotto (sintesi)

1. **Policy «bozze, non invii autonomi»** e gate Approva obbligatorio, anche dopo crash.
2. **Tre pulsanti** Approva/Modifica/Scarta negli stati con bozza (e spam forzabile); zero pulsanti per mittente invalido e `non_commerciale`.
3. **Primo CRM HubSpot; prima mail Gmail**, dietro adapter.
4. **A1-A8** (lingua bozza = lingua cliente; mittente invalido senza CRM/bottoni; P.IVA facoltativa; classe `non_commerciale`; thread aggiorna lead; campi `title`/`originalLanguage`; PII fuori dalla bozza; allowlist anche su pratiche chiuse), ciascuno con criterio in §7.2.
5. **Haiku 5.5 extract + Sonnet 5.5 bozza**; stima ~0,01-0,02 USD/pratica (non misurata); soft 5 USD/giorno e hard 20 USD/giorno con copy Telegram in §5.1.
6. **Eval `evals/segreteria/`** obbligatorie; ogni caso limite di §6 ha comportamento e criterio in §7.

## 9.1 Decisioni A1-A8 (criterio di accettazione)

| ID | Decisione | Criterio |
|---|---|---|
| A1 | Bozza nella lingua del cliente (default IT); scheda Telegram sempre in IT | §7.2-18; gold 020 (EN), 021 (IT su misto) |
| A2 | Mittente non valido → nessun lead CRM, solo registro + avviso senza pulsanti | §7.2-19; gold 031 |
| A3 | `vatNumber` facoltativo; mai ai privati; aziende solo se tenant `requireVatNumber` (default no) | §7.2-20; gold 005, 008, 010 |
| A4 | Classe `non_commerciale`: no bozza, no lead, notifica breve, non è spam | §7.2-16; gold 024, 025 |
| A5 | Nuova richiesta su thread inviato → update stesso lead/prodotti + nuova bozza | §7.2-17; gold 027 |
| A6 | Campi lead `title` e `originalLanguage` | §7.2-11; schema lead + gold con titolo/lingua |
| A7 | CRM: solo contatti scritti dal mittente; bozza: solo nome e azienda (niente cell/indirizzo/IBAN/CF) | §7.2-21; gold 028, 005 |
| A8 | Tap fuori allowlist ignorato e registrato, anche su pratiche chiuse | §7.1-3; test motore |

## 10. Handoff

| A chi | Cosa |
|---|---|
| **Ship** | Adapter, stati, tre bottoni, tetti costo, test §7, cartella `evals/segreteria/`; PR da branch dedicato |
| **AI Guru** | Schema eval, routing modelli, rubrica judge; documents/approve durable se serve |
| **Emily** | Coordinamento; chiavi reali ancora bloccanti per la prova live |
| **Craft** | Prompt default IT; revisione gold eval; iterazione copy §3 e §5.1 |

*Fine spec settimana 3.*
