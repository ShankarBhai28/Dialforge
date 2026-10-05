# DialForge

An original, from-scratch AI-driven dialer CRM - real Asterisk queue
integration, campaign/lead management, reporting, and (in progress) an AI
voice-agent layer on top of ARI's audio plumbing.

- **`docs/RUNBOOK.md`** - the narrative log: what was built, in what order,
  why, and every bug found/fixed along the way. Start here to understand a
  design decision.
- **`docs/STATUS.md`** - the dashboard: phase status, exact server
  versions/ports, and known tech debt. Start here for "where do things
  stand right now."
- **`docs/DEPLOY.md`** - the procedural checklist for setting up a fresh
  server or deploying an update to an existing one.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Node.js/Express REST API + static admin/agent frontend, MySQL via `mysql2`, hand-rolled ARI/AMI clients |
| `bot-service/` | Phase 5 proof-of-concept: ARI `externalMedia` audio plumbing for the planned AI voice-agent layer |
| `ari-hello-world/` | Phase 1 historical artifact, superseded by `backend/ari.js` - kept for reference only |
| `docs/` | RUNBOOK, STATUS, DEPLOY as described above |

## Quick start

See `docs/DEPLOY.md` for the full checklist (Asterisk config, MySQL schema,
`.env` setup, systemd unit). The short version, once Asterisk/MySQL exist:
```
cd backend
cp .env.example .env   # fill in real values
npm install
node seed-users.js     # one-time initial accounts
node server.js
```
