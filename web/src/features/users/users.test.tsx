import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { UsersPage } from './UsersPage';

const USERS = {
  body: [
    { id: 1, username: 'admin', role: 'admin', created_at: '2026-09-01T10:00:00Z', extension_name: null },
    { id: 7, username: 'agent04', role: 'agent', created_at: '2026-09-02T10:00:00Z', extension_name: '1003' },
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
    expect(within(row).getByText('agent')).toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText('Password'), 'pw123');
    await screen.findByRole('option', { name: '1002 (Desk 2)' });
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Extension'), '1003');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toEqual({
      username: 'agent09',
      password: 'pw123',
      role: 'agent',
      extensionId: 3,
    });
  });

  it('creates an admin without an extension', async () => {
    const calls = fakeApi({
      'GET /admin/users': USERS,
      'GET /admin/extensions': EXTENSIONS,
      'POST /admin/users': { status: 201, body: {} },
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create user/i }));
    await userEvent.type(screen.getByLabelText('Username'), 'boss');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');
    expect(screen.queryByLabelText('Extension')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toEqual({
      username: 'boss',
      password: 'pw',
      role: 'admin',
      extensionId: null,
    });
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
});
