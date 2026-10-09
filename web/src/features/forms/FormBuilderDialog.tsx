// Create/edit a form: name, description, status and an ordered field list.
// Checks the same rules as the server (services/forms.js) before sending,
// so mistakes show next to the field instead of after a round trip.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Select } from '@/components/ui/form-controls';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FormError } from '@/components/common';
import { cn } from '@/lib/utils';
import { FIELD_TYPE_LABELS, TYPES_WITH_OPTIONS, useSaveForm, type FieldType, type Form, type FormInput } from './api';

type Row = {
  uid: number;
  label: string;
  key: string;
  /** Once the admin types a key it is never overwritten from the label. */
  keyManual: boolean;
  type: FieldType;
  options: string;
  required: boolean;
};

let nextUid = 1;
const newRow = (r: Partial<Row> = {}): Row => ({
  uid: nextUid++,
  label: '',
  key: '',
  keyManual: false,
  type: 'text',
  options: '',
  required: false,
  ...r,
});

/** "Loan Amount" -> "loan_amount" (suggested key while none is typed). */
export function slugifyKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 50);
}

const splitOptions = (s: string) =>
  s
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

/** Same checks and wording as validateFormFields on the server. */
function validate(name: string, rows: Row[]): { message: string; uid?: number } | null {
  if (!name.trim()) return { message: 'Form name is required' };
  if (rows.length === 0) return { message: 'a form needs at least one field' };
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const key = r.key.trim();
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key))
      return {
        uid: r.uid,
        message: `field ${i + 1}: key "${key}" must be lowercase letters, digits, underscores, starting with a letter`,
      };
    if (seen.has(key)) return { uid: r.uid, message: `field key "${key}" is used twice` };
    seen.add(key);
    if (!r.label.trim()) return { uid: r.uid, message: `field "${key}" needs a label` };
    if (TYPES_WITH_OPTIONS.includes(r.type) && splitOptions(r.options).length === 0)
      return { uid: r.uid, message: `field "${key}" (${r.type}) needs at least one option` };
  }
  return null;
}

export function FormBuilderDialog({
  form,
  onOpenChange,
}: {
  form: Form | null;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveForm();
  const [name, setName] = useState(form?.name ?? '');
  const [description, setDescription] = useState(form?.description ?? '');
  const [status, setStatus] = useState<Form['status']>(form?.status ?? 'active');
  const [rows, setRows] = useState<Row[]>(() =>
    form?.fields.length
      ? form.fields.map((f) =>
          newRow({
            label: f.label,
            key: f.field_key,
            keyManual: true,
            type: f.field_type,
            options: (f.options ?? []).join(', '),
            required: !!f.is_required,
          }),
        )
      : [newRow()],
  );
  const [invalid, setInvalid] = useState<{ message: string; uid?: number } | null>(null);

  const update = (uid: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) =>
    setRows((rs) => {
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.reset();
    // Rows left completely blank are ignored, like the classic builder.
    const filled = rows.filter((r) => r.label.trim() || r.key.trim());
    const problem = validate(name, filled);
    setInvalid(problem);
    if (problem) return;
    const body: FormInput = {
      name: name.trim(),
      description: description.trim(),
      status,
      fields: filled.map((r) => ({
        label: r.label.trim(),
        fieldKey: r.key.trim(),
        fieldType: r.type,
        options: TYPES_WITH_OPTIONS.includes(r.type) ? splitOptions(r.options) : [],
        isRequired: r.required,
      })),
    };
    save.mutate(
      { id: form?.id, body },
      {
        onSuccess: () => {
          toast.success(`Saved form: ${body.name}`);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <form onSubmit={onSubmit} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>{form ? `Edit form ${form.name}` : 'Create form'}</DialogTitle>
            <DialogDescription>
              <b>Key</b> is the field's machine name (lowercase, e.g. <code>loan_amount</code>) - saved answers and the
              Excel lead-upload columns use it. <b>Options</b> (comma-separated) are needed for Dropdown / Radio /
              Checkbox.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            {form && form.response_count > 0 && (
              <p className="rounded-md bg-status-break/12 px-3 py-2 text-sm text-status-break">
                This form has {form.response_count} saved response(s). Changing a field's key means old answers stay
                under the old key.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem]">
              <Field id="form-name" label="Form name">
                <Input id="form-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
              <Field id="form-description" label="Description (optional)">
                <Input id="form-description" value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field id="form-status" label="Status" hint="Only active forms can be picked for a campaign.">
                <Select
                  id="form-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value === 'inactive' ? 'inactive' : 'active')}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </Field>
            </div>

            <div className="grid gap-3">
              <h3 className="text-sm font-bold">Fields</h3>
              {rows.map((r, i) => {
                const id = `ff-${r.uid}`;
                const hasOptions = TYPES_WITH_OPTIONS.includes(r.type);
                const bad = invalid?.uid === r.uid;
                return (
                  <fieldset
                    key={r.uid}
                    aria-label={`Field ${i + 1}`}
                    className={cn('grid gap-3 rounded-md border p-3', bad && 'border-destructive')}
                  >
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_9rem_1.3fr]">
                      <Field id={`${id}-label`} label="Label">
                        <Input
                          id={`${id}-label`}
                          placeholder="e.g. Loan Amount"
                          value={r.label}
                          onChange={(e) =>
                            update(r.uid, {
                              label: e.target.value,
                              ...(r.keyManual ? {} : { key: slugifyKey(e.target.value) }),
                            })
                          }
                        />
                      </Field>
                      <Field id={`${id}-key`} label="Key">
                        <Input
                          id={`${id}-key`}
                          placeholder="loan_amount"
                          value={r.key}
                          aria-invalid={bad || undefined}
                          onChange={(e) => update(r.uid, { key: e.target.value, keyManual: true })}
                        />
                      </Field>
                      <Field id={`${id}-type`} label="Type">
                        <Select
                          id={`${id}-type`}
                          value={r.type}
                          onChange={(e) => update(r.uid, { type: e.target.value as FieldType })}
                        >
                          {Object.entries(FIELD_TYPE_LABELS).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field id={`${id}-options`} label="Options">
                        <Input
                          id={`${id}-options`}
                          placeholder={hasOptions ? 'Yes, No, Maybe' : 'Only for Dropdown / Radio / Checkbox'}
                          value={r.options}
                          disabled={!hasOptions}
                          onChange={(e) => update(r.uid, { options: e.target.value })}
                        />
                      </Field>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={r.required}
                          onChange={(e) => update(r.uid, { required: e.target.checked })}
                        />
                        Required
                      </label>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          aria-label={`Move field ${i + 1} up`}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => move(i, 1)}
                          disabled={i === rows.length - 1}
                          aria-label={`Move field ${i + 1} down`}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
                          aria-label={`Remove field ${i + 1}`}
                        >
                          <Trash2 /> Remove
                        </Button>
                      </div>
                    </div>
                  </fieldset>
                );
              })}
              <div>
                <Button type="button" variant="outline" onClick={() => setRows((rs) => [...rs, newRow()])}>
                  <Plus /> Add field
                </Button>
              </div>
            </div>
            <FormError message={invalid?.message ?? save.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {form ? 'Save changes' : 'Create form'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
