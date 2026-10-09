# DialForge — Frontend guide (web/)

The React app lives in `web/` and is served by the backend at **`/app`**. The classic pages (`/admin.html`, `/agent.html`) keep working until each screen is rebuilt; see `docs/APP_REBUILD_PLAN.md` for the order.

Stack: React 19, TypeScript, Vite, Tailwind CSS 4, shadcn-style components, React Router 7, TanStack Query 5, Vitest + Testing Library. The reasons are in `docs/adr/0002`.

## Run it

```
npm --prefix web install
npm run dev:web            # http://localhost:5173/app  - API calls go to the dev server
npm --prefix web test      # or: npm --prefix web run test:watch
npm run build:web          # builds into backend/web-dist (what the server serves)
```
`npm run dev:web` proxies API calls (`/auth`, `/admin`, `/agent`, `/leads`, `/calls`, `/queues`, `/ws`) to `https://dialforge.ddnsfree.com:3000`. Log in with your normal test account. To use another backend: `DIALFORGE_API=https://other-host:3000 npm run dev:web`.

## Folder layout

```
web/src/
  main.tsx                 app start: query client (401 -> back to login), router, toasts
  index.css                theme: colours by role (primary, muted, status-*...), font
  app/                     routes.tsx, AdminLayout, Sidebar, nav.ts (admin menu)
  components/ui/           Button, Input, Label, Card, Badge, Skeleton - shared building blocks
  components/              FullPageSpinner, ErrorState
  features/<area>/         one folder per screen area: api.ts (types + query hooks), pages, components, tests
  lib/api.ts               fetch wrapper: get/post/put/del, ApiError with the server's message
  lib/realtime.ts          /ws live updates: useRealtime(type, handler)
  lib/hooks.ts             small shared hooks (useNow)
  lib/format.ts            date/time display + <input> value helpers
  components/common.tsx    SectionHeader, EmptyState, Field, FormError, ConfirmDialog, StatusPill
  test/                    setup + helpers (fakeApi, renderAt)
```

## Agent screen (features/agent)
- `softphone/softphone.ts`: the phone line (JsSIP behind a small interface; `softphone/jssip.ts` is the real SIP stack, `softphone/fakes.ts` the test double). It knows nothing about leads.
- `controller.ts`: the call workflow. It decides what each ring means: our own click-to-call leg, a dialer/queue call, or a colleague's transfer. It also handles screen pop, the outcome dialog, auto-Available after wrap-up, and preview leads. It is plain TypeScript, so `controller.test.ts` drives it with the fake line.
- Components read both through `useController()` / `usePhone()` (`AgentProvider.tsx`).
- Never call JsSIP from a component. Add a method to the softphone or the controller, plus a test.

## How to move a classic screen into the app (the Stage 3 recipe)

1. **Types + data hooks**: `features/<area>/api.ts`. Define the response types to match exactly what the backend returns, then one `useQuery` hook per GET and one `useMutation` per change. Copy the pattern in `features/dashboard/api.ts`.
2. **Page**: `features/<area>/<Area>Page.tsx`. Use `Card`, `Button` and the other components in `components/ui`. Handle all three states: loading (`Skeleton`), error (`ErrorState` with retry), and empty ("No campaigns yet").
3. **Route**: add it to `REBUILT` in `app/routes.tsx`, using the same path as its entry in `app/nav.ts`. The classic placeholder disappears for that screen.
4. **After a change**, call `queryClient.invalidateQueries({ queryKey })` so lists refresh, and show `toast.success('Saved')`. Errors from mutations become toasts automatically.
5. **Live data**: `useRealtime('agent.status', () => invalidate…)`. If the backend doesn't publish what you need, add a `hub.publish(...)` server-side (ARCHITECTURE §8).
6. **Test**: `features/<area>/<area>.test.tsx` with `fakeApi({ 'GET /admin/...': { body } })` and `renderAt('/admin/...')`. At minimum: it shows the data, it saves, and it shows the server's error message.
7. **Compare** the new screen with the classic one using the same data before calling it done.

## Rules
- Call the backend only through `lib/api.ts`, never `fetch` directly. That keeps errors and the 401-to-login handling in one place. File uploads: `post(path, formData)`.
- A mutation whose form or dialog shows the error itself sets `meta: { errorInline: true }`; otherwise its error also appears as a toast.
- Server data lives in TanStack Query, not in `useState` copies. Local `useState` is for UI state only (open/closed, form inputs).
- Colours come from the theme (`bg-primary`, `text-muted-foreground`, `bg-status-available`), never hex values in components.
- Every screen must work at phone width (the sidebar becomes a drawer).
- Permissions are enforced by the server. The UI hides what a role can't use, but never relies on that for security.
- Lint: the React hooks rules are on. If one complains, fix the code; don't disable the rule.
