// What the agent picks after a call, per campaign. The whole list is saved at
// once (PUT replaces the set); order here is the order agents see.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormError } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useDispositions, useSaveDispositions, type Disposition } from './api';
import { checkDispositions, codeFromLabel, dispoRow, dispositionsBody, type DispoRow } from './settings';

function DispositionsForm({
  campaignId,
  initial,
  onClose,
}: {
  campaignId: number;
  initial: Disposition[];
  onClose: () => void;
}) {
  const save = useSaveDispositions(campaignId);
  const [rows, setRows] = useState<DispoRow[]>(() => initial.map(dispoRow));
  const [localError, setLocalError] = useState<string | null>(null);

  const update = (uid: number, patch: Partial<DispoRow>) =>
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) =>
    setRows((rs) => {
      const j = i + by;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = dispositionsBody(rows);
    const error = checkDispositions(body);
    setLocalError(error);
    if (error) return;
    save.mutate(body, { onSuccess: () => toast.success('Dispositions saved') });
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogBody className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          What the agent picks after a call. <b>Final</b> = lead is done. <b>Retry</b> = dialer may call again after N
          minutes. <b>Callback</b> = agent picks a date/time. <b>DNC</b> = number goes on the Do Not Call list (must
          also be final). The code is what's stored on the lead - avoid changing codes already in use.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Final</TableHead>
              <TableHead>Retry (min)</TableHead>
              <TableHead>Callback</TableHead>
              <TableHead>DNC</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const n = i + 1;
              return (
                <TableRow key={r.uid}>
                  <TableCell>
                    <Input
                      aria-label={`Disposition ${n} label`}
                      placeholder="e.g. Wrong Number"
                      className="min-w-36"
                      value={r.label}
                      onChange={(e) =>
                        update(r.uid, {
                          label: e.target.value,
                          // the code follows the label until it's typed by hand
                          ...(r.codeTouched ? {} : { code: codeFromLabel(e.target.value) }),
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Disposition ${n} code`}
                      placeholder="wrong_number"
                      className="min-w-32 font-mono text-xs"
                      maxLength={30}
                      value={r.code}
                      onChange={(e) => update(r.uid, { code: e.target.value, codeTouched: true })}
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`Disposition ${n} final`}
                      checked={r.isFinal}
                      onChange={(e) => update(r.uid, { isFinal: e.target.checked })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Disposition ${n} retry minutes`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={43200}
                      placeholder="—"
                      className="w-24"
                      value={r.retryAfterMin}
                      onChange={(e) => update(r.uid, { retryAfterMin: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`Disposition ${n} callback`}
                      checked={r.isCallback}
                      onChange={(e) => update(r.uid, { isCallback: e.target.checked })}
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`Disposition ${n} DNC`}
                      checked={r.marksDnc}
                      onChange={(e) => update(r.uid, { marksDnc: e.target.checked })}
                    />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move disposition ${n} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move disposition ${n} down`}
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      aria-label={`Remove disposition ${n}`}
                      onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, dispoRow()])}>
            <Plus /> Add disposition
          </Button>
        </div>
        <FormError message={localError ?? save.error?.message} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button type="submit" disabled={save.isPending}>
          Save dispositions
        </Button>
      </DialogFooter>
    </form>
  );
}

export function DispositionsEditor({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const list = useDispositions(campaignId);
  if (list.isPending)
    return (
      <DialogBody className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </DialogBody>
    );
  if (list.error)
    return (
      <DialogBody>
        <ErrorState message={list.error.message} onRetry={() => list.refetch()} />
      </DialogBody>
    );
  return <DispositionsForm campaignId={campaignId} initial={list.data} onClose={onClose} />;
}
