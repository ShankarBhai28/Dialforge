import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { RolesPage } from './RolesPage';

const META = {
  screens: [
    { key: 'live', label: 'Live Agents', actions: ['view'] },
    { key: 'dialer', label: 'Dialer', actions: ['view', 'control'] },
    { key: 'campaigns', label: 'Campaigns', actions: ['view', 'create', 'edit', 'delete'] },
  ],
  actionLabels: {
    view: 'View',
    create: 'Create',
    edit: 'Edit',
    delete: 'Delete',
    control: 'Start / Pause / Stop',
  },
  teamScopeBlocked: { campaigns: ['create', 'delete'] },
};
const TL = {
  id: 5,
  name: 'Team Leader',
  scope: 'team',
  permissions: { live: ['view'], dialer: ['view', 'control'], campaigns: [] },
  userCount: 2,
};
const api = (extra = {}) => fakeApi({ 'GET /admin/roles': { body: { ...META, roles: [TL] } }, ...extra });

describe('Roles', () => {
  it('lists roles with what they see, their rights and how many users have them', async () => {
    api();
    renderPage(<RolesPage />);
    const row = (await screen.findByText('Team Leader')).closest('tr')!;
    expect(within(row).getByText('Own teams')).toBeInTheDocument();
    expect(within(row).getByText('Live Agents: View · Dialer: View, Start / Pause / Stop')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('creates a role by ticking actions; any tick brings View; new roles see all teams', async () => {
    const calls = api({ 'POST /admin/roles': { status: 201, body: { id: 6 } } });
    renderPage(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create role/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Sees data of')).toHaveValue('all');
    await userEvent.type(within(dialog).getByLabelText('Role name'), ' Supervisor ');
    await userEvent.click(within(dialog).getByLabelText('Campaigns: Create'));
    expect(within(dialog).getByLabelText('Campaigns: View')).toBeChecked();
    await userEvent.click(within(dialog).getByLabelText('Live Agents: View'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const body = calls.find((c) => c.key === 'POST /admin/roles')?.body as {
      name: string;
      scope: string;
      permissions: Record<string, string[]>;
    };
    expect(body.name).toBe('Supervisor');
    expect(body.scope).toBe('all');
    expect(body.permissions.campaigns?.sort()).toEqual(['create', 'view']);
    expect(body.permissions.live).toEqual(['view']);
  });

  it('own teams: actions that reach outside the teams are locked, and switching drops them', async () => {
    const calls = api({ 'POST /admin/roles': { status: 201, body: { id: 6 } } });
    renderPage(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create role/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Role name'), 'TL');
    await userEvent.click(within(dialog).getByLabelText('Campaigns: Create'));
    await userEvent.click(within(dialog).getByLabelText('Campaigns: Edit'));
    await userEvent.selectOptions(within(dialog).getByLabelText('Sees data of'), 'team');
    expect(within(dialog).getByLabelText('Campaigns: Create')).toBeDisabled();
    expect(within(dialog).getByLabelText('Campaigns: Delete')).toBeDisabled();
    expect(within(dialog).getByLabelText('Campaigns: Edit')).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const body = calls.find((c) => c.key === 'POST /admin/roles')?.body as { permissions: Record<string, string[]> };
    expect(body.permissions.campaigns?.sort()).toEqual(['edit', 'view']);
  });

  it('unticking View clears the row; edit starts from the current rights', async () => {
    const calls = api({ 'PUT /admin/roles/5': { body: {} } });
    renderPage(<RolesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Team Leader' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Dialer: Start / Pause / Stop')).toBeChecked();
    await userEvent.click(within(dialog).getByLabelText('Dialer: View'));
    expect(within(dialog).getByLabelText('Dialer: Start / Pause / Stop')).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/roles/5')?.body).toEqual({
      name: 'Team Leader',
      scope: 'team',
      permissions: { live: ['view'], dialer: [], campaigns: [] },
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
