import type { Disposition } from './api';

// The server's fallback set (backend/src/services/dispositions.js
// DEFAULT_DISPOSITIONS): used for leads without a campaign, and for labels
// in the leads table, which mixes campaigns.
export const DEFAULT_DISPOSITIONS: Disposition[] = [
  { code: 'interested', label: 'Interested' },
  { code: 'not_interested', label: 'Not Interested' },
  { code: 'callback', label: 'Callback' },
  { code: 'no_answer', label: 'No Answer' },
  { code: 'do_not_call', label: 'Do Not Call' },
];

const LABELS: Record<string, string> = {
  new: 'New',
  ...Object.fromEntries(DEFAULT_DISPOSITIONS.map((d) => [d.code, d.label])),
};

/** "no_answer" -> "No Answer"; a campaign's own codes fall back to the raw code. */
export const statusLabel = (code: string) => LABELS[code] ?? code;

// Ticked by default in the Recycle dialog: calls that never reached anyone,
// leads never dialed, and callbacks. Final agent outcomes stay unticked.
export const RECYCLE_DEFAULT_TICK = ['new', 'no_answer', 'busy', 'machine', 'network_error', 'abandoned', 'callback'];
