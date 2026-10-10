// What the logged-in user may do on the admin side, from /auth/me.
// The server checks every request anyway; this only decides what to show.
//
// Super Admin: everything. Staff (TL, supervisor, ...): the actions their
// role ticks per screen - view, create, edit, delete and a few
// screen-specific ones (Dialer control, Leads import / recycle, ...).
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
  | 'reports'
  | 'audit';
/** 'roles' is the Roles screen: Super Admin only, never part of a role. */
export type NavScreen = Screen | 'roles';
export type Action =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'control'
  | 'import'
  | 'recycle'
  | 'cancel'
  | 'password'
  | 'export'
  | 'logout';

export function canDo(user: User | null | undefined, screen: NavScreen, action: Action) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'staff' || screen === 'roles') return false;
  return (user.permissions?.[screen] ?? []).includes(action);
}

export function access(user: User | null | undefined) {
  return {
    isSuperAdmin: user?.role === 'admin',
    /** Own-teams role: sees only its teams' data. */
    teamScope: user?.scope === 'team',
    /** Own-teams role that isn't in any team yet: sees no data at all. */
    inNoTeam: user?.scope === 'team' && user.teamCount === 0,
    can: (screen: NavScreen, action: Action) => canDo(user, screen, action),
    canView: (screen: NavScreen) => canDo(user, screen, 'view'),
  };
}

export function useAccess() {
  const { data: user } = useMe();
  return access(user);
}

/** \`can('edit')\` for one screen. */
export function useCan(screen: NavScreen) {
  const { can } = useAccess();
  return (action: Action) => can(screen, action);
}
