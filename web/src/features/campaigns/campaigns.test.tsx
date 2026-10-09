import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { CampaignsPage } from './CampaignsPage';
import type { Campaign } from './api';

const QUEUES = { body: [{ id: 3, name: 'sales_q', asterisk_name: 'sales_q', ring_strategy: 'ringall' }] };
const FORMS = {
  body: [
    { id: 7, name: 'Survey', status: 'active' },
    { id: 8, name: 'Old form', status: 'inactive' },
  ],
};

const PREDICTIVE: Campaign = {
  id: 5,
  name: 'Predictive_Test',
  status: 'active',
  created_at: '2026-10-01T10:00:00.000Z',
  queue_id: 3,
  queue_name: 'sales_q',
  ring_strategy: 'ringall',
  wait_timeout: 30,
  outbound_caller_id: '8065098690',
  auto_answer: 1,
  form_id: 7,
  form_name: 'Survey',
  dial_mode: 'predictive',
  dial_ratio: '1.50',
  max_dial_ratio: '2.50',
  target_abandon_pct: '3.00',
  ring_timeout_sec: 25,
  max_attempts: 4,
  max_channels: 20,
  amd_enabled: 1,
  preview_autodial_sec: null,
  wrapup_sec: 15,
  abandon_wait_sec: 5,
  call_window_start: '09:00:00',
  call_window_end: '21:00:00',
  timezone: 'Asia/Kolkata',
  dialer_state: 'stopped',
};

const DISPOSITIONS = [
  { code: 'interested', label: 'Interested', is_final: 1, retry_after_min: null, marks_dnc: 0, is_callback: 0 },
  { code: 'no_answer', label: 'No Answer', is_final: 0, retry_after_min: 60, marks_dnc: 0, is_callback: 0 },
];

const RULES = [
  { result: 'no_answer', label: 'No answer', enabled: 1, delay_min: 60, max_tries: 3 },
  { result: 'busy', label: 'Busy', enabled: 0, delay_min: 15, max_tries: 3 },
];

const base = {
  'GET /admin/queues': QUEUES,
  'GET /admin/forms': FORMS,
  'GET /admin/campaigns/5/dispositions': { body: DISPOSITIONS },
  'GET /admin/campaigns/5/recycle-rules': { body: RULES },
};

describe('Campaigns', () => {
  it('lists campaigns with queue, form and mode', async () => {
    fakeApi({
      ...base,
      'GET /admin/campaigns': {
        body: [
          PREDICTIVE,
          { ...PREDICTIVE, id: 6, name: 'Manual one', dial_mode: 'manual', status: 'paused', queue_name: null },
        ],
      },
    });
    renderPage(<CampaignsPage />);
    const row = (await screen.findByText('Predictive_Test')).closest('tr')!;
    expect(within(row).getByText('sales_q')).toBeInTheDocument();
    expect(within(row).getByText('Survey')).toBeInTheDocument();
    expect(within(row).getByText('Predictive ≤2.5:1')).toBeInTheDocument();
    const manual = screen.getByText('Manual one').closest('tr')!;
    expect(within(manual).getByText('Paused')).toBeInTheDocument();
    expect(within(manual).getByText('Manual')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    fakeApi({ ...base, 'GET /admin/campaigns': { body: [] } });
    renderPage(<CampaignsPage />);
    expect(await screen.findByText('No campaigns yet')).toBeInTheDocument();
  });

  it('creates a campaign with every setting the route expects', async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [] },
      'POST /admin/campaigns': { status: 201, body: { id: 9, name: 'Sales' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /create campaign/i }));
    const dialog = screen.getByRole('dialog');
    // paste: one event instead of one per key keeps this big form test quick
    await userEvent.click(within(dialog).getByLabelText('Campaign name'));
    await userEvent.paste(' Sales ');
    await within(within(dialog).getByLabelText('Queue')).findByRole('option', { name: 'sales_q' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Queue'), 'sales_q');
    const formSelect = within(dialog).getByLabelText('Form');
    await within(formSelect).findByRole('option', { name: 'Survey' });
    // inactive forms can't be attached
    expect(within(formSelect).queryByRole('option', { name: /Old form/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(formSelect, 'Survey');
    await userEvent.click(within(dialog).getByLabelText('Outbound Caller ID (DID)'));
    await userEvent.paste('8065098690');

    // Mode-specific fields appear only for their mode.
    expect(within(dialog).queryByLabelText('Dial ratio')).not.toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Dial mode'), 'progressive');
    expect(within(dialog).getByLabelText('Dial ratio')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Max dial ratio')).not.toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText('Dial ratio'));
    await userEvent.type(within(dialog).getByLabelText('Dial ratio'), '2');
    await userEvent.click(within(dialog).getByLabelText('Answering-machine detection'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Create campaign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'POST /admin/campaigns')?.body).toEqual({
      name: 'Sales',
      queueId: 3,
      formId: 7,
      outboundCallerId: '8065098690',
      autoAnswer: false,
      status: 'active',
      dialMode: 'progressive',
      dialRatio: 2,
      maxDialRatio: 2.5,
      targetAbandonPct: 3,
      previewAutodialSec: null,
      ringTimeoutSec: 30,
      maxAttempts: 3,
      maxChannels: 10,
      wrapupSec: 10,
      abandonWaitSec: 5,
      callWindowStart: '09:00',
      callWindowEnd: '21:00',
      timezone: 'Asia/Kolkata',
      amdEnabled: true,
    });
  });

  it('edits a campaign, sending its saved values back', async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'PUT /admin/campaigns/5': { body: { id: 5, name: 'Predictive_Test' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Starting ratio (until learned)')).toHaveValue(1.5);
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'paused');
    await userEvent.clear(within(dialog).getByLabelText('Target abandon %'));
    await userEvent.type(within(dialog).getByLabelText('Target abandon %'), '2.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.key === 'PUT /admin/campaigns/5')?.body).toEqual({
      name: 'Predictive_Test',
      queueId: 3,
      formId: 7,
      outboundCallerId: '8065098690',
      autoAnswer: true,
      status: 'paused',
      dialMode: 'predictive',
      dialRatio: 1.5,
      maxDialRatio: 2.5,
      targetAbandonPct: 2.5,
      previewAutodialSec: null,
      ringTimeoutSec: 25,
      maxAttempts: 4,
      maxChannels: 20,
      wrapupSec: 15,
      abandonWaitSec: 5,
      callWindowStart: '09:00',
      callWindowEnd: '21:00',
      timezone: 'Asia/Kolkata',
      amdEnabled: true,
    });
  });

  it('checks settings before sending, like the server does', async () => {
    const calls = fakeApi({ ...base, 'GET /admin/campaigns': { body: [PREDICTIVE] } });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Max dial ratio'));
    await userEvent.type(within(dialog).getByLabelText('Max dial ratio'), '1.2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'max dial ratio must be between the dial ratio and 5',
    );
    expect(calls.some((c) => c.key === 'PUT /admin/campaigns/5')).toBe(false);
  });

  it("shows the server's error when a save is rejected", async () => {
    fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'PUT /admin/campaigns/5': { status: 400, body: { error: 'that form is inactive' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('that form is inactive');
  });

  it("shows the server's reason when a delete is blocked", async () => {
    const blocked = 'Cannot delete - still referenced by 12 lead(s). Reassign or remove them first.';
    fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'DELETE /admin/campaigns/5': { status: 409, body: { error: blocked } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(blocked);
  });

  it('edits and saves dispositions', async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'PUT /admin/campaigns/5/dispositions': { body: { status: 'ok' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dispositions for Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByDisplayValue('Interested')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /add disposition/i }));
    // the code follows the label
    await userEvent.type(within(dialog).getByLabelText('Disposition 3 label'), 'Wrong Number');
    expect(within(dialog).getByLabelText('Disposition 3 code')).toHaveValue('wrong_number');
    await userEvent.click(within(dialog).getByLabelText('Disposition 3 final'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move disposition 3 up' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save dispositions' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /admin/campaigns/5/dispositions')).toBe(true));
    expect(calls.find((c) => c.key === 'PUT /admin/campaigns/5/dispositions')?.body).toEqual({
      dispositions: [
        {
          label: 'Interested',
          code: 'interested',
          isFinal: true,
          retryAfterMin: null,
          isCallback: false,
          marksDnc: false,
        },
        {
          label: 'Wrong Number',
          code: 'wrong_number',
          isFinal: true,
          retryAfterMin: null,
          isCallback: false,
          marksDnc: false,
        },
        {
          label: 'No Answer',
          code: 'no_answer',
          isFinal: false,
          retryAfterMin: 60,
          isCallback: false,
          marksDnc: false,
        },
      ],
    });
  });

  it("checks dispositions first and shows the server's error", async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'PUT /admin/campaigns/5/dispositions': { status: 500, body: { error: 'failed to save dispositions' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dispositions for Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(await within(dialog).findByLabelText('Disposition 2 DNC'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save dispositions' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '"No Answer": Do-Not-Call dispositions must also be final',
    );
    expect(calls.some((c) => c.key === 'PUT /admin/campaigns/5/dispositions')).toBe(false);

    await userEvent.click(within(dialog).getByLabelText('Disposition 2 DNC'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save dispositions' }));
    expect(await within(dialog).findByText('failed to save dispositions')).toBeInTheDocument();
  });

  it('saves recycle rules for every result', async () => {
    const calls = fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'PUT /admin/campaigns/5/recycle-rules': { body: { status: 'ok' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Recycle rules for Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(await within(dialog).findByLabelText('Busy: auto redial'));
    await userEvent.clear(within(dialog).getByLabelText('No answer: redial after (min)'));
    await userEvent.type(within(dialog).getByLabelText('No answer: redial after (min)'), '90');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recycle rules' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /admin/campaigns/5/recycle-rules')).toBe(true));
    expect(calls.find((c) => c.key === 'PUT /admin/campaigns/5/recycle-rules')?.body).toEqual({
      rules: {
        no_answer: { enabled: true, delayMin: 90, maxTries: 3 },
        busy: { enabled: true, delayMin: 15, maxTries: 3 },
      },
    });
  });

  it("shows the server's error for recycle rules", async () => {
    fakeApi({
      ...base,
      'GET /admin/campaigns': { body: [PREDICTIVE] },
      'PUT /admin/campaigns/5/recycle-rules': { status: 404, body: { error: 'campaign not found' } },
    });
    renderPage(<CampaignsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Recycle rules for Predictive_Test' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByLabelText('Busy: auto redial');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recycle rules' }));
    expect(await within(dialog).findByText('campaign not found')).toBeInTheDocument();
  });
});
