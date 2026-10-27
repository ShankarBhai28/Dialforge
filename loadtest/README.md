# Load test: how many predictive agents a server carries

No people and no real phone calls: **SIPp** plays the agents' phones and the customers (a fake
carrier), and a small script plays the agents' screens. VIZTEX runs a real predictive campaign
with recording on; we step the number of agents up and measure CPU, memory and audio quality.

```
 [load generator]                         [VIZTEX telephony]                 [load generator]
 SIPp :5071 registers 5001-5200 ───────►  Asterisk  ◄──── dialer (app) ───► SIPp :5060 "carrier"
 SIPp :5070 answers agent calls ◄──────── Queue → PJSIP/5001...              answers 70%, busy 15%,
 agents.js: login, Available, ──HTTPS──►  app server                         no answer 15%; talks 30/60/120 s
            disposition
```

The whole sequence on four fresh servers (AWS account, servers, installs, run, cleanup) is in
[../docs/LOADTEST_STEP_BY_STEP.md](../docs/LOADTEST_STEP_BY_STEP.md).

**Test servers only** - the load-test endpoints and the fake trunk must never be on a customer's server.

## Servers (one afternoon, then delete)

| Server | How | Size |
|---|---|---|
| DB, telephony, app | `docs/INSTALL_THREE_SERVERS.md` steps 1-12 (no test call needed) | db 2 vCPU, **telephony 4 vCPU** (resized to 8 later), app 2 vCPU |
| **load generator** | below | 4 vCPU (c7i.xlarge), Ubuntu 24.04, same VPC / subnet |

All test traffic uses **private IPs** (no internet traffic, no cost per GB).

### Load generator
1. EC2 → Launch: Ubuntu 24.04, c7i.xlarge, the same subnet as the others, 16 GB disk, a key.
   Security group **loadgen-sg**: SSH 22 from My IP; **all UDP from tel-sg** (SIP + audio).
2. **tel-sg** gets two more rules: **UDP 5060 and UDP 10000-20000 from loadgen-sg**.
   **app-sg** gets: **TCP 443 from loadgen-sg** (the agent bots).
3. Copy the kit and set it up (your PC, Git Bash):
   ```
   scp -i ~/Documents/<loadgen-key>.pem -r loadtest ubuntu@<loadgen-public-ip>:~
   ssh -i ~/Documents/<loadgen-key>.pem ubuntu@<loadgen-public-ip>
   sudo bash loadtest/loadgen-setup.sh      # then exit and ssh in again
   ```

## Prepare VIZTEX (about 20 minutes)

1. **Files** (your PC, in the repo): two throwaway passwords, letters/digits only:
   ```
   node loadtest/make-files.js --count 200 --team "Load test" --agent-password <pw1> --sip-password <pw2>
   ```
   → `loadtest/out/agents-import.csv`, `leads.csv`, `sipp-agents.csv`. Copy `sipp-agents.csv` to the
   load generator: `scp -i ... loadtest/out/sipp-agents.csv ubuntu@<loadgen-ip>:~/loadtest/`
2. **App server**: licence and 200 extensions:
   ```
   sudo bash viztex/install/set-licence.sh --customer "Load test" --seats 250 --channels 600 --expires <date>
   cd ~/dialforge-backend && npm run ext:add -- --from 5001 --count 200
   ```
3. **Telephony server** (copy the kit there first: `scp -r loadtest ubuntu@<tel-ip>:~`): the plain-SIP
   twins of 5001-5200, and the fake carrier as a separate trunk endpoint `loadtrunk` (a real trunk,
   if any, stays as it is):
   ```
   sudo bash ~/loadtest/telephony-setup.sh --loadgen-ip <loadgen-private-ip> --from 5001 --count 200 --password <pw2>
   ```
   **App server**: in `~/dialforge-backend/.env` set these three, then
   `sudo systemctl restart dialforge-backend dialforge-dialer`:
   ```
   TRUNK_ENDPOINT=loadtrunk
   TRUNK_CALLER_ID=8000000000
   DIALER_MAX_TRUNK_CHANNELS=600
   ```
4. **Browser, as Super Admin**:
   - Teams → create **Load test**.
   - Users → **Import agents** → `agents-import.csv` → Create 200 agents.
   - Queues → **loadtest_q**, ring strategy **Least recent** - check it after saving. **Not Ring all** (the default): with 200 agents every call would ring all of them.
   - Campaigns → **Load test**: mode **Predictive**, queue loadtest_q, **AMD off** for the first runs,
     recording **on**, auto-answer **on**. Map it to team Load test (Teams → Load test → Campaigns).
   - Leads → new list in campaign Load test → import `leads.csv`.
   - Don't start it yet.

## Run

On the **load generator**, three tmux windows (`tmux new -s lt`; new window: Ctrl+B then C):
```
cd ~/loadtest/sipp && ulimit -n 65535
# 1. the carrier (customers)
sipp -sf carrier.xml -i <loadgen-private-ip> -p 5060 -mi <loadgen-private-ip> -min_rtp_port 20000 -max_rtp_port 39998 -trace_err
# 2. the agents' phones (answering)
sipp -sf agents-answer.xml -i <loadgen-private-ip> -p 5070 -mi <loadgen-private-ip> -min_rtp_port 40000 -max_rtp_port 59998 -trace_err
# 3. register them, then the agents' screens
sipp <tel-private-ip>:5060 -sf agents-register.xml -inf ../sipp-agents.csv -i <loadgen-private-ip> -p 5071 -m 200 -r 20
node ~/loadtest/agents.js --url https://<app-private-ip> --count 25 --password <pw1> --campaign "Load test"
```
On **each VIZTEX server**: `bash ~/loadtest/measure.sh` in tmux (copy the kit to db and app too).

Check before starting: telephony `sudo asterisk -rx "pjsip show contacts" | grep -c 50` → 200;
Live Agents shows the bots Available.

**Steps** - start the campaign's dialer in the browser, then every ~10 minutes stop `agents.js`
(Ctrl+C) and start it with more agents: **25 → 50 → 100 → 150 → 200**. Keep 1-2 **real browser
agents** in the campaign too (normal extensions) to listen to the audio. Then resize telephony to
8 vCPU (stop, change type, start) and repeat the high steps.

**Stop when** CPU stays above ~80 %, loss above 1 %, jitter above 30 ms, or agents report choppy audio -
the step before is the limit.

## Reports on months of data

`bigdata.js` (on the app server, from `~/dialforge-backend`) fills the database with fake history -
by default 90 days of the campaign's agents, ~140 calls each per day, with dialer attempts,
call events, status rows, outcomes and callbacks - in a separate paused campaign "Big data history".
`report-times.js` then times every report (today / 7 / 30 / 90 days), the CDR export, dashboard,
Live Agents, Call Log and leads list. Steps: docs/LOADTEST_STEP_BY_STEP.md → H2.
`bigdata.js --remove --yes` deletes it again.

## After

- Copy the `~/loadtest-*.csv` files to your PC; the result is the table "telephony N vCPU = X agents".
- Real agents use encrypted browser phones, which cost Asterisk more than SIPp's plain SIP: plan with
  **20-30 % below** the measured limit.
- Delete all four servers, the security groups, the Elastic IPs, keys and DNS names (as in the guide's step 14).
- Undo on a server you keep: `sudo bash telephony-setup.sh --remove`.

## Dry run on dev (2026-10-24)

10 agents, about 25 minutes, everything on dev (SIPp carrier on port 5080, `--carrier-port 5080`, since
Asterisk has 5060; SIPp audio ports 20000-39998, above Asterisk's): 61 calls handled with a disposition,
0 bot errors, outcomes close to 70/15/15, every ended call recorded (MP3). Fixed on the way: Ubuntu's
package is `sip-tester`; one SIP login name (`loadtest`) for all test extensions (SIPp can't vary it
per call); `rewrite_contact=no` (calls go to the answering SIPp, port 5070); the carrier's BYE needs
VIZTEX's Contact as its address; Node 24's process is named `MainThread`. To check in the real test:
the jitter column (0.0 on one machine).
