# Handoff - where VIZTEX stands (30 Oct 2026)

For a new Claude session or account picking this work up. Read this first, then the
files it points to. No passwords or keys are in this file - they never go into chat or git.

## 1. What this is

- **VIZTEX**: the owner's own dialer CRM (predictive / progressive / preview dialing, inbound
  queues, WebRTC agents, reports). Written in upper case in the UI; code names say `dialforge`.
- Stack: Node.js backend (`backend/`, Express + MySQL + Asterisk ARI/AMI), React + TypeScript
  + Vite screen (`web/`), Asterisk 22 with PJSIP realtime, installer `install/install.sh`
  (one server, or three: db / telephony / app).
- Repo: `C:\Users\User01\DialForge`, GitHub `ShankarBhai28/Dialforge` (private). `gh` is not
  installed; GitHub is reached with plain `git` (and `curl` to the API for CI status).
- Owner background: Asterisk / dialer support engineer; prefers plain step-by-step
  explanations, wants to be able to do things himself (guides in `docs/`).

## 2. Code state

| Branch | State |
|---|---|
| `main` | GitHub at a15ffa0; the local `main` has 3 more commits (load-test guide/kit) - also contained in `loadtest-fixes` |
| `loadtest-fixes` | **current work**, on GitHub up to 185592b; one local commit more (08f644c, local PC script). Not merged into main yet - merge after the fixes are measured on the test servers |
| `tenant-part1` | Cloud (multi-company) edition parts 1-3, on GitHub, not merged |

`loadtest-fixes` has: indexes (migration 0021), MySQL cache size in the installer, faster Live
Agents / Agent Performance / List Penetration / Time Sheet, Call Log capped count ("of 10,000+"),
stale-call cleanup (`backend/src/services/staleCalls.js`), `install/backup-to-pc.sh`,
`scripts/local.sh`, and the load-test results in `docs/LOADTEST_STEP_BY_STEP.md`.

Checks: `npm run check` from the repo root (lint, format, typecheck, all tests) must pass
before a commit. Last: 262 backend + 231 web tests.

## 3. Where things run

| Name | What | Notes |
|---|---|---|
| **Local PC** | VIZTEX without Asterisk (every screen, no calls) | `bash scripts/local.sh start` → http://localhost:5173/app/ (login `boss`); `docs/LOCAL_PC.md` |
| **dialforge-dev** | the dev server, 3.7.241.104 / dialforge.ddnsfree.com | key `Documents\dialforge-key.pem`; deploy `bash scripts/deploy-dev.sh`; stopped |
| **Load-test servers** | lt-db, lt-tel (13.232.143.228), lt-app (43.205.200.115), lt-gen | keys `Documents\Load_test.pem`, `lt-gen.pem`; stopped; lt-db / lt-gen get new IPs on each start; details in `docs/LOADTEST_STEP_BY_STEP.md` |

**AWS account 168287841604** (AWS India, Mumbai) was put **on hold for verification on
30 Oct**: documents uploaded (bank statement + Aadhaar), address case 179334157200295 open.
Until AWS confirms, the servers can't be started. Credits: ~$84 left, valid to 24 Sep 2027.

## 4. Next steps, in order

1. When AWS restores the account: start dialforge-dev → `install/backup-to-pc.sh` (backup to the
   PC first) → stop it again if not needed.
2. Load-test servers: deploy `loadtest-fixes`, rerun `loadtest/report-times.js` (alone,
   `--parallel 3`, during 100 agents), check the stale-call cleanup closes ghost calls; fill the
   empty columns of the report table in `docs/LOADTEST_STEP_BY_STEP.md`.
3. If 90-day reports are still slow: daily summary tables.
4. Merge `loadtest-fixes` into main (owner says "push it"), then **terminate the 4 load-test
   servers and release their Elastic IPs** (saves the credit).
5. UI work the owner asked for (start with a clickable mockup for approval):
   - Dialer → Live calls: "Just finished" list clutters - tabs In progress / Finished + result filter.
   - **Bug**: with Live calls and Hopper both open, Live calls' Close doesn't close it (its onClose
     runs, the card stays); Live calls alone closes fine. Reproducible in `dialer.test.tsx`.
   - Live Agents: one line per agent; default columns agent, status + time in status (idle),
     extension, campaign, queue, current call, talk time; the rest in a Columns chooser; the agent
     panel to show the same timers. Overall goal: attractive, professional, uncluttered.
6. Cloud edition part 4 (inbound DID → company, AMI/ARI events by company), then 5-6.

## 5. How the owner wants the work done

- **Security first.** Never print or paste passwords, `.env` contents, tokens, one-time
  passwords or the `Credentials-Dialforge` file. Secrets go straight into files, never chat.
- **Servers**: back up → tell the owner → wait for his go-ahead before changing a live server.
  Never start campaigns or change real dialing settings - he does that in the UI.
- **Push / merge only when he says "push it"**: secret scan first (see `docs/RUNBOOK.md`),
  push the branch, fast-forward main, check CI.
- **Costs**: say before anything costs money on AWS.
- Kill only processes you started (by PID), never by name or pattern.
- Each milestone goes into `docs/RUNBOOK.md`; guides are written so he can follow them alone.
- Commits end with a `Co-Authored-By:` line for the Claude model.

## 6. The PC

- Avast HTTPS scanning (and a "Tecdata Shield" root CA) re-sign web traffic. Claude Code and Node
  trust them through the user variable `NODE_EXTRA_CA_CERTS=C:\Users\User01\certs\corp-roots.pem`.
  SSL errors in Claude Code (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) → that file needs the current
  Avast root again.
- 16 GB RAM; it ran out once (too many browsers / tabs): restart every few days.
- Claude Code's notes for this project: `C:\Users\User01\.claude\projects\C--Users-User01\memory\`
  (`MEMORY.md` is the index; `project-dialforge.md` is the full history). They are files on this
  PC, read by any Claude Code session started in `C:\Users\User01`.
