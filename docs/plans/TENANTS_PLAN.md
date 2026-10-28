# Tenants: many customers on one VIZTEX (the Cloud edition)

One web address for every customer (`app.viztex.in`), a **company code** at login, and each
customer's data in **its own database**. The app and telephony servers are shared. Decided in
Oct 2026 (RUNBOOK: Phase 2 discussions): only the platform owner creates customers; most customers
use our SIP; one URL worldwide, no subdomains.

```
 browser ── https://app.viztex.in ── login: company code + username + password
                 │
            app server ── viztex_platform (customers, logins)
                 │
                 ├── viztex_t_acme      (one database per customer, same tables as today)
                 ├── viztex_t_globex
                 └── ...
            telephony server(s): extensions and queues named per customer (part 3)
```

Single-customer installs (Starter, Business) stay exactly as they are: everything below is
switched on only by `MULTI_TENANT=1`.

## The parts

| Part | What | Status |
|---|---|---|
| 1 | Tenant registry, company-code login, every web request on its customer's database | done (branch tenant-part1) |
| 2 | Background jobs per customer (stale agents, auto-dispositions, presence, dialer feed); the dialer engine loops over customers | done (same branch) |
| 3 | Telephony per customer: extension / queue / context prefixes in Asterisk, recordings per customer | |
| 4 | Calls back to the right customer: ARI / AMI events routed by prefix | |
| 5 | Per-customer limits: seats, channels (Asterisk `GROUP()`), caller IDs; minutes metered | |
| 6 | Platform admin: create / suspend customers, plans, usage, wallet; multi-tenant load test | |

## Part 1 in detail

**Platform database** (`PLATFORM_DB_NAME`, default `viztex_platform`; its own migrations in
`backend/migrations-platform/`):
- `tenants`: `code` (what people type at login, `a-z 0-9 -`, 2-30), `name`, `db_name`, `status`
  (`active` / `suspended`).
- `sessions`: the login sessions of every customer (a session must be readable before we know
  whose it is), with `tenant_code`.

**Which database a request uses.** `db.js` stays the one module every query goes through, but
it now hands each query to the pool of the **current tenant** (Node's AsyncLocalStorage, set per
request). No query in the 60 route / service files changes. Outside a request (timers, the
dialer engine, telephony events) the current tenant is the **home tenant**: the database in
`DB_NAME`, which is also registered as a tenant. Parts 2-4 move those onto every customer.

**Login.** `POST /auth/login` takes `company` too; an unknown or suspended company gets the same
answer as a wrong password. The session remembers the company; every later request runs on that
customer's database. A suspended customer's sessions stop at their next request.
`GET /auth/config` tells the login page whether to show the company field.

**Things kept in memory, keyed by customer** (user ids repeat across databases): live
connections (realtime hub), revoked sessions, the role cache, failed-login counters, lead-import
reports.

**Creating a customer** (on the app server):
```
npm run tenant -- create --code acme --name "Acme Collections" --admin boss
npm run tenant -- list
npm run tenant -- suspend --code acme      # and: resume
npm run db:migrate -- --platform           # the platform database
npm run db:migrate -- --tenant acme        # one customer;  --all-tenants: every one
```
`create` makes the database `viztex_t_acme`, applies every migration, adds the Super Admin (the
one-time password is printed once) and registers the customer. The app's MySQL user needs
rights on `viztex_t_%` databases and the platform database (see RUNBOOK).

**Not yet in part 1:** timers and the dialer engine (part 2); telephony and recordings (parts
3-4) work for the home tenant only; the licence (seats, channels) is shared by all customers
(part 5).

## Part 2 in detail

`forEachTenant(fn)` (services/tenants.js) runs a job once per **active** company, as that
company, a few at a time (`TENANT_JOB_PARALLEL`, default 4); a failing company is logged and
skipped. The list is re-read once a minute, so a new company starts working within a minute. The
home database runs too, even before `register-home`. Single install: the job runs once, as before.

Per company now: stale-agent cleanup, auto-dispositions, the live_agents refresh (its own pending
refresh and running mark), the Dialer screen feed, and both dialer-engine loops (hopper / status
tick every 5 s, pacing every 1 s). The system health watch stays one per server (it checks the
server, Asterisk and services, not a company).

Dialer calls: the channel id is `dfd-<company>-<attempt id>` and the Stasis arguments end with
the company (single install: unchanged `dfd-<attempt id>`), so the engine handles each call's
events as its company; the answered call also gets the channel variable `DIALER_TENANT` for the
backend's queue events (part 4).

**Still home-only after part 2:** Asterisk itself - extension, queue and context names are shared
by all companies until part 3, and the backend's AMI / ARI call events until part 4. So a second
company can be created and used for everything except real calls.
