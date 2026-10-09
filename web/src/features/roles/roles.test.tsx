import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { RolesPage } from './RolesPage';

const SCREENS = [
  { key: 'live', label: 'Live Agents' },
  { key: 'dialer', label: 'Dialer' },
  { key: 'users', label: 'Users' },
];
const TL = {
  id: 5,
  name: 'Team Leader',
  scope: 'team',
  permissions: { live: 'view', dialer: 'manage', users: 'none' },
  userCount: 2,
};
const api = (extra = {}) => fakeApi({ 'GET /admin/roles': { body: { screens: SCREENS, roles: [TL] } }, ...extra });

describe('Roles', () => {
  it('lists roles with what they see and how many users have them', async () => {
    api();
    renderPage(<RolesPage />);
    const row = (await screen.findByText('Team Leader')).closest('tr')!;
    expect(within(row).getByText('Own teams')).toBeInTheDocument();
    expect(within(row).getByText('Live Agents, Dialer (manage)')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('creates a role from the screen grid', async () => {
    const calls = api({ 'POST /admin/roles': { status: 201, body: { id: 6 } } });
    renderPage(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create role/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Role name'), ' Supervisor ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Sees data of'), 'all');
    await userEvent.click(within(dialog).getByLabelText('Live Agents: View'));
    await userEvent.click(within(dialog).getByLabelText('Users: Manage'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/roles')?.body).toEqual({
      name: 'Supervisor',
      scope: 'all',
      permissions: { live: 'view', users: 'manage' },
    });
  });

  it('edits a role starting from its current rights', async () => {
    const calls = api({ 'PUT /admin/roles/5': { body: {} } });
    renderPage(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Team Leader' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Dialer: Manage')).toBeChecked();
    await userEvent.click(within(dialog).getByLabelText('Dialer: View'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/roles/5')?.body).toEqual({
      name: 'Team Leader',
      scope: 'team',
      permissions: { live: 'view', dialer: 'view', users: 'none' },
    });
  });

  it("shows the server's reason when a role in use can't be deleted", async () => {
    api({ 'DELETE /admin/roles/5': { status: 409, body: { error: 'Cannot delete - tl.ravi still has this role.' } } });
    renderPage(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Team Leader' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('tl.ravi still has');
  });
});
