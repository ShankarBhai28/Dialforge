import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { ERROR_TOAST } from '@/lib/toast';
import { meKey, noteSessionEnded } from '@/features/auth/auth';
import { stopRealtime, subscribe } from '@/lib/realtime';
import { routes } from '@/app/routes';
import './index.css';

// A 401 anywhere means the login expired: forget the user, which sends
// every protected screen back to the login page.
function onError(err: Error) {
  if (err instanceof ApiError && err.status === 401) {
    stopRealtime(); // the session is gone; don't keep reconnecting /ws
    queryClient.setQueryData(meKey, null);
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      onError(err);
      // A failed change shows as a toast, unless its form shows the error
      // itself (useMutation({ meta: { errorInline: true } })).
      if (mutation.meta?.errorInline) return;
      if (!(err instanceof ApiError && err.status === 401)) toast.error(err.message, ERROR_TOAST);
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

// The server ended this login (the agent logged in somewhere else): leave
// at once - the agent screen unmounts and disconnects its phone line.
subscribe('session.ended', (msg) => {
  noteSessionEnded((msg.data as { reason?: string } | null)?.reason ?? '');
  stopRealtime();
  queryClient.setQueryData(meKey, null);
});

const router = createBrowserRouter(routes, { basename: '/app' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {/* "Saved" notices go after 2 s; errors stay longer (ERROR_TOAST) so they can be read. */}
      <Toaster richColors position="top-right" duration={2000} />
    </QueryClientProvider>
  </StrictMode>,
);
