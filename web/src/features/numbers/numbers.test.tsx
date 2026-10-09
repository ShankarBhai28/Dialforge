import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { NumbersPage } from './NumbersPage';

const CAMPAIGNS = {
  body: [
    { id: 1, name: 'Predictive_Test' },
    { id: 4, name: 'Support' },
  ],
};

describe('DID Numbers', () => {
  it('lists numbers and flags unmapped ones', async () => {
    fakeApi({
      'GET /admin/dids': {
        body: [
          { id: 2, number: '8065098690', campaign_id: 1, campaign_name: 'Predictive_Test' },
          { id: 3, number: '8065000000', campaign_id: null, campaign_name: null },
        ],
      },
      'GET /admin/campaigns': CAMPAIGNS,
    });
    renderPage(<NumbersPage />);
    const row = (await screen.findByText('8065098690')).closest('tr')!;
    expect(within(row).getByText('Predictive_Test')).toBeInTheDocument();
    expect(screen.getByText(/not mapped/i)).toBeInTheDocument();
  });

  it('adds a number mapped to a campaign', async () => {
    const calls = fakeApi({
      'GET /admin/dids': { body: [] },
      'GET /admin/campaigns': CAMPAIGNS,
      'POST /admin/dids': { status: 201, body: {} },
    });
    renderPage(<NumbersPage />);
    expect(await screen.findByText('No numbers yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /add number/i }));
    await userEvent.type(screen.getByLabelText('Number'), ' 8065098690 ');
    await screen.findByRole('option', { name: 'Support' });
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'Support');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/dids')?.body).toEqual({ number: '8065098690', campaignId: 4 });
  });

  it("shows the server's reason when a delete fails, and keeps the dialog open", async () => {
    fakeApi({
      'GET /admin/dids': { body: [{ id: 2, number: '8065098690', campaign_id: 1, campaign_name: 'Predictive_Test' }] },
      'GET /admin/campaigns': CAMPAIGNS,
      'DELETE /admin/dids/2': { status: 404, body: { error: 'DID not found' } },
    });
    renderPage(<NumbersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 8065098690' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('DID not found');
  });
});
