// Leads -> bulk actions on the ticked leads (or all leads matching the
// filters): status, move to a list, give to an agent, make dialable again,
// add to DNC, delete. The server checks every rule again (leadBulk.js).
import { useState } from 'react';
import { toast } from 'sonner';
import { Ban, ListRestart, Shuffle, Tag, Trash2, UserCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { useAccess, useCan } from '@/features/auth/access';
import {
  useBulkLeads,
  useDispositions,
  useLeadAgents,
  useLists,
  type BulkAction,
  type BulkInput,
  type BulkTarget,
} from './api';
import { DEFAULT_DISPOSITIONS } from './statuses';

const TITLES: Record<BulkAction, string> = {
  status: 'Change status',
  move: 'Move to a list',
  assign: 'Give to an agent',
  reset: 'Make dialable again',
  dnc: 'Add to the DNC list',
  delete: 'Delete leads',
};

function ActionDialog({
  action,
  target,
  count,
  campaignId,
  onDone,
  onClose,
}: {
  action: BulkAction;
  target: BulkTarget;
  count: number;
  /** The campaign filter ('' = none, 'none' = unassigned): status choices come from it. */
  campaignId: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const bulk = useBulkLeads();
  const lists = useLists();
  const agents = useLeadAgents(action === 'assign');
  const dispositions = useDispositions(campaignId && campaignId !== 'none' ? Number(campaignId) : null);
  const [status, setStatus] = useState('new');
  const [listId, setListId] = useState('');
  const [userId, setUserId] = useState('');
  const [resetAttempts, setResetAttempts] = useState(true);
  const leads = `${count.toLocaleString('en-IN')} lead${count === 1 ? '' : 's'}`;

  const statusChoices = [
    { code: 'new', label: 'New' },
    ...(campaignId && campaignId !== 'none' ? (dispositions.data ?? []) : DEFAULT_DISPOSITIONS),
  ];
  const missing = (action === 'move' && !listId) || (action === 'assign' && userId === '');

  function run() {
    const body: BulkInput = { ...target, action };
    if (action === 'status') body.status = status;
    if (action === 'move') body.listId = Number(listId);
    if (action === 'assign') body.userId = userId === 'nobody' ? null : Number(userId);
    if (action === 'reset') body.resetAttempts = resetAttempts;
    bulk.mutate(body, {
      onSuccess: (r) => {
        const what = `${r.changed.toLocaleString('en-IN')} lead${r.changed === 1 ? '' : 's'}`;
        toast.success(`${TITLES[action]}: ${what}`, r.notes.length ? { description: r.notes.join(' · ') } : undefined);
        onDone();
      },
    });
  }

  const destructive = action === 'delete' || action === 'dnc';
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {TITLES[action]} · {leads}
          </DialogTitle>
          <DialogDescription>
            {action === 'status' && "Uses the campaign's outcomes. All the leads must be in one campaign."}
            {action === 'move' && "The leads also move to that list's campaign. They keep their status and history."}
            {action === 'assign' &&
              'Only that agent sees these leads and calls them; the dialer leaves them alone. Pick Nobody to share them with the campaign again.'}
            {action === 'reset' &&
              'Like Recycle: dialable now. Do Not Call leads, DNC numbers and leads on a call are skipped.'}
            {action === 'dnc' &&
              'Their numbers go on the DNC list and are never called again. The leads are marked Do Not Call.'}
            {action === 'delete' &&
              "They're no longer dialled or shown; pending callbacks are cancelled. Their calls, recordings and answers are kept."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {action === 'status' && (
            <Field id="bulk-status" label="New status">
              <Select id="bulk-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {statusChoices.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {action === 'move' && (
            <Field id="bulk-list" label="List">
              <Select id="bulk-list" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">Pick a list</option>
                {lists.data?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.campaign_name ?? 'no campaign'})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {action === 'assign' && (
            <Field id="bulk-agent" label="Agent">
              <Select id="bulk-agent" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Pick an agent</option>
                <option value="nobody">Nobody - shared with the campaign</option>
                {agents.data
                  ?.filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {action === 'reset' && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={resetAttempts} onChange={(e) => setResetAttempts(e.target.checked)} /> Reset the
              attempt count to 0
            </label>
          )}
          <FormError message={bulk.error?.message} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={bulk.isPending || missing}
            onClick={run}
          >
            {action === 'delete' ? `Delete ${leads}` : action === 'dnc' ? `Add ${leads} to DNC` : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BulkBar({
  target,
  count,
  campaignId,
  onClear,
}: {
  target: BulkTarget;
  count: number;
  campaignId: string;
  onClear: () => void;
}) {
  const can = useCan('leads');
  const canDnc = useAccess().can('dnc', 'create');
  const [action, setAction] = useState<BulkAction | null>(null);
  const actions: [BulkAction, string, typeof Tag, boolean][] = [
    ['status', 'Status', Tag, can('edit')],
    ['move', 'Move to list', Shuffle, can('edit')],
    ['assign', 'Give to agent', UserCheck, can('edit')],
    ['reset', 'Make dialable', ListRestart, can('recycle')],
    ['dnc', 'Add to DNC', Ban, can('edit') && canDnc],
    ['delete', 'Delete', Trash2, can('delete')],
  ];
  return (
    <div
      role="toolbar"
      aria-label="Actions on the ticked leads"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
    >
      <span className="mr-1 text-sm font-semibold">{count.toLocaleString('en-IN')} ticked</span>
      {actions
        .filter(([, , , allowed]) => allowed)
        .map(([key, label, Icon]) => (
          <Button
            key={key}
            size="sm"
            variant="outline"
            className={key === 'delete' || key === 'dnc' ? 'text-destructive' : undefined}
            onClick={() => setAction(key)}
          >
            <Icon /> {label}
          </Button>
        ))}
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
        <X /> Clear
      </Button>
      {action && (
        <ActionDialog
          action={action}
          target={target}
          count={count}
          campaignId={campaignId}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            onClear();
          }}
        />
      )}
    </div>
  );
}
