import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';
import type { Level, Screen } from '@/features/auth/access';

export type RoleScope = 'all' | 'team';

// GET /admin/roles: the screens a role can cover (from the server, so this
// list never drifts from what it checks) and the roles with their users count.
export type AdminRole = {
  id: number;
  name: string;
  scope: RoleScope;
  permissions: Record<Screen, Level>;
  userCount: number;
};
export type RolesResponse = { screens: { key: Screen; label: string }[]; roles: AdminRole[] };

export type RoleInput = { name: string; scope: RoleScope; permissions: Partial<Record<Screen, Level>> };

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
