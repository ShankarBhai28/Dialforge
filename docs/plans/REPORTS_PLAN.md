# Reports plan (2026-10-13)

What a contact-center manager needs to run outbound, predictive and inbound
work, and what DialForge builds for it. Every report: date range (in the
center's time zone), filters, totals row, CSV export (right Reports -> Export
CSV), team scope (a team-scoped role sees only its campaigns / agents).

## The reports

| # | Report | Answers | One row per |
|---|---|---|---|
| 1 | **Call Detail (CDR)** | What happened on every call? | call |
| 2 | **Agent Performance** | How productive was each agent? | agent |
| 3 | **Agent Time Sheet** | When did agents log in / out, how long on break? | agent per day |
| 4 | **Campaign Performance** | How is each campaign doing? | campaign |
| 5 | **Outcomes (Dispositions)** | What did customers say? | outcome x campaign / agent |
| 6 | **Predictive Dialer** | Is the dialer pacing well and legally (drop rate)? | campaign (or hour) |
| 7 | **Inbound / Queue** | Are callers answered fast enough? | campaign / DID |
| 8 | **Hourly (Interval)** | When in the day do calls / answers happen? | hour |
| 9 | **List Penetration** | How much of each list is worked through? | list |
| 10 | **Callbacks** | Are promised callbacks made on time? | agent |

### Columns (main ones)
1. **CDR**: call id, start, direction, campaign, agent, extension, number, lead, DID, wait (queue), ring, talk, result (technical: answered / no answer / busy / machine / abandoned ...), outcome (agent's disposition), transferred to, recording.
2. **Agent Performance**: login time, ready (idle), talk, wrap-up (ACW), break, calls (out / in), connected, avg talk, avg handle time (talk + wrap per call), occupancy % ((talk + wrap) / (login - break)), outcomes given, callbacks set.
3. **Time Sheet**: date, first login, last logout, logged-in time, breaks (count, time, by reason), wrap-up time.
4. **Campaign**: leads, leads dialed (penetration %), calls, answered (contact rate %), connected to an agent, abandoned (abandon %), avg talk, avg handle, outcome counts, success count / % (outcomes marked "success").
5. **Outcomes**: count and % of each outcome, by campaign or by agent.
6. **Predictive**: dial attempts, human answered, machine (AMD), no answer, busy / congestion / failed, connected to agent, dropped (abandoned), **drop rate %** (dropped / human answered; red above 3 %), avg dial ratio, avg ring time, avg wait for an agent, attempts per agent hour.
7. **Inbound**: offered, answered, abandoned (abandon %), avg / max wait, **service level %** (answered within N seconds, default 20), avg talk.
8. **Hourly**: per hour: calls (out / in), answered, abandoned, talk time, agents logged in.
9. **List Penetration**: leads, never called, called, contacted, final, waiting retry / callback, DNC, avg attempts, penetration %.
10. **Callbacks**: scheduled, done, overdue (past due, still pending), cancelled; per agent.

## Data the reports need (migration 0006)
Today the call row doesn't say which agent handled it (reports guess from the
extension + time) and the agent's outcome lives only on the lead (latest one)
and the audit log. Added to `calls`:
- `agent_user_id` - the agent who took the call (click-to-call: the caller; queue / dialer: AgentConnect).
- `agent_connect_time` - when the agent was connected (queue wait = this - entered queue).
- `outcome`, `outcome_at` - the disposition the agent gave this call (wrap-up = outcome_at - end_time).
- `did` - the number the customer dialed (inbound).
- Indexes on `start_time`, `(agent_user_id, start_time)`.
- `campaign_dispositions.is_success` - which outcomes count as a success (sale / interested) for conversion %.
Old calls are filled in from the status log, call events and audit log.

## Time zone
Times are stored in UTC. Reports use `REPORT_TIMEZONE` (default
`Asia/Kolkata`): "today" = local midnight to midnight, hours are local hours.

## Build
- Backend: `src/services/reports/` - one module per report returning
  `{ columns, rows, totals }`; one route `GET /admin/reports/:key`
  (`?format=csv`); `GET /admin/reports` = the list + each report's filters.
- Frontend: one Reports screen - report picker, shared filter bar (date
  presets Today / Yesterday / Last 7 days / This month / custom, campaign,
  agent, ...), generic table that formats by column type (seconds, %,
  date-time), totals row, CSV.
- Later: scheduled e-mail of daily reports, charts, saved filters.
