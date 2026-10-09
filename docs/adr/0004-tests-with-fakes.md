# 0004 — Tests: node:test with fakes; real calls stay manual

**Status:** Accepted (2026-10-09)

**Context.** Most bugs so far were in call logic (double redial, transfer edge cases). Testing them by placing calls is slow and costs trunk minutes.

**Decision.** Backend logic is tested with Node's built-in `node:test`, plus fake `ari` / `ami` / `pool` objects passed through each module's `init()` (see `backend/tests/call-control.test.js`). There are no extra dependencies. The UI uses Vitest + React Testing Library; browser smoke tests use Playwright against a test server. Anything involving a real phone stays on the manual checklist (`docs/PREDICTIVE_DIALER_TEST_CHECKLIST.md`).

**Consequences.** Modules should take their dependencies through `init()` or function parameters, not `require` them at the top, so tests can pass fakes.
