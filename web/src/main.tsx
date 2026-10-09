import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { meKey } from '@/features/auth/auth';
import { stopRealtime } from '@/lib/realtime';
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
      if (!(err instanceof ApiError && err.status === 401)) toast.error(err.message);
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createBrowserRouter(routes, { basename: '/app' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  </StrictMode>,
);
