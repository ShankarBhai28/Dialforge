// Queues: reusable ring-groups. Each save also rewrites the queue's stanza in
// Asterisk's queues.conf on the server, so a save can fail after the DB part.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Pencil, PhoneCall, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, Field, FormError, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { RING_STRATEGIES, useDeleteQueue, useQueues, useSaveQueue, type Queue } from './api';

const strategyLabel = (v: string) => RING_STRATEGIES.find((s) => s.value === v)?.label ?? v;
const yesNo = (v: string) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v);

function QueueDialog({ queue, onOpenChange }: { queue: Queue | null; onOpenChange: (v: boolean) => void }) {
  const save = useSaveQueue();
  const [name, setName] = useState(queue?.name ?? '');
  const [ringStrategy, setRingStrategy] = useState(queue?.ring_strategy ?? 'ringall');
  const [waitTimeout, setWaitTimeout] = useState(String(queue?.wait_timeout ?? 30));
  const [announce, setAnnounce] = useState(queue?.announce ?? 'no');
  const [retry, setRetry] = useState(String(queue?.retry ?? 1));
  const [timeoutRestart, setTimeoutRestart] = useState(queue?.timeout_restart ?? 'yes');
  const [localError, setLocalError] = useState<string | null>(null);

  // A strategy set outside this screen (e.g. rrmemory) stays selectable.
  const strategies = RING_STRATEGIES.some((s) => s.value === ringStrategy)
    ? RING_STRATEGIES
    : [...RING_STRATEGIES, { value: ringStrategy, label: ringStrategy }];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const wait = Number(waitTimeout);
    const retrySec = Number(retry);
    // The server treats 0/blank as "use the default", so catch it here instead.
    const error =
      !queue && !name.trim()
        ? 'Queue name is required'
        : !Number.isInteger(wait) || wait < 1
          ? 'Wait timeout must be a whole number of seconds (1 or more)'
          : !Number.isInteger(retrySec) || retrySec < 1
            ? 'Retry must be a whole number of seconds (1 or more)'
            : null;
    setLocalError(error);
    if (error) return;
    const body = { ringStrategy, waitTimeout: wait, announce, retry: retrySec, timeoutRestart };
    save.mutate(
      { id: queue?.id, body: queue ? body : { name: name.trim(), ...body } },
      {
        onSuccess: () => {
          toast.success(queue ? 'Queue updated' : `Created queue: ${name.trim()}`);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{queue ? `Edit ${queue.name}` : 'Create queue'}</DialogTitle>
            <DialogDescription>
              A reusable ring-group. Campaigns point at a queue; agents in it get the campaign's calls.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field
              id="queue-name"
              label="Queue name"
              className="sm:col-span-2"
              hint={
                queue
                  ? `Can't be renamed - campaigns and Asterisk refer to it as "${queue.asterisk_name ?? queue.name}".`
                  : 'Letters and digits; spaces become underscores in Asterisk.'
              }
            >
              <Input
                id="queue-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!!queue}
                autoFocus={!queue}
              />
            </Field>
            <Field id="queue-strategy" label="Ringing strategy">
              <Select id="queue-strategy" value={ringStrategy} onChange={(e) => setRingStrategy(e.target.value)}>
                {strategies.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="queue-timeout" label="Wait timeout (sec)" hint="How long each agent's phone rings.">
              <Input
                id="queue-timeout"
                type="number"
                min={1}
                inputMode="numeric"
                value={waitTimeout}
                onChange={(e) => setWaitTimeout(e.target.value)}
              />
            </Field>
            <Field id="queue-announce" label="Announce" hint="Announce position/wait to the caller.">
              <Select id="queue-announce" value={announce} onChange={(e) => setAnnounce(e.target.value)}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </Select>
            </Field>
            <Field id="queue-retry" label="Retry (sec)" hint="Pause before ringing the next agent.">
              <Input
                id="queue-retry"
                type="number"
                min={1}
                inputMode="numeric"
                value={retry}
                onChange={(e) => setRetry(e.target.value)}
              />
            </Field>
            <Field id="queue-restart" label="Timeout restart" hint="Reset the timeout on retry.">
              <Select id="queue-restart" value={timeoutRestart} onChange={(e) => setTimeoutRestart(e.target.value)}>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <FormError message={localError ?? save.error?.message} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {queue ? 'Save changes' : 'Create queue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function QueuesPage() {
  const queues = useQueues();
  const remove = useDeleteQueue();
  // null = closed, 'new' = create, Queue = edit that one.
  const [editing, setEditing] = useState<Queue | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Queue | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Queues"
          description="Reusable ring-groups - a campaign references one, plus its own CLI and ring behavior."
          actions={
            <Button onClick={() => setEditing('new')}>
              <Plus /> Create queue
            </Button>
          }
        />

        {queues.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : queues.error ? (
          <ErrorState message={queues.error.message} onRetry={() => queues.refetch()} />
        ) : queues.data.length === 0 ? (
          <EmptyState icon={PhoneCall} title="No queues yet">
            Create a queue, then pick it on a campaign so its calls ring the queue's agents.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Ringing strategy</TableHead>
                <TableHead>Wait timeout</TableHead>
                <TableHead>Announce</TableHead>
                <TableHead>Retry</TableHead>
                <TableHead>Timeout restart</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.data.map((q) => (
                <TableRow key={q.id}>
                  <TableCell>
                    <div className="font-semibold">{q.name}</div>
                    {q.asterisk_name && q.asterisk_name !== q.name && (
                      <div className="text-xs text-muted-foreground">{q.asterisk_name}</div>
                    )}
                  </TableCell>
                  <TableCell>{strategyLabel(q.ring_strategy)}</TableCell>
                  <TableCell className="tabular-nums">{q.wait_timeout}s</TableCell>
                  <TableCell>{yesNo(q.announce)}</TableCell>
                  <TableCell className="tabular-nums">{q.retry}s</TableCell>
                  <TableCell>{yesNo(q.timeout_restart)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(q)} aria-label={`Edit ${q.name}`}>
                      <Pencil /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleting(q)}
                      aria-label={`Delete ${q.name}`}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {editing && (
        <QueueDialog
          key={editing === 'new' ? 'new' : editing.id}
          queue={editing === 'new' ? null : editing}
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete queue "${deleting?.name}"?`}
        description="This also removes it from Asterisk."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Queue deleted');
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
