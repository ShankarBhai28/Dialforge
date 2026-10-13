import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { fakeApi, renderPage } from '@/test/render';
import { DashboardPage } from './DashboardPage';

const HEALTH = {
  at: '2026-10-13T10:00:00Z',
  overall: 'fail',
  checks: [
    { key: 'db', label: 'Database', status: 'ok', detail: 'connected' },
    { key: 'backup', label: 'Nightly backup', status: 'warn', detail: 'none yet' },
    { key: 'svc:asterisk', label: 'Service asterisk', status: 'fail', detail: 'failed' },
  ],
};
const base = {
  'GET /admin/dashboard': { body: { totalAgents: 1, availableNow: 0, callsToday: 0, avgHandleSeconds: 0 } },
  'GET /admin/live-agents': { body: [] },
};

describe('System health card', () => {
  it('Super Admin: shows every check, problems first', async () => {
    fakeApi({ ...base, 'GET /admin/system/health': { body: HEALTH } });
    renderPage(<DashboardPage />);
    const list = await screen.findByRole('list', { name: 'Health checks' });
    const items = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items[0]).toContain('Service asterisk');
    expect(items[1]).toContain('none yet');
    expect(items[2]).toContain('Database');
    expect(screen.getByText(/Something is not working/)).toBeInTheDocument();
  });

  it('not shown to other admin logins', async () => {
    fakeApi({
      ...base,
      'GET /auth/me': {
        body: { id: 30, username: 'sup', role: 'staff', scope: 'all', permissions: { dashboard: ['view'] } },
      },
    });
    renderPage(<DashboardPage />);
    await screen.findByText('Agents');
    expect(screen.queryByText('System health')).not.toBeInTheDocument();
  });
});
