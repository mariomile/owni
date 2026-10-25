# Report di ricerca con le fonti

Dalla settimana 22 Owni cerca sul web e apre le pagine trovate, una alla volta. Per una domanda che chiede di approfondire («fammi il punto sugli incentivi per le pompe di calore», «confronta tre gestionali per uno studio») il modello doveva fare decine di chiamate, e le fonti che citava erano quelle che ricordava di aver letto. Gli assistenti con cui Owni viene confrontata fanno ricerche approfondite che finiscono in un report con le fonti.

## Come funziona

- **Due tool**, offerti quando il server ha un servizio di ricerca (`OWNI_SEARCH_API_KEY`), attivi quando l'owner accende la ricerca per l'istanza, come `web_search`.
- **`research_gather`** riceve la domanda e da 2 a 6 ricerche diverse. Ogni ricerca conta nel limite giornaliero dell'account; se finisce a metà, quelle fatte bastano e il tool lo dice. Le ricerche partono insieme; dei risultati si prendono prima i primi di ogni ricerca, poi i secondi, così ogni lato della domanda ha posto. Lo stesso indirizzo (anche con un `#` diverso) si apre una volta.
- **Le pagine** si aprono come con `web_read`: solo dai siti che l'owner consente, con gli stessi controlli a ogni redirect. Al massimo 8 pagine, 4 per sito, 4 alla volta. Di ogni pagina restano i paragrafi che parlano della domanda (parole in comune, singolare e plurale, sigle in maiuscolo; prima quelli con numeri), fino a 2.500 caratteri. Una pagina sparita (404, 410) non è una fonte. Un sito non consentito, una pagina che rifiuta (403), un PDF o una pagina che non si apre restano con l'estratto della ricerca, detto come tale.
- **Il dossier** è in `ricerche/<domanda>/fonti.json` (e `fonti.md`, leggibile) nel workspace, con le fonti numerate. La stessa domanda entro un giorno aggiunge fonti allo stesso dossier, numerate di seguito, senza riaprire le pagine già lette; una domanda diversa con lo stesso nome, o la stessa dopo un giorno, ne apre uno nuovo (`-2`, `-3`). Al massimo 12 fonti per chiamata e 24 per dossier.
- **Al modello** il dossier arriva recintato come dato (`untrusted`). Fuori dal recinto solo numeri, il nome del dossier, i siti non consentiti (dalla lista dell'owner) e cosa fare dopo.
- **`research_report`** riceve titolo e testo in Markdown con le citazioni `[n]`. Controlla che ogni numero sia nel dossier (un anno tra parentesi o il testo di un link non contano) e che ce ne sia almeno uno; toglie un elenco di fonti scritto dal modello e mette sotto quello del dossier, solo le fonti citate, con data ed «estratto» quando la pagina non è stata aperta. In testa: data della ricerca, domanda, quante fonti citate, e se il report si basa solo sugli estratti. Salva `ricerche/<titolo>.md` (`-2` se c'è già) e lo manda nella conversazione; se l'invio non riesce lo dice al modello.
- **Un dossier** si accetta solo com'è scritto da `research_gather`: numeri in ordine, indirizzi `http` e `https`. Un file scritto dal modello con `file_write` non lo è.
- **Audit**: `web_search.ran` per ogni ricerca, `research.gathered` (ricerche, fonti, pagine lette) e `research.reported` (fonti citate). Mai domanda, ricerche o indirizzi.

## Alternative scartate

- **Un sotto-agente che cerca da solo per minuti.** Più costoso, difficile da fermare e da limitare; i due tool lasciano al modello della conversazione il ragionamento e tengono nel codice i limiti, i siti e le fonti.
- **Leggere le pagine intere.** Otto pagine intere superano quello che un modello legge bene in una risposta; i paragrafi che parlano della domanda bastano, e la pagina resta citata per intero.
- **Fidarsi delle citazioni del modello.** Un numero che non è nel dossier o un elenco di fonti inventato finirebbe in un file che la persona inoltra. Il codice controlla i numeri e scrive l'elenco.
- **PDF o HTML.** Markdown si legge già nella console e si apre ovunque; un PDF richiede un motore di impaginazione.

## Conseguenze

- Su Telegram e WhatsApp il file arriva come Markdown, con `##` e `[1]` visibili; per questo il modello risponde anche con una sintesi che basta senza aprirlo.
- Gli estratti scelti per parole in comune possono perdere un paragrafo che usa sinonimi; il modello può aprire la pagina con `web_read`.
- Una pagina costruita in JavaScript ha poco testo senza browser: resta il suo estratto o quel poco.
- Due `research_gather` sulla stessa domanda nello stesso momento possono scriversi sopra il dossier.
