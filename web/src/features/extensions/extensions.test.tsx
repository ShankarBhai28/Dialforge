import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { ExtensionsPage } from './ExtensionsPage';

const EXT = (over: Record<string, unknown>) => ({
  id: 1,
  name: '1001',
  label: null,
  enabled: true,
  has_password: true,
  used_by: 'agent1001',
  registered: true,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});
const LIST = { body: [EXT({}), EXT({ id: 2, name: '1002', used_by: null, registered: false, enabled: false })] };

describe('Extensions', () => {
  it('lists lines with who uses them, whether connected, and enabled', async () => {
    fakeApi({ 'GET /admin/extensions': LIST });
    renderPage(<ExtensionsPage />);
    const row = (await screen.findByText('1001')).closest('tr')!;
    expect(within(row).getByText('agent1001')).toBeInTheDocument();
    expect(within(row).getByText('Online')).toBeInTheDocument();
    const off = screen.getByText('1002').closest('tr')!;
    expect(within(off).getByText('Disabled')).toBeInTheDocument();
    expect(within(off).getByText('Offline')).toBeInTheDocument();
  });

  it('adds an extension and shows its generated SIP password once', async () => {
    const calls = fakeApi({
      'GET /admin/extensions': LIST,
      'POST /admin/extensions': { status: 201, body: { id: 3, name: '1004', sipPassword: 'GeneratedPw1234567890abc' } },
    });
    renderPage(<ExtensionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /add extension/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Extension number'), '1004');
    await userEvent.type(within(dialog).getByLabelText('Label (optional)'), 'Desk 4');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await screen.findByLabelText('SIP password')).toHaveTextContent('GeneratedPw1234567890abc');
    expect(calls.find((c) => c.key === 'POST /admin/extensions')?.body).toEqual({ name: '1004', label: 'Desk 4' });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByLabelText('SIP password')).not.toBeInTheDocument());
  });

  it("disables after confirming; delete shows the server's reason when the extension is in use", async () => {
    const calls = fakeApi({
      'GET /admin/extensions': LIST,
      'PUT /admin/extensions/1': { body: {} },
      'DELETE /admin/extensions/1': {
        status: 409,
        body: { error: 'Cannot delete - 1001 is the extension of agent1001.' },
      },
    });
    renderPage(<ExtensionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disable 1001' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'PUT /admin/extensions/1')?.body).toEqual({ enabled: false }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Delete 1001' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('extension of agent1001');
  });

  it('view-only role: no change buttons', async () => {
    fakeApi({
      'GET /auth/me': {
        body: { id: 30, username: 'tl', role: 'staff', scope: 'all', permissions: { extensions: ['view'] } },
      },
      'GET /admin/extensions': LIST,
    });
    renderPage(<ExtensionsPage />);
    await screen.findByText('1001');
    expect(
      screen.queryByRole('button', { name: /add extension|disable|delete|new sip password/i }),
    ).not.toBeInTheDocument();
  });
});
