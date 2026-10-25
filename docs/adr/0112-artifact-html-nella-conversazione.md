# 0112: Artifact HTML nella conversazione

Un agente sa già scrivere file e mandarli, ma una pagina HTML arrivava come un allegato da scaricare e aprire a parte. Per un cruscotto, un calcolatore, un report impaginato o un piccolo strumento interattivo serve quello che fa Claude con gli artifact: la pagina si vede subito, accanto alla conversazione, e ogni modifica dell'agente ne fa una versione nuova. La pagina però è scritta dal modello, quindi è codice non fidato che gira nella console, dove ci sono la sessione della persona e le API di Owni.

## Decisione

- **Due tool, `artifact_create` e `artifact_update`.** Il primo riceve titolo e pagina intera, il secondo l'id e di nuovo la pagina intera, che diventa la versione successiva (le precedenti restano). La descrizione insegna al modello quando usarli: contenuti visivi o interattivi sostanziosi e autonomi, non risposte brevi, elenchi o tabelle che si leggono bene in chat. Funzionano solo in una conversazione della console; altrove l'agente scrive il file con `file_write` e lo manda con `file_send`.
- **Le pagine stanno con la conversazione.** `instances/<agente>/web/artifacts/<thread>/<id>/` contiene `meta.json` e un `v<n>.html` per versione, file 0600. Limiti: 512 KB per versione, 30 versioni per artifact, 50 artifact per conversazione. Salvataggio e messaggio sono legati alla chiamata del tool: rieseguita dopo un crash, non aggiunge una versione né un secondo messaggio.
- **Nella trascrizione c'è un riferimento, non la pagina.** Il messaggio dell'agente ha il campo `artifact: {id, version, title}`; nelle stanze lo stesso campo porta anche il thread del posto dell'agente, da cui la pagina si apre.
- **Una rotta sola la serve, con un CSP suo.** `GET /api/instances/:id/artifacts/:thread/:artifact/:version` controlla che la conversazione sia della persona, come i messaggi: l'owner non legge gli artifact delle chat di un membro. La risposta sostituisce le intestazioni della console con `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals`, `default-src 'none'`, script e stili inline e da tre CDN (jsDelivr, unpkg, cdnjs), font da Google Fonts, immagini e media da `data:`, `blob:` e https, `connect-src 'none'`, `frame-ancestors 'self'`; niente `X-Frame-Options: DENY`, `nosniff`, `Cache-Control: private, no-store`. Il sandbox del CSP dà alla pagina un'origine opaca anche quando è aperta in una scheda a sé: non legge il cookie di sessione e non può chiamare le API.
- **Il pannello la mostra in un iframe sandbox.** `sandbox="allow-scripts allow-popups allow-forms allow-modals"`, `referrerpolicy="no-referrer"`, mai `allow-same-origin`. La console aggiunge `frame-src 'self'` al suo CSP, e nient'altro cambia.
- **Anche i file HTML del workspace si aprono così.** Un `.html` mandato con `file_send` o elencato in Documenti e file ha il pulsante «Apri»; `files/raw?view=1` lo serve con le stesse intestazioni, solo per `.html` e `.htm`. Il download resta com'era.
- **In chat è una card, accanto è un pannello.** La card ha icona, titolo, «Versione n», Apri e Scarica. Il pannello ha titolo, scelta della versione, apertura in una nuova scheda, download e chiusura. Si apre da solo quando arriva un artifact o una versione nuova nella conversazione aperta, non quando la si carica; sul telefono non si apre da solo, perché coprirebbe la chat, e quando lo si apre prende tutta la larghezza con un pulsante per tornare indietro, come Browser e Schermo.
- **L'app per Mac non cambia.** Carica la console dal server locale, quindi valgono le intestazioni del server; il CSP di `tauri.conf.json` riguarda solo la pagina di connessione inclusa nell'app.

## Alternative scartate

- **Un'origine o un dominio separato per le pagine**, come fa Claude. È l'isolamento più forte, ma Owni gira su un server della persona, spesso su `localhost` o su un solo indirizzo: un secondo dominio vorrebbe dire DNS, certificati e configurazione in più per ogni installazione. Il sandbox del CSP dà già un'origine opaca senza niente da configurare.
- **`srcdoc` nell'iframe.** Senza `allow-same-origin` la pagina sarebbe comunque isolata, ma prenderebbe il CSP della console (niente script inline né CDN) e non si potrebbe aprire in una scheda o scaricare con un indirizzo. Una rotta vera tiene insieme le tre cose.
- **HTML dentro il Markdown della risposta.** Il renderer della console non interpreta HTML di proposito: aprirlo vorrebbe dire far girare codice del modello con l'origine della console.

## Conseguenze

- Una pagina può caricare script solo dai tre CDN e non può fare richieste di rete: niente dati dal vivo, niente chiamate a Owni. I dati vanno scritti dentro la pagina.
- La pagina può aprire finestre e inviare moduli verso l'esterno (`allow-popups`, `allow-forms`): è il prezzo di pagine utili, e la pagina non ha comunque niente della sessione da portarsi dietro.
- Il modello aggiorna una pagina riscrivendola tutta: con il contesto compattato può non avere più il testo della versione precedente, e non c'è un tool per rileggerla.
- Un artifact non si cancella da solo: resta finché resta la conversazione.
