# 0111: Il prodotto si chiama Owni

Il prodotto cambia nome e diventa Owni. Il cambio arriva insieme a un giro di rifinitura dell'identità e dell'interfaccia, per un aspetto più curato: il nome è la prima cosa che una persona vede, sul sito, nell'app installata sul telefono (PWA), nell'app per Mac e nei messaggi che riceve su Telegram, WhatsApp e per mail. Un solo nome, nel prodotto e nel codice, evita il confine tra nome pubblico e nome in codice.

## Decisione

- **Il nome che si vede è Owni, ovunque.** Interfaccia web, PWA, app per Mac (finestre, icona nella barra, menu, notifiche, helper per il controllo del computer), testi dell'agente, errori, mail, messaggi Telegram e WhatsApp, output da riga di comando, metadati dei file prodotti (PDF, DOCX, calendari ICS), user agent delle richieste web, documentazione e README. Il nome predefinito dell'istanza, quando `OWNI_INSTANCE_NAME` non è impostata, è «Owni».
- **Anche i nomi interni sono Owni.** Variabili d'ambiente `OWNI_*`, pacchetti e crate (`owni`, `owni-desktop`, `owni_desktop_lib`), eseguibili (`owni-desktop`, `owni-computer-use`), identificatori e file del codice, intestazioni HTTP `x-owni-*`, chiavi del `localStorage`, immagini `ghcr.io/<owner>/owni` e `owni-computer`, il repository `mariomile/owni`. L'istanza predefinita ha id `owni`.
- **L'identificatore dell'app per Mac è `app.owni.desktop`** e il pacchetto si chiama `Owni.app`.
- **Nessuna migrazione nel codice.** Il vecchio nome non è letto da nessuna parte: un'installazione esistente rinomina a mano variabili e cartelle una volta sola.

## Conseguenze

- Chi ha un server deve rinominare le variabili d'ambiente in `OWNI_*` e, se usa l'istanza predefinita, la sua cartella in `instances/owni`, prima di aggiornare.
- Chi usa l'app per Mac installa `Owni.app` e rifà il consenso ai permessi (Accessibilità e Registrazione dello schermo, notifiche), come descritto in `docs/desktop.md`: l'helper per il controllo del computer ha un nome nuovo e macOS lo vede come un'app nuova.
- Le preferenze dell'interfaccia salvate nel browser ripartono dai valori predefiniti.
