import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage, type FakeApi } from '@/test/render';
import { LeadsPage } from './LeadsPage';

const CAMPAIGNS = {
  body: [
    { id: 1, name: 'Predictive_Test' },
    { id: 4, name: 'Support' },
  ],
};

const LISTS = {
  body: [
    {
      id: 7,
      campaign_id: 1,
      campaign_name: 'Predictive_Test',
      name: 'October cold',
      is_active: 1,
      priority: 5,
      created_at: '2026-10-01T10:00:00.000Z',
      lead_count: 120,
      dialable_count: 37,
    },
    {
      id: 8,
      campaign_id: 4,
      campaign_name: 'Support',
      name: 'Referrals',
      is_active: 0,
      priority: 0,
      created_at: '2026-10-02T10:00:00.000Z',
      lead_count: 0,
      dialable_count: 0,
    },
  ],
};

const LEADS = {
  body: [
    {
      id: 31,
      phone: '9840012345',
      alt_phone: null,
      name: 'Ravi Kumar',
      campaign_id: 1,
      campaign_name: 'Predictive_Test',
      list_id: 7,
      list_name: 'October cold',
      status: 'no_answer',
      attempts: 2,
      priority: 0,
      created_at: '2026-10-03T10:00:00.000Z',
    },
    {
      id: 32,
      phone: '9840099999',
      alt_phone: null,
      name: null,
      campaign_id: null,
      campaign_name: null,
      list_id: null,
      list_name: null,
      status: 'new',
      attempts: 0,
      priority: 0,
      created_at: '2026-10-04T10:00:00.000Z',
    },
  ],
};

/** fakeApi JSON-parses request bodies; the import sends FormData, so record those separately. */
function fakeApiWithUploads(table: FakeApi) {
  const calls = fakeApi(table);
  const inner = globalThis.fetch;
  const uploads: FormData[] = [];
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      uploads.push(init.body);
      return inner(path, { ...init, body: undefined });
    }
    return inner(path, init);
  });
  return { calls, uploads };
}

const base = { 'GET /admin/lists': LISTS, 'GET /admin/campaigns': CAMPAIGNS, 'GET /leads': LEADS };

describe('Leads & Lists - lists', () => {
  it('shows lists with dialable counts and dialer state', async () => {
    fakeApi(base);
    renderPage(<LeadsPage />);
    const row = (await screen.findByText('October cold')).closest('tr')!;
    expect(within(row).getByText('Predictive_Test')).toBeInTheDocument();
    expect(within(row).getByText('37')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(screen.getByText('Referrals').closest('tr')!).getByText('Inactive')).toBeInTheDocument();
  });

  it('creates a list with the exact body', async () => {
    const calls = fakeApi({ ...base, 'POST /admin/lists': { status: 201, body: { id: 9 } } });
    renderPage(<LeadsPage />);
    await screen.findByText('October cold');
    await userEvent.click(screen.getByRole('button', { name: /create list/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('List name'), ' Diwali batch ');
    await within(dialog).findByRole('option', { name: 'Support' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Campaign'), 'Support');
    await userEvent.type(within(dialog).getByLabelText('Priority'), '-5');
    await userEvent.click(within(dialog).getByLabelText('Active for dialer'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create list' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/lists')?.body).toEqual({
      name: 'Diwali batch',
      campaignId: 4,
      priority: -5,
      isActive: false,
    });
  });

  it('edits a list (priority and active toggle)', async () => {
    const calls = fakeApi({ ...base, 'PUT /admin/lists/7': { body: {} } });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit October cold' }));
    const dialog = screen.getByRole('dialog');
    const priority = within(dialog).getByLabelText('Priority');
    await userEvent.clear(priority);
    await userEvent.type(priority, '10');
    await userEvent.click(within(dialog).getByLabelText('Active for dialer'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/lists/7')?.body).toEqual({
      name: 'October cold',
      campaignId: 1,
      priority: 10,
      isActive: false,
    });
  });

  it("shows the server's reason when a list can't be deleted", async () => {
    fakeApi({
      ...base,
      'DELETE /admin/lists/7': {
        status: 409,
        body: { error: 'Cannot delete - 120 lead(s) still belong to this list. Reassign or remove them first.' },
      },
    });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete October cold' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('120 lead(s) still belong to this list');
  });
});

describe('Leads & Lists - recycle', () => {
  const RECYCLE = {
    body: {
      list: { id: 7, name: 'October cold', maxAttempts: 3 },
      statuses: [
        { status: 'no_answer', label: 'No Answer', total: 50, dialable: 10, scheduled: 20, done: 20, recyclable: true },
        { status: 'interested', label: 'Interested', total: 8, dialable: 0, scheduled: 0, done: 8, recyclable: true },
        {
          status: 'do_not_call',
          label: 'Do Not Call',
          total: 2,
          dialable: 0,
          scheduled: 0,
          done: 2,
          recyclable: false,
        },
      ],
      history: [
        {
          statuses: 'no_answer',
          reset_attempts: 1,
          leads_recycled: 12,
          created_at: '2026-10-05T10:00:00.000Z',
          username: 'admin',
        },
      ],
    },
  };

  it('sends the chosen statuses and shows the result', async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/lists/7/recycle': RECYCLE,
      'POST /admin/lists/7/recycle': { body: { recycled: 55, skippedDnc: 1, skippedOnCall: 0 } },
    });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Recycle October cold' }));
    const dialog = screen.getByRole('dialog');
    const noAnswer = await within(dialog).findByLabelText('Recycle No Answer');
    // defaults: never-reached results ticked, final outcomes not, DNC locked
    expect(noAnswer).toBeChecked();
    expect(within(dialog).getByLabelText('Recycle Interested')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Recycle Do Not Call')).toBeDisabled();
    expect(within(dialog).getByText(/used all 3 attempts/)).toBeInTheDocument();
    expect(within(dialog).getByText(/admin recycled 12/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByLabelText('Recycle Interested'));
    await userEvent.click(within(dialog).getByLabelText(/Reset attempt count/));
    await userEvent.click(within(dialog).getByRole('button', { name: /^Recycle$/ }));
    expect(within(dialog).getByText(/dialable again now/)).toHaveTextContent('no_answer, interested');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, recycle' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '55 lead(s) recycled (skipped: 1 on DNC). A running campaign dials them within seconds.',
    );
    expect(calls.find((c) => c.key === 'POST /admin/lists/7/recycle')?.body).toEqual({
      statuses: ['no_answer', 'interested'],
      resetAttempts: false,
    });
  });

  it('asks for at least one status', async () => {
    const calls = fakeApi({ ...base, 'GET /admin/lists/7/recycle': RECYCLE });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Recycle October cold' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(await within(dialog).findByLabelText('Recycle No Answer'));
    await userEvent.click(within(dialog).getByRole('button', { name: /^Recycle$/ }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Tick at least one status');
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });
});

describe('Leads & Lists - leads', () => {
  it('shows leads and filters them', async () => {
    fakeApi(base);
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Leads' }));
    const row = (await screen.findByText('Ravi Kumar')).closest('tr')!;
    expect(within(row).getByText('No Answer')).toBeInTheDocument();
    expect(within(screen.getByText('9840099999').closest('tr')!).getByText('Unassigned')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search name or phone'), '99999');
    expect(screen.queryByText('Ravi Kumar')).not.toBeInTheDocument();
    expect(screen.getByText('9840099999')).toBeInTheDocument();
  });

  it('edits a lead: picking a list also sets its campaign', async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/campaigns/4/dispositions': { body: [{ code: 'sale', label: 'Sale' }] },
      'GET /admin/campaigns/1/dispositions': { body: [{ code: 'no_answer', label: 'No Answer' }] },
      'PUT /admin/leads/31': { body: { status: 'ok' } },
    });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Leads' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit 9840012345' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Referrals (Support)' });
    await userEvent.selectOptions(within(dialog).getByLabelText('List'), 'Referrals (Support)');
    expect(within(dialog).getByLabelText('Campaign')).toHaveValue('4');
    await within(dialog).findByRole('option', { name: 'Sale' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'Sale');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Ravi K');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/leads/31')?.body).toEqual({
      name: 'Ravi K',
      phone: '9840012345',
      campaignId: 4,
      listId: 8,
      status: 'sale',
    });
  });

  it("shows the server's reason when a lead can't be deleted", async () => {
    fakeApi({
      ...base,
      'DELETE /admin/leads/31': {
        status: 409,
        body: { error: 'Cannot delete - 3 call record(s) reference this lead.' },
      },
    });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Leads' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 9840012345' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('3 call record(s) reference this lead');
  });

  it('shows an error state with retry when leads fail to load', async () => {
    fakeApi({ ...base, 'GET /leads': { status: 500, body: { error: 'database is down' } } });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Leads' }));
    expect(await screen.findByText('database is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Leads & Lists - import', () => {
  it('uploads the file into the chosen list and shows the summary', async () => {
    const { uploads } = fakeApiWithUploads({
      ...base,
      'POST /admin/leads/import': {
        body: {
          total: 10,
          imported: 6,
          duplicates: 1,
          dnc: 1,
          invalid: 2,
          errors: [
            { row: 4, reason: 'invalid phone "12"' },
            { row: 9, reason: 'priority must be a whole number -100..100' },
          ],
        },
      },
    });
    renderPage(<LeadsPage />);
    // "Import" on a list row opens the Import tab with that list picked
    await userEvent.click(await screen.findByRole('button', { name: 'Import into Referrals' }));
    expect(screen.getByLabelText('Into list')).toHaveValue('8');
    expect(screen.getByRole('link', { name: /template \(\.xlsx\)/i })).toHaveAttribute(
      'href',
      '/admin/leads/template?format=xlsx&listId=8',
    );
    expect(screen.getByRole('link', { name: '.csv' })).toHaveAttribute(
      'href',
      '/admin/leads/template?format=csv&listId=8',
    );

    const file = new File(['phone,name\n9840012345,Ravi\n'], 'leads.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('File'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Imported 6 of 10 (1 duplicate, 1 on DNC list, 2 invalid).',
    );
    expect(screen.getByText('Row 4: invalid phone "12"')).toBeInTheDocument();
    expect(screen.getByText('Row 9: priority must be a whole number -100..100')).toBeInTheDocument();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].get('listId')).toBe('8');
    expect((uploads[0].get('file') as File).name).toBe('leads.csv');
  });

  it('asks for a file, and shows the server error', async () => {
    const { uploads } = fakeApiWithUploads({
      ...base,
      'POST /admin/leads/import': { status: 400, body: { error: 'the file must have a "phone" column' } },
    });
    renderPage(<LeadsPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Import' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an .xlsx or .csv file first.');
    expect(uploads).toHaveLength(0);

    await userEvent.upload(screen.getByLabelText('File'), new File(['x'], 'bad.xlsx'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Import failed: the file must have a "phone" column')).toBeInTheDocument();
  });
});
