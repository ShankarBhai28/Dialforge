# Contributing to DialForge

## 1. Setup (about 10 minutes)

Needs **Node.js 22+** and Git.

```
git clone https://github.com/ShankarBhai28/Dialforge.git
cd Dialforge
npm install                 # repo tools: ESLint, Prettier
npm --prefix backend install
npm --prefix web install
npm run check               # lint + format check + tests - must pass before you start
```

Editor: install the **ESLint**, **Prettier** and **EditorConfig** extensions, and turn on "format on save".

### Running things

| You are working on | How to run it |
|---|---|
| Backend logic (dialer rules, call control, validation) | Write or extend a test in `backend/tests/` and run `npm test`. The tests use fake Asterisk and fake DB objects, so nothing else is needed. |
| Screens (React app) | `npm run dev:web`, then open http://localhost:5173/app. API calls go to the dev server, so you need no Asterisk on your laptop. Read `docs/FRONTEND.md` first. |
| Backend against real Asterisk | Use **your own test server** (see `docs/DEPLOY.md`). Never point a local backend at the shared dev server's Asterisk: two processes using the same ARI app name steal each other's calls. |

## 2. Branches and commits
- `main` = what runs in production. Nobody pushes to it directly.
- Make a branch from the current working branch: `feature/<short-name>`, `fix/<short-name>`.
- Small commits. The first line of the message says what changed in plain words ("Recycle: skip DNC numbers"); the body says why.
- One topic per pull request. Formatting-only changes go in their own commit.

## 3. Pull request checklist
- [ ] `npm run check` passes (CI runs the same thing).
- [ ] New logic has a test in `backend/tests/` (or `web/`, from Stage 2).
- [ ] Schema change → new `backend/migration-<topic>.sql`, safe to run on the live DB, mentioned in the PR.
- [ ] Anything touching calls (ARI/AMI, dialplan, queues, dialer) lists how you tested it, and is tested on a test server with **internal extensions or your own numbers**.
- [ ] Docs updated: `ARCHITECTURE.md` if a flow changed, plus a `RUNBOOK.md` entry for anything deployed.
- [ ] No secrets, customer numbers or real lead data in code, tests, logs or screenshots.

## 4. Code rules
- Formatting is Prettier's job — don't argue with it. Lint errors block the merge.
- Server: validate every input, use `?` placeholders in SQL (never build SQL from strings), and return clear errors as `{ error: "..." }` with the right HTTP status.
- Never trust the browser for permissions: check the role on the server for every admin route.
- Keep Asterisk thin: logic belongs in our code, not in long dialplan.
- A blocked delete gets a specific message ("used by campaign X"), never a silent cascade.

## 5. Safety rules (read these twice)
- **Never place test calls through a live customer trunk.** Test trunks and internal extensions only.
- **Never start a campaign on a shared server** unless the person who owns it asked you to.
- Back up before every server change: DB dump plus copies of the files you change, in `~/backups/<name>-<date>/`.
- Production access is limited to the people who deploy. Developers work on test servers.

## 6. Deploying
Only people with server access deploy. Use the script, so every deploy follows the same steps:
```
DEPLOY_KEY=~/path/to/key.pem scripts/deploy-dev.sh      # DRY_RUN=1 to only build and package
```
It runs `npm run check` and builds the web app. On the server it then:
- refuses if calls are active;
- backs up to `~/backups/pre-deploy-<time>/`;
- reinstalls dependencies only if the lockfile changed;
- restarts the backend, and the dialer only if dialer code changed;
- checks `/health` and `/app`;
- prints the rollback command.

The script does **not** apply database migrations: run the new `backend/migration-*.sql` by hand first (see `docs/DEPLOY.md` §15). After deploying, check the screen you changed and add a `RUNBOOK.md` entry.
