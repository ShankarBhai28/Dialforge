import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { fakeApi, renderPage } from '@/test/render';
import { LicenceBanner } from './LicenceBanner';
import { LicenceCard } from './LicenceCard';

const LIC = {
  state: 'ok',
  customer: 'Acme',
  seats: 10,
  seatsUsed: 8,
  extensions: 11,
  channels: 15,
  channelsInUse: 3,
  expires: '2026-12-31',
  daysLeft: 78,
};

describe('Licence', () => {
  it('card: seats and lines used of the licensed number, the end date', async () => {
    fakeApi({ 'GET /admin/licence': { body: LIC } });
    renderPage(<LicenceCard />);
    expect(await screen.findByText('8 / 10')).toBeInTheDocument();
    expect(screen.getByText('3 / 15')).toBeInTheDocument();
    expect(screen.getByText(/11 extensions/)).toBeInTheDocument();
    expect(screen.getByText('31 Dec 2026')).toBeInTheDocument();
    expect(screen.getByText('78 days left')).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('no banner while the licence is fine; a warning before the end; a red notice after', async () => {
    fakeApi({ 'GET /admin/licence': { body: LIC } });
    const { unmount } = renderPage(<LicenceBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    fakeApi({ 'GET /admin/licence': { body: { ...LIC, state: 'expiring', daysLeft: 5 } } });
    const second = renderPage(<LicenceBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/ends in 5 days \(31 Dec 2026\)/);
    second.unmount();

    fakeApi({ 'GET /admin/licence': { body: { ...LIC, state: 'expired', daysLeft: -1 } } });
    renderPage(<LicenceBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/ended on 31 Dec 2026.*can't log in/);
  });

  it("licence set but unreadable on the server: the card says so (it isn't hidden)", async () => {
    fakeApi({ 'GET /admin/licence': { body: { ...LIC, state: 'invalid', seats: null, channels: null } } });
    renderPage(<LicenceCard />);
    expect(await screen.findByText(/could not be read on the server/)).toBeInTheDocument();
  });

  it('no licence set (a dev server): nothing shown', async () => {
    fakeApi({ 'GET /admin/licence': { body: { ...LIC, state: 'none', seats: null, channels: null, expires: null } } });
    const { container } = renderPage(<LicenceCard />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
