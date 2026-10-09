// Admin sidebar: same groups as the classic admin page. `classic` is the
// section name in /admin.html, used until that screen moves to this app.
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
  type LucideIcon,
} from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; classic: string };
export type NavGroup = { key: string; label: string; icon: LucideIcon; items: NavItem[] };
export type NavEntry = NavItem | NavGroup;

export const isGroup = (e: NavEntry): e is NavGroup => 'items' in e;

export const ADMIN_NAV: NavEntry[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, classic: 'dashboard' },
  {
    key: 'monitor',
    label: 'Monitoring',
    icon: Activity,
    items: [
      { to: '/admin/live', label: 'Live Agents', icon: Gauge, classic: 'live' },
      { to: '/admin/dialer', label: 'Dialer', icon: PhoneForwarded, classic: 'dialer' },
      { to: '/admin/calls', label: 'Call Log', icon: ScrollText, classic: 'calllog' },
    ],
  },
  {
    key: 'campaign',
    label: 'Campaign Management',
    icon: Megaphone,
    items: [
      { to: '/admin/campaigns', label: 'Campaigns', icon: Megaphone, classic: 'campaigns' },
      { to: '/admin/leads', label: 'Leads & Lists', icon: BookUser, classic: 'leads' },
      { to: '/admin/forms', label: 'Forms', icon: ListChecks, classic: 'forms' },
      { to: '/admin/callbacks', label: 'Callbacks', icon: CalendarClock, classic: 'callbacks' },
      { to: '/admin/dnc', label: 'DNC List', icon: PhoneOff, classic: 'dnc' },
    ],
  },
  {
    key: 'telephony',
    label: 'Telephony',
    icon: Smartphone,
    items: [
      { to: '/admin/queues', label: 'Queues', icon: PhoneCall, classic: 'queues' },
      { to: '/admin/numbers', label: 'DID Numbers', icon: Hash, classic: 'numbers' },
    ],
  },
  {
    key: 'people',
    label: 'Users & Teams',
    icon: UsersRound,
    items: [
      { to: '/admin/users', label: 'Users', icon: Users, classic: 'users' },
      { to: '/admin/teams', label: 'Teams', icon: UsersRound, classic: 'teams' },
    ],
  },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, classic: 'reports' },
];

export const allNavItems = (): NavItem[] => ADMIN_NAV.flatMap((e) => (isGroup(e) ? e.items : [e]));
