# Fase 3, primo passo: navigazione web in sola lettura, prima delle micro-VM

Rivista in parte dall'[ADR 0011](0011-moduli-web-con-approvazione.md): l'invio di moduli con approvazione arriva prima delle micro-VM.

Il piano porta nella cella browser e terminale, «leggere è libero, scrivere o inviare si approva». Abbiamo deciso di iniziare dalla parte che non scrive: un'istanza legge pagine web (`web_read`) e ne fa screenshot (`web_screenshot`) solo dai siti che l'owner elenca per lei, mai da un indirizzo interno. Niente moduli, niente clic, niente terminale.

Perché: è il pezzo che serve subito (leggere il sito di un cliente, un bando, una pagina dell'Agenzia delle Entrate) e il solo che si può dare nei container di oggi (ADR 0008) senza le micro-VM: Owni non esegue codice suo, apre pagine altrui in un Chromium senza download, con ogni richiesta della pagina controllata.

## Alternative scartate

- **Browser completo con azioni** (compilare, cliccare, inviare): sono azioni verso l'esterno, chiedono il giro di approvazione e un isolamento più forte. Dopo le micro-VM.
- **Terminale nella cella**: esecuzione di codice arbitrario, solo con micro-VM.
- **Qualunque sito di default**: il default resta negato come per canali e connettori; l'owner può scegliere `*` per tutti i siti pubblici.

## Conseguenze

- Ogni indirizzo è controllato sull'IP a cui ci si connette davvero (non solo sul nome), in tutte le grafie IPv4 e IPv6, e di nuovo dopo ogni redirect: niente loopback, reti private, link-local, endpoint dei metadati del cloud.
- Negli screenshot Chromium non tocca la rete: ogni richiesta della pagina gli viene servita dallo stesso fetch controllato di `web_read`, un redirect alla volta; WebSocket e service worker sono bloccati, solo richieste GET, con un tetto di richieste e di byte per screenshot. Il DNS lo risolviamo solo noi.
- Chromium gira con il suo sandbox. Dove il sandbox non parte (un container senza user namespace, un processo root) gli screenshot restano spenti, a meno che l'operatore accetti esplicitamente di farlo girare senza (`OWNI_SCREENSHOTS_WITHOUT_SANDBOX=1`): in quel caso un exploit del renderer avrebbe gli stessi permessi della cella. Chromium parte senza i segreti nell'ambiente.
- Il contenuto delle pagine (testo, titolo) arriva al modello marcato come dati, con un'etichetta casuale: una pagina non può chiudere la recinzione e scrivere istruzioni.
- Con `*` una pagina con istruzioni nascoste potrebbe spingere Owni a «leggere» un indirizzo che porta fuori dati nella query: per questo i siti consentiti conviene elencarli uno per uno, e nella chat del brief del mattino (che legge mail di chiunque) gli strumenti web non girano.
- Chromium nell'immagine è facoltativo (`WITH_BROWSER`); l'immagine pubblicata dalla CI lo ha. Senza, gli screenshot dicono di non essere disponibili e la lettura funziona.
