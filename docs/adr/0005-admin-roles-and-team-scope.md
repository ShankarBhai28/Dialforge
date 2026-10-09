# 0005 — Admin roles: per-screen rights and team scope

**Status:** Accepted (2026-10-10)

**Context.** Team Leaders and supervisors need an admin login, but not every admin right. The owner (Super Admin) decides what each role gets, and a TL usually sees only their own team.

**Decision.**
- `users.role` stays the account type: `admin` = Super Admin (everything), `agent`, and a new `staff` = an admin login limited by `users.role_id` → `roles`.
- A role sets, for each admin screen, **none / view / manage**, plus a **scope**: `all` teams, or `team` = only the teams the user is a member of on the Teams screen. Screens and checks live in `backend/src/services/access.js`.
- The server checks every admin request (`requirePermission(screen, level)` in `middleware/auth.js`). Hiding buttons in the app is only for convenience. Team scope is applied inside each route's SQL (`scopeCondition`, `campaignInScope`). Rows outside the scope answer 404, as if missing.
- Team scope covers campaign and agent data: dashboard, live agents, dialer, call log, campaigns, leads and lists, callbacks, reports, form responses, users and teams. Queues, DID numbers, forms and DNC are shared settings with no team, so only the screen level applies to them.
- A team-scoped role can't do things that reach outside its teams: create or delete campaigns, manage users, or change teams.
- Only a Super Admin manages roles and admin-side accounts (Super Admins and staff). A role with Users: manage handles agent accounts only, so nobody can raise their own rights.
- Lookup lists that screens need for dropdowns (`GET /admin/campaigns`, `lists`, `queues`, `forms`, `users`, `extensions`, `teams`, `roles`) are readable by any admin-side login. They are still scoped.
- Live updates (`/ws`) are filtered per staff connection by the same rules (`staffView` in `realtime/hub.js`). A team-scoped connection gets only a call id from `call.event`.
- Staff logins are admin-side only. Agent routes (calling, outcomes) refuse them (`requireCaller`).

**Consequences.**
- Every new admin route must pick a screen and level, and, if its data belongs to a campaign or agent, apply the scope. `backend/tests/access.test.js` shows the pattern.
- Rights apply on the user's next request: roles are cached and cleared on save.
- A user moved to another team gets the new scope at once for requests, and within 30 s for live updates.
