# 0002 — Frontend: React + TypeScript + Vite

**Status:** Accepted (2026-10-09)

**Context.** `admin.html` (2,600 lines) and `agent.html` (2,000 lines) mix layout, style and logic in single files with global state. Each feature made the next one riskier. More developers are joining.

**Decision.** A new app in `web/`: React + TypeScript + Vite, Tailwind + shadcn/ui, React Router, TanStack Query for server data, React Hook Form + Zod for forms, and a WebSocket for live updates. JsSIP is wrapped in one softphone module with an explicit call state machine. Express serves the built app at `/app` until it replaces the old pages (plan: `docs/APP_REBUILD_PLAN.md`).

**Why these.** They are the most common choices, so new developers already know them. Types catch wrong field names at build time. shadcn components are copied into our repo, so we can change them freely.

**Consequences.** There is now a build step (`npm run build`), and the old pages stay frozen (fixes only) until each screen moves.
