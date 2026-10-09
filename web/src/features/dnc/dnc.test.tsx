import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { DncPage } from './DncPage';

const row = (id: number, phone: string) => ({
  id,
  phone,
  source: 'manual',
  created_at: '2026-10-01T10:00:00Z',
  created_by_name: 'admin',
});

const FIRST = 'GET /admin/dnc?page=1&pageSize=50';
/** GET /admin/dnc reply: `all` = whole list, `total` = matching the search. */
const list = (rows: unknown[], opts: { all?: number; total?: number; page?: number } = {}) => {
  const all = opts.all ?? rows.length;
  return { body: { rows, total: opts.total ?? all, page: opts.page ?? 1, pageSize: 50, all } };
};

describe('DNC list', () => {
  it('lists numbers with the total', async () => {
    fakeApi({ [FIRST]: list([row(1, '9876543210'), row(2, '9000000000')]) });
    renderPage(<DncPage />);
    const tr = (await screen.findByText('9876543210')).closest('tr')!;
    expect(within(tr).getByText('manual')).toBeInTheDocument();
    expect(within(tr).getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('2 numbers')).toBeInTheDocument();
  });

  it('searches on the server and shows the matching count', async () => {
    const calls = fakeApi({
      [FIRST]: list([row(1, '9876543210'), row(2, '9000000000')]),
      'GET /admin/dnc?q=98&page=1&pageSize=50': list([row(1, '9876543210')], { all: 2, total: 1 }),
    });
    renderPage(<DncPage />);
    await screen.findByText('9000000000');
    await userEvent.type(screen.getByLabelText('Search number'), '98');
    expect(await screen.findByText('2 numbers (1 matching)')).toBeInTheDocument();
    expect(screen.queryByText('9000000000')).not.toBeInTheDocument();
    expect(calls.some((c) => c.key === 'GET /admin/dnc?q=98&page=1&pageSize=50')).toBe(true);
  });

  it('asks the server for the next page', async () => {
    const calls = fakeApi({
      [FIRST]: list([row(1, '9000000000')], { all: 60 }),
      'GET /admin/dnc?page=2&pageSize=50': list([row(55, '9000000055')], { all: 60, page: 2 }),
    });
    renderPage(<DncPage />);
    await screen.findByText('9000000000');
    expect(screen.getByText('1–50 of 60')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('9000000055')).toBeInTheDocument();
    expect(screen.queryByText('9000000000')).not.toBeInTheDocument();
    expect(screen.getByText('51–60 of 60')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'GET /admin/dnc?page=2&pageSize=50')).toBe(true);
  });

  it('a new search starts again at page 1', async () => {
    const calls = fakeApi({
      [FIRST]: list([row(1, '9000000000')], { all: 60 }),
      'GET /admin/dnc?page=2&pageSize=50': list([row(55, '9000000055')], { all: 60, page: 2 }),
      'GET /admin/dnc?q=987&page=1&pageSize=50': list([row(3, '9876543210')], { all: 60, total: 1 }),
    });
    renderPage(<DncPage />);
    await screen.findByText('9000000000');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('9000000055');
    await userEvent.type(screen.getByLabelText('Search number'), '987');
    expect(await screen.findByText('9876543210')).toBeInTheDocument();
    expect(screen.getByText('60 numbers (1 matching)')).toBeInTheDocument();
    expect(calls.filter((c) => c.key.includes('q=') && !c.key.includes('page=1&'))).toHaveLength(0);
  });

  it('bulk adds the raw text and shows the result counts', async () => {
    const calls = fakeApi({
      [FIRST]: list([]),
      'POST /admin/dnc': { body: { added: 2, existing: 1, invalid: 1 } },
    });
    renderPage(<DncPage />);
    expect(await screen.findByText('No numbers')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Numbers'), '9876543210{enter}+91 90000 00000, 12');
    await userEvent.click(screen.getByRole('button', { name: /add to dnc/i }));
    expect(await screen.findByText('Added 2, already listed 1, invalid 1.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /admin/dnc')?.body).toEqual({
      phones: '9876543210\n+91 90000 00000, 12',
    });
    expect(screen.getByLabelText('Numbers')).toHaveValue('');
  });

  it("shows the server's reason when adding fails", async () => {
    fakeApi({
      [FIRST]: list([]),
      'POST /admin/dnc': { status: 400, body: { error: 'max 5000 numbers per add' } },
    });
    renderPage(<DncPage />);
    await userEvent.type(await screen.findByLabelText('Numbers'), '1');
    await userEvent.click(screen.getByRole('button', { name: /add to dnc/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('max 5000 numbers per add');
  });

  it('removes a number after confirming', async () => {
    const calls = fakeApi({
      [FIRST]: list([row(7, '9876543210')]),
      'DELETE /admin/dnc/7': { body: { status: 'ok' } },
    });
    renderPage(<DncPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove 9876543210' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/can be called again/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.key === 'DELETE /admin/dnc/7')).toBe(true);
  });

  it("shows the server's reason when remove fails", async () => {
    fakeApi({
      [FIRST]: list([row(7, '9876543210')]),
      'DELETE /admin/dnc/7': { status: 404, body: { error: 'not found' } },
    });
    renderPage(<DncPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove 9876543210' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not found');
  });

  it('shows a load error with retry', async () => {
    fakeApi({ [FIRST]: { status: 500, body: { error: 'db down' } } });
    renderPage(<DncPage />);
    expect(await screen.findByText('db down')).toBeInTheDocument();
  });
});
