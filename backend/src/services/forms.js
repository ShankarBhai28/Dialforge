const pool = require('../../db');

// --- Admin: custom forms (fields an agent fills in per call) ---
const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'email', 'phone', 'date', 'dropdown', 'radio', 'checkbox'];

const FIELD_TYPES_WITH_OPTIONS = ['dropdown', 'radio', 'checkbox'];

// Returns an error string, or null plus the cleaned field list. Checked
// server-side because a bad field_key or a dropdown with no options would
// otherwise only show up later as a broken agent screen.
function validateFormFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return { error: 'a form needs at least one field' };
  const seen = new Set();
  const cleaned = [];
  for (const [i, f] of fields.entries()) {
    const key = String(f.fieldKey || '').trim();
    const label = String(f.label || '').trim();
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) {
      return {
        error: `field ${i + 1}: key "${key}" must be lowercase letters, digits, underscores, starting with a letter`,
      };
    }
    if (seen.has(key)) return { error: `field key "${key}" is used twice` };
    seen.add(key);
    if (!label) return { error: `field "${key}" needs a label` };
    if (!FORM_FIELD_TYPES.includes(f.fieldType)) return { error: `field "${key}" has an unknown type` };
    let options = null;
    if (FIELD_TYPES_WITH_OPTIONS.includes(f.fieldType)) {
      options = (f.options || []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length === 0) return { error: `field "${key}" (${f.fieldType}) needs at least one option` };
    }
    cleaned.push({ key, label, type: f.fieldType, options, required: f.isRequired ? 1 : 0, order: i });
  }
  return { fields: cleaned };
}

async function loadFormsWithFields(whereSql = '', params = []) {
  const [forms] = await pool.query(`SELECT * FROM forms ${whereSql} ORDER BY id DESC`, params);
  if (forms.length === 0) return [];
  const [fields] = await pool.query('SELECT * FROM form_fields WHERE form_id IN (?) ORDER BY sort_order, id', [
    forms.map((f) => f.id),
  ]);
  return forms.map((form) => ({ ...form, fields: fields.filter((f) => f.form_id === form.id) }));
}

// Values are re-checked against the form definition here - the browser's
// "required" attribute is a convenience, not a guarantee.
function validateFormData(fields, data) {
  const clean = {};
  for (const f of fields) {
    let v = data[f.field_key];
    const options = f.options || [];
    if (f.field_type === 'checkbox') {
      v = Array.isArray(v) ? v.map(String) : [];
      if (v.some((x) => !options.includes(x))) return { error: `"${f.label}" has an invalid choice` };
      if (f.is_required && v.length === 0) return { error: `"${f.label}" is required` };
      clean[f.field_key] = v;
      continue;
    }
    v = v == null ? '' : String(v).trim();
    if (v === '') {
      if (f.is_required) return { error: `"${f.label}" is required` };
      clean[f.field_key] = null;
      continue;
    }
    if (f.field_type === 'number' && !Number.isFinite(Number(v))) return { error: `"${f.label}" must be a number` };
    if (f.field_type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
      return { error: `"${f.label}" must be an email` };
    if (f.field_type === 'phone' && !/^\+?[0-9]{6,15}$/.test(v))
      return { error: `"${f.label}" must be a phone number` };
    if (f.field_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `"${f.label}" must be a date` };
    if (['dropdown', 'radio'].includes(f.field_type) && !options.includes(v))
      return { error: `"${f.label}" has an invalid choice` };
    clean[f.field_key] = f.field_type === 'number' ? Number(v) : v;
  }
  return { data: clean };
}

module.exports = { loadFormsWithFields, validateFormData, validateFormFields };
