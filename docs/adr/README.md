# Architecture Decision Records

One short file per significant decision: what we chose, why, and what it costs us.
Add a new file (next number) when you make a decision another developer would otherwise question or undo.
Never edit an accepted ADR's decision; write a new one that supersedes it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-asterisk-ari-plus-native-queue.md) | Asterisk control: ARI for calls we own, native Queue() + AMI for queueing | Accepted |
| [0002](0002-react-typescript-frontend.md) | Frontend: React + TypeScript + Vite, replacing the HTML pages | Accepted |
| [0003](0003-keep-express-mysql.md) | Backend: keep Node/Express + MySQL, restructure instead of rewrite | Accepted |
| [0004](0004-tests-with-fakes.md) | Tests: node:test with fake ARI/AMI/DB; real calls stay a manual checklist | Accepted |
