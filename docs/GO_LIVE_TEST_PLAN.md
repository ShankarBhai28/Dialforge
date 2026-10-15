# VIZTEX go-live test plan

Run these sessions with real people, a real trunk and real calls before giving VIZTEX to a client (10 agents: manual, inbound, predictive).
Results are kept on the shared checklist page: https://claude.ai/artifact/5wPysiYLWdGtda4H7ezhMT (mark Pass / Fail / Blocked + a note).
Feature-by-feature screen checks stay in PREDICTIVE_DIALER_TEST_CHECKLIST.md; this plan tests VIZTEX as a whole.

## Before testing
_You + Claude · 1 day_ - Everything here must be ready before the first test session. Claude can do the server parts with you.

- [ ] **P1** A production-like server built with install.sh, not the dev server - _pass when:_ installer shows all 12 checks OK; real domain and certificate
- [ ] **P2** Real SIP trunk added with add-trunk.sh: at least 10 channels for the pilot (about 30 for 10 agents on predictive) and 1–2 DIDs - _pass when:_ one outbound and one inbound call connect with audio both ways
- [ ] **P3** Licence set with set-licence.sh for the pilot (seats, lines, end date) - _pass when:_ Dashboard Licence card shows the right numbers
- [ ] **P4** Alerts on: ALERT_WEBHOOK_URL set and an external uptime monitor on /health - _pass when:_ stop the dialer service once and the alert arrives within 5 minutes
- [ ] **P5** Off-server backup on: BACKUP_S3_BUCKET set - _pass when:_ System health says "copied off-server" and the files are in S3 the next morning
- [ ] **P6** Set up in the app: one user and extension per agent, a team, a Team Leader role, queues, three campaigns (manual, inbound, predictive), DIDs mapped, outcomes, a form, recording on - _pass when:_ an agent can log in, start a shift and see the right queue
- [ ] **P7** People: 1 supervisor, 3–4 agents (own laptop, Chrome, wired headset, own login, separate browsers) and 2–3 "customers" with mobiles - _pass when:_ everyone has their login and knows their role
- [ ] **P8** Test leads: only numbers of people who agreed to be called (the team's mobiles), 15–20 for the predictive list; recycle rules short (2 minutes) for testing - _pass when:_ list uploaded, no stranger's number in it

## Session 1 · Manual calling
_3 agents · about 1.5 hours_ - Agents call the "customers" one by one from leads and the dialpad.

- [ ] **M1** Each agent makes 10 calls to the customers' mobiles - _pass when:_ every call connects; clear audio both ways; no one-way or silent calls
- [ ] **M2** The customer's phone shows the campaign's caller ID - _pass when:_ the number shown is the one set on the campaign
- [ ] **M3** Outcome after every answered call; one call set as a Callback for 10 minutes later - _pass when:_ outcome saved on the lead; the callback appears in My Callbacks and comes due on time
- [ ] **M4** Refusals: a DNC number, a call outside calling hours, one agent more than the seats, more calls than licensed lines - _pass when:_ each is refused with a clear message; nothing hangs
- [ ] **M5** Recordings of answered calls - _pass when:_ each plays in the Call log with both sides and the right length
- [ ] **M6** Transfers: warm to another agent, blind to a queue, conference with a mobile - _pass when:_ each works as expected and the call keeps one recording
- [ ] **M7** Supervisor on Live Agents: status, current call, Listen, Whisper, Barge - _pass when:_ what the screen shows matches reality; each monitor mode does what it says
- [ ] **M8** One agent works from a mobile hotspot instead of the office network - _pass when:_ audio both ways (goes through the TURN relay)

## Session 2 · Inbound
_3 agents · about 1 hour_ - The customers call the client's number while agents are Available.

- [ ] **I1** A customer calls the DID - _pass when:_ a free agent rings within 5 seconds; a known caller's history shows
- [ ] **I2** One agent is on a call when the next customer calls - _pass when:_ the busy agent is skipped; another free agent gets it
- [ ] **I3** 4 customers call at once with 3 agents - _pass when:_ the 4th hears hold music and reaches the first agent who frees up
- [ ] **I4** A customer hangs up while waiting - _pass when:_ counted as abandoned in Reports
- [ ] **I5** All agents on Break, a customer calls - _pass when:_ the caller is not left in silence; what they hear is acceptable to the client
- [ ] **I6** Each DID reaches its own campaign; after the call the agent goes through wrap-up back to Available - _pass when:_ right campaign on the screen; status flow correct
- [ ] **I7** Auto answer on, then off - _pass when:_ on: connects straight away; off: ringing popup, agent accepts

## Session 3 · Progressive and predictive
_3–4 agents · about 2 hours_ - Start in progressive at ratio 1, then switch the same list to predictive. The customers answer some calls, reject some and ignore some.

- [ ] **D1** Progressive, ratio 1, 3 agents Available - _pass when:_ each free agent gets a call; no two agents ever get the same customer
- [ ] **D2** A customer the agent talked to - _pass when:_ is not dialled again while the agent is in wrap-up, only after the outcome rules say so
- [ ] **D3** Answered, rejected (busy) and unanswered calls - _pass when:_ each result recorded correctly; redials follow the recycle rules
- [ ] **D4** Predictive, starting ratio 1.0, max 1.5 - _pass when:_ Dialer page shows the ratio learning; drop rate stays at or below 3%
- [ ] **D5** A customer answers when no agent is free - _pass when:_ hears a message, is counted as abandoned and is redialled by the rule
- [ ] **D6** Pause, then Stop - _pass when:_ no new calls within 2 seconds; calls in progress finish normally
- [ ] **D7** Dialer → Live calls during dialling; supervisor hangs one up - _pass when:_ list matches reality; Hang up ends that call
- [ ] **D8** An inbound call arrives while the dialer runs - _pass when:_ reaches an agent in that queue correctly
- [ ] **D9** An agent goes on Break while calls are ringing - _pass when:_ no dialer call is sent to them

## Session 4 · Failure drills
_Supervisor + Claude · about 45 minutes_ - Break things on purpose to see that VIZTEX recovers and that you are told.

- [ ] **F1** Restart the backend during a live call - _pass when:_ the call continues; nobody is logged out; screens recover within 30 seconds
- [ ] **F2** Restart the dialer while it is dialling - _pass when:_ it carries on; no customer is dialled twice
- [ ] **F3** An agent's internet drops for 30 seconds during a call - _pass when:_ the agent can reconnect and continue; what happened to the call is clear
- [ ] **F4** An agent closes the browser without logging out - _pass when:_ their seat frees up; they show offline within 10 minutes
- [ ] **F5** The trunk goes down (block the provider for 2 minutes) - _pass when:_ an alert arrives; calls are refused with a clear message; it recovers by itself
- [ ] **F6** Licence end date set to yesterday, then back - _pass when:_ agents are blocked with the message and admins see the banner; setting it back restores work at once
- [ ] **F7** Rebuild a server from the S3 backup - _pass when:_ done in the 15 Oct 2026 rehearsal: same data, logins, licence and recordings

## Session 5 · Load (optional)
_Claude runs it · about 1 hour · AWS cost about $1–2_ - A second test server plays 30 simulated customers so the real server is measured at full load.

- [ ] **L1** 30 calls at once with recording for 20 minutes - _pass when:_ CPU below 70%, no failed calls, no audio errors
- [ ] **L2** Recording storage per hour measured - _pass when:_ disk and S3 plan fit at least 90 days of the client's volume

## Session 6 · Dress rehearsal
_3–4 agents · 2–3 hours · a real shift_ - Work like a real client day: manual, inbound and predictive mixed. The supervisor uses only the screens, no server access.

- [ ] **R1** A full shift with all three call types - _pass when:_ nobody gets stuck; supervisor can run the floor from the screens
- [ ] **R2** End of day: Reports against the Call log - _pass when:_ calls, connected, talk time and per-agent totals match
- [ ] **R3** All bugs from every session reviewed - _pass when:_ no Blocker or Major open

## Go / no-go
_Decide together · all must pass_ - VIZTEX goes to a client only when every line here passes.

- [ ] **G1** No Blocker open; every Major fixed or has an agreed workaround
- [ ] **G2** No one-way or silent audio in the last 50 calls
- [ ] **G3** Predictive drop rate at or below 3% over the dress rehearsal
- [ ] **G4** Reports match the Call log
- [ ] **G5** Alerts arrived within 5 minutes in the drills; uptime monitor on
- [ ] **G6** Last night's backup is in S3
- [ ] **G7** Server peak CPU and disk below 70%
- [ ] **G8** Client confirmed: DND/NCPR scrubbing, registered caller numbers, recording announcement
- [ ] **G9** Support agreed: who answers during the client's hours and how they reach you

## Recording problems
- **Blocker** (stops go-live): a call lost or connected to the wrong person, no audio, data lost, a call not recorded when it should be, an agent unable to work for more than 2 minutes.
- **Major**: a feature broken with a workaround - fix or agree the workaround.
- **Minor**: wording, layout, slow but working - fix later.
- Every Fail note: time, agent login + extension, customer number, what you did and saw, screenshot if the screen looked wrong.
