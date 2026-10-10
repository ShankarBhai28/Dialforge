# 0005 — Admin roles: per-screen rights and team scope

**Status:** Accepted (2026-10-10)

**Context.** Team Leaders and supervisors need an admin login, but not every admin right. The owner (Super Admin) decides what each role gets, and a TL usually sees only their own team.

**Decision.**
- `users.role` stays the account type: `admin` = Super Admin (everything), `agent`, and a new `staff` = an admin login limited by `users.role_id` → `roles`.
- A role ticks, for each admin screen, the **actions** it may do: View, Create, Edit, Delete, and that screen's own ones (Dialer Start/Pause/Stop, Leads Import and Recycle, Callbacks Cancel, Users Reset password, Reports Export CSV). Any action implies View; nothing ticked hides the screen. (The first version had none / view / manage; a single "manage" was too coarse, e.g. create campaigns but not delete them. Rows saved that way are still read: manage = every action.) Plus a **scope**: `all` teams, or `team` = only the teams the user is a member of on the Teams screen. Screens and checks live in `backend/src/services/access.js`.
- The server checks every admin request (`requirePermission(screen, level)` in `middleware/auth.js`). Hiding buttons in the app is only for convenience. Team scope is applied inside each route's SQL (`scopeCondition`, `campaignInScope`). Rows outside the scope answer 404, as if missing.
- Team scope covers campaign and agent data: dashboard, live agents, dialer, call log, campaigns, leads and lists, callbacks, reports, form responses, users and teams. Queues, DID numbers, forms and DNC are shared settings with no team, so only the screen level applies to them.
- A team-scoped role can't have the actions that reach outside its teams (`TEAM_SCOPE_BLOCKED`): create or delete campaigns, create / edit / reset users, create / edit / delete teams. Saving such a role is refused with the reason, and the Roles screen shows them locked; nothing is dropped silently.
- Only a Super Admin manages roles and admin-side accounts (Super Admins and staff). A role with Users rights handles agent accounts only, so nobody can raise their own rights.
- Lookup lists that screens need for dropdowns (`GET /admin/campaigns`, `lists`, `queues`, `forms`, `users`, `extensions`, `teams`, `roles`) are readable by any admin-side login. They are still scoped.
- Live updates (`/ws`) are filtered per staff connection by the same rules (`staffView` in `realtime/hub.js`). A team-scoped connection gets only a call id from `call.event`.
- Staff logins are admin-side only. Agent routes (calling, outcomes) refuse them (`requireCaller`).

**Consequences.**
- Every new admin route must pick a screen and level, and, if its data belongs to a campaign or agent, apply the scope. `backend/tests/access.test.js` shows the pattern.
- Rights apply on the user's next request: roles are cached and cleared on save.
- A user moved to another team gets the new scope at once for requests, and within 30 s for live updates.
