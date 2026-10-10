import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { AuditPage } from './AuditPage';

const FIRST = 'GET /admin/audit?page=1&pageSize=50';
const ROWS = [
  {
    id: 12,
    at: '2026-10-11T05:00:00.000Z',
    user_id: 1,
    username: 'admin',
    action: 'campaigns.edit',
    entity: 'campaigns',
    entity_id: '5',
    status: 200,
    summary: null,
    request_json: { name: 'Sales 2', status: 'paused' },
    before_json: { id: 5, name: 'Sales', status: 'active' },
    after_json: { id: 5, name: 'Sales 2', status: 'paused' },
    ip: '10.0.0.5',
  },
  {
    id: 11,
    at: '2026-10-11T04:00:00.000Z',
    user_id: 30,
    username: 'sup',
    action: 'campaigns.delete',
    entity: 'campaigns',
    entity_id: '5',
    status: 403,
    summary: "refused: Your role doesn't allow: Campaigns - Delete",
    request_json: null,
    before_json: null,
    after_json: null,
    ip: null,
  },
];
const page = {
  rows: ROWS,
  total: 2,
  page: 1,
  pageSize: 50,
  actions: ['campaigns.delete', 'campaigns.edit'],
  entities: ['campaigns'],
};

describe('Audit log', () => {
  it('lists who did what, with refused attempts marked, and opens a row to show what changed', async () => {
    fakeApi({ [FIRST]: { body: page } });
    renderPage(<AuditPage />);
    expect(await screen.findByRole('cell', { name: 'campaigns.edit' })).toBeInTheDocument();
    expect(screen.getByText('Refused')).toBeInTheDocument();
    expect(screen.getByText(/Campaigns - Delete/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show details of #12' }));
    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('active')).toHaveClass('line-through');
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.getByText('From 10.0.0.5')).toBeInTheDocument();
  });

  it('filters on the server', async () => {
    const calls = fakeApi({
      [FIRST]: { body: page },
      'GET /admin/audit?action=campaigns.edit&page=1&pageSize=50': { body: { ...page, rows: [ROWS[0]], total: 1 } },
      'GET /admin/audit?action=campaigns.edit&failed=1&page=1&pageSize=50': { body: { ...page, rows: [], total: 0 } },
    });
    renderPage(<AuditPage />);
    await screen.findByRole('cell', { name: 'campaigns.edit' });
    await userEvent.selectOptions(screen.getByLabelText('Filter by action'), 'campaigns.edit');
    await waitFor(() => expect(calls.some((c) => c.key.includes('action=campaigns.edit'))).toBe(true));
    await userEvent.click(screen.getByLabelText('Refused / failed only'));
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
  });
});
