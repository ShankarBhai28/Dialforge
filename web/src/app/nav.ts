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
  type LucideIcon,
} from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon };
export type NavGroup = { key: string; label: string; icon: LucideIcon; items: NavItem[] };
export type NavEntry = NavItem | NavGroup;

export const isGroup = (e: NavEntry): e is NavGroup => 'items' in e;

export const ADMIN_NAV: NavEntry[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  {
    key: 'monitor',
    label: 'Monitoring',
    icon: Activity,
    items: [
      { to: '/admin/live', label: 'Live Agents', icon: Gauge },
      { to: '/admin/dialer', label: 'Dialer', icon: PhoneForwarded },
      { to: '/admin/calls', label: 'Call Log', icon: ScrollText },
    ],
  },
  {
    key: 'campaign',
    label: 'Campaign Management',
    icon: Megaphone,
    items: [
      { to: '/admin/campaigns', label: 'Campaigns', icon: Megaphone },
      { to: '/admin/leads', label: 'Leads & Lists', icon: BookUser },
      { to: '/admin/forms', label: 'Forms', icon: ListChecks },
      { to: '/admin/callbacks', label: 'Callbacks', icon: CalendarClock },
      { to: '/admin/dnc', label: 'DNC List', icon: PhoneOff },
    ],
  },
  {
    key: 'telephony',
    label: 'Telephony',
    icon: Smartphone,
    items: [
      { to: '/admin/queues', label: 'Queues', icon: PhoneCall },
      { to: '/admin/numbers', label: 'DID Numbers', icon: Hash },
    ],
  },
  {
    key: 'people',
    label: 'Users & Teams',
    icon: UsersRound,
    items: [
      { to: '/admin/users', label: 'Users', icon: Users },
      { to: '/admin/teams', label: 'Teams', icon: UsersRound },
    ],
  },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
];

export const allNavItems = (): NavItem[] => ADMIN_NAV.flatMap((e) => (isGroup(e) ? e.items : [e]));
