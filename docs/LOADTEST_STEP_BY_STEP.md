# Load test on four servers - step by step

How to measure **how many predictive agents one telephony server carries**: VIZTEX on three
servers (DB, telephony, app) plus one **load generator** that plays the agents and the
customers. No real people, no real phone calls. Written while doing it on 27 Oct 2026; the
values of that run are at the end ("This run").

The tools themselves are explained in [../loadtest/README.md](../loadtest/README.md); the
three VIZTEX installs come from [INSTALL_THREE_SERVERS.md](INSTALL_THREE_SERVERS.md). This page
is the **whole sequence in one place**, with the AWS surprises we hit.

**Time:** about half a day (installs ~1.5 h, preparing ~30 min, test steps ~1.5 h, cleanup 15 min).
**Cost:** about $4-6 (₹350-500) for 5 hours, if everything is deleted the same day.

```
 lt-gen (load generator)                lt-tel (Asterisk)              lt-app (VIZTEX + dialer)
 SIPp "agents' phones"  ◄── calls ───── Queue ◄──── dialer ──────────── campaign
 SIPp "carrier"         ◄── calls ───── loadtrunk                        │
 agents.js (bots) ───────────── HTTPS ──────────────────────────────────►│
                                          │                              │
                                          └──────── lt-db (MySQL) ◄──────┘
 All test traffic over private IPs (no internet traffic, no per-GB cost).
```

---

## A. AWS account - check this the day before

These three stopped us on 27 Oct; sort them out **before** creating servers.

1. **Paid plan.** On the AWS **Free plan** only small types (`m7i-flex.large`, `c7i-flex.large`,
   2 vCPU) can be launched; `c7i.xlarge` / `m7i.xlarge` don't even appear in the list.
   - Sign in as the **root user** (your email; an IAM user gets "An error occurred" on the button).
   - Billing and Cost Management → **Upgrade plan** → confirm. One-way; the remaining credits stay
     and are used first (Billing → **Credits** shows the balance). Afterwards, usage beyond the
     credits is charged to the card.
   - Right after: Billing → **Budgets** → Create → template **Monthly cost budget** → **$10** →
     your email. AWS emails you before a forgotten server costs real money.
2. **vCPU limit.** New accounts may run only **8 vCPU** in total ("You have requested more vCPU
   capacity than your current vCPU limit of 8"). The test needs **16** at its peak
   (db 2 + app 2 + telephony 8 + generator 4).
   - **Service Quotas** → Amazon EC2 → "**Running On-Demand Standard (A, C, D, H, I, M, R, T, Z)
     instances**" → Request increase at account level → **16**. Region Mumbai.
   - **Not** "All Standard (A, C, D, H, I, M, R, T, Z) **Spot Instance Requests**" - almost the same
     name, but a different quota that doesn't help. Search for `On-Demand Standard`; its current
     value shows 8.
   - Only one request at a time ("Quota increase request limit reached" = one is already pending).
     Status: Service Quotas → **Quota request history**. Can take hours - request a day early.
3. **"Insufficient capacity"** when starting a server = AWS has none of that type in that zone
   right now (not your account). Pick a twin type with the same vCPU: `c7i.xlarge` →
   **`m7i.xlarge`** → `c6i.xlarge` → `m6i.xlarge`. Keep the same family for the 8-vCPU step later
   (`m7i.xlarge` → `m7i.2xlarge`) so the two results compare fairly.

- [ ] Paid plan, $10 budget, vCPU limit 16 approved.

## B. Security groups (4)

Create all four **empty** first (they refer to each other), then add the rules. Same rules as
INSTALL_THREE_SERVERS step 2, plus the generator's:

| Group | Inbound rules |
|---|---|
| **lt-db-sg** | SSH 22 My IP; TCP 3306 from lt-app-sg; TCP 3306 from lt-tel-sg |
| **lt-tel-sg** | SSH 22 My IP; TCP 80, 8089 Anywhere; TCP+UDP 3478 Anywhere; UDP 10000-20000 Anywhere; UDP 49152-49300 Anywhere; TCP 8088 + 5038 from lt-app-sg; **UDP 5060 from lt-gen-sg**; **UDP 10000-20000 from lt-gen-sg** |
| **lt-app-sg** | SSH 22 My IP; TCP 80, 443, 3000 Anywhere (443 also serves the bots) |
| **lt-gen-sg** | SSH 22 My IP; **all UDP from lt-tel-sg** |

SSH times out on one server but works on another? Compare that server's group with a working
one (Instance → **Security** tab shows which group it really has), and make sure you use its
**current** public IP.

- [ ] Four groups with their rules.

## C. Servers (4), addresses, names

Mumbai, **Ubuntu 24.04**, default VPC, **the same subnet for all four**, auto-assign public IP on.
One key pair for db/tel/app is fine; the generator may have its own.

| Name | Type | Disk | Group | Elastic IP + DNS |
|---|---|---|---|---|
| lt-db | m7i-flex.large (2 vCPU / 8 GB) | 20-30 GB | lt-db-sg | no |
| lt-tel | **c7i.xlarge or m7i.xlarge (4 vCPU)** → later 8 vCPU | 30 GB | lt-tel-sg | **yes** |
| lt-app | m7i-flex.large (2 vCPU / 8 GB) | 30 GB | lt-app-sg | **yes** |
| lt-gen | **c7i.xlarge or m7i.xlarge (4 vCPU)** | 16 GB | lt-gen-sg | no |

**Elastic IPs:** EC2 → Elastic IPs → Allocate (2) → select → Actions → **Associate** → instance.
Check on the instance's page that the IP appears under **"Elastic IP addresses"** - an allocated
but un-associated Elastic IP does nothing and is still charged. Release any spare one.
**DNS:** the two names → the two **Elastic** IPs (not the temporary public IPs: those change on
every stop/start, and the telephony install writes its IP into Asterisk and TURN).

Why not start the generator right away: with an 8-vCPU limit it doesn't fit next to a 4-vCPU
telephony server. It isn't needed until section H - keep it **stopped** until the quota is raised.
(A stopped server without an Elastic IP gets a new public IP when started - fine for the generator.)

```
nslookup <tel-name>      # -> telephony Elastic IP
nslookup <app-name>      # -> app Elastic IP
```
- [ ] Fill in the table in "This run" (private IPs!).

## D. Package to the three VIZTEX servers (your PC, Git Bash)

```
cd /c/Users/User01/DialForge
git checkout main && git pull
bash scripts/make-release.sh                 # prints dist/viztex-<date>-<commit>.tgz
PKG=dist/viztex-<date>-<commit>.tgz          # <- the printed name
for ip in <db-ip> <tel-elastic-ip> <app-elastic-ip>; do
  scp -i ~/Documents/<key>.pem $PKG ubuntu@$ip:~ &&
  ssh -i ~/Documents/<key>.pem ubuntu@$ip "rm -rf viztex && tar xzf $(basename $PKG) && cat viztex/VERSION"
done
```
- [ ] Three identical VERSION lines.

## E. Install DB, telephony, app

Exactly INSTALL_THREE_SERVERS **steps 7-11** (what each does and the expected checks are there):

```
# 7. DB server
sudo bash viztex/install/install.sh --role db --app-ip <app-private> --telephony-ip <tel-private>

# 8. shared passwords: from your PC, one whole line each (never the part before | alone)
ssh -i ~/Documents/<key>.pem ubuntu@<db-ip> "sudo cat /etc/viztex/secrets.env" | ssh -i ~/Documents/<key>.pem ubuntu@<tel-elastic-ip> "umask 077; cat > ~/secrets.env"
ssh -i ~/Documents/<key>.pem ubuntu@<db-ip> "sudo cat /etc/viztex/secrets.env" | ssh -i ~/Documents/<key>.pem ubuntu@<app-elastic-ip> "umask 077; cat > ~/secrets.env"

# 9. telephony server, in tmux (~30 min) - one FAIL (ODBC) expected here
sudo bash viztex/install/install.sh --role telephony --domain <tel-name> --email <you> \
  --db-ip <db-private> --app-ip <app-private> --secrets ~/secrets.env

# 10. app server, in tmux - save the one-time password, never paste it anywhere
sudo bash viztex/install/install.sh --role app --domain <app-name> --admin boss --email <you> \
  --db-ip <db-private> --telephony-ip <tel-private> --telephony-domain <tel-name> --secrets ~/secrets.env

# 11. telephony again: now everything OK; then rm ~/secrets.env on tel and app
sudo bash viztex/install/install.sh --role telephony ... --secrets ~/secrets.env --checks-only
```
No test call and no real trunk needed. Log in once in the browser as `boss` and change the password.

- [ ] All checks OK; `~/secrets.env` removed from tel and app.

## F. Load generator

When the quota allows it, start **lt-gen** (note its new public IP), then from your PC:
```
cd /c/Users/User01/DialForge
scp -i ~/Documents/<gen-key>.pem -r loadtest ubuntu@<gen-ip>:~
ssh -i ~/Documents/<gen-key>.pem ubuntu@<gen-ip> "sudo bash loadtest/loadgen-setup.sh"
```
The kit also goes to the other three (for `measure.sh`, and the telephony setup):
```
for ip in <db-ip> <tel-elastic-ip> <app-elastic-ip>; do scp -i ~/Documents/<key>.pem -r loadtest ubuntu@$ip:~; done
```
- [ ] `sipp -v` works on lt-gen.

## G. Prepare VIZTEX

loadtest/README.md → "Prepare VIZTEX", with 200 agents:
1. Your PC: `node loadtest/make-files.js --count 200 --team "Load test" --agent-password <pw1> --sip-password <pw2>`
   (two throwaway passwords, letters/digits; kept in `loadtest/out/`, never committed), then
   `scp ... loadtest/out/sipp-agents.csv ubuntu@<gen-ip>:~/loadtest/`.
2. App server: `set-licence.sh --customer "Load test" --seats 250 --channels 600 --expires <date>`,
   `cd ~/dialforge-backend && npm run ext:add -- --from 5001 --count 200`.
3. Telephony server: `sudo bash ~/loadtest/telephony-setup.sh --loadgen-ip <gen-private> --from 5001 --count 200 --password <pw2>`.
4. App server `.env`: `TRUNK_ENDPOINT=loadtrunk`, `TRUNK_CALLER_ID=8000000000`,
   `DIALER_MAX_TRUNK_CHANNELS=600`; `sudo systemctl restart dialforge-backend dialforge-dialer`.
5. Browser (boss): team **Load test**; Users → Import agents → `agents-import.csv`; queue
   **loadtest_q** with **Least recent** (check after saving - not Ring all); campaign **Load test**
   (Predictive, loadtest_q, AMD off, recording on, auto-answer on), mapped to the team; leads list ←
   `leads.csv`. Don't start it yet.

- [ ] 200 agents, queue Least recent, campaign + leads ready.

## H. Run

loadtest/README.md → "Run": on lt-gen three SIPp windows + `agents.js`; `measure.sh` on db, tel
and app. Start the campaign in the browser. Steps of ~10 minutes: **25 → 50 → 100 → 150 → 200**
agents. Stop when CPU stays above ~80 %, loss above 1 %, jitter above 30 ms, or audio is choppy.

Then the **8-vCPU** round: stop lt-tel → Change instance type (same family, 2xlarge) → start (the
Elastic IP stays) → re-register the agents (SIPp register window) → repeat the high steps.

## H2. Reports on months of data (after the calls test)

The calls test leaves a nearly empty database; a real customer's grows by ~2 million calls a
quarter. This fills it with that much fake history and times every admin screen.

1. **Stop the campaign's dialer** in the browser and wait until no call is open (the script refuses
   otherwise).
2. App server - fill 90 days for the 200 agents (about 20-40 min, ~8-10 GB on the DB disk;
   it prints a line per day):
   ```
   cd ~/dialforge-backend && node ~/loadtest/bigdata.js --days 90 --yes
   ```
   It makes a paused campaign **Big data history** with its own leads, so the test campaign is untouched.
3. Time the screens, alone (on the app server, `boss` and its password):
   ```
   node ~/loadtest/report-times.js --url https://127.0.0.1 --user boss --password '<boss password>'
   ```
   Then again with 3 admins at once (`--parallel 3`), and once more **while 100 agents run**
   (start the campaign and the bots as in H). `measure.sh` on db and app shows what each costs.
4. Anything over ~5 s gets fixed (index, shorter default range) before a big customer.
5. To keep the server but drop the history: `node ~/loadtest/bigdata.js --remove --yes`.

## I. Results and cleanup

1. Copy `~/loadtest-*.csv` from db, tel and app to your PC; fill in "Results" below.
2. Delete: the 4 instances (Terminate) → **release both Elastic IPs** → the 4 security groups →
   the key pairs → the DDNS names. Check EC2 → Instances / Elastic IPs / Volumes are empty.
3. Next day: Billing → Bills shows the test's cost.

- [ ] Nothing left running.

---

## This run (27 Oct 2026)

| | lt-db | lt-tel | lt-app | lt-gen |
|---|---|---|---|---|
| Type | m7i-flex.large (2 / 8 GB) | m7i.xlarge (4 / 16 GB) | m7i-flex.large (2 / 8 GB) | c7i.xlarge (4 vCPU) |
| Private IP | 172.31.11.46 | 172.31.12.28 | 172.31.1.12 | 172.31.10.106 |
| Public IP | 43.204.235.135 | 13.232.143.228 (Elastic) | 43.205.200.115 (Elastic) | changes on start |
| DNS | - | lt-tel.freeddns.org | lt-app.ddnsfree.com | - |
| Key | Load_test.pem | Load_test.pem | Load_test.pem | lt-gen.pem |

What happened:
- All four first launched on the Free plan as 2-vCPU types; c7i.xlarge wasn't offered → upgraded to
  the Paid plan (as root; $91 credits left), $10 budget.
- The DNS names first pointed at two Elastic IPs that were allocated but never associated, so the
  servers ran on temporary IPs; fixed by associating Elastic IPs with lt-tel and lt-app.
- lt-tel to c7i.xlarge: "vCPU limit of 8" → quota increase to 16 requested; lt-gen stopped meanwhile.
  Then "insufficient capacity" for c7i.xlarge → **m7i.xlarge** worked.
- The first quota request went to the **Spot** quota by mistake (case 179309603500231) → requested
  the On-Demand one again.
- Installs (package 20261027-0fdb869): DB, telephony (one planned ODBC FAIL, OK after the app),
  app - all checks OK. Section G done the same day: 200 extensions + test endpoints, `.env` switched
  to `loadtrunk` (backup `.env.before-loadtest`), 200 agents imported, queue `leastrecent`,
  campaign Predictive / AMD off / recording on / auto-answer on, 20,000 leads.

## Results

| Telephony | Agents | Calls at once | CPU % (tel) | Loss % | Jitter ms | Audio | Verdict |
|---|---|---|---|---|---|---|---|
| 4 vCPU | 25 | | | | | | |
| 4 vCPU | 50 | | | | | | |
| 4 vCPU | 100 | | | | | | |
| 4 vCPU | 150 | | | | | | |
| 4 vCPU | 200 | | | | | | |
| 8 vCPU | 150 | | | | | | |
| 8 vCPU | 200 | | | | | | |

Reports on 90 days of history (report-times.js; seconds, the slowest of each kind):

| Screen | Alone | 3 admins | During 100 agents |
|---|---|---|---|
| Dashboard | | | |
| Call Log (page 1) | | | |
| CDR - 30 days | | | |
| Agent Performance - 30 days | | | |
| Campaign Performance - 90 days | | | |
| Predictive - 90 days | | | |
| List Penetration | | | |
| CDR export CSV - 30 days | | | |
