// Lead upload duplicate check: every scope, DNC / invalid always skipped,
// the skipped-rows Excel report.
const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');
const ExcelJS = require('exceljs');

const root = path.join(__dirname, '..');
function fake(rel, exports) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
fake('db.js', { query: async () => [[]] });

const { planImport, findExisting, saveReport, getReport, reportWorkbook } = require('../src/services/leadDedupe');

const row = (rowNum, phone, extra = {}) => ({ rowNum, values: { phone, name: `n${rowNum}`, ...extra } });
const ROWS = [
  row(2, '9840012345'),
  row(3, '+91 98400 12345'), // same number as row 2
  row(4, '9000000001'), // already in the campaign
  row(5, '9111111111'), // on DNC
  row(6, '12'), // invalid
  row(7, '9222222222'),
];
const EXISTING = new Map([['9000000001', { id: 345, list: 'Oct', campaign: 'Sales', campaignId: 2 }]]);
const DNC = new Set(['9111111111']);
const plan = (scope, existing = EXISTING) => planImport({ rows: ROWS, fields: [], scope, existing, dnc: DNC });

test('campaign (default): file repeats and existing leads skipped, with the reason', () => {
  const p = plan('campaign');
  assert.deepStrictEqual(
    p.toInsert.map((r) => r.phone),
    ['9840012345', '9222222222'],
  );
  assert.deepStrictEqual(p.summary, {
    total: 6,
    imported: 2,
    inFile: 1,
    existing: 1,
    dnc: 1,
    invalid: 1,
    updated: 0,
    copies: 0,
  });
  const reasons = Object.fromEntries(p.skipped.map((s) => [s.rowNum, s.reason]));
  assert.strictEqual(reasons[3], 'Duplicate: same number as row 2 in this file');
  assert.strictEqual(reasons[4], 'Already in campaign Sales - list Oct (lead #345)');
  assert.strictEqual(reasons[5], 'On the Do Not Call list');
  assert.match(reasons[6], /Invalid phone "12"/);
});

test('file only: repeats inside the sheet skipped, existing leads allowed', () => {
  const p = plan('file', new Map());
  assert.deepStrictEqual(p.summary, {
    total: 6,
    imported: 3,
    inFile: 1,
    existing: 0,
    dnc: 1,
    invalid: 1,
    updated: 0,
    copies: 0,
  });
});

test('none: every valid row goes in, even repeats; DNC and invalid still skipped', () => {
  const p = plan('none');
  assert.deepStrictEqual(p.summary, {
    total: 6,
    imported: 4,
    inFile: 0,
    existing: 0,
    dnc: 1,
    invalid: 1,
    updated: 0,
    copies: 0,
  });
});

test('a lead in a campaign the uploader may not see is "another campaign"', () => {
  const p = planImport({
    rows: ROWS,
    fields: [],
    scope: 'all',
    existing: EXISTING,
    dnc: DNC,
    campaignInScope: () => false,
  });
  assert.strictEqual(p.skipped.find((s) => s.rowNum === 4).reason, 'Already in another campaign');
});

test('existing leads: looked up only for the file numbers, phone or alt phone, within the scope', async () => {
  const seen = [];
  const db = {
    async query(q, params) {
      seen.push([q.replace(/\s+/g, ' '), params]);
      return [
        [{ id: 9, phone: '9000000001', alt_phone: '+91 9333333333', campaign_id: 2, list: 'Oct', campaign: 'Sales' }],
      ];
    },
  };
  const found = await findExisting(
    ['9000000001', '9333333333', '9000000001'],
    'list',
    { listId: 5, campaignId: 2 },
    { pool: db },
  );
  assert.deepStrictEqual([...found.keys()].sort(), ['9000000001', '9333333333']);
  assert.match(seen[0][0], /\(l\.phone IN \(\?\) OR l\.alt_phone IN \(\?\)\) AND l\.list_id = \?/);
  assert.deepStrictEqual(seen[0][1], [['9000000001', '9333333333'], ['9000000001', '9333333333'], 5]);
  seen.length = 0;
  await findExisting(['9000000001'], 'all', {}, { pool: db });
  assert.doesNotMatch(seen[0][0], /AND l\.(list_id|campaign_id) = \?/);
  assert.strictEqual((await findExisting(['9000000001'], 'file', {}, { pool: db })).size, 0);
  assert.strictEqual((await findExisting(['9000000001'], 'none', {}, { pool: db })).size, 0);
});

test('report: only for the uploader, expires; Excel has the reason and the original columns', async () => {
  const p = plan('campaign');
  const report = {
    headers: ['phone', 'name', ''],
    skipped: p.skipped,
    summary: p.summary,
    listName: 'Oct',
    scope: 'campaign',
    dryRun: true,
  };
  const id = saveReport(7, report, 1000);
  assert.ok(getReport(7, id, 2000));
  assert.strictEqual(getReport(8, id, 2000), null);
  assert.strictEqual(getReport(7, id, 1000 + 61 * 60 * 1000), null);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await reportWorkbook(report));
  const ws = wb.getWorksheet('Not imported');
  assert.deepStrictEqual(ws.getRow(1).values.slice(1), ['Row in file', 'Type', 'Reason', 'phone', 'name']);
  assert.deepStrictEqual(ws.getRow(2).values.slice(1), [
    3,
    'Duplicate in file',
    'Duplicate: same number as row 2 in this file',
    '+91 98400 12345',
    'n3',
  ]);
  assert.strictEqual(ws.rowCount, 1 + p.skipped.length);
  const sum = wb.getWorksheet('Summary');
  const items = Object.fromEntries(
    sum
      .getSheetValues()
      .slice(2)
      .map((r) => [r[1], r[2]]),
  );
  assert.strictEqual(items['Duplicate check'], 'In this campaign');
  assert.strictEqual(items['Checked only (nothing saved)'], 'Yes');
  assert.strictEqual(items['Would be imported'], 2);
});

// --- "Update existing leads": one customer stays one lead ---
const UPD_ROWS = [
  row(2, '9000000001', { name: 'Ravi Kumar', city: '' }), // a lead of this campaign: update it
  row(3, '9000000002', { name: '' }), // two leads in this campaign have this number: never guess
  row(4, '9000000003', { name: 'New' }), // not a lead yet: added
  row(5, '9000000001', { name: 'Again' }), // same number twice in the file: once only
];
const MATCHES = new Map([
  ['9000000001', [{ id: 345, list: 'Oct' }]],
  [
    '9000000002',
    [
      { id: 346, list: 'Oct' },
      { id: 347, list: null },
    ],
  ],
]);
const CITY = [{ field_key: 'city', label: 'City', field_type: 'text', options: null }];

test('update existing: filled cells update the one matching lead; empty cells and several matches are left alone', () => {
  const p = planImport({
    rows: UPD_ROWS,
    fields: CITY,
    scope: 'campaign',
    existing: new Map(),
    dnc: new Set(),
    onDuplicate: 'update',
    campaignMatches: MATCHES,
  });
  assert.deepStrictEqual(p.toUpdate, [{ leadId: 345, name: 'Ravi Kumar', altPhone: null, priority: null, custom: {} }]);
  assert.deepStrictEqual(
    p.toInsert.map((r) => r.phone),
    ['9000000003'],
  );
  assert.match(p.skipped.find((s) => s.rowNum === 3).reason, /Matches 2 leads in this campaign \(#346, #347\)/);
  assert.match(p.skipped.find((s) => s.rowNum === 5).reason, /same number as row 2/);
  assert.strictEqual(p.summary.updated, 1);
});

test('skip mode with a looser check: a second lead with the same number in this campaign is counted as a warning', () => {
  const p = planImport({
    rows: [row(2, '9000000001')],
    fields: [],
    scope: 'list',
    existing: new Map(),
    dnc: new Set(),
    campaignMatches: MATCHES,
  });
  assert.strictEqual(p.toInsert.length, 1);
  assert.strictEqual(p.summary.copies, 1);
});
