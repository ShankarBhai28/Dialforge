// Inputs for a campaign form's fields, shared by the agent's call form and
// the admin lead edit dialog.
import { Input } from '@/components/ui/input';
import { Checkbox, Select, Textarea } from '@/components/ui/form-controls';
import { Field } from '@/components/common';

/** One value per field key: a list for checkboxes, a string otherwise. */
export type FieldValues = Record<string, string | string[]>;

/** The parts of a form_fields row the inputs need. */
export type FieldDef = {
  field_key: string;
  label: string;
  field_type: string;
  options: string[] | null;
  is_required: number | boolean;
};

/** Form values from saved data (a lead's custom_data, a response). */
export function fieldValues(fields: FieldDef[], data: Record<string, unknown> | null | undefined): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = data?.[f.field_key];
    if (f.field_type === 'checkbox') out[f.field_key] = v == null ? [] : (Array.isArray(v) ? v : [v]).map(String);
    else out[f.field_key] = v == null ? '' : String(Array.isArray(v) ? v[0] : v);
  }
  return out;
}

const INPUT_TYPES: Record<string, string> = {
  number: 'number',
  email: 'email',
  phone: 'tel',
  date: 'date',
};

/**
 * The input for one form field. `optional` drops the required check (an
 * admin editing a lead's saved values, where blanks are allowed).
 */
export function FieldInput({
  f,
  value,
  onChange,
  idPrefix = 'ff',
  optional = false,
}: {
  f: FieldDef;
  value: string | string[];
  onChange: (v: string | string[]) => void;
  idPrefix?: string;
  optional?: boolean;
}) {
  const id = `${idPrefix}-${f.field_key}`;
  const required = !optional && !!f.is_required;
  const label = `${f.label}${required ? ' *' : ''}`;
  const opts = f.options ?? [];
  if (f.field_type === 'radio' || f.field_type === 'checkbox') {
    const list = Array.isArray(value) ? value : [value];
    return (
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-semibold">{label}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {opts.map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-sm">
              {f.field_type === 'checkbox' ? (
                <Checkbox
                  checked={list.includes(o)}
                  onChange={(e) => onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))}
                />
              ) : (
                <input
                  type="radio"
                  name={id}
                  className="accent-primary"
                  checked={value === o}
                  onChange={() => onChange(o)}
                />
              )}
              {o}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <Field id={id} label={label} className={f.field_type === 'textarea' ? 'sm:col-span-2' : undefined}>
      {f.field_type === 'textarea' ? (
        <Textarea id={id} value={value as string} required={required} onChange={(e) => onChange(e.target.value)} />
      ) : f.field_type === 'dropdown' ? (
        <Select id={id} value={value as string} required={required} onChange={(e) => onChange(e.target.value)}>
          <option value="">-- select --</option>
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={INPUT_TYPES[f.field_type] ?? 'text'}
          value={value as string}
          required={required}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
