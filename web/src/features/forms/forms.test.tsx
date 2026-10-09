import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { FormsPage } from './FormsPage';

const LOAN_FORM = {
  id: 3,
  name: 'Loan enquiry',
  description: 'Asked on every sales call',
  status: 'active',
  created_at: '2026-10-01T10:00:00.000Z',
  campaigns: 'Predictive_Test',
  response_count: 2,
  fields: [
    {
      id: 11,
      form_id: 3,
      field_key: 'loan_amount',
      label: 'Loan Amount',
      field_type: 'number',
      options: null,
      is_required: 1,
      sort_order: 0,
    },
    {
      id: 12,
      form_id: 3,
      field_key: 'products',
      label: 'Products',
      field_type: 'checkbox',
      options: ['Home', 'Car'],
      is_required: 0,
      sort_order: 1,
    },
  ],
};

describe('Forms', () => {
  it('lists forms with fields, campaigns, responses and status', async () => {
    fakeApi({ 'GET /admin/forms': { body: [LOAN_FORM] } });
    renderPage(<FormsPage />);
    const row = (await screen.findByText('Loan enquiry')).closest('tr')!;
    expect(within(row).getByText('Loan Amount*, Products')).toBeInTheDocument();
    expect(within(row).getByText('Predictive_Test')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
  });

  it('shows the empty state and an error state with retry', async () => {
    fakeApi({ 'GET /admin/forms': { body: [] } });
    const { unmount } = renderPage(<FormsPage />);
    expect(await screen.findByText('No forms yet')).toBeInTheDocument();
    unmount();
    fakeApi({ 'GET /admin/forms': { status: 500, body: { error: 'database is down' } } });
    renderPage(<FormsPage />);
    expect(await screen.findByText('database is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('validates the builder before sending, then saves the exact body', async () => {
    const calls = fakeApi({
      'GET /admin/forms': { body: [] },
      'POST /admin/forms': { status: 201, body: { id: 5, name: 'Survey' } },
    });
    renderPage(<FormsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create form/i }));
    const dialog = screen.getByRole('dialog');
    const save = () => userEvent.click(within(dialog).getByRole('button', { name: 'Create form' }));

    await save();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Form name is required');

    await userEvent.type(within(dialog).getByLabelText('Form name'), 'Survey');
    // key is suggested from the label
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Interested In');
    expect(within(dialog).getByLabelText('Key')).toHaveValue('interested_in');
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'Dropdown');
    await save();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'field "interested_in" (dropdown) needs at least one option',
    );
    await userEvent.type(within(dialog).getByLabelText('Options'), 'Home, Car, ');

    // a second field, with a bad key, then fixed; then moved above the first
    await userEvent.click(within(dialog).getByRole('button', { name: /add field/i }));
    const second = within(dialog).getByRole('group', { name: 'Field 2' });
    await userEvent.type(within(second).getByLabelText('Label'), 'City');
    await userEvent.clear(within(second).getByLabelText('Key'));
    await userEvent.type(within(second).getByLabelText('Key'), '1city');
    await save();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('field 2: key "1city" must be lowercase letters');
    await userEvent.clear(within(second).getByLabelText('Key'));
    await userEvent.type(within(second).getByLabelText('Key'), 'city');
    await userEvent.click(within(second).getByLabelText('Required'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move field 2 up' }));

    // a blank third row is ignored
    await userEvent.click(within(dialog).getByRole('button', { name: /add field/i }));
    expect(calls.some((c) => c.key === 'POST /admin/forms')).toBe(false);
    await save();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/forms')?.body).toEqual({
      name: 'Survey',
      description: '',
      status: 'active',
      fields: [
        { label: 'City', fieldKey: 'city', fieldType: 'text', options: [], isRequired: true },
        {
          label: 'Interested In',
          fieldKey: 'interested_in',
          fieldType: 'dropdown',
          options: ['Home', 'Car'],
          isRequired: false,
        },
      ],
    });
  }, 20_000); // many keystrokes; slow on a busy machine

  it("edits a form and shows the server's error inline", async () => {
    const calls = fakeApi({
      'GET /admin/forms': { body: [LOAN_FORM] },
      'PUT /admin/forms/3': { status: 409, body: { error: 'a form with that name already exists' } },
    });
    renderPage(<FormsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Loan enquiry' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 saved response\(s\)/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText('Form name'));
    await userEvent.type(within(dialog).getByLabelText('Form name'), 'Leads');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('a form with that name already exists');
    expect(calls.find((c) => c.key === 'PUT /admin/forms/3')?.body).toEqual({
      name: 'Leads',
      description: 'Asked on every sales call',
      status: 'active',
      fields: [
        { label: 'Loan Amount', fieldKey: 'loan_amount', fieldType: 'number', options: [], isRequired: true },
        { label: 'Products', fieldKey: 'products', fieldType: 'checkbox', options: ['Home', 'Car'], isRequired: false },
      ],
    });
  });

  it("shows the server's reason when deactivating is blocked", async () => {
    const calls = fakeApi({
      'GET /admin/forms': { body: [LOAN_FORM] },
      'PUT /admin/forms/3': {
        status: 409,
        body: {
          error: 'Cannot deactivate - used by campaign(s): Predictive_Test. Pick another form for them first.',
        },
      },
    });
    renderPage(<FormsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Loan enquiry' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cannot deactivate - used by campaign(s)');
    expect((calls.find((c) => c.key === 'PUT /admin/forms/3')?.body as { status: string }).status).toBe('inactive');
  });

  it("shows the server's reason when a delete is blocked", async () => {
    fakeApi({
      'GET /admin/forms': { body: [LOAN_FORM] },
      'DELETE /admin/forms/3': {
        status: 409,
        body: { error: 'Cannot delete - still referenced by campaign(s) Predictive_Test.' },
      },
    });
    renderPage(<FormsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Loan enquiry' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still referenced by campaign(s)');
  });

  it('shows responses with one column per field', async () => {
    fakeApi({
      'GET /admin/forms': { body: [LOAN_FORM] },
      'GET /admin/forms/3/responses': {
        body: [
          {
            id: 1,
            data: { loan_amount: 50000, products: ['Home', 'Car'] },
            created_at: '2026-10-05T10:00:00.000Z',
            lead_id: 31,
            call_id: 90,
            username: 'agent04',
            campaign_name: 'Predictive_Test',
            lead_phone: '9840012345',
          },
        ],
      },
    });
    renderPage(<FormsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Responses of Loan enquiry' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('agent04')).toBeInTheDocument();
    expect(within(dialog).getByText('Responses - Loan enquiry (latest 1)')).toBeInTheDocument();
    expect(within(dialog).getByRole('columnheader', { name: 'Loan Amount' })).toBeInTheDocument();
    expect(within(dialog).getByText('50000')).toBeInTheDocument();
    expect(within(dialog).getByText('Home, Car')).toBeInTheDocument();
    expect(within(dialog).getByText('9840012345')).toBeInTheDocument();
  });
});
