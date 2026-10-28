# Schermo dal vivo nella console

> Aggiornata dall'[ADR 0135](0135-schermo-nel-computer-dell-agente.md): la vista dal vivo viene dallo schermo del computer dell'agente, non più da un desktop di Cua.

Con lo Schermo ([ADR 0045](0045-schermo-cua.md)) l'agente lavora su un desktop Linux suo. Chi gli scrive dalla console però vede solo le risposte: «Clic in 640, 400.» non dice se ha aperto la finestra giusta, e per capire cosa sta facendo bisogna chiederglielo. Il VNC c'è nel container ma non è pubblicato, e pubblicarlo vorrebbe dire un'altra porta, un'altra password e una persona che può anche cliccare.

## Decisione

- **Accanto alla chat c'è il pannello «Schermo»**, come quello del browser interno ([ADR 0044](0044-browser-interno.md)): mostra l'ultima schermata che l'agente ha preso in quella conversazione, l'ora e cosa ha appena fatto («Clic in 640, 400.», «Scritto (12 caratteri).»; mai il testo scritto). Su uno schermo largo si apre da solo la prima volta che l'agente usa lo schermo; altrimenti compare il pulsante per aprirlo. Un pannello alla volta: aprendo lo Schermo si chiude il browser e viceversa.
- **Solo guardare.** Nessun clic né tasto dal pannello: chi vuole correggere scrive in chat. Il pannello lo ricorda, insieme al fatto che prima di inviare, pagare o accedere l'agente si ferma e chiede.
- **Si vede solo quello che l'agente ha già visto**: le schermate che prende dopo ogni azione e con desktop_look. Guardare il pannello non avvia il desktop né scatta foto in più, quindi non costa nulla e non sveglia un container fermo.
- **Per conversazione**: la schermata la vede chi sta in quella conversazione con l'agente, e nessun altro, nemmeno l'owner dalla conversazione di un'altra persona. Se il desktop è condiviso tra agenti, la schermata è quella che l'agente ha visto lui stesso in quel momento.
- **In memoria, le ultime 300 conversazioni**. Dopo un riavvio di Owni, o se l'owner azzera lo schermo o elimina l'agente, il pannello sparisce fino alla prossima azione. La console chiede ogni 2 secondi se c'è una schermata nuova, col pannello aperto o mentre la conversazione si muove, ogni 10 altrimenti, e mai per un agente senza schermo; scarica l'immagine solo quando è cambiata. Restano solo le conversazioni della console (le altre nessuno le guarda), e al massimo 200 MB di schermate.
- **Il testo scritto non si vede mai**: dopo desktop_type il pannello dice quanti caratteri, e un tasto che è un carattere (anche con maiuscolo) è «Premuto un tasto.», così un codice battuto tasto per tasto non compare.

## Alternative scartate

- **Pubblicare il VNC (noVNC nella console)**: sarebbe davvero dal vivo, ma apre un canale verso il container con credenziali da gestire, permette di cliccare insieme all'agente e tiene acceso il desktop finché qualcuno guarda.
- **Salvare le schermate su disco, come cronologia**: sono dati della persona (mail, documenti aperti) che resterebbero sul server senza che nessuno li abbia chiesti. La conversazione dice già cosa ha fatto l'agente; il pannello serve a vederlo adesso.
- **Uno stream (SSE) invece di chiedere ogni 2 secondi**: per una schermata che cambia al massimo una volta per azione, una richiesta piccola ogni 2 secondi basta e non tiene connessioni aperte.
