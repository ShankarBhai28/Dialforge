# DialForge — Architecture

How the system fits together, for developers joining the project. Read this before changing anything that touches calls.
For *why* a decision was made, see `docs/adr/`. For the history of how each piece was built and the bugs found on the way, see `RUNBOOK.md`.

## 1. The big picture

```
 Browser (admin)           Browser (agent)
   admin UI                  agent UI + JsSIP softphone
      │  HTTPS/JSON             │  HTTPS/JSON        │ WebRTC (WSS signalling, SRTP media)
      ▼                         ▼                    ▼
 ┌──────────────────────────────────────┐   ┌────────────────────────────┐
 │ backend/server.js  (Express, :3000)  │   │ Asterisk 22 (PJSIP)        │
 │  REST API, sessions, call control    │◄─►│  ARI app "dialforge-app"   │
 │  ARI client  (ari.js)                │   │  AMI (queue events)        │
 │  AMI client  (ami.js)                │   │  native Queue()            │
 └───────────────┬──────────────────────┘   │  dialplan: extensions-*.conf│
                 │                          └──────────┬─────────────────┘
 ┌───────────────┴──────────────────────┐              │ SIP trunk
 │ backend/dialer-engine.js (systemd    │◄─ ARI app ──►│ (nxtra = TEST ONLY)
 │  dialforge-dialer) hopper + pacing   │ "dialforge-dialer"
 └───────────────┬──────────────────────┘              ▼
                 ▼                                   PSTN
              MySQL (dialforge_dev)
```

There are **two Node processes**, both in `backend/`:

| Process | systemd unit | ARI app name | Job |
|---|---|---|---|
| `server.js` | `dialforge-backend` | `dialforge-app` | API for both UIs, login, click-to-call, inbound routing, transfer/conference, queue membership |
| `dialer-engine.js` | `dialforge-dialer` | `dialforge-dialer` | Campaign dialing: fills the hopper, decides how many calls to place, originates them, records results |

They share MySQL and never call each other directly. The dialer engine takes a DB lock, so only one instance can run.

## 2. Asterisk: who controls what

DialForge uses **two ways to talk to Asterisk**, and knowing which one is in charge of a call matters:

- **ARI (Stasis)** — our code *owns* the channel: it answers, bridges, plays audio and hangs up. Used for click-to-call, the dialer's outbound legs, and transfer/conference.
- **Native `Queue()` + AMI events** — Asterisk owns the channel while it waits in a queue and rings agents (ring strategy, `ringinuse=no`, hold music). Stasis sees nothing during that time, so `server.js` listens to **AMI** events (`AgentConnect`, `AgentComplete`, `QueueCallerAbandon`, `UserEvent`) to keep the `calls` table and agent status correct.

Dialplan files (installed in `/etc/asterisk/`, `#include`d from `extensions.conf`):

| Context | File | What it does |
|---|---|---|
| inbound from trunk | server only | `Stasis(dialforge-app, inbound, <caller>, <dialed DID>)` |
| `[queue-dispatch]` | server only | `Queue(${QUEUENAME})` — inbound calls after the app has picked the campaign |
| `[dialer-answered]` | `backend/asterisk/extensions-dialer.conf` | Dialer call answered: optional AMD → `Queue()` with max wait → abandon prompt |
| `[df-control]` | `backend/asterisk/extensions-control.conf` | Pulls both legs of a queue call back into Stasis (`adopt`) so a transfer/conference can start |

## 3. Main call flows

**Click-to-call (agent dials a lead).** `POST /calls/click` → originate the agent's WebRTC extension (`click2call,<id>,agent`) → when it answers, originate the customer through the trunk (`click2call,<id>,dest`) → bridge both in a mixing bridge. State is held in `activeCalls` (memory) and `calls` (DB).

**Inbound.** Trunk → `Stasis(inbound)` → look up the DID in `dids` to pick a campaign → insert a `calls` row → set `QUEUENAME` → continue to `[queue-dispatch]`. Asterisk's queue rings agents; AMI `AgentConnect` fills in which agent answered.

**Dialer (progressive / predictive).** Every tick the engine, per running campaign: cleans and refills `dial_hopper`, counts idle agents, works out the dial ratio (predictive learns from answer and abandon rates), claims leads, and originates customer legs into `[dialer-answered]`. Answered calls enter the campaign queue, the same as inbound. Each try is a row in `dial_attempts`; `finishAttempt` (in `dialer-common.js`) records the result and applies the **recycle rules** (redial later, or mark the lead final).

**Transfer / conference** (`call-control.js`). A queue call is first "adopted": AMI Redirect sends both legs to `[df-control]`, which puts them back into Stasis in our own bridge. Then: blind, warm (customer on hold with music, agent talks to the target first) or conference (everyone in one bridge), to an agent, a queue or an outside number. Click-to-call calls are already in Stasis, so they skip the redirect.

## 4. Agent state

Agent status lives in `agent_status_log` (latest row per agent). The values are `available`, `break`, `acw` (after-call work) and `logout`. Every change also drives real Asterisk queue membership (`QueueAdd` / `QueuePause` / `QueueRemove`), so `queue show` on the server always matches the UI. After a call the agent goes to ACW, and back to Available after the campaign's wrap-up time.

## 5. Data model (main tables)

| Area | Tables |
|---|---|
| Tenancy & users | `tenants`, `users`, `extensions`, `teams`, `team_members`, `team_campaigns` |
| Campaigns | `campaigns` (dial mode, ratio, hours, auto answer, AMD, max wait…), `queues`, `dids`, `campaign_dispositions`, `campaign_recycle_rules` |
| Leads | `lists`, `leads`, `callbacks`, `dnc_numbers`, `recycle_log` |
| Forms | `forms`, `form_fields`, `form_responses` |
| Calls | `calls`, `call_events` (append-only audit), `dial_attempts`, `dial_hopper`, `dialer_status` |
| Agents | `agent_status_log` |

Every table has `tenant_id` (always 1 today; multi-tenant is planned). The schema is `backend/schema.sql` plus `backend/migration-*.sql`, applied in order.

## 6. Code map

| Path | What |
|---|---|
| `backend/server.js` | Entry point only: checks `.env`, connects AMI, builds the app, starts telephony events, listens on HTTPS |
| `backend/src/app.js` | `createApp()`: middleware plus every route module. Opens no connections, so tests can build it freely |
| `backend/src/routes/*.js` | One Express router per area (campaigns, leads, forms, dialer, agent, reports…). Full URL paths are written in each file, so grep for a URL finds its handler |
| `backend/src/services/*.js` | Logic shared by several routes: agent status and queue membership, dispositions, forms validation, DNC, lead import, campaign settings |
| `backend/src/telephony/events.js` | `start()`: ARI Stasis handler (inbound, click-to-call) and AMI queue event handlers. Called once by `server.js` only |
| `backend/src/webApp.js` | Serves the built React app (`backend/web-dist`) at `/app`; unknown `/app/...` URLs get `index.html` |
| `web/` | React app; see `docs/FRONTEND.md` |
| `backend/src/realtime/hub.js` | WebSocket `/ws`: pushes live updates to logged-in browsers (§8) |
| `backend/src/middleware/auth.js` | `requireAuth`, `requireRole('admin')` |
| `backend/src/config.js`, `src/state.js` | Settings from `.env`; in-memory call maps shared by routes and telephony |
| `backend/call-control.js` | Transfer / conference state machine |
| `backend/dialer-engine.js` | Dialer process |
| `backend/dialer-common.js` | Code shared by both processes (attempt results, recycle rules) |
| `backend/ari.js`, `backend/ami.js` | Thin Asterisk clients (no third-party ARI/AMI library) |
| `backend/public/` | Current admin and agent pages (plain HTML/JS) — being replaced by `web/` |
| `backend/tests/` | `node:test` suites run with fakes; no Asterisk or DB needed |
| `bot-service/` | AI voice-bot audio plumbing (proof of concept) |
| `docs/` | This file, RUNBOOK, DEPLOY, STATUS, plans, checklists, ADRs |

### Where new code goes
- A new endpoint goes in the matching `src/routes/<area>.js`, or a new file added to `ROUTERS` in `src/app.js`. Protect it with `requireAuth` or `requireRole('admin')`; `tests/routes.test.js` fails if a route is public by accident or an admin route lets agents in.
- Logic used by more than one route, or worth unit-testing, goes in `src/services/`. Services never import routes.
- Anything reacting to Asterisk events goes in `src/telephony/` or `call-control.js`.

## 7. Configuration

All settings come from `backend/.env` (template: `backend/.env.example`). Never commit `.env`.
Extra optional setting: `DIALER_MAX_TRUNK_CHANNELS` caps how many trunk channels the dialer may use (default 4).

## 8. Live updates (WebSocket `/ws`)

Browsers open `wss://<host>:3000/ws` after logging in. The upgrade is checked against the same session cookie as the REST API; no login gets a 401. Each message is JSON `{ type, data, at }`.

| type | data | Sent to |
|---|---|---|
| `hello` | `{ user, role }` | the new connection |
| `agent.status` | `{ userId, status, reason, queueId, extensionName }` | admins + that agent |
| `call.event` | `{ callId, eventType, payload }` (every `call_events` row) | admins |

Publish from server code with `require('./src/realtime/hub').publish(type, data, { toUserId })`. More message types get added as React screens need them (Stages 3–4). The old HTML pages still poll and don't use `/ws`.
