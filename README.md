# DialForge

A dialer CRM built from scratch on Asterisk 22. It has:
- inbound queues, click-to-call, and preview, progressive and predictive dialing;
- campaigns, lead lists with Excel upload, custom forms, dispositions, callbacks, DNC and automatic redial;
- a WebRTC agent softphone with transfer and conference;
- reports;
- an AI voice-bot layer in progress.

## New here? Read in this order
1. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit together and how a call flows.
2. **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** — setup, branches, PR checklist, safety rules.
3. **[docs/APP_REBUILD_PLAN.md](docs/APP_REBUILD_PLAN.md)** — the move to a React frontend that is in progress now.
4. **[docs/adr/](docs/adr/)** — why the big technical choices were made.

Reference: [RUNBOOK](docs/RUNBOOK.md) (history of every build step and bug fix) · [STATUS](docs/STATUS.md) (phase dashboard, server versions) · [DEPLOY](docs/DEPLOY.md) (fresh server and updates) · [Dialer test checklist](docs/PREDICTIVE_DIALER_TEST_CHECKLIST.md)

## Quick start (developers)
```
npm install && npm --prefix backend install
npm run check        # lint + formatting + tests
```
Running the full system needs Asterisk and MySQL on a server; see `docs/DEPLOY.md`.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Express REST API, ARI/AMI call control, dialer engine, MySQL schema and migrations, tests |
| `backend/public/` | Current admin and agent pages (plain HTML) — being replaced by `web/` |
| `backend/asterisk/` | Dialplan files the app depends on |
| `web/` | React + TypeScript app (from Stage 2 of the rebuild) |
| `bot-service/` | AI voice-bot audio plumbing (proof of concept) |
| `docs/` | Architecture, contributing, plans, runbook, deploy guide, decision records |
| `ari-hello-world/`, `phase0/` | Early experiments, kept for reference only |

## Scripts (repo root)

| Command | Does |
|---|---|
| `npm run check` | Everything CI runs: lint, formatting check, tests |
| `npm run lint` | ESLint |
| `npm run format` | Rewrites files with Prettier |
| `npm test` | Backend tests (`backend/tests/`, no Asterisk or DB needed) |
