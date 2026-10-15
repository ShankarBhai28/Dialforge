// Leads: open one lead, tick many for bulk actions, export, give to an agent.
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { LeadsTab } from './LeadsTab';
import { LeadDetailPage } from './LeadDetailPage';

const lead = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  phone: `98400123${id}`,
  alt_phone: null,
  name: `Lead ${id}`,
  campaign_id: 1,
  campaign_name: 'Sales',
  list_id: 7,
  list_name: 'Oct list',
  status: 'new',
  attempts: 0,
  priority: 0,
  custom_data: null,
  created_at: '2026-10-03T10:00:00.000Z',
  assigned_user_id: null,
  assigned_to: null,
  ...extra,
});
const PAGE = 'GET /admin/leads?page=1&pageSize=50';
const base = {
  'GET /admin/campaigns': { body: [{ id: 1, name: 'Sales' }] },
  'GET /admin/lists': {
    body: [{ id: 7, campaign_id: 1, campaign_name: 'Sales', name: 'Oct list', is_active: 1, priority: 0 }],
  },
  'GET /admin/leads/agents': { body: [{ id: 4, username: 'agent1004', active: true }] },
  [PAGE]: {
    body: {
      rows: [lead(11), lead(12, { assigned_user_id: 4, assigned_to: 'agent1004' })],
      total: 120,
      page: 1,
      pageSize: 50,
      statuses: ['new'],
    },
  },
};

describe('Leads - bulk, export, assignment', () => {
  it('ticked leads can be given to an agent; the table shows who has them', async () => {
    const calls = fakeApi({
      ...base,
      'POST /admin/leads/bulk': { body: { action: 'assign', changed: 1, skipped: 0, notes: ['given to agent1004'] } },
    });
    renderPage(<LeadsTab />);
    const row12 = (await screen.findByText('Lead 12')).closest('tr')!;
    expect(within(row12).getByText('agent1004')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Tick 9840012311'));
    const bar = screen.getByRole('toolbar', { name: 'Actions on the ticked leads' });
    expect(within(bar).getByText('1 ticked')).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: /Give to agent/ }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'agent1004' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Agent'), 'agent1004');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/leads/bulk')?.body).toEqual({
      ids: [11],
      action: 'assign',
      userId: 4,
    });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument(); // ticks cleared
  });

  it('"tick all matching" sends the filters, not ids; delete says how many', async () => {
    const calls = fakeApi({
      ...base,
      'POST /admin/leads/bulk': { body: { action: 'delete', changed: 120, skipped: 0, notes: [] } },
    });
    renderPage(<LeadsTab />);
    await screen.findByText('Lead 11');
    await userEvent.click(screen.getByLabelText('Tick every lead on this page'));
    await userEvent.click(screen.getByRole('button', { name: 'Tick all 120 leads' }));
    const bar = screen.getByRole('toolbar');
    expect(within(bar).getByText('120 ticked')).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: /Delete/ }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete 120 leads' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /admin/leads/bulk')).toBe(true));
    expect(calls.find((c) => c.key === 'POST /admin/leads/bulk')?.body).toEqual({
      all: true,
      filters: { q: '', campaignId: '', listId: '', status: '', assignedTo: '' },
      action: 'delete',
    });
  });

  it('Export links to the file with the same filters as the table', async () => {
    fakeApi({
      ...base,
      'GET /admin/leads?assignedTo=none&page=1&pageSize=50': {
        body: { rows: [lead(11)], total: 1, page: 1, pageSize: 50, statuses: ['new'] },
      },
    });
    renderPage(<LeadsTab />);
    expect(await screen.findByRole('link', { name: /Export all \(120\)/ })).toHaveAttribute(
      'href',
      '/admin/leads/export?',
    );
    await userEvent.selectOptions(screen.getByLabelText('Filter by agent'), 'Not given to an agent');
    expect(await screen.findByRole('link', { name: /Export these \(1\)/ })).toHaveAttribute(
      'href',
      '/admin/leads/export?assignedTo=none',
    );
  });

  it("a lead's own page: where it stands, its form answers and its history", async () => {
    fakeApi({
      'GET /admin/leads/12': {
        body: {
          ...lead(12, { assigned_user_id: 4, assigned_to: 'agent1004', custom_data: { budget: '40L' } }),
          is_final: 0,
          next_call_at: null,
          last_attempt_at: '2026-10-12T10:00:00Z',
          callback_at: null,
          list_active: 1,
          updated_by_name: 'admin',
          deleted_at: null,
          deleted_by_name: null,
          on_dnc: false,
          form_fields: [{ key: 'budget', label: 'Budget' }],
        },
      },
      'GET /admin/leads/12/history': {
        body: {
          lead: {
            id: 12,
            name: 'Lead 12',
            phone: '9840012312',
            altPhone: null,
            status: 'new',
            attempts: 0,
            final: false,
            nextCallAt: null,
            campaign: 'Sales',
            list: 'Oct list',
            createdAt: '2026-10-03T10:00:00Z',
            customData: null,
          },
          summary: {
            calls: 0,
            answered: 0,
            talkSeconds: 0,
            lastCallAt: null,
            lastSpokeWith: null,
            lastSpokeAt: null,
            lastOutcome: null,
            agents: [],
            pendingCallback: null,
          },
          latestForm: null,
          timeline: [{ type: 'created', at: '2026-10-03T10:00:00Z', campaign: 'Sales', list: 'Oct list' }],
        },
      },
    });
    renderPage(<LeadDetailPage />, { path: '/admin/leads/:id', url: '/admin/leads/12' });
    expect(await screen.findByRole('heading', { name: 'Lead 12' })).toBeInTheDocument();
    expect(screen.getAllByText('Given to agent1004').length).toBeGreaterThan(0);
    expect(screen.getByText('Budget')).toBeInTheDocument();
    expect(screen.getByText('40L')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All leads/ })).toHaveAttribute('href', '/admin/leads');
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
  });
});
