# Week 3 — Segreteria commerciale (Telegram)

> Nota (settimana 4): questa settimana ha consegnato la logica provata con fake. Mancavano entry point, pulsanti Telegram, modello e adapter live, e le eval misuravano il template partendo dal gold. Vedi [`week4.md`](week4.md).

Branch: `week-3` (based on `ci-setup` so PR CI runs). Spec: [`spec-segreteria-commerciale.md`](spec-segreteria-commerciale.md).

## What shipped

- **Pratica store** (`src/core/practice.ts`): durable JSON pratiche, mailMessageId index, statuses including `logged`, flow actions `log_only` / `notify_only`, Lead fields `title`, `originalLanguage`, `vatNumber`, missing-fields incl. deliverySite/budget/deadline.
- **Mail / CRM adapters** (`src/connectors/`): interfaces + fakes; Gmail/HubSpot stubs (live API not enabled without Mario’s secrets).
- **Durable tools**: `send_email` (`replaySafe: false`), `mail_read`, `crm_upsert_lead`, `request_approval` / `record_approval`.
- **Pipeline** (`src/segreteria/`): classify → extract → CRM upsert → draft → Telegram proposal with exactly three buttons; callbacks Approva/Modifica/Scarta; crash recovery re-proposes buttons (never silent send).
- **Model routing + caps** (`model-routing.ts`, `usage.ts`): Haiku extract / Sonnet draft; soft $5 / hard $20 with verbatim Telegram copy.
- **Evals** (`evals/segreteria/`): 35 cases from AI Guru; `pnpm eval:segreteria` runs deterministic checks (prices, lei/tu, mustAsk, multi, PII) in PR CI; judge nightly.

## Policy

«Bozze, non invii autonomi.» Nothing calls `sendReply` without allowlisted **Approva**.

## Out of scope / blocked on secrets

Live Telegram bot token, model API keys, Gmail OAuth, HubSpot token, `OWNI_TELEGRAM_ALLOWED_USERS` — tests use fakes only.
