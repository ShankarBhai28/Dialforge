import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { QueuesPage } from './QueuesPage';

const SALES = {
  id: 3,
  name: 'Sales Team',
  asterisk_name: 'sales_team',
  status: 'active',
  created_at: '2026-10-01T10:00:00.000Z',
  ring_strategy: 'leastrecent',
  wait_timeout: 25,
  announce: 'yes',
  retry: 2,
  timeout_restart: 'no',
};

describe('Queues', () => {
  it('lists queues with their ring settings', async () => {
    fakeApi({ 'GET /admin/queues': { body: [SALES] } });
    renderPage(<QueuesPage />);
    const row = (await screen.findByText('Sales Team')).closest('tr')!;
    expect(within(row).getByText('sales_team')).toBeInTheDocument();
    expect(within(row).getByText('Least Recent')).toBeInTheDocument();
    expect(within(row).getByText('25s')).toBeInTheDocument();
    expect(within(row).getByText('Yes')).toBeInTheDocument();
    expect(within(row).getByText('No')).toBeInTheDocument();
  });

  it('creates a queue', async () => {
    const calls = fakeApi({
      'GET /admin/queues': { body: [] },
      'POST /admin/queues': { status: 201, body: { id: 4, name: 'Support', asteriskName: 'support' } },
    });
    renderPage(<QueuesPage />);
    expect(await screen.findByText('No queues yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create queue/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Queue name'), ' Support ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ringing strategy'), 'Fewest Calls');
    await userEvent.clear(within(dialog).getByLabelText('Wait timeout (sec)'));
    await userEvent.type(within(dialog).getByLabelText('Wait timeout (sec)'), '20');
    await userEvent.selectOptions(within(dialog).getByLabelText('Announce'), 'Yes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create queue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/queues')?.body).toEqual({
      name: 'Support',
      ringStrategy: 'fewestcalls',
      waitTimeout: 20,
      announce: 'yes',
      retry: 1,
      timeoutRestart: 'yes',
    });
  });

  it('edits a queue without sending a name (it cannot be renamed)', async () => {
    const calls = fakeApi({
      'GET /admin/queues': { body: [SALES] },
      'PUT /admin/queues/3': { body: { id: 3 } },
    });
    renderPage(<QueuesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Sales Team' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Queue name')).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Timeout restart'), 'Yes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/queues/3')?.body).toEqual({
      ringStrategy: 'leastrecent',
      waitTimeout: 25,
      announce: 'yes',
      retry: 2,
      timeoutRestart: 'yes',
    });
  });

  it("shows the server's error when a create fails", async () => {
    fakeApi({
      'GET /admin/queues': { body: [SALES] },
      'POST /admin/queues': { status: 409, body: { error: 'a queue with a matching name already exists' } },
    });
    renderPage(<QueuesPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create queue/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Queue name'), 'sales team');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create queue' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('a queue with a matching name already exists');
  });

  it("shows the server's reason when a delete is blocked", async () => {
    const blocked = 'Cannot delete - still used by campaign(s): Predictive_Test. Reassign or delete them first.';
    fakeApi({
      'GET /admin/queues': { body: [SALES] },
      'DELETE /admin/queues/3': { status: 409, body: { error: blocked } },
    });
    renderPage(<QueuesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Sales Team' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(blocked);
  });

  it('shows an error state with retry when the list fails', async () => {
    fakeApi({ 'GET /admin/queues': { status: 500, body: { error: 'database unavailable' } } });
    renderPage(<QueuesPage />);
    expect(await screen.findByText('database unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
