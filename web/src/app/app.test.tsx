import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN, AGENT, fakeApi, renderAt } from '@/test/render';
import { allNavItems } from './nav';

const DASHBOARD = {
  'GET /admin/dashboard': { body: { totalAgents: 4, availableNow: 2, callsToday: 31, avgHandleSeconds: 95 } },
  'GET /admin/live-agents': {
    body: [
      {
        id: 7,
        username: 'agent04',
        extension_name: '1003',
        status: 'available',
        reason: null,
        started_at: new Date().toISOString(),
        queue_name: 'Support Queue',
        active_call_number: null,
      },
    ],
  },
};

describe('login', () => {
  it('sends a logged-out visitor to the login page', async () => {
    fakeApi({ 'GET /auth/me': { status: 401, body: { error: 'not logged in' } } });
    const { router } = renderAt('/admin/campaigns');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Fadmin%2Fcampaigns');
  });

  it('shows the server message for a wrong password', async () => {
    fakeApi({
      'GET /auth/me': { status: 401 },
      'POST /auth/login': { status: 401, body: { error: 'invalid username or password' } },
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid username or password');
  });

  it('takes an admin to the dashboard with live numbers', async () => {
    const calls = fakeApi({
      'GET /auth/me': { status: 401 },
      'POST /auth/login': { body: { status: 'ok', user: ADMIN } },
      ...DASHBOARD,
    });
    const { router } = renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Username'), ' admin ');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('31')).toBeInTheDocument();
    expect(screen.getByText('1m 35s')).toBeInTheDocument();
    expect(await screen.findByText('agent04')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin');
    expect(calls.find((c) => c.key === 'POST /auth/login')?.body).toEqual({ username: 'admin', password: 'secret' });
  });

  it('keeps agents out of admin screens', async () => {
    fakeApi({ 'GET /auth/me': { body: AGENT } });
    const { router } = renderAt('/admin/users');
    expect(await screen.findByRole('heading', { name: /connect your line/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/agent');
  });
});

describe('admin sidebar', () => {
  it('opens and closes a group, and opens the group of the current screen', async () => {
    fakeApi({ 'GET /auth/me': { body: ADMIN } });
    renderAt('/admin/queues');
    const nav = await screen.findByRole('navigation', { name: 'Admin', hidden: false });
    const scope = within(nav);

    // Telephony holds the current screen, so it starts open.
    expect(scope.getByRole('button', { name: /telephony/i })).toHaveAttribute('aria-expanded', 'true');
    expect(scope.getByRole('link', { name: 'Queues' })).toHaveClass('bg-white/15');

    const people = scope.getByRole('button', { name: /users & teams/i });
    expect(scope.queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
    await userEvent.click(people);
    expect(scope.getByRole('link', { name: 'Teams' })).toBeInTheDocument();
    await userEvent.click(people);
    expect(scope.queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
  });

  it('every menu entry opens a rebuilt screen, not the classic placeholder', async () => {
    fakeApi({ 'GET /auth/me': { body: ADMIN } });
    for (const item of allNavItems()) {
      const { unmount } = renderAt(item.to);
      await screen.findByRole('heading', { level: 1, name: item.label });
      expect(screen.queryByText(/moving here soon/i), item.to).not.toBeInTheDocument();
      unmount();
    }
  });

  it('logging out returns to the login page', async () => {
    let loggedIn = true;
    fakeApi({
      'GET /auth/me': () => (loggedIn ? { body: ADMIN } : { status: 401 }),
      'POST /auth/logout': () => {
        loggedIn = false;
        return { body: { status: 'ok' } };
      },
      ...DASHBOARD,
    });
    const { router } = renderAt('/admin');
    await userEvent.click(await screen.findByRole('button', { name: /log out/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/login');
  });
});
