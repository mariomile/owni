# Volti degli agenti

> Aggiornata dall'[ADR 0125](0125-stato-unico-degli-agenti-e-console-piu-chiara.md): l'emoji non c'è più, nemmeno accanto al nome. Il volto è l'unico segno di un agente.

Con più agenti, la console li distingueva solo per nome ed emoji: un selettore in cima alla barra, una lettera o un'emoji in un quadrato nella pagina Agenti, tre puntini mentre uno risponde. Mario vuole un design che faccia «wow», ispirato a Grok e Grok Bot. xAI racconta che in Grok Bot gli oggetti principali sono gli agenti, non le chat, e che ognuno ha un avatar riconoscibile «quasi con la coda dell'occhio»: forme semplici, occhi espressivi, una famiglia sola con piccole varianti, e l'avatar stesso che si muove per dire che sta lavorando, al posto dei tre puntini ([Designing Grok Bot](https://x.ai/news/designing-grok-bot)).

## Decisione

- **Ogni agente ha un volto disegnato dal suo ID** (`face()` in `src/web/ui/app.js`): un corpo morbido (tondo, quadrato, uovo o largo), un colore fra otto, occhi a punto, alti o larghi, e un dettaglio (antenna, guance, sopracciglia, o niente). Ogni tratto ha il suo hash, quindi lo stesso ID dà sempre lo stesso volto, ovunque e su ogni dispositivo, senza salvare niente. Owni, l'agente principale, resta nel bianco e nero della console e segue il tema.
- **Dove compare**: nella barra laterale, nella pagina Agenti, sopra il saluto della chat vuota (grande, con la luce del suo colore dietro), accanto al nome nelle risposte, nelle stanze e sulle schede della board.
- **Il volto dice che sta pensando**: mentre la risposta arriva, gli occhi si guardano intorno e il corpo ondeggia, con «Ricercatore sta pensando…» accanto. Nelle stanze ci sono i volti degli agenti presenti. Da fermi sbattono le palpebre ogni tanto, ognuno con il suo tempo. Con «riduci movimento» non si muove niente.
- **La barra laterale elenca gli agenti** (volto, nome, a cosa serve) al posto del menu a tendina; un tocco apre le chat di quell'agente.
- **Tema scuro nero profondo** (#000, superfici #141414, bordi sottili) come Grok; il solo colore della console sono i volti. Il testo secondario passa il contrasto AA (4.5:1) su ogni superficie, nei due temi.
- **L'emoji scelta resta** accanto al nome nei testi, ma non sostituisce più il volto.
- I colori dei volti passano dal CSSOM (`style.setProperty`): la CSP della console rifiuta gli attributi `style`.
- Controllato con il rilevatore di Impeccable (`impeccable detect`): niente testo sfumato, niente bordo colorato su un lato, movimenti che rallentano senza rimbalzo.

## Alternative scartate

- **Volti caricati o generati con un modello di immagini**: un file per agente da salvare e servire, e una famiglia che non si somiglia più. Il disegno dal codice è uguale per tutti e non costa niente.
- **Lasciare l'emoji come avatar**: non si distingue in piccolo, non si muove, e due agenti con la stessa emoji si confondono.
- **Un pallino colorato di stato accanto all'avatar**: xAI l'ha scartato perché aggiunge un livello da leggere; il volto che si muove dice la stessa cosa.
