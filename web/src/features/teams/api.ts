import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';

// GET /admin/teams: teams.* plus member, campaign and extension id+name lists.
export type Team = {
  id: number;
  name: string;
  status: 'active' | 'inactive' | string;
  created_at: string;
  members: { id: number; username: string }[];
  campaigns: { id: number; name: string }[];
  /** Extensions the members may connect with; empty = any extension. */
  extensions: { id: number; name: string }[];
};

export type TeamInput = {
  name: string;
  status: string;
  memberIds: number[];
  campaignIds: number[];
  extensionIds: number[];
};

export const teamKeys = { all: ['admin', 'teams'] as const };

export function useTeams() {
  return useQuery({ queryKey: teamKeys.all, queryFn: () => get<Team[]>('/admin/teams') });
}

/** Create or edit; both replace the full member/campaign/extension sets server-side. */
export function useSaveTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: TeamInput & { id?: number }) =>
      id ? put(`/admin/teams/${id}`, body) : post('/admin/teams', body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKeys.all }),
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/teams/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKeys.all }),
  });
}
