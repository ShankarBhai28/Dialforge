# VIZTEX on your PC (no Asterisk)

Every screen works - users, campaigns, leads, reports, Live Agents, the Dialer page - but no
calls (there is no Asterisk on the PC; the phone line shows "not connected"). Good for UI
work and for trying things without a server. Set up on 30 Oct 2026.

## Every day (Git Bash)

```
cd /c/Users/User01/DialForge
bash scripts/local.sh start     # then open http://localhost:5173/app/  (login: boss)
bash scripts/local.sh status    # running or not
bash scripts/local.sh logs      # last lines of both logs
bash scripts/local.sh stop      # when done
```

- MySQL starts with Windows by itself (service **MySQL84**). If `start` says the backend is
  not running, check it: Windows key → "Services" → MySQL84 → Start.
- The backend log keeps saying `ECONNREFUSED ...:5038` / `:8088` (AMI / ARI): expected, no
  Asterisk here.
- Changing code under `web/src`: the browser updates by itself. Under `backend/`:
  `bash scripts/local.sh stop` then `start`.
- Low on memory (Task Manager shows RAM almost full): close heavy programs first - the two
  servers need ~300 MB, MySQL ~400 MB.

## Set up once (already done on this PC)

1. **MySQL Community Server 8.4** (Windows MSI from mysql.com): "Development Computer",
   your own root password, port 3306.
2. In `mysql -u root -p`: database `viztex_local` + user `viztex`@`localhost` with
   `GRANT ALL ON viztex_local.*` (a random password).
3. `backend/.env`: `DB_HOST=127.0.0.1`, `DB_USER=viztex`, `DB_PASSWORD=<that password>`,
   `DB_NAME=viztex_local`; placeholders for `ARI_PASS`, `AMI_PASS`; a random
   `SESSION_SECRET`; `STALE_AGENT_MINUTES=0`, `STALE_CALL_CHECK_SECONDS=0` (nothing to watch).
4. A local certificate (Git Bash):
   ```
   cd backend && mkdir -p certs && MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
     -keyout certs/privkey.pem -out certs/fullchain.pem
   ```
   (valid a year; make it again when it runs out).
5. `cd backend && npm run db:migrate`, then `npm run create-admin -- --username boss`
   (prints a one-time password - change it after logging in).
6. A test licence, so the Dashboard shows the Licence card (no file = no limits, no card):
   `backend/licence.local.json` with
   `{ "customer": "Local PC (test)", "seats": 10, "channels": 30, "expires": "2027-10-14" }`
   and in `backend/.env` `LICENCE_FILE=C:/Users/User01/DialForge/backend/licence.local.json`.
   Edit the file to try limits - the app re-reads it within 10 s, no restart.

`backend/.env`, `backend/certs/`, `backend/licence.local.json` and `.local-run/` are never
committed (`.gitignore`). Avast's HTTPS scanning re-signs even localhost, so the screen
(`web/vite.config.ts`) skips the certificate check for a backend on this PC only.

## Demo floor (to show Live Agents without real calls)

```
cd /c/Users/User01/DialForge/backend
npm run demo:floor -- add       # 6 demo agents: predictive / inbound / manual / callback calls, idle, break
npm run demo:floor -- remove    # deletes exactly those rows
```

Run `add` again for fresh timers. The demo agents have no password (they can't log in). The
tool refuses on a server with `APP_ENV=production`. Source: `backend/src/tools/demo-floor.js`.
