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
export type Extension = {
  id: number;
  name: string;
  label: string | null;
  /** Disabled = Asterisk doesn't know it any more (can't register). */
  enabled: boolean;
  has_password: boolean;
  /** Users who have it as their extension, e.g. "agent02, agent1002". */
  used_by: string | null;
  /** A browser or phone is connected right now; null = Asterisk didn't answer. */
  registered: boolean | null;
  created_at: string;
};

export type NewUser = {
  username: string;
  password: string;
  role: string;
  extensionId: number | null;
  roleId: number | null;
  /** The team the account joins (required for an own-teams login: one of its teams). */
  teamId: number | null;
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

/** POST /admin/users/import without commit: what the file would create (passwords never come back). */
export type UserImportCheck = {
  ready: number;
  problems: { rowNum: number; username: string; error: string }[];
};

function importForm(file: File, commit: boolean) {
  const form = new FormData();
  form.append('file', file);
  if (commit) form.append('commit', '1');
  return form;
}

/** Bulk import, step 1: check the file - nothing is saved. */
export function useCheckUserImport() {
  return useMutation({
    mutationFn: (file: File) => post<UserImportCheck>('/admin/users/import', importForm(file, false)),
    meta: { errorInline: true },
  });
}

/** Bulk import, step 2: create every account (only accepted when the whole file is clean). */
export function useImportUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => post<{ created: number }>('/admin/users/import', importForm(file, true)),
    meta: { errorInline: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userKeys.all });
      qc.invalidateQueries({ queryKey: ['admin', 'teams'] });
    },
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
