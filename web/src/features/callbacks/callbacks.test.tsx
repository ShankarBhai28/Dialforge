import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { CallbacksPage } from './CallbacksPage';

const base = { note: null, campaign_name: 'Sales', created_by_name: 'agent04' };
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
    campaign_name: 'Support',
  },
];

describe('Callbacks', () => {
  it('lists callbacks, flags overdue ones and only offers cancel on pending', async () => {
    fakeApi({ 'GET /admin/callbacks': { body: ROWS } });
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

  it('filters by status, campaign and lead', async () => {
    fakeApi({ 'GET /admin/callbacks': { body: ROWS } });
    renderPage(<CallbacksPage />);
    await screen.findByText('Ravi');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'Overdue');
    expect(screen.getByText('Ravi')).toBeInTheDocument();
    expect(screen.queryByText('9000000002')).not.toBeInTheDocument();
    expect(screen.queryByText('Meena')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), 'Support');
    expect(screen.getByText('Meena')).toBeInTheDocument();
    expect(screen.queryByText('Ravi')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Campaign'), '');
    await userEvent.type(screen.getByLabelText('Lead'), '0002');
    expect(screen.getByText('9000000002')).toBeInTheDocument();
    expect(screen.queryByText('Ravi')).not.toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    fakeApi({ 'GET /admin/callbacks': { body: [] } });
    renderPage(<CallbacksPage />);
    expect(await screen.findByText('No callbacks yet')).toBeInTheDocument();
  });

  it('cancels a pending callback', async () => {
    const calls = fakeApi({
      'GET /admin/callbacks': { body: ROWS },
      'POST /admin/callbacks/1/cancel': { body: { status: 'ok' } },
    });
    renderPage(<CallbacksPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel callback for 9000000001' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel callback' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/callbacks/1/cancel')?.body).toEqual({});
  });

  it("shows the server's reason when cancel fails", async () => {
    fakeApi({
      'GET /admin/callbacks': { body: ROWS },
      'POST /admin/callbacks/1/cancel': { status: 404, body: { error: 'no pending callback with that id' } },
    });
    renderPage(<CallbacksPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel callback for 9000000001' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel callback' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no pending callback with that id');
  });

  it('shows a load error with retry', async () => {
    fakeApi({ 'GET /admin/callbacks': { status: 500, body: { error: 'db down' } } });
    renderPage(<CallbacksPage />);
    expect(await screen.findByText('db down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
