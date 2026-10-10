import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';
import type { Action, Screen } from '@/features/auth/access';

export type RoleScope = 'all' | 'team';
export type Permissions = Partial<Record<Screen, Action[]>>;

// GET /admin/roles: the screens with the actions each one has (from the
// server, so this list never drifts from what it checks), the actions an
// own-teams role can't have, and the roles with how many users have them.
export type AdminRole = {
  id: number;
  name: string;
  scope: RoleScope;
  permissions: Permissions;
  userCount: number;
};
export type RoleScreen = { key: Screen; label: string; actions: Action[] };
export type RolesResponse = {
  screens: RoleScreen[];
  actionLabels: Record<Action, string>;
  teamScopeBlocked: Partial<Record<Screen, Action[]>>;
  roles: AdminRole[];
};

export type RoleInput = { name: string; scope: RoleScope; permissions: Permissions };

export const roleKeys = { all: ['admin', 'roles'] as const };

export function useRoles() {
  return useQuery({ queryKey: roleKeys.all, queryFn: () => get<RolesResponse>('/admin/roles') });
}

export function useSaveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RoleInput & { id?: number }) =>
      id ? put(`/admin/roles/${id}`, body) : post('/admin/roles', body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/roles/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  });
}
