# Predictive Dialer — End-to-End Test Checklist

Run this once all steps are deployed, in order — later steps reuse what earlier ones set up.
Server: **dialforge-dev** (`https://dialforge.ddnsfree.com:3000`). Tick each box; if one fails, note what you saw and stop there.

## Before you start — safety
- [ ] Use **only your own numbers or internal extensions (1001 / 1002 / 1003)** as leads. From D7 on, the system dials by itself.
- [ ] Two browsers (or one normal + one incognito window): one logged in as **admin**, one as an **agent** with a connected WebRTC extension.
- [ ] Test inside the campaign's calling hours (default 09:00–21:00 IST), or widen them in the campaign first.
- [ ] Optional reset point: `~/backups/` on the server has a DB dump before each step.

## D1 — Teams
- [ ] Admin → Teams shows **Default Team** with all agents and campaigns.
- [ ] Create team **Test Team**: one agent (e.g. agent1003) + one campaign (e.g. Real Test Campaign). Untick that agent in Default Team.
- [ ] Agent1003 → Available → queue list shows **only** Real Test Campaign's queue.
- [ ] Put agent1003 back how you want it afterwards.

## D2 — Custom Forms
- [ ] Admin → Forms → create **Test Form**: Amount (Number, required), Plan (Dropdown: Gold, Silver), Notes (Long text).
- [ ] Campaigns → Edit the test campaign → Form = Test Form → Save. Column shows it.
- [ ] Agent (Available in that campaign's queue) sees the **Test Form** card.
- [ ] Save with Amount empty → error "Amount is required". Fill it → "Form saved".
- [ ] Admin → Forms → Responses shows the row.
- [ ] Try deleting Test Form → blocked (used by a campaign / has responses).

## D3 — Settings, dispositions, callbacks, DNC
- [ ] Campaigns → Edit → Dialer settings: switch mode and watch fields change; save a bad value (e.g. ratio 9) → clear error.
- [ ] Campaign → **Dispositions** → add "Wrong Number" (Final) → Save.
- [ ] Agent calls a lead (your number/extension) → hang up → outcome popup lists the campaign's dispositions incl. Wrong Number.
- [ ] Choose **Callback** → pick a time ~5 min ahead, "only me" ticked → appears in agent **My Callbacks** and Admin → **Callbacks**.
- [ ] Mark a different lead **Do Not Call** → its number appears in Admin → **DNC List** → calling it again → "on the Do Not Call list".
- [ ] DNC List: add `+91 98400 00000` → shows as `9840000000`; remove it.
- [ ] (Optional) set calling hours to exclude now → outside call refused with the hours in the message → set back.

## D4 — Excel upload
- [ ] Leads → create list **Test List** in the test campaign.
- [ ] Select it → **Download Template (.xlsx)** → columns include `amount`/`plan`/`notes` (your form keys) and an Instructions sheet.
- [ ] Fill ~6 rows: 3 good (real mobile numbers **you own** — upload needs 7+ digits, so extensions like 1001 can't be imported), 1 duplicate, 1 DNC number, 1 with `plan = Diamond`.
- [ ] Import → counts match (3 imported, 1 duplicate, 1 DNC, 1 invalid with "Row N: plan must be one of…").
- [ ] Agent → Call an imported lead → form opens **pre-filled** with amount/plan.

## D5 — Dialer engine + hopper
- [ ] Admin → **Dialer**: engine badge **running**.
- [ ] Campaigns → Edit test campaign → mode **Progressive** → Save.
- [ ] Dialer → **Start** → note empty, Hopper shows the imported leads in order (callbacks first, then priority).
- [ ] Agent goes Available in that queue → **Idle agents 1**, **Would dial 1** (dry-run, nothing is dialed in D5).
- [ ] Leads → set Test List **inactive** → within ~5 s its leads leave the hopper → set active again.
- [ ] **Pause** → note "paused by admin", hopper kept. **Stop** → hopper empties.

## D6 — Preview
- [ ] Campaign mode **Preview**, Preview auto-dial blank → Save → Dialer → **Start**.
- [ ] Agent Available → **Preview – Next Lead** card shows a lead with its data.
- [ ] Refresh the agent page → the **same** lead is shown again.
- [ ] **Skip** → next lead appears; the skipped one is not offered again for 15 min.
- [ ] **Dial** → your phone rings via the normal click-to-call flow → hang up → outcome popup → choose → go Available → next lead appears.
- [ ] Set Preview auto-dial = 10 → next lead shows "Auto-dial in 10s" → click **stop** → it stops.
- [ ] Agent goes on **Break** → Admin Hopper shows the lead back to **ready** (not locked).
- [ ] Dialer → **Stop** when done.

## D7 — Progressive
Start small: **test leads = your own extensions**, max channels **1**.
- [ ] As the agent (on extension 1001), Add Lead **1002** while Available in the test campaign's queue (it gets the campaign; leads with no list are dialable too). Register **1002** in a second browser tab (the "customer").
- [ ] Campaign: mode **Progressive**, ratio 1, **Auto Answer on**, Max channels 1, Max wait for agent 5 → Save. Dialer → **Start**.
- [ ] Agent 1001 Available → within ~1-5 s extension **1002 rings** (the dialer called the "customer").
- [ ] Answer on 1002 → agent 1001 auto-answers → status line shows **"Dialer call: … 1002"**, form linked → talk → hang up → outcome popup → save → after wrap-up seconds the agent is **Available again by itself**.
- [ ] Dialer page "Today": 1 dialed · 1 answered · 1 to agent.
- [ ] **No answer**: add another test lead (an extension nobody answers) → let it ring out → Today shows "not reached"; lead's next call moved by the No Answer retry time.
- [ ] **Abandon**: agent Available → while 1002 is still *ringing*, put agent 1001 on **Break** → now answer on 1002 → no agent in the queue → after ~5 s 1002 hears the "busy" prompt and is hung up → Today shows **1 abandoned** (% in red).
- [ ] Only then, one real trunk test: a lead with **your own mobile**, max channels 1 → phone rings → answer → reaches the agent.
- [ ] Dialer → **Stop**.

<!-- D8 section is added when deployed. -->
