# DialForge — Predictive Dialer: Design & Implementation Plan

Status: **design only, nothing built yet** (written 2026-10-08).
Builds on what already exists: campaigns, queues (real Asterisk `Queue()`), lists (Phase 14), CSV lead import (Phase 12), dispositions + DNC enforcement (Phase 10), click-to-call via ARI, per-campaign auto-answer, AMI-driven agent states.

---

## 1. Review of the requested flow

| # | Your idea | Verdict | Correction / addition |
|---|---|---|---|
| 1 | Create list → pick from available campaigns | ✅ Correct (already works this way since Phase 14) | Add `lists.is_active` + `lists.priority` so the dialer knows *which* lists of a campaign to dial and in what order. |
| 2 | Upload leads with an Excel format | ✅ Correct | Today import is CSV only → add `.xlsx` (use the `exceljs` library). Template must include custom-form fields, stored in `leads.custom_data` (JSON). Normalize phones to one format; DNC-scrub at import. |
| 3 | Campaign type: manual / preview / progressive / predictive | ✅ Correct | Each mode is a different **dialing engine behaviour**, not just a label (see §3). |
| 4 | Campaign picks one active custom form | ✅ Correct | Needs a full **Custom Forms** module: forms, fields, and form *responses* (the agent's saved answers per call). |
| 5 | Teams module | ✅ Correct | Teams → members (agents) → campaigns a team may work. Add a supervisor per team. |
| 6 | Dial ratio on campaign | ⚠️ Partly | A **fixed** ratio = *progressive/power* dialing. **Real predictive** = the system *computes* the ratio every second from live stats. So campaign needs: `dial_ratio` (progressive), `max_dial_ratio` + `target_abandon_pct` (predictive limits). |
| 7 | Buffer table | ✅ Correct | Called a **hopper**: a small pre-selected queue of "next leads to dial" per campaign (see §4). |

### Things missing from the list
1. **Abandon handling** — in predictive mode customers *will* sometimes answer with no agent free. Need: wait max ~2 s for an agent, then play a short message and hang up, and log it as `abandoned`. Abandon rate is the #1 health metric of a predictive dialer.
2. **Retry / recycle rules** — No Answer → retry after X min, Busy → after Y min, max attempts per lead.
3. **Configurable dispositions per campaign** — today they're hardcoded. Each disposition needs: final or not, retry delay, marks DNC, schedules callback.
4. **Callbacks** — scheduled per agent ("my callback") or for anyone in the campaign; callbacks go into the hopper first when due.
5. **Dial attempts table** — every originate is logged with its *network result* (answered/busy/no-answer/congestion/invalid/abandoned). This also fixes the Phase 11 gap ("no Busy/Failed data").
6. **Calling-hours window** per campaign (e.g. 09:00–21:00) — dialer refuses to dial outside it.
7. **Channel capacity limits** — trunk max concurrent channels + per-campaign max channels. The trunk limit is the hard ceiling on everything.
8. **AMD (answering-machine detection)** — optional; Asterisk `AMD()` app. Adds 2–4 s delay and is inaccurate; start with it **off**.
9. **Lead locking** — two dialer ticks must never dial the same lead (`SELECT … FOR UPDATE SKIP LOCKED`, MySQL 8 supports it).
10. **Real-time dialer dashboard** — hopper count, dialing/ringing/answered, idle agents, live ratio, abandon %.
11. **Supervisor tools** — listen / whisper / barge (Asterisk `ChanSpy`), later.
12. **Compliance (India)** — DND/NCPR scrubbing, TRAI telemarketer registration / DLT, proper 140/160-series CLI for commercial calling, calling-hours rules. Confirm current rules with your trunk provider before live use.

---

## 2. Modules to build

```
Teams ──┐
        ├──> Campaign (mode, ratio, form, teams, queue, CLI, hours, retry rules, dispositions)
Forms ──┘         │
                  ├──> Lists ──> Leads (Excel upload, custom_data)
                  │
                  └──> Dialer Engine ──> Hopper ──> ARI originate ──> Queue() ──> Agent
                                                                                   │
                                     dial_attempts / calls / form_responses <──────┘
```

---

## 3. The four dial modes

| Mode | Who starts the call | Lines per free agent | Abandon possible? |
|---|---|---|---|
| **Manual** | Agent types any number (today's click-to-call) | — | No |
| **Preview** | System pushes the next lead to the agent's screen; agent reads it, clicks Dial (or auto-dial after N-second countdown) | 1, agent-triggered | No |
| **Progressive** | System dials automatically the moment an agent is free | fixed `dial_ratio` (usually 1.0) | Almost never |
| **Predictive** | System dials *ahead* of agents becoming free, using live answer-rate | computed, between 1.0 and `max_dial_ratio` | Yes — kept under `target_abandon_pct` |

Build order is **Preview → Progressive → Predictive**: each one is the previous one plus one new piece.

---

## 4. Runtime flow (how it actually works)

Two loops run inside a new **dialer-engine** service (separate Node process + systemd unit, its own ARI Stasis app `dialforge-dialer`, same MySQL):

### Loop A — Hopper filler (every ~5 s per running campaign)
```
want = max(20, idle_agents × current_ratio × 10)
if hopper_count < want:
   pick leads WHERE campaign running
                AND list is_active
                AND lead not final / not DNC
                AND attempts < max_attempts
                AND next_call_at <= NOW()
                AND now within calling window
   ORDER BY due callbacks first, list.priority, lead.priority, next_call_at
   INSERT into dial_hopper (status='ready')
```
Why a hopper: the `leads` table can be lakhs of rows; scanning it every second is slow. The hopper is tiny, pre-sorted, and is where locking happens.

### Loop B — Pacing tick (every 1 s per running campaign)
```
idle      = agents logged into campaign queue, status=available, not on call
in_flight = attempts dialing/ringing, not yet answered
if mode == progressive:  to_dial = floor(idle × dial_ratio) − in_flight
if mode == predictive:
     answer_rate = answered / attempts   (last 15 min, min 30 samples; else assume 0.3)
     ratio       = clamp(1 / answer_rate × adjust, 1.0, max_dial_ratio)
     to_dial     = floor(idle × ratio) − in_flight
     adjust:  abandon% (last 30 min) > target  → adjust −= 0.1
              abandon% < target and agents idle > 10 s avg → adjust += 0.05
to_dial = min(to_dial, free trunk channels, campaign max_channels)
repeat to_dial times:
     take 1 hopper row with FOR UPDATE SKIP LOCKED → status='dialing'
     INSERT dial_attempts; ARI originate (CLI = campaign CLI, timeout = ring_timeout)
```

### Per-call path
```
originate ──► no answer / busy / congestion  → dial_attempts.result, apply retry rule,
                                               lead.next_call_at = now + delay, remove from hopper
          └─► answered (optional AMD → machine? hang up, result='machine')
                 └─► put customer into campaign Queue() with 2 s max wait
                        ├─ agent free → agent auto-answers (WebRTC), screen pop: lead + custom form
                        │      → talk → hangup → ACW → agent saves disposition + form
                        │      → form_responses saved, retry/callback/DNC rules applied
                        └─ no agent in 2 s → play "we'll call you back" → hang up,
                                               result='abandoned', lead re-queued with priority
```
Reusing the existing `Queue()` for the answered leg means agent states (available/break/ACW via QueuePause) already work — no new agent picker needed.

---

## 5. Database changes (MySQL)

### New tables
| Table | Key columns |
|---|---|
| `teams` | id, tenant_id, name, status (supervisor later) |
| `team_members` | team_id, user_id (PK both) |
| `team_campaigns` | team_id, campaign_id (PK both) — agent sees only campaigns mapped to their team(s) |
| `forms` | id, tenant_id, name, is_active, created_at |
| `form_fields` | id, form_id, field_key, label, field_type (text/number/date/dropdown/radio/checkbox/textarea), options JSON, is_required, sort_order |
| `form_responses` | id, tenant_id, form_id, lead_id, call_id, user_id, data JSON, created_at |
| `campaign_dispositions` | id, campaign_id, code, label, is_final, retry_after_min, marks_dnc, is_callback, sort_order |
| `callbacks` | id, tenant_id, lead_id, campaign_id, user_id NULL (=anyone), callback_at, status (pending/done/missed) |
| `dnc_numbers` | id, tenant_id, phone, source (manual/ncpr/customer_request), created_at — UNIQUE(tenant_id, phone) |
| `dial_hopper` | id, campaign_id, lead_id UNIQUE, list_id, phone, priority, status (ready/dialing), locked_at, inserted_at |
| `dial_attempts` | id, tenant_id, campaign_id, lead_id, call_id NULL, phone, ari_channel_id, started_at, answered_at, ended_at, result (answered/busy/noanswer/congestion/invalid/machine/abandoned/failed), hangup_cause INT, agent_user_id NULL, ratio_at_dial |
| `dialer_stats_minute` (optional) | campaign_id, minute, attempts, answered, abandoned, idle_agent_sec — for dashboard + pacing history |

### Changes to existing tables
```sql
ALTER TABLE campaigns
  ADD dial_mode ENUM('manual','preview','progressive','predictive') NOT NULL DEFAULT 'manual',
  ADD dialer_state ENUM('stopped','running','paused') NOT NULL DEFAULT 'stopped',
  ADD form_id INT NULL,
  ADD dial_ratio DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  ADD max_dial_ratio DECIMAL(4,2) NOT NULL DEFAULT 2.50,
  ADD target_abandon_pct DECIMAL(4,2) NOT NULL DEFAULT 3.00,
  ADD ring_timeout_sec INT NOT NULL DEFAULT 30,
  ADD max_attempts INT NOT NULL DEFAULT 3,
  ADD max_channels INT NOT NULL DEFAULT 10,
  ADD amd_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD preview_autodial_sec INT NULL,
  ADD call_window_start TIME NOT NULL DEFAULT '09:00:00',
  ADD call_window_end   TIME NOT NULL DEFAULT '21:00:00',
  ADD wrapup_sec INT NOT NULL DEFAULT 10;

ALTER TABLE lists ADD is_active TINYINT(1) NOT NULL DEFAULT 1, ADD priority INT NOT NULL DEFAULT 0;

ALTER TABLE leads
  ADD alt_phone VARCHAR(20) NULL,
  ADD custom_data JSON NULL,
  ADD priority INT NOT NULL DEFAULT 0,
  ADD attempts INT NOT NULL DEFAULT 0,
  ADD last_attempt_at DATETIME NULL,
  ADD next_call_at DATETIME NULL,
  ADD last_result VARCHAR(20) NULL,
  ADD is_final TINYINT(1) NOT NULL DEFAULT 0,
  ADD INDEX idx_dialable (campaign_id, is_final, next_call_at);

ALTER TABLE calls ADD dial_attempt_id INT NULL;
```
Every new table keeps `tenant_id` (directly or through its parent) — same rule as the rest of the schema.

### Excel lead template
`phone*`, `alt_phone`, `name`, `email`, `city`, `priority`, then **one column per field_key of the campaign's form** (e.g. `loan_amount`, `policy_no`). Unknown columns → reject with a clear error. Download button generates the template from the chosen campaign's form.

---

## 6. Implementation phases (each = one vertical slice, tested on DialForge_Testing first)

| Step | What | Done when |
|---|---|---|
| **D1** | Teams module (CRUD + members) + campaign↔teams | Agent only sees campaigns of their team(s) |
| **D2** | Custom Forms builder (CRUD forms/fields, active flag) + campaign form dropdown + agent screen renders form + saves `form_responses` | Agent fills form on a manual call, row saved |
| **D3** | Campaign settings UI (mode, ratios, hours, retries, channels) + per-campaign dispositions + callbacks + `dnc_numbers` | Rules editable and enforced on manual calls |
| **D4** | `.xlsx` import with form-driven template, DNC scrub, custom_data | Upload 1 000-row Excel cleanly, dupes/invalid reported |
| **D5** | dialer-engine service skeleton + hopper filler + Start/Pause/Stop campaign | Hopper fills/drains correctly, no duplicates |
| **D6** | **Preview** mode | Lead pops to agent, Dial works, retry rules applied |
| **D7** | **Progressive** mode (ARI originate → Queue → agent auto-answer) + `dial_attempts` results | 1:1 auto-dial loop with 2 agents, results logged |
| **D8** | **Predictive** mode: ratio > 1, abandon path + message, adaptive pacing | Abandon % stays under target in a load test |
| **D9** | Real-time dialer dashboard + reports (attempts, answer rate, abandon %, results) | Supervisor sees live numbers |
| **D10** | Load test with SIPp acting as a fake trunk (answers X %, busy Y %) on DialForge_Testing | 2 vCPU box handles target channels, no leaks |
| **D11** | Go-live pilot | see §7 |

---

## 7. Going live — yes, but with gates
1. Everything above built and tested on **DialForge_Testing** first, not on the main server.
2. **Trunk**: know the concurrent-channel limit and that it allows automated/predictive outbound. Confirm the trunk is *yours* to use for this product.
3. **Compliance**: DND scrubbing, telemarketer registration/DLT, correct CLI series, calling hours.
4. **Backup** DB + `/etc/asterisk` before deploying; migration scripts are additive only.
5. Pilot: one campaign, 2–3 agents, start **progressive 1:1**, then predictive with `max_dial_ratio` 1.5 and watch abandon %.
6. Server size: c7i-flex.large (2 vCPU) is fine for a pilot (~20–30 channels, no transcoding). Recording + more agents → plan an upgrade (cost flagged before doing it).
