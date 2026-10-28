import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '@/lib/api';
import { stopRealtime } from '@/lib/realtime';
import { disconnectMonitorLine } from '@/features/monitor/monitorLine';

/** admin = Super Admin; staff = admin login limited by a role (TL, supervisor, ...). */
export type Role = 'admin' | 'staff' | 'agent';
export type User = {
  id: number;
  username: string;
  role: Role;
  extensionId: number | null;
  extensionName: string | null;
  /** Admin-side logins only: 'Super Admin' or the staff role's name. */
  roleName?: string;
  /** 'team' = only the data of the teams they belong to. */
  scope?: 'all' | 'team';
  /** Staff: the actions ticked per screen. Super Admin: null (everything). */
  permissions?: Record<string, string[]> | null;
  /** Own-teams role: how many teams they're in. */
  teamCount?: number | null;
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
    // Short, so a role change by the Super Admin shows on screen within ~30 s.
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    retry: false,
  });
}

/** Cloud edition: the login page also asks for the company code. */
export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => get<{ multiTenant: boolean }>('/auth/config'),
    staleTime: Infinity,
    retry: 1,
  });
}

export function homeFor(role: Role) {
  return role === 'agent' ? '/agent' : '/admin';
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    // takeOver: an agent logged in elsewhere logs in here instead (the other screen is closed).
    mutationFn: (v: { company?: string; username: string; password: string; takeOver?: boolean }) =>
      post<{ user: User }>('/auth/login', v),
    meta: { errorInline: true }, // the login page shows it
    onSuccess: ({ user }) => qc.setQueryData(meKey, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/auth/logout'),
    onSettled: () => {
      stopRealtime();
      disconnectMonitorLine();
      qc.setQueryData(meKey, null);
      // Drop every other cached screen's data so the next user starts clean.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== meKey[0] });
    },
  });
}

// --- "You were logged out because you logged in elsewhere" ---
const ENDED_KEY = 'df-session-ended';
const ENDED_TEXT: Record<string, string> = {
  elsewhere: 'You were logged out here because you logged in on another browser or computer.',
};

/** Remembers why the session ended, for the login page to show. */
export function noteSessionEnded(reason: string) {
  try {
    sessionStorage.setItem(ENDED_KEY, ENDED_TEXT[reason] ?? 'Your session was ended.');
  } catch {
    /* private mode */
  }
}

/** The notice, once (then forgotten). */
export function takeSessionEndedNotice(): string | null {
  try {
    const v = sessionStorage.getItem(ENDED_KEY);
    sessionStorage.removeItem(ENDED_KEY);
    return v;
  } catch {
    return null;
  }
}
