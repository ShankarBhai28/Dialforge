import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '@/lib/api';

// GET /admin/users never selects password_hash, so there is nothing to hide here.
export type User = {
  id: number;
  username: string;
  /** admin = Super Admin; staff = admin login limited by role_id. */
  role: 'agent' | 'admin' | 'staff' | string;
  /** inactive = can't log in (users are never deleted: calls and history point at them) */
  status: 'active' | 'inactive';
  created_at: string;
  extension_id: number | null;
  extension_name: string | null;
  role_id: number | null;
  role_name: string | null;
};

export type UserUpdate = {
  role: string;
  extensionId: number | null;
  roleId: number | null;
  status: 'active' | 'inactive';
};

/** "Super Admin", the admin login's role name, or "Agent". */
export const accountLabel = (u: Pick<User, 'role' | 'role_name'>) =>
  u.role === 'admin' ? 'Super Admin' : u.role === 'staff' ? (u.role_name ?? 'Admin') : 'Agent';

// GET /admin/extensions (the server deliberately leaves out sip_password).
export type Extension = { id: number; name: string; label: string | null };

export type NewUser = {
  username: string;
  password: string;
  role: string;
  extensionId: number | null;
  roleId: number | null;
};

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

/** Role / extension / active. Changing role or status ends that user's open sessions. */
export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UserUpdate & { id: number }) => put(`/admin/users/${id}`, body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  });
}

/** Admin sets a new password; the user is logged out everywhere. */
export function useResetPassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      post(`/admin/users/${id}/password`, { password }),
    meta: { errorInline: true },
  });
}
