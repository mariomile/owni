# Verifica in due passaggi con TOTP, facoltativa per persona

Fino alla settimana 5 il link personale era l'unica chiave della console (ADR 0005): chi lo aveva entrava. Un link finisce facilmente in una chat, in una mail inoltrata o nella cronologia di un browser condiviso, e per chi gestisce dati di clienti non basta. Dalla settimana 6 ogni persona può attivare la verifica in due passaggi: da quel momento al login servono il link e un codice di sei cifre dell'app di autenticazione del telefono. Usiamo TOTP (RFC 6238, HMAC-SHA1, passi di 30 secondi) perché lo legge qualsiasi app (Google Authenticator, 1Password, Authy…), non serve un servizio esterno né l'invio di SMS, e si implementa in poche righe con `node:crypto`, senza dipendenze.

Regole:

- **Facoltativa per persona**, non imposta dall'owner: l'owner decide di chiederla, la console non la rende obbligatoria. Rendere la verifica obbligatoria per il tenant è un passo successivo, se un cliente lo chiede.
- **Un codice vale una volta** (si salva l'ultimo passo usato) ed è accettato un passo prima o dopo, per l'orologio del telefono.
- **Cinque tentativi in dieci minuti** per persona, contati prima della verifica, sul login e sulla disattivazione. Il conteggio vive nel processo e si azzera al riavvio: un limite contro i tentativi a raffica, non un registro.
- **Attivarla chiude le altre sessioni** della persona: una sessione aperta con un link rubato non sopravvive. Il reset fatto dall'owner (console o `pnpm owni person reset-2fa`) le chiude tutte.
- **Il segreto TOTP sta in `people.json`**, nella cartella dati del tenant, come gli hash dei link. Non arriva mai al browser dopo l'attivazione, né nei log, né nell'audit. Chi ha accesso al disco ha comunque tutto: i backup vanno conservati cifrati (runbook).
- **Le scritture su `people.json` e `sessions.json` passano da un lock condiviso fra processi**, perché la riga di comando li modifica mentre Owni gira.

## Alternative scartate

- **Passkey / WebAuthn**: più forte e senza codici da digitare, ma chiede un dominio stabile con https per ogni installazione e più codice lato browser e server. Da rivalutare quando le installazioni avranno tutte un dominio.
- **Codice via email o Telegram**: dipende da un canale che può essere lo stesso da cui è uscito il link, e da un servizio esterno sempre raggiungibile.
- **Password per persona**: un altro segreto da gestire e da far ruotare, che non protegge più di un TOTP.

## Conseguenze

- Chi perde il telefono chiede all'owner il reset; l'owner che perde il telefono usa la riga di comando sul server.
- Niente codici di recupero: il reset dell'owner li sostituisce, ed evita un altro segreto da conservare.
