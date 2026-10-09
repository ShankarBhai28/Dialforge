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
- [ ] Edit **Test Team** → Extensions: tick one extension other than agent1003's own (e.g. 1005) → Save. The table shows it.
- [ ] Agent1003 logs out of the line and back in → the Extension box is now a list: their own extension + 1005 only.
- [ ] Untick all extensions on Test Team → agent1003 can type any free extension again.
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

## D8 — Predictive
Needs volume to learn (≥ 20 finished calls in 15 min) — with 1-2 test lines you'll mostly see the "learning" state. That's expected.
- [ ] Campaign mode **Predictive**: Starting ratio 1.0, Max dial ratio 1.5, Target abandon 3, Max channels **2** → Save. Dialer → Start.
- [ ] Dialer page shows "now 1:1 · learning (n/20 calls) - using starting ratio".
- [ ] Several test leads (own extensions; some answered, some left ringing) → as attempts finish, the note counts up; once ≥ 20 it shows an answer % and a ratio between 1.0 and 1.5.
- [ ] Force abandons (agent to Break while lines ring, answer them) → abandon % rises → within ~30 s **adjust** drops; above 6% (2× target) the note says "holding at 1.0".
- [ ] Dialer → **Stop**. Campaigns back to the mode you want.

## D9 — Recycling / redial
- [ ] Campaigns → **Recycle rules**: see 5 rows (No answer 60/3, Busy 15/3, Answering machine 120/2, Network error 10/3, Abandoned 2/3). Set **No answer → redial after 2 min, max 2** → Save. Try max 0 → clear error.
- [ ] Dialer running, agent Available, a lead with your number → **don't answer** → after ~2 min it's dialed again (not immediately) → don't answer again → it's **not** dialed a 3rd time (tries used up).
- [ ] Leads → Lists: **Dialable now** column. Click **Recycle** on the list → table by status; No Answer ticked, Interested unticked, Do Not Call can't be ticked.
- [ ] Keep "Reset attempt count" ticked → **Recycle** → "N lead(s) recycled" → Dialable now goes up → a running campaign dials them within seconds. "Recent:" shows who recycled what.
- [ ] Put one of those numbers on the DNC list → Recycle again → "skipped: 1 on DNC".
- [ ] Set the No answer rule back to what you want.

## In-call panel, transfer, conference
Set up: two agents logged in and **Available** (e.g. agent04 on 1003 + agent1001 on 1001, two browsers), plus your mobile as the "customer". Refresh agent pages with **Ctrl+F5**.
- [ ] Any call answered -> panel bottom-right: name/number, **LIVE** + timer; tab title shows `● LIVE`. Click-to-call shows "Ringing customer…" until you answer the mobile.
- [ ] **Mute** -> red warning, customer can't hear you -> Unmute. **Hold** -> customer hears music, header amber -> Resume. **Keypad** -> tones heard on the phone.
- [ ] **Warm transfer to agent**: Transfer -> Warm -> Agent -> agent1001 -> Call first -> customer hears music; agent1001 rings, sees "Transfer offered" + lead -> answer -> you two talk -> **Complete transfer** -> you're dropped (outcome popup, ACW); customer + agent1001 talk; agent1001 gets the outcome popup when it ends.
- [ ] Warm again -> **Cancel** -> back to the customer. Warm -> **Merge (3-way)** -> all three hear each other -> **Leave conference** -> the other two continue.
- [ ] **Blind transfer to agent** -> you're dropped at once; customer hears music until agent1001 answers.
- [ ] **Blind transfer to queue** -> customer waits in that queue; an Available agent in it gets the call with screen pop.
- [ ] **Conference / transfer to number** (a second phone you own) -> it rings with the campaign caller ID; **Drop** it from the conference.
- [ ] Blind to a number and don't answer -> after ~30 s the customer goes back to the campaign's queue.
- [ ] Customer hangs up during a conference -> everyone dropped, agents to ACW.

## New agent screen (`/app/agent`) — before agents switch to it
Same setup as above: two agents in **two different browsers** (or one normal + one incognito), your mobile as the customer. Each agent logs in at `https://dialforge.ddnsfree.com:3000/app`.
- [ ] Login as an agent → **Connect your line** → enter the extension → Connect → the workbench opens (tiles, leads, dialpad). Refresh the page (F5) → it reconnects by itself.
- [ ] Second agent tries the **same** extension while the first is connected → refused with "in use by …". (Use a different extension each.)
- [ ] Status pill → **Available** → queue picker → pick the queue → pill turns green "Available - <queue>". Break → Lunch → amber "Lunch".
- [ ] Click a lead → details + form open in the middle → **Call** → your mobile rings (the browser line is answered by itself) → panel says "Ringing customer…" → answer the mobile → **Live call** + timer.
- [ ] In the call: **Mute** (red warning; mobile can't hear you) → Unmute. **Hold** → mobile hears music → Resume. **Keypad** → tones heard.
- [ ] Fill the form → **Save Form** → "Form saved." Hang up → **Call outcome** dialog → pick one → it closes. Try **Callback** once → pick a time → it appears under Callbacks.
- [ ] Dialer campaign (progressive), Auto Answer **off**: a dialer call rings → **Incoming call** popup with ringtone + the customer's number → Accept → the lead pops up with the form pre-filled → hang up → outcome → back to **Available** by itself after the wrap-up time.
- [ ] Auto Answer **on**: no popup, the call connects straight away.
- [ ] Transfer: **Warm → Agent → the other agent → Call first** → customer hears music → the other agent sees "Transfer offered by a colleague" → **Complete transfer** → you're dropped; the other agent gets the outcome dialog when it ends. Repeat once with **Blind → Queue** and once with **Conference → Number**.
- [ ] Audio check from a **different network** (e.g. a mobile hotspot): the new screen uses the TURN server; the classic screen never did.
- [ ] Anything that behaves differently from the classic agent screen → note it.

## After testing
- [ ] Tell Claude what failed (step + what you saw) — fixes go in before the live trunk.
