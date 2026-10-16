// Leads / list Download: one row per lead, with how it was worked.
const assert = require('node:assert');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const ExcelJS = require('exceljs');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { exportLeads } = require('../src/services/leadExport');

const LEAD = {
  id: 9,
  name: 'Ravi',
  phone: '9003220102',
  alt_phone: null,
  status: 'callback',
  attempts: 3,
  last_attempt_at: new Date('2026-10-15T10:00:00Z'),
  next_call_at: null,
  is_final: 0,
  priority: 0,
  created_at: new Date('2026-10-01T09:00:00Z'),
  custom_data: { city: 'Chennai' },
  campaign_name: 'Sales',
  list_name: 'Oct',
  assigned_to: null,
  status_label: 'Call Back',
};

function db() {
  let served = false;
  return {
    async query(sql) {
      if (sql.includes('JSON_TABLE')) return [[{ k: 'city' }]];
      if (sql.includes('FROM leads l') && sql.includes('l.id > ?')) {
        if (served) return [[]];
        served = true;
        return [[LEAD]];
      }
      if (sql.includes('COUNT(*) AS calls')) return [[{ lead_id: 9, calls: 4, connected: 2, talk: 400 }]];
      if (sql.includes('agent_connect_time IS NOT NULL GROUP BY lead_id'))
        return [[{ lead_id: 9, agent: 'agent1003' }]];
      if (sql.includes('MAX(id) AS id FROM calls WHERE lead_id IN (?) GROUP BY lead_id'))
        return [[{ lead_id: 9, agent_connect_time: null, disposition: 'busy', end_time: new Date() }]];
      if (sql.includes("action = 'leads.outcome'")) return [[{ lead_id: 9, note: 'call after 6, wants 2BHK' }]];
      if (sql.includes('FROM callbacks')) return [[{ lead_id: 9, due: new Date('2026-10-17T11:30:00Z') }]];
      return [[]];
    },
  };
}

test('each lead row says who last handled it, how its calls went, the last note and any callback due', async () => {
  const out = new PassThrough();
  out.setHeader = () => {};
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => out.on('end', r));
  const n = await exportLeads({}, null, out, { pool: db(), getCampaignFormFields: async () => [] });
  await done;
  assert.strictEqual(n, 1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  const ws = wb.getWorksheet('Leads');
  const headers = ws.getRow(1).values.slice(1);
  const row = Object.fromEntries(headers.map((h, i) => [h, ws.getRow(2).values[i + 1]]));
  assert.strictEqual(row['Last agent'], 'agent1003');
  assert.strictEqual(row['Last call result'], 'Busy'); // the latest call, not the last answered one
  assert.strictEqual(row.Calls, 4);
  assert.strictEqual(row.Connected, 2);
  assert.strictEqual(row['Talk time (seconds)'], 400);
  assert.strictEqual(row['Last note'], 'call after 6, wants 2BHK');
  assert.strictEqual(row['Callback due'], '2026-10-17 11:30');
  assert.strictEqual(row.Status, 'Call Back');
  assert.strictEqual(row.city, 'Chennai');
});

test("list download: the list's form LABELS in form order, every field even when empty, no second Name", async () => {
  const out = new PassThrough();
  out.setHeader = () => {};
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => out.on('end', r));
  const base = db();
  const pool = {
    async query(sql, p) {
      if (sql.startsWith('SELECT campaign_id FROM lists')) return [[{ campaign_id: 4 }]];
      return base.query(sql, p);
    },
  };
  const form = [
    { field_key: 'name', label: 'First Name' },
    { field_key: 'amount', label: 'Email Address' },
    { field_key: 'date_of_birth', label: 'Date of Birth' },
    { field_key: 'phone2', label: 'Phone' }, // same as a fixed column
  ];
  await exportLeads({ listId: '2' }, null, out, { pool, getCampaignFormFields: async (id) => (id === 4 ? form : []) });
  await done;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  const headers = wb.getWorksheet('Leads').getRow(1).values.slice(1);
  const formHeaders = headers.slice(headers.indexOf('Callback due') + 1);
  // labels, in form order; empty Date of Birth still there; "First Name" is the Name column; city is on no form (last)
  assert.deepStrictEqual(formHeaders, ['Email Address', 'Date of Birth', 'Phone (form)', 'city']);
  assert.strictEqual(headers.filter((h) => /name/i.test(h)).length, 1);
});
