import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';

// GET /admin/teams: teams.* plus member and campaign id+name lists.
export type Team = {
  id: number;
  name: string;
  status: 'active' | 'inactive' | string;
  /** The team this one sits under (null = top level). Logins in a team see every team below it. */
  parent_id: number | null;
  created_at: string;
  /** Agents and admin logins (TL, supervisor) - a team-scoped role sees its teams' data. */
  members: { id: number; username: string; role: string }[];
  campaigns: { id: number; name: string }[];
};

export type TeamInput = {
  name: string;
  status: string;
  parentId: number | null;
  memberIds: number[];
  campaignIds: number[];
};

/**
 * Teams in tree order (each parent followed by its sub-teams, by name) with
 * their level (0 = top). A team whose parent isn't in the list (an own-teams
 * login sees only part of the tree) starts at the top.
 */
export function teamTree(teams: Team[]): { team: Team; level: number }[] {
  const ids = new Set(teams.map((t) => t.id));
  const kids = new Map<number | null, Team[]>();
  for (const t of teams) {
    const parent = t.parent_id != null && ids.has(t.parent_id) ? t.parent_id : null;
    kids.set(parent, [...(kids.get(parent) ?? []), t]);
  }
  const out: { team: Team; level: number }[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, level: number) => {
    for (const t of [...(kids.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ team: t, level });
      walk(t.id, level + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A team and every team below it (ids) - a team can't go under any of these. */
export function teamAndBelow(teams: Team[], id: number): Set<number> {
  const out = new Set<number>([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of teams)
      if (t.parent_id != null && out.has(t.parent_id) && !out.has(t.id)) {
        out.add(t.id);
        grew = true;
      }
  }
  return out;
}

export const teamKeys = { all: ['admin', 'teams'] as const };

export function useTeams() {
  return useQuery({ queryKey: teamKeys.all, queryFn: () => get<Team[]>('/admin/teams') });
}

/** Create or edit; both replace the full member/campaign sets server-side. */
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
