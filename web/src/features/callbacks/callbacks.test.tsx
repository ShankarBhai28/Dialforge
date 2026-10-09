import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { CallbacksPage } from './CallbacksPage';

const base = { note: null, campaign_id: 1, campaign_name: 'Sales', created_by_name: 'agent04' };
const ROWS = [
  {
    ...base,
    id: 1,
    callback_at: '2020-01-01T10:00:00Z',
    status: 'pending',
    name: 'Ravi',
    phone: '9000000001',
    assigned_to: null,
  },
  {
    ...base,
    id: 2,
    callback_at: '2099-01-01T10:00:00Z',
    status: 'pending',
    name: null,
    phone: '9000000002',
    assigned_to: 'agent05',
    note: 'after lunch',
  },
  {
    ...base,
    id: 3,
    callback_at: '2020-01-02T10:00:00Z',
    status: 'done',
    name: 'Meena',
    phone: '9000000003',
    assigned_to: null,
    campaign_id: 4,
    campaign_name: 'Support',
  },
];

const FIRST = 'GET /admin/callbacks?page=1&pageSize=50';
const paged = (rows: unknown[], total = rows.length, page = 1) => ({ body: { rows, total, page, pageSize: 50 } });
const CAMPAIGNS = {
  'GET /admin/campaigns': {
    body: [
      { id: 1, name: 'Sales' },
      { id: 4, name: 'Support' },
    ],
  },
};

describe('Callbacks', () => {
  it('lists callbacks, flags overdue ones and only offers cancel on pending', async () => {
    fakeApi({ ...CAMPAIGNS, [FIRST]: paged(ROWS) });
    renderPage(<CallbacksPage />);
    const ravi = (await screen.findByText('Ravi')).closest('tr')!;
    expect(within(ravi).getByText(/overdue/)).toBeInTheDocument();
    expect(within(ravi).getByText('Anyone')).toBeInTheDocument();
    const second = screen.getByText('9000000002').closest('tr')!;
    expect(within(second).getByText('agent05')).toBeInTheDocument();
    expect(within(second).getByText('after lunch')).toBeInTheDocument();
    expect(within(second).queryByText(/overdue/)).not.toBeInTheDocument();
    const meena = screen.getByText('Meena').closest('tr')!;
    expect(within(meena).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('sends status, campaign and lead filters to the server, starting at page 1', async () => {
    const calls = fakeApi({
      ...CAMPAIGNS,
      [FIRST]: paged(ROWS, 120),
      'GET /admin/callbacks?page=2&pageSize=50': paged([ROWS[1]], 120, 2),
      'GET /admin/callbacks?status=overdue&page=1&pageSize=50': paged([ROWS[0]]),
      'GET /admin/callbacks?campaignId=4&page=1&pageSize=50': paged([ROWS[2]]),
      'GET /admin/callbacks?campaignId=4&q=Ravi&page=1&pageSize=50': paged([]),
    });
    renderPage(<CallbacksPage />);
    await screen.findByText('Ravi');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.queryByText('Ravi')).not.toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'Overdue');
    expect(await screen.findByText('Ravi')).toBeInTheDocument();
    expect(screen.queryByText('9000000002')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'Support');
    expect(await screen.findByText('Meena')).toBeInTheDocument();
    expect(screen.queryByText('Ravi')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Lead'), 'Ravi');
    expect(await screen.findByText('No callbacks match these filters')).toBeInTheDocument();
    // after the first Next, every filtered request asked for page 1
    expect(calls.filter((c) => /(status|campaignId|q)=/.test(c.key) && !c.key.includes('page=1&'))).toHaveLength(0);
  });

  it('asks the server for the next page', async () => {
    const calls = fakeApi({
      ...CAMPAIGNS,
      [FIRST]: paged([ROWS[0]], 51),
      'GET /admin/callbacks?page=2&pageSize=50': paged([ROWS[2]], 51, 2),
    });
    renderPage(<CallbacksPage />);
    await screen.findByText('Ravi');
    expect(screen.getByText('1–50 of 51')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Meena')).toBeInTheDocument();
    expect(screen.queryByText('Ravi')).not.toBeInTheDocument();
    expect(calls.some((c) => c.key === 'GET /admin/callbacks?page=2&pageSize=50')).toBe(true);
  });

  it('shows the empty state', async () => {
    fakeApi({ ...CAMPAIGNS, [FIRST]: paged([]) });
    renderPage(<CallbacksPage />);
    expect(await screen.findByText('No callbacks yet')).toBeInTheDocument();
  });

  it('cancels a pending callback', async () => {
    const calls = fakeApi({
      ...CAMPAIGNS,
      [FIRST]: paged(ROWS),
      'POST /admin/callbacks/1/cancel': { body: { status: 'ok' } },
    });
    renderPage(<CallbacksPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel callback for 9000000001' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel callback' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/callbacks/1/cancel')?.body).toEqual({});
    // the list reloads after the cancel
    await waitFor(() => expect(calls.filter((c) => c.key === FIRST)).toHaveLength(2));
  });

  it("shows the server's reason when cancel fails", async () => {
    fakeApi({
      ...CAMPAIGNS,
      [FIRST]: paged(ROWS),
      'POST /admin/callbacks/1/cancel': { status: 404, body: { error: 'no pending callback with that id' } },
    });
    renderPage(<CallbacksPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel callback for 9000000001' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel callback' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no pending callback with that id');
  });

  it('shows a load error with retry', async () => {
    fakeApi({ ...CAMPAIGNS, [FIRST]: { status: 500, body: { error: 'db down' } } });
    renderPage(<CallbacksPage />);
    expect(await screen.findByText('db down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
