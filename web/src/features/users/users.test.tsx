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
    { id: 2, name: '1002', label: 'Desk 2', enabled: true, sip_password: 'secret-1' },
    { id: 3, name: '1003', label: null, enabled: true, sip_password: 'secret-2' },
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

  it('a team leader / manager creates agents only into one of their teams', async () => {
    const team = (id: number, name: string, parent_id: number | null) => ({
      id,
      name,
      parent_id,
      status: 'active',
      created_at: '',
      members: [],
      campaigns: [],
    });
    const calls = fakeApi({
      'GET /auth/me': {
        body: {
          id: 32,
          username: 'mgr',
          role: 'staff',
          roleName: 'Manager',
          scope: 'team',
          teamCount: 2,
          permissions: { users: ['view', 'create', 'edit', 'password'] },
        },
      },
      'GET /admin/users': USERS,
      'GET /admin/extensions': EXTENSIONS,
      'GET /admin/teams': { body: [team(12, 'TL 1', 11), team(11, 'Manager A', null)] },
      'POST /admin/users': { status: 201, body: { id: 9, username: 'agent09', role: 'agent' } },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create user/i }));
    // Agent accounts only (no account type choice), and the team is required.
    expect(screen.queryByLabelText('Account type')).not.toBeInTheDocument();
    const teamSelect = screen.getByLabelText('Team');
    expect(teamSelect).toBeRequired();
    await screen.findByRole('option', { name: /TL 1/ });
    expect(
      within(teamSelect)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim()),
    ).toEqual(['- Pick a team -', 'Manager A', 'TL 1']);
    await userEvent.type(screen.getByLabelText('Username'), 'agent09');
    await userEvent.type(screen.getByLabelText('Password'), 'pw123456');
    await userEvent.selectOptions(teamSelect, '12');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toMatchObject({ role: 'agent', teamId: 12 });
  });

  it('imports agents: the file is checked first, Create only when every row is fine', async () => {
    // First file: one problem. Second file: clean. Commit = the second file with commit=1.
    let clean = false;
    const calls = fakeApi({
      'GET /admin/users': USERS,
      'POST /admin/users/import': (init) => {
        const form = init?.body as FormData;
        if (form.get('commit') === '1') return { status: 201, body: { created: 2 } };
        return clean
          ? { body: { ready: 2, problems: [] } }
          : {
              body: {
                ready: 1,
                problems: [{ rowNum: 3, username: 'agent01', error: 'that username is already taken' }],
              },
            };
      },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /import agents/i }));
    const dialog = screen.getByRole('dialog');
    const create = within(dialog).getByRole('button', { name: /create agents/i });
    expect(create).toBeDisabled();
    const csv = (name: string) => new File(['username,password,extension,team\n'], name, { type: 'text/csv' });

    await userEvent.upload(within(dialog).getByLabelText('File'), csv('bad.csv'));
    const problem = await within(dialog).findByText('that username is already taken');
    expect(within(problem.closest('tr')!).getByText('3')).toBeInTheDocument();
    expect(create).toBeDisabled();
    expect(calls.filter((c) => c.key === 'POST /admin/users/import')).toHaveLength(1);

    clean = true;
    await userEvent.upload(within(dialog).getByLabelText('File'), csv('good.csv'));
    const go = await within(dialog).findByRole('button', { name: 'Create 2 agents' });
    expect(go).toBeEnabled();
    await userEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const sent = calls.filter((c) => c.key === 'POST /admin/users/import').map((c) => c.body as FormData);
    expect(sent.map((form) => [(form.get('file') as File).name, form.get('commit')])).toEqual([
      ['bad.csv', null],
      ['good.csv', null],
      ['good.csv', '1'],
    ]);
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
      teamId: null,
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
      teamId: null,
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
      teamId: null,
    });
  });

  it('a role with Users rights handles agent accounts only; View alone changes nothing', async () => {
    const staff = (permissions: Record<string, string[]>) => ({
      body: { id: 30, username: 'sup', role: 'staff', roleName: 'Supervisor', scope: 'all', permissions },
    });
    fakeApi({ 'GET /auth/me': staff({ users: ['view', 'create', 'edit', 'password'] }), 'GET /admin/users': USERS });
    const { unmount } = renderPage(<UsersPage />);
    await screen.findByRole('button', { name: 'Edit agent04' });
    expect(screen.queryByRole('button', { name: 'Edit admin' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    expect(screen.queryByLabelText('Account type')).not.toBeInTheDocument(); // agents only
    unmount();

    fakeApi({ 'GET /auth/me': staff({ users: ['view'] }), 'GET /admin/users': USERS });
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
