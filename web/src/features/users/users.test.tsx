import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { UsersPage } from './UsersPage';

const USERS = {
  body: [
    {
      id: 1,
      username: 'admin',
      role: 'admin',
      status: 'active',
      created_at: '2026-09-01T10:00:00Z',
      extension_id: null,
      extension_name: null,
    },
    {
      id: 7,
      username: 'agent04',
      role: 'agent',
      status: 'active',
      created_at: '2026-09-02T10:00:00Z',
      extension_id: 3,
      extension_name: '1003',
    },
    {
      id: 8,
      username: 'leaver',
      role: 'agent',
      status: 'inactive',
      created_at: '2026-09-03T10:00:00Z',
      extension_id: 2,
      extension_name: '1002',
    },
  ],
};
const EXTENSIONS = {
  body: [
    { id: 2, name: '1002', label: 'Desk 2', sip_password: 'secret-1' },
    { id: 3, name: '1003', label: null, sip_password: 'secret-2' },
  ],
};

describe('Users', () => {
  it('lists users with role and extension', async () => {
    fakeApi({ 'GET /admin/users': USERS });
    renderPage(<UsersPage />);
    const row = (await screen.findByText('agent04')).closest('tr')!;
    expect(within(row).getByText('Agent')).toBeInTheDocument();
    expect(within(row).getByText('1003')).toBeInTheDocument();
  });

  it('creates an agent linked to an extension, never showing SIP passwords', async () => {
    const calls = fakeApi({
      'GET /admin/users': USERS,
      'GET /admin/extensions': EXTENSIONS,
      'POST /admin/users': { status: 201, body: { id: 9, username: 'agent09', role: 'agent' } },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create user/i }));
    await userEvent.type(screen.getByLabelText('Username'), ' agent09 ');
    await userEvent.type(screen.getByLabelText('Password'), 'pw123456');
    await screen.findByRole('option', { name: '1002 (Desk 2)' });
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Extension'), '1003');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toEqual({
      username: 'agent09',
      password: 'pw123456',
      role: 'agent',
      extensionId: 3,
      roleId: null,
    });
  });

  it('creates a Super Admin without an extension', async () => {
    const calls = fakeApi({
      'GET /admin/users': USERS,
      'GET /admin/extensions': EXTENSIONS,
      'POST /admin/users': { status: 201, body: {} },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create user/i }));
    await userEvent.type(screen.getByLabelText('Username'), 'boss');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.selectOptions(screen.getByLabelText('Account type'), 'admin');
    expect(screen.queryByLabelText('Extension')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toEqual({
      username: 'boss',
      password: 'pw',
      role: 'admin',
      extensionId: null,
      roleId: null,
    });
  });

  it('creates an admin login with a role (TL / supervisor)', async () => {
    const calls = fakeApi({
      'GET /admin/users': USERS,
      'GET /admin/extensions': EXTENSIONS,
      'GET /admin/roles': {
        body: {
          screens: [],
          roles: [
            { id: 4, name: 'Supervisor', scope: 'all', permissions: {}, userCount: 0 },
            { id: 5, name: 'Team Leader', scope: 'team', permissions: {}, userCount: 0 },
          ],
        },
      },
      'POST /admin/users': { status: 201, body: {} },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create user/i }));
    await userEvent.type(screen.getByLabelText('Username'), 'tl.ravi');
    await userEvent.type(screen.getByLabelText('Password'), 'pw123456');
    await userEvent.selectOptions(screen.getByLabelText('Account type'), 'staff');
    await screen.findByRole('option', { name: 'Team Leader (own teams)' });
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'Team Leader (own teams)');
    expect(screen.queryByLabelText('Extension')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toEqual({
      username: 'tl.ravi',
      password: 'pw123456',
      role: 'staff',
      extensionId: null,
      roleId: 5,
    });
  });

  it('a role with Users: manage handles agent accounts only; view-only changes nothing', async () => {
    const staff = (permissions: Record<string, string>) => ({
      body: { id: 30, username: 'sup', role: 'staff', roleName: 'Supervisor', scope: 'all', permissions },
    });
    fakeApi({ 'GET /auth/me': staff({ users: 'manage' }), 'GET /admin/users': USERS });
    const { unmount } = renderPage(<UsersPage />);
    await screen.findByRole('button', { name: 'Edit agent04' });
    expect(screen.queryByRole('button', { name: 'Edit admin' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    expect(screen.queryByLabelText('Account type')).not.toBeInTheDocument(); // agents only
    unmount();

    fakeApi({ 'GET /auth/me': staff({ users: 'view' }), 'GET /admin/users': USERS });
    renderPage(<UsersPage />);
    await screen.findByText('agent04');
    expect(screen.queryByRole('button', { name: /create user/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit agent04' })).not.toBeInTheDocument();
  });

  it("shows the server's reason when create fails", async () => {
    fakeApi({
      'GET /admin/users': USERS,
      'GET /admin/extensions': EXTENSIONS,
      'POST /admin/users': { status: 409, body: { error: 'that username is already taken' } },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create user/i }));
    await userEvent.type(screen.getByLabelText('Username'), 'agent04');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await screen.findByRole('option', { name: '1002 (Desk 2)' });
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'that username is already taken',
    );
  });

  it('shows a load error with retry', async () => {
    fakeApi({ 'GET /admin/users': { status: 500, body: { error: 'db down' } } });
    renderPage(<UsersPage />);
    expect(await screen.findByText('db down')).toBeInTheDocument();
  });

  describe('managing accounts', () => {
    const ME = { 'GET /auth/me': { body: { id: 1, username: 'admin', role: 'admin' } } };

    it('edits an agent: role + extension', async () => {
      const calls = fakeApi({
        ...ME,
        'GET /admin/users': USERS,
        'GET /admin/extensions': EXTENSIONS,
        'PUT /admin/users/7': { body: {} },
      });
      renderPage(<UsersPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit agent04' }));
      const dialog = screen.getByRole('dialog');
      await within(dialog).findByRole('option', { name: '1002 (Desk 2)' });
      await userEvent.selectOptions(within(dialog).getByLabelText('Extension'), '1002 (Desk 2)');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(calls.find((c) => c.key === 'PUT /admin/users/7')?.body).toEqual({
          role: 'agent',
          status: 'active',
          extensionId: 2,
          roleId: null,
        }),
      );
    });

    it('resets a password', async () => {
      const calls = fakeApi({
        ...ME,
        'GET /admin/users': USERS,
        'POST /admin/users/7/password': { body: { status: 'ok' } },
      });
      renderPage(<UsersPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Reset password for agent04' }));
      await userEvent.type(screen.getByLabelText('New password'), 'n3w-password');
      await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
      await waitFor(() =>
        expect(calls.find((c) => c.key === 'POST /admin/users/7/password')?.body).toEqual({ password: 'n3w-password' }),
      );
    });

    it("deactivates an agent, shows the server's refusal, and can't deactivate yourself", async () => {
      const calls = fakeApi({
        ...ME,
        'GET /admin/users': USERS,
        'PUT /admin/users/7': { status: 400, body: { error: 'there must always be at least one active admin' } },
      });
      renderPage(<UsersPage />);
      const leaverRow = (await screen.findByText('leaver')).closest('tr')!;
      expect(within(leaverRow).getByText('Inactive')).toBeInTheDocument();
      expect(within(leaverRow).getByRole('button', { name: 'Activate leaver' })).toBeInTheDocument();
      await screen.findByText('(you)');
      expect(screen.queryByRole('button', { name: 'Deactivate admin' })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Deactivate agent04' }));
      const dialog = screen.getByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('at least one active admin');
      expect(calls.find((c) => c.key === 'PUT /admin/users/7')?.body).toEqual({
        role: 'agent',
        status: 'inactive',
        extensionId: 3,
      });
    });
  });
});
