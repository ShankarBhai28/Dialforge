// Per-campaign automatic redial rules for calls that didn't reach an agent.
// The server always returns every result (defaults filled in), and the PUT
// needs every one back.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormError } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useRecycleRules, useSaveRecycleRules, type RecycleRule, type RecycleRulesInput } from './api';

type Row = { result: string; label: string; enabled: boolean; delayMin: string; maxTries: string };

/** Same ranges and wording as PUT /recycle-rules. */
function checkRules(rows: Row[]): string | null {
  for (const r of rows) {
    const delay = Number(r.delayMin);
    const tries = Number(r.maxTries);
    if (r.delayMin.trim() === '' || !Number.isInteger(delay) || delay < 1 || delay > 10080)
      return `${r.label}: "redial after" must be 1-10080 minutes`;
    if (r.maxTries.trim() === '' || !Number.isInteger(tries) || tries < 1 || tries > 20)
      return `${r.label}: "max times" must be a whole number 1-20`;
  }
  return null;
}

function RecycleRulesForm({
  campaignId,
  initial,
  onClose,
}: {
  campaignId: number;
  initial: RecycleRule[];
  onClose: () => void;
}) {
  const save = useSaveRecycleRules(campaignId);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((r) => ({
      result: r.result,
      label: r.label ?? r.result,
      enabled: !!r.enabled,
      delayMin: String(r.delay_min),
      maxTries: String(r.max_tries),
    })),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const update = (result: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.result === result ? { ...r, ...patch } : r)));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const error = checkRules(rows);
    setLocalError(error);
    if (error) return;
    const rules: RecycleRulesInput = Object.fromEntries(
      rows.map((r) => [r.result, { enabled: r.enabled, delayMin: Number(r.delayMin), maxTries: Number(r.maxTries) }]),
    );
    save.mutate(rules, { onSuccess: () => toast.success('Recycle rules saved') });
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogBody className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          What the dialer does after a call that didn't reach an agent. <b>Auto redial</b> on = call the lead again
          after the given minutes, up to <b>max times</b> for that result; after that (or with auto redial off) the lead
          is set aside until you recycle its list (Leads → Recycle). The campaign's <b>Max attempts</b> still caps the
          total calls per lead. Agent outcomes (e.g. the agent picks "No Answer") use the Dispositions retry time
          instead.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Result</TableHead>
              <TableHead>Auto redial</TableHead>
              <TableHead>Redial after (min)</TableHead>
              <TableHead>Max times</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.result}>
                <TableCell className="font-semibold">{r.label}</TableCell>
                <TableCell>
                  <Checkbox
                    aria-label={`${r.label}: auto redial`}
                    checked={r.enabled}
                    onChange={(e) => update(r.result, { enabled: e.target.checked })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${r.label}: redial after (min)`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10080}
                    className="w-28"
                    value={r.delayMin}
                    onChange={(e) => update(r.result, { delayMin: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={`${r.label}: max times`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={20}
                    className="w-20"
                    value={r.maxTries}
                    onChange={(e) => update(r.result, { maxTries: e.target.value })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <FormError message={localError ?? save.error?.message} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button type="submit" disabled={save.isPending}>
          Save recycle rules
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RecycleRulesEditor({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const rules = useRecycleRules(campaignId);
  if (rules.isPending)
    return (
      <DialogBody className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </DialogBody>
    );
  if (rules.error)
    return (
      <DialogBody>
        <ErrorState message={rules.error.message} onRetry={() => rules.refetch()} />
      </DialogBody>
    );
  return <RecycleRulesForm campaignId={campaignId} initial={rules.data} onClose={onClose} />;
}
