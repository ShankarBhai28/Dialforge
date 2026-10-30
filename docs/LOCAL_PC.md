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

`backend/.env`, `backend/certs/` and `.local-run/` are never committed (`.gitignore`).
