// Edit a pending callback: when, the note, and who takes it. Admins pick an
// agent of the campaign's teams (or anyone); an agent keeps it for themselves
// or gives it to anyone in the campaign.
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Select, Textarea } from '@/components/ui/form-controls';
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
import { toDateTimeLocal } from '@/lib/format';

export type CallbackEdit = { callbackAt: string; note: string; userId?: number | null; mine?: boolean };

type Who =
  /** Admin: an agent of the campaign's teams, or null = anyone in the campaign. */
  | { kind: 'agent'; userId: number | null; agents: { id: number; username: string }[] | undefined }
  /** Agent: true = only me, false = anyone in the campaign. */
  | { kind: 'mine'; mine: boolean };

export function EditCallbackDialog({
  callback,
  who,
  onOpenChange,
  onSave,
  pending,
  error,
}: {
  callback: { callback_at: string; note: string | null; name: string | null; phone: string } | null;
  who: Who;
  onOpenChange: (open: boolean) => void;
  onSave: (v: CallbackEdit) => void;
  pending: boolean;
  error?: string;
}) {
  return (
    <Dialog open={!!callback} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {callback && (
          <EditForm
            key={callback.callback_at}
            callback={callback}
            who={who}
            onSave={onSave}
            pending={pending}
            error={error}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({
  callback,
  who,
  onSave,
  pending,
  error,
  onCancel,
}: {
  callback: { callback_at: string; note: string | null; name: string | null; phone: string };
  who: Who;
  onSave: (v: CallbackEdit) => void;
  pending: boolean;
  error?: string;
  onCancel: () => void;
}) {
  const [at, setAt] = useState(() => toDateTimeLocal(callback.callback_at));
  const [note, setNote] = useState(callback.note ?? '');
  const [userId, setUserId] = useState(who.kind === 'agent' && who.userId ? String(who.userId) : '');
  const [mine, setMine] = useState(who.kind === 'mine' ? who.mine : true);
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    onSave({
      callbackAt: new Date(at).toISOString(),
      note: note.trim(),
      ...(who.kind === 'agent' ? { userId: userId ? Number(userId) : null } : { mine }),
    });
  }
  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>Edit callback</DialogTitle>
        <DialogDescription>
          {callback.name ? `${callback.name}, ` : ''}
          {callback.phone}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <Field id="cb-edit-at" label="Call back at">
          <Input id="cb-edit-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
        </Field>
        {who.kind === 'agent' ? (
          <Field id="cb-edit-who" label="Who calls back">
            <Select id="cb-edit-who" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Anyone in the campaign</option>
              {/* keep the current agent selectable while the list loads */}
              {!who.agents && who.userId && <option value={who.userId}>(current agent)</option>}
              {who.agents?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)} />
            Only me (off: anyone in the campaign can take it)
          </label>
        )}
        <Field id="cb-edit-note" label="Note">
          <Textarea id="cb-edit-note" value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <FormError message={error} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
