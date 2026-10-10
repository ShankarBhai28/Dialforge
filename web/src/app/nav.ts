// Admin sidebar: screens grouped by area; each group opens and closes.
import {
  Activity,
  BarChart3,
  BookUser,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
  ScrollText,
  Smartphone,
  Users,
  UsersRound,
  CalendarClock,
  Hash,
  History,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import type { NavScreen } from '@/features/auth/access';

/** `screen`: the permission that shows it (a role's level for that screen). */
export type NavItem = { to: string; label: string; icon: LucideIcon; screen: NavScreen };
export type NavGroup = { key: string; label: string; icon: LucideIcon; items: NavItem[] };
export type NavEntry = NavItem | NavGroup;

export const isGroup = (e: NavEntry): e is NavGroup => 'items' in e;

export const ADMIN_NAV: NavEntry[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, screen: 'dashboard' },
  {
    key: 'monitor',
    label: 'Monitoring',
    icon: Activity,
    items: [
      { to: '/admin/live', label: 'Live Agents', icon: Gauge, screen: 'live' },
      { to: '/admin/dialer', label: 'Dialer', icon: PhoneForwarded, screen: 'dialer' },
      { to: '/admin/calls', label: 'Call Log', icon: ScrollText, screen: 'calls' },
    ],
  },
  {
    key: 'campaign',
    label: 'Campaign Management',
    icon: Megaphone,
    items: [
      { to: '/admin/campaigns', label: 'Campaigns', icon: Megaphone, screen: 'campaigns' },
      { to: '/admin/leads', label: 'Leads & Lists', icon: BookUser, screen: 'leads' },
      { to: '/admin/forms', label: 'Forms', icon: ListChecks, screen: 'forms' },
      { to: '/admin/callbacks', label: 'Callbacks', icon: CalendarClock, screen: 'callbacks' },
      { to: '/admin/dnc', label: 'DNC List', icon: PhoneOff, screen: 'dnc' },
    ],
  },
  {
    key: 'telephony',
    label: 'Telephony',
    icon: Smartphone,
    items: [
      { to: '/admin/queues', label: 'Queues', icon: PhoneCall, screen: 'queues' },
      { to: '/admin/numbers', label: 'DID Numbers', icon: Hash, screen: 'numbers' },
    ],
  },
  {
    key: 'people',
    label: 'Users & Teams',
    icon: UsersRound,
    items: [
      { to: '/admin/users', label: 'Users', icon: Users, screen: 'users' },
      { to: '/admin/teams', label: 'Teams', icon: UsersRound, screen: 'teams' },
      { to: '/admin/roles', label: 'Roles', icon: ShieldCheck, screen: 'roles' },
    ],
  },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, screen: 'reports' },
  { to: '/admin/audit', label: 'Audit Log', icon: History, screen: 'audit' },
];

export const allNavItems = (): NavItem[] => ADMIN_NAV.flatMap((e) => (isGroup(e) ? e.items : [e]));

/** The menu limited to what `canView` allows; groups left empty disappear. */
export function visibleNav(canView: (screen: NavScreen) => boolean): NavEntry[] {
  return ADMIN_NAV.flatMap((e): NavEntry[] => {
    if (!isGroup(e)) return canView(e.screen) ? [e] : [];
    const items = e.items.filter((i) => canView(i.screen));
    return items.length ? [{ ...e, items }] : [];
  });
}
