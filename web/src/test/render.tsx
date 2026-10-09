// Test helpers: render the real routes at a URL with a fresh query cache,
// and fake the backend with a small table of path -> response.
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { routes } from '@/app/routes';

type Reply = { status?: number; body?: unknown };
export type FakeApi = Record<string, Reply | ((init?: RequestInit) => Reply)>;

/**
 * Replaces fetch: "GET /auth/me" -> reply. Unknown paths answer 404. Returns the call log.
 * Without its own "GET /auth/me" the user is a Super Admin (every screen and action).
 */
export function fakeApi(given: FakeApi) {
  const table: FakeApi = { 'GET /auth/me': { body: ADMIN }, ...given };
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${path}`;
      const body = init?.body;
      calls.push({ key, body: body instanceof FormData ? body : body ? JSON.parse(String(body)) : undefined });
      const entry = table[key];
      const reply =
        typeof entry === 'function' ? entry(init) : (entry ?? { status: 404, body: { error: 'not found' } });
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  // No live updates in tests.
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  );
  return calls;
}

export function renderAt(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}

export const ADMIN = { id: 1, username: 'admin', role: 'admin', extensionId: null, extensionName: null };
export const AGENT = { id: 7, username: 'agent04', role: 'agent', extensionId: 3, extensionName: '1003' };

/** Renders one page component (no layout/auth) at `url`, matching `path` for params. */
export function renderPage(element: ReactElement, { path = '/', url = path }: { path?: string; url?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path, element }], { initialEntries: [url] });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
