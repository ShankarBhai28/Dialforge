import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { NumbersPage } from './NumbersPage';

const QUEUES = {
  body: [
    { id: 1, name: 'autodial_test' },
    { id: 4, name: 'Tamil Queue' },
  ],
};

describe('DID Numbers', () => {
  it('lists numbers with their queue and the campaigns that take it; flags unmapped ones', async () => {
    fakeApi({
      'GET /admin/dids': {
        body: [
          {
            id: 2,
            number: '8065098690',
            queue_id: 1,
            queue_name: 'autodial_test',
            campaign_names: 'Care, Predictive_Test',
          },
          { id: 5, number: '8065011111', queue_id: 4, queue_name: 'Tamil Queue', campaign_names: null },
          { id: 3, number: '8065000000', queue_id: null, queue_name: null, campaign_names: null },
        ],
      },
      'GET /admin/queues': QUEUES,
    });
    renderPage(<NumbersPage />);
    const row = (await screen.findByText('8065098690')).closest('tr')!;
    expect(within(row).getByText('autodial_test')).toBeInTheDocument();
    expect(within(row).getByText('Care, Predictive_Test')).toBeInTheDocument();
    const orphan = screen.getByText('8065011111').closest('tr')!;
    expect(within(orphan).getByText('No campaign takes this queue')).toBeInTheDocument();
    expect(screen.getByText(/not mapped/i)).toBeInTheDocument();
  });

  it('adds a number routed to a queue', async () => {
    const calls = fakeApi({
      'GET /admin/dids': { body: [] },
      'GET /admin/queues': QUEUES,
      'POST /admin/dids': { status: 201, body: {} },
    });
    renderPage(<NumbersPage />);
    expect(await screen.findByText('No numbers yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /add number/i }));
    await userEvent.type(screen.getByLabelText('Number'), ' 8065098690 ');
    await screen.findByRole('option', { name: 'Tamil Queue' });
    await userEvent.selectOptions(screen.getByLabelText('Queue'), 'Tamil Queue');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/dids')?.body).toEqual({ number: '8065098690', queueId: 4 });
  });

  it("shows the server's reason when a delete fails, and keeps the dialog open", async () => {
    fakeApi({
      'GET /admin/dids': {
        body: [{ id: 2, number: '8065098690', queue_id: 1, queue_name: 'autodial_test', campaign_names: 'Care' }],
      },
      'GET /admin/queues': QUEUES,
      'DELETE /admin/dids/2': { status: 404, body: { error: 'DID not found' } },
    });
    renderPage(<NumbersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 8065098690' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('DID not found');
  });
});
