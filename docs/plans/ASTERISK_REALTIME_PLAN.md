# Plan — Asterisk reads extensions and queues from MySQL (step 2)

Status: **proposed, waiting for go-ahead** (2026-10-13). Nothing on the server has been changed for this yet.

## Why
Today two things are set by hand on the Asterisk server:
- **Extensions** (agent softphone lines) are typed into `/etc/asterisk/pjsip.conf` *and* separately into the `extensions` table. A new extension or a new client means editing files on the server.
- **Queues**: the app writes `/etc/asterisk/queues.conf` directly (`routes/queues.js`), so the app must run on the same machine as Asterisk.

After this step the database is the only place for both; Asterisk reads it. Adding an extension or queue in the app is enough, and Asterisk can live on its own server (needed for bigger clients).

## What was checked (read-only, 2026-10-13)
| Item | Finding |
|---|---|
| Asterisk modules | `res_odbc`, `res_config_odbc`, `res_sorcery_realtime` are loaded — realtime support is there |
| ODBC | unixODBC libraries installed; **MySQL/MariaDB ODBC driver missing** (`odbc-mariadb` 3.1.15 available from Ubuntu) |
| Extensions | 3 (1001–1003) in `pjsip.conf` (endpoint + auth + aor each, WebRTC, `ulaw,opus`, context `internal`) and in the `extensions` table — **passwords identical** in both (compared by hash) |
| Trunk + transports | `transport-wss`, `transport-udp`, trunk `dialforge-nxtra1` (endpoint/auth/aor/identify) — stay in `pjsip.conf` |
| Queues | 4 stanzas in `queues.conf`, same values as the `queues` table; `[general] persistentmembers = yes` |
| Queue members | added / removed at runtime by the app over AMI (dynamic) — unchanged by this step |

## Design
1. **Extensions** — PJSIP *sorcery* looks in two places, in order: `pjsip.conf` (transports, trunk) and then MySQL for agent extensions.
   - The database gets three **views** in Asterisk's standard shape — `ps_endpoints`, `ps_auths`, `ps_aors` — built from our own `extensions` table (the id, the SIP password, and the shared WebRTC settings). The `extensions` table stays the single source of truth; nothing is copied.
   - Per-extension options (codecs, context) start as fixed values in the views; columns can be added later if a client needs differences.
2. **Queues** — `app_queue` realtime reads a view `ast_queues` built from our `queues` table (`asterisk_name` → `name`, `ring_strategy` → `strategy`, …). The 4 static stanzas leave `queues.conf` (`[general]` stays). `routes/queues.js` stops editing the file; saving a queue is just the database row, which Asterisk reads the next time the queue is used.
3. **Access** — a separate MySQL user `asterisk_rt` that may only **read those four views** (it can't see leads, users or anything else). Asterisk connects with it over ODBC (`res_odbc.conf`, DSN in `/etc/odbc.ini`).
4. **App screen** — a new **Extensions** screen (Telephony): create / edit / disable extensions, generate a strong SIP password, see whether each is registered. New permission `extensions` in roles.
5. **Migration** `0002_asterisk_realtime.sql` creates the views; `db:migrate` applies it like any other change.

## Cut-over (one short window, your choice of time)
Before: full backup of `/etc/asterisk` + database; no active calls (checked).
1. Install `odbc-mariadb`, add the DSN, create `asterisk_rt`, apply migration 0002 — **no effect on calls yet**.
2. Test while the old setup still runs: `odbc show` (connected), `realtime load ps_endpoints id 1001` (row comes back), and a test queue that exists only in MySQL (static queues still win for the real names).
3. Switch: new `sorcery.conf` + `extconfig.conf`; remove the 3 extensions from `pjsip.conf` and the 4 queue stanzas from `queues.conf`; `module reload res_pjsip.so`, `module reload app_queue.so`. Browsers re-register by themselves within seconds (the agent screen reconnects).
4. Check: `pjsip show endpoints` lists 1001–1003 + trunk, an agent connects and calls out, an inbound call reaches the queue, Available/Break still move queue membership.
5. Deploy the app part (queue editing without the file, Extensions screen).

**Expected interruption:** registered agent lines drop and reconnect once (under a minute). Don't do it during a campaign.

**Undo (one command):** restore the `/etc/asterisk` backup and `core restart now` — back to today's files exactly. The views and the `asterisk_rt` user can stay; they do nothing without the config.

## Risks and how they're covered
| Risk | Cover |
|---|---|
| MySQL 8 login method not supported by the driver | Tested in step 2 of the cut-over before switching; `asterisk_rt` can use `mysql_native_password` if needed |
| DB down → Asterisk can't find extensions | Same as the app today (it needs the DB too). Sorcery can cache realtime objects; added if the load test shows a need |
| A typo in a view breaks registration | Views tested with `realtime load` before the switch; undo restores the files |
| Passwords different between file and DB | Already verified identical |

## After this step
- A new client = install script + `db:migrate` + `create-admin` + extensions created on the screen. No Asterisk file editing for agents or queues.
- Asterisk can move to its own server: point the ODBC DSN at the database server, open MySQL to that server only.
