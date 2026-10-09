import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '@/lib/api';
import { stopRealtime } from '@/lib/realtime';

export type Role = 'admin' | 'agent';
export type User = {
  id: number;
  username: string;
  role: Role;
  extensionId: number | null;
  extensionName: string | null;
};

export const meKey = ['auth', 'me'] as const;

/** The logged-in user, or null when not logged in. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await get<User>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function homeFor(role: Role) {
  return role === 'admin' ? '/admin' : '/agent';
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { username: string; password: string }) => post<{ user: User }>('/auth/login', v),
    onSuccess: ({ user }) => qc.setQueryData(meKey, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/auth/logout'),
    onSettled: () => {
      stopRealtime();
      qc.setQueryData(meKey, null);
      // Drop every other cached screen's data so the next user starts clean.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== meKey[0] });
    },
  });
}
