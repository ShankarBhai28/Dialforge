# DialForge — Application Rebuild Plan (React frontend + structured backend)

Status: **in progress** — Stages 0–4 built and deployed 2026-10-09: every admin screen and the agent screen are at `/app`. Next: the real-call test of the agent screen (checklist section "New agent screen"), then Stage 5 (switchover). Branch: `react-frontend` (cut from `predictive-dialer`).

## Why
- `admin.html` (2,600 lines) and `agent.html` (2,000 lines) are single files that mix layout, styling and logic. Every new feature makes them harder to change safely.
- `server.js` (2,700 lines, ~85 endpoints) has every route in one file.
- Other developers will work on this. They need a standard stack, a clear folder layout, written conventions and automatic checks, so they can add features without breaking the dialer.

## Decisions
| Area | Choice | Why |
|---|---|---|
| Frontend | **React 19 + TypeScript + Vite** | Industry standard, easy to hire for; types catch wrong field names before the browser does |
| UI kit | **Tailwind CSS + shadcn/ui** | Clean look; ready tables, forms, dialogs; components live in our repo, so we can change them |
| Routing / data | **React Router**, **TanStack Query** | Standard routing; caching, loading and error states handled one way everywhere |
| Forms | **React Hook Form + Zod** | One validation pattern for every admin form |
| Live updates | **WebSocket** (`ws`, already installed) | Replaces 1.5 s polling; the agent screen reacts immediately |
| Softphone | **JsSIP**, wrapped in one module | Already proven on real calls; the rest of the app never touches JsSIP directly |
| Backend | **Keep Node/Express + MySQL**, split into modules | It works on real calls; a rewrite would only add risk. Move to TypeScript gradually |
| Tests | **Vitest** + React Testing Library, **Supertest** (API), **Playwright** (browser smoke) | Real-call checklist stays manual |
| Quality | ESLint + Prettier, `.editorconfig`, `.gitattributes` | Same style for everyone; also fixes the CRLF/LF mix |
| CI | GitHub Actions: lint, typecheck, test and build on every PR | Free minutes cover a private repo at this size |

## Order: foundation and admin first, agent screen after
1. The admin screens carry no live-call risk, so they are where the patterns get set. Developers then copy those patterns: page layout, tables, forms, API hooks, errors.
2. The agent screen needs everything built before it: login, the API client, WebSocket events, shared components.
3. Agents keep using the proven `agent.html` until the React version passes the real-call checklist. Nothing they use daily changes until then.

## Target layout
```
DialForge/
  backend/                 Express API, ARI/AMI, dialer engine (path kept: systemd units use it)
    src/routes/            one file per area: auth, agent, campaigns, leads, lists, forms,
                           dialer, queues, numbers, users, teams, reports, callControl
    src/services/          business logic (dialer-common, call-control, ...)
    src/telephony/         ari.js, ami.js
    src/realtime/          WebSocket hub: agent + admin events
    tests/
  web/                     React app (served by Express at /app)
    src/app/               router, providers, layout (sidebar, topbar)
    src/features/<area>/   pages, components, api hooks per area
    src/softphone/         JsSIP wrapper + call state machine
    src/components/ui/     shadcn components
    src/lib/               api client, websocket client, formatters
  docs/                    ARCHITECTURE, CONTRIBUTING, RUNBOOK, DEPLOY, adr/
  .github/workflows/ci.yml
```

## Stages (each one: commit → server backup → deploy → verify → RUNBOOK entry)

### Stage 0 — Developer foundation
- npm workspaces (`backend`, `web`), ESLint, Prettier, `.editorconfig`, `.gitattributes` (LF everywhere).
- `README.md` (what DialForge is, 10-minute local setup), `docs/ARCHITECTURE.md` (call flows, ARI vs AMI, dialer engine, data model), `docs/CONTRIBUTING.md` (branches, commit style, PR checklist, "never test on the live trunk"), `docs/adr/` (records of decisions like the ones above).
- Local dev: the React dev server proxies the API to dialforge-dev, so a developer needs no Asterisk on their laptop.
- CI workflow.

### Stage 1 — Backend restructure (no behaviour change)
- Split `server.js` into route and service modules. Endpoints and URLs stay identical, so the old HTML pages keep working.
- One error format `{ error, code }`; input validation on write endpoints.
- WebSocket hub at `/ws`: agent status, call ringing/answered/ended, transfer state, dialer stats.
- Supertest tests for login, campaigns, leads and the agent call-state endpoints.

### Stage 2 — React app shell
- Vite + React + TS + Tailwind + shadcn; login using the existing session cookie; role-based routes (admin / agent).
- Layout with the collapsible sidebar groups; typed API client; toasts; loading and error screens.
- Express serves the built app at `/app`. The old pages stay at their current URLs.

### Stage 3 — Admin screens (one commit each)
Dashboard + Live Agents → Campaigns (settings, dispositions, recycle rules) → Leads & Lists (Excel upload, recycle) → Forms → Dialer (start/pause/stop, hopper, today's stats) → Callbacks, DNC → Queues, DID Numbers → Users, Teams → Call Log, Reports.

### Stage 4 — Agent screen
- Softphone module: registration, incoming/outgoing, mute/hold/DTMF, ringtone, reconnects, as one state machine.
- Status bar + tiles; Leads | Workspace (lead + form) | Dialpad + history; preview card; in-call panel; transfer/conference; outcome popup; callbacks.
- Pass the full real-call checklist with two agents and your own mobile before switching over.

### Stage 5 — Switchover
- `/` opens the React app. Old pages stay reachable for one week as a fallback, then get deleted.

### Stage 6 — Ongoing
- Move backend modules to TypeScript one at a time and share types with `web/`.
- Then continue the dialer roadmap (D10 load test, D11 pilot) on the new structure.

## Rules during the rebuild
- No new features in the old HTML pages unless something breaks.
- Dialer and telephony behaviour do not change during Stages 0–3.
- Same server rules as before: back up before every change, don't start campaigns, the nxtra trunk is for testing only.

## Follow-ups found while rebuilding (Stage 3)
Backend gaps the new screens work around. None of them blocks the switchover.

**Security / correctness**
- ~~`GET /agent/extension-credentials/:extension` gives any agent any extension's SIP password~~ — **done 2026-10-10**: agents always get their own assigned extension's credentials (see Stage 4 follow-ups).
- ~~Users can't be edited, no password reset~~ — **done 2026-10-09**: edit role and extension, reset password, deactivate (no delete, by design), and create checks that the extension exists.
- ~~Team ids not validated~~ — **done 2026-10-10**: unknown agent, campaign or extension ids get a 400 naming them.
- ~~`POST /admin/lists` unknown campaign = raw 500~~ — **done 2026-10-10**: 400 "campaign not found" (create and edit).
- ~~`PUT /admin/leads/:id` list/campaign mismatch, no `alt_phone` / `priority`~~ — **done 2026-10-10**: the list must belong to the chosen campaign, and alt phone and priority are editable. Form fields (`custom_data`) became editable too on 2026-10-10.
- ~~`POST /admin/campaigns` ignores `status`~~ — **done 2026-10-10**: create takes active or paused; both create and edit check it.

**Scale (needed before real volume)**
- ~~Server-side paging and filtering~~ — **done 2026-10-09**: leads, calls, DNC and callbacks page and filter on the server.
- ~~Dialer screen polls every 3 s~~ — **done 2026-10-10**: the backend pushes `dialer.status` on `/ws` when the screen would change (`realtime/dialerFeed.js`); the screen keeps a 15 s safety refresh.
- ~~JS bundle 615 kB~~ — **done 2026-10-09**: each screen is lazy-loaded; first load 370 kB (116 kB gzipped).

**Done during Stage 3:** `/admin/extensions` no longer returns `sip_password`, and queue settings are validated before they are written to `queues.conf`.

## Follow-ups found in Stage 4
- ~~TURN password is public~~ — **done 2026-10-09**: coturn now uses `use-auth-secret`. `/agent/webrtc-config` signs a per-login password that expires after 12 h, and the old fixed password is refused.
- The classic agent page sets ICE servers on the UA, where JsSIP ignores them, so it has never used STUN/TURN. The new screen passes them per call. Not worth fixing in the classic page; it is being retired.
- ~~Extension choice open to any agent~~ — **done 2026-10-10**: an agent always connects with the extension assigned in Users; the Connect screen shows it read-only. (A per-team extension list was tried the same day and removed: with a fixed extension it has no purpose.)

