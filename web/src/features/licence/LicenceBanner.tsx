// Across the top of every admin screen when the subscription is ending or
// has ended - so it's renewed before agents are stopped.
import { formatDay, useLicence } from './api';

export function LicenceBanner() {
  const { data: l } = useLicence();
  if (!l || !l.expires || (l.state !== 'expiring' && l.state !== 'expired')) return null;
  const ended = l.state === 'expired';
  const left = l.daysLeft ?? 0;
  return (
    <div
      role="alert"
      className={
        ended
          ? 'mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm'
          : 'mb-4 rounded-md border border-status-break/40 bg-status-break/10 px-4 py-3 text-sm'
      }
    >
      {ended ? (
        <>
          <strong>Your VIZTEX subscription ended on {formatDay(l.expires)}.</strong> Agents can&apos;t log in or call
          and the dialer is stopped. Your data is safe - contact your VIZTEX provider to renew.
        </>
      ) : (
        <>
          <strong>
            Your VIZTEX subscription ends {left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`} (
            {formatDay(l.expires)}).
          </strong>{' '}
          Contact your VIZTEX provider to renew - after that date agents can&apos;t log in.
        </>
      )}
    </div>
  );
}
