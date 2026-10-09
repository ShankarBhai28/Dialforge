// What the logged-in user may do on the admin side, from /auth/me.
// The server checks every request anyway; this only decides what to show.
//
// Super Admin: everything. Staff (TL, supervisor, ...): their role's level
// per screen - none (hidden), view (read only), manage (also change).
import { useMe, type User } from './auth';

export type Screen =
  | 'dashboard'
  | 'live'
  | 'dialer'
  | 'calls'
  | 'campaigns'
  | 'leads'
  | 'forms'
  | 'callbacks'
  | 'dnc'
  | 'queues'
  | 'numbers'
  | 'users'
  | 'teams'
  | 'reports';
/** 'roles' is the Roles screen: Super Admin only, never part of a role. */
export type NavScreen = Screen | 'roles';
export type Level = 'none' | 'view' | 'manage';

const RANK: Record<Level, number> = { none: 0, view: 1, manage: 2 };

export function levelFor(user: User | null | undefined, screen: NavScreen): Level {
  if (!user) return 'none';
  if (user.role === 'admin') return 'manage';
  if (user.role !== 'staff' || screen === 'roles') return 'none';
  return user.permissions?.[screen] ?? 'none';
}

export function access(user: User | null | undefined) {
  const at = (screen: NavScreen, level: Level) => RANK[levelFor(user, screen)] >= RANK[level];
  return {
    isSuperAdmin: user?.role === 'admin',
    /** Team-scoped role: sees only its teams' data, and can't create things outside them. */
    teamScope: user?.scope === 'team',
    canView: (screen: NavScreen) => at(screen, 'view'),
    canManage: (screen: NavScreen) => at(screen, 'manage'),
  };
}

export function useAccess() {
  const { data: user } = useMe();
  return access(user);
}

export const useCanManage = (screen: NavScreen) => useAccess().canManage(screen);
