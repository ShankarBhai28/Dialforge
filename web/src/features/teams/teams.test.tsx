import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { TeamsPage } from './TeamsPage';

const USERS = {
  body: [
    { id: 1, username: 'admin', role: 'admin', created_at: '', extension_name: null },
    { id: 7, username: 'agent04', role: 'agent', created_at: '', extension_name: '1003' },
    { id: 8, username: 'agent05', role: 'agent', created_at: '', extension_name: '1004' },
  ],
};
const CAMPAIGNS = {
  body: [
    { id: 1, name: 'Sales', status: 'active' },
    { id: 4, name: 'Old', status: 'inactive' },
  ],
};
const TEAM = {
  id: 3,
  name: 'Alpha',
  status: 'active',
  created_at: '',
  members: [{ id: 7, username: 'agent04' }],
  campaigns: [{ id: 1, name: 'Sales' }],
};
const api = (extra = {}) =>
  fakeApi({
    'GET /admin/teams': { body: [TEAM] },
    'GET /admin/users': USERS,
    'GET /admin/campaigns': CAMPAIGNS,
    ...extra,
  });

describe('Teams', () => {
  it('lists teams with agents and campaigns', async () => {
    api();
    renderPage(<TeamsPage />);
    const row = (await screen.findByText('Alpha')).closest('tr')!;
    expect(within(row).getByText('agent04')).toBeInTheDocument();
    expect(within(row).getByText('Sales')).toBeInTheDocument();
    expect(within(row).getByText('active')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    fakeApi({ 'GET /admin/teams': { body: [] } });
    renderPage(<TeamsPage />);
    expect(await screen.findByText('No teams yet')).toBeInTheDocument();
  });

  it('creates a team with ticked agents and campaigns (agents only)', async () => {
    const calls = api({ 'POST /admin/teams': { status: 201, body: { id: 9, name: 'Beta' } } });
    renderPage(<TeamsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create team/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Team name'), ' Beta ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'inactive');
    await userEvent.click(await within(dialog).findByLabelText('Agents: agent05'));
    expect(within(dialog).queryByLabelText('Agents: admin')).not.toBeInTheDocument();
    await userEvent.click(await within(dialog).findByLabelText('Campaigns: Old'));
    expect(within(dialog).getByText('(inactive)')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/teams')?.body).toEqual({
      name: 'Beta',
      status: 'inactive',
      memberIds: [8],
      campaignIds: [4],
    });
  });

  it('edits a team, starting from its current members and campaigns', async () => {
    const calls = api({ 'PUT /admin/teams/3': { body: { id: 3, name: 'Alpha' } } });
    renderPage(<TeamsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Alpha' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Team name')).toHaveValue('Alpha');
    expect(await within(dialog).findByLabelText('Agents: agent04')).toBeChecked();
    await userEvent.click(within(dialog).getByLabelText('Agents: agent05'));
    await userEvent.click(await within(dialog).findByLabelText('Campaigns: Sales'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/teams/3')?.body).toEqual({
      name: 'Alpha',
      status: 'active',
      memberIds: [7, 8],
      campaignIds: [],
    });
  });

  it("shows the server's reason when saving fails", async () => {
    api({ 'POST /admin/teams': { status: 409, body: { error: 'a team with that name already exists' } } });
    renderPage(<TeamsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create team/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Team name'), 'Alpha');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create team' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('a team with that name already exists');
  });

  it('deletes a team after confirming, and shows a failure', async () => {
    const calls = api({ 'DELETE /admin/teams/3': { status: 404, body: { error: 'team not found' } } });
    renderPage(<TeamsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Alpha' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Its agents will lose access to its campaigns.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('team not found');
    expect(calls.some((c) => c.key === 'DELETE /admin/teams/3')).toBe(true);
  });

  it('shows a load error with retry', async () => {
    fakeApi({ 'GET /admin/teams': { status: 500, body: { error: 'db down' } } });
    renderPage(<TeamsPage />);
    expect(await screen.findByText('db down')).toBeInTheDocument();
  });
});
