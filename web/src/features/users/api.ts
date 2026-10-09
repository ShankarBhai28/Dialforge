import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';

// GET /admin/users never selects password_hash, so there is nothing to hide here.
export type User = {
  id: number;
  username: string;
  role: 'agent' | 'admin' | string;
  created_at: string;
  extension_name: string | null;
};

// GET /admin/extensions (the server deliberately leaves out sip_password).
export type Extension = { id: number; name: string; label: string | null };

export type NewUser = { username: string; password: string; role: string; extensionId: number | null };

export const userKeys = {
  all: ['admin', 'users'] as const,
  extensions: ['admin', 'extensions'] as const,
};

/** All accounts; Teams also uses this to list agents. */
export function useUsers() {
  return useQuery({ queryKey: userKeys.all, queryFn: () => get<User[]>('/admin/users') });
}

export function useExtensions() {
  return useQuery({ queryKey: userKeys.extensions, queryFn: () => get<Extension[]>('/admin/extensions') });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NewUser) => post<{ id: number; username: string; role: string }>('/admin/users', v),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  });
}
