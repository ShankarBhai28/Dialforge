// The reports (docs/plans/REPORTS_PLAN.md). Each one takes
// { db, range, q, scope, csv } and returns
// { columns: [{ key, label, type?, warnAbove?, warnBelow? }], rows, totals, meta?, notes? }.
// Column types: text (default), id, number, decimal, seconds, percent, date, datetime.
// `filters` tells the screen which inputs to show.
const calls = require('./callReports');
const agents = require('./agentReports');
const campaigns = require('./campaignReports');

const REPORTS = [
  {
    key: 'cdr',
    title: 'Call Detail (CDR)',
    description: 'Every call: who, when, how long, how it ended and what the agent recorded.',
    filters: ['campaign', 'agent', 'direction', 'answered', 'outcome', 'number'],
    run: calls.cdr,
  },
  {
    key: 'agents',
    title: 'Agent Performance',
    description: 'Per agent: logged-in, talk, wrap-up and break time, calls, handle time, occupancy, conversions.',
    filters: ['agent', 'campaign'],
    run: agents.agentPerformance,
  },
  {
    key: 'timesheet',
    title: 'Agent Time Sheet',
    description: 'Per agent per day: first login, last logout, breaks (with reasons) and wrap-up time.',
    filters: ['agent'],
    run: agents.timeSheet,
  },
  {
    key: 'campaigns',
    title: 'Campaign Performance',
    description: 'Per campaign: penetration, contact rate, abandon rate, talk time and conversions.',
    filters: ['campaign'],
    run: campaigns.campaignPerformance,
  },
  {
    key: 'outcomes',
    title: 'Outcomes (Dispositions)',
    description: 'What agents recorded after calls, per campaign or per agent.',
    filters: ['campaign', 'agent', { key: 'groupBy', options: ['campaign', 'agent'] }],
    run: calls.outcomes,
  },
  {
    key: 'predictive',
    title: 'Predictive Dialer',
    description: 'Dialer pacing: attempts, answers, machines, drops (drop rate) and wait for an agent.',
    filters: ['campaign', { key: 'groupBy', options: ['campaign', 'hour'] }],
    run: campaigns.predictive,
  },
  {
    key: 'inbound',
    title: 'Inbound / Queue',
    description: 'Callers offered, answered and abandoned; waits and service level.',
    filters: ['campaign', { key: 'groupBy', options: ['campaign', 'did'] }, 'sla'],
    run: calls.inbound,
  },
  {
    key: 'hourly',
    title: 'Hourly',
    description: 'Calls, answers and talk time per hour of the day.',
    filters: ['campaign', 'direction'],
    run: calls.hourly,
  },
  {
    key: 'lists',
    title: 'List Penetration',
    description: 'How far each lead list has been worked (current state).',
    filters: ['campaign'],
    noRange: true,
    run: campaigns.listPenetration,
  },
  {
    key: 'callbacks',
    title: 'Callbacks',
    description: 'Callbacks due in the range: done, overdue, still to come - per agent.',
    filters: ['campaign', 'agent'],
    run: campaigns.callbacks,
  },
];

const byKey = Object.fromEntries(REPORTS.map((r) => [r.key, r]));

/** The list for the screen (no functions). */
const catalog = () => REPORTS.map(({ run: _run, ...r }) => r);

module.exports = { REPORTS, byKey, catalog };
