# DialForge — Project Status & Plan

**Purpose of this document**: a fast, at-a-glance snapshot of where the project stands — phases done/pending, exactly what's installed with versions, how to access everything, and what's next. For the detailed *why* and *how* behind each of these (including bugs found and fixed), see `RUNBOOK.md` — that's the narrative log; this is the dashboard.

Last updated: 2026-10-05 (Phase 15 — GitHub + secrets rotation + deploy guide). This will go stale — check the RUNBOOK's most recent entries if something here seems out of date.

---

## 1. Phase Status

| Phase | Status | What it covers |
|---|---|---|
| **Phase 0** | ✅ Done | AWS EC2 setup, Asterisk 22 + PJSIP built from source, WebRTC calling between two test extensions, TURN server (with a restrictive-network fallback on port 443), real domain + Let's Encrypt cert |
| **Phase 1** | ✅ Done | ARI-driven call control (our own Node.js code deciding what happens to a call, instead of static dialplan `Dial()`) |
| **Phase 2** | ✅ Done | Real SIP trunk registered to a reseller (nxtra) fronting a Tata Communications line, confirmed working both ways — first real outbound PSTN call connected 2026-09-30 |
| **Phase 3** | ✅ Core flow done | Database (MySQL), backend REST API, real click-to-call (now trunk-aware), real login/role system (admin vs agent), polished agent panel (embedded WebRTC softphone, live status + queue selection + Login/Talk/Break/Handle/ACW time tiles + call log + dialpad + hangup), polished admin panel (Dashboard + real-time Live Agents + Users + Call Log + Campaigns, sidebar-nav SPA layout), phpMyAdmin for DB access. |
| **Phase 4** | ⬜ Not started | Multi-tenant enforcement (schema already has `tenant_id` everywhere, just not enforced/exposed in UI yet), billing, self-serve onboarding |
| **Phase 5** | 🔶 Audio plumbing done | New `bot-service` proven: Asterisk streams live call audio into our own code (ARI `externalMedia`), and we can play audio back into the call (ARI bridge `play`). Real STT/LLM/TTS conversation logic not started yet |
| **Phase 8** | ✅ Done | Real inbound PSTN calls route through Asterisk's **native `Queue()` app** — real ring strategy, real hold, real skip-if-unreachable — not our own agent-picker. AMI events (`AgentConnect`/`AgentComplete`/`QueueCallerAbandon`) keep our own `calls` DB tracking and ACW auto-transition working even though Stasis loses visibility once a call is hooked into `Queue()`. Per-campaign **Auto Answer** resolves from the agent's current queue (race-free, no dependency on AMI timing). Queues are **real Asterisk queues** — `queue show` lists them, and Available/Break/ACW/Logout transitions drive real `QueueAdd`/`QueuePause`/`QueueRemove`. The agent status pill also stays in sync with server-initiated changes (e.g. auto-ACW) via the existing stats poll. |
| **Phase 9** | ✅ Done | Real **DID → campaign mapping** — the dialed number (not just caller ID) is now passed through the dialplan and looked up against a `dids` table before picking a campaign/queue, with a loudly-logged fallback if a DID genuinely isn't mapped yet. Admin panel has a DID Numbers management card. Verified both the matched and fallback paths directly. |
| **Phase 10** | ✅ Done | **Outbound campaigns** — leads are now campaign-scoped (`leads.campaign_id`, agents only see/dial their current campaign's leads), per-campaign outbound CLI is actually used by click2call (was stored since Phase 8, never read until now), and a real post-call disposition workflow (New/Interested/Not Interested/Callback/No Answer/Do Not Call) with **enforced** DNC — click2call refuses to dial a lead marked Do Not Call, verified directly. Scoped to manual/preview dialing, not a predictive-dialer pacing engine. Admin panel also gained a Leads table (campaign + disposition visible per lead) — built as the natural next vertical slice, not a broader "admin-first" pass. |
| **Phase 11** | ✅ Done | **Reports** — Campaign / Agent / Call (filterable) / Hourly, each with CSV export. Every number traced to a real column, nothing invented (no fake Busy/Failed breakdown — that data doesn't exist yet). Agent Report correctly attributes calls via a time-windowed join to whichever extension an agent was *actually* using, avoiding the login-extension bug fixed twice earlier. Added `leads.updated_by` to make "Callbacks per agent" answerable rather than guessed. |
| **Phase 12** | ✅ Done | **CSV lead import** — campaign-scoped bulk lead upload (`multer` for the multipart upload, hand-rolled CSV parsing for correct quoted-field handling), duplicate detection against both existing DB rows and the file itself, invalid-phone filtering, downloadable template. Verified via curl with an adversarial test file before the UI was built; re-import of the same file correctly produced all-duplicates on the second pass. Leads, Queues, and DID Numbers now each live in their own top-level sidebar module, not nested inside Campaigns — Campaigns itself is now just campaign definitions. |
| **Phase 13** | ✅ Done | **Edit/Delete** for Queues, Campaigns, DID Numbers, and Leads — all four were Create + List only before this. Deletes are blocked with a specific error (not silent nulling) when something still references the row, backed by real DB foreign keys plus explicit pre-checks for a precise message. Queue edits rewrite the live `/etc/asterisk/queues.conf` stanza and reload Asterisk, same as queue creation. |
| **Phase 14** | ✅ Done | **Lead Lists** — a named batch of leads within a campaign (`lists` table, `leads.list_id`). CSV import now targets a list (campaign derived from it) instead of landing loose in the campaign. Full Create/Edit/Delete, same blocked-delete pattern as Phase 13. No agent-facing "dial from this list" feature — purely an admin-side organizational layer, deliberately scoped that way. |
| **Phase 15** | ✅ Done | **GitHub + secrets rotation + fresh-server deploy guide** — all hardcoded secrets (DB/ARI/AMI/session/demo passwords) moved to `.env` and rotated live; 30 commits squashed into one clean commit with zero secret strings (verified directly); pushed to a private GitHub repo (`ShankarBhai28/Dialforge`). `docs/DEPLOY.md` rewritten into a fully standalone, copy-paste walkthrough for standing up a second server from scratch (Asterisk+WebRTC+app, trunk deliberately deferred to Appendix B). Also fixed a Phase 13 gap (queue delete didn't check `agent_status_log` references) and a stale pre-systemd cert-renewal hook. |

**Immediate next steps once picked back up**: no automated tests exist anywhere yet - worth a minimal smoke-test pass given how many interacting subsystems there now are (ARI, AMI, MySQL, sessions, WebRTC). Also want to re-add `qualify_frequency` monitoring on the trunk AOR (dropped during Phase 2 troubleshooting) so we get visibility if nxtra's registration drops. ~~Rotate hardcoded secrets (session secret, DB/ARI/AMI passwords) to environment variables~~ — **resolved 2026-10-05** (Phase 15). For Phase 5, next is wiring up the actual AI conversation (OpenAI Realtime or Gemini Live, per earlier decision) on top of the now-proven audio plumbing - deliberately deferred while CRM/queue infrastructure was the focus. Phase 4 (multi-tenant enforcement/billing) not started. The bot service still needs the same systemd treatment the Node backend got. Ring-strategy behavior has only been tested with one agent in a queue, not 2+ simultaneously. Per-campaign outbound CLI is code-reviewed but not live-fire verified with a distinguishing value (see RUNBOOK Phase 10).

---

## 2. Server Inventory (exact versions, as of 2026-09-24)

| Software | Version | Purpose |
|---|---|---|
| Ubuntu | 24.04.5 LTS | Base OS |
| Asterisk | 22.11.0 (built from source) | Telephony core — PJSIP, ARI, WebRTC |
| pjproject | 2.17 (Asterisk's own bundled copy is what's actually used) | SIP/media stack underneath Asterisk |
| coturn | 4.6.1 | TURN/STUN server — two instances (port 3478 plain, port 443 TLS/TURNS fallback) |
| Node.js | 24.21.0 (LTS, via NodeSource) | Backend runtime |
| npm | 11.19.0 | Node package manager |
| MySQL | 8.0.46 | Database (switched from Postgres — see RUNBOOK section 7) |
| Apache | 2.4.58 | Web server for phpMyAdmin |
| PHP | 8.3.6 | Required by phpMyAdmin |
| phpMyAdmin | 5.2.3 (manual install, not the `.deb` package) | DB admin GUI |
| certbot | 2.9.0 | Let's Encrypt certificate management (webroot method) |

**Instance**: AWS EC2 `c7i-flex.large` (2 vCPU, ~3.7GB RAM), region `ap-south-1`, Elastic IP `3.7.241.104`, domain `dialforge.ddnsfree.com` (free DDNS via Dynu). 2GB swap configured. ~7.6GB of 29GB disk used.

---

## 3. Running Services & Ports

| Service | Port(s) | Notes |
|---|---|---|
| `sshd` | 22 (TCP) | Restricted to "My IP" in security group |
| Apache | 80 (TCP, redirects `/phpmyadmin` to 8443), 8443 (TCP, HTTPS) | phpMyAdmin |
| Asterisk HTTP/WSS | 8088 (TCP), 8089 (TCP, HTTPS/WSS) | WebRTC signaling, ARI, static test page |
| Asterisk AMI | 5038 (TCP, localhost only) | Manager Interface — used only for real queue membership (`QueueAdd`/`QueuePause`/`QueueRemove`), never exposed externally |
| Asterisk SIP | 5060 (UDP) | Live SIP trunk to nxtra/Tata Communications (Phase 2) — security-group-restricted to nxtra's IP `152.52.42.148/32` only, not "Anywhere" |
| RTP media | 10000-20000 (UDP) | Call audio |
| coturn (main) | 3478 (TCP+UDP) | TURN relay |
| coturn (fallback) | 443 (TCP+UDP, TLS/TURNS) | For networks that block port 3478 |
| coturn relay range | 49152-49300 (UDP) | Actual media relay ports |
| MySQL | 3306 (localhost only — not exposed externally) | Only phpMyAdmin/backend talk to it directly |
| Node backend | 3000 (TCP, HTTPS) | REST API + frontend. Now a systemd service (`dialforge-backend`) — auto-starts on boot, auto-restarts on crash |
| Bot service | 12000 (UDP, localhost/private IP only) | ARI `externalMedia` audio in/out for the Phase 5 bot — receives call audio, plays responses back |

**All services confirmed set to auto-start on boot** (`systemctl enable`d): Asterisk, coturn, coturn-443, MySQL, Apache, and now the **Node backend** (`dialforge-backend.service`, added 2026-09-30 — auto-restarts on crash too, verified via `kill -9`). **Exception**: the bot service is still started manually (`nohup node ...`) — not yet a systemd service.

---

## 4. How To Access Everything

| What | How |
|---|---|
| SSH into the server | `ssh -i dialforge-key.pem ubuntu@3.7.241.104` |
| WebRTC test softphone | `https://dialforge.ddnsfree.com:8089/static/test.html` — register as `1001` or `1002`, call each other or dial `9000` for the ARI-controlled bridge |
| Agent login | `https://dialforge.ddnsfree.com:3000/login.html` — `agent1001`/`agent1002`, password in `Credentials-Dialforge/` (not in git, see Phase 14). **Must use the domain, not the raw IP** — the cert is only valid for the hostname. After logging in, agents connect a WebRTC extension right in the panel (no separate test page needed anymore, see Phase 6 in RUNBOOK) |
| Admin login | Same login page — `admin`, password in `Credentials-Dialforge/` (redesigned: Dashboard / Live Agents / Users / Call Log sidebar) |
| phpMyAdmin (DB GUI) | `https://dialforge.ddnsfree.com:8443/phpmyadmin/` — log in with MySQL user `dialforge` |
| Backend API directly | `curl https://dialforge.ddnsfree.com:3000/health` (or `/leads`, `/calls`, `POST /calls/click2call`, admin-only: `/admin/dashboard`, `/admin/live-agents`, `/admin/users`, `/admin/extensions`) |
| Local project files | `C:\Users\User01\DialForge\` (git repo — `docs/`, `backend/`, `ari-hello-world/`, `bot-service/`) |
| Bot service test | Dial `9001` from a registered WebRTC extension — bridges to the bot service, echoes your audio back and plays "hello world" after ~3s |

---

## 5. Known Limitations / Tech Debt (intentional, tracked, not forgotten)

- ~~Node backend isn't a systemd service yet~~ — **resolved 2026-09-30**: `dialforge-backend.service`, `Restart=on-failure`, `systemctl enable`d. The bot service (`bot-service/`) still needs the same treatment.
- ~~Frontend is plain HTTP, not HTTPS~~ — **resolved 2026-09-30**: Node backend now serves HTTPS directly (same Let's Encrypt cert as Asterisk/Apache, copied to a location the `ubuntu` user can read, with a renewal deploy hook to keep it fresh). This was required, not cosmetic — browsers block microphone access on non-secure pages, which silently broke the embedded WebRTC softphone in the agent panel.
- ~~Click-to-call only dials our own test extensions~~ — **resolved 2026-09-30**: `resolveDestination()` now routes real numbers through the trunk automatically, with the authorized CLI stamped.
- Trunk AOR (`dialforge-nxtra1`) has no `qualify_frequency` set — dropped during Phase 2 troubleshooting (see RUNBOOK) and not yet re-added, so a dropped registration on nxtra's side won't show up as a status change until someone checks `pjsip show contacts` manually.
- ~~Inbound calls arriving via the trunk just answer + play a test sound~~ — **resolved 2026-09-30**: routes into ARI, finds an available agent, rings them with a real Accept/Reject popup. Still simplistic: picks any available agent globally, not scoped to a queue/campaign — see Phase 8 in the table above.
- Campaigns/queues exist and are admin-manageable (queue is standalone, campaign references one queue + CLI + auto-answer — matches reference-product structure, see RUNBOOK), but nothing enforces which queue an inbound DID belongs to yet — that mapping doesn't exist. Ring strategy/wait timeout/announce/retry/timeout-restart are stored per queue but not yet used by the actual routing logic (which only ever considers one candidate agent, not a real ring group). Auto Answer *is* fully wired end-to-end though — that one's real, not just stored.
- Multi-tenancy: schema has `tenant_id` everywhere, but every row is hardcoded to tenant `1` — no enforcement or UI for multiple tenants yet (by design, per the original phased plan — this comes in Phase 4).
- ~~Asterisk endpoints restricted to `opus` only~~ — **resolved 2026-09-25**: `1001`/`1002` now prefer `ulaw` (with `opus` still allowed as fallback). This was required because stock Asterisk can't *encode* opus at all (only pass through already-opus audio from a browser), which silently broke both playing sound files and any future TTS output. `ulaw` also happens to be what the eventual PSTN trunk will need anyway.
- Bot service (`bot-service/`) is a proof-of-concept only — it echoes raw audio and can play one canned sound. No real STT/LLM/TTS integration yet (that's the next Phase 5 step), and its raw-RTP echo code path should be removed once real audio processing replaces it (it was a diagnostic step, not meant to stay).
