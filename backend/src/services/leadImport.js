const multer = require('multer');
const ExcelJS = require('exceljs');
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { loadFormsWithFields } = require('./forms');

const leadUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Hand-rolled, not another dependency - correctly handles quoted fields
// with embedded commas/escaped quotes, which is the actual tricky part
// of CSV parsing (doesn't handle embedded newlines inside a quoted
// field, an acceptable gap for a name/phone lead list).
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result.map((s) => s.trim());
}

// --- Admin: lead upload (.xlsx or .csv) into a list ---
// Fixed columns every upload understands; on top of these, every field
// key of the list's campaign form is accepted and stored in custom_data.
const LEAD_BASE_COLUMNS = [
  { key: 'phone', required: true, help: 'Mobile/landline. +91, 0 and spaces are fine - stored as digits.' },
  { key: 'name', required: false, help: 'Customer name' },
  { key: 'alt_phone', required: false, help: 'Second number (optional)' },
  { key: 'priority', required: false, help: 'Whole number -100..100, higher is dialed first (default 0)' },
];

const MAX_IMPORT_ROWS = 20000;

// An Excel cell can be a plain value, a Date, rich text, a hyperlink or
// a formula - flatten all of them to the string a person sees.
function excelCellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return excelCellToString(v.result);
    if ('text' in v) return excelCellToString(v.text);
    return '';
  }
  return String(v);
}

// Returns { headers, rows: [{ rowNum, values: {header: string} }] } or { error }.
async function readLeadUpload(file) {
  const isXlsx = /\.xlsx$/i.test(file.originalname) || file.buffer.subarray(0, 2).toString() === 'PK';
  let table = [];
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer);
    } catch {
      return { error: 'could not read that Excel file - save it as .xlsx and try again' };
    }
    const ws = wb.worksheets[0];
    if (!ws) return { error: 'the Excel file has no sheets' };
    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
      const cells = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(excelCellToString(row.getCell(c).value).trim());
      table.push({ rowNum, cells });
    });
  } else {
    const lines = file.buffer
      .toString('utf-8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/);
    table = lines
      .map((l, i) => ({ rowNum: i + 1, cells: parseCsvLine(l).map((c) => c.trim()) }))
      .filter((r) => r.cells.some((c) => c !== ''));
  }
  if (table.length < 2) return { error: 'the file has no data rows (row 1 must be the column headers)' };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { error: `max ${MAX_IMPORT_ROWS} rows per upload - split the file` };
  const headers = table[0].cells.map((h) => h.toLowerCase().trim());
  const rows = table.slice(1).map(({ rowNum, cells }) => ({
    rowNum,
    values: Object.fromEntries(headers.map((h, i) => [h, cells[i] || ''])),
  }));
  return { headers, rows };
}

// Lead data is pre-call information, so values are checked for type/choice
// like form answers, but "required" doesn't apply.
function parseLeadCustomValue(field, raw) {
  const opts = field.options || [];
  switch (field.field_type) {
    case 'number':
      return Number.isFinite(Number(raw)) ? { value: Number(raw) } : { error: 'must be a number' };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { value: raw } : { error: 'must be a date (YYYY-MM-DD)' };
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? { value: raw } : { error: 'must be an email' };
    case 'phone': {
      const n = normalizePhone(raw);
      return n.length >= 6 && n.length <= 15 ? { value: n } : { error: 'must be a phone number' };
    }
    case 'dropdown':
    case 'radio':
      return opts.includes(raw) ? { value: raw } : { error: `must be one of: ${opts.join(', ')}` };
    case 'checkbox': {
      const picked = raw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const bad = picked.filter((x) => !opts.includes(x));
      return bad.length ? { error: `"${bad[0]}" is not one of: ${opts.join(', ')}` } : { value: picked };
    }
    default:
      return { value: raw };
  }
}

async function getCampaignFormFields(campaignId) {
  const [rows] = await pool.query('SELECT form_id FROM campaigns WHERE id = ?', [campaignId]);
  if (!rows[0] || !rows[0].form_id) return [];
  const [form] = await loadFormsWithFields('WHERE id = ?', [rows[0].form_id]);
  return form ? form.fields : [];
}

// Upload errors (e.g. too large) answered as JSON, not Express's HTML page.
function receiveLeadFile(req, res, next) {
  leadUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file is larger than 5 MB' : err.message });
  });
}

module.exports = { LEAD_BASE_COLUMNS, getCampaignFormFields, parseLeadCustomValue, readLeadUpload, receiveLeadFile };
