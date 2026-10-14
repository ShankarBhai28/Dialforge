import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

/** The client's licence (read-only - only the provider changes it, on the server). */
export type Licence = {
  state: 'none' | 'invalid' | 'ok' | 'expiring' | 'expired';
  customer: string | null;
  seats: number | null;
  seatsUsed: number; // agents logged in now
  extensions: number;
  channels: number | null;
  channelsInUse: number | null;
  expires: string | null;
  daysLeft: number | null;
};

export function useLicence() {
  return useQuery({
    queryKey: ['admin', 'licence'] as const,
    queryFn: () => get<Licence>('/admin/licence'),
    refetchInterval: 60_000,
  });
}

/** "31 Dec 2026" from "2026-12-31" (no time zone shift). */
export function formatDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
