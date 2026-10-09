# 0003 — Keep Node/Express + MySQL; restructure, don't rewrite

**Status:** Accepted (2026-10-09)

**Context.** The backend works on real calls (click-to-call, inbound queues, dialer, transfer). Its problem is shape (one 2,700-line `server.js`), not technology.

**Decision.** Keep Express and MySQL. Split routes into `backend/src/routes/*` and logic into `src/services/*` with no behaviour change, then move modules to TypeScript one at a time. NestJS, Postgres, or a rewrite in another language were considered and rejected: high risk, no user-visible gain.

**Consequences.** We keep plain JavaScript for a while. Tests and the lint rules have to carry the safety until TypeScript arrives.
