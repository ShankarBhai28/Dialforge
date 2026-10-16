import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderPage } from '@/test/render';
import { CustomerHistory } from './CustomerHistory';
import type { LeadHistory } from './api';

const H: LeadHistory = {
  lead: {
    id: 9,
    name: 'Ravi',
    phone: '9840012345',
    altPhone: null,
    status: 'callback',
    attempts: 3,
    final: false,
    nextCallAt: null,
    campaign: 'Sales',
    list: 'Oct list',
    createdAt: '2026-10-01T09:00:00Z',
    customData: null,
  },
  summary: {
    calls: 2,
    answered: 1,
    talkSeconds: 160,
    lastCallAt: '2026-10-12T10:00:00Z',
    lastSpokeWith: 'agent1003',
    lastSpokeAt: '2026-10-12T10:00:00Z',
    lastOutcome: 'Call Back',
    agents: ['agent1003'],
    pendingCallback: { due: '2026-10-14T12:30:00Z' },
  },
  latestForm: {
    form: 'Loan form',
    at: '2026-10-12T10:02:00Z',
    agent: 'agent1003',
    answers: [{ label: 'Budget', value: '40L' }],
  },
  timeline: [
    {
      type: 'call',
      at: '2026-10-12T10:00:00Z',
      callId: 31,
      direction: 'outbound',
      agent: 'agent1003',
      extension: '1003',
      result: 'Answered',
      talkSeconds: 160,
      outcome: 'Call Back',
      note: 'after 6',
      callbackAt: null,
      transferred: false,
      recorded: true,
      recordingUrl: '/admin/calls/31/recording',
    },
    { type: 'edit', at: '2026-10-06T08:00:00Z', agent: 'admin', changes: [{ field: 'Name', from: 'R', to: 'Ravi' }] },
    { type: 'created', at: '2026-10-01T09:00:00Z', campaign: 'Sales', list: 'Oct list' },
  ],
};

describe('Customer history', () => {
  it('admin: summary, last form, timeline; a recording plays inline', async () => {
    fakeApi({ 'GET /admin/leads/9/history': { body: H } });
    renderPage(<CustomerHistory side="admin" leadId={9} />);
    const section = await screen.findByRole('region', { name: 'Customer history' });
    expect(within(section).getByText(/Last spoke with/)).toHaveTextContent('agent1003');
    expect(within(section).getByText('40L')).toBeInTheDocument();
    expect(within(section).getByText('“after 6”')).toBeInTheDocument();
    expect(within(section).getByText(/Answered · 2m 40s/)).toBeInTheDocument();
    expect(within(section).getByText(/Name: R →/)).toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: 'Play recording of call 31' }));
    expect(within(section).getByLabelText('Recording of call 31')).toHaveAttribute('src', '/admin/calls/31/recording');
  });

  it('each save says what it changed; an upload names its file; other leads with the number are marked', async () => {
    const withChanges: LeadHistory = {
      ...H,
      timeline: [
        {
          type: 'form',
          at: '2026-10-14T10:00:00Z',
          agent: 'agent1003',
          form: 'Loan form',
          callId: 40,
          answers: [{ label: 'Budget', value: '60L' }],
          changes: [{ field: 'Budget', from: '40L', to: '60L' }],
        },
        {
          type: 'edit',
          at: '2026-10-13T08:00:00Z',
          agent: 'admin',
          source: 'upload october.xlsx',
          changes: [{ field: 'City', from: 'Chennai', to: 'Madurai' }],
        },
        {
          type: 'call',
          at: '2026-10-12T10:00:00Z',
          callId: 77,
          direction: 'outbound',
          agent: 'agent1001',
          extension: '1001',
          result: 'Answered',
          talkSeconds: 30,
          outcome: null,
          note: null,
          callbackAt: null,
          transferred: false,
          recorded: false,
          earlierLead: { id: 40, name: 'Ravi', campaign: 'Insurance', deleted: false },
        },
      ],
    };
    fakeApi({ 'GET /admin/leads/9/history': { body: withChanges } });
    renderPage(<CustomerHistory side="admin" leadId={9} />);
    const section = await screen.findByRole('region', { name: 'Customer history' });
    expect(within(section).getByText(/Budget: 40L →/)).toBeInTheDocument();
    expect(within(section).getByText(/· upload october.xlsx/)).toBeInTheDocument();
    expect(within(section).getByText(/City: Chennai →/)).toBeInTheDocument();
    expect(within(section).getByText('other lead · Insurance')).toBeInTheDocument();
  });

  it('agent screen: summary first, the full timeline on demand; no player without a link', async () => {
    const noUrl = {
      ...H,
      timeline: H.timeline.map((t) => (t.type === 'call' ? { ...t, recordingUrl: undefined } : t)),
    };
    fakeApi({ 'GET /agent/leads/9/history': { body: noUrl } });
    renderPage(<CustomerHistory side="agent" leadId={9} collapsible />);
    const section = await screen.findByRole('region', { name: 'Customer history' });
    expect(within(section).queryByText('“after 6”')).not.toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: 'Show all (3)' }));
    expect(within(section).getByText('“after 6”')).toBeInTheDocument();
    expect(within(section).getByText('recorded')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /play recording/i })).not.toBeInTheDocument();
  });

  it('a new lead says so', async () => {
    fakeApi({
      'GET /agent/leads/9/history': {
        body: {
          ...H,
          summary: { ...H.summary, calls: 0, answered: 0, lastSpokeWith: null, pendingCallback: null },
          latestForm: null,
          timeline: [H.timeline[2]],
        },
      },
    });
    renderPage(<CustomerHistory side="agent" leadId={9} />);
    expect(await screen.findByText('No calls with this customer yet.')).toBeInTheDocument();
  });
});
