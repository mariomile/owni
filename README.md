# Owni

Piattaforma agenti open source di Buildrs: un'azienda di agenti AI, sempre attivi, per aziende attente a privacy e controllo dei processi. Si parte da un assistente; quando serve, ogni agente diventa un collega con il suo ruolo, le sue responsabilità e il suo posto nell'organigramma. Self-host/on-prem, un tenant per installazione, egress default deny, nessuna azione irreversibile senza approvazione. Nucleo durevole: Pi Durable (`@earendil-works/pi-durable` 1.3.0, sperimentale), dietro un'interfaccia nostra.

Cosa fa:

- **Parla** con le persone su Telegram e nella console web, riprende le conversazioni dopo un crash e segnala le risposte che potrebbero arrivare due volte.
- **Usa i vostri sistemi** tramite connettori MCP, ognuno limitato al suo host.
- **Lavora con i file**: li crea, li legge, li invia e riceve quelli caricati.
- **È proattiva**: esegue task programmati, una volta o a ripetizione.
- **Mostra il lavoro in corso**: progressi e Stop nella chat, con storico persistente di conversazioni, task e automazioni. Stop non annulla azioni già completate.
- **Riprende il browser dopo il tuo accesso**: nelle chat private puoi prendere il controllo, compilare un modulo semplice e restituirlo a Owni. I cookie restano separati per persona e agente, e puoi cancellarli dal pannello ([limiti](docs/adr/0106-browser-personale-e-controllo-umano.md)).
- **Si estende da sola**: scrive nuovi tool, che girano isolati in sandbox e solo dopo l'approvazione di una persona.
- **Lavora come un'azienda**: l'organigramma dice chi coordina, chi risponde a chi e chi è responsabile di cosa. Ogni agente lo sa e passa al collega giusto quello che non è suo ([ADR 0117](docs/adr/0117-organigramma-degli-agenti.md)).

Documenti: [prodotto e checklist](docs/prodotto.md) · [runbook](docs/runbook.md) · [architettura](docs/architettura.md) · [glossario](GLOSSARY.md) · [decisioni](docs/adr/) · [stato e cose da fare](docs/stato-e-todo.md) · settimane [1](docs/week1.md), [2](docs/week2.md), [3](docs/week3.md), [4](docs/week4.md), [5](docs/week5.md) · [come contribuire](docs/contributing.md) · [piano iniziale](docs/piano-iniziale.md)

## Requisiti

- Node.js 24 o successivo (usa `node:sqlite`) e pnpm 10, oppure Docker.

## Avvio

```bash
cp .env.example .env     # basta ANTHROPIC_API_KEY
pnpm install
pnpm start               # al primo avvio il link dell'owner è in data/owner-login-link.txt
```

Con Docker: `docker compose up -d --build`, poi `docker compose exec owni cat /data/owner-login-link.txt`. Installazione, persone, Telegram, connettori, backup e aggiornamenti: [`docs/runbook.md`](docs/runbook.md).

Per provare senza chiave: `OWNI_MODEL_PROVIDER=faux pnpm start` usa un modello locale deterministico (eco; `/tool <nome> <json>` chiama un tool).

## Sviluppo

```bash
pnpm typecheck
pnpm test          # nessuna chiave, nessuna chiamata di rete esterna
pnpm eval:agente
pnpm build
```

### Solo il bot Telegram (sviluppo)

```bash
cp .env.example .env
# compila TELEGRAM_BOT_TOKEN (da @BotFather), ANTHROPIC_API_KEY
# e OWNI_TELEGRAM_ALLOWED_USERS (i tuoi user ID Telegram, separati da virgola)
pnpm dev:telegram
```

Al primo avvio crea il tenant `default` e l'istanza `telegram` in `data/`, con una egress policy che consente solo il provider modello configurato e il canale `telegram`, e salva la chiave del modello nel secret store del tenant. Agli avvii successivi riprende le conversazioni rimaste a metà.

Se manca una variabile il processo esce con il nome esatto, ad esempio:

```text
owni: Missing environment variable: ANTHROPIC_API_KEY. Set it in .env (see .env.example).
```

Per provare senza chiave del modello: `OWNI_MODEL_PROVIDER=faux` usa il modello locale deterministico (risponde con un'eco; "conta fino a 5" chiama il tool `slow_counter`). Il token Telegram resta necessario.

### Variabili d'ambiente

| Variabile | Obbligatoria | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sì | |
| `OWNI_MODEL_PROVIDER` | no | `anthropic` (uno dei 18 provider di [ADR 0032](docs/adr/0032-qualsiasi-modello.md), o `faux`) |
| `OWNI_MODEL_ID` | no | il modello di partenza del provider (`claude-sonnet-5-5`; `owni-dev` per `faux`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, ... | quella del provider scelto | |
| `OWNI_DATA_DIR` | no | `data` |
| `OWNI_TENANT_ID` | no | `default` |
| `OWNI_INSTANCE_ID` | no | `telegram` |
| `OWNI_TELEGRAM_ALLOWED_USERS` | no, ma senza nessuno può scrivere al bot | nessuno (default deny) |

## App desktop

Owni per Mac, Windows e Linux, con l'icona nella barra e una scorciatoia da qualsiasi app: [docs/desktop.md](docs/desktop.md).

## Struttura

```text
src/app.ts                    processo unico: istanze, canali, scheduler, console web
src/main/                     entry point (owni = pnpm start, cli = pnpm owni, telegram)
src/core/                     nucleo: runtime, tenant/istanze, segreti, audit, egress, outbox
src/core/workspace.ts         file per istanza; schedules.ts + scheduler.ts + cron.ts: task programmati
src/core/proposals.ts         tool proposti; approvals.ts decisioni; sandbox.ts esecuzione isolata
src/core/tools/               tool dell'istanza: file_*, schedule_*, tool_propose, tool approvati
src/core/adapters/pi-durable* unico punto che importa Pi Durable / pi-ai
src/channels/                 interfaccia ChannelAdapter, adapter Telegram (pulsanti, documenti)
src/connectors/               MCP, Google, fetch con egress
src/web/                      server HTTP, accesso, canale web, console (ui/: HTML, CSS, JS, font)
desktop/                      app desktop Tauri: una finestra sul server (docs/desktop.md)
src/gateway.ts                collega canali e nucleo
test/                         test (vitest), con processi figli reali per i crash
```
