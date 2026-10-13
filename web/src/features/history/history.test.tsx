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
