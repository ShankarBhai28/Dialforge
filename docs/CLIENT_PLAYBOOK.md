# VIZTEX client playbook - a new client on its own server, from scratch

The complete procedure, in order, for giving a client VIZTEX: what to collect,
the AWS server, the install, the client's setup, go-live, handover, running
many client servers, and taking one down. The deep "why" of each server piece
is in DEPLOY.md; the installer's details in INSTALL.md; recovery in
DISASTER_RECOVERY.md.

**Model today: one client = one server** (its own database, Asterisk, app,
backups). Section 9 says when and how to move beyond that.

> Before the first real client: run sections 3-5 once on a test EC2 and
> terminate it (the installer has not yet run on a fresh server), and do a
> load test for the sizing in section 2.

---

## 1. Collect from the client (before anything is built)

| Item | Example / why |
|---|---|
| Company name, admin contact (name, phone, email) | who gets the Super Admin login, who to call |
| Number of agents (now / in 6 months), supervisors / TLs | server size (section 2), roles |
| Working days and hours, time zone | campaign calling hours, report days (`--timezone`) |
| Hostname they want | `acme.viztex.in` (your domain) or their own subdomain - you need control of its DNS |
| Where agents work from | office IPs (to restrict port 3000 / 8089 later) or anywhere |
| **SIP trunk**: provider, IP-allowlisted or username/password, provider SIP IP(s), DIDs, outgoing caller ID, concurrent channels | `add-trunk.sh`; ask the provider to allow your server's IP |
| Campaigns: names, dial mode (manual / preview / progressive / predictive), outcomes (dispositions) and which count as success | Campaigns setup |
| Lead lists (Excel / CSV) and the fields per lead | the campaign form + import template |
| Inbound: which DID goes to which campaign / queue | DID numbers |
| Recording: yes / no, how long to keep (default 90 days), an announcement? | `RECORDING_RETENTION_DAYS`; consent wording (their legal duty) |
| DNC: numbers never to call; TRAI / NCPR scrubbing who does it | DNC list import |
| Alerts: a Slack / Teams / Google Chat webhook for problems | `ALERT_WEBHOOK_URL` |
| Data rules: who may see recordings, export reports | roles |

Keep this in the client's record (section 8), not in Git.

---

## 2. Size the server (estimates - confirm with a load test)

| Agents | EC2 type (or similar) | vCPU / RAM | Disk |
|---|---|---|---|
| up to 15 | t3.medium | 2 / 4 GB | 40 GB |
| 15 - 40 | c7i.xlarge / m7i.xlarge | 4 / 8-16 GB | 100 GB |
| 40 - 80 | c7i.2xlarge | 8 / 16 GB | 200 GB |
| 80+ | load test first; likely Asterisk on its own server (section 9) | | |

Recordings: about 0.2 MB a minute -> 50 agents x 5 h talk a day ~ 3.6 GB a day,
~330 GB for 90 days; keep fewer days on the server and the rest in S3.
Prices change - use the AWS Pricing Calculator (region ap-south-1, Mumbai) and
add EBS disk, Elastic IP and S3. Bill the client with a margin over this.

---

## 3. AWS (about 20 minutes, AWS console)

1. **Key pair**: EC2 -> Key pairs -> Create, name `viztex-<client>`, `.pem`. Store it
   safely right away (DISASTER_RECOVERY section C) - it's the only way in.
2. **Security group** `viztex-<client>` - inbound:

   | Port | Protocol | Source | For |
   |---|---|---|---|
   | 22 | TCP | your office IP | SSH |
   | 80 | TCP | 0.0.0.0/0 | certificate issue / renewal |
   | 3000 | TCP | 0.0.0.0/0 (or the client's office IPs) | the app |
   | 8089 | TCP | same as 3000 | agents' browser phones |
   | 3478 | TCP + UDP | 0.0.0.0/0 | TURN |
   | 10000-20000 | UDP | 0.0.0.0/0 | call audio |
   | 49152-49300 | UDP | 0.0.0.0/0 | TURN relay |
   | 5060 | UDP | the SIP provider's IP(s) only | trunk (add after section 5) |

   Never 3306 (MySQL) or 5038 (AMI).
3. **Launch the instance**: Ubuntu Server 24.04 LTS, size from section 2, the key
   pair and security group, disk size from section 2 (gp3). Name tag `viztex-<client>`.
4. **Elastic IP**: allocate, associate with the instance (the IP must never change -
   the trunk provider allows this IP).
5. **Backups bucket** (once per client): S3 -> Create bucket `viztex-backup-<client>`,
   region ap-south-1, Block all public access ON, default encryption ON. Optional
   lifecycle rule: delete objects after 180 days.
6. **IAM role** for the server: IAM -> Roles -> Create -> AWS service: EC2 ->
   create this policy (put / read / list, **no delete** - a hacked server can't wipe
   its backups):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
         "Resource": "arn:aws:s3:::viztex-backup-<client>/*" },
       { "Effect": "Allow", "Action": "s3:ListBucket",
         "Resource": "arn:aws:s3:::viztex-backup-<client>" }
     ]
   }
   ```
   Role name `viztex-backup-<client>`; then EC2 -> the instance -> Actions ->
   Security -> Modify IAM role -> choose it.
7. **Budget alert** (once for the account): Billing -> Budgets -> monthly budget
   with an email alert, so a forgotten server is noticed.

---

## 4. DNS (5 minutes + waiting)

Create an A record `<hostname>` -> the Elastic IP (your DNS provider / DDNS).
Check from your PC: `nslookup <hostname>` shows the Elastic IP. The certificate
step fails until it does.

---

## 5. Install (about 30-45 minutes, mostly waiting)

On your PC (repo root, Git Bash) - always from a commit that passed CI and was
tried on dev:
```
git checkout main && git pull
bash scripts/make-release.sh                       # -> dist/viztex-<date>-<commit>.tgz
scp -i viztex-<client>.pem dist/viztex-*.tgz ubuntu@<elastic-ip>:~
ssh -i viztex-<client>.pem ubuntu@<elastic-ip>
```
On the server:
```
tar xzf viztex-*.tgz
sudo bash viztex/install/install.sh --domain <hostname> --admin <your-admin-name> \
  --email <your-email> --timezone Asia/Kolkata
```
At the end: **11 checks** and the **Super Admin login + one-time password** -
store it in the client record. A failed check names the step; full log
`/var/log/viztex-install.log`; fix and run the same command again (safe).

Then on the server, `~/dialforge-backend/.env`:
```
BACKUP_S3_BUCKET=viztex-backup-<client>
ALERT_WEBHOOK_URL=<client or your webhook>
RECORDING_RETENTION_DAYS=90
```
`sudo systemctl restart dialforge-backend` and run one backup:
`sudo systemctl start dialforge-backup.service` -> Dashboard -> System health
shows "copied off-server".

---

## 6. Set up the client (in the app, about 1-2 hours)

Log in at `https://<hostname>:3000` as the Super Admin; **change the password**.
In this order (each needs the one before):

0. **Licence** - what they pay for, on the server (only you can change it):
   `sudo bash viztex/install/set-licence.sh --customer "Acme" --seats 10 --channels 15 --expires 2026-12-31`
   - seats: most **agents logged in at the same time** - the next agent's login gets
     "All 10 agent seats are in use" (admins / supervisors and extensions don't
     count; an agent frees the seat by logging out, closing the screen, or after
     10 min with the line down); channels: most calls on the
     trunk at once, every kind (dialer, manual, transfer out, inbound - over it the
     agent sees "All 15 phone lines are in use", an inbound caller hears busy);
     keep it at or below what the trunk provider gives them.
   - expires: admins see a warning 14 days before; after it agents can't log in,
     calls and the dialer stop; admin login and all data stay (they can export).
   - Renew: `set-licence.sh --expires 2027-03-31` (other values kept). More seats:
     `--seats 15` (+ `ext:add` if they need more extensions). `--show` prints it. Applies within 10 s, no restart.
1. **Extensions** - one per agent (1001, 1002, ...) plus any monitoring lines
   for admins, added by you on the server: `npm run ext:add -- --from 1001 --count 10`
   (not limited by the licence - its seats count logged-in agents). The client's
   admin can't add them (no button, API refuses); they can assign, rename,
   disable, re-key and delete.
2. **Roles** - e.g. TL, Supervisor: tick the rights (Reports, Dialer control,
   Hang up live calls, Play recordings, Listen / Whisper / Barge, Force logout...).
3. **Users** - agents (each with an extension), TLs / supervisors (with a role,
   and an extension if they monitor calls), the client's own admin.
4. **Queues** - one per campaign (ring strategy, wait time).
5. **Forms** - the fields agents fill per call.
6. **Campaigns** - dial mode, queue, form, outcomes (tick **Success** on the
   good ones), calling hours, recording on/off, recycle rules, Max channels.
7. **Teams** - agents + their campaigns (a campaign in no team can't be worked).
8. **Lists** - create, then **Import** the client's leads (**Check file** first;
   duplicate check "In this campaign").
9. **DNC** - import the client's do-not-call numbers.
10. **SIP trunk** (provider has allowed the Elastic IP; open UDP 5060 to them):
    ```
    sudo bash ~/viztex/install/add-trunk.sh --host <provider-ip> --caller-id <did> --channels <n>
    # username/password trunk: add --username U --password 'P' --register
    ```
    Then **DID numbers** -> map each DID to its campaign.

---

## 7. Go-live checklist (do every line; tick in the client record)

- [ ] Licence: Dashboard shows the Licence card with the right seats, lines and end date.
- [ ] Agent logs in -> Start your shift -> Available; line registered.
- [ ] Outbound: agent calls a mobile; audio both ways; outcome saved; shows in Call log.
- [ ] Inbound: call each DID from a mobile; right campaign; agent answers.
- [ ] Recording plays (Call log / Reports -> Call Detail).
- [ ] Transfer and conference between two agents.
- [ ] Supervisor: Live Agents, Listen / Whisper / Barge; Dialer -> Live calls, Hang up.
- [ ] Dialer (if used): start the campaign with 1-2 agents; watch drop % in Reports.
- [ ] Reports show today's calls in the client's time zone.
- [ ] Backup: System health "copied off-server"; S3 bucket has today's files.
- [ ] Alerts: stop and start the dialer service once -> the webhook gets a message.
- [ ] Uptime check: a free external monitor (UptimeRobot / Better Stack) on
      `https://<hostname>:3000/health`, alerting you.
- [ ] Recording announcement / consent handled by the client.
- [ ] Agents trained (login, outcomes, callbacks, call log); supervisors (Live Agents, Dialer, Reports).

---

## 8. Handover and the client record

Give the client: the URL, their admin login (they change the password), a short
agent guide, your support contact and hours.

Keep **one record per client** in a private place (password manager / private
sheet - never Git):

| Field | |
|---|---|
| Client, contacts | |
| Hostname, Elastic IP, region, instance id, size | |
| Key pair file name (where stored) | |
| S3 bucket, IAM role | |
| Super Admin username (password in the password manager) | |
| Trunk provider, account, DIDs, channels | |
| Licence: seats, channels, end date (renewal reminder in your calendar) | |
| Installed release (`dist/viztex-<date>-<commit>`), date | |
| Updates applied (date, commit) | |
| Go-live date, checklist done | |
| Monthly cost (AWS) / price | |

---

## 9. Running many client servers

**Updates (one at a time, quiet hours):**
1. The change is on `main`, CI passed, and it ran on dev first.
2. Per client, outside working hours:
   `DEPLOY_HOST=ubuntu@<client-ip> DEPLOY_KEY=viztex-<client>.pem bash scripts/deploy-dev.sh`
   (refuses during calls; backs up; runs migrations; restarts only what changed;
   health check; prints the rollback line).
3. Update the client record (date, commit). Tag releases you roll out:
   `git tag v2026.10.14 && git push --tags`.
4. Dialplan file changes (`backend/asterisk/*.conf`) need a manual copy - see INSTALL.md section 5.

**Every week:** look at each server's System health (backups copied, disk,
services); read the alert channel.
**Every month:** `sudo apt update && sudo apt upgrade -y` on each server (quiet
hours; reboot if it asks); check AWS bill vs the budget; test one restore from a
backup on a throwaway server now and then (DISASTER_RECOVERY section B).

**Security:** SSH only from your IP; one key per client; never share the
Super Admin; remove leavers in Users; keep the S3 role without delete rights.

---

## 10. When a client leaves

1. Agree the end date; export what they're owed (Reports CSV, recordings from S3,
   leads) and hand it over.
2. A last backup (`sudo systemctl start dialforge-backup.service`) - keep the S3
   bucket for the time your contract says, then delete it.
3. Ask the trunk provider to remove the IP; stop the instance, then terminate it;
   **release the Elastic IP** (an unattached one is billed); delete the DNS record,
   security group and IAM role.
4. Mark the client record "closed" with the dates.

---

## 11. The next level (plan it when this hurts, not before)

Standalone per client is the right start: complete isolation, simple support,
easy pricing, easy exit. Move on when one of these appears - typically around
5-10 clients:

| Pain | Next step |
|---|---|
| Updating N servers by hand takes too long | **Fleet tooling**: a private inventory file of clients + `deploy-all` (update each in turn, stop at the first failure), one health view of all servers. Cheapest big win - do this first. |
| Many small servers mostly idle; cost | **Shared app, own database per client**: one app cluster serving several clients, each with its own MySQL database; Asterisk shared or per client. |
| A client above ~80-100 agents | **Split one client**: Asterisk (and the dialer) on their own servers, MySQL on RDS, the app behind a load balancer; SIPp load test to size it. |
| Dozens of clients, self-signup | **Full SaaS**: tenant id everywhere (already in the schema), one control plane, Kamailio in front of a pool of Asterisk servers, central billing and monitoring. |

Before any of these: the installer run on a fresh server, a load test (real
agents-per-server numbers), and the fleet tooling.
